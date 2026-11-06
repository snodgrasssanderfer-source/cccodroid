// 日记：每轮结束把这一轮的问答按角色、日期、渠道追加到素材；每晚 22:00 左右各写一篇。
// 小克和 DeepSeek 用上游定时任务（小克走订阅，要主人在定时任务页自己打开「订阅账户」）；
// 哈基米不走 Claude Code，上游定时任务起不了它，由这里的定时器交给 agy。
import fs from "node:fs";
import path from "node:path";
import { LIVE, CFG, log } from "./config.mjs";
import { NEXT, readBodyBuf, sendJson } from "./http.mjs";
import { publish } from "./bus.mjs";
import { END_HOOKS } from "./queue.mjs";
import { ROLES, roleById, roleDir, roleOfDir } from "./xk-roles.mjs";
import { turns } from "./xk-transcript.mjs";
import { today } from "./xk-memstore.mjs";
import { ENGINE_RUN, INTERNAL, STATE, addRoute, httpError, projectOf, saveState, selfApi } from "./xk-core.mjs";

const CH = { app: "App", "qq-private": "QQ 私聊", "qq-group": "QQ 群" };
const NICK = { xiaoke: "小克", hachimi: "哈基米", deepseek: "小鱼" };   // 界面上的叫法，和角色名（DeepSeek）不一样，导出文件用这个
const DIARY_TIME = "22:00";
STATE.diaryTasks ||= {};   // 角色 → 上游定时任务号
STATE.diaryRetry ||= {};   // 角色 → 额度恢复后补写的时刻

const inputsDir = (id) => path.join(roleDir(id), "diary", "inputs");
const hhmm = (t) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });

// 提示词不写死「今天」：定时任务错过了会在下次打开时补跑，额度用完也会晚点补写，按「还没写的那几天」来就不会写错日子
export const DIARY_PROMPT = "diary/inputs/ 里是每天的素材（文件名是日期）。找出 diary/ 下还没有同名日记的那几天，每天用你自己的口吻写一篇日记，存成 diary/<日期>.md。" +
  "只根据当天的素材写，素材里没写到的事不编。写完回复写了哪几天；没有要写的就回复「没有要写的」。";

/** 一轮结束：把这一轮的问答记进素材 */
export function appendInputs(run, f = {}) {
  const role = roleOfDir(run.cwd);
  if (!role || !run.sessionId) return;
  const said = turns(run.sessionId, run.startedAt - 1000);
  const reply = said.filter((t) => t.role === "assistant").map((t) => t.text).join("\n").trim();
  if (!reply && !run.text) return;
  const answer = f.isError || f.failed ? "（这一轮出错了，她没有回复）" : reply || "（没有回复）";
  let channel = "app";
  try { channel = JSON.parse(fs.readFileSync(path.join(roleDir(role.id), ".xk", "runs", run.id + ".json"), "utf8")).channel || "app"; }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  const day = today(new Date(run.startedAt));
  fs.mkdirSync(inputsDir(role.id), { recursive: true });
  // 群里那一轮：run.text 是整段群消息（「（群聊：」开头，三个人的话都在里面），不是主人说的一句。
  // 只摘主人在群里说的那几句，标成「群里」；他没开口（她们之间接话、目标模式接着干）就不写「主人：」那行（11-06 大扫除，小鱼查的）
  let ask = String(run.text || "").trim(), where = CH[channel] || channel;
  if (ask.startsWith("（群聊：")) {
    where = "群里";
    ask = ask.split("\n").filter((l) => l.startsWith("主人：")).map((l) => l.slice(3).trim()).join(" / ");
  }
  fs.appendFileSync(path.join(inputsDir(role.id), day + ".md"),
    `\n## ${hhmm(run.startedAt)} · ${where}\n${ask ? "主人：" + ask + "\n" : ""}${role.name}：${answer}\n`);
}

function retryAfterQuota(role, taskId) {
  const c = STATE.cooldown[role];
  if (!c) return;
  STATE.diaryRetry[role] = { at: c.until + 2 * 60000, taskId };
  saveState();
  armRetry(role);
}
function armRetry(role) {
  const r = STATE.diaryRetry[role];
  if (!r) return;
  setTimeout(() => {
    delete STATE.diaryRetry[role]; saveState();
    selfApi("POST", `/api/sched/${encodeURIComponent(r.taskId)}/run`, {})
      .then(() => log(`📔 额度恢复，补写${roleById(role).name}的日记`))
      .catch((e) => publish({ type: "xk", op: "diary", error: true, text: `${roleById(role).name}的日记补写没成：${e.message}` }));
  }, Math.max(0, r.at - Date.now())).unref?.();
}

END_HOOKS.push((run, f) => {
  if (run.sched) {
    const role = ROLES.find((r) => STATE.diaryTasks[r.id] === run.sched.taskId);
    // 额度用完失败的（接班模块已经记下冷却和重置时间）：等恢复后再跑一次
    if (role && (f.isError || f.failed) && STATE.cooldown[role.id]) retryAfterQuota(role.id, run.sched.taskId);
    return;
  }
  const job = INTERNAL.get(run.id);
  if (job && job.kind === "diary") {
    INTERNAL.delete(run.id);
    if (f.isError || f.failed) publish({ type: "xk", op: "diary", error: true, text: `${roleById(job.role).name}的日记没写成` });
    return;
  }
  if (job || run.auto) return;
  appendInputs(run, f);
});

/** 小克、DeepSeek：上游定时任务，每天 22:00。已有就不动（主人改过时间或关掉都尊重） */
export async function ensureDiaryTasks() {
  const { tasks } = await selfApi("GET", "/api/sched");
  for (const r of ROLES.filter((x) => x.engine === "claude")) {
    const name = `日记 · ${r.name}`;
    let t = tasks.find((x) => x.id === STATE.diaryTasks[r.id]) || tasks.find((x) => x.name === name);
    if (!t) t = (await selfApi("POST", "/api/sched", { name, prompt: DIARY_PROMPT, projectId: projectOf(r.id), freq: { kind: "daily", time: DIARY_TIME },
      perm: "proj", missed: "run", retry: 2, saveSession: false, notify: "fail", limitMin: 10 })).task;
    STATE.diaryTasks[r.id] = t.id;
  }
  saveState();
}

// 哈基米：每 30 分钟看一次，过了 22:00、今天有素材还没写，就交给 agy（错过的前几天也一起补，提示词里按「还没写的那几天」）
function pendingDays(id) {
  const ins = fs.existsSync(inputsDir(id)) ? fs.readdirSync(inputsDir(id)).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)) : [];
  return ins.map((f) => f.slice(0, 10)).filter((d) => !fs.existsSync(path.join(roleDir(id), "diary", d + ".md")));
}
export function agyDiaryDue(now = new Date()) {
  const t = today(now), [h, m] = DIARY_TIME.split(":").map(Number);
  const after = now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
  return pendingDays("hachimi").filter((d) => d < t || after);
}
function agyDiaryTick() {
  const role = roleById("hachimi");
  if (!ENGINE_RUN.agy || STATE.cooldown.hachimi || STATE.diaryAgyAt === today() + (new Date().getHours() >= 22 ? "n" : "d")) return;
  if (!agyDiaryDue().length) return;
  STATE.diaryAgyAt = today() + (new Date().getHours() >= 22 ? "n" : "d");   // 每天白天、晚上各最多试一次，失败等下一档
  saveState();
  const item = { id: "xa" + Date.now().toString(36) + "d", message: DIARY_PROMPT, sessionId: null };
  INTERNAL.set(item.id, { kind: "diary", role: role.id });
  ENGINE_RUN.agy(item, { internal: true });
}

if (LIVE) {
  setTimeout(() => ensureDiaryTasks().catch((e) => log("⚠️ 建日记定时任务失败：" + e.message)), 4000).unref();
  for (const r of Object.keys(STATE.diaryRetry)) armRetry(r);
  setInterval(agyDiaryTick, 30 * 60000).unref();
  setTimeout(agyDiaryTick, 60000).unref();
}

// ── 界面：导出成图片 ──
// 纸纹、横线、日期、签名由前端画成 PNG 传上来，群聊长图也一样。这里只负责校验和落盘（exports/ 在「保存到」允许的范围里）
const EXPORT_MAX = 24 * 1024 * 1024;
function saveExportPng(prefix, name, buf, cleanRe) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.length > EXPORT_MAX || buf[0] !== 0x89 || buf.toString("latin1", 1, 4) !== "PNG")
    throw httpError(400, "图片数据不对");
  const dir = path.join(CFG.home, "exports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${prefix}-${Date.now().toString(36)}.png`);
  fs.writeFileSync(file, buf);
  // 只留一天：存过的原图不长期堆在私有目录；按同一类清（diary-/room-），别把另一类的图删了
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!cleanRe.test(f)) continue;
      const p = path.join(dir, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(p);
    }
  } catch {}
  return { path: file, name };
}
export function saveDiaryPng(roleId, date, buf) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw httpError(400, "日期不对");
  const role = roleById(roleId);
  if (!role) throw httpError(404, "没有这个角色");
  if (!fs.existsSync(path.join(roleDir(role.id), "diary", date + ".md"))) throw httpError(404, "这天没有日记");
  return saveExportPng(`diary-${role.id}-${date}`, `${NICK[role.id] || role.name}的日记 ${date}.png`, buf, /^diary-.*\.png$/);
}
// 群聊长截图：前端把选中的气泡画成一张长图传上来，这里只落盘
export function saveRoomPng(buf) {
  return saveExportPng("room", "聊天室记录.png", buf, /^room-.*\.png$/);
}

// ── 界面：按角色、日期看 ──
addRoute(async (req, res, u, p) => {
  if (p === "/api/xk/diary/export" && req.method === "POST") {
    let buf;
    // 只有超限才说「太大」；签名不符、连接断了照实报，别都说成太大
    try { buf = await readBodyBuf(req, EXPORT_MAX + 4096); }
    catch (e) { throw /too large/.test(e.message) ? httpError(413, "图片太大") : httpError(400, "图片没传完整：" + e.message); }
    return sendJson(res, 200, { ok: true, ...saveDiaryPng(u.searchParams.get("role"), u.searchParams.get("date"), buf) });
  }
  if (p === "/api/xk/room/export" && req.method === "POST") {
    let buf;
    try { buf = await readBodyBuf(req, EXPORT_MAX + 4096); }
    catch (e) { throw /too large/.test(e.message) ? httpError(413, "图片太大") : httpError(400, "图片没传完整：" + e.message); }
    return sendJson(res, 200, { ok: true, ...saveRoomPng(buf) });
  }
  if (p === "/api/xk/diary" && req.method === "GET") {
    const role = roleById(u.searchParams.get("role"));
    if (!role) throw httpError(404, "没有这个角色");
    const d = path.join(roleDir(role.id), "diary");
    const days = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse() : [];
    return sendJson(res, 200, { role: role.id, days, pending: pendingDays(role.id), taskId: STATE.diaryTasks[role.id] || null });
  }
  const m = p.match(/^\/api\/xk\/diary\/([a-z]+)\/(\d{4}-\d{2}-\d{2})$/);
  if (m && req.method === "GET") {
    const role = roleById(m[1]);
    if (!role) throw httpError(404, "没有这个角色");
    const f = path.join(roleDir(role.id), "diary", m[2] + ".md");
    if (!fs.existsSync(f)) throw httpError(404, "这天没有日记");
    return sendJson(res, 200, { date: m[2], text: fs.readFileSync(f, "utf8") });
  }
  return NEXT;
});

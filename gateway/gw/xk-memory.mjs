// 记忆的网关一侧：对话停下 10 分钟后自动整理一遍（不只靠她当场调 remember），以及界面上看、改、删。
// 整理是一次调用：网关挑好相关旧记忆、连同对话发过去，模型只回 JSON，网关自己写（照 mem0 的 ADDITIVE 流程，#26）。
// 不走工具来回（每记一条就整段上下文重读一遍），也不开会话（不会出现在会话列表、不会被当成最近那段）
import fs from "node:fs";
import path from "node:path";
import { LIVE, log } from "./config.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { publish } from "./bus.mjs";
import { spawn } from "node:child_process";
import { END_HOOKS } from "./queue.mjs";
import { RUNS } from "./runs.mjs";
import { PROVIDER, providerById } from "./providers.mjs";
import { isLoginMode } from "./models.mjs";
import { claudeCmd, claudeEnv, ensureBridge, killTree, settingsArgs } from "./claude.mjs";
import { roleById, roleDir, roleOfDir, roleOfSession } from "./xk-roles.mjs";
import { turns } from "./xk-transcript.mjs";
import { line, load, remember, remove, search, today, update } from "./xk-memstore.mjs";
import { ENGINE_ASK, STATE, XK_HOME, addRoute, httpError, json, saveState } from "./xk-core.mjs";

// 停多久算「这段聊完了」：太短会把一段话拆成好几次整理，太长主人第二天回来时还没记
const IDLE_MS = 10 * 60 * 1000;
STATE.memDirty ||= {};   // 会话号 → 最后一轮结束时刻（还没整理）
STATE.memDone ||= {};    // 会话号 → 整理到哪个时刻

/** 这一轮属于哪个渠道：App 是默认；QQ 接入（第二阶段）入队时调它，MCP 服务和日记按 run 号读 */
export function markRun(role, runId, info) {
  const f = path.join(roleDir(role), ".xk", "runs", runId + ".json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(info));
}

const timers = new Map();
function arm(sid, at) {
  clearTimeout(timers.get(sid));
  const t = setTimeout(() => { timers.delete(sid); fire(sid); }, Math.max(0, at + IDLE_MS - Date.now()));
  t.unref?.();
  timers.set(sid, t);
}
// 主人正在聊（有她自己的一轮在跑）就再等一个空闲期：整理要花额度和网速，别和她抢
const chatting = () => [...RUNS.values()].some((r) => !r.ended && !r.auto && !r.sched);
function fire(sid) {
  if (chatting()) return arm(sid, Date.now());
  consolidate(sid).catch((e) => log("整理记忆出错：" + e.message));
}

// 整理是格式化活：用便宜档，别为记笔记跑一轮主模型、吃主人的订阅额度。看法带人设，留给角色在聊天里自己记。
// 小克（订阅）用 haiku；别家用它的快档（DeepSeek 是 flash）
const CHEAP = { anthropic: "haiku" };
export const cheapModel = (P) => CHEAP[P.id] || P.fastModel || P.defaultModel || "";
const WORK = path.join(XK_HOME, "ask");   // 一次性调用的工作目录：不在角色目录里，就不读人设、不跑 hook、不挂记忆工具
/** 问一次、拿回文字：不给工具、不留会话。{ text } 或 { error } */
export const ASK = {
  async claude(prompt, role) {
    const P = providerById(role.provider);
    if (!P) return { error: `${role.name}的接口（${role.provider}）没配` };
    // 她那家正好是全局那家、又不是登录模式时，claude 走本地 DNS 桥（同 autotitle）
    if (P.id === PROVIDER.id && !isLoginMode() && !(await ensureBridge())) return { error: "本地 DNS 桥启动失败，连不上接口" };
    const model = cheapModel(P);
    return new Promise((resolve) => {
      fs.mkdirSync(WORK, { recursive: true });
      const [cmd, args] = claudeCmd([...settingsArgs(P), "-p", "--no-session-persistence", "--tools", "", "--strict-mcp-config",
        "--system-prompt", SYSTEM, "--output-format", "json", ...(model ? ["--model", model] : [])]);
      const child = spawn(cmd, args, { cwd: WORK, env: claudeEnv({ model, provider: P }), stdio: ["pipe", "pipe", "pipe"], detached: true });
      let out = "", err = "", done = false;
      const fin = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => { killTree(child); fin({ error: "5 分钟没答完" }); }, 5 * 60000);
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", (e) => fin({ error: "claude 起不来：" + e.message }));
      child.on("close", (code) => {
        let j = null; try { j = JSON.parse(out.trim().split("\n").pop()); } catch {}
        if (!j) return fin({ error: (err || out).trim().slice(-300) || `claude 没有输出（退出码 ${code}）` });
        if (j.is_error) return fin({ error: String(j.result || j.subtype || "出错").slice(0, 300) });
        fin({ text: String(j.result || "") });
      });
      child.stdin.end(prompt);
    });
  },
  agy: (prompt) => (ENGINE_ASK.agy ? ENGINE_ASK.agy(SYSTEM + "\n\n" + prompt) : Promise.resolve({ error: "哈基米的 agy 没装" })),
};

const SYSTEM = `你替一个角色整理她的长期记忆：读她和主人的一段对话，挑出以后用得上的事，只输出一个 JSON 对象，不要别的文字。`;
const day = (ms) => today(new Date(ms));
const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);
const WEEK = "日一二三四五六";

/** 整理的提示。known：相关旧记忆（编号 = 数组下标，模型按编号指，网关映射回 id——小整数比 8 位 id 抄不错） */
export function prompt(role, talk, known) {
  const lines = talk.map((t) => { const d = new Date(t.at); return `[${day(t.at)} 周${WEEK[d.getDay()]} ${clock(t.at)}] ${t.role === "user" ? "主人" : role.name}：${t.text}`; });
  const old = known.map((m, i) => `${i}. ${line(m).replace(/^- \[[0-9a-f]+\] /, "")}`);
  return `你是${role.name}，下面是你和主人的一段对话（每句前面是说这句话的日期和时间）。\n\n` +
    `规矩：\n` +
    `1. 只记以后用得上的事实（fact）、发生的事（event）、计划（plan），每条写成单独看得懂的一句话，who 写清是谁的事（主人、你自己、别人的名字）。你自己的看法这里不记——那是你在聊天里亲口记的。闲聊客套不记。\n` +
    `2. 时间按那句话是哪天说的换算，不是按今天：昨晚 23:50 说的「明天」就是说话那天的下一天。text 里写换算好的具体日期；date 写这件事发生或计划的日期（YYYY-MM-DD），说不出就写说话那天；said 写那句话的日期；有截止的写 until。\n` +
    `3. 下面编了号的旧记忆里已经有的同一件事，不要再记；但日期、数字、具体名字不一样的不算同一件事，关于同一个人或物的新细节也照记。\n` +
    `4. 新内容让某条旧记忆不可能再同时成立（改了主意、换了安排、事情结束了），把旧记忆的编号放进 ends。只是补充进展、更新状态、两条能同时成立的，不写 ends。\n` +
    `5. 没什么可记的就回 {"memories":[]}。\n\n` +
    `只输出：{"memories":[{"text":"…","kind":"fact|event|plan","who":"…","date":"YYYY-MM-DD","said":"YYYY-MM-DD","until":"","ends":[编号]}]}\n\n` +
    `可能相关的旧记忆（只用来去重和判断 ends，不从这里摘）：\n${old.join("\n") || "（没有）"}\n\n---\n${lines.join("\n")}`;
}

/** 模型的回复 → 要写的条目（ends 已换成真 id）。不是 JSON、编号对不上都抛错：和「没东西可记」（空数组）分开 */
export function parse(text, known) {
  const s = String(text || ""), a = s.indexOf("{"), b = s.lastIndexOf("}");
  let o;
  try { o = JSON.parse(s.slice(a, b + 1)); } catch (e) { throw new Error(`回复不是 JSON（${e.message}）：${s.slice(0, 200)}`); }
  if (a < 0 || !o || !Array.isArray(o.memories)) throw new Error("回复里没有 memories 数组：" + s.slice(0, 200));
  return o.memories.map((m) => {
    if (!m || typeof m.text !== "string" || !m.text.trim()) throw new Error("有一条没有 text：" + JSON.stringify(m).slice(0, 200));
    const ends = [].concat(m.ends ?? []).map((n) => {
      if (typeof n === "string" && /^\d+$/.test(n)) n = Number(n);
      if (!Number.isInteger(n) || !known[n]) throw new Error(`ends 里的编号 ${JSON.stringify(n)} 不在旧记忆里（只有 0–${known.length - 1}）`);
      return known[n].id;
    });
    return { text: m.text, kind: m.kind, who: m.who, date: m.date, said: m.said, until: m.until, ends };
  });
}

const BUSY = new Set();   // 同一个会话的整理不叠着跑
/** 整理一段会话里还没整理过的部分：网关挑旧记忆 → 问一次 → 自己写。返回写了几条；没东西整理返回 null */
export async function consolidate(sid) {
  const role = roleOfSession(sid);
  if (!role) { delete STATE.memDirty[sid]; saveState(); return null; }
  const talk = turns(sid, STATE.memDone[sid] || 0);
  if (!talk.some((t) => t.role === "user")) { delete STATE.memDirty[sid]; saveState(); return null; }
  if (BUSY.has(sid)) return null;
  BUSY.add(sid);
  const dir = roleDir(role.id), until = talk[talk.length - 1].at;
  log(`🧠 整理记忆：${role.name} 会话 ${String(sid).slice(0, 8)}（${talk.length} 段）`);
  try {
    const known = search(dir, talk.map((t) => t.text).join("\n"), 15);
    const r = await ASK[role.engine](prompt(role, talk, known), role);
    if (r.error) throw new Error(r.error);
    const items = parse(r.text, known);
    const lastSaid = day(until);   // 模型漏写 said 时的兜底：这段对话最后那天，不是今天
    let n = 0;
    for (const m of items) {
      if (m.kind === "opinion") { log(`整理记忆：跳过一条看法（${role.name}的看法留给她自己记）：${m.text}`); continue; }
      remember(dir, { ...m, said: m.said || lastSaid, channel: "app", source: { sessionId: sid, by: "consolidate" } });
      n++;
    }
    STATE.memDone[sid] = until;
    delete STATE.memDirty[sid];
    saveState();
    return n;
  } catch (e) {
    // 留着 memDirty，下次这个会话再有新消息时一起整理
    log(`⚠️ 整理记忆失败（${role.name}）：${e.message}`);
    publish({ type: "xk", op: "memory_failed", role: role.id, error: e.message });
    throw e;
  } finally { BUSY.delete(sid); }
}

END_HOOKS.push((run) => {
  if (run.internal || run.sched || run.auto || !run.sessionId || !roleOfDir(run.cwd)) return;
  STATE.memDirty[run.sessionId] = Date.now();
  saveState();
  arm(run.sessionId, Date.now());
});

// 网关重启前没整理完的：从启动起再等一个空闲期。一起来就补跑，主人刚点完更新回来正要聊（#26 真机）
if (LIVE) for (const sid of Object.keys(STATE.memDirty)) arm(sid, Date.now());

// ── 界面：看、改、删 ──
addRoute(async (req, res, u, p) => {
  if (p === "/api/xk/memory" && req.method === "GET") {
    const role = roleById(u.searchParams.get("role"));
    if (!role) throw httpError(404, "没有这个角色");
    return sendJson(res, 200, { role: role.id, items: load(roleDir(role.id)).sort((a, b) => b.date.localeCompare(a.date) || b.updated - a.updated) });
  }
  const m = p.match(/^\/api\/xk\/memory\/([a-z]+)\/([0-9a-f]+)$/);
  if (!m) return NEXT;
  const role = roleById(m[1]);
  if (!role) throw httpError(404, "没有这个角色");
  if (req.method === "PATCH") return sendJson(res, 200, update(roleDir(role.id), m[2], await json(req)));
  if (req.method === "DELETE") return sendJson(res, 200, remove(roleDir(role.id), m[2]));
  return NEXT;
});

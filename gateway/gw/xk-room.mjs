// 聊天室（#35，设计稿 xk/design/presence.md 第四节）：像 QQ 群，主人一进群三个人都在。
// 群里不另开会话（主人 11-03 定的）：每个人就在她当前那段对话里接着说——群里的新发言作为一条消息递进她那段，
// 她的回复贴回群里。所以人设、记忆注入、工具都照常，主人回到私聊时群里聊过的她都记得；记忆整理也照旧按她那段来。
import fs from "node:fs";
import path from "node:path";
import { LIVE, log } from "./config.mjs";
import { onPublish, publish } from "./bus.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { END_HOOKS, enqueue } from "./queue.mjs";
import { RUNS } from "./runs.mjs";
import { ROLES, ROLES_DIR, roleById, roleOfDir, roleOfSession } from "./xk-roles.mjs";
import { turns } from "./xk-transcript.mjs";
import { ASK } from "./xk-memory.mjs";
import { ENGINE_RUN, STATE, XK_HOME, addRoute, httpError, json, projectOf, saveState } from "./xk-core.mjs";

const FILE = path.join(XK_HOME, "room.jsonl");
STATE.room ||= { seen: {}, lastAside: {}, usage: {} };
// 插话：主人一句话最多一个人插一句；同一个人两次插话至少隔这么久，免得吵、也省额度
export const ASIDE_GAP = { ms: 3 * 60 * 1000 };
export const PASS = "（不插话）";

// ── 群消息：一行一条 {n, from: "owner" | 角色 | "system", text, at, kind?: "aside"} ──
let MSGS = null;
export function messages() {
  if (MSGS) return MSGS;
  try { MSGS = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch (e) { if (e.code !== "ENOENT") throw new Error(`群消息读不了（${FILE}）：${e.message}`); MSGS = []; }
  return MSGS;
}
function append(m) {
  const msg = { n: messages().length, at: Date.now(), ...m };
  fs.appendFileSync(FILE, JSON.stringify(msg) + "\n");
  MSGS.push(msg);
  publish({ type: "xk", op: "room", msg });
  return msg;
}
/** 测试用：换个空群 */
export function resetRoom() { MSGS = []; fs.rmSync(FILE, { force: true }); STATE.room = { seen: {}, lastAside: {}, usage: {} }; ROUNDS.clear(); BATCH = null; BUSY.clear(); TURNS.clear(); CIDS.clear(); AGAIN.clear(); }

const asleep = (id) => { const c = STATE.cooldown[id]; return !!(c && !(c.until <= Date.now())); };
const nameOf = (id) => (id === "owner" ? "主人" : id === "deepseek" ? "小鱼" : roleById(id)?.name || id);
// 怎么叫她们：名字和常用叫法
const CALLS = { xiaoke: /小克|克克|大小姐/, hachimi: /哈基米|基米|小猫|猫猫/, deepseek: /小鱼|鲸鱼|大肥鱼|deepseek/i };

export const called = (text, but) => ROLES.map((r) => r.id).filter((id) => id !== but && CALLS[id]?.test(text));

// ── 谁开口（#61，主人 11-03 定的混合做法）：明确的按规则定，拿不准的才用便宜档问一次「谁想接」，上限用规则卡死 ──
// 节奏：主人连着发的几句攒成一批再定（等他说完）；点了名的等得短些
export const PACE = { quietMs: 2000, maxMs: 8000, calledMs: 1000, followMs: 5 * 60 * 1000 };
// 上限：一批主人的话，第一波最多两个人开口；之后主人不开口，她们之间点名交办的最多再接六句、没点名自己插话的最多三句，两样分开算，
// 免得派活被闲聊吃掉（主人 11-03 定的）。到了上限群里说一声，不然看着像谁不理人。插话和接话都用她平时的模型（#64）
export const CAP = { wave: 2, chain: 3, named: 6 };
export const CAPPED = "她们这一轮说到上限了，等你开口再接着聊";
const TRAITS = { xiaoke: "讲究、较真、好面子，凡事想透了才动手，写代码、拿主意在行", hachimi: "见多识广、闲不住、点子多，爱查资料、看图，自信来得早", deepseek: "直、带点懒劲、爱吃饭，干活靠谱，一句话把大计划缩成眼下一步" };
const JUDGE_SYSTEM = "你帮一个群聊决定接下来谁开口，像真人群聊那样：不是每句话都要好几个人接。只输出一个 JSON 对象，不要别的文字。";

/** 正和主人一来一回的那位：她最后一个正经说话（插话不算），而且没过多久 */
function following() {
  const m = [...messages()].reverse().find((x) => x.from !== "owner" && x.from !== "system" && x.kind !== "aside");
  return m && Date.now() - m.at <= PACE.followMs && !asleep(m.from) ? m.from : null;
}

/** 问一次便宜档：mode = owner（主人刚说完，谁接、要不要再有人插一句）/ chain（after 刚说完，有没有人想接一句） */
export async function judge(mode, after, taken = []) {
  const awake = ROLES.map((r) => r.id).filter((id) => !asleep(id));
  if (!awake.length) return {};
  const lines = messages().slice(-20).map((m) => `${nameOf(m.from)}：${m.text}`).join("\n");
  const who = awake.map((id) => `- ${id}（${nameOf(id)}）：${TRAITS[id] || ""}`).join("\n");
  // 主人 11-03 嫌插话太少：不再写「大多数时候不用」，有话想说（补充、接梗、不同意）就让她插；刷屏靠 ASIDE_GAP 和上限卡
  const ask = mode === "owner"
    ? (taken.length
      ? `主人刚说完最后那几句，${taken.map(nameOf).join("、")}会接。另外还有没有人对这话题有话想说（补充、接梗、不同意都算）？有就写在 aside，reply 写 none。`
      : `主人刚说完最后那几句。谁来接最合适（看话题和各自的性子）？另一个人要是对这话题也有话想说（补充、接梗、不同意都算），写在 aside。`)
    : `${nameOf(after)}刚说完最后一句。有没有人想接一句（补充、接梗、不同意都算）？真没有就写 none。`;
  const prompt = `群里有主人和下面几位（睡着的不在）：\n${who}\n\n最近的群消息：\n${lines}\n\n${ask}\n只输出：{"reply":"${awake.join("|")}|none","aside":"${awake.join("|")}|none"}`;
  // 判断用小鱼那家的便宜档（单价最低，不占小克的订阅额度）；她睡着了就借小克的 haiku
  const r = await ASK.claude(prompt, roleById(asleep("deepseek") ? "xiaoke" : "deepseek"), JUDGE_SYSTEM);
  if (r.error) throw new Error(r.error);
  const s = String(r.text || ""), i = s.indexOf("{"), j = s.lastIndexOf("}");
  let o; try { o = JSON.parse(s.slice(i, j + 1)); } catch (e) { throw new Error("回复不是 JSON：" + s.slice(0, 120)); }
  const ok = (id) => (awake.includes(id) && id !== after && !taken.includes(id) ? id : null);
  return { reply: ok(o.reply), aside: ok(o.aside) };
}

// ── 递进她那段：群里她上次看过之后的新发言 ──
function feed(id, kind, caller) {
  const all = messages(), from = (STATE.room.seen[id] ?? -1) + 1;
  const lines = all.slice(from).filter((m) => m.from !== id).map((m) => `${nameOf(m.from)}：${m.text}`);
  const ask = kind === "aside"
    ? `你可以插一句（一两句话就好）；不想插就只回「${PASS}」。`
    : (caller ? `${nameOf(caller)}在群里叫你了，接她的话；交给你的事能做就做。` : "轮到你在群里接话了，直接说你要说的。") +
      "要是在汇报干了什么活，第一段一两句只写结果，过程和细节空一行放后面（群页会把后面折起来，主人点开才看）。";
  return { upTo: all.length - 1, fresh: lines.length > 0, text: `${FEED_HEAD}主人把你们三个叫到一个群里了，大家都听得到。下面是群里你上次说话之后的新消息）\n${lines.join("\n")}\n\n（${ask}）` };
}

// 她当前那段会话：#23 记的「最近那段」，得还在、还是她的；没有就在她的项目里新开
function sidOf(id) {
  const sid = STATE.lastByRole?.[id];
  return sid && roleOfSession(sid)?.id === id ? sid : null;
}

const TURNS = new Map();     // run 号 → { role, kind, upTo, sid, round, at }（哈基米、插进别人那轮的）
const CIDS = new Map();      // 入队时带的 cid → 同上（Claude Code 那两位：结束时 run.cid 认得出）
let CID = 0;
const BUSY = new Set();      // 正在群里说话的人：一个人一次只跑一轮，后来的消息攒着下轮一起递
const AGAIN = new Map();     // 她跑着时又轮到她：跑完再来一轮（kind）

/** 让 id 在群里说一轮（kind：reply / aside） */
export function speak(id, kind = "reply", round = null, caller = null) {
  const role = roleById(id);
  if (!role || asleep(id)) return null;
  if (BUSY.has(id)) { if (kind === "reply" || !AGAIN.has(id)) AGAIN.set(id, { kind, round, caller }); return null; }
  const { text, upTo, fresh } = feed(id, kind, caller);
  if (!fresh) return null;   // 她跑着时攒下的已经在上一轮里看过了
  const sid = sidOf(id);
  BUSY.add(id);
  publish({ type: "xk", op: "room_typing", role: id, on: true });
  // 先登记再入队：没配密钥这类错，上游在 enqueue 返回之前就同步结束了这一轮，晚登记就认不出来，她会一直「在说…」
  const turn = { role: id, kind, upTo, sid, round, at: Date.now() }, cid = "xk-room-" + (++CID);
  if (ROUNDS.has(round)) ROUNDS.get(round).pending++;
  CIDS.set(cid, turn);
  let item;
  if (role.engine === "claude") {
    // 不切型号（#64，主人 11-03）：插话也用她平时那个。在她那段里中途换模型，整段上下文要重读、缓存用不上，反而更贵，
    // 界面上这段对话也会显示成换了模型。省钱的只有「判断谁接」那一下，它是单独的一次调用，不碰她的会话
    item = enqueue({ message: text, sessionId: sid, projectId: sid ? null : projectOf(id), cid });
    // 她那段正有一轮在跑（比如主人刚在私聊里说完话）：消息会直接插进那一轮，不另起一轮，就认那一轮的结束
    if (item.injected && CIDS.has(cid)) { const r = [...RUNS.values()].find((x) => !x.ended && x.sessionId === sid); if (r) TURNS.set(r.id, turn); }
  } else {
    item = { id: "xr" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), message: text, sessionId: sid };
    TURNS.set(item.id, turn);
    ENGINE_RUN[role.engine](item, {});
  }
  return item;
}

// 这一轮报的错（没配密钥、额度用完……）：群里说「没说出来」时带上原因
const ERRS = new Map();
onPublish((ev) => { if (ev?.type === "error" && ev.runId) { ERRS.set(ev.runId, String(ev.message || "").slice(0, 120)); if (ERRS.size > 100) ERRS.delete(ERRS.keys().next().value); } });

// 头像卡片上的上下文占用：她那段对话每轮结束都记一下（私聊的轮次也算，数才是她当前那段的）
END_HOOKS.push((run, f = {}) => {
  const r = !run.auto && !run.sched && f.usage?.context_tokens ? roleOfDir(run.cwd) : null;
  if (r) { STATE.room.usage[r.id] = { used: f.usage.context_tokens, window: f.usage.context_window || null, at: Date.now() }; saveState(); }
});

END_HOOKS.push((run, f = {}) => {
  const t = TURNS.get(run.id) || (run.cid && CIDS.get(run.cid));
  if (!t || t.done) return;
  t.done = true; TURNS.delete(run.id); if (run.cid) CIDS.delete(run.cid);
  BUSY.delete(t.role);
  publish({ type: "xk", op: "room_typing", role: t.role, on: false });
  STATE.room.seen[t.role] = t.upTo;
  // 新开的那段这时才有会话号：下一轮接着它（xk.mjs 记「最近那段」的钩子排在后面，等不到它）
  if (run.sessionId) STATE.lastByRole = { ...(STATE.lastByRole || {}), [t.role]: String(run.sessionId) };
  // 她说的话从她那段会话记录里取（普通轮次的结束事件里没有正文）；哈基米的 agy 也写同样格式的记录
  // 只取紧跟在群聊那条后面的回话：群里的话插进她正在跑的私聊那轮时（item.injected），同一轮里还有她回主人的私聊，那段不能贴进群
  const said = run.sessionId ? roomReply(turns(String(run.sessionId), t.at)) : "";
  const bad = f.failed || f.isError || run.aborted;
  if (bad) { const why = ERRS.get(run.id) || f.subtype; append({ from: "system", text: `${nameOf(t.role)}没说出来${why ? "：" + why : ""}` }); }
  else if (said && said !== PASS && !said.endsWith(PASS)) append({ from: t.role, text: said, ...(t.kind === "aside" ? { kind: "aside" } : {}) });
  ERRS.delete(run.id);
  saveState();
  const r = ROUNDS.get(t.round);
  if (r) r.pending--;
  if (AGAIN.has(t.role)) { const a = AGAIN.get(t.role); AGAIN.delete(t.role); speak(t.role, a.kind, a.round, a.caller); return; }
  if (!bad && said && said !== PASS && !said.endsWith(PASS)) afterSaid(t.role, said, t.round).catch((e) => log("聊天室接话出错：" + e.message));
});

export const FEED_HEAD = "（群聊：";
/** 会话里的问答 → 她在群里说的话：只要群聊递进去的那条后面的回复，私聊的问答一概不要 */
export function roomReply(ts) {
  let inRoom = false;
  const parts = [];
  for (const x of ts) {
    if (x.role === "user") inRoom = x.text.startsWith(FEED_HEAD);
    else if (inRoom) parts.push(x.text);
  }
  return parts.join("\n").trim();
}

// ── 这一批里她们之间怎么接：点了名的必接（小克把事交给小鱼就是这么交的）；没点名、这一波都说完了，才问一次有没有人想接 ──
const ROUNDS = new Map();   // 批号 → { left: 还能自己插几句, named: 点名还能接几句, pending: 这批还在说的人数, aside: 已经有人自己插过话, capped: 已经说过到上限了 }
/** 点了名的叫她接；点名的额度用完了，群里说一声（一批只说一次） */
function callNamed(r, round, ids, caller) {
  let dropped = false;
  for (const id of ids) { if (r.named > 0) { r.named--; speak(id, "reply", round, caller); } else dropped = true; }
  if (dropped && !r.capped) { r.capped = true; append({ from: "system", text: CAPPED }); saveState(); }
}
let ROUND = 0;
const asideOk = (id) => !asleep(id) && !BUSY.has(id) && Date.now() - (STATE.room.lastAside[id] || 0) >= ASIDE_GAP.ms;
async function afterSaid(who, text, round) {
  const r = ROUNDS.get(round);
  if (!r || round !== ROUND) return;   // 主人又开口了：旧的那批不再往下接
  const named = called(text, who).filter((id) => !asleep(id));
  if (named.length) { callNamed(r, round, named, who); return; }
  if (r.left <= 0 || r.aside || r.pending > 0) return;
  let j = {};
  try { j = await judge("chain", who); } catch (e) { log("聊天室：判断有没有人接话失败（这次就不接了）：" + e.message); }
  const id = [j.aside, j.reply].find((x) => x && asideOk(x));
  if (!id || round !== ROUND || r.aside) return;
  r.left--; r.aside = true; STATE.room.lastAside[id] = Date.now();
  speak(id, "aside", round);
}

// ── 主人在群里说话：先攒一批（等他说完），再定谁开口 ──
let BATCH = null;
/** 主人在群里说一句。decided：这一批定完谁开口时兑现（测试等它） */
export function ownerSays(text, to = []) {
  const msg = append({ from: "owner", text: String(text).trim(), ...(to.length ? { to } : {}) });
  const b = BATCH ||= { first: Date.now(), texts: [], to: new Set() };
  b.texts.push(msg.text); for (const id of to) b.to.add(id);
  if (!b.done) b.done = new Promise((ok) => (b.fire = ok));
  clearTimeout(b.timer);
  const hot = b.to.size || b.texts.some((x) => called(x).length);
  const due = Math.min(Date.now() + (hot ? PACE.calledMs : PACE.quietMs), b.first + PACE.maxMs);
  b.timer = setTimeout(() => { if (BATCH === b) BATCH = null; decide(b).then(b.fire, (e) => { log("聊天室：定谁开口出错：" + e.message); b.fire([]); }); }, Math.max(0, due - Date.now()));
  return { msg, decided: b.done };
}

async function decide(b) {
  const round = ++ROUND, r = { left: CAP.chain, named: CAP.named, pending: 0, aside: false, capped: false };
  ROUNDS.set(round, r);
  if (ROUNDS.size > 20) ROUNDS.delete(ROUNDS.keys().next().value);
  // 规则先定：@ 的、叫到名字的；没有就是正和主人一来一回的那位
  let ids = [...new Set([...b.to, ...b.texts.flatMap((x) => called(x))])].filter((id) => !asleep(id));
  if (!ids.length && following()) ids = [following()];
  let aside = null;
  // 拿不准：问一次便宜档；问不成就退回上一个说话的 / 当前角色
  if (!ids.length) {
    try { const j = await judge("owner"); if (j.reply) ids = [j.reply]; aside = j.aside; }
    catch (e) { log("聊天室：判断谁接话失败，按上一个说话的来：" + e.message); }
    if (!ids.length) { const last = [...messages()].reverse().find((m) => roleById(m.from) && !asleep(m.from)); const id = last ? last.from : STATE.active; if (!asleep(id)) ids = [id]; }
  } else if (ids.length < CAP.wave) {
    // 谁接已经按规则定了（点了名 / 正一来一回）：还是问一次有没有人想插一句（主人 11-03 定的：每句都问，插话才不会几乎没有）
    try { aside = (await judge("owner", null, ids)).aside; }
    catch (e) { log("聊天室：判断有没有人插话失败（这次就不插了）：" + e.message); }
  }
  ids = ids.slice(0, CAP.wave);
  if (!ids.length) { append({ from: "system", text: "她们都睡着了，等额度恢复再来" }); return []; }
  for (const id of ids) speak(id, "reply", round);
  if (aside && !ids.includes(aside) && ids.length < CAP.wave && asideOk(aside)) { r.aside = true; STATE.room.lastAside[aside] = Date.now(); speak(aside, "aside", round); }
  return ids;
}

// ── 她们在别处（私聊里）往群里说的话：记忆工具 room_say 写进 roles/.room/outbox/，这里每秒收一次 ──
const OUTBOX = path.join(ROLES_DIR, ".room", "outbox");
/** 她说一句（不是在群里轮到她，是她自己用工具贴进来的）：点了名的叫她接，不叫别人插话 */
export function memberSays(from, text) {
  const msg = append({ from, text: String(text).trim() });
  const round = ++ROUND, r = { left: CAP.chain, named: CAP.named, pending: 0, aside: true, capped: false };
  ROUNDS.set(round, r);
  callNamed(r, round, called(msg.text, from).filter((x) => !asleep(x)), from);
  return msg;
}
export function drainOutbox() {
  let fs0 = [];
  try { fs0 = fs.readdirSync(OUTBOX).filter((f) => f.endsWith(".json")).sort(); } catch (e) { if (e.code !== "ENOENT") throw e; return; }
  for (const f of fs0) {
    const p = path.join(OUTBOX, f);
    try {
      const o = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!roleById(o.from) || !String(o.text || "").trim()) throw new Error("不是她们贴的话：" + JSON.stringify(o).slice(0, 80));
      memberSays(o.from, o.text);
    } catch (e) { log(`聊天室：收不了 ${f}：${e.message}`); }
    fs.rmSync(p, { force: true });
  }
}
if (LIVE) setInterval(() => { try { drainOutbox(); } catch (e) { log("聊天室：收 outbox 出错：" + e.message); } }, 1000).unref();

export function members() {
  return ROLES.map((r) => ({
    id: r.id, name: nameOf(r.id),
    state: asleep(r.id) ? "sleep" : BUSY.has(r.id) ? "talk" : "idle",
    sessionId: sidOf(r.id), usage: STATE.room.usage[r.id] || null, cooldown: STATE.cooldown[r.id] || null,
  }));
}

addRoute(async (req, res, u, p) => {
  if (p !== "/api/xk/room") return NEXT;
  if (req.method === "GET") {
    const after = Number(u.searchParams.get("after") ?? -1);
    return sendJson(res, 200, { messages: messages().filter((m) => m.n > after), members: members() });
  }
  if (req.method === "POST") {
    const b = await json(req);
    if (!String(b.text || "").trim()) throw httpError(400, "text 不能为空");
    const to = Array.isArray(b.to) ? b.to.filter((id) => roleById(id)) : [];
    return sendJson(res, 200, { msg: ownerSays(b.text, to).msg });
  }
  return NEXT;
});

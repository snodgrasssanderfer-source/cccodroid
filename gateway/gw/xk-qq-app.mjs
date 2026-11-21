// 12 号的 App 聊天室（主人 11-10 定）：QQ 那边断了也能在 App 里和她聊。
// 不另造一个 12 号：App 里说的话当成主人在 QQ 私聊里说的，递进她和主人私聊的同一段（xk-qq.mjs 的 appIn），
// 她的回复按来路送回——App 里说就回 App，QQ 断了她主动找主人（日记、要批的事）也落到这里。QQ 私聊的来回照抄一份进来，一页看全。
// 访客：主人可以把小克、哈基米、小鱼请进来，也能随时请出去。客人在她自己当前那段对话里接话（和「我们仨」的群一样），
// 记东西记进她自己的记忆；12 号只有她自己那本记忆本，彼此的记忆不混（主人 11-10 叮嘱的）。
// 谁接话：主人的话 12 号都接（主人在头像栏只点了客人时除外）；客人只在被点名时接；她们之间点名接话一串最多 CHAIN 句。
import fs from "node:fs";
import path from "node:path";
import { CFG, log } from "./config.mjs";
import { publish } from "./bus.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { END_HOOKS, enqueue } from "./queue.mjs";
import { RUNS } from "./runs.mjs";
import { ROLES, roleById, roleOfSession } from "./xk-roles.mjs";
import { turns } from "./xk-transcript.mjs";
import { ENGINE_RUN, STATE, addRoute, carryText, httpError, json, projectOf, saveState, writeCarry } from "./xk-core.mjs";
import { takeRollover } from "./xk-rollover.mjs";
import { displayName } from "./xk-shared.mjs";
import { cooling } from "./xk-handover.mjs";

const DIR = path.join(CFG.workspace, "qq-clean");
const FILE = path.join(DIR, "app-room.jsonl");
export const MEDIA_DIR = path.join(DIR, "app-media");
export const TWELVE = "twelve";
export const CHAIN = 6;
const initState = () => ({ guests: [], seen: {}, twelveSeen: -1 });
STATE.qqApp ||= initState();

const asleep = (id) => !!cooling(id);
const nameOf = (id) => (id === TWELVE ? "12号" : id === "owner" ? "主人" : id === "system" ? "系统" : displayName(id));
const CALLS = { xiaoke: /小克|克克|大小姐|姐姐/, hachimi: /哈基米|基米|猫猫/, deepseek: /小鱼|鲸鱼|大肥鱼|deepseek/i };
const CALL_TWELVE = /12\s*号|十二号|妹妹|小椿|椿/;
const CALL_ALL = /大家|你们几个|你们俩|你们仨|各位|都来/;
/** 话里点到了哪几位在场的客人（but：说话的人自己） */
// 点了具体的名字就只叫这几位（11-11：主人「哈基米，和大家打个招呼」把小克也叫起来了）；
// 「大家」只在主人的话里、又没点名时算叫全体。她们之间说「大家好」是寒暄，不算叫人
export const calledGuests = (text, but, owner = false) => {
  const t = String(text || ""), named = STATE.qqApp.guests.filter((id) => id !== but && CALLS[id]?.test(t));
  return named.length || !owner || !CALL_ALL.test(t) ? named : STATE.qqApp.guests.filter((id) => id !== but);
};
export const callsTwelve = (text) => CALL_TWELVE.test(String(text || ""));

// ── 消息：一行一条 {n, at, from: "owner" | "twelve" | "system" | 角色, text, via?: "app" | "qq", kind?: "perm" | "image" | "audio" | "file", media?} ──
let MSGS = null;
export function appMessages() {
  if (MSGS) return MSGS;
  try { MSGS = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch (e) { if (e.code !== "ENOENT") throw new Error(`12号聊天室的记录读不了：${e.message}`); MSGS = []; }
  return MSGS;
}
/** 记一条、推给界面。notify：QQ 不通时她找主人，弹系统通知（App 在前台时外壳不弹） */
export function appSay(from, text, extra = {}) {
  const { notify, ...rest } = extra;
  const t = String(text ?? "").trim();
  if (!t && !rest.media) return null;
  fs.mkdirSync(DIR, { recursive: true });
  const msg = { n: appMessages().length, at: Date.now(), from, text: t, ...rest };
  fs.appendFileSync(FILE, JSON.stringify(msg) + "\n");
  MSGS.push(msg);
  publish({ type: "xk", op: "qqapp", msg });
  if (notify) publish({ type: "sched_note", taskId: "xk-qq-app", title: nameOf(from === "system" ? TWELVE : from), text: t.slice(0, 200), sessionId: null, ok: true });
  return msg;
}
const EXT = { "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/jpeg": "jpg", "audio/wav": "wav" };
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
/** 图、语音、文件：存进 app-media，消息里只记文件名 */
export function appMedia(from, buf, ext, kind, text = "", extra = {}) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const safe = String(ext || "bin").replace(/[^\w]/g, "").slice(0, 8) || "bin";
  const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${safe}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  return appSay(from, text, { kind, media: name, ...extra });
}
/** 测试用 */
export function resetApp() { MSGS = []; fs.rmSync(FILE, { force: true }); STATE.qqApp = initState(); BUSY.clear(); TURNS.clear(); CIDS.clear(); AGAIN.clear(); CHAINS.clear(); TWELVE_AT = -1; TYPING.clear(); }

// ── 主人这边由 xk-qq.mjs 接上：host.deliver 把一句话递进 12 号那段，host.connected 说 QQ 通不通 ──
let HOST = { deliver: null, connected: () => false };
export function setHost(h) { HOST = { ...HOST, ...h }; }

const TYPING = new Set();
function typing(who, on) {
  if (on ? TYPING.has(who) : !TYPING.has(who)) return;
  if (on) TYPING.add(who); else TYPING.delete(who);
  publish({ type: "xk", op: "qqapp_typing", who, on });
}

// 一串接话：主人说一句开一串，点名接话每接一句扣一次
const CHAINS = new Map();   // 串号 → { left }
let CHAIN_N = 0;
function newChain() { const id = ++CHAIN_N; CHAINS.set(id, { left: CHAIN }); if (CHAINS.size > 20) CHAINS.delete(CHAINS.keys().next().value); return id; }
function spend(chain) { const c = CHAINS.get(chain); if (!c || c.left <= 0) return false; c.left--; return true; }

/** 12 号上次看过之后，客人和系统说的（主人的话和她自己的不算：主人那句另递，她自己的她记得） */
function twelveContext(skipN = -1) {
  const all = appMessages(), from = STATE.qqApp.twelveSeen + 1;
  const lines = all.slice(from).filter((m) => m.n !== skipN && m.from !== TWELVE && m.from !== "owner" && m.via !== "qq")
    .map((m) => m.from === "system" ? `[App 聊天室] （${m.text}）` : `[App 聊天室] ${nameOf(m.from)}（姐姐）：${m.text}`);
  STATE.qqApp.twelveSeen = all.length - 1; saveState();
  if (!lines.length) return "";
  return "[App 聊天室里姐姐们说的话。她们是主人手机里住着的三位，各有各的记忆；她们记得什么你看不到，你的记忆本也只记你自己的事，别替她们记]\n" + lines.join("\n") + "\n";
}
let TWELVE_AT = -1;   // 12 号这一轮开始时聊天室有几条：收尾时取她这一轮说的
function askTwelve(chain, text, line) {
  if (!HOST.deliver) throw httpError(503, "QQ 那边还没配（没有 qq.json），12号起不来");
  if (!TYPING.has(TWELVE)) TWELVE_AT = appMessages().length;
  typing(TWELVE, true);
  try { HOST.deliver({ text, line, chain }); }
  catch (e) { typing(TWELVE, false); throw e; }
}
/** 12 号从 App 来的那一轮收尾（xk-qq.mjs 的结束钩子叫）：她点了在场客人的名，客人接 */
export function twelveDone(chain, { failed = false, why = "", more = false } = {}) {
  if (more) return;   // 跑着时又攒了话，下一轮接着跑
  typing(TWELVE, false);
  const said = appMessages().slice(Math.max(0, TWELVE_AT)).filter((m) => m.from === TWELVE && m.via !== "qq").map((m) => m.text).join("\n");
  TWELVE_AT = -1;
  if (!said && failed) appSay("system", `12号这一轮没说出来${why ? "：" + String(why).slice(0, 120) : ""}`);
  if (!said) return;
  for (const id of calledGuests(said, TWELVE)) if (spend(chain)) speak(id, chain, TWELVE);
}

// ── 主人在 App 里说一句 ──
/** to：主人在头像栏点了谁（12 号写 twelve）；没点就是 12 号接，话里点到名的客人也接 */
export function ownerSays(text, to = []) {
  const t = String(text || "").trim();
  if (!t) throw httpError(400, "text 不能为空");
  const msg = appSay("owner", t, { via: "app", ...(to.length ? { to } : {}) });
  const chain = newChain();
  const picked = to.filter((id) => id === TWELVE || STATE.qqApp.guests.includes(id));
  const twelve = !picked.length || picked.includes(TWELVE);
  const guests = picked.length ? picked.filter((id) => id !== TWELVE) : calledGuests(t, null, true);
  if (twelve) askTwelve(chain, t, twelveContext(msg.n));
  for (const id of guests) speak(id, chain, "owner");
  return msg;
}

// ── 访客 ──
export function setGuest(id, on) {
  const role = roleById(id);
  if (!role) throw httpError(400, "没有这个人：" + id);
  const g = STATE.qqApp.guests, has = g.includes(id);
  if (on && has) return STATE.qqApp.guests;
  if (!on && !has) return STATE.qqApp.guests;
  if (on) { if (asleep(id)) throw httpError(409, `${nameOf(id)}睡着了（额度用完），等她醒了再请`); g.push(id); }
  else STATE.qqApp.guests = g.filter((x) => x !== id);
  // 刚请进来：从这一条往后看，之前的私聊她不看（那是主人和 12 号之间的）
  if (on) STATE.qqApp.seen[id] = appMessages().length;
  saveState();
  appSay("system", on ? `主人把${nameOf(id)}请进来了` : `${nameOf(id)}出去了`);
  publish({ type: "xk", op: "qqapp_members", members: members() });
  return STATE.qqApp.guests;
}

// ── 客人接话：在她自己当前那段对话里接着说（和 xk-room 同一套），回复贴进聊天室 ──
export const GUEST_HEAD = "（12号聊天室：";
const JUST = new Map();
function sidOf(id) {
  const sid = JUST.get(id) || STATE.lastByRole?.[id];
  return sid && roleOfSession(sid)?.id === id ? sid : null;
}
const TURNS = new Map(), CIDS = new Map(), BUSY = new Map(), AGAIN = new Map();
let CID = 0;
function guestFeed(id, caller) {
  const all = appMessages(), from = STATE.qqApp.seen[id] ?? all.length;
  const lines = all.slice(from).filter((m) => m.from !== id).map((m) => `${nameOf(m.from)}${m.via === "qq" ? "（QQ 上）" : ""}：${m.kind && m.kind !== "perm" ? `[${m.kind === "image" ? "图片" : m.kind === "audio" ? "语音" : "文件"}] ` : ""}${m.text}`);
  const ask = caller === "owner" ? "主人叫你了，接他的话。" : caller === TWELVE ? "12号叫你了，接她的话。" : caller ? `${nameOf(caller)}叫你了，接她的话。` : "轮到你接话了。";
  return { upTo: all.length - 1, text: `${GUEST_HEAD}主人把你请进了他和 12号 的 App 聊天室，大家都听得到。12号是主人在 QQ 上的那个 AI（也是 Claude），她有她自己的记忆本，你有你的：听到的事要记就用你自己的记忆工具记，别往她的 qq-clean 里写。下面是你上次说话之后的新消息）\n${lines.join("\n")}\n\n（${ask}直接说你要说的话，像在群里接话一样短；这里不是 QQ，不用发消息的工具。点谁的名字她就会接。）` };
}
export function speak(id, chain = 0, caller = null) {
  const role = roleById(id);
  if (!role || asleep(id) || !STATE.qqApp.guests.includes(id)) return null;
  if (BUSY.has(id)) { AGAIN.set(id, { chain, caller }); return null; }
  const { text, upTo } = guestFeed(id, caller);
  let sid = sidOf(id), carry = "";
  const ro = takeRollover(id, sid);
  if (ro) { sid = null; carry = carryText(ro.fromSid, id, id, ro.reason); }
  const cid = "xk-qqapp-" + (++CID);
  const turn = { role: id, upTo, chain, at: Date.now(), cid };
  CIDS.set(cid, turn); BUSY.set(id, turn.at); typing(id, true);
  let item;
  try {
    if (role.engine === "claude") {
      item = enqueue({ message: text, sessionId: sid, projectId: sid ? null : projectOf(id), cid });
      if (carry) writeCarry(id, item.id, carry);
      if (item.injected && CIDS.has(cid)) { const r = [...RUNS.values()].find((x) => !x.ended && x.sessionId === sid); if (r) TURNS.set(r.id, turn); }
    } else {
      item = { id: "xq" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), message: text, sessionId: sid };
      TURNS.set(item.id, turn);
      ENGINE_RUN[role.engine](item, { carry });
    }
  } catch (e) {
    turn.done = true; CIDS.delete(cid); TURNS.delete(item?.id); BUSY.delete(id); typing(id, false);
    appSay("system", `${nameOf(id)}没说出来：${String(e.message).slice(0, 120)}`);
    return null;
  }
  if (ro) publish({ type: "xk", op: "handover", runId: item.id, from: id, to: id, reason: ro.reason, fromSession: ro.fromSid, rollover: true });
  return item;
}
const NUDGE = /^\[Your previous response had no visible output/;
/** 会话里的问答 → 她在聊天室说的话：只要聊天室递进去那条后面的回复 */
export function guestReply(ts) {
  let inRoom = false;
  const parts = [];
  for (const x of ts) {
    // Claude Code 自己补的催促（上一轮没出字）不算换了话头：11-11 哈基米被催了一下才开口，这句被当成别处的话丢了
    if (x.role === "user") { if (!NUDGE.test(x.text)) inRoom = x.text.startsWith(GUEST_HEAD); }
    else if (inRoom) parts.push(x.text);
  }
  // 11-11 中转站上的 Gemini 有一回把思考过程当正文写了出来（[::thought … :]），带着她私下的记忆贴进了聊天室；
  // 网关重启打断的那轮，Claude Code 会补一句 No response requested.——这两样都不是她要说的话
  return parts.join("\n").replace(/\[::thought[\s\S]*?(?::\]|$)/g, "").split("\n").filter((l) => l.trim() !== "No response requested.").join("\n").trim();
}
const ERRS = new Map();
END_HOOKS.push((run, f = {}) => {
  const t = TURNS.get(run.id) || (run.cid && CIDS.get(run.cid));
  if (!t || t.done) return;
  t.done = true; TURNS.delete(run.id); if (run.cid) CIDS.delete(run.cid); if (t.cid) CIDS.delete(t.cid);
  BUSY.delete(t.role); typing(t.role, false);
  STATE.qqApp.seen[t.role] = t.upTo + 1;
  const said = run.sessionId ? guestReply(turns(String(run.sessionId), t.at)) : "";
  const here = STATE.qqApp.guests.includes(t.role);   // 说着说着被请出去了：话不贴
  // 看过的只算到递进去的那条：她说话这段时间里别人说的，下一轮还要给她（11-11：哈基米第二轮收到的是空的）。她自己的话 guestFeed 本来就滤掉
  if (said && here) appSay(t.role, said);
  else if (here && (f.failed || f.isError || run.aborted)) appSay("system", `${nameOf(t.role)}没说出来${f.subtype ? "：" + f.subtype : ""}`);
  saveState();
  if (run.sessionId) JUST.set(t.role, String(run.sessionId));
  try {
    if (AGAIN.has(t.role)) { const a = AGAIN.get(t.role); AGAIN.delete(t.role); speak(t.role, a.chain, a.caller); return; }
    if (!said || !here) return;
    for (const id of calledGuests(said, t.role)) if (spend(t.chain)) speak(id, t.chain, t.role);
    // 递进去的是那几行原话（标着是姐姐说的），不当成主人的话：主人那句「批」只认主人
    if (callsTwelve(said) && spend(t.chain)) askTwelve(t.chain, "", twelveContext());
  } catch (e) { log("12号聊天室接话出错：" + e.message); }
  finally { JUST.delete(t.role); }
});

export function members() {
  return {
    twelve: { state: TYPING.has(TWELVE) ? "talk" : "idle" },
    guests: STATE.qqApp.guests.slice(),
    roles: ROLES.map((r) => ({ id: r.id, name: nameOf(r.id), guest: STATE.qqApp.guests.includes(r.id), state: asleep(r.id) ? "sleep" : BUSY.has(r.id) ? "talk" : "idle" })),
    qq: !!HOST.connected(),
  };
}

addRoute(async (req, res, u, p) => {
  if (!p.startsWith("/api/xk/qqapp")) return NEXT;
  if (p.startsWith("/api/xk/qqapp/media/") && req.method === "GET") {
    const name = decodeURIComponent(p.slice("/api/xk/qqapp/media/".length));
    if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) throw httpError(400, "文件名不对");
    let buf; try { buf = fs.readFileSync(path.join(MEDIA_DIR, name)); } catch { throw httpError(404, "没有这个文件"); }
    const ext = name.split(".").pop().toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "content-length": buf.length, "cache-control": "private, max-age=86400" });
    return res.end(buf);
  }
  if (p === "/api/xk/qqapp/guest" && req.method === "POST") {
    const b = await json(req);
    return sendJson(res, 200, { guests: setGuest(String(b.id || ""), !!b.on), members: members() });
  }
  if (p !== "/api/xk/qqapp") return NEXT;
  if (req.method === "GET") {
    const after = Number(u.searchParams.get("after") ?? -1);
    // 第一次打开只给最近 200 条，往上翻的以后再做
    const list = appMessages().filter((m) => m.n > after);
    return sendJson(res, 200, { messages: after < 0 ? list.slice(-200) : list, members: members() });
  }
  if (req.method === "POST") {
    const b = await json(req);
    const to = Array.isArray(b.to) ? b.to.map(String) : [];
    return sendJson(res, 200, { msg: ownerSays(b.text, to) });
  }
  return NEXT;
});

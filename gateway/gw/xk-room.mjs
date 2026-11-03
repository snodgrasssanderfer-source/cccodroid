// 聊天室（#35，设计稿 xk/design/presence.md 第四节）：像 QQ 群，主人一进群三个人都在。
// 群里不另开会话（主人 11-03 定的）：每个人就在她当前那段对话里接着说——群里的新发言作为一条消息递进她那段，
// 她的回复贴回群里。所以人设、记忆注入、工具都照常，主人回到私聊时群里聊过的她都记得；记忆整理也照旧按她那段来。
import fs from "node:fs";
import path from "node:path";
import { publish } from "./bus.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { END_HOOKS, enqueue } from "./queue.mjs";
import { RUNS } from "./runs.mjs";
import { providerById } from "./providers.mjs";
import { ROLES, roleById, roleOfSession } from "./xk-roles.mjs";
import { turns } from "./xk-transcript.mjs";
import { cheapModel } from "./xk-memory.mjs";
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
export function resetRoom() { MSGS = []; fs.rmSync(FILE, { force: true }); STATE.room = { seen: {}, lastAside: {}, usage: {} }; ASIDED.clear(); }

const asleep = (id) => { const c = STATE.cooldown[id]; return !!(c && !(c.until <= Date.now())); };
const nameOf = (id) => (id === "owner" ? "主人" : id === "deepseek" ? "小鱼" : roleById(id)?.name || id);
// 怎么叫她们：名字和常用叫法
const CALLS = { xiaoke: /小克|克克|大小姐/, hachimi: /哈基米|基米|小猫|猫猫/, deepseek: /小鱼|鲸鱼|大肥鱼|deepseek/i };

/** 这句谁接：点了名的（@ 或句子里叫到）；没点名就是群里上一个说话的，再没有就是当前角色。睡着的不接 */
export function whoAnswers(text, to = []) {
  let ids = (to.length ? to : ROLES.map((r) => r.id).filter((id) => CALLS[id]?.test(text))).filter((id) => roleById(id));
  if (!ids.length) {
    const last = [...messages()].reverse().find((m) => roleById(m.from) && !asleep(m.from));
    ids = [last ? last.from : STATE.active];
  }
  return ids.filter((id) => !asleep(id));
}

// ── 递进她那段：群里她上次看过之后的新发言 ──
function feed(id, kind) {
  const all = messages(), from = (STATE.room.seen[id] ?? -1) + 1;
  const lines = all.slice(from).filter((m) => m.from !== id).map((m) => `${nameOf(m.from)}：${m.text}`);
  const ask = kind === "aside"
    ? `你可以插一句（一两句话就好）；不想插就只回「${PASS}」。`
    : "轮到你在群里接话了，直接说你要说的。";
  return { upTo: all.length - 1, fresh: lines.length > 0, text: `（群聊：主人把你们三个叫到一个群里了，大家都听得到。下面是群里你上次说话之后的新消息）\n${lines.join("\n")}\n\n（${ask}）` };
}

// 她当前那段会话：#23 记的「最近那段」，得还在、还是她的；没有就在她的项目里新开
function sidOf(id) {
  const sid = STATE.lastByRole?.[id];
  return sid && roleOfSession(sid)?.id === id ? sid : null;
}

const TURNS = new Map();     // run 号 → { role, kind, upTo, sid, at }
const BUSY = new Set();      // 正在群里说话的人：一个人一次只跑一轮，后来的消息攒着下轮一起递
const AGAIN = new Map();     // 她跑着时又轮到她：跑完再来一轮（kind）

/** 让 id 在群里说一轮（kind：reply / aside） */
export function speak(id, kind = "reply", ownerN = null) {
  const role = roleById(id);
  if (!role || asleep(id)) return null;
  if (BUSY.has(id)) { if (kind === "reply" || !AGAIN.has(id)) AGAIN.set(id, { kind, ownerN }); return null; }
  const { text, upTo, fresh } = feed(id, kind);
  if (!fresh) return null;   // 她跑着时攒下的已经在上一轮里看过了
  const sid = sidOf(id);
  BUSY.add(id);
  publish({ type: "xk", op: "room_typing", role: id, on: true });
  let item;
  if (role.engine === "claude") {
    // 插话用便宜档（设计稿第四节）；正经接话用她平时那个
    const model = kind === "aside" ? cheapModel(providerById(role.provider) || {}) : null;
    item = enqueue({ message: text, sessionId: sid, projectId: sid ? null : projectOf(id), ...(model ? { model } : {}) });
  } else {
    item = { id: "xr" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), message: text, sessionId: sid };
  }
  // 她那段正有一轮在跑（比如主人刚在私聊里说完话）：消息会直接插进那一轮，不另起一轮，就认那一轮的结束
  const runId = item.injected ? [...RUNS.values()].find((r) => !r.ended && r.sessionId === sid)?.id || item.id : item.id;
  TURNS.set(runId, { role: id, kind, upTo, sid, ownerN, at: Date.now() });
  if (role.engine !== "claude") ENGINE_RUN[role.engine](item, {});
  return item;
}

END_HOOKS.push((run, f = {}) => {
  const t = TURNS.get(run.id);
  if (!t) return;
  TURNS.delete(run.id);
  BUSY.delete(t.role);
  publish({ type: "xk", op: "room_typing", role: t.role, on: false });
  STATE.room.seen[t.role] = t.upTo;
  // 新开的那段这时才有会话号：下一轮接着它（xk.mjs 记「最近那段」的钩子排在后面，等不到它）
  if (run.sessionId) STATE.lastByRole = { ...(STATE.lastByRole || {}), [t.role]: String(run.sessionId) };
  if (f.usage?.context_tokens) STATE.room.usage[t.role] = { used: f.usage.context_tokens, window: f.usage.context_window || null, at: Date.now() };
  // 她说的话从她那段会话记录里取（普通轮次的结束事件里没有正文）；哈基米的 agy 也写同样格式的记录
  const said = run.sessionId ? turns(String(run.sessionId), t.at).filter((x) => x.role === "assistant").map((x) => x.text).join("\n").trim() : "";
  if (f.failed || f.isError || run.aborted) append({ from: "system", text: `${nameOf(t.role)}没说出来${f.subtype ? "（" + f.subtype + "）" : ""}` });
  else if (said && said !== PASS && !said.endsWith(PASS)) append({ from: t.role, text: said, ...(t.kind === "aside" ? { kind: "aside" } : {}) });
  saveState();
  if (AGAIN.has(t.role)) { const a = AGAIN.get(t.role); AGAIN.delete(t.role); speak(t.role, a.kind, a.ownerN); return; }
  // 主人那句的正式回复贴出来了：看看有没有人想插一句（主人一句话最多一个人插）
  if (t.kind === "reply" && t.ownerN != null && !ASIDED.has(t.ownerN)) { ASIDED.add(t.ownerN); offerAside(t.role, t.ownerN); }
});

const ASIDED = new Set();   // 已经让人插过话的主人那句（按群消息号）
function offerAside(after, ownerN) {
  const now = Date.now();
  const who = ROLES.map((r) => r.id).filter((id) => id !== after && !asleep(id) && !BUSY.has(id) && now - (STATE.room.lastAside[id] || 0) >= ASIDE_GAP.ms)
    .sort((a, b) => (STATE.room.lastAside[a] || 0) - (STATE.room.lastAside[b] || 0))[0];
  if (!who) return;
  STATE.room.lastAside[who] = now;
  speak(who, "aside", ownerN);
}

/** 主人在群里说一句 */
export function ownerSays(text, to = []) {
  const msg = append({ from: "owner", text: String(text).trim(), ...(to.length ? { to } : {}) });
  const ids = whoAnswers(msg.text, to);
  if (!ids.length) append({ from: "system", text: "她们都睡着了，等额度恢复再来" });
  for (const id of ids) speak(id, "reply", msg.n);
  return { msg, answers: ids };
}

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
    return sendJson(res, 200, ownerSays(b.text, to));
  }
  return NEXT;
});

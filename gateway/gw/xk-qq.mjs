// QQ 接入（#134，主人 11-06 定的）：NapCat（OneBot 11）的正向 WebSocket 客户端，外加「聊天 / 工作」两种模式。
// 隐私是硬要求：仓库公开，QQ 号、token、电脑 IP 一个都不进仓库、日志、测试。配置只读手机本地的 ~/.config/xiaoke/qq.json，
// 没有这个文件就什么都不做。日志里只说「连上了 / 断了」，不带地址。
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { CFG, LIVE, log } from "./config.mjs";
import { END_HOOKS, enqueue } from "./queue.mjs";
import { markRun } from "./xk-memory.mjs";
import { RUNS } from "./runs.mjs";
import { STATE, projectOf, saveState } from "./xk-core.mjs";
import { roleOfSession } from "./xk-roles.mjs";
import { turns } from "./xk-transcript.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 和 state.json 放一起（.config/xiaoke）；只在手机上，不进仓库
export const CONFIG_FILE = path.join(CFG.home, ".config", "xiaoke", "qq.json");
// 聊天模式的干净会话：不放 roles/ 下面，不然会读到世界书和三人的 CLAUDE.md（roleOfDir 也认不出它）
export const CLEAN_DIR = path.join(CFG.workspace, "qq-clean");
// 聊天模式只给联网搜索和读网页（AstrBot 的做法，主人 11-06 定的）。用白名单（--tools）而不是黑名单：
// 黑名单漏了 Read/Grep 就能读到手机上的 token 和记忆，漏了 mcp__bili 群里谁都能让她去 B站删评论（小克审 #135 时查出来的）
export const CLEAN_TOOLS = ["WebSearch", "WebFetch"];
export const CLEAN_DENY = ["Bash", "BashOutput", "KillShell", "Edit", "MultiEdit", "Write", "NotebookEdit", "Read", "Glob", "Grep", "LS", "Task", "Agent", "Skill"];
// 人设卡：主人改好的琉璃川椿卡放这里。不能叫 CLAUDE.md（那会被当成项目说明，叠在 Claude Code 默认的编程助手提示下面）；
// 它整个当系统提示（--system-prompt），Claude Code 默认那套一个字都不带
export const CARD_FILE = path.join(CLEAN_DIR, "card.md");
// 聊天模式只挂这一个 MCP：QQ 发消息、拍一拍、看图、表情库、她自己的轻量记忆（#134 第二步，主人说的卡上那套）
export const QQ_MCP = path.join(HERE, "xk-qq-mcp.mjs");
export const QQ_MCP_NAME = "qq";
export const QQ_TOOLS = ["send_message", "send_poke", "get_message_images", "list_stickers", "get_sticker_image", "send_sticker", "sticker_note", "collect_sticker", "memory_append", "memory_query", "memory_remove"];
/** MCP 服务的配置（JSON 串）：只这一个服务。路径是本机的，不外传 */
export const qqMcpConfig = () => JSON.stringify({ mcpServers: { [QQ_MCP_NAME]: { type: "stdio", command: process.execPath, args: [QQ_MCP] } } });
// MCP 和网关不在一个进程里：借文件来回（和留言板、群一个路子）。MCP 写 req/，网关做完把结果写 res/
export const RPC_DIR = path.join(CLEAN_DIR, ".rpc");
const REQ_DIR = path.join(RPC_DIR, "req"), RES_DIR = path.join(RPC_DIR, "res"), RUN_DIR = path.join(RPC_DIR, "runs"), TMP_DIR = path.join(RPC_DIR, "tmp");
export const STICKER_DIR = path.join(CLEAN_DIR, "stickers");
export const MEMORY_FILE = path.join(CLEAN_DIR, "memory.json");

const RECONNECT_MAX = 30000;
const retryBase = () => Number(process.env.CCAPP_QQ_RETRY_MS) || 1000;
const WORK_ON = ["换成工作模型", "换成工作模式"], WORK_OFF = ["回到聊天模式"];
const MODE_TEXT = { work: "已切到工作模式", chat: "已回到聊天模式" };

STATE.qq ||= { modes: {}, sessions: {} };   // 会话 → 模式（chat / work）；会话 → 干净会话的 Claude 会话号
const BUSY = new Map();      // 会话 → { at, cid }：正在跑一轮
const PENDING = new Map();   // 会话 → 跑着时攒下的几句（跑完一起递进去）
const RUNSQQ = new Map();    // run 号 → { key, cfg, ev, kind, at, head }
const SENT = new Set();      // 自己发出去的 message_id：群里「引用了机器人的话」要认它
const WAITERS = new Map();   // 发出去的 echo → { action, resolve, reject, timer }
const NICK = new Map();      // QQ 号 → 昵称（从收到的消息里记，拍一拍要用）
const MSGS = new Map();      // message_id → { nick, text }：引用要还原成「谁说了什么」
export const REPLIES = [];   // 每一句要发回 QQ 的话（测试看它；真发由 send 去做）
/** 测试用：把模块里的会话状态清干净 */
export function resetQQ() {
  STATE.qq = { modes: {}, sessions: {} };
  BUSY.clear(); PENDING.clear(); RUNSQQ.clear(); SENT.clear(); WAITERS.clear(); NICK.clear(); MSGS.clear(); HISTORY.clear(); REPLIES.length = 0;
}
function remember(id, o, map, cap) {
  if (!id) return;
  map.delete(id); map.set(String(id), o);
  while (map.size > cap) map.delete(map.keys().next().value);
}

// ── 配置 ──
/** 读 qq.json；没有、坏了、没启用都返回 null（模块不启动）。字段缺一个也算坏，宁可不动 */
export function loadConfig(file = CONFIG_FILE) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw new Error(`qq.json 读不了（${file}）：${e.message}`); }
  if (!j || typeof j !== "object") throw new Error("qq.json 不是对象");
  if (!j.enabled) return null;
  for (const k of ["ws", "token", "bot", "owner"]) if (typeof j[k] !== "string" || !j[k]) throw new Error(`qq.json 缺 ${k}`);
  if (!/^wss?:\/\//.test(j.ws)) throw new Error("qq.json 的 ws 要写成 ws:// 或 wss://");
  return { ...j, names: Array.isArray(j.names) ? j.names.map(String).filter(Boolean) : [] };
}

/** 日志和报错里出现什么都不带地址、不带 token：调用处一律用这句，别拼 url。
 *  LAST 是测试用的：日志在测试环境里不落盘（config 的 log 只在 LIVE 时写），得能看见自己说了什么 */
const LAST = [];
const say = (s) => { LAST.push(String(s)); if (LAST.length > 200) LAST.shift(); log("QQ：" + s); };
export const qqLog = () => LAST.slice();

// ── WebSocket：够用的客户端（握手带 Authorization，文本帧收发，ping/pong、close 都认） ──
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function frame(payload, opcode, mask) {   // mask=true：客户端→服务端
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  let head;
  if (data.length < 126) head = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | data.length]);
  else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = (mask ? 0x80 : 0) | 126; head.writeUInt16BE(data.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = (mask ? 0x80 : 0) | 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
  if (!mask) return Buffer.concat([head, data]);
  const m = crypto.randomBytes(4), out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ m[i % 4];
  return Buffer.concat([head, m, out]);
}
export const encodeFrame = (payload, opcode = 0x1) => frame(payload, opcode, true);
export const serverFrame = (payload, opcode = 0x1) => frame(payload, opcode, false);
/** 一段字节里能解出几帧：{ frames: [{ opcode, payload }], rest }（半帧留在 rest 里） */
export function decodeFrames(buf) {
  const frames = [];
  let i = 0;
  for (;;) {
    if (buf.length - i < 2) break;
    const opcode = buf[i] & 0x0f, masked = !!(buf[i + 1] & 0x80);
    let len = buf[i + 1] & 0x7f, at = i + 2;
    if (len === 126) { if (buf.length - at < 2) break; len = buf.readUInt16BE(at); at += 2; }
    else if (len === 127) { if (buf.length - at < 8) break; len = Number(buf.readBigUInt64BE(at)); at += 8; }
    if (len > 8 << 20) throw new Error("帧太大：" + len);
    if (masked && buf.length - at < 4) break;
    const m = masked ? buf.subarray(at, at + 4) : null;
    if (masked) at += 4;
    if (buf.length - at < len) break;
    let payload = buf.subarray(at, at + len);
    if (m) { const out = Buffer.alloc(len); for (let k = 0; k < len; k++) out[k] = payload[k] ^ m[k % 4]; payload = out; }
    frames.push({ opcode, payload });
    i = at + len;
  }
  return { frames, rest: buf.subarray(i) };
}

let SOCK = null, RETRY = 0, TIMER = null, STOPPED = false;
const status = { connected: false, lastError: "" };

function connect(cfg) {
  if (STOPPED || SOCK) return;
  const u = new URL(cfg.ws);
  const key = crypto.randomBytes(16).toString("base64");
  const mod = u.protocol === "wss:" ? https : http;
  const req = mod.request({
    hostname: u.hostname, port: u.port || (u.protocol === "wss:" ? 443 : 80), path: u.pathname + u.search,
    headers: {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key,
      Authorization: `Bearer ${cfg.token}`,
    },
  });
  const hide = (x) => String(x).split(u.hostname).join("***");   // 报错原文里可能带地址（ECONNREFUSED 192.168.x.x:3001）
  const again = (why) => {
    const safe = hide(why);
    status.connected = false; status.lastError = safe;
    const wait = nextDelay();
    say(`没连上（${safe}），${Math.round(wait / 1000)} 秒后再试`);
    armRetry(cfg, wait);
  };
  req.on("upgrade", (res, socket, head) => {
    const want = crypto.createHash("sha1").update(key + GUID).digest("base64");
    if (res.headers["sec-websocket-accept"] !== want) { socket.destroy(); return again("握手对不上"); }
    SOCK = socket; RETRY = 0; status.connected = true; status.lastError = "";
    say("连上了");
    // 一帧可能被 TCP 拆成几块到：攒着，解出整帧再处理（OneBot 的大消息、连发都可能被拆）
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      let got;
      try { got = decodeFrames(buf); } catch (e) { say("收到的帧不对，断开重连：" + e.message); return drop(cfg, socket); }
      buf = got.rest;
      for (const f of got.frames) {
        if (f.opcode === 0x1) onOneBot(cfg, f.payload.toString("utf8"));
        else if (f.opcode === 0x8) { say("对面关掉了连接"); return drop(cfg, socket); }
        else if (f.opcode === 0x9) { try { socket.write(encodeFrame(f.payload, 0xa)); } catch {} }
      }
    });
    socket.on("error", (e) => { say("连接出错：" + hide(e.message)); drop(cfg, socket); });
    socket.on("close", () => drop(cfg, socket));
  });
  req.on("response", (res) => { res.resume(); again(`HTTP ${res.statusCode}`); });
  req.on("error", (e) => again(e.message));
  req.end();
}
function drop(cfg, socket) {
  if (SOCK !== socket) return;
  SOCK = null; status.connected = false;
  try { socket.destroy(); } catch {}
  armRetry(cfg);
}
function nextDelay() { const ms = Math.min(RECONNECT_MAX, retryBase() * 2 ** RETRY); RETRY = Math.min(RETRY + 1, 10); return ms; }
function armRetry(cfg, wait = nextDelay()) {
  if (STOPPED || TIMER) return;
  TIMER = setTimeout(() => { TIMER = null; connect(cfg); }, wait);
  TIMER.unref?.();
}
/** 测试用：先停下，不要自己重连 */
export function stopQQ() { STOPPED = true; if (TIMER) clearTimeout(TIMER); TIMER = null; if (SOCK) { try { SOCK.destroy(); } catch {} } SOCK = null; status.connected = false; }
export const qqStatus = () => ({ ...status });

const newEcho = (action) => action + ":" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
/** 记下等回执的 echo；回执一直不来也不会无限涨（超过 1000 条丢最老的） */
function track(echo, w) {
  WAITERS.set(echo, w);
  while (WAITERS.size > 1000) WAITERS.delete(WAITERS.keys().next().value);
}
/** 发一个动作，不等回执（回话、切模式提示这类） */
function send(cfg, action, params) {
  if (!SOCK) return false;
  const echo = newEcho(action);
  track(echo, { action });
  try { SOCK.write(encodeFrame(JSON.stringify({ action, params, echo }))); return true; }
  catch (e) { WAITERS.delete(echo); say("发不出去：" + e.message); return false; }
}
/** 发一个动作，等 NapCat 的回执（发消息要拿 message_id、看图要拿图片地址） */
function act(action, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!SOCK) return reject(new Error("没连上 NapCat，发不出去"));
    const echo = newEcho(action);
    const timer = setTimeout(() => { WAITERS.delete(echo); reject(new Error(`NapCat 没回话（${action}）`)); }, timeoutMs);
    timer.unref?.();
    track(echo, { action, resolve, reject, timer });
    try { SOCK.write(encodeFrame(JSON.stringify({ action, params, echo }))); }
    catch (e) { clearTimeout(timer); WAITERS.delete(echo); reject(e); }
  });
}

// ── 一条 OneBot 事件 ──
/** 消息段 → 文本；at 记下是不是 @ 了机器人；reply 记下引用的是不是我们发的 */
export function parseSegments(message, bot, sent = SENT) {
  let text = "", atBot = false, replySelf = false, reply = null;
  for (const s of Array.isArray(message) ? message : []) {
    const d = s?.data || {};
    if (s.type === "text") text += d.text || "";
    else if (s.type === "at") { if (String(d.qq) === String(bot)) atBot = true; text += " "; }
    else if (s.type === "reply") { reply = String(d.id || ""); if (sent.has(reply)) replySelf = true; }
    else if (s.type === "image") text += "[图片]";
    else if (s.type === "face" || s.type === "mface") text += "[表情]";
  }
  return { text: text.replace(/\s+/g, " ").trim(), atBot, reply, replySelf };
}
/** 群里要不要接：被 @、引用了我们的话、或者叫到 names 里的名字；私聊每条都接 */
export function shouldAnswer(ev, cfg) {
  if (ev.message_type === "private") return true;
  const p = parseSegments(ev.message, cfg.bot);
  return p.atBot || p.replySelf || cfg.names.some((n) => p.text.includes(n));
}
const convKey = (ev) => (ev.message_type === "group" ? "g:" + ev.group_id : "p:" + ev.user_id);
const convName = (ev) => (ev.message_type === "group" ? ev.group_name || String(ev.group_id) : String(ev.user_id));

/** 压成一行：正文里的换行是伪造消息头的入口（有人自己写一行「主人(QQ …)：」），一律换成空格。
 *  号码只认 NapCat 事件里的 user_id，正文里写什么都不算 */
export function oneLine(s, max = 2000) {
  return String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/ {2,}/g, " ").trim().slice(0, max);
}
const short = (s, n = 60) => { const t = oneLine(s, n + 1); return t.length > n ? t.slice(0, n) + "…" : t; };
/** 昵称：群名片优先，其次昵称；都没有就用 QQ 号 */
export function nickOf(ev) {
  return oneLine(ev?.sender?.card || ev?.sender?.nickname || NICK.get(String(ev?.user_id ?? "")) || ("QQ" + (ev?.user_id ?? "?")), 40);
}
/** 递进干净会话的一行：`[群 <群名>] <昵称>(QQ <号>)：<正文>`
 *  引用写成 `[引用 <谁>：<原文前 60 字>]`；号码只来自事件 */
export function incomingLine(ev, text, quote = null) {
  const who = `${nickOf(ev)}(QQ ${ev.user_id})`;
  const head = ev.message_type === "group" ? `[群 ${oneLine(ev.group_name || ev.group_id, 60)}] ${who}：` : `[私聊] ${who}：`;
  const q = quote ? `[引用 ${short(quote.nick, 20)}：${short(quote.text)}] ` : "";
  return head + q + oneLine(text);
}
/** 拍一拍：notice 里不一定带昵称，先用收消息时记下的 */
export function pokeLine(ev, bot) {
  const w = NICK.get(String(ev.user_id)) || ("QQ" + ev.user_id);
  const t = String(ev.target_id) === String(bot) ? "你" : (NICK.get(String(ev.target_id)) || ("QQ" + ev.target_id));
  return `[拍一拍] ${w} 拍了拍 ${t}`;
}

// 群里没叫到她的消息：先攒着（每群最近 30 条），下次真叫到她时一起当上下文递进去。
// 真正的「自己插话」要起轮次花额度，等主人定频率（#134 第二步）
const HISTORY = new Map();
const HISTORY_MAX = 30;
function historyPush(ev, line) {
  if (ev.message_type !== "group") return;
  const g = String(ev.group_id), a = HISTORY.get(g) || [];
  a.push(line); while (a.length > HISTORY_MAX) a.shift();
  HISTORY.set(g, a);
}
function historyTake(ev) {
  if (ev.message_type !== "group") return "";
  const g = String(ev.group_id), a = HISTORY.get(g);
  if (!a?.length) return "";
  HISTORY.delete(g);
  return "[最近群里的消息]\n" + a.join("\n") + "\n[/最近群里的消息]\n";
}
/** 引用的是哪条：先查收到的消息（名片 + 正文），查不到再问 NapCat（get_msg） */
async function quoteOf(cfg, id) {
  const hit = MSGS.get(String(id));
  if (hit) return hit;
  try {
    const d = await act("get_msg", { message_id: Number(id) || id }, 4000);
    if (!d || !d.message) return { nick: "未知", text: "" };
    return { nick: d.sender?.card || d.sender?.nickname || "未知", text: parseSegments(d.message, cfg.bot).text };
  } catch { return { nick: "未知", text: "" }; }
}

function onOneBot(cfg, raw) {
  let ev;
  try { ev = JSON.parse(raw); } catch { return say("收到的东西不是 JSON"); }
  // 自己发出去的动作回来了：认下 message_id（「引用了机器人的话」要靠它），等着的调用拿到结果
  if (ev.echo && WAITERS.has(ev.echo)) {
    const w = WAITERS.get(ev.echo); WAITERS.delete(ev.echo); if (w.timer) clearTimeout(w.timer);
    if (ev.retcode !== 0) {
      const why = `retcode ${ev.retcode}` + (ev.wording ? `：${ev.wording}` : "");
      if (w.reject) w.reject(new Error(why)); else say(`发回话没成（${w.action}）：${why}`);
    } else {
      if (ev.data?.message_id != null) { SENT.add(String(ev.data.message_id)); if (SENT.size > 500) SENT.delete(SENT.values().next().value); }
      w.resolve?.(ev.data || {});
    }
    return;
  }
  handleEvent(cfg, ev).catch((e) => say("处理消息出错：" + e.message));
}

/** 一条事件（消息 / 拍一拍）：整理了再决定接不接 */
export async function handleEvent(cfg, ev) {
  if (ev.post_type === "notice" && ev.notice_type === "poke") {
    const line = pokeLine(ev, cfg.bot);
    // 拍的是她（或在私聊里）：当成叫她；@ 自己是用来说「这句是冲她来的」，原话在 line 里
    const toMe = String(ev.target_id) === String(cfg.bot) || ev.group_id == null;
    const fake = { ...ev, message_type: ev.group_id != null ? "group" : "private", message_id: null, sender: ev.sender,
      message: toMe ? [{ type: "at", data: { qq: cfg.bot } }, { type: "text", data: { text: line } }] : [] };
    if (toMe) handleMessage(cfg, fake, line, { line });
    else historyPush(fake, line);   // 别人互相拍：不当成叫她
    return;
  }
  if (ev.post_type !== "message" || (ev.message_type !== "private" && ev.message_type !== "group")) return;
  const p = parseSegments(ev.message, cfg.bot);
  if (!p.text) return;
  const nick = nickOf(ev);
  NICK.set(String(ev.user_id), nick);
  if (ev.message_id) remember(ev.message_id, { nick, text: p.text }, MSGS, 500);
  const quote = p.reply ? await quoteOf(cfg, p.reply) : null;
  const line = incomingLine(ev, p.text, quote);
  // 切模式的暗号不走「叫到她」那套判断：只认发送者是不是主人
  const cmd = String(ev.user_id) === String(cfg.owner) && [...WORK_ON, ...WORK_OFF].includes(p.text.replace(/\s+/g, ""));
  if (!cmd && !shouldAnswer(ev, cfg)) return historyPush(ev, line);
  // 叫到她了：把没叫她的那些一起递进去（工作模式不掺，和以前一样只递那句话）
  const ctx = modeOf(convKey(ev)) === "chat" ? historyTake(ev) : "";
  handleMessage(cfg, ev, p.text, { line: ctx + line });
}

/** 说一句话回去；太长按段落拆成几条。群里引用对方那条（拍一拍的回复没有消息可引） */
function reply(cfg, ev, text) {
  const parts = String(text || "").trim();
  if (!parts) return;
  const chunks = [];
  let left = parts;
  while (left.length > 800) {
    const cut = left.lastIndexOf("\n", 800);
    chunks.push(left.slice(0, cut > 200 ? cut : 800));
    left = left.slice(cut > 200 ? cut : 800).replace(/^\n+/, "");
  }
  if (left) chunks.push(left);
  for (const c of chunks) {
    REPLIES.push({ key: convKey(ev), ev, text: c });
    const msg = [];
    if (ev.message_type === "group" && ev.message_id) msg.push({ type: "reply", data: { id: String(ev.message_id) } });
    msg.push({ type: "text", data: { text: c } });
    const ok = ev.message_type === "group"
      ? send(cfg, "send_group_msg", { group_id: ev.group_id, message: msg })
      : send(cfg, "send_private_msg", { user_id: ev.user_id, message: msg });
    if (!ok) say("没发出去：连接断了");
  }
}

export const modeOf = (key) => STATE.qq.modes[key] || "chat";
const setMode = (key, mode) => { STATE.qq.modes[key] = mode; saveState(); };

/** 收一条消息（测试也直接喂这个）。extra.line：整理好的一行（带号码和昵称），聊天模式用 */
export function handleMessage(cfg, ev, text, extra = {}) {
  const key = convKey(ev);
  const owner = String(ev.user_id) === String(cfg.owner);
  const bare = String(text).replace(/\s+/g, "");
  // 切模式：只认发送者的号，不看内容是谁写的；别人的同一句话当普通消息
  if (owner && WORK_ON.includes(bare)) { setMode(key, "work"); return reply(cfg, ev, MODE_TEXT.work); }
  if (owner && WORK_OFF.includes(bare)) { setMode(key, "chat"); return reply(cfg, ev, MODE_TEXT.chat); }
  if (!shouldAnswer(ev, cfg)) return;
  const kind = modeOf(key);
  if (kind === "work" && !owner) { say("工作模式：不是主人的消息，不递给两边"); return; }
  deliver(cfg, ev, key, kind, text, extra.line);
}

function deliver(cfg, ev, key, kind, text, line = "") {
  const b = BUSY.get(key);
  if (b && RUNSQQ.get(b.cid)) { const a = PENDING.get(key) || []; a.push({ cfg, ev, text, line }); PENDING.set(key, a); return; }   // 那一轮还在跑：攒着
  if (b) BUSY.delete(key);   // 记录里已经没有那一轮了（收尾事件丢了）：按实际放开
  const at = Date.now(), cid = "xk-qq-" + (++CID);
  let sid = null, head = "";
  if (kind === "work") {
    head = (ev.message_type === "group" ? `（QQ群 ${convName(ev)}：` : "（QQ私聊：") + text + "）";
    sid = roleSid("xiaoke");
  }
  // 先登记再入队：入队可能同步就把这一轮跑完（没配密钥这类），晚登记就认不出收尾
  const r = { key, cfg, ev, kind, at, head, cid };
  RUNSQQ.set(cid, r);
  BUSY.set(key, { at, cid });
  try {
    let item;
    if (kind === "work") {
      item = enqueue({ message: head, sessionId: sid, projectId: sid ? null : projectOf("xiaoke"), cid });
      markRun("xiaoke", item.id, { channel: ev.message_type === "group" ? "qq-group" : "qq-private", sessionId: sid });
      // 她那段正有一轮在跑：消息插进那一轮，认那一轮的结束（和 xk-room 一样）
      if (item.injected) { const cur = [...RUNS.values()].find((x) => !x.ended && x.sessionId === sid); if (cur) RUNSQQ.set(cur.id, r); }
    } else {
      const card = ensureClean();
      item = enqueue({
        message: line || incomingLine(ev, text), sessionId: STATE.qq.sessions[key] || null, cwd: CLEAN_DIR, cid,
        internal: true, unattended: true, auto: "xk-qq", disallowedTools: CLEAN_DENY,
        // 项目设置里也放行了，这里再钉一遍：没人看着的时候不能弹确认，卡一下就白掉一轮
        allowedTools: QQ_TOOLS.map((t) => `mcp__${QQ_MCP_NAME}__${t}`),
        clean: { tools: CLEAN_TOOLS, systemPrompt: card, mcpConfig: qqMcpConfig() },
      });
      // MCP 那边靠这个文件知道「这一轮是哪个会话、回话发给谁」
      writeRunCtx(item.id, r);
    }
    RUNSQQ.set(item.id, r);
  } catch (e) {
    r.done = true; RUNSQQ.delete(cid); BUSY.delete(key);
    say("这一轮没起来：" + e.message);
  }
}
let CID = 0;
/** 小克「最近那段」：还是她自己的、还在，才接；没有就新开（和 xk-room 的 sidOf 一个道理） */
function roleSid(id) {
  const sid = STATE.lastByRole?.[id];
  return sid && roleOfSession(sid)?.id === id ? sid : null;
}

// ── 聊天工具的 MCP（xk-qq-mcp.mjs）：MCP 是另一个进程，碰不到这条 WebSocket，借文件来回 ──
const readJson = (f, def = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (e.code === "ENOENT") return def; throw e; } };
function writeJsonAtomic(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(v));
  fs.renameSync(f + ".tmp", f);
}
/** 这一轮是哪个会话、回话发给谁：MCP 靠它知道目标（号码只从这里来） */
function writeRunCtx(runId, r) {
  try {
    writeJsonAtomic(path.join(RUN_DIR, String(runId) + ".json"), {
      runId: String(runId), key: r.key, type: r.ev.message_type === "group" ? "group" : "private",
      group_id: r.ev.group_id ?? null, user_id: r.ev.user_id ?? null,
      group_name: r.ev.group_name ?? null, message_id: r.ev.message_id ?? null, at: r.at,
    });
  } catch (e) { say("写这一轮的会话记录失败：" + e.message); }
}
const runCtxOf = (runId) => readJson(path.join(RUN_DIR, String(runId || "") + ".json"), null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gapMs = () => Math.max(0, Number(process.env.CCAPP_QQ_GAP_MS) || (1000 + Math.floor(Math.random() * 2000)));

/** 一段图片字节是什么格式 */
function mimeOf(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.length > 4 && buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf.length > 12 && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "application/octet-stream";
}
/** 下载一张图（不到 8MB，最多跟三次跳转）。失败就是失败，不编 */
function download(url, ms = 15000, hop = 0) {
  return new Promise((resolve, reject) => {
    if (!/^https?:\/\//.test(String(url))) return reject(new Error("不是 http 地址"));
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { timeout: ms, headers: { "User-Agent": "xiaoke-qq" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hop < 3) {
        res.resume();
        return download(new URL(res.headers.location, url).toString(), ms, hop + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const parts = []; let n = 0;
      res.on("data", (d) => { n += d.length; if (n > 8 << 20) { req.destroy(new Error("图太大")); return; } parts.push(d); });
      res.on("end", () => resolve(Buffer.concat(parts)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("下载超时")));
    req.on("error", reject);
  });
}

/** 一条消息里的图片段 */
const imageSegs = (msg) => (Array.isArray(msg) ? msg : []).filter((s) => s?.type === "image").map((s) => ({ url: s.data?.url || "", file: s.data?.file || "" }));
/** 取一条消息的图片字节：优先直链，没有就请 NapCat 去拿（get_image） */
async function fetchImageOf(seg) {
  if (/^https?:\/\//.test(seg.url || "")) return download(seg.url);
  if (/^https?:\/\//.test(seg.file || "")) return download(seg.file);
  const d = await act("get_image", { file: seg.file || seg.url }, 20000);
  if (d?.base64) return Buffer.from(String(d.base64).replace(/^base64:\/\//, ""), "base64");
  if (d?.file && /^https?:\/\//.test(d.file)) return download(d.file);
  throw new Error("拿不到这张图");
}

const STICKERS = path.join(STICKER_DIR, "index.json");
const loadStickers = () => readJson(STICKERS, { items: [] }) || { items: [] };
const nextStickerId = (ix) => "s" + (1 + ix.items.reduce((m, i) => Math.max(m, Number(String(i.id).replace(/^s/, "")) || 0), 0));
function saveSticker(ix, id, buf) {
  fs.mkdirSync(STICKER_DIR, { recursive: true });
  const ext = mimeOf(buf) === "image/png" ? "png" : mimeOf(buf) === "image/gif" ? "gif" : mimeOf(buf) === "image/webp" ? "webp" : "jpg";
  const file = path.join(STICKER_DIR, id + "." + ext);
  fs.writeFileSync(file, buf);
  return file;
}
/** 刷新 QQ 收藏表情（fetch_custom_face）；NapCat 版本不同返回的形状不同，认得出的都收下 */
async function refreshFaces(ix) {
  let list = [];
  try {
    const d = await act("fetch_custom_face", { count: 30 }, 8000);
    list = Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : Array.isArray(d?.urls) ? d.urls : []);
  } catch { return; }
  for (const x of list) {
    const url = typeof x === "string" ? x : (x?.url || x?.file || "");
    if (!/^https?:\/\//.test(url)) continue;
    let it = ix.items.find((i) => i.url === url);
    if (!it) { it = { id: nextStickerId(ix), url, desc: "", note: "", tags: [], uses: 0, addedAt: Date.now(), source: "qq" }; ix.items.push(it); }
    if (typeof x === "object" && x.desc && !it.desc) it.desc = String(x.desc).slice(0, 80);
  }
}
function stickerText(it) {
  const bits = [it.id];
  if (it.desc) bits.push("备注：" + it.desc);
  if (it.note) bits.push("笔记：" + it.note);
  if (it.tags?.length) bits.push("标签：" + it.tags.join("、"));
  bits.push("用过 " + (it.uses || 0) + " 次");
  return bits.join("  ");
}

// ── 工具：网关这边做（要 NapCat、要真实文件） ──
async function sendOne(ctx, m) {
  const text = oneLine(m.text, 1500);
  if (!text) return null;
  const segs = [];
  if (ctx.type === "group" && m.replyToMessageId) segs.push({ type: "reply", data: { id: String(m.replyToMessageId) } });
  if (ctx.type === "group" && m.atUserId) segs.push({ type: "at", data: { qq: String(m.atUserId) } });
  segs.push({ type: "text", data: { text } });
  const d = await act(ctx.type === "group" ? "send_group_msg" : "send_private_msg",
    ctx.type === "group" ? { group_id: ctx.group_id, message: segs } : { user_id: ctx.user_id, message: segs }, 20000);
  return d?.message_id ?? null;
}
function stickerBytes(it) {
  if (it.file && fs.existsSync(it.file)) return fs.readFileSync(it.file);
  if (it.url) return download(it.url);
  throw new Error("这张表情没有图");
}

async function runTool(req, ctx, r) {
  const a = req.args || {};
  const args = Array.isArray(a.messages) ? a.messages : null;
  switch (req.tool) {
    case "send_message": {
      const list = (args || []).slice(0, 10);
      if (!list.length) throw new Error("messages 要是数组，至少一条");
      if (r) r.usedSend = true;
      let n = 0;
      for (let i = 0; i < list.length; i++) {
        if (i) await sleep(gapMs());
        const m = typeof list[i] === "string" ? { text: list[i] } : (list[i] || {});
        if (await sendOne(ctx, m)) n++;
      }
      return { sent: n };
    }
    case "send_poke": {
      const target = a.targetUserId ? String(a.targetUserId) : String(ctx.user_id);
      if (ctx.type === "group") await act("group_poke", { group_id: ctx.group_id, user_id: target }, 15000);
      else await act("friend_poke", { user_id: target }, 15000);
      return { ok: true };
    }
    case "get_message_images": {
      const id = a.messageId ?? ctx.message_id;
      if (!id) throw new Error("没有消息号");
      const d = await act("get_msg", { message_id: Number(id) || id }, 15000);
      const segs = imageSegs(d?.message).slice(0, 4);
      if (!segs.length) return { files: [] };
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const files = [];
      for (let i = 0; i < segs.length; i++) {
        try {
          const buf = await fetchImageOf(segs[i]);
          const f = path.join(TMP_DIR, `${Date.now().toString(36)}-${i}.img`);
          fs.writeFileSync(f, buf);
          files.push({ path: f, mime: mimeOf(buf), bytes: buf.length });
        } catch (e) { say("一张图没拿到：" + e.message); }
      }
      return { files };
    }
    case "list_stickers": {
      const ix = loadStickers();
      await refreshFaces(ix);
      writeJsonAtomic(STICKERS, ix);
      if (!ix.items.length) return { text: "表情库还是空的。看到喜欢的图可以用 collect_sticker 收进来。" };
      return { text: ix.items.slice(0, 40).map(stickerText).join("\n") };
    }
    case "get_sticker_image": {
      const ix = loadStickers();
      const it = ix.items.find((x) => x.id === String(a.id));
      if (!it) throw new Error("没有这张表情：" + a.id);
      const buf = await stickerBytes(it);
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const f = path.join(TMP_DIR, `${Date.now().toString(36)}-${it.id}.img`);
      fs.writeFileSync(f, buf);
      return { file: f, mime: mimeOf(buf) };
    }
    case "send_sticker": {
      const ix = loadStickers();
      const it = ix.items.find((x) => x.id === String(a.id));
      if (!it) throw new Error("没有这张表情：" + a.id);
      if (r) r.usedSend = true;
      const buf = await stickerBytes(it);
      const segs = [];
      if (ctx.type === "group" && a.replyToMessageId) segs.push({ type: "reply", data: { id: String(a.replyToMessageId) } });
      if (ctx.type === "group" && a.atUserId) segs.push({ type: "at", data: { qq: String(a.atUserId) } });
      segs.push({ type: "image", data: { file: "base64://" + buf.toString("base64") } });
      await act(ctx.type === "group" ? "send_group_msg" : "send_private_msg",
        ctx.type === "group" ? { group_id: ctx.group_id, message: segs } : { user_id: ctx.user_id, message: segs }, 30000);
      it.uses = (it.uses || 0) + 1;
      writeJsonAtomic(STICKERS, ix);
      return { ok: true };
    }
    case "sticker_note": {
      const ix = loadStickers();
      const it = ix.items.find((x) => x.id === String(a.id));
      if (!it) throw new Error("没有这张表情：" + a.id);
      if (typeof a.note === "string") it.note = oneLine(a.note, 300);
      if (typeof a.desc === "string") it.desc = oneLine(a.desc, 80);
      if (Array.isArray(a.tags)) it.tags = a.tags.map((t) => oneLine(t, 20)).filter(Boolean).slice(0, 8);
      writeJsonAtomic(STICKERS, ix);
      return { text: "记下了：" + stickerText(it) };
    }
    case "collect_sticker": {
      const id = a.messageId ?? ctx.message_id;
      if (!id) throw new Error("没有消息号");
      const d = await act("get_msg", { message_id: Number(id) || id }, 15000);
      const segs = imageSegs(d?.message);
      const seg = segs[Number(a.imageIndex) || 0];
      if (!seg) throw new Error("这条消息里没有那张图");
      const buf = await fetchImageOf(seg);
      const ix = loadStickers();
      const nid = nextStickerId(ix);
      const file = saveSticker(ix, nid, buf);
      ix.items.push({ id: nid, file, url: /^https?:\/\//.test(seg.url) ? seg.url : "", desc: oneLine(a.desc, 80), note: oneLine(a.note, 300), tags: Array.isArray(a.tags) ? a.tags.map((t) => oneLine(t, 20)).filter(Boolean).slice(0, 8) : [], uses: 0, addedAt: Date.now(), source: "collect" });
      writeJsonAtomic(STICKERS, ix);
      return { id: nid, text: "收进表情库了：" + stickerText(ix.items.at(-1)) };
    }
    case "memory_append": {
      const text = oneLine(a.text, 500);
      if (!text) throw new Error("text 不能为空");
      const ms = readJson(MEMORY_FILE, []) || [];
      const m = { id: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), text, at: Date.now() };
      ms.push(m); while (ms.length > 300) ms.shift();
      writeJsonAtomic(MEMORY_FILE, ms);
      return { text: "记下了（" + m.id + "）：" + text };
    }
    case "memory_query": {
      const q = oneLine(a.query, 100);
      const ms = readJson(MEMORY_FILE, []) || [];
      const hits = (q ? ms.filter((m) => m.text.includes(q)) : ms).slice(-(Number(a.limit) || 10));
      return { text: hits.length ? hits.map((m) => `[${m.id}] ${m.text}`).join("\n") : "没有相关的记忆。" };
    }
    case "memory_remove": {
      const ms = readJson(MEMORY_FILE, []) || [];
      const i = ms.findIndex((m) => m.id === String(a.id));
      if (i < 0) throw new Error("没有这条记忆：" + a.id);
      const [gone] = ms.splice(i, 1);
      writeJsonAtomic(MEMORY_FILE, ms);
      return { text: "删掉了：" + gone.text };
    }
    default: throw new Error("没有这个工具：" + req.tool);
  }
}

let DRAINING = false;
/** 把 MCP 发过来的请求做完（测试也直接调）。一次只做一个：网关一侧的动作是串行的 */
export async function drainQQRpc() {
  if (DRAINING) return 0;
  DRAINING = true;
  let n = 0;
  try {
    let files = [];
    try { files = fs.readdirSync(REQ_DIR).filter((f) => f.endsWith(".json")).sort(); } catch (e) { if (e.code !== "ENOENT") throw e; }
    for (const f of files) {
      const p = path.join(REQ_DIR, f);
      let req = null;
      try { req = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
      fs.rmSync(p, { force: true });
      if (!req?.id || !req.tool) continue;
      const out = { id: req.id, ok: true };
      try {
        const ctx = runCtxOf(req.runId);
        if (!ctx) throw new Error("这一轮不在 QQ 会话里（没有会话记录）");
        const r = RUNSQQ.get(String(req.runId)) || [...RUNSQQ.values()].find((x) => x.cid === req.runId) || null;
        out.result = await runTool(req, ctx, r);
      } catch (e) {
        out.ok = false; out.error = String(e.message || e).slice(0, 300);
      }
      writeJsonAtomic(path.join(RES_DIR, String(req.id) + ".json"), out);
      n++;
    }
  } finally { DRAINING = false; }
  return n;
}

// 聊天模式的干净会话：目录、项目级设置（兜底，真正管用的是 run 里的 --tools 白名单和 --strict-mcp-config）、人设卡。
// 返回人设卡正文。卡改过了就把各会话的旧段落放掉：claude 第一轮就把系统提示记死了，续旧段落用的还是旧卡
export function ensureClean() {
  const f = path.join(CLEAN_DIR, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const want = JSON.stringify({
    permissions: {
      allow: [...CLEAN_TOOLS, ...QQ_TOOLS.map((t) => `mcp__${QQ_MCP_NAME}__${t}`)],
      deny: [...CLEAN_DENY, "mcp__device", "mcp__xk-memory", "mcp__bili"],
    },
    disableClaudeAiConnectors: true, disableBundledSkills: true,
  }, null, 1) + "\n";
  let had = ""; try { had = fs.readFileSync(f, "utf8"); } catch {}
  if (had !== want) fs.writeFileSync(f, want);
  if (!fs.existsSync(CARD_FILE)) fs.writeFileSync(CARD_FILE, CLEAN_MD);
  const raw = fs.readFileSync(CARD_FILE, "utf8").trim() || CLEAN_MD;
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  if (STATE.qq.cardHash !== hash) {
    if (STATE.qq.cardHash) say("人设卡换了，各会话从新的一段开始");
    STATE.qq.cardHash = hash; STATE.qq.sessions = {}; saveState();
  }
  return stripFrontmatter(raw);
}
/** 卡开头的 --- frontmatter 不是给模型看的，当系统提示前去掉 */
export function stripFrontmatter(s) {
  return String(s).replace(/^\s*---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "").trim();
}
// 占位：主人改好的琉璃川椿卡给过来之前先用这个，别让人一进 QQ 就撞上空的
export const CLEAN_MD = "# 在这个窗口里\n\n你是主人在 QQ 上聊天的那一位。用中文、口语，短句；不聊自己的设定和别人的事，不透露主人这边的任何信息。\n";

/** 聊天模式：最后一条消息之后她说的话（同一段会话里上一轮的回复不算） */
export function lastReply(ts) {
  let i = ts.length - 1;
  while (i >= 0 && ts[i].role !== "user") i--;
  return ts.slice(i + 1).filter((x) => x.role === "assistant").map((x) => x.text).join("\n").trim();
}
/** 工作模式：会话记录里紧跟在「（QQ…：」那条后面的回复；私聊里别的话不要 */
export function workReply(ts, head) {
  let inQQ = false;
  const said = [];
  for (const x of ts) {
    if (x.role === "user") inQQ = x.text.startsWith(head);
    else if (inQQ) said.push(x.text);
  }
  return said.join("\n").trim();
}

END_HOOKS.push((run, f = {}) => {
  const r = RUNSQQ.get(run.id) || (run.cid && RUNSQQ.get(run.cid));
  if (!r || r.done) return;
  r.done = true;
  RUNSQQ.delete(run.id); if (run.cid) RUNSQQ.delete(run.cid);
  if (BUSY.get(r.key)?.cid === r.cid) BUSY.delete(r.key);
  fs.rmSync(path.join(RUN_DIR, String(run.id) + ".json"), { force: true });
  if (run.sessionId && r.kind === "chat") { STATE.qq.sessions[r.key] = String(run.sessionId); saveState(); }
  const ts = run.sessionId ? turns(String(run.sessionId), r.at) : [];
  const said = r.kind === "work" ? workReply(ts, r.head) : lastReply(ts);
  if (r.kind === "work") {
    // 工作模式照旧：没说话、出错都给一句
    if (f.isError || f.failed) reply(r.cfg, r.ev, said || "（这一轮出错了）");
    else reply(r.cfg, r.ev, said || "（这次没说出话）");
  } else if (r.usedSend) {
    // 这一轮已经用 send_message / send_sticker 自己发过了：最后的文字不再另发
  } else if (said) {
    reply(r.cfg, r.ev, said);
  } else if (f.isError || f.failed) {
    // 聊天模式：群里不该冒「这轮出错了」，记日志就行
    say("这一轮没成，没回话（" + (f.error || "出错") + "）");
  }
  const pend = PENDING.get(r.key);
  if (pend?.length) {
    PENDING.delete(r.key);
    const last = pend[pend.length - 1];
    const lines = pend.map((x) => x.line || x.text).join("\n");
    deliver(last.cfg, last.ev, r.key, r.kind, pend.map((x) => x.text).join("\n"), lines);
  }
});

// ── 启动 ──
let STARTED = false;
export function startQQ(cfg = loadConfig()) {
  if (!cfg) return null;
  STOPPED = false;
  say("开始接（NapCat 正向 WebSocket）");
  connect(cfg);
  return { status };
}
if (LIVE) {
  // 没 qq.json 就什么都不做；主人在手机里写好文件以后，最多一分钟就开始接
  const tick = () => {
    try { const cfg = loadConfig(); if (cfg && !STARTED) { STARTED = true; startQQ(cfg); } } catch (e) { say(e.message); }
  };
  setTimeout(tick, 5000).unref();
  setInterval(tick, 60000).unref();
  // 聊天工具来的请求：两百毫秒看一次，有就做
  setInterval(() => { drainQQRpc().catch((e) => say("聊天工具出错：" + e.message)); }, 200).unref();
}

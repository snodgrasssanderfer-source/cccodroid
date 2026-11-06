// QQ 接入（#134，主人 11-06 定的）：NapCat（OneBot 11）的正向 WebSocket 客户端，外加「聊天 / 工作」两种模式。
// 隐私是硬要求：仓库公开，QQ 号、token、电脑 IP 一个都不进仓库、日志、测试。配置只读手机本地的 ~/.config/xiaoke/qq.json，
// 没有这个文件就什么都不做。日志里只说「连上了 / 断了」，不带地址。
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { CFG, LIVE, log } from "./config.mjs";
import { END_HOOKS, enqueue } from "./queue.mjs";
import { markRun } from "./xk-memory.mjs";
import { RUNS } from "./runs.mjs";
import { STATE, projectOf, saveState } from "./xk-core.mjs";
import { roleOfSession } from "./xk-roles.mjs";
import { turns } from "./xk-transcript.mjs";

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

const RECONNECT_MAX = 30000;
const retryBase = () => Number(process.env.CCAPP_QQ_RETRY_MS) || 1000;
const WORK_ON = ["换成工作模型", "换成工作模式"], WORK_OFF = ["回到聊天模式"];
const MODE_TEXT = { work: "已切到工作模式", chat: "已回到聊天模式" };

STATE.qq ||= { modes: {}, sessions: {} };   // 会话 → 模式（chat / work）；会话 → 干净会话的 Claude 会话号
const BUSY = new Map();      // 会话 → { at, cid }：正在跑一轮
const PENDING = new Map();   // 会话 → 跑着时攒下的几句（跑完一起递进去）
const RUNSQQ = new Map();    // run 号 → { key, cfg, ev, kind, at, head }
const SENT = new Set();      // 自己发出去的 message_id：群里「引用了机器人的话」要认它
const ECHO = new Map();      // 发出去的 echo → 发的是什么动作（收回 message_id 记账）
export const REPLIES = [];   // 每一句要发回 QQ 的话（测试看它；真发由 send 去做）
/** 测试用：把模块里的会话状态清干净 */
export function resetQQ() {
  STATE.qq = { modes: {}, sessions: {} };
  BUSY.clear(); PENDING.clear(); RUNSQQ.clear(); SENT.clear(); ECHO.clear(); REPLIES.length = 0;
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

function send(cfg, action, params) {
  if (!SOCK) return false;
  const echo = action + ":" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  ECHO.set(echo, action);
  try { SOCK.write(encodeFrame(JSON.stringify({ action, params, echo }))); return true; }
  catch (e) { say("发不出去：" + e.message); return false; }
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

function onOneBot(cfg, raw) {
  let ev;
  try { ev = JSON.parse(raw); } catch { return say("收到的东西不是 JSON"); }
  if (ev.post_type === "message" && (ev.message_type === "private" || ev.message_type === "group")) {
    const p = parseSegments(ev.message, cfg.bot);
    if (!p.text) return;
    handleMessage(cfg, ev, p.text);
    return;
  }
  // 自己发出去的那句回来了：记下 message_id，「引用了机器人的话」以后认得出
  if (ev.echo && ECHO.has(ev.echo)) {
    const action = ECHO.get(ev.echo); ECHO.delete(ev.echo);
    if (ev.retcode !== 0) say(`发回话没成（${action}）：retcode ${ev.retcode}`);
    else if (ev.data?.message_id != null) {
      SENT.add(String(ev.data.message_id));
      if (SENT.size > 500) SENT.delete(SENT.values().next().value);
    }
  }
}

/** 说一句话回去；太长按段落拆成几条。群里引用对方那条 */
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
    const msg = ev.message_type === "group"
      ? [{ type: "reply", data: { id: String(ev.message_id) } }, { type: "text", data: { text: c } }]
      : [{ type: "text", data: { text: c } }];
    const ok = ev.message_type === "group"
      ? send(cfg, "send_group_msg", { group_id: ev.group_id, message: msg })
      : send(cfg, "send_private_msg", { user_id: ev.user_id, message: msg });
    if (!ok) say("没发出去：连接断了");
  }
}

export const modeOf = (key) => STATE.qq.modes[key] || "chat";
const setMode = (key, mode) => { STATE.qq.modes[key] = mode; saveState(); };

/** 收一条消息（测试也直接喂这个） */
export function handleMessage(cfg, ev, text) {
  const key = convKey(ev);
  const owner = String(ev.user_id) === String(cfg.owner);
  const bare = String(text).replace(/\s+/g, "");
  // 切模式：只认发送者的号，不看内容是谁写的；别人的同一句话当普通消息
  if (owner && WORK_ON.includes(bare)) { setMode(key, "work"); return reply(cfg, ev, MODE_TEXT.work); }
  if (owner && WORK_OFF.includes(bare)) { setMode(key, "chat"); return reply(cfg, ev, MODE_TEXT.chat); }
  if (!shouldAnswer(ev, cfg)) return;
  const kind = modeOf(key);
  if (kind === "work" && !owner) { say("工作模式：不是主人的消息，不递给两边"); return; }
  deliver(cfg, ev, key, kind, text);
}

function deliver(cfg, ev, key, kind, text) {
  const b = BUSY.get(key);
  if (b && RUNSQQ.get(b.cid)) { const a = PENDING.get(key) || []; a.push({ cfg, ev, text }); PENDING.set(key, a); return; }   // 那一轮还在跑：攒着
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
        message: text, sessionId: STATE.qq.sessions[key] || null, cwd: CLEAN_DIR, cid,
        internal: true, unattended: true, auto: "xk-qq", disallowedTools: CLEAN_DENY,
        clean: { tools: CLEAN_TOOLS, systemPrompt: card },
      });
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

// 聊天模式的干净会话：目录、项目级设置（兜底，真正管用的是 run 里的 --tools 白名单和 --strict-mcp-config）、人设卡。
// 返回人设卡正文。卡改过了就把各会话的旧段落放掉：claude 第一轮就把系统提示记死了，续旧段落用的还是旧卡
export function ensureClean() {
  const f = path.join(CLEAN_DIR, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const want = JSON.stringify({
    permissions: { allow: CLEAN_TOOLS, deny: [...CLEAN_DENY, "mcp__device", "mcp__xk-memory", "mcp__bili"] },
    disableClaudeAiConnectors: true, disableBundledSkills: true,
  }, null, 1) + "\n";
  let had = ""; try { had = fs.readFileSync(f, "utf8"); } catch {}
  if (had !== want) fs.writeFileSync(f, want);
  if (!fs.existsSync(CARD_FILE)) fs.writeFileSync(CARD_FILE, CLEAN_MD);
  const card = fs.readFileSync(CARD_FILE, "utf8").trim() || CLEAN_MD;
  const hash = crypto.createHash("sha256").update(card).digest("hex").slice(0, 16);
  if (STATE.qq.cardHash !== hash) {
    if (STATE.qq.cardHash) say("人设卡换了，各会话从新的一段开始");
    STATE.qq.cardHash = hash; STATE.qq.sessions = {}; saveState();
  }
  return card;
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
  if (run.sessionId && r.kind === "chat") { STATE.qq.sessions[r.key] = String(run.sessionId); saveState(); }
  const ts = run.sessionId ? turns(String(run.sessionId), r.at) : [];
  const said = r.kind === "work" ? workReply(ts, r.head) : lastReply(ts);
  if (f.isError || f.failed) reply(r.cfg, r.ev, said || "（这一轮出错了）");
  else reply(r.cfg, r.ev, said || "（这次没说出话）");
  const pend = PENDING.get(r.key);
  if (pend?.length) { PENDING.delete(r.key); const last = pend[pend.length - 1]; deliver(last.cfg, last.ev, r.key, r.kind, pend.map((x) => x.text).join("\n")); }
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
}

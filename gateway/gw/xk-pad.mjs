// 平板 App（第三步 3a，设计稿 xk/design/presence.md 第三节）的手机一侧：只给配对过的平板开的局域网口子。
// 主人 11-03 定的：平板单独做 App、不配局域网、更安全。所以：
//   - 配对：平板找到手机后两边交换 P-256 公钥，各自算出同一把密钥；两块屏幕各显示一个 6 位数（由这次交换算出），
//     主人看着一样，在手机上点确认才算数——中间有人偷换公钥，两边的数就对不上（蓝牙配对比数字的道理）。
//   - 之后每个请求、每个回复都用这把密钥加密（AES-256-GCM），带时间戳和序号，截下来重放不认；只放行聊天要用的几个接口。
//   - 上游的鉴权一点不动：这里把解开的请求用网关自己的令牌转给本机接口（selfApi）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { CFG, LIVE, log } from "./config.mjs";
import { onPublish, publish } from "./bus.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { XK_HOME, addRoute, httpError, json, selfApi } from "./xk-core.mjs";

export const PAD_PORT = Number(process.env.CCAPP_PAD_PORT || CFG.port + 7);
const FILE = path.join(XK_HOME, "pads.json");   // 配对过的平板和各自的密钥：只在手机上，不进仓库
const WINDOW_MS = 2 * 60 * 1000;                // 点「配对新平板」后多久内接受配对
const SKEW_MS = 60 * 1000;                      // 两台设备的钟差多少还认
// 平板能碰的接口：聊天页要用的这些，别的（文件、终端、设置……）一律不给
export const ALLOW = [/^\/api\/xk\/room(\?|$)/, /^\/api\/xk\/roles$/, /^\/api\/xk\/overlay$/, /^\/api\/xk\/health$/];

// ── 存储 ──
let DB = null;
export function devices() {
  if (DB) return DB;
  try { DB = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw new Error(`平板配对记录读不了（${FILE}）：${e.message}`); DB = { devices: [] }; }
  return DB;
}
function save() { fs.writeFileSync(FILE + ".tmp", JSON.stringify(DB, null, 1), { mode: 0o600 }); fs.renameSync(FILE + ".tmp", FILE); }
const byId = (id) => devices().devices.find((d) => d.id === id);

// ── 加解密 ──
const b64 = (b) => Buffer.from(b).toString("base64");
export function seal(key, obj, aad) {
  const n = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, n);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final(), c.getAuthTag()]);
  return { n: b64(n), c: b64(ct) };
}
export function open(key, env, aad) {
  const n = Buffer.from(String(env.n || ""), "base64"), all = Buffer.from(String(env.c || ""), "base64");
  if (n.length !== 12 || all.length < 17) throw httpError(400, "密文格式不对");
  const d = crypto.createDecipheriv("aes-256-gcm", key, n);
  d.setAAD(Buffer.from(aad)); d.setAuthTag(all.subarray(all.length - 16));
  try { return JSON.parse(Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString("utf8")); }
  catch { throw httpError(401, "解不开：不是配对时那把密钥"); }
}
/** 由双方公钥和共享秘密派生：通信密钥和给人比对的 6 位数（平板那边按同样的算法算） */
export function derive(shared, pubPhone, pubPad) {
  const salt = Buffer.concat([Buffer.from(pubPhone, "base64"), Buffer.from(pubPad, "base64")]);
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, salt, "xkpad v1 key", 32));
  const sasBytes = Buffer.from(crypto.hkdfSync("sha256", shared, salt, "xkpad v1 sas", 4));
  return { key, sas: String(sasBytes.readUInt32BE(0) % 1000000).padStart(6, "0") };
}

// ── 配对 ──
const PAIR = { until: 0, pending: new Map() };   // 配对窗口；等主人确认的：id → { name, key, sas, at }
export function openPairing(now = Date.now()) { PAIR.until = now + WINDOW_MS; PAIR.pending.clear(); ensureServer(); return { until: PAIR.until, port: PAD_PORT, addrs: lanAddrs() }; }
/** 平板发来公钥：回手机的公钥和配对号，两边各自算出 6 位数 */
export function pairRequest(b, now = Date.now()) {
  if (now >= PAIR.until) throw httpError(403, "手机上没开配对：在小克的「我的 → 平板」里点「配对新平板」");
  const pubPad = String(b.pub || "");
  let padKey;
  try { padKey = crypto.createPublicKey({ key: Buffer.from(pubPad, "base64"), format: "der", type: "spki" }); }
  catch (e) { throw httpError(400, "平板的公钥不对：" + e.message); }
  if (padKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw httpError(400, "平板的公钥要用 P-256");
  const mine = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubPhone = b64(mine.publicKey.export({ format: "der", type: "spki" }));
  const shared = crypto.diffieHellman({ privateKey: mine.privateKey, publicKey: padKey });
  const { key, sas } = derive(shared, pubPhone, pubPad);
  const id = crypto.randomBytes(8).toString("hex");
  const name = String(b.name || "平板").slice(0, 40);
  PAIR.pending.set(id, { name, key, sas, at: now });
  publish({ type: "xk", op: "pad_pending", id, name, sas });
  return { id, pub: pubPhone };
}
/** 主人在手机上点「一致，配对」 */
export function confirmPair(id) {
  const p = PAIR.pending.get(id);
  if (!p) throw httpError(404, "这台平板不在等配对（配对窗口过了就要重新开）");
  PAIR.pending.delete(id);
  devices().devices.push({ id, name: p.name, key: b64(p.key), pairedAt: Date.now(), lastSeen: 0, seq: 0 });
  save();
  publish({ type: "xk", op: "pad_paired", id, name: p.name });
  return { id, name: p.name };
}
export function unpair(id) {
  const d = byId(id);
  if (!d) throw httpError(404, "没有这台平板");
  devices().devices = devices().devices.filter((x) => x.id !== id);
  save();
  return { id };
}

// ── 平板发来的加密请求 ──
export const PROXY = { call: (method, p, body) => selfApi(method, p, body) };
/** 解开 → 核对时间和序号 → 放行的接口转给本机 → 加密回去。序号要一直变大：截下来的旧请求再发一遍不认 */
/** 解开平板发来的一个信封，核对时间和序号：回 { d: 设备, key, q: 明文 } */
function verify(env, now) {
  const d = byId(String(env.id || ""));
  if (!d) throw httpError(PAIR.pending.has(env.id) ? 403 : 401, PAIR.pending.has(env.id) ? "等手机上确认配对" : "这台平板没配对过");
  const key = Buffer.from(d.key, "base64"), q = open(key, env, d.id);
  if (Math.abs(now - Number(q.t)) > SKEW_MS) throw httpError(401, "时间对不上（两台设备的钟差了一分钟以上）");
  // 序号：平板会同时发好几个请求（长轮询等事件的同时发消息），到达顺序不一定，所以用一个滑动窗口——
  // 比见过的最大号往回 64 以内、而且没用过的才认；序号落盘，网关重启后旧请求照样不认
  const n = Number(q.q), seen = d.seen || [];
  if (!(n > 0) || n <= d.seq - 64 || seen.includes(n)) throw httpError(401, "序号旧了：这个请求已经用过");
  d.seen = [...seen, n].slice(-64); d.seq = Math.max(d.seq, n); d.lastSeen = now; save();
  return { d, key, q };
}
export async function padCall(env, now = Date.now()) {
  const { d, key, q } = verify(env, now);
  if (q.p === "/pad/stream/start") return seal(key, startStream(d, q.b || {}), d.id);
  if (q.p === "/pad/stream/status") return seal(key, { s: 200, b: { sid: STREAM.sid, error: STREAM.error || "" } }, d.id);
  const method = String(q.m || "GET").toUpperCase(), p = String(q.p || "");
  // 事件：ev = 上次拿到的光标；-1 = 刚连上，只要现在的光标，马上回
  if (q.ev != null) return seal(key, await waitEvents(Number(q.ev), Number(q.ev) < 0 ? 0 : 25000), d.id);
  if (!ALLOW.some((re) => re.test(p))) throw httpError(403, "平板不能用这个接口：" + p);
  let out;
  try { out = { s: 200, b: await PROXY.call(method, p, q.b ?? null) }; }
  catch (e) { out = { s: e.status || 500, error: e.message }; }
  return seal(key, out, d.id);
}

// ── 事件：平板用加密的长轮询拿（SSE 加不了密），只给聊天页用得上的那几种 ──
const RING = [];   // [{ seq, ev }]
let EVSEQ = 0;
const WAITERS = new Set();
const WANT = (ev) => ev && ((ev.type === "xk" && /^(room|room_typing|overlay|overlay_say)$/.test(ev.op)) || ev.type === "run_end");
onPublish((ev) => {
  if (!WANT(ev)) return;
  RING.push({ seq: ++EVSEQ, ev });
  if (RING.length > 500) RING.shift();
  for (const w of WAITERS) w();
});
export function waitEvents(after, ms = 25000) {
  const pick = () => ({ cursor: EVSEQ, events: after < 0 ? [] : RING.filter((x) => x.seq > after).map((x) => x.ev) });
  const now = pick();
  if (now.events.length || ms <= 0) return Promise.resolve(now);
  return new Promise((ok) => {
    const done = () => { WAITERS.delete(done); clearTimeout(t); ok(pick()); };
    const t = setTimeout(done, ms);
    WAITERS.add(done);
  });
}

// ── 串流（第三步 3b）：易控的服务端（xk/pad/server，GPL-3.0）在手机上只听本机一个端口，网关接住它的两条连接，加密转给平板 ──
// 平板：先发 /pad/stream/start（加密请求）→ 网关通知外壳起服务端（XkStream.java，经 Shizuku 以 shell 身份）→
// 平板开两条升级连接（先 main：声音和控制，再 video：画面），请求头里带加密的身份校验 → 网关在本机连上服务端，双向逐块加密转发。
// 每条连接一把子密钥（HKDF(配对密钥, 平板给的随机盐, 方向)），nonce = 方向 1 字节 + 3 个 0 + 8 字节计数：截下来重放、调换顺序都解不开。
export const STREAM = { sid: null, port: 0, at: 0, error: "", opts: null };
export const SPAWN = { connect: (port) => net.connect(port, "127.0.0.1") };
function startStream(d, b) {
  STREAM.sid = crypto.randomBytes(6).toString("hex");
  STREAM.port = 20000 + crypto.randomInt(20000);
  STREAM.at = Date.now(); STREAM.error = "";
  // 平板说它解得了什么（H.265、Opus）；画质参数照易控的默认，平板可以给
  const opts = { serverPort: STREAM.port, isAudio: b.audio === false ? 0 : 1, maxSize: Number(b.maxSize) || 1600, maxFps: Number(b.maxFps) || 60,
    maxVideoBit: Number(b.maxVideoBit) || 8000000, keepAwake: 1, supportH265: b.h265 ? 1 : 0, supportOpus: b.opus ? 1 : 0, listenClip: 0 };
  STREAM.opts = opts;
  publish({ type: "xk", op: "stream_start", sid: STREAM.sid, device: d.name, opts });
  return { s: 200, b: { sid: STREAM.sid } };
}
export function streamKey(key, salt, ch, dir) { return Buffer.from(crypto.hkdfSync("sha256", key, salt, `xkpad v1 stream ${ch} ${dir}`, 32)); }
const nonce = (dir, n) => { const b = Buffer.alloc(12); b[0] = dir; b.writeBigUInt64BE(BigInt(n), 4); return b; };
/** 一个方向的加密：每块 = 4 字节长度 + 密文和校验 */
export function sealer(key, dir) {
  let n = 0;
  return (chunk) => {
    const c = crypto.createCipheriv("aes-256-gcm", key, nonce(dir, n++));
    const ct = Buffer.concat([c.update(chunk), c.final(), c.getAuthTag()]);
    const h = Buffer.alloc(4); h.writeUInt32BE(ct.length);
    return Buffer.concat([h, ct]);
  };
}
/** 另一个方向的解密：喂进来的是 TCP 流（会拆包粘包），解出一块就回调一块；校验不过就抛 */
export function opener(key, dir, onPlain) {
  let n = 0, buf = Buffer.alloc(0);
  return (data) => {
    buf = Buffer.concat([buf, data]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len < 16 || len > 16 << 20) throw new Error("串流的块长度不对：" + len);
      if (buf.length < 4 + len) return;
      const all = buf.subarray(4, 4 + len); buf = buf.subarray(4 + len);
      const d = crypto.createDecipheriv("aes-256-gcm", key, nonce(dir, n++));
      d.setAuthTag(all.subarray(len - 16));
      onPlain(Buffer.concat([d.update(all.subarray(0, len - 16)), d.final()]));
    }
  };
}
/** 平板来的升级连接：核对身份 → 连本机服务端（它刚起，可能还没开始听，重试一会儿）→ 双向加密转发 */
export async function streamUpgrade(req, sock, head, now = Date.now()) {
  const fail = (code, msg) => { sock.end(`HTTP/1.1 ${code} x\r\ncontent-type: text/plain; charset=utf-8\r\n\r\n${msg}`); };
  let v;
  try { v = verify(JSON.parse(Buffer.from(String(req.headers["x-pad"] || ""), "base64").toString("utf8")), now); }
  catch (e) { return fail(e.status || 400, e.message); }
  const { key, q } = v, ch = q.ch === "video" ? "video" : "main";
  if (q.sid !== STREAM.sid || !STREAM.port) return fail(409, "这次串流不是最新开的那次：重新开始");
  if (STREAM.error) return fail(502, STREAM.error);
  const salt = Buffer.from(String(q.salt || ""), "base64");
  if (salt.length !== 16) return fail(400, "缺盐");
  let up = null;
  for (let i = 0; i < 40 && !up; i++) {
    if (STREAM.error) return fail(502, STREAM.error);
    up = await new Promise((ok) => { const c = SPAWN.connect(STREAM.port); c.once("connect", () => ok(c)); c.once("error", () => ok(null)); });
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) return fail(504, "手机上的串流服务端 10 秒没起来（Shizuku 开着吗？）");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: xkpad\r\nconnection: Upgrade\r\n\r\n");
  const toPad = sealer(streamKey(key, salt, ch, 0), 0);
  const fromPad = opener(streamKey(key, salt, ch, 1), 1, (plain) => up.write(plain));
  up.on("data", (c) => sock.write(toPad(c)));
  sock.on("data", (c) => { try { fromPad(c); } catch (e) { log("串流：平板来的数据解不开，断开：" + e.message); sock.destroy(); up.destroy(); } });
  if (head && head.length) sock.emit("data", head);
  const close = () => { sock.destroy(); up.destroy(); };
  up.on("close", close); sock.on("close", close); up.on("error", close); sock.on("error", close);
}

// ── 局域网监听：只有 /pad/pair、/pad/v1 和串流的升级连接，别的一律 404 ──
// Wi‑Fi / 热点的排前面，VPN 的（tun、ppp）排最后：主人照着手填时第一个就是对的
function lanAddrs() {
  const vpn = (n) => /^(tun|ppp|ipsec|wg)/.test(n);
  return Object.entries(os.networkInterfaces())
    .sort(([a], [b]) => vpn(a) - vpn(b))
    .flatMap(([, as]) => as.filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address));
}
let SERVER = null;
async function body(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 1 << 20) throw httpError(413, "太大了"); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw httpError(400, "不是 JSON"); }
}
export async function padHandle(req, res) {
  const p = new URL(req.url, "http://x").pathname;
  try {
    if (req.method === "POST" && p === "/pad/pair") return sendJson(res, 200, pairRequest(await body(req)));
    if (req.method === "POST" && p === "/pad/v1") return sendJson(res, 200, await padCall(await body(req)));
    return sendJson(res, 404, { error: "not found" });
  } catch (e) { return sendJson(res, e.status || 500, { error: e.message }); }
}
export function ensureServer() {
  if (SERVER || !LIVE) return;
  SERVER = http.createServer((req, res) => { padHandle(req, res).catch((e) => log("平板口子出错：" + e.message)); });
  SERVER.on("upgrade", (req, sock, head) => {
    if (new URL(req.url, "http://x").pathname !== "/pad/stream") return sock.destroy();
    streamUpgrade(req, sock, head).catch((e) => { log("串流出错：" + e.message); sock.destroy(); });
  });
  SERVER.on("error", (e) => { log(`⚠️ 平板口子 ${PAD_PORT} 开不了：${e.message}`); SERVER = null; });
  SERVER.listen(PAD_PORT, "0.0.0.0", () => log(`平板口子已开：${PAD_PORT}（只认配对过的平板）`));
}
if (LIVE && devices().devices.length) ensureServer();

// 外壳反连平板（XkPad.java）走到哪一步了：只给「我的 → 平板」看，开着 VPN 连不上时好知道卡在哪
export const BACK = { text: "", at: 0 };

// ── 手机上的界面（「我的 → 平板」）：开配对、确认、看已配对的、取消配对 ──
addRoute(async (req, res, u, p) => {
  if (!p.startsWith("/api/xk/pad")) return NEXT;
  if (p === "/api/xk/pad" && req.method === "GET") {
    return sendJson(res, 200, {
      devices: devices().devices.map(({ key, seq, seen, ...d }) => d), port: PAD_PORT, addrs: lanAddrs(), back: BACK,
      pairing: Date.now() < PAIR.until ? { until: PAIR.until, pending: [...PAIR.pending].map(([id, x]) => ({ id, name: x.name, sas: x.sas })) } : null,
    });
  }
  if (p === "/api/xk/pad/pair" && req.method === "POST") return sendJson(res, 200, openPairing());
  // 外壳（XkStream.java）报串流服务端起不来：平板那边拿 /pad/stream/status 看得到原因
  if (p === "/api/xk/pad/stream" && req.method === "PUT") {
    const b = await json(req);
    if (b.sid === STREAM.sid) STREAM.error = String(b.error || "");
    if (STREAM.error) log("串流：" + STREAM.error);
    return sendJson(res, 200, { sid: STREAM.sid, error: STREAM.error });
  }
  if (p === "/api/xk/pad/back" && req.method === "PUT") {
    BACK.text = String((await json(req)).text || ""); BACK.at = Date.now();
    return sendJson(res, 200, BACK);
  }
  if (p === "/api/xk/pad/confirm" && req.method === "POST") return sendJson(res, 200, confirmPair(String((await json(req)).id || "")));
  const m = p.match(/^\/api\/xk\/pad\/([0-9a-f]+)$/);
  if (m && req.method === "DELETE") return sendJson(res, 200, unpair(m[1]));
  return NEXT;
});

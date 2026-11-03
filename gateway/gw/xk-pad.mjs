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
export async function padCall(env, now = Date.now()) {
  const d = byId(String(env.id || ""));
  if (!d) throw httpError(PAIR.pending.has(env.id) ? 403 : 401, PAIR.pending.has(env.id) ? "等手机上确认配对" : "这台平板没配对过");
  const key = Buffer.from(d.key, "base64"), q = open(key, env, d.id);
  if (Math.abs(now - Number(q.t)) > SKEW_MS) throw httpError(401, "时间对不上（两台设备的钟差了一分钟以上）");
  if (!(Number(q.q) > d.seq)) throw httpError(401, "序号旧了：这个请求已经用过");
  d.seq = Number(q.q); d.lastSeen = now; save();   // 序号落盘：网关重启后旧请求照样不认
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

// ── 局域网监听：只有 /pad/pair 和 /pad/v1 两个口子，别的一律 404 ──
function lanAddrs() {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);
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
  SERVER.on("error", (e) => { log(`⚠️ 平板口子 ${PAD_PORT} 开不了：${e.message}`); SERVER = null; });
  SERVER.listen(PAD_PORT, "0.0.0.0", () => log(`平板口子已开：${PAD_PORT}（只认配对过的平板）`));
}
if (LIVE && devices().devices.length) ensureServer();

// ── 手机上的界面（「我的 → 平板」）：开配对、确认、看已配对的、取消配对 ──
addRoute(async (req, res, u, p) => {
  if (!p.startsWith("/api/xk/pad")) return NEXT;
  if (p === "/api/xk/pad" && req.method === "GET") {
    return sendJson(res, 200, {
      devices: devices().devices.map(({ key, seq, ...d }) => d), port: PAD_PORT, addrs: lanAddrs(),
      pairing: Date.now() < PAIR.until ? { until: PAIR.until, pending: [...PAIR.pending].map(([id, x]) => ({ id, name: x.name, sas: x.sas })) } : null,
    });
  }
  if (p === "/api/xk/pad/pair" && req.method === "POST") return sendJson(res, 200, openPairing());
  if (p === "/api/xk/pad/confirm" && req.method === "POST") return sendJson(res, 200, confirmPair(String((await json(req)).id || "")));
  const m = p.match(/^\/api\/xk\/pad\/([0-9a-f]+)$/);
  if (m && req.method === "DELETE") return sendJson(res, 200, unpair(m[1]));
  return NEXT;
});

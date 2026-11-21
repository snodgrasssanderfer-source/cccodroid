// 本地句向量（主人 11-11 定：12 号挑记忆改成按意思挑）。
// 模型 bge-small-zh-v1.5 量化版（24MB）+ onnxruntime-web 的 wasm，放在 ~/.cache/xk-embed，不进 APK；
// 没装、载不起来、等超时都返回 null，调用方退回按字挑。算一句约 20ms，在单独的线程里跑。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Worker } from "node:worker_threads";

export const EMBED_DIR = process.env.XK_EMBED_DIR || path.join(os.homedir(), ".cache", "xk-embed");
export const EMBED_MODEL = "bge-small-zh-v1.5-q8";
// bge 建议拿短句去找长段时，查询那边加这句引子（11-11 拿 12 号的记忆试过：不相干的话挑出来的杂条少了）
export const QUERY_PFX = "为这个句子生成表示以用于检索相关文章：";
const DIM_MAX = 1024;

export function embedInstalled(dir = EMBED_DIR) {
  return fs.existsSync(path.join(dir, "bge-small-zh", "model_quantized.onnx")) &&
    fs.existsSync(path.join(dir, "rt", "node_modules", "onnxruntime-web", "package.json"));
}

let W = null, seq = 0, dead = "";
const WAIT = new Map();
function worker() {
  if (W || dead) return W;
  if (!embedInstalled()) { dead = "没装"; return null; }
  W = new Worker(new URL("./xk-embed-worker.mjs", import.meta.url), { workerData: { dir: EMBED_DIR } });
  W.unref();
  W.on("message", ({ id, vecs, err }) => { const w = WAIT.get(id); if (w) { WAIT.delete(id); w(err ? null : vecs); } });
  W.on("error", (e) => { dead = String(e?.message || e); W = null; for (const w of WAIT.values()) w(null); WAIT.clear(); });
  return W;
}
/** 测试收尾用：关掉那条线程，进程才退得出 */
export async function embedStop() { const w = W; W = null; dead = ""; if (w) await w.terminate(); }
/** 网关起来时先载上（载一次不到一秒），第一句话就不用等 */
export function embedWarm() { const w = worker(); if (w) embedAsync(["预热"]).catch(() => {}); return !!w; }

/** 异步算：给记忆补向量用。失败返回 null */
export function embedAsync(texts, timeoutMs = 60000) {
  const w = worker();
  if (!w || !texts.length) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((res) => {
    const t = setTimeout(() => { WAIT.delete(id); res(null); }, timeoutMs);
    WAIT.set(id, (v) => { clearTimeout(t); res(v); });
    w.postMessage({ id, texts });
  });
}

/** 同步算：挑记忆那一步在同步代码里，主线程干等（最多 timeoutMs）。还没载好、超时都返回 null */
export function embedSync(texts, timeoutMs = 400) {
  const w = worker();
  if (!w || !texts.length) return null;
  const sab = new SharedArrayBuffer(16 + texts.length * DIM_MAX * 4);
  const head = new Int32Array(sab, 0, 4);
  w.postMessage({ id: ++seq, texts, sab });
  if (Atomics.wait(head, 0, 0, timeoutMs) === "timed-out" || Atomics.load(head, 0) !== 1) return null;
  const n = head[1], dim = head[2];
  return Array.from({ length: n }, (_, i) => new Float32Array(sab, 16 + i * dim * 4, dim).slice());
}

export const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// 存盘：按这条里绝对值最大的那维放大到 ±127 压成 int8，再 base64，512 维一条不到 700 字；取回时重新归一，长度不用存
export function vecPack(v) {
  let mx = 0; for (const x of v) mx = Math.max(mx, Math.abs(x));
  const k = mx ? 127 / mx : 0;
  return Buffer.from(Int8Array.from(v, (x) => Math.round(x * k)).buffer).toString("base64");
}
export function vecUnpack(s) {
  const b = Buffer.from(s, "base64"), i8 = new Int8Array(b.buffer, b.byteOffset, b.length), v = new Float32Array(i8.length);
  let n = 0;
  for (let i = 0; i < i8.length; i++) { v[i] = i8[i] / 127; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
export const textHash = (t) => crypto.createHash("sha1").update(String(t)).digest("base64").slice(0, 10);

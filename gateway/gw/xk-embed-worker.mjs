// 向量那条线程：载 onnxruntime-web（wasm，单线程）和 bge-small-zh 量化模型，收一批句子、回一批单位向量（512 维）。
// 主线程要同步等时传一块 SharedArrayBuffer：写进去再 notify；不传就 postMessage 回去。
import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { makeTokenizer } from "./xk-embed-tok.mjs";

const { dir } = workerData;
let session = null, encode = null, ort = null, dim = 0, failed = "";

async function load() {
  const rtMain = path.join(dir, "rt", "node_modules", "onnxruntime-web", "package.json");
  ort = createRequire(rtMain)("onnxruntime-web");
  ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = pathToFileURL(path.join(dir, "rt", "node_modules", "onnxruntime-web", "dist") + "/").href;
  const md = path.join(dir, "bge-small-zh");
  const tj = JSON.parse(fs.readFileSync(path.join(md, "tokenizer.json"), "utf8"));
  encode = makeTokenizer(tj.model.vocab, { max: 256 });
  session = await ort.InferenceSession.create(fs.readFileSync(path.join(md, "model_quantized.onnx")));
  dim = JSON.parse(fs.readFileSync(path.join(md, "config.json"), "utf8")).hidden_size || 512;
}
const ready = load().catch((e) => { failed = String(e?.message || e); });

async function embed(texts) {
  const ids = texts.map(encode), L = Math.max(...ids.map((a) => a.length)), n = ids.length;
  const inp = new BigInt64Array(n * L), mask = new BigInt64Array(n * L), type = new BigInt64Array(n * L);
  ids.forEach((a, i) => a.forEach((t, j) => { inp[i * L + j] = BigInt(t); mask[i * L + j] = 1n; }));
  const feeds = {};
  for (const name of session.inputNames) {
    const data = name === "input_ids" ? inp : name === "attention_mask" ? mask : type;
    feeds[name] = new ort.Tensor("int64", data, [n, L]);
  }
  const out = await session.run(feeds);
  const h = out[session.outputNames[0]].data;   // [n, L, dim]，取 [CLS] 那一格
  return ids.map((_, i) => {
    const v = new Float32Array(dim);
    let s = 0;
    for (let k = 0; k < dim; k++) { v[k] = h[i * L * dim + k]; s += v[k] * v[k]; }
    s = Math.sqrt(s) || 1;
    for (let k = 0; k < dim; k++) v[k] /= s;
    return v;
  });
}

parentPort.on("message", async ({ id, texts, sab }) => {
  await ready;
  let vecs = null, err = failed;
  if (!err) { try { vecs = await embed(texts); } catch (e) { err = String(e?.message || e); } }
  if (sab) {
    // 头 4 个 int32：状态（1 好 2 错）、条数、维数、空；后面是向量
    const head = new Int32Array(sab, 0, 4);
    if (vecs && 16 + vecs.length * dim * 4 <= sab.byteLength) {
      const body = new Float32Array(sab, 16);
      vecs.forEach((v, i) => body.set(v, i * dim));
      head[1] = vecs.length; head[2] = dim; Atomics.store(head, 0, 1);
    } else Atomics.store(head, 0, 2);
    Atomics.notify(head, 0);
  } else parentPort.postMessage({ id, vecs, err });
});

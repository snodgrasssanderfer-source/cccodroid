// 平板 App 的 Java 加密（xk/pad/java/cc/codroid/pad/PadCrypto.java）和网关（xk-pad.mjs）对得上：同一个 6 位数、同一把密钥、互相解得开。
// 机器上没有 javac 就跳过（GitHub 的机器和云端会话里都有）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { onPublish } from "../gw/bus.mjs";
import { open, openPairing, pairRequest, seal } from "../gw/xk-pad.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const hasJavac = spawnSync("javac", ["-version"]).status === 0;

test("Java 端和网关：配对比的数一样、密钥一样、加密互通", { skip: !hasJavac && "没有 javac" }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "padjava-"));
  execFileSync("javac", ["-d", out, path.join(here, "../../xk/pad/java/cc/codroid/pad/PadCrypto.java"), path.join(here, "fixtures/PadCryptoCheck.java")]);
  const j = (...a) => execFileSync("java", ["-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-cp", out, "cc.codroid.pad.PadCryptoCheck", ...a], { encoding: "utf8" }).trim().split("\n");
  const [pub, priv] = j("gen");
  openPairing();
  let phone = null;
  const off = onPublish((e) => { if (e.op === "pad_pending") phone = e; });
  const r = pairRequest({ pub, name: "测试平板" });
  off();
  const [key64, sas] = j("derive", priv, r.pub, pub);
  assert.equal(sas, phone.sas, "两块屏幕上的 6 位数一样");
  const key = Buffer.from(key64, "base64");
  const [n, c] = j("seal", key64, JSON.stringify({ t: 1, q: 2, m: "GET", p: "/api/xk/roles" }), r.id);
  assert.deepEqual(open(key, { n, c }, r.id), { t: 1, q: 2, m: "GET", p: "/api/xk/roles" }, "网关解得开平板加的密");
  const env = seal(key, { s: 200, b: { 好: "的" } }, r.id);
  assert.deepEqual(JSON.parse(j("open", key64, env.n, env.c, r.id)[0]), { s: 200, b: { 好: "的" } }, "平板解得开网关加的密");
  fs.rmSync(out, { recursive: true, force: true });
});

// 平板 App 的 Java 加密（xk/pad/java/cc/codroid/pad/PadCrypto.java）和网关（xk-pad.mjs）对得上：同一个 6 位数、同一把密钥、互相解得开。
// 机器上没有 javac 就跳过（GitHub 的机器和云端会话里都有）
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { onPublish } from "../gw/bus.mjs";
import { open, opener, openPairing, pairRequest, seal, sealer, streamKey } from "../gw/xk-pad.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const hasJavac = spawnSync("javac", ["-version"]).status === 0;

test("Java 端和网关：配对比的数一样、密钥一样、加密互通", { skip: !hasJavac && "没有 javac" }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "padjava-"));
  // PadStream 里用了安卓的类：桌面上编不了整个文件，只抽出加解密那两个内部类和 subKey / nonce 来编
  const ps = fs.readFileSync(path.join(here, "../../xk/pad/java/cc/codroid/pad/PadStream.java"), "utf8");
  const pick = (from, to) => ps.slice(ps.indexOf(from), ps.indexOf(to));
  fs.mkdirSync(path.join(out, "src"), { recursive: true });
  fs.writeFileSync(path.join(out, "src/PadStream.java"), "package cc.codroid.pad;\nimport java.io.*;\nimport javax.crypto.Cipher;\nimport javax.crypto.spec.GCMParameterSpec;\nimport javax.crypto.spec.SecretKeySpec;\nfinal class PadStream {\n" +
    pick("    /** 和网关 streamKey 一样", "    /** 手机 → 平板") + pick("    /** 手机 → 平板", "\n}\n") + "}\n");
  execFileSync("javac", ["-d", out, path.join(here, "../../xk/pad/java/cc/codroid/pad/PadCrypto.java"), path.join(out, "src/PadStream.java"), path.join(here, "fixtures/PadCryptoCheck.java")]);
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
  // 串流：平板加的块网关解得开（两段 = 两块，计数接着走），网关加的块平板解得开
  const salt = crypto.randomBytes(16).toString("base64");
  const frames = Buffer.from(j("stream", key64, salt, "main", "hello", ", phone")[0], "base64");   // 命令行参数用英文：没设语言环境的机器上中文参数会被 Java 读坏
  const plain = [];
  opener(streamKey(key, Buffer.from(salt, "base64"), "main", 1), 1, (p) => plain.push(p.toString()))(frames);
  assert.equal(plain.join(""), "hello, phone");
  const enc = sealer(streamKey(key, Buffer.from(salt, "base64"), "video", 0), 0);
  const blob = Buffer.concat([enc(Buffer.from("画面")), enc(Buffer.from("一帧"))]).toString("base64");
  assert.equal(j("unstream", key64, salt, "video", blob)[0], "画面一帧");
  fs.rmSync(out, { recursive: true, force: true });
});

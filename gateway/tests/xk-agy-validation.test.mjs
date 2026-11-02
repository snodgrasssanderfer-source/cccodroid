// #2：Google 要求先验证账号时，哈基米的报错要说清楚、给出验证链接（假 agy 吐的是 11-01 真机抓到的原文，plt 换成了占位）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { onPublish } from "../gw/bus.mjs";
import { ensureRoles } from "../gw/xk-roles.mjs";
import { ENGINES, STATE } from "../gw/xk-core.mjs";
import { AGY, agyValidation, runAgy, stopAgy } from "../gw/xk-agy.mjs";
import { fakeAgy } from "./fixtures/xk-fake-agy.mjs";

const URL_ = "https://accounts.google.com/v3/signin/continue?plt=PLT_PLACEHOLDER&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini&sarp=1&scc=1&flowName=GlifWebSignIn&authuser";
// agy 1.4.12，账号没验证时 stream-json 的 result（stderr 里是同一段，前面多个 "error: "）
const REAL = "Eligibility check failed: Your current account is not eligible for Antigravity. Verify your account to continue.\n\nAlternatively, try signing in with another personal Google account.\n\nPlease verify your account in your browser to continue:\n" + URL_;

const fake = async (lines, code = 0, stderr = "") => { await stopAgy(); fakeAgy(AGY, { lines, code, stderr }); };
after(() => stopAgy());
const run = (item) => new Promise((ok) => {
  const evs = [];
  const off = onPublish((e) => { if (e.runId === item.id) { evs.push(e); if (e.type === "run_end") { off(); ok(evs); } } });
  runAgy(item);
});

test("认得出要验证账号，链接整条取出来；别的错误不算", () => {
  assert.deepEqual(agyValidation(REAL), { url: URL_ });
  assert.deepEqual(agyValidation("error: " + REAL), { url: URL_ }, "stderr 那份");
  // agy 内部日志里是 403 + VALIDATION_REQUIRED + validation_url（JSON），这种写法也认
  assert.deepEqual(agyValidation(`PERMISSION_DENIED (code 403): Verify your account to continue. "reason": "VALIDATION_REQUIRED", "validation_url": "${URL_}"`), { url: URL_ });
  assert.deepEqual(agyValidation("Verify your account to continue."), { url: null }, "没带链接也认，只是给不出链接");
  assert.equal(agyValidation("authentication failed or timed out"), null);
  assert.equal(agyValidation("RESOURCE_EXHAUSTED: quota exceeded"), null);
  assert.equal(agyValidation(""), null);
});

test("真实格式跑一轮：报错说清楚、带链接；不当成没登录；验证前不接班；之后成功一轮就解除", async () => {
  ensureRoles();
  delete STATE.agyAuth; delete STATE.agyVerify;
  await fake([{ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: REAL, finished_reason: "error" } }], 1, "error: " + REAL);
  const evs = await run({ id: "xv1", message: "在吗", sessionId: null });
  const err = evs.find((e) => e.type === "error").message;
  assert.match(err, /Google 要求先验证/);
  assert.ok(err.includes(URL_), "链接整条带上");
  assert.equal(evs.at(-1).isError, true);
  assert.equal(STATE.agyAuth, undefined, "登录是好的，别标成没登录");
  assert.equal(STATE.agyVerify.url, URL_);
  assert.equal(ENGINES.agy(), false, "没验证时接不了班");
  await fake([{ event: "result", result: { conversation_id: "c9", status: "SUCCESS", response: "在的" } }]);
  const ok = await run({ id: "xv2", message: "在吗", sessionId: null });
  assert.equal(ok.at(-1).isError, false);
  assert.equal(STATE.agyVerify, undefined);
  assert.equal(ENGINES.agy(), true);
});

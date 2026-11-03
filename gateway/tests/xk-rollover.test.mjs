// 小鱼：上下文到 20% 自动换新对话（#72）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLLOVER_AT, agyTokens, agyUsage, contextRatio, rolloverAt, takeRollover } from "../gw/xk-rollover.mjs";
import { STATE, carryText } from "../gw/xk-core.mjs";
import { END_HOOKS } from "../gw/queue.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";

test("上下文占用：按 context_tokens / context_window 算，两成到线", () => {
  assert.equal(ROLLOVER_AT, 0.2);
  assert.equal(contextRatio({ sessionId: "s" }, { usage: { context_tokens: 200000, context_window: 1000000 } }), 0.2);
  assert.ok(contextRatio({ sessionId: "s" }, { usage: { context_tokens: 199999, context_window: 1000000 } }) < ROLLOVER_AT);
  assert.equal(contextRatio({ sessionId: "s" }, {}), null);   // 拿不到也估不出（没有会话记录）就先不动
});

test("只有同一段才换；换了就把标记清掉", () => {
  STATE.rollover = { deepseek: { sid: "s1", pct: 0.35 } };
  assert.equal(takeRollover("deepseek", "s2"), null);
  const r = takeRollover("deepseek", "s1");
  assert.equal(r.fromSid, "s1");
  assert.match(r.reason, /35%/);
  assert.equal(takeRollover("deepseek", "s1"), null);
});

test("哈基米走 agy：读日志最后一条 PLANNER_RESPONSE 的实际上下文（input + 缓存 + 输出）", () => {
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-"));
  STATE.agyConv = { s1: "conv-1" };
  const logs = path.join(brain, "conv-1", ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, "transcript.jsonl"), [
    JSON.stringify({ type: "PLANNER_RESPONSE", input_tokens: 1, cache_read_tokens: 1, output_tokens: 1 }),
    JSON.stringify({ type: "GENERIC", content: "中间夹着别的记录" }),
    JSON.stringify({ type: "PLANNER_RESPONSE", input_tokens: 2922, cache_read_tokens: 158224, output_tokens: 596 }),
  ].join("\n"));
  assert.equal(agyTokens("s1", brain), 161742, "只读 input_tokens 会小一个数量级");
  assert.equal(agyTokens("没跑过的会话", brain), 0, "不知道 agy 会话号就退回字数估");
  const u = agyUsage("s1", brain);
  assert.deepEqual([u.context_tokens, u.context_window], [161742, 1000000], "卡片和换新线共用这份数");
  STATE.agyConv = {};
});

test("换新线按角色分开：哈基米 60%，别人照 20%", () => {
  ensureRoles();
  assert.equal(rolloverAt("hachimi"), 0.6);
  assert.equal(rolloverAt("xiaoke"), 0.2);
  assert.equal(rolloverAt("deepseek"), 0.2);
  const cwd = fs.realpathSync(roleDir("hachimi"));
  const end = (sid, f) => END_HOOKS.forEach((h) => { try { h({ id: "r-" + sid, sessionId: sid, cwd }, f); } catch {} });
  STATE.rollover = {};
  end("s-h", { usage: { context_tokens: 590000, context_window: 1000000 } });
  assert.equal(STATE.rollover.hachimi, undefined, "五成九还没到她的线");
  end("s-h", { usage: { context_tokens: 610000, context_window: 1000000 } });
  assert.equal(STATE.rollover.hachimi.sid, "s-h", "过了六成才换");
  STATE.rollover = {};
});

test("自己换自己的交接说明：带的是她自己上一段，不是别人的记忆", () => {
  const t = carryText(null, "deepseek", "deepseek", "上一段对话太长（占到 21%），自动换了新对话");
  assert.match(t, /换新对话说明/);
  assert.match(t, /21%/);
});

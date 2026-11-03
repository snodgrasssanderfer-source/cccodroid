// 小鱼：上下文到 20% 自动换新对话（#72）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLLOVER_AT, contextRatio, takeRollover } from "../gw/xk-rollover.mjs";
import { STATE, carryText } from "../gw/xk-core.mjs";

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

test("自己换自己的交接说明：带的是她自己上一段，不是别人的记忆", () => {
  const t = carryText(null, "deepseek", "deepseek", "上一段对话太长（占到 21%），自动换了新对话");
  assert.match(t, /换新对话说明/);
  assert.match(t, /21%/);
});

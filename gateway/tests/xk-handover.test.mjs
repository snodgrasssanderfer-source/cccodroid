// 小克：接班判定、顺序、发消息时换人与交回
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENGINES, PLANNERS, STATE } from "../gw/xk-core.mjs";
import { limitHit, nextRole, roleReady } from "../gw/xk-handover.mjs";

const run = (o = {}) => ({ id: "r1", provider: "anthropic", startedAt: Date.now() - 1000, ...o });

test("额度用完的两种信号：429 文本；订阅 rate_limit_event rejected（取被拒窗口的重置时间）", () => {
  assert.equal(limitHit(run({ provider: "deepseek" }), { isError: false }, null, "429"), null, "没出错就不是");
  const h = limitHit(run({ provider: "deepseek" }), { isError: true }, null, "API Error: Request rejected (429) · rate limit");
  assert.match(h.reason, /429/);
  assert.ok(h.until > Date.now());
  assert.equal(limitHit(run({ provider: "deepseek" }), { isError: true }, null, "网络断了"), null);
  const reset = Math.floor(Date.now() / 1000) + 7200;
  const rl = { status: "rejected", at: Date.now(), fiveHour: { used: 100, resetsAt: reset }, sevenDay: { used: 40, resetsAt: reset + 99999 } };
  const s = limitHit(run(), { isError: true }, rl, "");
  assert.equal(s.until, reset * 1000);
  assert.match(s.reason, /订阅/);
  assert.equal(limitHit(run(), { isError: true }, { ...rl, at: 0 }, ""), null, "上一轮留下的旧额度事件不算");
});

test("按顺序找下一个能接的，跳过冷却中和没就绪的", () => {
  STATE.order = ["xiaoke", "hachimi", "deepseek"];
  STATE.cooldown = {};
  ENGINES.agy = () => true;
  assert.equal(nextRole("xiaoke").id, "hachimi");
  STATE.cooldown.hachimi = { until: Date.now() + 60000 };
  assert.equal(roleReady({ id: "hachimi", engine: "agy" }), false);
  // DeepSeek 没填 Key、哈基米冷却：转一圈回到小克
  assert.equal(nextRole("deepseek").id, "xiaoke");
  STATE.cooldown.hachimi = { until: Date.now() - 1 };
  assert.equal(roleReady({ id: "hachimi", engine: "agy" }), true, "过了重置时间自动解除");
  ENGINES.agy = () => false;
  assert.equal(nextRole("xiaoke"), null);
  // 11-06 大扫除：from 不在顺序里（老状态文件、角色被删）从排头转一圈，以前 -1 会永远轮不到最后一位
  ENGINES.agy = () => true;
  STATE.order = ["hachimi", "deepseek", "xiaoke"];
  STATE.cooldown = { hachimi: { until: Date.now() + 60000 } };
  assert.equal(nextRole("nobody").id, "xiaoke", "轮到排最后那一位");
  STATE.order = ["xiaoke", "hachimi", "deepseek"];
  STATE.cooldown = {};
});

test("发消息：落到冷却中的角色就换人带上对话；接班会话里原角色恢复了就交回", async () => {
  STATE.projects = { xiaoke: "p-x", hachimi: "p-h", deepseek: "p-d" };
  ENGINES.agy = () => true;
  STATE.cooldown = { xiaoke: { until: Date.now() + 3600e3, reason: "订阅额度用完了" } };
  const plan = async (b, role) => { const ctx = { body: { ...b }, role, carry: null, notice: null }; for (const p of PLANNERS) await p(b, ctx); return ctx; };
  let c = await plan({ message: "在吗", sessionId: "s-old" }, "xiaoke");
  assert.equal(c.role, "hachimi");
  assert.equal(c.body.projectId, "p-h");
  assert.equal(c.body.sessionId, null);
  assert.equal(c.carry.fromSid, "s-old");
  c.onQueued({ id: "r-new" });
  assert.equal(STATE.originRun["r-new"].from, "xiaoke");
  // 原角色恢复：接班会话里的下一条交回去
  STATE.cooldown = {};
  STATE.origin["s-h"] = { from: "xiaoke", reason: "x" };
  c = await plan({ message: "我回来了", sessionId: "s-h" }, "hachimi");
  assert.equal(c.role, "xiaoke");
  assert.equal(c.body.projectId, "p-x");
  assert.match(c.notice.reason, /交回/);
  // 斜杠命令不换人
  STATE.cooldown = { xiaoke: { until: Date.now() + 3600e3 } };
  c = await plan({ message: "/compact", sessionId: "s-old" }, "xiaoke");
  assert.equal(c.role, "xiaoke");
});

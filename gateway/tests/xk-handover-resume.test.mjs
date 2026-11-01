// #1：接班后交回原角色（额度恢复自动交回、主人手动换回来），接着原来那段会话，不新开
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";
import { publish } from "../gw/bus.mjs";
import { projectSlug } from "../gw/projects.mjs";
import { ENGINES, STATE, carryText } from "../gw/xk-core.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import { planChat, switchTo } from "../gw/xk.mjs";

ensureRoles();
ENGINES.agy = () => true;
STATE.projects = { xiaoke: "p-x", hachimi: "p-h", deepseek: "p-d" };
const session = (role, sid) => {
  const cwd = fs.realpathSync(roleDir(role)), dir = path.join(CFG.home, ".claude", "projects", projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), JSON.stringify({ type: "user", sessionId: sid, cwd, uuid: "u", message: { role: "user", content: "你好" } }) + "\n");
  return sid;
};
const X = session("xiaoke", "bbbbbbbb-2222-4222-8222-000000000001");    // 小克原来那段
const H = session("hachimi", "bbbbbbbb-2222-4222-8222-000000000002");   // 哈基米接班那段
const GONE = "bbbbbbbb-2222-4222-8222-0000000000ff";                     // 已经删掉的会话
const reset = (o = {}) => Object.assign(STATE, { cooldown: {}, origin: {}, originRun: {}, pending: {}, ...o });

test("额度用完换人：接班会话记下来源会话号", async () => {
  reset({ cooldown: { xiaoke: { until: Date.now() + 3600e3, reason: "订阅额度用完了" } } });
  const c = await planChat({ message: "在吗", sessionId: X });
  assert.equal(c.role, "hachimi");
  assert.equal(c.body.sessionId, null, "接班的一方照旧新开");
  c.onQueued({ id: "r1" });
  assert.equal(STATE.originRun.r1.fromSid, X);
  publish({ type: "init", runId: "r1", sessionId: H });
  assert.equal(STATE.origin[H].fromSid, X, "拿到会话号后转进 origin，来源会话号跟着");
});

test("额度恢复后交回：接着原来那段，带上接班期间的对话", async () => {
  reset({ origin: { [H]: { from: "xiaoke", fromSid: X, reason: "x" } } });
  const c = await planChat({ message: "我回来了", sessionId: H });
  assert.equal(c.role, "xiaoke");
  assert.equal(c.body.sessionId, X);
  assert.equal(c.body.projectId, "p-x");
  assert.deepEqual([c.carry.fromSid, c.carry.fromRole, c.carry.back], [H, "hachimi", true]);
  assert.equal(c.notice.back, true);
});

test("原来那段没了、或者是旧版记的没有来源会话号：照旧新开", async () => {
  reset({ origin: { [H]: { from: "xiaoke", fromSid: GONE, reason: "x" } } });
  let c = await planChat({ message: "我回来了", sessionId: H });
  assert.equal(c.role, "xiaoke");
  assert.equal(c.body.sessionId, null);
  assert.ok(!c.carry.back);
  reset({ origin: { [H]: { from: "xiaoke", reason: "x" } } });
  c = await planChat({ message: "我回来了", sessionId: H });
  assert.equal(c.body.sessionId, null);
});

test("来源会话号指向别的角色的会话：不接（只回到原角色自己的会话）", async () => {
  reset({ origin: { [H]: { from: "xiaoke", fromSid: H, reason: "x" } } });
  const c = await planChat({ message: "我回来了", sessionId: H });
  assert.equal(c.role, "xiaoke");
  assert.equal(c.body.sessionId, null);
});

test("手动换走再换回来：接着原来那段，接班期间的对话只带一次", async () => {
  reset();
  // 在小克的会话里手动换成哈基米：她新开一段，记下从哪来的
  let sw = switchTo("hachimi", X, "主人手动换了角色");
  assert.equal(sw.resume, null);
  let c = await planChat({ message: "换你来", projectId: "p-h" });
  assert.equal(c.role, "hachimi");
  assert.equal(c.carry.fromSid, X);
  c.onQueued({ id: "r2" });
  publish({ type: "init", runId: "r2", sessionId: H });
  assert.equal(STATE.origin[H].fromSid, X);
  // 在哈基米那段里换回小克：回到 X
  sw = switchTo("xiaoke", H, "主人手动换了角色");
  assert.equal(sw.resume, X);
  c = await planChat({ message: "我又回来了", sessionId: X });
  assert.equal(c.role, "xiaoke");
  assert.equal(c.body.sessionId, X);
  assert.deepEqual([c.carry.fromSid, c.carry.back], [H, true]);
  assert.equal(STATE.pending.xiaoke, undefined);
  c = await planChat({ message: "再说一句", sessionId: X });
  assert.equal(c.carry, null, "说明只跟着回来后的第一条");
});

test("交回说明：说的是你回来了、接着原来的对话，不是换你接着聊", () => {
  const t = carryText(H, "hachimi", "xiaoke", "主人把你换了回来", true);
  assert.match(t, /交回说明/);
  assert.match(t, /哈基米/);
  assert.doesNotMatch(t, /现在换成你接着聊/);
  assert.match(carryText(X, "xiaoke", "hachimi", "主人手动换了角色"), /现在换成你接着聊/, "接班的措辞不变");
});

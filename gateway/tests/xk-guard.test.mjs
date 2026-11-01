// 兜底：哈基米（不走 Claude Code）的会话 / 项目里，任何一轮都不许起 claude（主人 11-01 报：DeepSeek 顶着哈基米的人设说话）
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";
import { START_GUARDS } from "../gw/queue.mjs";
import { projectSlug } from "../gw/projects.mjs";
import { ENGINE_RUN, STATE } from "../gw/xk-core.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import "../gw/xk.mjs";

ensureRoles();
const calls = [];
ENGINE_RUN.agy = (item) => calls.push(item);
STATE.projects = { xiaoke: "p-x", hachimi: "p-h", deepseek: "p-d" };
const session = (role, sid) => {
  const cwd = fs.realpathSync(roleDir(role)), dir = path.join(CFG.home, ".claude", "projects", projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), JSON.stringify({ type: "user", sessionId: sid, cwd, uuid: "u", message: { role: "user", content: "你好" } }) + "\n");
  return sid;
};
const startable = (q) => START_GUARDS.every((g) => g(q) !== false);
const H = session("hachimi", "aaaaaaaa-1111-4111-8111-000000000001"), X = session("xiaoke", "aaaaaaaa-1111-4111-8111-000000000002");

test("哈基米会话里主人发的消息：不起 claude，改交 agy，会话号带过去", () => {
  assert.equal(startable({ id: "q1", sessionId: H, message: "你是什么模型" }), false);
  assert.deepEqual(calls.at(-1), { id: "q1", message: "你是什么模型", sessionId: H });
});

test("哈基米会话里网关自己起的（空闲压缩）：直接不跑", () => {
  const n = calls.length;
  assert.equal(startable({ id: "q2", sessionId: H, message: "/compact", auto: "idle" }), false);
  assert.equal(calls.length, n);
});

test("哈基米项目里的新会话也改交 agy；小克的会话照常起 claude", () => {
  assert.equal(startable({ id: "q3", projectId: "p-h", message: "在吗" }), false);
  assert.equal(calls.at(-1).id, "q3");
  assert.equal(startable({ id: "q4", sessionId: X, message: "在吗" }), true);
  assert.equal(startable({ id: "q5", projectId: "p-x", message: "在吗" }), true);
});

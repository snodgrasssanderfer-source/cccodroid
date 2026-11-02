// 整理记忆用便宜档：小克那轮用 haiku，不再为记笔记跑一轮主模型；看法不在整理里补记
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";
import { START_GUARDS } from "../gw/queue.mjs";
import { projectSlug } from "../gw/projects.mjs";
import { STATE } from "../gw/xk-core.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import { consolidate } from "../gw/xk-memory.mjs";

ensureRoles();
STATE.projects = { xiaoke: "p-x", hachimi: "p-h", deepseek: "p-d" };
const seen = [];
START_GUARDS.unshift((q) => { if (q.auto === "xk-memory") { seen.push(q); return false; } return true; });   // 不真去跑
const session = (role, sid) => {
  const cwd = fs.realpathSync(roleDir(role)), dir = path.join(CFG.home, ".claude", "projects", projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), [
    { type: "user", sessionId: sid, cwd, uuid: "u1", timestamp: at, message: { role: "user", content: "下周六去爬山" } },
    { type: "assistant", sessionId: sid, cwd, uuid: "a1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "好呀" }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  return sid;
};

test("小克的整理轮用 haiku；DeepSeek 用她自己的默认（本来就是 flash）", () => {
  const x = consolidate(session("xiaoke", "dddddddd-4444-4444-8444-000000000001"));
  assert.ok(x, "有内容就起一轮");
  assert.equal(x.model, "haiku");
  assert.doesNotMatch(x.message, /你自己的看法用 remember/);
  const d = consolidate(session("deepseek", "dddddddd-4444-4444-8444-000000000002"));
  assert.equal(d.model, null);
});

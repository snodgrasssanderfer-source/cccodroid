// 手动换人：接着她自己最近那段会话，不再次次新开（主人 11-02：小克→哈基米→小鱼一路换，每次都是新对话）
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";
import { END_HOOKS } from "../gw/queue.mjs";
import { projectSlug } from "../gw/projects.mjs";
import { ENGINES, STATE } from "../gw/xk-core.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import { lastSidOf, planChat, switchTo } from "../gw/xk.mjs";

ensureRoles();
ENGINES.agy = () => true;
STATE.projects = { xiaoke: "p-x", hachimi: "p-h", deepseek: "p-d" };
const cwdOf = (role) => fs.realpathSync(roleDir(role));
const session = (role, sid) => {
  const dir = path.join(CFG.home, ".claude", "projects", projectSlug(cwdOf(role)));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), JSON.stringify({ type: "user", sessionId: sid, cwd: cwdOf(role), uuid: "u", message: { role: "user", content: "你好" } }) + "\n");
  return sid;
};
const ended = (role, sid, extra = {}) => END_HOOKS.forEach((h) => { try { h({ id: "r-" + sid, sessionId: sid, cwd: cwdOf(role), ...extra }, {}); } catch {} });
const X = session("xiaoke", "cccccccc-3333-4333-8333-000000000001");
const H = session("hachimi", "cccccccc-3333-4333-8333-000000000002");
const D = session("deepseek", "cccccccc-3333-4333-8333-000000000003");
const DIARY = session("deepseek", "cccccccc-3333-4333-8333-000000000004");
const reset = () => Object.assign(STATE, { cooldown: {}, origin: {}, originRun: {}, pending: {}, lastByRole: {} });

test("跑完一轮记下这个角色最近那段；网关自己起的轮次不算", () => {
  reset();
  ended("deepseek", D);
  ended("deepseek", DIARY, { sched: { taskId: "t" } });
  ended("deepseek", DIARY, { auto: "xk-memory" });
  assert.equal(lastSidOf("deepseek"), D);
  assert.equal(lastSidOf("hachimi"), null, "没聊过的照旧新开");
});

test("一路换人（小克→哈基米→小鱼→小克）：每次都接上她自己最近那段，并带上刚才聊的", async () => {
  reset();
  ended("xiaoke", X); ended("hachimi", H); ended("deepseek", D);
  let sw = switchTo("hachimi", X, "主人手动换了角色");
  assert.equal(sw.resume, H);
  let c = await planChat({ message: "换你来", sessionId: H });
  assert.equal(c.role, "hachimi");
  assert.deepEqual([c.carry.fromSid, c.carry.back], [X, true]);
  assert.equal(switchTo("deepseek", H, "主人手动换了角色").resume, D);
  assert.equal(switchTo("xiaoke", D, "主人手动换了角色").resume, X);
});

test("她最近那段被删了：照旧新开；从空的新对话换过去也照旧新开", () => {
  reset();
  STATE.lastByRole = { hachimi: "cccccccc-3333-4333-8333-0000000000ff" };
  assert.equal(switchTo("hachimi", X, "主人手动换了角色").resume, null);
  ended("hachimi", H);
  assert.equal(switchTo("hachimi", null, "主人手动换了角色").resume, null);
});

test("交回被替班前那段优先于她最近那段（#1）", () => {
  reset();
  const X0 = session("xiaoke", "cccccccc-3333-4333-8333-000000000005");
  ended("xiaoke", X);                                    // 最近那段是 X
  STATE.origin[H] = { from: "xiaoke", fromSid: X0, reason: "x", manual: true };
  assert.equal(switchTo("xiaoke", H, "主人手动换了角色").resume, X0);
});

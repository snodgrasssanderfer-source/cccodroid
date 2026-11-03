// 留言板（#7）：便条存取、已读、hook 注入、记忆工具里的 board_write / board_read、下班补一张
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { PATHS } from "../gw/config.mjs";
import { ENGINE_RUN, STATE } from "../gw/xk-core.mjs";
import { ROLES_DIR, ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import { list, post, quietFile, takeUnread, toId, unreadText } from "../gw/xk-board.mjs";
import { shiftEnd } from "../gw/xk-board-gw.mjs";

const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gw");
const BOARD = path.join(ROLES_DIR, ".board");
ensureRoles();
beforeEach(() => { fs.rmSync(BOARD, { recursive: true, force: true }); STATE.boardAsked = {}; for (const k of Object.keys(STATE.cooldown)) delete STATE.cooldown[k]; });

test("贴、列、已读：给大家的三个人都收得到，自己贴的自己收不到，读过一次就不再带", () => {
  post(ROLES_DIR, { from: "owner", text: "晚上记得提醒我收快递" });
  post(ROLES_DIR, { from: "xiaoke", to: "deepseek", text: "主人的周报写到第二节了" });
  assert.equal(list(ROLES_DIR).length, 2);
  assert.deepEqual(takeUnread(ROLES_DIR, "deepseek").map((n) => n.from).sort(), ["owner", "xiaoke"]);
  assert.deepEqual(takeUnread(ROLES_DIR, "deepseek"), [], "读过就不再带");
  assert.deepEqual(takeUnread(ROLES_DIR, "hachimi").map((n) => n.from), ["owner"], "给小鱼的哈基米收不到");
  assert.deepEqual(takeUnread(ROLES_DIR, "xiaoke").map((n) => n.from), ["owner"], "自己贴的自己收不到");
  assert.deepEqual(list(ROLES_DIR).find((n) => n.from === "owner").readBy.sort(), ["deepseek", "hachimi", "xiaoke"]);
});

test("收件人：名字、角色号都认，空和「大家」是给大家，认不出就说清楚", () => {
  assert.equal(toId("小鱼"), "deepseek");
  assert.equal(toId("hachimi"), "hachimi");
  assert.equal(toId(""), null);
  assert.equal(toId("大家"), null);
  assert.throws(() => toId("小明"), /不认识「小明」/);
  assert.throws(() => post(ROLES_DIR, { from: "owner", text: "  " }), /空/);
});

test("网关自己起的轮次不把便条读掉", () => {
  post(ROLES_DIR, { from: "owner", text: "早点睡" });
  const q = quietFile(ROLES_DIR, "run-q1"); fs.mkdirSync(path.dirname(q), { recursive: true }); fs.writeFileSync(q, "");
  assert.equal(unreadText(ROLES_DIR, "xiaoke", "run-q1"), "");
  assert.match(unreadText(ROLES_DIR, "xiaoke", "run-real"), /主人留给大家.*早点睡/);
});

test("hook：每条消息前带上给她的新便条，只带一次", () => {
  post(ROLES_DIR, { from: "hachimi", to: "xiaoke", text: "主人让查的航班查好了，周五早上那班最便宜" });
  const run = () => JSON.parse(execFileSync(process.execPath, [path.join(GW, "xk-hook.mjs"), "prompt", roleDir("xiaoke")], { input: JSON.stringify({ prompt: "航班" }), env: { ...process.env, CCAPP_RUN_ID: "r1" } }).toString() || "{}");
  assert.match(run().hookSpecificOutput.additionalContext, /哈基米留给小克.*周五早上那班/);
  assert.doesNotMatch(run().hookSpecificOutput?.additionalContext || "", /周五早上那班/);
});

test("记忆工具：board_write 贴上（写着是谁留的），board_read 看得到", () => {
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "board_write", arguments: { text: "主人要的歌单做了一半，还差夜跑那组", to: "小克" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "board_read", arguments: {} } },
  ];
  const r = spawnSync(process.execPath, [path.join(GW, "xk-memory-mcp.mjs"), roleDir("deepseek")], { input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n" });
  const out = r.stdout.toString().trim().split("\n").map((l) => JSON.parse(l));
  assert.match(out[1].result.content[0].text, /贴好了：- 小鱼留给小克/);
  assert.match(out[2].result.content[0].text, /歌单做了一半/);
  assert.deepEqual(list(ROLES_DIR).map((n) => [n.from, n.to]), [["deepseek", "xiaoke"]]);
});

test("替换自己的便条（#45）：没人读过就直接换；读过的人下一轮再收到更正；别人的换不了", () => {
  // 没人读过：板上只剩新的，接班的只看到对的那张
  const a = post(ROLES_DIR, { from: "xiaoke", to: "hachimi", text: "三件事等主人拍板", at: Date.UTC(2026, 10, 2, 14, 10) });
  const a2 = post(ROLES_DIR, { from: "xiaoke", to: "hachimi", text: "聊天室主人早定了，只剩世界书", replaces: a.id });
  assert.deepEqual(list(ROLES_DIR).map((n) => n.id), [a2.id]);
  assert.match(a2.text, /^（更正了 11\/2 22:10 那张）聊天室/);
  assert.deepEqual(a2.replaces.readBy, []);
  assert.deepEqual(takeUnread(ROLES_DIR, "hachimi").map((n) => n.id), [a2.id]);
  // 读过了再换：新号没人读过，她下一轮再收到
  const b = post(ROLES_DIR, { from: "xiaoke", text: "悬浮窗等云端" });
  assert.equal(takeUnread(ROLES_DIR, "deepseek").length, 1);
  const b2 = post(ROLES_DIR, { from: "xiaoke", text: "悬浮窗发版了，等真机验", replaces: b.id });
  assert.deepEqual(b2.replaces.readBy, ["deepseek"]);
  assert.deepEqual(takeUnread(ROLES_DIR, "deepseek").map((n) => n.id), [b2.id], "读过旧的：再收到更正");
  assert.deepEqual(takeUnread(ROLES_DIR, "hachimi").map((n) => n.id), [b2.id], "没读过旧的：只看到对的那张");
  assert.ok(!list(ROLES_DIR).some((n) => n.id === b.id));
  // 别人的、没有的：拒绝，板上不动
  const c = post(ROLES_DIR, { from: "deepseek", text: "日记导出做好了" });
  assert.throws(() => post(ROLES_DIR, { from: "xiaoke", text: "改一下", replaces: c.id }), /小鱼贴的，只能换自己贴的/);
  assert.throws(() => post(ROLES_DIR, { from: "xiaoke", text: "改一下", replaces: "nope123" }), /没有这张便条/);
  assert.equal(list(ROLES_DIR).length, 3);
});

test("记忆工具：board_read 带便条号，board_write 填 replaces 换掉自己那张", () => {
  const old = post(ROLES_DIR, { from: "deepseek", to: "xiaoke", text: "歌单做完了" });
  takeUnread(ROLES_DIR, "xiaoke");
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "board_read", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "board_write", arguments: { text: "歌单还差夜跑那组", to: "小克", replaces: old.id } } },
  ];
  const r = spawnSync(process.execPath, [path.join(GW, "xk-memory-mcp.mjs"), roleDir("deepseek")], { input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n" });
  const out = r.stdout.toString().trim().split("\n").map((l) => JSON.parse(l));
  assert.match(out[1].result.content[0].text, new RegExp("^\\[" + old.id + "\\] - 小鱼留给小克"));
  assert.match(out[2].result.content[0].text, /旧的那张撤下了；小克读过旧的，下一轮会再收到这张/);
  assert.deepEqual(takeUnread(ROLES_DIR, "xiaoke").map((n) => n.text), [list(ROLES_DIR)[0].text]);
  assert.match(list(ROLES_DIR)[0].text, /^（更正了 .* 那张）歌单还差夜跑那组$/);
});

// ── 下班补一张 ──
const sid = (n) => `dddddddd-7777-4777-8777-00000000000${n}`;
function session(n, role, lines) {
  const dir = path.join(PATHS.projects, "-xk-board");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid(n) + ".jsonl"), lines.map(([type, text], i) => JSON.stringify({
    type, sessionId: sid(n), cwd: fs.realpathSync(roleDir(role)), uuid: "u" + i, timestamp: new Date(Date.now() - (lines.length - i) * 1000).toISOString(),
    message: type === "user" ? { role: "user", content: text } : { role: "assistant", content: [{ type: "text", text }] },
  })).join("\n") + "\n");
}

test("下班补一张：额度用完写不了，网关从对话里摘一份，标明是摘的", () => {
  session(1, "xiaoke", [["user", "帮我把周报的第三节写完"], ["assistant", "第三节写好了，第四节还没动"]]);
  STATE.cooldown.xiaoke = { until: Date.now() + 3600e3 };
  const r = shiftEnd({ from: "xiaoke", to: "hachimi", sid: sid(1), reason: "额度用完" });
  assert.equal(r.auto.auto, true);
  assert.match(r.auto.text, /小克额度用完了，换成哈基米[\s\S]*第四节还没动/);
  assert.equal(r.auto.to, "hachimi");
});

test("下班补一张：还有额度就补跑一轮让她自己写；这一班已经写过、或主人没说过话，就不补", () => {
  const ran = [], keep = ENGINE_RUN.agy;
  ENGINE_RUN.agy = (item, x) => ran.push([item, x]);
  try {
    session(2, "hachimi", [["user", "帮我订周五的票"], ["assistant", "在比价，还差一家"]]);
    const r = shiftEnd({ from: "hachimi", to: "xiaoke", sid: sid(2), reason: "主人换了人" });
    assert.ok(r.run);
    assert.equal(ran.length, 1);
    assert.equal(ran[0][1].internal, true);
    assert.match(ran[0][0].message, /board_write[\s\S]*还差一家/);
    assert.equal(shiftEnd({ from: "hachimi", to: "xiaoke", sid: sid(2) }), null, "问过了、主人之后没再说话：不再问");
    STATE.boardAsked = {};
    post(ROLES_DIR, { from: "hachimi", to: "xiaoke", text: "票还差一家没比" });
    assert.equal(shiftEnd({ from: "hachimi", to: "xiaoke", sid: sid(2) }), null, "这一班写过了");
    assert.equal(ran.length, 1);
  } finally { ENGINE_RUN.agy = keep; }
});

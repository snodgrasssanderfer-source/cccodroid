// 小鱼：上下文到线后先问她自己（压缩还是换新，#79）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLLOVER_AT, agyTokens, agyUsage, contextRatio, rolloverAt, takeRollover } from "../gw/xk-rollover.mjs";
import { INTERNAL, STATE, carryText } from "../gw/xk-core.mjs";
import { END_HOOKS } from "../gw/queue.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";

ensureRoles();
const GW = fileURLToPath(new URL("../gw/", import.meta.url));
const cwdOf = (id) => fs.realpathSync(roleDir(id));
const end = (role, sid, f) => END_HOOKS.forEach((h) => { try { h({ id: "r-" + sid, sessionId: sid, cwd: cwdOf(role) }, f); } catch {} });
const askPath = (role) => path.join(roleDir(role), ".xk", "ask.json");
const askedPath = (role) => path.join(roleDir(role), ".xk", "asked.json");
const choicePath = (role) => path.join(path.dirname(roleDir(role)), ".ctl", role + ".json");
const clear = (role) => { STATE.rollover = {}; for (const f of [askPath(role), askedPath(role), choicePath(role)]) fs.rmSync(f, { force: true }); };
const hook = (role, sid, prompt = "接着说") => {
  const r = spawnSync(process.execPath, [path.join(GW, "xk-hook.mjs"), "prompt", roleDir(role)], {
    input: JSON.stringify({ prompt, session_id: sid }), env: { ...process.env, CCAPP_RUN_ID: "r-" + sid }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
};
const mcp = (role, name, a) => {
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: a } },
  ];
  const r = spawnSync(process.execPath, [path.join(GW, "xk-memory-mcp.mjs"), roleDir(role)], { input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", encoding: "utf8" });
  return JSON.parse(r.stdout.trim().split("\n").find((l) => JSON.parse(l).id === 2)).result;
};

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

test("换新线按角色分开：哈基米 60%，别人照 20%；她到线直接换、不问", () => {
  assert.equal(rolloverAt("hachimi"), 0.6);
  assert.equal(rolloverAt("xiaoke"), 0.2);
  assert.equal(rolloverAt("deepseek"), 0.2);
  clear("hachimi");
  end("hachimi", "s-h", { usage: { context_tokens: 590000, context_window: 1000000 } });
  assert.equal(STATE.rollover.hachimi, undefined, "五成九还没到她的线");
  end("hachimi", "s-h", { usage: { context_tokens: 610000, context_window: 1000000 } });
  assert.equal(STATE.rollover.hachimi.sid, "s-h", "过了六成才换");
  assert.ok(!STATE.rollover.hachimi.ask, "agy 压不了：不问，直接换");
  assert.ok(!fs.existsSync(askPath("hachimi")), "不给哈基米递那句话");
  clear("hachimi");
});

test("小克、小鱼到线先问：下一轮递一句，递过留记号", () => {
  clear("deepseek");
  end("deepseek", "s-d", { usage: { context_tokens: 250000, context_window: 1000000 } });
  const ro = STATE.rollover.deepseek;
  assert.equal(ro.ask, true, "先问，不直接换");
  assert.equal(ro.sid, "s-d");
  assert.equal(takeRollover("deepseek", "s-d"), null, "问之前不换");
  const a = JSON.parse(fs.readFileSync(askPath("deepseek"), "utf8"));
  assert.match(a.text, /占到 25%/);
  assert.match(a.text, /context_next/);
  // 下一轮：hook 把这句递给她，问完就删，留个记号给网关收选择
  assert.match(hook("deepseek", "s-d"), /context_next/);
  assert.ok(!fs.existsSync(askPath("deepseek")), "只递一次");
  assert.equal(JSON.parse(fs.readFileSync(askedPath("deepseek"), "utf8")).sid, "s-d");
  clear("deepseek");
});

test("她选 compact：同一段里起一个 /compact 的内部轮次，不换会话", () => {
  clear("deepseek");
  end("deepseek", "s-d", { usage: { context_tokens: 250000, context_window: 1000000 } });
  hook("deepseek", "s-d");
  const r = mcp("deepseek", "context_next", { mode: "compact", why: "同一件事" });
  assert.match(r.content[0].text, /压缩/);
  end("deepseek", "s-d", { usage: { context_tokens: 260000, context_window: 1000000 } });
  assert.equal(STATE.rollover.deepseek, undefined, "她选好了，不再挂着换新");
  assert.ok([...INTERNAL.values()].some((j) => j.kind === "compact"), "起了 /compact 内部轮次");
  assert.ok(!fs.existsSync(askedPath("deepseek")));
  clear("deepseek");
});

test("不选（或选 new）：按换新对话走，下一句就换", () => {
  for (const pick of [null, "new"]) {
    clear("deepseek");
    end("deepseek", "s-d", { usage: { context_tokens: 250000, context_window: 1000000 } });
    hook("deepseek", "s-d");
    if (pick) mcp("deepseek", "context_next", { mode: pick });
    end("deepseek", "s-d", { usage: { context_tokens: 260000, context_window: 1000000 } });
    const ro = STATE.rollover.deepseek;
    assert.equal(ro.ask, undefined, "问完了，按默认换新");
    const r = takeRollover("deepseek", "s-d");
    assert.equal(r.fromSid, "s-d");
    assert.match(r.reason, /26%/);
    clear("deepseek");
  }
});

test("压缩完下一轮还在线上：直接换新，不再问第二遍", () => {
  clear("deepseek");
  STATE.rollover = { deepseek: { sid: "s-d", pct: 0.26, afterCompact: true } };
  end("deepseek", "s-d", { usage: { context_tokens: 300000, context_window: 1000000 } });
  assert.equal(STATE.rollover.deepseek.ask, undefined, "不再问");
  assert.equal(STATE.rollover.deepseek.sid, "s-d", "直接换新");
  assert.ok(!fs.existsSync(askPath("deepseek")));
  // 压下去了：标记清掉，照常聊
  STATE.rollover = { deepseek: { sid: "s-d", pct: 0.26, afterCompact: true } };
  end("deepseek", "s-d", { usage: { context_tokens: 80000, context_window: 1000000 } });
  assert.equal(STATE.rollover.deepseek, undefined);
  clear("deepseek");
});

test("自己换自己的交接说明：带的是她自己上一段，不是别人的记忆", () => {
  const t = carryText(null, "deepseek", "deepseek", "上一段对话太长（占到 21%），自动换了新对话");
  assert.match(t, /换新对话说明/);
  assert.match(t, /21%/);
});

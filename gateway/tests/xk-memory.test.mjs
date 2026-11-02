// 小克：记忆存储、MCP 服务
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { digest, load, remember, remove, search, update } from "../gw/xk-memstore.mjs";

const tmp = (n) => { const d = path.join(process.env.CCAPP_TMP, n); fs.mkdirSync(d, { recursive: true }); return d; };

test("记住、变了标成已过去、按关键词和时间找回", () => {
  const d = tmp("mem1");
  const a = remember(d, { text: "主人在学吉他，每周练三次", kind: "fact", date: "2026-10-01" });
  const b = remember(d, { text: "主人说吉他先放一放，改学钢琴", kind: "fact", date: "2026-10-28", ends: [a.id], channel: "qq-private" });
  remember(d, { text: "我觉得钢琴更适合主人", kind: "opinion", who: "你自己", date: "2026-10-28" });
  const old = load(d).find((m) => m.id === a.id);
  assert.equal(old.past, true);
  assert.equal(old.until, "2026-10-28");
  assert.equal(b.channel, "qq-private");
  const hits = search(d, "主人的吉他还在练吗", 5, Date.parse("2026-11-01"));
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].id, b.id, "新的、还成立的排前面");
  assert.ok(hits.some((m) => m.id === a.id), "已过去的也找得到");
  assert.throws(() => remember(d, { text: "x", ends: ["nope"] }), /不存在/);
});

test("会话开始的要点：今后的计划在前，不带已过去的", () => {
  const d = tmp("mem2");
  const p = remember(d, { text: "周六一起看电影", kind: "plan", date: "2026-11-07" });
  const gone = remember(d, { text: "旧计划", kind: "plan", date: "2026-11-08" });
  update(d, gone.id, { past: true });
  const s = digest(d, 1500, Date.parse("2026-11-01T12:00:00"));
  assert.match(s.split("\n")[0], /周六一起看电影/);
  assert.doesNotMatch(s, /旧计划/);
  remove(d, p.id);
  assert.equal(load(d).length, 1);
});

test("MCP 服务：工具清单、记住、回想、出错带原因", () => {
  const d = tmp("mem3");
  fs.mkdirSync(path.join(d, ".xk/runs"), { recursive: true });
  fs.writeFileSync(path.join(d, ".xk/runs/r1.json"), JSON.stringify({ channel: "qq-group", sessionId: "s1" }));
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "remember", arguments: { text: "主人喜欢热可可", kind: "fact", date: "2026-11-01" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "recall", arguments: { query: "热可可" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "forget", arguments: { id: "nope" } } },
  ];
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../gw/xk-memory-mcp.mjs", import.meta.url)), d],
    { input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", encoding: "utf8", env: { ...process.env, CCAPP_RUN_ID: "r1" } });
  const out = Object.fromEntries(r.stdout.trim().split("\n").map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  assert.deepEqual(out[2].result.tools.map((t) => t.name), ["remember", "recall", "forget", "board_write", "board_read"]);
  assert.match(out[3].result.content[0].text, /记下了/);
  assert.match(out[4].result.content[0].text, /热可可/);
  assert.equal(out[5].result.isError, true);
  assert.match(out[5].result.content[0].text, /没有这条记忆/);
  assert.equal(load(d)[0].channel, "qq-group");
  assert.equal(load(d)[0].source.sessionId, "s1");
});

// 哈基米开不了口的两处（11-02 真机）：agy 建的 mcp_config.json 是空文件；agy models 的 stderr 日志被当成模型
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { onPublish } from "../gw/bus.mjs";
import { ensureRoles } from "../gw/xk-roles.mjs";
import { STATE } from "../gw/xk-core.mjs";
import { AGY, checkModels, parseModels, runAgy, stopAgy } from "../gw/xk-agy.mjs";
import { fakeAgy } from "./fixtures/xk-fake-agy.mjs";

const MCP = path.join(CFG.home, ".gemini", "config", "mcp_config.json");
// agy 1.4.12 真机原样：stdout 是「代号<Tab>名字」，stderr 是日志
const OUT = "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";
const ERR = "ERROR: logging before google.Init: I1102 00:28:10.762650       1 server_zerog.go:46] Initialized Android local timezone to Asia/Shanghai\nFetching available models...\n";

const fake = (js) => { fs.mkdirSync(path.dirname(AGY), { recursive: true }); fs.writeFileSync(AGY, `#!${process.execPath}\n${js}\n`); fs.chmodSync(AGY, 0o755); };
const run = (item) => new Promise((ok) => {
  const evs = [];
  const off = onPublish((e) => { if (e.runId === item.id) { evs.push(e); if (e.type === "run_end") { off(); ok(evs); } } });
  runAgy(item);
});
const okAgy = async () => { await stopAgy(); fakeAgy(AGY, { lines: [{ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "喵" } }] }); };
after(() => stopAgy());

test("mcp_config.json 是 agy 建的空文件：当空配置，补上记忆服务，这一轮照常跑", async () => {
  ensureRoles(); delete STATE.agyVerify; delete STATE.agyAuth;
  fs.mkdirSync(path.dirname(MCP), { recursive: true });
  fs.writeFileSync(MCP, "");
  await okAgy();
  const evs = await run({ id: "xc1", message: "在吗", sessionId: null });
  assert.equal(evs.find((e) => e.type === "error"), undefined, "不该报准备失败");
  assert.equal(evs.at(-1).isError, false);
  assert.ok(JSON.parse(fs.readFileSync(MCP, "utf8")).mcpServers["xk-memory"]);
});

test("mcp_config.json 里有东西但不是 JSON：不覆盖主人的文件，报错说清楚", async () => {
  fs.writeFileSync(MCP, "{ 这不是 json");
  await okAgy();
  const evs = await run({ id: "xc2", message: "在吗", sessionId: null });
  assert.match(evs.find((e) => e.type === "error").message, /读不了 .*mcp_config\.json/);
  assert.equal(fs.readFileSync(MCP, "utf8"), "{ 这不是 json");
  fs.writeFileSync(MCP, "");
});

test("模型清单：按 Tab 分代号和名字；日志行不算模型", () => {
  const list = parseModels(OUT);
  assert.deepEqual(list.map((m) => m.id), ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "claude-sonnet-4-6", "gpt-oss-120b-medium"]);
  assert.equal(list[0].label, "Gemini 3.8 Flash (High)");
  assert.equal(parseModels(ERR).length, 0, "日志、提示行都不是模型");
});

test("agy models 真跑一遍（stdout 清单 + stderr 日志）：只列四个模型，算登录了", async () => {
  fake(`process.stdout.write(${JSON.stringify(OUT)});process.stderr.write(${JSON.stringify(ERR)});`);
  const m = await checkModels(true);
  assert.equal(m.auth, true);
  assert.deepEqual(m.list.map((x) => x.id), ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "claude-sonnet-4-6", "gpt-oss-120b-medium"]);
  assert.ok(!m.list.some((x) => /ERROR|Fetching/.test(x.id + x.label)));
});

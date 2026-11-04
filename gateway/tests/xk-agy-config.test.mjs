// 哈基米开不了口的两处（11-02 真机）：agy 建的 mcp_config.json 是空文件；agy models 的 stderr 日志被当成模型
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { onPublish } from "../gw/bus.mjs";
import { ensureRoles } from "../gw/xk-roles.mjs";
import { STATE } from "../gw/xk-core.mjs";
import { AGY, GO_EXEC, agyEnv, checkModels, ensureMcp, parseModels, runAgy, stopAgy } from "../gw/xk-agy.mjs";
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

test("MCP 配置两个位置都写（命令行版读 antigravity-cli/，#101）：记忆服务补上，别的条目和字段原样留着", async () => {
  const CLI = path.join(CFG.home, ".gemini", "antigravity-cli", "mcp_config.json");
  fs.writeFileSync(MCP, JSON.stringify({ mcpServers: { other: { command: "x" } }, keep: 1 }));
  fs.rmSync(CLI, { force: true });
  await okAgy();
  await run({ id: "xc3", message: "在吗", sessionId: null });
  const a = JSON.parse(fs.readFileSync(MCP, "utf8")), b = JSON.parse(fs.readFileSync(CLI, "utf8"));
  assert.ok(a.mcpServers["xk-memory"] && b.mcpServers["xk-memory"]);
  assert.deepEqual(a.mcpServers.other, { command: "x" }); assert.equal(a.keep, 1);
  assert.deepEqual(b.mcpServers["xk-memory"], a.mcpServers["xk-memory"]);
  fs.writeFileSync(MCP, "");
});

test("没 SUCCESS 但话已经出来了（收尾报「流中断」，#101）：话记进会话，错误照样报", async () => {
  await stopAgy();
  fakeAgy(AGY, { lines: [
    { event: "step_update", step_update: { step_type: "agent_response", text_delta: "我觉得先试第二种。" } },
    { event: "result", result: { conversation_id: "c9", status: "ERROR", error: "The stream was interrupted. Please continue the task you were working on." } },
  ] });
  const evs = await run({ id: "xc4", message: "你说呢", sessionId: null });
  assert.match(evs.find((e) => e.type === "error").message, /stream was interrupted/);
  assert.equal(evs.at(-1).isError, true);
  const sid = evs.find((e) => e.type === "init").sessionId;
  const f = fs.readdirSync(PATHS.projects, { recursive: true }).find((x) => String(x).endsWith(sid + ".jsonl"));
  assert.match(fs.readFileSync(path.join(PATHS.projects, String(f)), "utf8"), /我觉得先试第二种。/);
});

test("安卓上 agy（Go）起不了应用目录里的程序（#101）：MCP 让 linker64 去加载 node，shell 换成 /system/bin/sh", () => {
  GO_EXEC.android = true;
  try {
    fs.writeFileSync(MCP, "");
    ensureMcp();
    const m = JSON.parse(fs.readFileSync(MCP, "utf8")).mcpServers["xk-memory"];
    assert.equal(m.command, "/system/bin/linker64");
    assert.equal(m.args[0], process.execPath, "linker64 后面跟真的 node，再跟脚本和参数");
    assert.match(m.args[1], /xk-memory-mcp\.mjs$/);
    const env = agyEnv();
    assert.equal(env.SHELL, "/system/bin/sh");
    const dir = env.PATH.split(":")[0];
    for (const n of ["bash", "sh"]) assert.equal(fs.readlinkSync(path.join(dir, n)), "/system/bin/sh", "PATH 最前面的 bash / sh 指向系统的 sh");
  } finally { GO_EXEC.android = false; fs.writeFileSync(MCP, ""); }
  ensureMcp();
  assert.equal(JSON.parse(fs.readFileSync(MCP, "utf8")).mcpServers["xk-memory"].command, process.execPath, "不是安卓照旧直接起 node");
  assert.equal(agyEnv().SHELL, process.env.SHELL);
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

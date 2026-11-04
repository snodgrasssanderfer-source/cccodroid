// 哈基米在终端里调工具（#101）：xk-tool.mjs 照她的 mcp_config.json 起真的记忆服务，记得进、查得到；图片存文件；名字或参数不对报清楚
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gw");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xk-tool-"));
const home = path.join(tmp, "home"), role = path.join(tmp, "role");
fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
fs.mkdirSync(path.join(role, "memory"), { recursive: true });
const dev = path.join(tmp, "dev.mjs");
fs.writeFileSync(dev, `import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
  else if (m.method === "tools/list") send({ id: m.id, result: { tools: [{ name: "screenshot", inputSchema: { type: "object" } }] } });
  else if (m.method === "tools/call") send({ id: m.id, result: { content: [{ type: "image", data: Buffer.from("jpg").toString("base64"), mimeType: "image/jpeg" }] } }); });`);
fs.writeFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify({ mcpServers: {
  "xk-memory": { command: process.execPath, args: [path.join(GW, "xk-memory-mcp.mjs"), role] },
  device: { command: process.execPath, args: [dev] },
} }));
const tool = (...a) => spawnSync(process.execPath, [path.join(GW, "xk-tool.mjs"), ...a], { cwd: role, env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 60000 });

test("不带参数：列出记忆服务和设备服务的工具和参数", () => {
  const r = tool();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /【xk-memory】[\s\S]*remember：[\s\S]*query（必填）/);
  assert.match(r.stdout, /【device】[\s\S]*screenshot/);
});

test("remember 记得进、recall 查得到（走的是真的记忆服务，带日期和来源）", () => {
  assert.equal(tool("remember", JSON.stringify({ text: "主人在玩西奥小镇", kind: "fact", date: "2026-11-04" })).status, 0);
  const r = tool("recall", '{"query":"西奥小镇"}');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2026-11-04 .*主人在玩西奥小镇/);
});

test("截图：图存成文件、打印路径", () => {
  const r = tool("screenshot");
  const f = /图片：(\S+)（/.exec(r.stdout)?.[1];
  assert.ok(f && fs.readFileSync(f, "utf8") === "jpg", r.stdout);
});

test("没有这个工具、参数不是 JSON：报清楚，退出码非 0", () => {
  const a = tool("nosuch");
  assert.notEqual(a.status, 0); assert.match(a.stderr, /没有叫 nosuch 的工具/);
  const b = tool("recall", "不是json");
  assert.notEqual(b.status, 0); assert.match(b.stderr, /参数要是 JSON/);
});

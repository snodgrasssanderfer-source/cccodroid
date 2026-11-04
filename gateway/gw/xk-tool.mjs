#!/usr/bin/env node
// 哈基米在终端里调工具用（#101）：agy 1.4.12 在手机上一个 MCP 服务都起不来（每次启动都报认不出登录用户，
// MCP 要过的那道管控多半因此没过），她又能跑终端命令，所以由这里替她起同一个 MCP 服务、调一次、把结果打出来。
// 服务清单就读网关替她维护的 ~/.gemini/config/mcp_config.json（xk-agy.mjs 的 ensureMcp），不另存一份。
//   node xk-tool.mjs                      列出全部工具和参数
//   node xk-tool.mjs <工具名> ['<JSON>']   调一个工具；图片存成文件，打印路径
// 独立脚本：不 import 网关的模块（那些一 import 就起服务）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CONF = path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
const TIMEOUT_MS = 120_000;

function servers() {
  const t = fs.existsSync(CONF) ? fs.readFileSync(CONF, "utf8") : "";
  return Object.entries((t.trim() ? JSON.parse(t) : {}).mcpServers || {}).filter(([, s]) => s.command);
}

/** 起一个 MCP 服务，握手，回一个 ask(method, params) 和 close() */
function connect(name, s) {
  const child = spawn(s.command, s.args || [], { env: { ...process.env, ...(s.env || {}) }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", err = "", seq = 0;
  const waiting = new Map();
  const fail = (why) => { for (const w of waiting.values()) w.no(new Error(`${name}：${why}${err.trim() ? "（" + err.trim().split("\n").slice(-3).join(" ") + "）" : ""}`)); waiting.clear(); };
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const w = waiting.get(m.id);
      if (!w) continue;
      waiting.delete(m.id);
      m.error ? w.no(new Error(`${name}：${m.error.message || JSON.stringify(m.error)}`)) : w.ok(m.result);
    }
  });
  child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
  child.on("error", (e) => fail("起不来：" + e.message));
  child.on("exit", (code) => fail(`退出了（${code}）`));
  const ask = (method, params) => new Promise((ok, no) => {
    const id = ++seq;
    const t = setTimeout(() => { waiting.delete(id); no(new Error(`${name}：${method} ${TIMEOUT_MS / 1000} 秒没回`)); }, TIMEOUT_MS);
    waiting.set(id, { ok: (r) => { clearTimeout(t); ok(r); }, no: (e) => { clearTimeout(t); no(e); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const ready = ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "xk-tool", version: "1" } })
    .then(() => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"));
  return { ask: (m, p) => ready.then(() => ask(m, p)), close: () => child.kill() };
}

function brief(schema) {
  const props = schema?.properties || {}, req = new Set(schema?.required || []);
  return Object.entries(props).map(([k, v]) => `    ${k}${req.has(k) ? "（必填）" : ""}：${v.type || ""}${v.description ? " — " + v.description : ""}`).join("\n");
}

async function main() {
  const [tool, argText] = process.argv.slice(2);
  const list = servers();
  if (!list.length) throw new Error(`${CONF} 里没有工具服务`);
  for (const [name, s] of list) {
    const c = connect(name, s);
    try {
      const { tools = [] } = await c.ask("tools/list", {});
      if (!tool) {
        console.log(`【${name}】`);
        for (const t of tools) console.log(`  ${t.name}：${(t.description || "").split("\n")[0]}${brief(t.inputSchema) ? "\n" + brief(t.inputSchema) : ""}`);
        continue;
      }
      if (!tools.some((t) => t.name === tool)) continue;
      let args = {};
      try { if (argText) args = JSON.parse(argText); } catch (e) { throw new Error(`参数要是 JSON（比如 '{"query":"游戏"}'）：${e.message}`); }
      const r = await c.ask("tools/call", { name: tool, arguments: args });
      for (const x of r.content || []) {
        if (x.type === "text") console.log(x.text);
        else if (x.type === "image") {
          const dir = path.join(process.cwd(), ".xk-shots");
          fs.mkdirSync(dir, { recursive: true });
          const f = path.join(dir, `${Date.now()}.${(x.mimeType || "image/png").split("/")[1]}`);
          fs.writeFileSync(f, Buffer.from(x.data, "base64"));
          console.log(`图片：${f}（用读文件看）`);
        } else console.log(JSON.stringify(x));
      }
      process.exitCode = r.isError ? 1 : 0;
      return;
    } finally { c.close(); }
  }
  if (tool) throw new Error(`没有叫 ${tool} 的工具：不带参数运行一次看全部工具`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });

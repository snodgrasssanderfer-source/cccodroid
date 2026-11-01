// 记忆工具的 MCP 服务（stdio）：node xk-memory-mcp.mjs <角色目录>。由角色项目的 .mcp.json 让 Claude Code 拉起，
// 所以它只能碰自己这个角色的记忆。渠道（App / QQ 私聊 / QQ 群）由网关按 run 号写在 .xk/runs/ 里，没有就是 App。
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { KINDS, line, remember, remove, search, today } from "./xk-memstore.mjs";

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { process.stderr.write("用法：xk-memory-mcp.mjs <角色目录>\n"); process.exit(2); }

function runInfo() {
  const run = process.env.CCAPP_RUN_ID;
  const f = run && path.join(dir, ".xk", "runs", run + ".json");
  try { return f ? JSON.parse(fs.readFileSync(f, "utf8")) : {}; } catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}

const TOOLS = [
  { name: "remember", description: "记下一条以后用得上的事：主人说的事实、发生的事、计划，或你自己的看法。日期要写成具体日期（把昨天、下周换算好）。事情变了：记新的，并把旧记忆的 id 放进 ends，旧的会标成已过去留着。",
    inputSchema: { type: "object", required: ["text", "kind", "date"], properties: {
      text: { type: "string", description: "一句话写清是谁、什么事，比如「主人说下周六（2026-11-07）要去爬山」" },
      kind: { type: "string", enum: KINDS, description: "fact 事实 / event 发生的事 / plan 计划 / opinion 你自己的看法" },
      date: { type: "string", description: "这件事发生或成立的日期，YYYY-MM-DD" },
      who: { type: "string", description: "跟谁有关：主人、你自己（你的看法写「你自己」），或别人的名字。默认主人" },
      until: { type: "string", description: "已知到哪天为止，YYYY-MM-DD，可不填" },
      ends: { type: "array", items: { type: "string" }, description: "因为这条而不再成立的旧记忆 id" } } } },
  { name: "recall", description: "按关键词查自己的记忆（新的、相关的排前面，已过去的也查得到）。自动附上的记忆不全，主人问到具体的事而那里没有时用它，可以换几种说法查。",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, limit: { type: "number", description: "最多几条，默认 8" } } } },
  { name: "forget", description: "删掉一条记忆。只在主人要你忘掉、或这条本来就记错了时用；事情只是变了的话用 remember 的 ends。",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
];

function call(name, a) {
  if (name === "remember") {
    const info = runInfo();
    const m = remember(dir, { ...a, channel: info.channel || "app", source: { runId: process.env.CCAPP_RUN_ID || null, sessionId: info.sessionId || null } });
    return `记下了：${line(m)}`;
  }
  if (name === "recall") {
    const hits = search(dir, a.query, Number(a.limit) || 8);
    return hits.length ? `今天是 ${today()}。\n` + hits.map(line).join("\n") : "没有找到相关的记忆。";
  }
  if (name === "forget") return `删掉了：${line(remove(dir, String(a.id || "")))}`;
  throw new Error("没有这个工具：" + name);
}

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  if (!l.trim()) return;
  let m;
  try { m = JSON.parse(l); } catch (e) { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: e.message } }); }
  const ok = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") return ok({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "xk-memory", version: "1" } });
  if (m.method === "tools/list") return ok({ tools: TOOLS });
  if (m.method === "tools/call") {
    try { return ok({ content: [{ type: "text", text: call(m.params.name, m.params.arguments || {}) }] }); }
    catch (e) { return ok({ content: [{ type: "text", text: "出错了：" + e.message }], isError: true }); }
  }
  if (m.method === "ping") return ok({});
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "不支持：" + m.method } });
});

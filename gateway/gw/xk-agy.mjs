// 哈基米：经 Antigravity CLI（agy）用主人 Google 账号的 Gemini。
// agy 没有整体替换系统提示的选项（只有 ACP 模式下的追加），所以人设和世界书写进哈基米目录的 AGENTS.md（agy 会读）；
// post_history、相关记忆、接班说明在每条消息前作为单独一段发过去（agy 的 hook 没有「每条消息前」这个事件）。
// 会话记录按 Claude Code 的格式另写一份，会话列表、历史、接班摘要、日记都照常能用。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG, PATHS, PREFIX, log } from "./config.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { publish } from "./bus.mjs";
import { END_HOOKS } from "./queue.mjs";
import { projectSlug } from "./projects.mjs";
import { rememberSession } from "./runs.mjs";
import { WORLDBOOK, postHistoryFile, roleDir } from "./xk-roles.mjs";
import { line, search } from "./xk-memstore.mjs";
import { ENGINES, ENGINE_RUN, STATE, addRoute, httpError, saveState } from "./xk-core.mjs";

const DIR = roleDir("hachimi");
// 放在上游加进 PATH 的 ~/.cccodroid/bin：主人在应用内终端里直接敲 agy 登录
export const AGY = path.join(CFG.home, ".cccodroid", "bin", "agy");
const MANIFESTS = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/";   // 官方 install.sh 里的地址
const MEM_MCP = fileURLToPath(new URL("./xk-memory-mcp.mjs", import.meta.url));
STATE.agyConv ||= {};   // 我们的会话号 → agy 的 conversation_id

ENGINES.agy = () => fs.existsSync(AGY) && STATE.agyAuth !== false;

const platform = () => (process.platform === "android" ? "android_arm64" : `linux_${process.arch === "arm64" ? "arm64" : "amd64"}`);

/** 从官方渠道装 agy：取平台清单，下载，核对清单里的 sha512，解出 antigravity。用 curl：它认代理设置，Node 的 fetch 不认 */
// 和上游组件下载一样用工具包里的 curl / tar
const bin = (n) => (PREFIX ? path.join(PREFIX, "bin", n) : n);
const curl = (args) => new Promise((ok, no) => execFile(bin("curl"), ["-fsSL", "--retry", "2", ...args], { maxBuffer: 1 << 20, encoding: "utf8" },
  (e, out, err) => (e ? no(new Error(`curl ${args.at(-1)}：${(err || e.message).trim()}`)) : ok(out))));
export async function install(manifestBase = MANIFESTS) {
  const mf = JSON.parse(await curl([manifestBase + platform() + ".json"]));
  if (!mf.url || !mf.sha512) throw new Error("agy 发布清单缺 url 或 sha512：" + JSON.stringify(mf).slice(0, 200));
  const tmp = fs.mkdtempSync(path.join(CFG.home, ".agy-dl-"));
  try {
    const tgz = path.join(tmp, "agy.tar.gz");
    await curl(["-o", tgz, mf.url]);
    const got = crypto.createHash("sha512").update(fs.readFileSync(tgz)).digest("hex");
    if (got !== mf.sha512) throw new Error("agy 安装包的 sha512 和官方清单对不上，没有安装");
    execFileSync(bin("tar"), ["-xzf", tgz, "-C", tmp, "antigravity"]);
    fs.mkdirSync(path.dirname(AGY), { recursive: true });
    fs.renameSync(path.join(tmp, "antigravity"), AGY);
    fs.chmodSync(AGY, 0o755);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  delete STATE.agyAuth; saveState();
  return { version: mf.version, platform: platform() };
}

const version = () => { try { return execFileSync(AGY, ["--version"], { encoding: "utf8", timeout: 20000, env: agyEnv() }).trim(); } catch (e) { return "运行失败：" + (e.stderr || e.message).toString().slice(0, 300); } };
const agyEnv = () => ({ ...process.env, HOME: CFG.home });

/** 人设 + 世界书 → hachimi/AGENTS.md（每轮前重写，导入后立刻生效） */
function writeAgents() {
  const agent = path.join(DIR, ".claude", "agents", "hachimi.md");
  const persona = fs.existsSync(agent) ? fs.readFileSync(agent, "utf8").replace(/^---[\s\S]*?---\n/, "") : "";
  const wb = fs.existsSync(WORLDBOOK) ? fs.readFileSync(WORLDBOOK, "utf8") : "";
  const mech = fs.existsSync(path.join(DIR, "CLAUDE.md")) ? fs.readFileSync(path.join(DIR, "CLAUDE.md"), "utf8") : "";
  fs.writeFileSync(path.join(DIR, "AGENTS.md"), [persona.trim(), wb.trim(), mech.trim()].filter(Boolean).join("\n\n---\n\n") + "\n");
}

/** 记忆工具：登记到 agy 的全局 MCP 配置（~/.gemini/config/mcp_config.json），只指向哈基米的目录 */
function ensureMcp() {
  const f = path.join(CFG.home, ".gemini", "config", "mcp_config.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw new Error(`读不了 ${f}：${e.message}`); }
  cfg.mcpServers ||= {};
  const want = { command: process.execPath, args: [MEM_MCP, DIR] };
  if (JSON.stringify(cfg.mcpServers["xk-memory"]) === JSON.stringify(want)) return;
  cfg.mcpServers["xk-memory"] = want;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 1));
}

// ── 会话记录（Claude Code 的格式，上游的会话列表 / 历史接口直接认） ──
function sessionFile(sid) {
  const d = path.join(PATHS.projects, projectSlug(fs.realpathSync(DIR)));
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, sid + ".jsonl");
}
function appendTurn(sid, role, text, parent) {
  const uuid = crypto.randomUUID();
  fs.appendFileSync(sessionFile(sid), JSON.stringify({ type: role, sessionId: sid, cwd: fs.realpathSync(DIR), timestamp: new Date().toISOString(), uuid, parentUuid: parent || null,
    message: role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }], model: "antigravity" } }) + "\n");
  return uuid;
}

/** 跑一轮。item：{ id, message, sessionId? }；extra：{ internal, carry } */
export function runAgy(item, extra = {}) {
  const runId = item.id, startedAt = Date.now();
  let sid = item.sessionId || null;
  const isNew = !sid;
  if (isNew) sid = crypto.randomUUID();
  const emit = (ev) => publish({ ...ev, runId });
  emit({ type: "run_start", text: item.message, sessionId: isNew ? null : sid, startedAt, ...(extra.internal ? { auto: "xk-agy" } : {}) });
  const ctx = [];
  const hits = search(DIR, item.message, 6);
  if (hits.length) ctx.push("可能和这条消息有关的记忆（自动按关键词挑的，可能不准）：\n" + hits.map(line).join("\n"));
  if (extra.carry) ctx.push(extra.carry);
  if (fs.existsSync(postHistoryFile("hachimi"))) ctx.push(fs.readFileSync(postHistoryFile("hachimi"), "utf8").trim());
  const content = [...(ctx.length ? [{ type: "text", text: "（给你自己看的背景，不是主人说的话）\n" + ctx.join("\n\n") }] : []), { type: "text", text: item.message }];
  let parent = null;
  const finish = (fields) => {
    const run = { id: runId, text: item.message, sessionId: sid, cwd: DIR, startedAt, provider: "agy", ...(extra.internal ? { auto: "xk-agy" } : {}) };
    for (const h of END_HOOKS) { try { h(run, fields); } catch (e) { log("结束钩子出错: " + e.message); } }
    publish({ type: "run_end", runId, sessionId: sid, aborted: false, durationMs: Date.now() - startedAt, ...(extra.internal ? { auto: "xk-agy" } : {}), ...fields });
  };
  try {
    writeAgents(); ensureMcp();
    if (!extra.internal) parent = appendTurn(sid, "user", item.message, null);
  } catch (e) { emit({ type: "error", message: "哈基米准备失败：" + e.message }); finish({ failed: true }); return; }
  if (isNew) { rememberSession(sid); emit({ type: "init", sessionId: sid, model: "antigravity" }); }
  // 主人本人在 App 里发的才会走到这里（QQ 接入时再按渠道收紧）：没法把 agy 的权限请求转给界面，所以不逐条确认
  // stream-json 输入时不能再给 -p（它会把下一个参数当成提示词）
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions"];
  if (STATE.agyConv[sid]) args.push("--conversation", STATE.agyConv[sid]);
  const child = spawn(AGY, args, { cwd: DIR, env: { ...agyEnv(), CCAPP_RUN_ID: runId }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify({ event: "user", message: { content } }) + "\n");
  let buf = "", stderr = "", text = "", result = null;
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      let raw; try { raw = JSON.parse(l); } catch { continue; }
      // 实测 1.4.12：内容嵌在以事件名命名的键里，{"event":"result","result":{...}}
      const ev = raw[raw.event] && typeof raw[raw.event] === "object" ? raw[raw.event] : raw;
      if (raw.event === "step_update") {
        if (ev.conversation_id && !STATE.agyConv[sid]) { STATE.agyConv[sid] = ev.conversation_id; saveState(); }
        if (ev.step_type === "agent_response" && ev.text_delta) { text += ev.text_delta; emit({ type: "delta", text: ev.text_delta }); }
        if (ev.tool_info && ev.state === "DONE") {
          const id = "agy-" + ev.step_index;
          emit({ type: "tool_use", id, name: ev.tool_info.name, input: ev.tool_info.parameters || {} });
          emit({ type: "tool_result", id, ok: !ev.tool_info.error, text: String(ev.tool_info.error ? ev.tool_info.error.message : ev.tool_info.output || "").slice(0, 20000) });
        }
      } else if (raw.event === "result") result = ev;
    }
  });
  child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  child.on("error", (e) => { emit({ type: "error", message: "agy 起不来：" + e.message }); finish({ failed: true }); });
  child.on("close", (code) => {
    if (result?.conversation_id && STATE.agyConv[sid] !== result.conversation_id) { STATE.agyConv[sid] = result.conversation_id; saveState(); }
    const ok = result && result.status === "SUCCESS";
    const reply = (result && result.response) || text;
    if (ok && reply.trim() && !extra.internal) appendTurn(sid, "assistant", reply.trim(), parent);
    if (!ok) {
      const why = (result && result.error) || stderr.trim().split("\n").slice(-3).join(" ") || `退出码 ${code}`;
      if (/authenticat|login|sign in|未登录/i.test(why)) { STATE.agyAuth = false; saveState(); }
      emit({ type: "error", message: "哈基米（agy）：" + why });
    } else if (STATE.agyAuth === false) { delete STATE.agyAuth; saveState(); }
    finish({ isError: !ok, subtype: result ? String(result.status) : "no_result", ...(extra.internal ? { finalText: reply } : {}) });
  });
}
ENGINE_RUN.agy = runAgy;

// ── 界面：装、看状态 ──
addRoute(async (req, res, u, p) => {
  if (p === "/api/xk/agy" && req.method === "GET")
    return sendJson(res, 200, { installed: fs.existsSync(AGY), path: AGY, version: fs.existsSync(AGY) ? version() : null, auth: STATE.agyAuth !== false, platform: platform() });
  if (p === "/api/xk/agy/install" && req.method === "POST") {
    try { return sendJson(res, 200, { ok: true, ...(await install()) }); }
    catch (e) { throw httpError(502, "装 agy 失败：" + e.message); }
  }
  return NEXT;
});

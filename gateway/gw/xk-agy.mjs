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
import { StringDecoder } from "node:string_decoder";
import { ptyCommand, termEnv } from "./terminal.mjs";
import { END_HOOKS } from "./queue.mjs";
import { projectSlug } from "./projects.mjs";
import { rememberSession } from "./runs.mjs";
import { WORLDBOOK, postHistoryFile, roleDir } from "./xk-roles.mjs";
import { line, search } from "./xk-memstore.mjs";
import { ENGINES, ENGINE_RUN, STATE, addRoute, httpError, json, saveState } from "./xk-core.mjs";

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

// 同步跑 agy --version 会卡住网关：按文件修改时间记一份，换了二进制才重跑（登录时界面每 1.5 秒问一次状态）
let VER = { mt: 0, v: null };
const version = () => {
  let mt = 0; try { mt = fs.statSync(AGY).mtimeMs; } catch {}
  if (VER.mt === mt && VER.v) return VER.v;
  try { VER = { mt, v: execFileSync(AGY, ["--version"], { encoding: "utf8", timeout: 20000, env: agyEnv() }).trim() }; return VER.v; }
  catch (e) { return "运行失败：" + (e.stderr || e.message).toString().slice(0, 300); }
};
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
  if (STATE.agyModel) args.push("--model", STATE.agyModel);   // 主人在哈基米的卡片里选的 Gemini 模型
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

// ── 登录：照旧版小克登录 Claude 的做法，在伪终端里跑 agy（没登录时它先弹登录菜单），选 Google 登录，
//    把它打出来的登录链接交给界面，主人在浏览器里授权后把授权码贴回来。网关只搬字节，凭据由 agy 自己存，我们不读不存。
//    手机上没法替它自动打开浏览器，所以以前在终端里敲 agy 会停在那里不动。
const LOGIN = { child: null, raw: "", stage: "idle", url: null, error: "", choseAt: 0, codeAt: 0, timer: null };
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>]|\r/g;
const plain = (s) => s.replace(ANSI, "");
/** 登录链接：先找终端超链接（OSC 8，整条不折行），没有再把折到下一行的那几截拼回去 */
export function agyLoginUrl(raw) {
  const osc = /\x1b\]8;[^;]*;(https:\/\/accounts\.google\.com\/[^\x07\x1b]+)(?:\x07|\x1b\\)/.exec(raw);
  if (osc) return osc[1];
  const lines = plain(raw).split("\n");
  const i = lines.findIndex((l) => l.includes("https://accounts.google.com/"));
  if (i < 0) return null;
  let url = lines[i].slice(lines[i].indexOf("https://")).trim();
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (!t || !/^[A-Za-z0-9%._~:/?#[\]@!$&'()*+,;=-]+$/.test(t)) break;
    url += t;
  }
  return /[?&]state=/.test(url) ? url : null;   // 没拼完（还在往外打）就先不给
}
/** agy models：登录了就列出能用的模型，没登录只回一句「Please sign in」；不花额度，拿来当登录状态 */
let MODELS = { at: 0, auth: null, list: [] };
function checkModels(force) {
  if (!force && Date.now() - MODELS.at < 60000) return Promise.resolve(MODELS);
  return new Promise((ok) => execFile(AGY, ["models"], { encoding: "utf8", timeout: 45000, env: agyEnv(), maxBuffer: 1 << 20 }, (e, out, err) => {
    const text = plain(String(out || "") + "\n" + String(err || ""));
    if (/sign in|not signed in|log ?in/i.test(text)) MODELS = { at: Date.now(), auth: false, list: [] };
    else if (e && !text.trim()) MODELS = { at: Date.now(), auth: null, list: [], error: e.message };
    else {
      const list = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^fetching|^available|^[-─=]+$/i.test(l))
        .map((l) => ({ id: l.replace(/^[-*•>\s]+/, "").split(/\s+/)[0], label: l.replace(/^[-*•>\s]+/, "") })).filter((m) => /^[A-Za-z0-9._:/-]+$/.test(m.id));
      MODELS = { at: Date.now(), auth: true, list };
    }
    if (MODELS.auth === false) { STATE.agyAuth = false; saveState(); } else if (MODELS.auth && STATE.agyAuth === false) { delete STATE.agyAuth; saveState(); }
    ok(MODELS);
  }));
}
const loginState = () => ({ stage: LOGIN.stage, url: LOGIN.url, error: LOGIN.error, tail: plain(LOGIN.raw).split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-12).join("\n") });
function endLogin(stage, error) {
  clearInterval(LOGIN.timer); LOGIN.timer = null;
  if (LOGIN.child) { try { process.kill(-LOGIN.child.pid, "SIGKILL"); } catch { try { LOGIN.child.kill("SIGKILL"); } catch {} } }
  LOGIN.child = null; LOGIN.stage = stage; LOGIN.error = error || "";
  publish({ type: "xk", op: "agy_login", ...loginState() });
}
async function startLogin() {
  if (!fs.existsSync(AGY)) throw httpError(409, "agy 还没装");
  if (LOGIN.child) return loginState();
  if ((await checkModels(true)).auth) { LOGIN.stage = "done"; LOGIN.url = null; return loginState(); }
  const pc = ptyCommand();
  if (!pc) throw httpError(500, "没有伪终端（ptyhost / python3），登录界面起不来");
  Object.assign(LOGIN, { raw: "", stage: "starting", url: null, error: "", choseAt: 0, codeAt: 0 });
  // 500 列：链接尽量别折行；折了 agyLoginUrl 也会拼回去
  const child = spawn(pc[0], [...pc.slice(1), "50", "500", AGY], { cwd: DIR, env: { ...termEnv(), HOME: CFG.home }, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  LOGIN.child = child;
  const dec = new StringDecoder("utf8");
  child.stdout.on("data", (d) => {
    LOGIN.raw += dec.write(d);
    if (LOGIN.raw.length > 200000) LOGIN.raw = LOGIN.raw.slice(-200000);
    const t = plain(LOGIN.raw);
    // 登录方式菜单：第一项就是 Google 登录，回车选它
    if (!LOGIN.choseAt && /Select login method/i.test(t)) { LOGIN.choseAt = Date.now(); setTimeout(() => { try { child.stdin.write("\r"); } catch {} }, 300); LOGIN.stage = "choosing"; }
    if (!LOGIN.url) { const url = agyLoginUrl(LOGIN.raw); if (url) { LOGIN.url = url; LOGIN.stage = "url"; publish({ type: "xk", op: "agy_login", ...loginState() }); } }
    if (LOGIN.codeAt && /sign-in failed|invalid|error/i.test(t.slice(t.lastIndexOf("authorization code")))) {
      const why = t.slice(t.lastIndexOf("authorization code")).split("\n").find((l) => /failed|invalid|error/i.test(l)) || "";
      endLogin("failed", "授权码没被接受：" + why.trim());
    }
  });
  child.stderr.on("data", (d) => { LOGIN.raw += d; });
  child.stdin.on("error", () => {});
  child.stdio[3]?.on("error", () => {});
  child.on("close", () => { if (LOGIN.child === child) { LOGIN.child = null; if (LOGIN.stage !== "done") checkModels(true).then((m) => endLogin(m.auth ? "done" : "failed", m.auth ? "" : "agy 退出了，还没登录上")); } });
  // 一直等不到链接（网络、地区）：别永远转圈
  setTimeout(() => { if (LOGIN.child === child && !LOGIN.url) endLogin("failed", "等了 60 秒没拿到登录链接：" + loginState().tail.split("\n").slice(-3).join(" ")); }, 60000).unref();
  return loginState();
}
function submitCode(code) {
  if (!LOGIN.child || !LOGIN.url) throw httpError(409, "登录还没开始，或者已经结束了");
  code = String(code || "").trim();
  if (!code) throw httpError(400, "授权码是空的");
  // 码和回车分两次写：一口气写进去，终端界面会当成粘贴，不提交（旧版登录 Claude 时踩过）
  LOGIN.child.stdin.write(code);
  setTimeout(() => { try { LOGIN.child?.stdin.write("\r"); } catch {} }, 250);
  LOGIN.codeAt = Date.now(); LOGIN.stage = "verifying";
  // 登录成功后 agy 会进它自己的聊天界面，看输出认不准：每 3 秒问一次 agy models，能列出模型就算登上了
  clearInterval(LOGIN.timer);
  LOGIN.timer = setInterval(async () => {
    const m = await checkModels(true);
    if (m.auth) endLogin("done");
    else if (Date.now() - LOGIN.codeAt > 90000) endLogin("failed", "90 秒还没登上：" + loginState().tail.split("\n").slice(-3).join(" "));
  }, 3000);
  return loginState();
}

// ── 界面：装、看状态、登录、选模型 ──
addRoute(async (req, res, u, p) => {
  if (p === "/api/xk/agy" && req.method === "GET") {
    const installed = fs.existsSync(AGY), m = installed ? await checkModels(u.searchParams.has("fresh")) : { auth: null, list: [] };
    return sendJson(res, 200, { installed, path: AGY, version: installed ? version() : null, auth: m.auth, models: m.list, model: STATE.agyModel || "", platform: platform(), login: loginState() });
  }
  if (p === "/api/xk/agy/install" && req.method === "POST") {
    try { return sendJson(res, 200, { ok: true, ...(await install()) }); }
    catch (e) { throw httpError(502, "装 agy 失败：" + e.message); }
  }
  if (p === "/api/xk/agy/login" && req.method === "GET") return sendJson(res, 200, loginState());
  if (p === "/api/xk/agy/login" && req.method === "POST") return sendJson(res, 200, await startLogin());
  if (p === "/api/xk/agy/login/code" && req.method === "POST") return sendJson(res, 200, submitCode((await json(req)).code));
  if (p === "/api/xk/agy/login/cancel" && req.method === "POST") { if (LOGIN.child) endLogin("idle"); return sendJson(res, 200, loginState()); }
  if (p === "/api/xk/agy/model" && req.method === "PUT") {
    const m = String((await json(req)).model || "").trim();
    if (m && !/^[A-Za-z0-9._:/-]{1,120}$/.test(m)) throw httpError(400, "模型名不对：" + m);
    if (m) STATE.agyModel = m; else delete STATE.agyModel;
    saveState();
    return sendJson(res, 200, { ok: true, model: STATE.agyModel || "" });
  }
  return NEXT;
});

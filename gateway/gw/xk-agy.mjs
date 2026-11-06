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
import { injectFor } from "./xk-memstore.mjs";
import { unreadText } from "./xk-board.mjs";
import { ENGINES, ENGINE_ASK, ENGINE_RUN, STATE, XK_HOME, addRoute, httpError, json, saveState } from "./xk-core.mjs";
import { agyUsage } from "./xk-rollover.mjs";
import { deviceMcpConfig } from "./usage.mjs";

const DIR = roleDir("hachimi");
// 放在上游加进 PATH 的 ~/.cccodroid/bin：主人在应用内终端里直接敲 agy 登录
export const AGY = path.join(CFG.home, ".cccodroid", "bin", "agy");
const MANIFESTS = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/";   // 官方 install.sh 里的地址
const MEM_MCP = fileURLToPath(new URL("./xk-memory-mcp.mjs", import.meta.url));
const XK_TOOL = fileURLToPath(new URL("./xk-tool.mjs", import.meta.url));
STATE.agyConv ||= {};   // 我们的会话号 → agy 的 conversation_id

// 账号要先验证（agyVerify）时也接不了班：交给她只会再撞一次同样的错
ENGINES.agy = () => fs.existsSync(AGY) && STATE.agyAuth !== false && !STATE.agyVerify;

// Google 要求先验证账号（#2；11-01 真机 agy 1.4.12 实测）：stream-json 的 result.error 和 stderr 里是
// 「Eligibility check failed: … not eligible for Antigravity. Verify your account to continue. … 链接」，没有 VALIDATION_REQUIRED 字样，
// 那个词和 403 只在 agy 自己的日志里（带 validation_url）。登录本身是好的，agy models 照常列模型，所以只能在跑一轮时认出来
const VERIFY = /verify your account|not eligible for antigravity|eligibility check failed|VALIDATION_REQUIRED/i;
/** 是不是「要先验证账号」；是就返回 { url }（取不到链接时 url 为 null），不是返回 null */
export function agyValidation(text) {
  const t = String(text || "");
  if (!VERIFY.test(t)) return null;
  const m = /"validation_url"\s*:\s*"([^"]+)"/.exec(t) || /https:\/\/accounts\.google\.com\/[^\s"'<>]+/.exec(t);
  return { url: m ? m[1] || m[0] : null };
}

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
// 安卓上不能直接 exec 应用目录里的程序，别的进程靠 LD_PRELOAD 的垫片转给 linker64 去加载。agy 是 Go 写的，起子进程直接走系统调用、
// 垫片管不到，起 bash、node（MCP）、dbus-launch 全被内核拒（小克、小鱼 11-04 在 #101 查出来的）。所以 agy 要起的都换成系统分区的程序：
// MCP 写成「linker64 node 脚本…」；shell 用 /system/bin/sh（SHELL 指过去，PATH 最前面再放指向它的 bash / sh 软链接，
// 执行软链接时内核看的是它指向的系统程序）。sh 再起应用目录里的东西就经过 libc，垫片接得上。
export const GO_EXEC = { android: process.platform === "android" && fs.existsSync("/system/bin/linker64") };
const LINKER = "/system/bin/linker64", SYS_SH = "/system/bin/sh";
/** MCP 服务的 command / args：安卓上让 linker64 去加载 */
export function goCommand(command, args) { return GO_EXEC.android ? { command: LINKER, args: [command, ...args] } : { command, args }; }
function shellDir() {
  const d = path.join(XK_HOME, "agy-bin");
  fs.mkdirSync(d, { recursive: true });
  for (const n of ["bash", "sh"]) {
    const f = path.join(d, n);
    let cur = null; try { cur = fs.readlinkSync(f); } catch {}
    if (cur !== SYS_SH) { fs.rmSync(f, { force: true }); fs.symlinkSync(SYS_SH, f); }
  }
  return d;
}
export const agyEnv = () => {
  const env = { ...process.env, HOME: CFG.home };
  // MCP 能挂上靠的是上面 linker64 那一层（0.3.21 真机，#101）；它照样认得出是安卓（日志「Android (no OS keyring) detected」）
  if (GO_EXEC.android) Object.assign(env, { SHELL: SYS_SH, PATH: shellDir() + ":" + (process.env.PATH || "") });
  return env;
};

/** 人设 + 世界书 → hachimi/AGENTS.md（每轮前重写，导入后立刻生效） */
function writeAgents() {
  const agent = path.join(DIR, ".claude", "agents", "hachimi.md");
  const persona = fs.existsSync(agent) ? fs.readFileSync(agent, "utf8").replace(/^---[\s\S]*?---\n/, "") : "";
  const wb = fs.existsSync(WORLDBOOK) ? fs.readFileSync(WORLDBOOK, "utf8") : "";
  const mech = fs.existsSync(path.join(DIR, "CLAUDE.md")) ? fs.readFileSync(path.join(DIR, "CLAUDE.md"), "utf8") : "";
  const f = path.join(DIR, "AGENTS.md"), text = [persona.trim(), wb.trim(), mech.trim(), toolsHowTo()].filter(Boolean).join("\n\n---\n\n") + "\n";
  // 每轮都会调到这里：内容没变就不写（#125 小鱼查的）
  let cur = null; try { cur = fs.readFileSync(f, "utf8"); } catch {}
  if (cur !== text) fs.writeFileSync(f, text);
}

/** agy 在手机上挂不上 MCP（#101），上面说的工具改从终端调 xk-tool.mjs；挂上了也照样能用 */
function toolsHowTo() {
  const cmd = `"${process.execPath}" "${XK_TOOL}"`;
  return `# 你的工具在终端里调

上面说的记忆、留言板、群，还有设备工具（读屏、截图、点按……），工具列表里没有的话（agy 在这台手机上常挂不上），用终端调，效果一样：

- 看有哪些工具、要什么参数：\`${cmd}\`
- 调一个：\`${cmd} 工具名 '{"参数":"值"}'\`，比如 \`${cmd} recall '{"query":"主人喜欢的游戏"}'\`
- 截图一类的工具会把图存成文件、打印路径，用读文件的工具看图。
- 记忆一律走 remember，不要直接改 memory/memories.json（直接改会绕过日期、去重和来源）。`;
}

/** 记忆工具和设备工具：登记到 agy 的全局 MCP 配置，只指向哈基米的目录。
 *  两个位置都写：~/.gemini/config/ 是早先的（11-02 真机能用），命令行版后来读 ~/.gemini/antigravity-cli/
 *  （google-antigravity/antigravity-cli#60；11-03 起她的工具全没了，agy 会自己更新，#101）。别的条目原样留着 */
export const AGY_MCP_FILES = () => ["config", "antigravity-cli"].map((d) => path.join(CFG.home, ".gemini", d, "mcp_config.json"));
export function ensureMcp() {
  const want = { "xk-memory": goCommand(process.execPath, [MEM_MCP, DIR]) };
  // 设备工具（通知、剪贴板、读屏点按…）：和 Claude 那两位挂的是同一个（usage.mjs），用哪些由应用里的开关定
  const dev = deviceMcpConfig();
  if (dev) { const { type, command, args, ...d } = JSON.parse(dev).mcpServers.device; want.device = { ...d, ...goCommand(command, args || []) }; }
  for (const f of AGY_MCP_FILES()) {
    let cfg = {};
    // agy 第一次跑会建一个 0 字节的空文件（11-02 真机）：当空配置；里面有东西却不是 JSON 才报错，不覆盖主人的文件
    try { const t = fs.readFileSync(f, "utf8"); if (t.trim()) cfg = JSON.parse(t); } catch (e) { if (e.code !== "ENOENT") throw new Error(`读不了 ${f}：${e.message}`); }
    const next = { ...cfg, mcpServers: { ...(cfg.mcpServers || {}), ...want } };
    if (JSON.stringify(next) === JSON.stringify(cfg)) continue;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(next, null, 1));
  }
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

// agy 的轮次不在上游的 RUNS 里：界面在新会话还没拿到会话号时发的第二条消息只带 follow（前一轮的 run 号），靠这张表认出是哪个会话
const RUN_SID = new Map();
export const sidOfAgyRun = (id) => RUN_SID.get(String(id)) || null;
// 同一会话的轮次一个接一个跑：两个 agy 进程同时接着同一个 conversation 会互相踩
const CHAIN = new Map();
export function runAgyQueued(item, extra = {}) {
  const sid = item.sessionId || null;
  if (!sid) return runAgy(item, extra);
  const prev = CHAIN.get(sid) || Promise.resolve();
  const next = prev.then(() => new Promise((done) => runAgy(item, { ...extra, onEnd: done })));
  CHAIN.set(sid, next);
  next.then(() => { if (CHAIN.get(sid) === next) CHAIN.delete(sid); });
}

/** 跑一轮。item：{ id, message, sessionId? }；extra：{ internal, carry, onEnd } */
export function runAgy(item, extra = {}) {
  const runId = item.id, startedAt = Date.now();
  let sid = item.sessionId || null;
  const isNew = !sid;
  if (isNew) sid = crypto.randomUUID();
  RUN_SID.set(String(runId), sid);
  if (RUN_SID.size > 500) RUN_SID.delete(RUN_SID.keys().next().value);
  const emit = (ev) => publish({ ...ev, runId });
  emit({ type: "run_start", text: item.message, sessionId: isNew ? null : sid, startedAt, ...(extra.internal ? { auto: "xk-agy" } : {}) });
  const ctx = [];
  // 同一段会话里带过的不再带，最多 4 条、每条截短（#125）。新会话的会话号是刚生成的，清单自然是空的
  const hits = injectFor(DIR, sid, item.message);
  if (hits) ctx.push("可能和这条消息有关的记忆（自动按关键词挑的，可能不准；这段对话里带过的不再重复）：\n" + hits);
  if (extra.carry) ctx.push(extra.carry);
  const board = extra.internal ? "" : unreadText(path.dirname(DIR), "hachimi");
  if (board) ctx.push(board);
  ctx.push(`（系统：你这一轮经 Antigravity 用的是 Gemini，模型 ${STATE.agyModel || "是 agy 的默认"}。主人问起就照这个答。）`);
  if (fs.existsSync(postHistoryFile("hachimi"))) ctx.push(fs.readFileSync(postHistoryFile("hachimi"), "utf8").trim());
  const content = [...(ctx.length ? [{ type: "text", text: "（给你自己看的背景，不是主人说的话）\n" + ctx.join("\n\n") }] : []), { type: "text", text: item.message }];
  let parent = null;
  const finish = (fields) => {
    const run = { id: runId, text: item.message, sessionId: sid, cwd: DIR, startedAt, provider: "agy", ...(extra.internal ? { auto: "xk-agy" } : {}) };
    // agy 的 stdout 没有 usage，但本地日志有：走同一个 agyUsage，卡片上的百分比和换新线的判断就不会对不上
    const usage = agyUsage(sid);
    const f = usage ? { ...fields, usage } : fields;
    for (const h of END_HOOKS) { try { h(run, f); } catch (e) { log("结束钩子出错: " + e.message); } }
    publish({ type: "run_end", runId, sessionId: sid, aborted: false, durationMs: Date.now() - startedAt, ...(extra.internal ? { auto: "xk-agy" } : {}), ...f });
    extra.onEnd?.();
  };
  try {
    writeAgents(); ensureMcp();
    if (!extra.internal) parent = appendTurn(sid, "user", item.message, null);
  } catch (e) { emit({ type: "error", message: "哈基米准备失败：" + e.message }); finish({ failed: true }); return; }
  // 内部轮次（整理记忆）不记成「最近的会话」，不然开机会打开它（#8）
  if (isNew) { if (!extra.internal) rememberSession(sid); emit({ type: "init", sessionId: sid, model: "antigravity" }); }
  const p = warmProc(sid, !!extra.internal, runId);
  clearTimeout(p.timer);
  if (!extra.internal) copyChannel(runId, p.runKey);
  let text = "", result = null, done = false, turnErr = "";
  const end = (code, crash) => {
    if (done) return; done = true; p.turn = null;
    if (result?.conversation_id && STATE.agyConv[sid] !== result.conversation_id) { STATE.agyConv[sid] = result.conversation_id; saveState(); }
    const ok = result && result.status === "SUCCESS";
    const reply = (result && result.response) || text;
    // 没 SUCCESS 但话已经出来了的（收尾报「流中断」，#101）也记进会话：群聊从这里取她的话，私聊翻历史也看得到；错误照样报
    if (reply.trim() && !extra.internal) appendTurn(sid, "assistant", reply.trim(), parent);
    const verify = !ok && (agyValidation(result && result.error) || agyValidation(turnErr));
    if (verify) {
      // 先认这个：原文里有「signing in」，别落进下面的「没登录」
      STATE.agyVerify = { url: verify.url, at: Date.now() }; saveState();
      emit({ type: "error", message: "哈基米：Google 要求先验证这个账号，验证之前用不了 Gemini（登录本身没问题）。" +
        (verify.url ? `在浏览器里打开这个链接验证：${verify.url}` : "到哈基米的卡片里看看。") + " 验证完回来再发一次就行。" });
    } else if (!ok) {
      const why = crash || (result && result.error) || turnErr.trim().split("\n").slice(-3).join(" ") || `agy 没答完就退出了（退出码 ${code}）`;
      if (/authenticat|login|sign in|未登录/i.test(why)) { STATE.agyAuth = false; saveState(); }
      emit({ type: "error", message: "哈基米（agy）：" + why });
    } else if (STATE.agyAuth === false || STATE.agyVerify) { delete STATE.agyAuth; delete STATE.agyVerify; saveState(); }
    // 常驻的这一轮答完了：闲置计时重新开始
    if (!p.dead && !extra.internal) { p.timer = setTimeout(() => endWarm(sid), AGY_IDLE.ms); p.timer.unref?.(); }
    finish({ isError: !ok, subtype: result ? String(result.status) : "no_result", ...(extra.internal ? { finalText: reply } : {}) });
  };
  p.turn = {
    err(d) { turnErr += d; if (turnErr.length > 20000) turnErr = turnErr.slice(-20000); },
    event(raw) {
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
      } else if (raw.event === "result") { result = ev; end(0); }   // 多轮时一轮一个 result，不等进程退出
    },
    exit(code, crash) { end(code, crash); },
  };
  try { p.child.stdin.write(JSON.stringify({ event: "user", message: { content } }) + "\n"); if (extra.internal) p.child.stdin.end(); }
  catch (e) { end(null, "写给 agy 失败：" + e.message); }
}

// ── 常驻：每段对话一个 agy 进程，stdin 不关，一行一条消息（agy 的 --input-format stream-json 本来就一行跑一轮）。
// 11-02 真机实测：首条 10.2s，同一进程第二条 3.2s——每条新起 agy 都要重走登录检查、模型清单、额度、实验开关那一整套（约 5.7s）。
// 网关退出时管道一断，agy 读到 EOF 自己退出，不留孤儿。
export const WARM = new Map();                     // 我们的会话号 → { child, model, agents, runKey, turn, timer, dead }
export const AGY_IDLE = { ms: 10 * 60 * 1000 };    // 多久没新消息就让它退出：常驻省的是启动时间，不值得一直占着内存
// 按内容比：writeAgents 每轮都重写 AGENTS.md，按修改时间比会每轮都当成「换了人设」
const agentsMark = () => { try { return crypto.createHash("sha1").update(fs.readFileSync(path.join(DIR, "AGENTS.md"))).digest("hex"); } catch { return ""; } };
function warmProc(sid, oneShot, runId) {
  const model = STATE.agyModel || "", agents = agentsMark();
  let p = oneShot ? null : WARM.get(sid);
  // 人设、世界书只在 agy 启动时读：AGENTS.md 变了（导入了新人设）或换了模型，就换个新进程
  if (p && (p.dead || p.model !== model || p.agents !== agents)) { endWarm(sid); p = null; }
  if (p) return p;
  // 主人本人在 App 里发的才会走到这里（QQ 接入时再按渠道收紧）：没法把 agy 的权限请求转给界面，所以不逐条确认
  // stream-json 输入时不能再给 -p（它会把下一个参数当成提示词）
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions"];
  if (STATE.agyConv[sid]) args.push("--conversation", STATE.agyConv[sid]);
  if (model) args.push("--model", model);   // 主人在哈基米的卡片里选的 Gemini 模型
  // 常驻进程的 run 号用会话级的固定值，每轮把渠道记录抄过去（copyChannel）；一次性的照旧用本轮 run 号
  const runKey = oneShot ? runId : "agyw-" + sid;
  const child = spawn(AGY, args, { cwd: DIR, env: { ...agyEnv(), CCAPP_RUN_ID: runKey }, stdio: ["pipe", "pipe", "pipe"] });
  p = { child, model, agents, runKey, turn: null, timer: null, dead: false };
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      let raw; try { raw = JSON.parse(l); } catch { continue; }
      p.turn?.event(raw);
    }
  });
  child.stderr.on("data", (d) => p.turn?.err(String(d)));
  child.stdin.on("error", () => {});   // 进程先退了还在写：交给 close 处理
  const gone = (code, crash) => { p.dead = true; clearTimeout(p.timer); if (WARM.get(sid) === p) WARM.delete(sid); p.turn?.exit(code, crash); };
  child.on("error", (e) => gone(null, "agy 起不来：" + e.message));
  child.on("close", (code) => gone(code));
  if (!oneShot) WARM.set(sid, p);
  return p;
}
/** 让常驻的 agy 收工：关 stdin 它自己退；5 秒还没退就强杀 */
function endWarm(sid) {
  const p = WARM.get(sid); if (!p) return;
  WARM.delete(sid); clearTimeout(p.timer);
  try { p.child.stdin.end(); } catch {}
  setTimeout(() => { if (!p.dead) p.child.kill(); }, 5000).unref?.();
}
/** 全部收工，等它们真退出（测试、以后网关退出时用） */
export async function stopAgy() {
  const ps = [...WARM.values()]; for (const sid of [...WARM.keys()]) endWarm(sid);
  await Promise.all(ps.map((p) => p.dead ? null : new Promise((r) => p.child.once("close", r))));
}
const runFile = (id) => path.join(DIR, ".xk", "runs", id + ".json");
function copyChannel(runId, runKey) {
  // 渠道记录（QQ 接入时由 markRun 写）按 run 号放；常驻进程的 MCP 服务只认它启动时的 run 号，所以每轮抄一份过去，没有就删（= App）
  try { if (fs.existsSync(runFile(runId))) fs.copyFileSync(runFile(runId), runFile(runKey)); else fs.rmSync(runFile(runKey), { force: true }); }
  catch (e) { log("哈基米渠道记录没抄成：" + e.message); }
}
ENGINE_RUN.agy = runAgyQueued;

// 问一次、拿回文字（整理记忆用）：不在哈基米目录里跑（不读 AGENTS.md 人设）、不接对话、不放行工具、不写会话记录
const ASK_DIR = path.join(XK_HOME, "ask");
export function askAgy(prompt, timeoutMs = 5 * 60000) {
  return new Promise((resolve) => {
    fs.mkdirSync(ASK_DIR, { recursive: true });
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", ...(STATE.agyModel ? ["--model", STATE.agyModel] : [])];
    const child = spawn(AGY, args, { cwd: ASK_DIR, env: agyEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", text = "", err = "", done = false;
    const fin = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { child.kill(); fin({ error: `agy ${Math.round(timeoutMs / 60000)} 分钟没答完` }); }, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        let raw; try { raw = JSON.parse(l); } catch { continue; }
        const ev = raw[raw.event] && typeof raw[raw.event] === "object" ? raw[raw.event] : raw;
        if (raw.event === "step_update" && ev.step_type === "agent_response" && ev.text_delta) text += ev.text_delta;
        if (raw.event === "result") fin(ev.status === "SUCCESS" ? { text: ev.response || text } : { error: "哈基米（agy）：" + (ev.error || ev.status) });
      }
    });
    child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    child.stdin.on("error", () => {});
    child.on("error", (e) => fin({ error: "agy 起不来：" + e.message }));
    child.on("close", (code) => fin({ error: err.trim().split("\n").slice(-3).join(" ") || `agy 没答完就退出了（退出码 ${code}）` }));
    // 和以前一次性的内部轮次一样：写一行就关 stdin，agy 答完这一条自己退
    child.stdin.end(JSON.stringify({ event: "user", message: { content: [{ type: "text", text: prompt }] } }) + "\n");
  });
}
ENGINE_ASK.agy = askAgy;

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
/** agy models 的 stdout → [{ id, label }]。1.4.12 实测每行「代号<Tab>名字」；没 Tab 的行按「代号 名字」拆。
 *  只认 stdout：stderr 里是「ERROR: logging before google.Init…」「Fetching available models...」这类日志，以前混进来当成了模型 */
export function parseModels(out) {
  return plain(String(out || "")).split("\n").map((l) => l.replace(/^[-*•>\s]+/, "").trimEnd()).filter((l) => l && !/^fetching|^available|^[-─=]+$/i.test(l))
    .map((l) => { const [id, ...rest] = l.includes("\t") ? l.split("\t") : l.split(/\s+/); return { id: id.trim(), label: rest.join(l.includes("\t") ? "\t" : " ").trim() || id.trim() }; })
    .filter((m) => /^[A-Za-z0-9._/-]+$/.test(m.id));
}
export function checkModels(force) {
  if (!force && Date.now() - MODELS.at < 60000) return Promise.resolve(MODELS);
  return new Promise((ok) => execFile(AGY, ["models"], { encoding: "utf8", timeout: 45000, env: agyEnv(), maxBuffer: 1 << 20 }, (e, out, err) => {
    const text = plain(String(out || "") + "\n" + String(err || ""));
    if (/sign in|not signed in|log ?in/i.test(text)) MODELS = { at: Date.now(), auth: false, list: [] };
    else if (e && !text.trim()) MODELS = { at: Date.now(), auth: null, list: [], error: e.message };
    else MODELS = { at: Date.now(), auth: true, list: parseModels(out) };
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
    return sendJson(res, 200, { installed, path: AGY, version: installed ? version() : null, auth: m.auth, models: m.list, model: STATE.agyModel || "", platform: platform(), login: loginState(), verify: STATE.agyVerify || null });
  }
  // 主人说验证好了：先放开，下一轮真跑时还不行会再认出来（agy models 认不出这个，没有不花额度的检查办法）
  if (p === "/api/xk/agy/verified" && req.method === "POST") { delete STATE.agyVerify; saveState(); return sendJson(res, 200, { ok: true }); }
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

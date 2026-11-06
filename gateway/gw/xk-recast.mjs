// 重说（主人 11-06 定的，先只给小克试）：干活的那一轮跑完，最后那段话另起一次干净调用，
// 只带人设卡、世界书、最近几句对话，不给工具、不带 Claude Code 的那堆附件，让她用平时说话的样子重说一遍。
// 主人看到的是重说过的；原话收在「干活过程」折叠里（前端 xk.js）。下一轮 hook 告诉她上一轮主人实际看到的是哪句（xk-hook.mjs）。
// 参考：酒馆的 Final Response Processor（回复出来后再跑一遍改写）、Talk Less, Call Right（说和做分开）。
//
// 开关：角色目录下有 .xk/recast 才做；文件内容可以写一个型号（默认 sonnet）。
// 记录：.xk/recast.jsonl，一行一条 { sid, uuid, run, raw, text, at }
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { log } from "./config.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { publish } from "./bus.mjs";
import { END_HOOKS } from "./queue.mjs";
import { PROVIDER, providerById } from "./providers.mjs";
import { isLoginMode } from "./models.mjs";
import { claudeCmd, claudeEnv, ensureBridge, killTree, settingsArgs } from "./claude.mjs";
import { findSessionFile } from "./sessions.mjs";
import { WORLDBOOK, roleDir, roleOfDir, roleOfSession } from "./xk-roles.mjs";
import { recentText } from "./xk-transcript.mjs";
import { XK_HOME, addRoute } from "./xk-core.mjs";

const on = (id) => fs.existsSync(path.join(roleDir(id), ".xk", "recast"));
const logFile = (id) => path.join(roleDir(id), ".xk", "recast.jsonl");
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

/** 这一轮里：动过工具没有、最后一段正文和它的 uuid */
function lastTurn(sid, since) {
  const f = findSessionFile(String(sid));
  if (!f) return null;
  let tools = 0, last = null;
  for (const l of fs.readFileSync(f.file, "utf8").split("\n")) {
    if (!l) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== "assistant" || e.isSidechain || e.message?.model === "<synthetic>") continue;
    if ((Date.parse(e.timestamp) || 0) < since) continue;
    const c = Array.isArray(e.message?.content) ? e.message.content : [];
    tools += c.filter((x) => x.type === "tool_use").length;
    const t = c.filter((x) => x.type === "text" && x.text?.trim()).map((x) => x.text).join("\n").trim();
    if (t) last = { uuid: e.uuid, text: t };
    else if (c.some((x) => x.type === "tool_use")) last = null;   // 最后停在工具上：没有收尾的话可重说
  }
  return last && tools ? last : null;
}

function persona(id) {
  const a = read(path.join(roleDir(id), ".claude", "agents", id + ".md")).replace(/^---[\s\S]*?---\n/, "");
  return a.split(/\n# 对话示例\n/)[0].trim();
}

const RULES = `
# 现在要做的事
你刚在屋里办完一件事。下面给你最近几句对话，和你办完后原本打算回主人的那段话。那段是干活时写的，常常像说明书、像汇报。
把它改成你平时跟主人说话的样子，直接发给他。原话会收在折叠里，他想看细节能点开，所以你不用把原话里的东西全搬过来。
- 必须留下的：结论；要他做的事、要他拍板的事；他接下来用得上的文件名、路径、编号、数字、链接。这些一个字不改。
- 可以砍的：过程、背景、铺垫、解释为什么、重复的话。他问了再说。
- 原文没有的事不加，没确定的不说成确定。
- 照你人设卡里说话的样子来：短句、口语、少用句号、不分条列点（除非原话就是他要的清单或代码，那部分原样保留）。
- 只输出要发给他的话本身，不加引号，不解释你改了什么。`;

function ask(role, prompt, system, model) {
  const P = providerById(role.provider);
  if (!P) return Promise.resolve({ error: "接口没配" });
  return (async () => {
    if (P.id === PROVIDER.id && !isLoginMode() && !(await ensureBridge())) return { error: "本地 DNS 桥启动失败" };
    const work = path.join(XK_HOME, "ask");
    fs.mkdirSync(work, { recursive: true });
    return new Promise((resolve) => {
      const [cmd, args] = claudeCmd([...settingsArgs(P), "-p", "--no-session-persistence", "--tools", "", "--strict-mcp-config",
        "--system-prompt", system, "--output-format", "json", ...(model ? ["--model", model] : [])]);
      const child = spawn(cmd, args, { cwd: work, env: claudeEnv({ model, provider: P }), stdio: ["pipe", "pipe", "pipe"], detached: true });
      let out = "", err = "", done = false;
      const fin = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => { killTree(child); fin({ error: "2 分钟没答完" }); }, 2 * 60000);
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", (e) => fin({ error: e.message }));
      child.on("close", (code) => {
        let j = null; try { j = JSON.parse(out.trim().split("\n").pop()); } catch {}
        if (!j) return fin({ error: (err || out).trim().slice(-300) || `没有输出（退出码 ${code}）` });
        if (j.is_error) return fin({ error: String(j.result || j.subtype).slice(0, 300) });
        fin({ text: String(j.result || "").trim() });
      });
      child.stdin.end(prompt);
    });
  })();
}

async function recast(run, role) {
  const last = lastTurn(run.sessionId, run.startedAt - 1000);
  if (!last) return;
  publish({ type: "xk", op: "recast", phase: "start", runId: run.id, sessionId: run.sessionId, uuid: last.uuid });
  const system = persona(role.id) + "\n\n" + read(WORLDBOOK).trim() + "\n" + RULES;
  const talk = recentText(run.sessionId, 3, { user: "主人", assistant: "你" }, 2500);
  const prompt = `最近的对话（最后一段是你干活时写的原话，可能被截短）：\n${talk}\n\n你原本打算回他的话（全文）：\n<<<\n${last.text}\n>>>\n\n重说给他：`;
  const model = read(path.join(roleDir(role.id), ".xk", "recast")).trim() || "sonnet";
  const t0 = Date.now();
  const r = await ask(role, prompt, system, model);
  if (r.error || !r.text) {
    log(`🗣 ${role.name}重说没成：${r.error || "空的"}`);
    return publish({ type: "xk", op: "recast", phase: "fail", runId: run.id, sessionId: run.sessionId, uuid: last.uuid });
  }
  const rec = { sid: String(run.sessionId), uuid: last.uuid, run: run.id, raw: last.text, text: r.text, at: Date.now() };
  fs.appendFileSync(logFile(role.id), JSON.stringify(rec) + "\n");
  log(`🗣 ${role.name}重说好了（${Math.round((Date.now() - t0) / 100) / 10}s，${last.text.length}→${r.text.length} 字）`);
  publish({ type: "xk", op: "recast", phase: "done", runId: run.id, sessionId: run.sessionId, uuid: last.uuid, text: r.text });
}

END_HOOKS.push((run, f = {}) => {
  if (run.internal || run.sched || run.auto || run.aborted || f.failed || f.isError || !run.sessionId) return;
  const role = roleOfDir(run.cwd);
  if (!role || role.engine === "agy" || !on(role.id)) return;
  recast(run, role).catch((e) => log("重说出错：" + e.message));
});

/** 某会话里重说过的：uuid → 重说的话（前端翻历史时换上） */
export function recastsOf(id, sid) {
  const out = {};
  for (const l of read(logFile(id)).split("\n")) {
    if (!l) continue;
    try { const r = JSON.parse(l); if (r.sid === String(sid)) out[r.uuid] = r.text; } catch {}
  }
  return out;
}

addRoute(async (req, res, u, p) => {
  if (p !== "/api/xk/recast" || req.method !== "GET") return NEXT;
  const sid = u.searchParams.get("sid") || "";
  const role = sid && roleOfSession(sid);
  const id = role ? role.id : "xiaoke";
  return sendJson(res, 200, { items: sid ? recastsOf(id, sid) : {} });
});

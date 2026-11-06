// 小克各模块共用的状态和小工具（单独一个文件：各功能模块都依赖它，它不依赖任何功能模块，免得循环引用）。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CFG } from "./config.mjs";
import { readBody } from "./http.mjs";
import { TOKEN } from "./access.mjs";
import { END_HOOKS, START_GUARDS, enqueue } from "./queue.mjs";
import { LAST_SESSION, forgetSession, rememberSession } from "./runs.mjs";
import { ROLES, ROLES_DIR, roleById, roleDir, roleOfSession } from "./xk-roles.mjs";
import { quietFile } from "./xk-board.mjs";
import { recentText } from "./xk-transcript.mjs";
import { writeJson } from "./xk-shared.mjs";

export const XK_HOME = path.join(CFG.home, ".config", "xiaoke");
fs.mkdirSync(XK_HOME, { recursive: true });

// ── 状态：当前角色、接班顺序、冷却、会话从哪个角色接过来 ──
const STATE_FILE = path.join(XK_HOME, "state.json");
export const STATE = { active: "xiaoke", order: ["xiaoke", "hachimi", "deepseek"], projects: {}, cooldown: {}, origin: {}, pending: {} };
try { Object.assign(STATE, JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); } catch (e) { if (e.code !== "ENOENT") throw new Error("小克状态文件坏了：" + e.message); }
export function saveState() { writeJson(STATE_FILE, STATE, { indent: 1 }); }

// 各模块往这里挂：handlers(req, res, u, p) 不认领就返回 NEXT
export const ROUTES = [];
export const addRoute = (fn) => ROUTES.push(fn);
export const httpError = (status, msg) => Object.assign(new Error(msg), { status });

export async function json(req) {
  const t = await readBody(req);
  try { return t ? JSON.parse(t) : {}; } catch (e) { throw httpError(400, "请求不是 JSON：" + e.message); }
}

/** 调网关自己的公开接口（项目、定时任务）：走上游的校验和存储，不碰它的内部变量 */
export function selfApi(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: "127.0.0.1", port: CFG.port, path: p, method,
      headers: { host: "127.0.0.1:" + CFG.port, "x-cc-token": TOKEN, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => {
        let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
        res.statusCode < 300 ? resolve(j) : reject(new Error(`${method} ${p} → ${res.statusCode} ${j.error || j.message || t.slice(0, 200)}`));
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

export const projectOf = (id) => STATE.projects[id] || null;
export const roleOfProject = (pid) => ROLES.find((r) => STATE.projects[r.id] === pid) || null;

// 非 Claude Code 的角色引擎（哈基米的 agy）登记自己能不能用：ENGINES.agy = () => true/false
export const ENGINES = {};
// 非 Claude Code 引擎怎么跑一轮：ENGINE_RUN.agy(item, { internal, carry })
export const ENGINE_RUN = {};
// 非 Claude Code 引擎问一次、拿回文字（不留会话、不给工具）：ENGINE_ASK.agy(prompt) → { text } | { error }
export const ENGINE_ASK = {};

// 有人下班（被换走、交回）时：SHIFT_END 里的每个都调一次 ({ from, to, sid, reason })。留言板往这里挂
export const SHIFT_END = [];
export const shiftEnded = (x) => { for (const h of SHIFT_END) h(x); };

// planners(b, ctx) 可以改 ctx：{ body, role, carry: {fromSid, fromRole, reason}, notice, onQueued(item) }。接班模块往这里加
export const PLANNERS = [];

// ── 接班说明：带上来源会话最近几轮，写进新会话第一轮的 run 号下，由 xk-hook.mjs 注入（只带一次） ──
// back：交回原角色、接着她原来那段会话（#1）——她自己的上下文还在，只缺替班那会儿聊的
export function carryText(fromSid, fromRole, toRole, reason, back = false) {
  const who = fromRole ? roleById(fromRole).name : "另一位";
  const talk = fromSid ? recentText(fromSid, 6, { assistant: fromRole ? roleById(fromRole).name : "她" }) : "";
  if (back) return `（交回说明，给你自己看的）${reason}。你不在的时候主人在和${who}聊，现在回到你们原来这段对话接着聊。` +
    (talk ? `下面是你不在时最近几轮，只是让你知道聊到哪了；这是${who}的对话，不是你的记忆：\n${talk}` : "");
  // 自己换自己（#72 上下文到 20% 换新对话）：带到的是她自己的话，不是别人的记忆
  if (fromRole && fromRole === toRole) return `（换新对话说明，给你自己看的）${reason}。下面是你上一段对话最新的几轮，带着它接着聊；这就是你自己的话：` +
    (talk ? `\n${talk}` : "（上一段没有可带的内容）");
  return `（接班说明，给你自己看的）主人刚才在和${who}聊，${reason}，现在换成你接着聊。` +
    (talk ? `下面是刚才最近几轮，只是让你知道在聊什么；这不是你的记忆，你用自己的人设和记忆回应：\n${talk}` : "");
}
/** 从接班会话 sid 换回角色 to 时，能接着的原会话号：得是 to 自己的、还在的那段（#1） */
export function resumeSid(sid, to) {
  const o = sid && STATE.origin[sid];
  return o && o.from === to && o.fromSid && roleOfSession(o.fromSid)?.id === to ? o.fromSid : null;
}
export function writeCarry(role, runId, text) {
  const f = path.join(roleDir(role), ".xk", "carry", runId + ".md");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text + "\n");
}


// 网关自己发起的轮次（空闲整理、日记补写）：auto 非空，外壳就不发「跑完了」通知；结束后各模块按 kind 收尾
export const INTERNAL = new Map();
// 网关自己起的轮次（整理记忆、定时任务写日记、空闲压缩）开跑时会把「最近的会话」记成它，
// 界面开机就照这个打开——主人一打开 App 看到的是一段整理记忆的对话（#8）。开跑前记下原来那段，跑完换回去
const PREV_LAST = new Map();
START_GUARDS.push((q) => {
  if (q.internal || q.sched || q.auto) {
    PREV_LAST.set(q.id, LAST_SESSION ? LAST_SESSION.id : null);
    if (PREV_LAST.size > 200) PREV_LAST.delete(PREV_LAST.keys().next().value);
    // 也不该把留言板上的便条「读掉」：给 hook 留个记号（xk-board.mjs）
    const f = quietFile(ROLES_DIR, q.id); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "");
  }
  return true;
});
END_HOOKS.push((run) => { fs.rmSync(quietFile(ROLES_DIR, run.id), { force: true }); });
END_HOOKS.push((run) => {
  if (!PREV_LAST.has(run.id)) return;
  const prev = PREV_LAST.get(run.id); PREV_LAST.delete(run.id);
  if (!LAST_SESSION || LAST_SESSION.id !== run.sessionId) return;   // 主人这期间自己开了别的会话：那才是最近的
  if (prev) rememberSession(prev); else forgetSession();
});

export function internalRun(kind, body, extra = {}) {
  const item = enqueue({ internal: true, unattended: true, auto: "xk-" + kind, ...body });
  INTERNAL.set(item.id, { kind, ...extra });
  return item;
}

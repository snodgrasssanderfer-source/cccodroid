// 小克：网关里我们自己加的全部功能从这里进。server.mjs 只多了一行 import 和 ROUTES 里的 routeXk（排第一，要先看 /api/chat）。
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { CFG, LIVE, log } from "./config.mjs";
import { findSessionFile, peekSession } from "./sessions.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { publish } from "./bus.mjs";
import { END_HOOKS, START_GUARDS, enqueue, routeQueue } from "./queue.mjs";
import { RUNS } from "./runs.mjs";
import { ROLES, ensureRoles, importPersona, importWorldbook, personaStatus, roleById, roleDir, roleOfDir, roleOfSession } from "./xk-roles.mjs";
import { ENGINE_RUN, PLANNERS, ROUTES, STATE, XK_HOME, addRoute, shiftEnded, carryText, httpError, json, projectOf, resumeSid, roleOfProject, saveState, selfApi, writeCarry } from "./xk-core.mjs";
import "./xk-memory.mjs";
import { handoverRoles } from "./xk-handover.mjs";
import { effectiveModel, routeSessModel } from "./sessmodel.mjs";
import { sidOfAgyRun } from "./xk-agy.mjs";
import "./xk-diary.mjs";
import "./xk-health.mjs";
import "./xk-board-gw.mjs";
import "./xk-overlay.mjs";

/** 三个角色各自对应一个上游项目（目录、默认服务商）。项目号记在状态里，接班和切换靠它 */
async function ensureProjects() {
  const { projects } = await selfApi("GET", "/api/projects");
  for (const r of ROLES) {
    const dir = fs.realpathSync(roleDir(r.id));
    let p = projects.find((x) => x.path === dir);
    if (!p) p = (await selfApi("POST", "/api/projects", { name: r.name, mode: "dir", path: dir })).project;
    // 模型和人设绑定（主人 11-01 定的）：角色项目的接口每次启动都对回这个角色的那家
    if (r.provider && p.provider !== r.provider) p = (await selfApi("PATCH", "/api/projects/" + encodeURIComponent(p.id), { provider: r.provider })).project;
    STATE.projects[r.id] = p.id;
  }
  saveState();
}
if (LIVE) {
  ensureRoles();
  // 等主地址监听上了再调自己的接口
  setTimeout(() => ensureProjects().catch((e) => log("⚠️ 小克建角色项目失败：" + e.message)), 1500).unref();
}

// ── /api/chat：先决定这条消息该落到哪个角色，再交给上游原样处理 ──
function fakeReq(req, body) {
  const r = Readable.from([Buffer.from(body)]);
  return Object.assign(r, { method: req.method, url: req.url, headers: { ...req.headers, "content-length": String(Buffer.byteLength(body)) }, socket: req.socket, ccAuthed: req.ccAuthed });
}
/** 这条消息该落到哪个角色、哪段会话、要不要带接班说明（单拿出来，测试直接调） */
export async function planChat(b) {
  const ctx = { body: { ...b }, role: null, carry: null, notice: null };
  if (!b.sessionId && !b.follow) {
    // 新会话首条带的模型选了另一家（输入栏里换了型号）：模型和人设绑定，落到那家对应的角色
    const byPin = b.pin && roleOfProvider(b.pin.provider);
    if (byPin && byPin.id !== roleOfProject(b.projectId)?.id) { ctx.body.projectId = projectOf(byPin.id); STATE.active = byPin.id; saveState(); }
    // 新会话没指定项目：落到当前角色
    if (!ctx.body.projectId && projectOf(STATE.active)) ctx.body.projectId = projectOf(STATE.active);
    ctx.role = roleOfProject(ctx.body.projectId)?.id || null;
    // 主人手动切过来的：带上切换前那段对话；这段新会话也记下从哪来的，换回去时好接着原来那段（#1）
    const pend = ctx.role && STATE.pending[ctx.role];
    if (pend && !pend.resumeSid) {
      ctx.carry = pend; delete STATE.pending[ctx.role]; saveState();
      // manual：主人自己换的，额度恢复时别自动拽回去（11-02 真机回归），主人手动换回时照样接原来那段
      if (pend.fromSid) ctx.onQueued = (item) => { STATE.originRun[item.id] = { from: pend.fromRole, fromSid: pend.fromSid, reason: pend.reason, manual: true, at: Date.now() }; saveState(); };
    }
  } else {
    // 只带 follow（新会话还没拿到会话号时发的下一条）：前一轮是哈基米的，就是她那个会话
    const sid = b.sessionId || (b.follow ? sidOfAgyRun(b.follow) : null);
    if (sid && !b.sessionId) { ctx.body.sessionId = sid; ctx.body.follow = null; }
    ctx.role = roleOfSession(sid)?.id || null;
    // 手动换回原角色、界面打开了她原来那段：回来后的第一条带上替班那会儿的对话
    const pend = ctx.role && STATE.pending[ctx.role];
    if (pend && pend.resumeSid === sid) { ctx.carry = pend; delete STATE.pending[ctx.role]; saveState(); }
  }
  for (const plan of PLANNERS) await plan(b, ctx);
  return ctx;
}
addRoute(async (req, res, u, p) => {
  if (p !== "/api/chat" || req.method !== "POST") return NEXT;
  const raw = await readBody(req);
  let b;
  try { b = JSON.parse(raw || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
  const ctx = await planChat(b);
  const role = roleById(ctx.role);
  if (role && role.engine !== "claude") {
    // 哈基米这类不走 Claude Code 的角色：交给它自己的驱动，界面收到的事件和普通轮次一样
    if (!String(ctx.body.message || "").trim()) return sendJson(res, 400, { error: "empty message" });
    const item = { id: "xa" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), message: String(ctx.body.message), sessionId: ctx.body.sessionId || null };
    ctx.onQueued?.(item);
    if (ctx.notice) publish({ type: "xk", op: "handover", runId: item.id, ...ctx.notice });
    ENGINE_RUN[role.engine](item, { carry: ctx.carry ? carryText(ctx.carry.fromSid, ctx.carry.fromRole, role.id, ctx.carry.reason, ctx.carry.back) : "" });
    return sendJson(res, 200, { ok: true, id: item.id, injected: false, started: true, xk: ctx.notice });
  }
  if (!ctx.carry) return routeQueue(fakeReq(req, JSON.stringify(ctx.body)), res, u, p);
  // 要带接班说明：自己入队，拿到 run 号立刻写说明（startRun 起进程前还有好几次 await，一定赶得上）
  if (!String(ctx.body.message || "").trim()) return sendJson(res, 400, { error: "empty message" });
  const item = enqueue({ ...ctx.body, internal: false, auto: undefined });
  writeCarry(ctx.role, item.id, carryText(ctx.carry.fromSid, ctx.carry.fromRole, ctx.role, ctx.carry.reason, ctx.carry.back));
  ctx.onQueued?.(item);
  if (ctx.notice) publish({ type: "xk", op: "handover", runId: item.id, ...ctx.notice });
  return sendJson(res, 200, { ok: true, id: item.id, injected: !!item.injected, started: RUNS.has(item.id), xk: ctx.notice });
});

// ── 兜底：不走 Claude Code 的角色（哈基米），她的会话 / 项目里绝不起 claude ──
// 走漏的路：空闲自动压缩、绕过 /api/chat 入队的轮次……一旦起了，就是全局那家（比如 DeepSeek）顶着她的人设说话（主人 11-01 报）。
// 主人发的消息改交她自己的引擎；网关自己起的（空闲压缩等）直接不跑
START_GUARDS.push((q) => {
  const sid = q.sessionId || (q.follow ? sidOfAgyRun(q.follow) : null);
  const role = sid ? roleOfSession(sid) : roleOfProject(q.projectId);
  if (!role || role.engine === "claude") return true;
  if (q.auto || q.internal || !ENGINE_RUN[role.engine]) { log(`跳过${role.name}会话里的一轮（${q.auto || "内部"}）：她不走 Claude Code`); return false; }
  log(`⚠️ ${role.name}的消息差点交给 Claude Code（${q.id}），改交 ${role.engine}`);
  ENGINE_RUN[role.engine]({ id: q.id, message: String(q.message || ""), sessionId: sid }, {});
  return false;
});

// ── 输入栏换型号：选了另一个角色那家的模型，就换成那个角色（接她最近那段，没有才新开；带上这段对话），原会话不动 ──
const roleOfProvider = (pid) => (pid ? ROLES.find((r) => r.provider === pid) || null : null);
// 从接班会话换回原角色：resume 是她原来那段的会话号，界面打开它接着聊（#1）；没有就照旧新开
// 每个角色最近一段主人自己聊的会话（网关自己起的整理记忆、日记、空闲压缩不算）：换人时接着她这段，不再次次新开
END_HOOKS.push((run) => {
  if (!run || run.sched || run.auto || run.internal || !run.sessionId) return;
  const r = roleOfDir(run.cwd);
  if (!r) return;
  STATE.lastByRole = { ...(STATE.lastByRole || {}), [r.id]: String(run.sessionId) };
  saveState();
});
/** 角色 to 最近那段、还在而且确实是她的会话号 */
export function lastSidOf(to) {
  const sid = STATE.lastByRole && STATE.lastByRole[to];
  return sid && roleOfSession(sid)?.id === to ? sid : null;
}
export function switchTo(to, fromSessionId, reason) {
  STATE.active = to;
  const fromRole = fromSessionId ? roleOfSession(fromSessionId)?.id || null : null;
  if (fromRole && fromRole !== to) shiftEnded({ from: fromRole, to, sid: fromSessionId, reason });
  // 先看是不是交回原角色（接她被替班前那段），否则接她自己最近那段；从空的新对话换过去的照旧新开
  const resume = fromSessionId && fromRole !== to ? resumeSid(fromSessionId, to) || lastSidOf(to) : null;
  if (fromSessionId && fromRole !== to) STATE.pending[to] = resume ? { fromSid: fromSessionId, fromRole, reason: "主人把你换了回来", back: true, resumeSid: resume } : { fromSid: fromSessionId, fromRole, reason };
  saveState();
  return { ok: true, active: to, projectId: projectOf(to), resume };
}
addRoute(async (req, res, u, p) => {
  // 新会话（还没会话号）问「用什么型号」又没带项目：按当前角色的项目答，别拿全局那家当成小克在用（#11）
  if (p === "/api/session-model" && req.method === "GET" && !u.searchParams.get("id") && !u.searchParams.get("project") && projectOf(STATE.active)) {
    const q = (k) => (u.searchParams.has(k) ? u.searchParams.get(k) : null);
    return sendJson(res, 200, effectiveModel("", projectOf(STATE.active), { provider: q("provider"), model: q("model"), effort: q("effort") }));
  }
  if (p !== "/api/session-model" || req.method !== "POST") return NEXT;
  const raw = await readBody(req);
  let b = {}; try { b = JSON.parse(raw || "{}"); } catch {}
  const cur = b.id ? roleOfSession(String(b.id)) : null, to = typeof b.provider === "string" ? roleOfProvider(b.provider) : null;
  if (cur && to && to.id !== cur.id) {
    const sw = switchTo(to.id, String(b.id), `主人在输入栏换成了${to.name}的模型`);
    return sendJson(res, 200, { ok: true, ...effectiveModel(String(b.id)), xkSwitch: { to: to.id, projectId: sw.projectId, model: typeof b.model === "string" ? b.model : null, provider: b.provider } });
  }
  return routeSessModel(fakeReq(req, raw), res, u, p);
});

// ── 角色、人设、世界书、手动切换 ──
addRoute(async (req, res, u, p) => {
  if (p === "/api/xk/roles" && req.method === "GET")
    return sendJson(res, 200, { active: STATE.active, order: STATE.order, roles: ROLES.map((r, i) => ({ ...r, projectId: projectOf(r.id), ...handoverRoles()[i], ...personaStatus(r.id) })) });
  let m = p.match(/^\/api\/xk\/roles\/([a-z]+)\/persona$/);
  if (m && req.method === "PUT") return sendJson(res, 200, importPersona(m[1], (await json(req)).text || ""));
  if (p === "/api/xk/worldbook" && req.method === "PUT") {
    const b = await json(req);
    return sendJson(res, 200, importWorldbook(Array.isArray(b.files) ? b.files : b.text || ""));
  }
  if (p === "/api/xk/session-role" && req.method === "GET") {
    const sid = u.searchParams.get("sid");
    const r = sid ? roleOfSession(sid) : roleById(STATE.active);
    // cwd：这段会话在哪个目录跑的（「我的 → 开发工具 → git」打开它；没有会话就是工作区）
    let cwd = null;
    if (sid) { try { const f = findSessionFile(String(sid)); cwd = (f && peekSession(f.file).cwd) || null; } catch {} }
    return sendJson(res, 200, { role: r ? r.id : null, active: STATE.active, origin: sid ? STATE.origin[sid] || null : null, cwd: cwd || (r ? roleDir(r.id) : CFG.workspace) });
  }
  if (p === "/api/xk/switch" && req.method === "POST") {
    // 手动切换：之后的新会话落到这个角色；从某个会话切过来的，第一条消息带上那段对话
    const { to, fromSessionId } = await json(req);
    if (!roleById(to)) throw httpError(404, "没有这个角色：" + to);
    return sendJson(res, 200, switchTo(to, fromSessionId, "主人手动换了角色"));
  }
  if (p === "/api/xk/order" && req.method === "PUT") {
    const { order } = await json(req);
    if (!Array.isArray(order) || order.length !== ROLES.length || ROLES.some((r) => !order.includes(r.id))) throw httpError(400, "顺序要把三个角色各列一次");
    STATE.order = order; saveState();
    return sendJson(res, 200, { ok: true, order });
  }
  return NEXT;
});

// ── App 更新源（外壳 Xk.java 读同一个文件）──
const FEED = path.join(XK_HOME, "update-feed");
const DEFAULT_FEED = "https://api.github.com/repos/snodgrasssanderfer-source/cccodroid/releases?per_page=30";
addRoute(async (req, res, u, p) => {
  if (p !== "/api/xk/update-feed") return NEXT;
  if (req.method === "GET") {
    const cur = fs.existsSync(FEED) ? fs.readFileSync(FEED, "utf8").trim() : "";
    return sendJson(res, 200, { feed: cur || DEFAULT_FEED, default: DEFAULT_FEED });
  }
  if (req.method === "PUT") {
    const { feed } = await json(req);
    const v = String(feed || "").trim();
    if (v && !/^https:\/\//.test(v)) throw httpError(400, "更新源要以 https:// 开头");
    if (v) fs.writeFileSync(FEED, v + "\n"); else fs.rmSync(FEED, { force: true });
    return sendJson(res, 200, { ok: true, feed: v || DEFAULT_FEED });
  }
  return NEXT;
});

export async function routeXk(req, res, u, p) {
  if (!p.startsWith("/api/xk/") && p !== "/api/chat" && p !== "/api/session-model") return NEXT;   // session-model：输入栏换型号要先看是不是换了人
  try {
    for (const r of ROUTES) if ((await r(req, res, u, p)) !== NEXT) return;
  } catch (e) {
    if (!res.headersSent) return sendJson(res, e.status || 500, { error: e.message });
    throw e;
  }
  return NEXT;
}

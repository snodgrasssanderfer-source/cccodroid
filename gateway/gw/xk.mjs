// 小克：网关里我们自己加的全部功能从这里进。server.mjs 只多了一行 import 和 ROUTES 里的 routeXk（排第一，要先看 /api/chat）。
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { LIVE, log } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { publish } from "./bus.mjs";
import { START_GUARDS, enqueue, routeQueue } from "./queue.mjs";
import { RUNS } from "./runs.mjs";
import { ROLES, ensureRoles, importPersona, importWorldbook, personaStatus, roleById, roleDir, roleOfSession } from "./xk-roles.mjs";
import { ENGINE_RUN, PLANNERS, ROUTES, STATE, XK_HOME, addRoute, carryText, httpError, json, projectOf, roleOfProject, saveState, selfApi, writeCarry } from "./xk-core.mjs";
import "./xk-memory.mjs";
import { handoverRoles } from "./xk-handover.mjs";
import { effectiveModel, routeSessModel } from "./sessmodel.mjs";
import { sidOfAgyRun } from "./xk-agy.mjs";
import "./xk-diary.mjs";

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
addRoute(async (req, res, u, p) => {
  if (p !== "/api/chat" || req.method !== "POST") return NEXT;
  const raw = await readBody(req);
  let b;
  try { b = JSON.parse(raw || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
  const ctx = { body: { ...b }, role: null, carry: null, notice: null };
  if (!b.sessionId && !b.follow) {
    // 新会话首条带的模型选了另一家（输入栏里换了型号）：模型和人设绑定，落到那家对应的角色
    const byPin = b.pin && roleOfProvider(b.pin.provider);
    if (byPin && byPin.id !== roleOfProject(b.projectId)?.id) { ctx.body.projectId = projectOf(byPin.id); STATE.active = byPin.id; saveState(); }
    // 新会话没指定项目：落到当前角色
    if (!ctx.body.projectId && projectOf(STATE.active)) ctx.body.projectId = projectOf(STATE.active);
    ctx.role = roleOfProject(ctx.body.projectId)?.id || null;
    // 主人手动切过来的：带上切换前那段对话
    if (ctx.role && STATE.pending[ctx.role]) { ctx.carry = STATE.pending[ctx.role]; delete STATE.pending[ctx.role]; saveState(); }
  } else {
    // 只带 follow（新会话还没拿到会话号时发的下一条）：前一轮是哈基米的，就是她那个会话
    const sid = b.sessionId || (b.follow ? sidOfAgyRun(b.follow) : null);
    if (sid && !b.sessionId) { ctx.body.sessionId = sid; ctx.body.follow = null; }
    ctx.role = roleOfSession(sid)?.id || null;
  }
  for (const plan of PLANNERS) await plan(b, ctx);
  const role = roleById(ctx.role);
  if (role && role.engine !== "claude") {
    // 哈基米这类不走 Claude Code 的角色：交给它自己的驱动，界面收到的事件和普通轮次一样
    if (!String(ctx.body.message || "").trim()) return sendJson(res, 400, { error: "empty message" });
    const item = { id: "xa" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), message: String(ctx.body.message), sessionId: ctx.body.sessionId || null };
    ctx.onQueued?.(item);
    if (ctx.notice) publish({ type: "xk", op: "handover", runId: item.id, ...ctx.notice });
    ENGINE_RUN[role.engine](item, { carry: ctx.carry ? carryText(ctx.carry.fromSid, ctx.carry.fromRole, role.id, ctx.carry.reason) : "" });
    return sendJson(res, 200, { ok: true, id: item.id, injected: false, started: true, xk: ctx.notice });
  }
  if (!ctx.carry) return routeQueue(fakeReq(req, JSON.stringify(ctx.body)), res, u, p);
  // 要带接班说明：自己入队，拿到 run 号立刻写说明（startRun 起进程前还有好几次 await，一定赶得上）
  if (!String(ctx.body.message || "").trim()) return sendJson(res, 400, { error: "empty message" });
  const item = enqueue({ ...ctx.body, internal: false, auto: undefined });
  writeCarry(ctx.role, item.id, carryText(ctx.carry.fromSid, ctx.carry.fromRole, ctx.role, ctx.carry.reason));
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

// ── 输入栏换型号：选了另一个角色那家的模型，就换成那个角色（开新会话，带上这段对话），原会话不动 ──
const roleOfProvider = (pid) => (pid ? ROLES.find((r) => r.provider === pid) || null : null);
function switchTo(to, fromSessionId, reason) {
  STATE.active = to;
  const fromRole = fromSessionId ? roleOfSession(fromSessionId)?.id || null : null;
  if (fromSessionId && fromRole !== to) STATE.pending[to] = { fromSid: fromSessionId, fromRole, reason };
  saveState();
  return { ok: true, active: to, projectId: projectOf(to) };
}
addRoute(async (req, res, u, p) => {
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
    return sendJson(res, 200, { role: r ? r.id : null, active: STATE.active, origin: sid ? STATE.origin[sid] || null : null });
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

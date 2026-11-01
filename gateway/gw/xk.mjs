// 小克：网关里我们自己加的全部功能从这里进。server.mjs 只多了一行 import 和 ROUTES 里的 routeXk（排第一，要先看 /api/chat）。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { CFG, LIVE, log } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { TOKEN } from "./access.mjs";
import { publish } from "./bus.mjs";
import { enqueue, routeQueue } from "./queue.mjs";
import { RUNS } from "./runs.mjs";
import { ROLES, ensureRoles, importPersona, importWorldbook, personaStatus, roleById, roleDir, roleOfDir, roleOfSession } from "./xk-roles.mjs";
import { recentText } from "./xk-transcript.mjs";

export const XK_HOME = path.join(CFG.home, ".config", "xiaoke");
fs.mkdirSync(XK_HOME, { recursive: true });

// ── 状态：当前角色、接班顺序、冷却、会话从哪个角色接过来 ──
const STATE_FILE = path.join(XK_HOME, "state.json");
export const STATE = { active: "xiaoke", order: ["xiaoke", "hachimi", "deepseek"], projects: {}, cooldown: {}, origin: {}, pending: {} };
try { Object.assign(STATE, JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); } catch (e) { if (e.code !== "ENOENT") throw new Error("小克状态文件坏了：" + e.message); }
export function saveState() { fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(STATE, null, 1)); fs.renameSync(STATE_FILE + ".tmp", STATE_FILE); }

// 各模块往这里挂：handlers(req, res, u, p) 不认领就返回 NEXT
const ROUTES = [];
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

/** 三个角色各自对应一个上游项目（目录、默认服务商）。项目号记在状态里，接班和切换靠它 */
async function ensureProjects() {
  const { projects } = await selfApi("GET", "/api/projects");
  for (const r of ROLES) {
    const dir = fs.realpathSync(roleDir(r.id));
    let p = projects.find((x) => x.path === dir);
    if (!p) p = (await selfApi("POST", "/api/projects", { name: r.name, mode: "dir", path: dir })).project;
    // 只在主人没设过时给默认服务商，设过就尊重主人的
    if (r.provider && !p.provider) p = (await selfApi("PATCH", "/api/projects/" + encodeURIComponent(p.id), { provider: r.provider })).project;
    STATE.projects[r.id] = p.id;
  }
  saveState();
}
export const projectOf = (id) => STATE.projects[id] || null;
export const roleOfProject = (pid) => ROLES.find((r) => STATE.projects[r.id] === pid) || null;

if (LIVE) {
  ensureRoles();
  // 等主地址监听上了再调自己的接口
  setTimeout(() => ensureProjects().catch((e) => log("⚠️ 小克建角色项目失败：" + e.message)), 1500).unref();
}

// ── 接班说明：带上来源会话最近几轮，写进新会话第一轮的 run 号下，由 xk-hook.mjs 注入（只带一次） ──
export function carryText(fromSid, fromRole, toRole, reason) {
  const talk = fromSid ? recentText(fromSid, 6, { assistant: fromRole ? roleById(fromRole).name : "她" }) : "";
  return `（接班说明，给你自己看的）主人刚才在和${fromRole ? roleById(fromRole).name : "另一位"}聊，${reason}，现在换成你接着聊。` +
    (talk ? `下面是刚才最近几轮，只是让你知道在聊什么；这不是你的记忆，你用自己的人设和记忆回应：\n${talk}` : "");
}
export function writeCarry(role, runId, text) {
  const f = path.join(roleDir(role), ".xk", "carry", runId + ".md");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text + "\n");
}

// ── /api/chat：先决定这条消息该落到哪个角色，再交给上游原样处理 ──
// planners(b, ctx) 可以改 ctx：{ body, role, carry: {fromSid, fromRole, reason}, notice }。接班模块会往这里加
export const PLANNERS = [];
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
    // 新会话没指定项目：落到当前角色
    if (!b.projectId && projectOf(STATE.active)) ctx.body.projectId = projectOf(STATE.active);
    ctx.role = roleOfProject(ctx.body.projectId)?.id || null;
    // 主人手动切过来的：带上切换前那段对话
    if (ctx.role && STATE.pending[ctx.role]) { ctx.carry = STATE.pending[ctx.role]; delete STATE.pending[ctx.role]; saveState(); }
  } else ctx.role = roleOfSession(b.sessionId)?.id || null;
  for (const plan of PLANNERS) await plan(b, ctx);
  if (!ctx.carry) return routeQueue(fakeReq(req, JSON.stringify(ctx.body)), res, u, p);
  // 要带接班说明：自己入队，拿到 run 号立刻写说明（startRun 起进程前还有好几次 await，一定赶得上）
  if (!String(ctx.body.message || "").trim()) return sendJson(res, 400, { error: "empty message" });
  const item = enqueue({ ...ctx.body, internal: false, auto: undefined });
  writeCarry(ctx.role, item.id, carryText(ctx.carry.fromSid, ctx.carry.fromRole, ctx.role, ctx.carry.reason));
  if (ctx.notice) publish({ type: "xk", op: "handover", runId: item.id, ...ctx.notice });
  return sendJson(res, 200, { ok: true, id: item.id, injected: !!item.injected, started: RUNS.has(item.id), xk: ctx.notice });
});

// ── 角色、人设、世界书、手动切换 ──
addRoute(async (req, res, u, p) => {
  if (p === "/api/xk/roles" && req.method === "GET")
    return sendJson(res, 200, { active: STATE.active, order: STATE.order, roles: ROLES.map((r) => ({ ...r, projectId: projectOf(r.id), cooldown: STATE.cooldown[r.id] || null, ...personaStatus(r.id) })) });
  let m = p.match(/^\/api\/xk\/roles\/([a-z]+)\/persona$/);
  if (m && req.method === "PUT") return sendJson(res, 200, importPersona(m[1], (await json(req)).text || ""));
  if (p === "/api/xk/worldbook" && req.method === "PUT") return sendJson(res, 200, importWorldbook((await json(req)).text || ""));
  if (p === "/api/xk/session-role" && req.method === "GET") {
    const sid = u.searchParams.get("sid");
    const r = sid ? roleOfSession(sid) : roleById(STATE.active);
    return sendJson(res, 200, { role: r ? r.id : null, active: STATE.active, origin: sid ? STATE.origin[sid] || null : null });
  }
  if (p === "/api/xk/switch" && req.method === "POST") {
    // 手动切换：之后的新会话落到这个角色；从某个会话切过来的，第一条消息带上那段对话
    const { to, fromSessionId } = await json(req);
    if (!roleById(to)) throw httpError(404, "没有这个角色：" + to);
    STATE.active = to;
    const fromRole = fromSessionId ? roleOfSession(fromSessionId)?.id || null : null;
    if (fromSessionId && fromRole !== to) STATE.pending[to] = { fromSid: fromSessionId, fromRole, reason: "主人手动换了角色" };
    saveState();
    return sendJson(res, 200, { ok: true, active: to, projectId: projectOf(to) });
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
const DEFAULT_FEED = "https://api.github.com/repos/snodgrasssanderfer-source/xiaoke-ccc/releases?per_page=30";
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
  if (!p.startsWith("/api/xk/") && p !== "/api/chat") return NEXT;
  try {
    for (const r of ROUTES) if ((await r(req, res, u, p)) !== NEXT) return;
  } catch (e) {
    if (!res.headersSent) return sendJson(res, e.status || 500, { error: e.message });
    throw e;
  }
  return NEXT;
}

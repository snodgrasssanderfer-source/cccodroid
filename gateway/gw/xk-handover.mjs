// 接班：一个角色额度用完，按顺序换到下一个角色，在新角色的项目里开新会话、带上刚才那段对话；原角色额度恢复后，下一条新消息交回去。
// 判定额度用完的两种信号（审计报告第 3 项实测）：API Key / 第三方接口是 HTTP 429；订阅账号是 rate_limit_event 且 status=rejected。
import { log } from "./config.mjs";
import { onPublish, publish } from "./bus.mjs";
import { END_HOOKS, enqueue } from "./queue.mjs";
import { keyOf, providerById } from "./providers.mjs";
import { isLoginMode } from "./models.mjs";
import { RATE_LIMITS } from "./stream.mjs";
import { projectById } from "./projects.mjs";
import { ROLES, roleById, roleOfDir } from "./xk-roles.mjs";
import { ENGINE_RUN, ENGINES, INTERNAL, PLANNERS, STATE, carryText, projectOf, saveState, writeCarry } from "./xk-core.mjs";

STATE.originRun ||= {};   // run 号 → { from, reason }：接班开的新会话拿到会话号后转进 STATE.origin

// 不知道什么时候重置（第三方接口的 429 不带重置时间）时，过一小时再让原角色试一次
const RETRY_MS = 60 * 60 * 1000;
// RESOURCE_EXHAUSTED / quota：agy（Gemini）额度用完时的说法
const LIMIT_TEXT = /\b429\b|rate[ _-]?limit|usage limit|resource[ _-]?exhausted|quota|额度/i;

const errors = new Map();   // run 号 → 这一轮报的错
onPublish((ev) => {
  if (ev.type === "error" && ev.runId) errors.set(ev.runId, String(ev.message || ""));
  if (ev.type === "init" && ev.runId && STATE.originRun[ev.runId]) {
    STATE.origin[ev.sessionId] = STATE.originRun[ev.runId];
    delete STATE.originRun[ev.runId];
    saveState();
  }
});

export const cooling = (id, now = Date.now()) => {
  const c = STATE.cooldown[id];
  if (c && c.until <= now) { delete STATE.cooldown[id]; saveState(); return null; }
  return c || null;
};

/** 角色现在能不能接：服务商配好了（订阅登录或有 Key）、引擎就绪、额度没在冷却 */
export function roleReady(role) {
  if (cooling(role.id)) return false;
  if (role.engine !== "claude") return !!(ENGINES[role.engine] && ENGINES[role.engine]());
  // 主人可能在项目里换过服务商：以项目当前的为准
  const p = providerById(projectById(projectOf(role.id))?.provider || role.provider);
  return !!p && (p.login || !!keyOf(p));
}

/** 顺序里排在 from 后面的第一个能接的（转一圈，不回到自己） */
export function nextRole(from) {
  const order = STATE.order;
  const i = order.indexOf(from);
  for (let k = 1; k < order.length; k++) {
    const r = roleById(order[(i + k) % order.length]);
    if (r && roleReady(r)) return r;
  }
  return null;
}

/** 这一轮是不是因为额度用完而失败；是的话返回 { until, reason } */
export function limitHit(run, f, rl = RATE_LIMITS, err = errors.get(run.id) || "") {
  if (!(f.isError || f.failed)) return null;
  const p = providerById(run.provider);
  const sub = p && isLoginMode(p) && rl && rl.status === "rejected" && rl.at >= run.startedAt;
  if (!sub && !LIMIT_TEXT.test(err)) return null;
  // 订阅：取被拒的那个窗口的重置时间（秒或毫秒都认）
  const ms = (t) => (t ? (t < 1e12 ? t * 1000 : t) : 0);
  const until = sub ? Math.max(ms(rl.fiveHour?.used >= 100 && rl.fiveHour.resetsAt), ms(rl.sevenDay?.used >= 100 && rl.sevenDay.resetsAt)) || Date.now() + RETRY_MS : Date.now() + RETRY_MS;
  return { until, reason: sub ? "订阅额度用完了" : "接口返回额度用完（429）" };
}

const fmt = (t) => new Date(t).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 起一个接班轮：新角色的项目里开新会话，原话再发一遍，接班说明按 run 号注入一次 */
function handOver(fromRole, toRole, fromSid, message, reason) {
  const carry = carryText(fromSid, fromRole.id, toRole.id, reason);
  let item;
  if (toRole.engine === "claude") { item = enqueue({ message, projectId: projectOf(toRole.id) }); writeCarry(toRole.id, item.id, carry); }
  else { item = { id: "xa" + Date.now().toString(36), message, sessionId: null }; setImmediate(() => ENGINE_RUN[toRole.engine](item, { carry })); }
  STATE.originRun[item.id] = { from: fromRole.id, reason, at: Date.now() };
  saveState();
  publish({ type: "xk", op: "handover", runId: item.id, from: fromRole.id, to: toRole.id, reason, fromSession: fromSid });
  log(`🔁 接班：${fromRole.name} → ${toRole.name}（${reason}）`);
  return item;
}

END_HOOKS.push((run, f) => {
  const role = roleOfDir(run.cwd);
  const err = errors.get(run.id);
  errors.delete(run.id);
  if (!role) return;
  const hit = limitHit(run, f, RATE_LIMITS, err || "");
  if (!hit) return;
  STATE.cooldown[role.id] = { until: hit.until, reason: hit.reason, at: Date.now() };
  saveState();
  if (INTERNAL.has(run.id) || run.sched || run.auto) return;   // 整理、日记这类没人等着的：只记冷却，日记自己会补写
  const next = nextRole(role.id);
  if (!next) {
    publish({ type: "xk", op: "handover_none", from: role.id, reason: hit.reason + "，其他角色也接不了" });
    return;
  }
  handOver(role, next, run.sessionId, run.text, `${role.name}的${hit.reason}，${fmt(hit.until)} 左右恢复`);
});

// 主人发来的消息：落到冷却中的角色就直接换人；接班会话里原角色恢复了，就交回去
PLANNERS.push((b, ctx) => {
  const role = ctx.role && roleById(ctx.role);
  if (!role || !String(b.message || "").trim() || /^\//.test(String(b.message).trim())) return;
  const sid = b.sessionId || null;
  const origin = sid && STATE.origin[sid];
  let to = null, reason = "";
  if (origin && origin.from !== role.id && roleReady(roleById(origin.from))) {
    to = roleById(origin.from);
    reason = `${to.name}的额度恢复了，交回给${to.name}`;
  } else if (cooling(role.id)) {
    to = nextRole(role.id);
    reason = `${role.name}的额度还没恢复（${fmt(STATE.cooldown[role.id].until)} 左右）`;
  }
  if (!to) return;
  ctx.body = { ...ctx.body, sessionId: null, follow: null, projectId: projectOf(to.id) };
  ctx.carry = sid ? { fromSid: sid, fromRole: role.id, reason } : ctx.carry || { fromSid: null, fromRole: role.id, reason };
  ctx.notice = { from: role.id, to: to.id, reason, fromSession: sid };
  ctx.role = to.id;
  ctx.onQueued = (item) => {
    if (origin && to.id === origin.from) return;   // 交回原角色：新会话不算接班会话
    STATE.originRun[item.id] = { from: role.id, reason, at: Date.now() };
    saveState();
  };
});

export const handoverRoles = () => ROLES.map((r) => ({ id: r.id, ready: roleReady(r), cooldown: cooling(r.id) }));

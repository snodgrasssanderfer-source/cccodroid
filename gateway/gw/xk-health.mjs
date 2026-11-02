// 三人健康卡（#15）：她们能不能说话、接班、写日记，不行的原因和去处理的地方。
// 四件事原本散在设置 → 后台与并行、设置 → 设备与权限、定时任务页、哈基米卡片里，这里只读、不改，凑成一张卡。
import fs from "node:fs";
import { NEXT, sendJson } from "./http.mjs";
import { keyOf, providerById } from "./providers.mjs";
import { projectById } from "./projects.mjs";
import { ROLES, roleOfSession } from "./xk-roles.mjs";
import { STATE, addRoute, projectOf, selfApi } from "./xk-core.mjs";
import { cooling } from "./xk-handover.mjs";
import { AGY } from "./xk-agy.mjs";

const hm = (t) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

/** 能不能说话（也就是能不能接班）：不能就给原因和去处理的地方 */
function talk(r) {
  const c = cooling(r.id);
  if (c) return { why: `额度用完了，约 ${hm(c.until)} 恢复`, art: "quota_low" };
  if (r.engine === "agy") {
    if (!fs.existsSync(AGY)) return { why: "还没装 Antigravity", fix: { act: "role", id: r.id } };
    if (STATE.agyVerify) return { why: "Google 要求先验证账号", fix: { act: "verify", url: STATE.agyVerify.url }, art: "hachimi_verify" };
    if (STATE.agyAuth === false) return { why: "Google 没登录", fix: { act: "role", id: r.id } };
    return null;
  }
  const p = providerById(projectById(projectOf(r.id))?.provider || r.provider);
  if (!p) return { why: "没配接口", fix: { act: "provider" } };
  if (!p.login && !keyOf(p)) return { why: `${p.label || p.id} 还没填 Key`, fix: { act: "provider" } };
  return null;
}

/** 能不能写日记：Claude Code 的角色靠上游定时任务；哈基米由网关自己起，能说话就能写 */
function diary(r, sched) {
  if (r.engine === "agy") return null;
  const t = sched && sched.tasks.find((x) => x.id === STATE.diaryTasks[r.id]);
  if (!sched) return { why: "读不到定时任务" };
  if (!t) return { why: "日记的定时任务还没建好", fix: { act: "sched" } };
  if (t.on === false) return { why: "日记的定时任务关着", fix: { act: "sched" }, art: "diary_blocked" };
  if (sched.loginTasks.includes(t.id) && !sched.allowLogin) return { why: "定时任务不许用订阅账户跑", fix: { act: "sched" }, art: "diary_blocked" };
  return null;
}

const SHZ = { not_installed: "没装 Shizuku", not_running: "Shizuku 没在运行（重启手机后要在 Shizuku 里重新启动）", no_permission: "Shizuku 还没授权给小克" };

export async function health(get = (p) => selfApi("GET", p)) {
  const [sched, priv] = await Promise.all([get("/api/sched").catch(() => null), get("/api/priv/status").catch(() => ({}))]);
  const roles = ROLES.map((r) => {
    const t = talk(r);
    return { id: r.id, talk: t, diary: t || diary(r, sched) };
  });
  const device = [];
  const fz = priv.frozen;
  if (fz && fz.count > 0) device.push({ id: "frozen", why: `系统在后台冻结过小克 ${fz.count} 次（最近约 ${Math.round(fz.ms / 1000)} 秒）：夜里写日记、空闲整理记忆会停住`, fix: { act: "settings", cat: "run" }, art: "frozen" });
  if (SHZ[priv.state]) device.push({ id: "shizuku", why: SHZ[priv.state], fix: { act: "settings", cat: "device" }, art: "shizuku_off" });
  return { ok: !device.length && roles.every((x) => !x.talk && !x.diary), roles, device };
}

// ── 用量按人分（#11）：上游只记总数和每段会话的 token，这里把会话归到角色上加起来。
//    哈基米走 agy，不经过上游的运行记录，没有数字（界面上照实说）
const SID_ROLE = new Map();   // 会话归属不会变，认过一次就记住（会话多时每次都翻记录太慢）
function sidRole(sid) {
  if (!SID_ROLE.has(sid)) { let r = null; try { r = roleOfSession(sid); } catch {} SID_ROLE.set(sid, r ? r.id : null); }
  return SID_ROLE.get(sid);
}
export function usageByRole(hours, now = Date.now()) {
  const h0 = Math.floor(now / 3600e3), d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const since = { today: Math.floor(d0.getTime() / 3600e3), week: h0 - 7 * 24, month: h0 - 30 * 24 };
  const out = Object.fromEntries(ROLES.map((r) => [r.id, { today: 0, week: 0, month: 0 }]));
  for (const [k, b] of Object.entries(hours || {})) {
    for (const [sid, tok] of Object.entries(b.st || {})) {
      const o = out[sidRole(sid)];
      if (o) for (const w in since) if (+k >= since[w]) o[w] += tok;
    }
  }
  return out;
}

addRoute(async (req, res, u, p) => {
  if (p === "/api/xk/health" && req.method === "GET") return sendJson(res, 200, await health());
  if (p === "/api/xk/usage" && req.method === "GET") {
    const us = await selfApi("GET", "/api/usage");
    return sendJson(res, 200, { off: !!us.off, roles: usageByRole(us.hours) });
  }
  return NEXT;
});

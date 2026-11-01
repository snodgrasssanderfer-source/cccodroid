// 记忆的网关一侧：对话停下 10 分钟后自动整理一遍（不只靠她当场调 remember），以及界面上看、改、删。
import fs from "node:fs";
import path from "node:path";
import { LIVE, log } from "./config.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { publish } from "./bus.mjs";
import { END_HOOKS } from "./queue.mjs";
import { trashSession } from "./sessionops.mjs";
import { findSessionFile } from "./sessions.mjs";
import { roleById, roleDir, roleOfDir, roleOfSession } from "./xk-roles.mjs";
import { turns } from "./xk-transcript.mjs";
import { load, remove, today, update } from "./xk-memstore.mjs";
import { INTERNAL, STATE, addRoute, httpError, internalRun, json, projectOf, saveState } from "./xk-core.mjs";

// 停多久算「这段聊完了」：太短会把一段话拆成好几次整理，太长主人第二天回来时还没记
const IDLE_MS = 10 * 60 * 1000;
STATE.memDirty ||= {};   // 会话号 → 最后一轮结束时刻（还没整理）
STATE.memDone ||= {};    // 会话号 → 整理到哪个时刻

/** 这一轮属于哪个渠道：App 是默认；QQ 接入（第二阶段）入队时调它，MCP 服务和日记按 run 号读 */
export function markRun(role, runId, info) {
  const f = path.join(roleDir(role), ".xk", "runs", runId + ".json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(info));
}

const timers = new Map();
function arm(sid, at) {
  clearTimeout(timers.get(sid));
  const t = setTimeout(() => { timers.delete(sid); consolidate(sid); }, Math.max(0, at + IDLE_MS - Date.now()));
  t.unref?.();
  timers.set(sid, t);
}

export function consolidate(sid) {
  const role = roleOfSession(sid);
  if (!role || role.engine !== "claude") { delete STATE.memDirty[sid]; saveState(); return null; }   // 哈基米的整理由 xk-agy 自己做
  const since = STATE.memDone[sid] || 0;
  const talk = turns(sid, since);
  if (!talk.some((t) => t.role === "user")) { delete STATE.memDirty[sid]; saveState(); return null; }
  const until = talk[talk.length - 1].at;
  const text = talk.map((t) => `${t.role === "user" ? "主人" : "你"}（${new Date(t.at).toLocaleString("zh-CN", { hour12: false })}）：${t.text}`).join("\n");
  const message = `今天是 ${today()}。下面是你和主人刚才的一段对话。整理你的长期记忆：\n` +
    `1. 先用 recall 查查相关的旧记忆，避免重复。\n` +
    `2. 把以后用得上的事实、发生的事、计划、你自己的看法用 remember 记下来，日期都写成具体日期（"昨天""下周"换算好），who 写清是谁的事或看法。\n` +
    `3. 和旧记忆冲突、或事情变了的：记新的，并把旧记忆的 id 放进 ends。\n` +
    `4. 只记对话里真有的；闲聊客套、你刚才已经记过的就不用再记。做完回复"整理好了"。\n\n---\n${text}`;
  const item = internalRun("memory", {
    message, projectId: projectOf(role.id), permissionMode: "default",
    allowedTools: ["mcp__xk-memory__remember", "mcp__xk-memory__recall", "mcp__xk-memory__forget"], timeoutMs: 5 * 60000,
  }, { sid, until, role: role.id });
  log(`🧠 整理记忆：${role.name} 会话 ${String(sid).slice(0, 8)}（${talk.length} 段）`);
  return item;
}

END_HOOKS.push((run, f) => {
  const job = INTERNAL.get(run.id);
  if (job) {
    if (job.kind !== "memory") return;
    INTERNAL.delete(run.id);
    // 整理用的那个会话不留在列表里
    if (run.sessionId && findSessionFile(String(run.sessionId))) { try { trashSession(run.sessionId); } catch (e) { log("整理会话收进回收站失败：" + e.message); } }
    if (f.failed || f.isError || run.aborted || run.timedOut) {
      log(`⚠️ 整理记忆失败（${job.role}）：${f.resultText || f.subtype || "没有结果"}`);
      publish({ type: "xk", op: "memory_failed", role: job.role, error: String(f.resultText || "整理没有完成") });
      return;   // 留着 memDirty，下次这个会话再有新消息时一起整理
    }
    STATE.memDone[job.sid] = job.until;
    delete STATE.memDirty[job.sid];
    saveState();
    return;
  }
  if (run.sched || run.auto || !run.sessionId || !roleOfDir(run.cwd)) return;
  STATE.memDirty[run.sessionId] = Date.now();
  saveState();
  arm(run.sessionId, Date.now());
});

if (LIVE) for (const [sid, at] of Object.entries(STATE.memDirty)) arm(sid, at);   // 网关重启前没整理完的接着等

// ── 界面：看、改、删 ──
addRoute(async (req, res, u, p) => {
  if (p === "/api/xk/memory" && req.method === "GET") {
    const role = roleById(u.searchParams.get("role"));
    if (!role) throw httpError(404, "没有这个角色");
    return sendJson(res, 200, { role: role.id, items: load(roleDir(role.id)).sort((a, b) => b.date.localeCompare(a.date) || b.updated - a.updated) });
  }
  const m = p.match(/^\/api\/xk\/memory\/([a-z]+)\/([0-9a-f]+)$/);
  if (!m) return NEXT;
  const role = roleById(m[1]);
  if (!role) throw httpError(404, "没有这个角色");
  if (req.method === "PATCH") return sendJson(res, 200, update(roleDir(role.id), m[2], await json(req)));
  if (req.method === "DELETE") return sendJson(res, 200, remove(roleDir(role.id), m[2]));
  return NEXT;
});

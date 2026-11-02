// 留言板在网关这边的部分：界面接口，和「下班补一张」（主人 11-02 定的）。
// 她们平时自己用 board_write 写；交回、被换走时，如果这一班主人跟她说过话、她却一张没写：
//   还有额度 → 网关补跑一轮让她写（给她这一班最近的对话）；
//   额度用完了（正是因为这个才换人）→ 她写不了，网关从对话里摘一份，标明是摘的。
import { log } from "./config.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { publish } from "./bus.mjs";
import { END_HOOKS } from "./queue.mjs";
import { trashSession } from "./sessionops.mjs";
import { findSessionFile } from "./sessions.mjs";
import { ROLES_DIR, roleById } from "./xk-roles.mjs";
import { ENGINE_RUN, INTERNAL, SHIFT_END, STATE, addRoute, httpError, internalRun, json, projectOf, saveState } from "./xk-core.mjs";
import { cooling } from "./xk-handover.mjs";
import { recentText, turns } from "./xk-transcript.mjs";
import { WHO, list, post, remove, toId } from "./xk-board.mjs";

/** from 从会话 sid 下班、换成 to。返回做了什么（测试看） */
export function shiftEnd({ from, to, sid, reason }) {
  const role = roleById(from);
  if (!role || !sid || from === to) return null;
  // 上一张便条（或上回问过她）之后主人没跟她说过话：没什么好交代的。
  // 问过她、她说没什么要交代的，也算数——不然主人来回换人，每换一次都多跑一轮
  STATE.boardAsked ||= {};
  const last = Math.max(STATE.boardAsked[from] || 0, ...list(ROLES_DIR).filter((n) => n.from === from).map((n) => n.at));
  if (!turns(sid, last + 1).some((t) => t.role === "user")) return null;
  STATE.boardAsked[from] = Date.now(); saveState();
  const toName = to ? roleById(to)?.name || "下一位" : "下一位";
  if (cooling(from)) {
    const talk = recentText(sid, 2, { assistant: role.name }, 1200);
    const n = post(ROLES_DIR, { from, to: to || null, auto: true, text: `${role.name}额度用完了，换成${toName}。她最后在聊的：\n${talk}` });
    publish({ type: "xk", op: "board", note: n });
    return { auto: n };
  }
  const message = `你刚下班：${reason || "主人换了人"}，接下来是${toName}陪主人。下面是你这一班最近的对话。\n` +
    `如果主人交代过事（要办的、办到一半的、答应了的），用 board_write 给${toName}留一张便条：交代了什么、办到哪一步、还差什么、要提醒的。结论放前面，几句话就够，不抄你的私人记忆。\n` +
    `只是闲聊、没有要接着做的，就不用写，回复"没什么要交代的"。\n\n---\n` + recentText(sid, 8, { assistant: "你" }, 6000);
  let item;
  if (role.engine === "claude") item = internalRun("board", {
    message, projectId: projectOf(from), permissionMode: "default",
    allowedTools: ["mcp__xk-memory__board_write", "mcp__xk-memory__board_read", "mcp__xk-memory__recall"], timeoutMs: 3 * 60000,
  }, { role: from });
  else {
    item = { id: "xa" + Date.now().toString(36) + "b", message, sessionId: null };
    INTERNAL.set(item.id, { kind: "board", role: from });
    ENGINE_RUN[role.engine](item, { internal: true });
  }
  log(`📌 ${role.name}下班，补一张便条（会话 ${String(sid).slice(0, 8)}）`);
  return { run: item };
}
SHIFT_END.push((x) => { try { shiftEnd(x); } catch (e) { log("⚠️ 下班便条没留成：" + e.message); publish({ type: "xk", op: "board", error: `${roleById(x.from)?.name || x.from}的下班便条没留成：${e.message}` }); } });

END_HOOKS.push((run, f = {}) => {
  const job = INTERNAL.get(run.id);
  if (!job || job.kind !== "board") return;
  INTERNAL.delete(run.id);
  // 补写便条用的那段会话不留在列表里（和整理记忆一样）
  if (run.sessionId && findSessionFile(String(run.sessionId))) { try { trashSession(run.sessionId); } catch (e) { log("便条会话收进回收站失败：" + e.message); } }
  if (f.isError || f.failed) publish({ type: "xk", op: "board", error: `${roleById(job.role).name}的下班便条没写成` });
  else publish({ type: "xk", op: "board" });
});

// ── 界面：看全部、主人贴一张、撕掉一张 ──
addRoute(async (req, res, u, p) => {
  if (p === "/api/xk/board" && req.method === "GET") return sendJson(res, 200, { notes: list(ROLES_DIR), who: WHO });
  if (p === "/api/xk/board" && req.method === "POST") {
    const b = await json(req);
    let n; try { n = post(ROLES_DIR, { from: "owner", to: toId(b.to), text: b.text }); } catch (e) { throw httpError(400, e.message); }
    publish({ type: "xk", op: "board", note: n });
    return sendJson(res, 200, { ok: true, note: n });
  }
  const m = p.match(/^\/api\/xk\/board\/([a-z0-9]+)$/);
  if (m && req.method === "DELETE") { try { remove(ROLES_DIR, m[1]); } catch (e) { throw httpError(404, e.message); } return sendJson(res, 200, { ok: true }); }
  return NEXT;
});

// 上下文占到线就自动换新对话（#72，主人 11-03 定的）：不压缩，直接换一段新会话，把上一段最后几轮带过去。
// 记占用：小克 / 小鱼用每轮的 f.usage（context_tokens / context_window）；
// 哈基米走 agy 的 stdout 没有 usage，但 agy 自己把每轮真实 token 写进了本地日志，读最后一条就够；
// 日志找不到（老会话、还没跑完）才退回按会话记录的字数估。
import fs from "node:fs";
import path from "node:path";
import { CFG } from "./config.mjs";
import { END_HOOKS } from "./queue.mjs";
import { STATE, saveState } from "./xk-core.mjs";
import { roleOfDir } from "./xk-roles.mjs";
import { turns } from "./xk-transcript.mjs";

export const ROLLOVER_AT = 0.2;          // 默认占到两成就换
// 单独定的线：哈基米 60%（主人 11-03 定的；agy 没有对外暴露的压缩线，就按这个换）
export const ROLLOVER_AT_BY_ROLE = { hachimi: 0.6 };
export const AGY_WINDOW = 1_000_000;     // agy 拿不到 context_window，按 1M 算；换模型时窗口不同要再对
const AGY_BRAIN = path.join(CFG.home, ".gemini", "antigravity-cli", "brain");

/** 这个角色的换新线：单独定过的照单独，没写的照默认 */
export const rolloverAt = (roleId) => ROLLOVER_AT_BY_ROLE[roleId] ?? ROLLOVER_AT;

STATE.rollover ||= {};                    // 角色 → { sid, pct }：这一段该换新对话了

// 哈基米（agy）：日志里每条 PLANNER_RESPONSE 带 input_tokens / cache_read_tokens / output_tokens。
// 注意 input_tokens 只是没命中缓存的那部分，实际上下文是三者相加；只读 input_tokens 会小一个数量级。
export function agyTokens(sessionId, brain = AGY_BRAIN) {
  const conv = sessionId && STATE.agyConv && STATE.agyConv[sessionId];
  if (!conv) return 0;
  const p = path.join(brain, String(conv), ".system_generated", "logs", "transcript.jsonl");
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch { return 0; }
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
    if (ev.type !== "PLANNER_RESPONSE") continue;
    const n = (Number(ev.input_tokens) || 0) + (Number(ev.cache_read_tokens) || 0) + (Number(ev.output_tokens) || 0);
    if (n > 0) return n;
  }
  return 0;
}

/** agy 这一轮的 usage：卡片和换新线共用同一份数，免得两边对不上；拿不到就 null */
export function agyUsage(sessionId, brain = AGY_BRAIN) {
  const used = agyTokens(sessionId, brain);
  return used > 0 ? { context_tokens: used, context_window: AGY_WINDOW } : null;
}

// 哈基米这类拿不到 usage 的：按会话记录的字数估 token（中文大约 1.5 字一个）
export function estimateTokens(sessionId) {
  try {
    let n = 0;
    for (const t of turns(sessionId)) n += String(t.text || "").length;
    return Math.ceil(n / 1.5);
  } catch { return 0; }
}

// 这一段现在占到多少（0..1）；算不出就 null
export function contextRatio(run, f = {}) {
  const used = f.usage?.context_tokens
    || (run && run.sessionId ? agyTokens(run.sessionId) : 0)
    || (run && run.sessionId ? estimateTokens(run.sessionId) : 0);
  const window = f.usage?.context_window || AGY_WINDOW;
  if (!(used > 0) || !(window > 0)) return null;
  return used / window;
}

// 下一次给她这段起轮时调用：这段该换就返回 { fromSid, reason }，并把标记清掉
export function takeRollover(roleId, sid) {
  const ro = STATE.rollover?.[roleId];
  if (!ro || !sid || String(ro.sid) !== String(sid)) return null;
  delete STATE.rollover[roleId];
  saveState();
  const pct = Math.round((ro.pct || 0) * 100);
  return { fromSid: String(ro.sid), reason: `上一段对话太长（占到 ${pct}%），自动换了新对话` };
}

// 每轮结束记占用：网关自己起的轮次（整理、日记、压缩）不算
END_HOOKS.push((run, f = {}) => {
  if (!run || run.auto || run.sched || run.internal || !run.sessionId) return;
  const role = roleOfDir(run.cwd);
  if (!role) return;
  const ratio = contextRatio(run, f);
  if (ratio == null || ratio < rolloverAt(role.id)) return;
  STATE.rollover = { ...(STATE.rollover || {}), [role.id]: { sid: String(run.sessionId), pct: ratio } };
  saveState();
});

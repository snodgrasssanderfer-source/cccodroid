// 上下文到 20% 自动换新对话（#72，主人 11-03 定的）：不压缩，直接换一段新会话，把上一段最后几轮带过去。
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

export const ROLLOVER_AT = 0.2;          // 占到两成就换，以后好调
const DEFAULT_WINDOW = 1_000_000;        // 哈基米是 1M；拿不到 context_window 时也按这个
const AGY_BRAIN = path.join(CFG.home, ".gemini", "antigravity-cli", "brain");

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
  const window = f.usage?.context_window || DEFAULT_WINDOW;
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
  if (ratio == null || ratio < ROLLOVER_AT) return;
  STATE.rollover = { ...(STATE.rollover || {}), [role.id]: { sid: String(run.sessionId), pct: ratio } };
  saveState();
});

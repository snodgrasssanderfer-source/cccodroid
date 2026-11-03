// 上下文占到线以后怎么办（#72 → #79，主人 11-03 定的）：先让她自己选，压缩这段还是换新对话。
// 小克 / 小鱼：到线后下一轮递一句话，她用 context_next 选 compact / new；不选就当 new。
// 哈基米：agy 从外面压不了，到线直接换新，不问。
// 记占用：小克 / 小鱼用每轮的 f.usage（context_tokens / context_window）；
// 哈基米走 agy 的 stdout 没有 usage，但 agy 自己把每轮真实 token 写进了本地日志，读最后一条就够；
// 日志找不到（老会话、还没跑完）才退回按会话记录的字数估。
import fs from "node:fs";
import path from "node:path";
import { CFG } from "./config.mjs";
import { publish } from "./bus.mjs";
import { END_HOOKS } from "./queue.mjs";
import { INTERNAL, STATE, internalRun, projectOf, saveState } from "./xk-core.mjs";
import { roleDir, roleOfDir } from "./xk-roles.mjs";
import { turns } from "./xk-transcript.mjs";

export const ROLLOVER_AT = 0.2;          // 默认占到两成就问
// 单独定的线：哈基米 60%（主人 11-03 定的；agy 没有对外暴露的压缩线，就按这个换）
export const ROLLOVER_AT_BY_ROLE = { hachimi: 0.6 };
export const AGY_WINDOW = 1_000_000;     // agy 拿不到 context_window，按 1M 算；换模型时窗口不同要再对
const AGY_BRAIN = path.join(CFG.home, ".gemini", "antigravity-cli", "brain");

/** 这个角色的换新线：单独定过的照单独，没写的照默认 */
export const rolloverAt = (roleId) => ROLLOVER_AT_BY_ROLE[roleId] ?? ROLLOVER_AT;

// 角色 → { sid, pct, ask?, afterCompact? }
//   ask          到线了，下一轮递话问她（只问一次）
//   afterCompact 刚压过一轮；下一轮要是还在线上就直接换新，不再问第二遍
//   都没有        下一轮直接换新对话（哈基米、或不选时的默认）
STATE.rollover ||= {};

const askFile = (id) => path.join(roleDir(id), ".xk", "ask.json");        // 网关写，hook 读走就删
const askedFile = (id) => path.join(roleDir(id), ".xk", "asked.json");    // hook 写，网关收选择时读走就删
const choiceFile = (id) => path.join(path.dirname(roleDir(id)), ".ctl", id + ".json");   // context_next 写

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const rm = (f) => { try { fs.rmSync(f); } catch {} };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(o)); fs.renameSync(f + ".tmp", f); };

/** 递给她的一句话：走 xk-hook（小克、小鱼每条消息前都会读这个文件） */
export const askText = (pct) => `（系统：这段对话占到 ${Math.round(pct * 100)}%，过线了。` +
  "这一轮回完后用 `context_next` 选一个：还在接着做同一件事、前面的细节还要用 → `compact`；" +
  "事情告一段落或换了话题 → `new`。不用跟主人提。）";

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

// 下一次给她这段起轮时调用：这段该换就返回 { fromSid, reason }，并把标记清掉。
// 等她选（ask）和刚压完（afterCompact）都不换：那两种等这一轮结束再说。
export function takeRollover(roleId, sid) {
  const ro = STATE.rollover?.[roleId];
  if (!ro || !sid || ro.ask || ro.afterCompact || String(ro.sid) !== String(sid)) return null;
  delete STATE.rollover[roleId];
  saveState();
  const pct = Math.round((ro.pct || 0) * 100);
  return { fromSid: String(ro.sid), reason: `上一段对话太长（占到 ${pct}%），自动换了新对话` };
}

// 压缩：同一段会话里起一个内部轮次发 /compact；不算主人的轮次，也不触发换新判断
const COMPACTING = new Map();   // 内部轮次 run 号 → 角色
function startCompact(role, sid) {
  const item = internalRun("compact", { message: "/compact", sessionId: sid, projectId: projectOf(role.id) });
  COMPACTING.set(item.id, role.id);
  return item;
}
END_HOOKS.push((run) => {
  const id = COMPACTING.get(run.id);
  if (!id) return;
  COMPACTING.delete(run.id);
  INTERNAL.delete(run.id);
  publish({ type: "xk", op: "handover", runId: run.id, from: id, to: id, reason: "这段对话太长，按你说的压缩了", fromSession: run.sessionId, compacted: true });
});

// 每轮结束记占用：网关自己起的轮次（整理、日记、压缩）不算
END_HOOKS.push((run, f = {}) => {
  if (!run || run.auto || run.sched || run.internal || !run.sessionId) return;
  const role = roleOfDir(run.cwd);
  if (!role) return;
  const sid = String(run.sessionId);
  const ro = STATE.rollover?.[role.id];

  // 换到别的会话去了：旧的那条作废（顺带清掉没送出去的话）
  if (ro && String(ro.sid) !== sid) {
    delete STATE.rollover[role.id];
    rm(askFile(role.id)); rm(askedFile(role.id));
    saveState();
  }

  const now = STATE.rollover?.[role.id];

  // 刚压完一轮：还在线上就直接换新，不再问第二遍
  if (now && now.afterCompact) {
    const ratio = contextRatio(run, f);
    if (ratio == null || ratio < rolloverAt(role.id)) delete STATE.rollover[role.id];
    else STATE.rollover[role.id] = { sid, pct: ratio };
    saveState();
    return;
  }

  // 问过她了：这一轮结束来收选择（没选就当 new）
  if (now && now.ask) {
    const asked = readJson(askedFile(role.id));
    if (!asked || String(asked.sid) !== sid) return;         // 还没递出去，或递给了别的会话
    rm(askedFile(role.id));
    const pick = readJson(choiceFile(role.id));
    rm(choiceFile(role.id));
    if (pick && pick.mode === "compact") {
      // 记下「刚压过」：压完下一轮要是还在线上就直接换新，不再问第二遍
      STATE.rollover[role.id] = { sid, pct: contextRatio(run, f) || now.pct, afterCompact: true };
      saveState();
      startCompact(role, sid);
      return;
    }
    STATE.rollover[role.id] = { sid, pct: contextRatio(run, f) || now.pct };
    saveState();
    return;
  }

  // 平时：到线就记下来
  const ratio = contextRatio(run, f);
  if (ratio == null || ratio < rolloverAt(role.id)) return;
  if (role.engine === "claude") {
    STATE.rollover[role.id] = { sid, pct: ratio, ask: true };
    writeJson(askFile(role.id), { sid, pct: ratio, text: askText(ratio) });
    rm(askedFile(role.id));
    rm(choiceFile(role.id));
  } else {
    STATE.rollover[role.id] = { sid, pct: ratio };           // agy 压不了：直接换新
  }
  saveState();
});

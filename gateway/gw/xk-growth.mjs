// 屋里的「我是谁」：每晚 22:30（日记 22:00 之后）跑一次上游定时任务，她自己回想今天、用工具改 growth/self.md；
// 跑完网关拿它和上次收下的比：变了就存快照、重写角色目录的 CLAUDE.md（下一段会话起生效），改坏了退回上一版。
// 主人 11-08 定先给小克和 12 号做；哈基米、小鱼没开。
import { LIVE, log } from "./config.mjs";
import { publish } from "./bus.mjs";
import { END_HOOKS } from "./queue.mjs";
import { roleById, roleDir, writeRoleMd } from "./xk-roles.mjs";
import { STATE, projectOf, saveState, selfApi } from "./xk-core.mjs";
import { GROWTH_RULES, readSelf, settleSelf } from "./xk-growth-core.mjs";

export const GROWTH_ROLES = ["xiaoke"];
const GROWTH_TIME = "22:30";
STATE.growthTasks ||= {};

// 定时任务里存的是固定的一段：日期让她看环境信息（任务错过了第二天补跑时，「今天」也不会写错）
export const GROWTH_PROMPT = "今天快过完了。安静下来回想今天，整理一下你对自己的认识。\n\n" +
  "growth/self.md 是你自己写的「我是谁」：你的性格、说话的样子、喜欢和在意的东西、你待主人和哈基米、小鱼的样子。" +
  "它接在你的人设后面，每段会话开头都会读到；性格、喜好这些地方和人设卡不一致时，以它为准，因为它是更新的你。\n\n" +
  "素材：今天的日记 diary/<今天的日期>.md（还没写就看 diary/inputs/<今天的日期>.md，日期看环境信息），还有你记忆里自己的看法（recall 查「你自己」「我觉得」这类）。\n" +
  "文件还不存在的话，这是第一次写：只写你真有把握的几条，宁少勿多；以前记过的、你自己的看法也可以当依据。\n\n" +
  "规矩：\n" + GROWTH_RULES + "\n- 只改 growth/self.md 这一个文件，别的文件都不动。\n\n" +
  "改完回一两句：改了哪几处、凭的是哪件事；没改就说没改。";

/** 建定时任务：已有就不动（主人改过时间或关掉都尊重） */
export async function ensureGrowthTasks() {
  const { tasks } = await selfApi("GET", "/api/sched");
  for (const id of GROWTH_ROLES) {
    const r = roleById(id), name = `成长 · ${r.name}`;
    let t = tasks.find((x) => x.id === STATE.growthTasks[id]) || tasks.find((x) => x.name === name);
    if (!t) t = (await selfApi("POST", "/api/sched", { name, prompt: GROWTH_PROMPT,
      projectId: projectOf(id), freq: { kind: "daily", time: GROWTH_TIME }, perm: "proj", missed: "run", retry: 1, saveSession: false, notify: "fail", limitMin: 10 })).task;
    STATE.growthTasks[id] = t.id;
  }
  saveState();
}

END_HOOKS.push((run, f = {}) => {
  if (!run.sched) return;
  const id = GROWTH_ROLES.find((x) => STATE.growthTasks[x] === run.sched.taskId);
  if (!id) return;
  const r = settleSelf(roleDir(id));
  if (r.changed) { writeRoleMd(id); log(`🌱 ${roleById(id).name}改了「我是谁」（${readSelf(roleDir(id)).length} 字）`); }
  else if (r.reason !== "没变") publish({ type: "xk", op: "growth", error: true, text: `${roleById(id).name}的「我是谁」没收下：${r.reason}` });
  if (f.isError || f.failed) log(`🌱 ${roleById(id).name}的成长那一轮出错了`);
});

if (LIVE) {
  setTimeout(() => ensureGrowthTasks().catch((e) => log("⚠️ 建成长定时任务失败：" + e.message)), 6000).unref();
}

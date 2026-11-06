// 悬浮窗（#32，设计稿 xk/design/presence.md 第一节）的网关一侧：把事件流整理成「谁、什么状态、一行字」推给外壳，
// 外壳（XkOverlay.java）只管画。主人离开 App 时也能看到她在做什么；重启倒计时、别的功能要往浮层推的话也走这里。
import { onPublish, publish } from "./bus.mjs";
import { RUNS } from "./runs.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { roleOfDir } from "./xk-roles.mjs";
import { STATE, addRoute, httpError, json, saveState } from "./xk-core.mjs";
import { sidOfAgyRun } from "./xk-agy.mjs";
import { cooling } from "./xk-handover.mjs";

STATE.overlay ||= { enabled: false, permitted: false };
// hideCmd：字幕里只写「跑命令」，不带命令内容（录屏、投屏时别人看得到浮层；主人 11-03 定的：做成开关，默认照显示）

// 浮层现在显示的：当前角色、状态（idle / busy / talk / sleep）、一行字
export const OV = { role: STATE.active, state: "idle", line: "" };
const LIVE_RUNS = new Map();   // runId → { role, text }：主人自己的轮次（网关自己起的整理、日记、压缩不显示）

const base = (p) => String(p || "").split("/").filter(Boolean).pop() || "";
const cut = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
// 工具 → 一句人话。MCP 工具按 __ 后面那段认（设备工具、记忆工具都是 MCP）
const STEP = {
  screen_read: () => "看屏幕", screenshot: () => "截屏", screen_tap: () => "点一下", screen_swipe: () => "滑一下",
  screen_type: (i) => "输入：" + cut(i.text, 20), screen_key: (i) => "按键 " + cut(i.key, 12),
  Bash: (i) => (STATE.overlay.hideCmd ? "跑命令" : "跑命令：" + cut(i.command, 40)), Read: (i) => "读 " + base(i.file_path),
  Edit: (i) => "改 " + base(i.file_path), MultiEdit: (i) => "改 " + base(i.file_path), Write: (i) => "写 " + base(i.file_path),
  Grep: (i) => "搜：" + cut(i.pattern, 30), Glob: () => "找文件", WebSearch: (i) => "上网搜：" + cut(i.query, 30), WebFetch: () => "看网页",
  Task: (i) => "派小帮手：" + cut(i.description, 30), Agent: (i) => "派小帮手：" + cut(i.description, 30), TodoWrite: () => "排待办",
  remember: () => "记下来", recall: () => "翻记忆", forget: () => "忘掉一条", board_write: () => "贴便条", board_read: () => "看留言板",
};
export function stepLine(name, input = {}) {
  const short = String(name || "").split("__").pop();
  return (STEP[short] || (() => short))(input || {});
}
/** 她这一轮说的话里，最后一句没说完的那句：字幕只放一行 */
export function lastLine(text, n = 60) {
  const lines = String(text).split("\n").map((s) => s.trim()).filter(Boolean);
  return cut(lines.pop() || "", n);
}

const asleep = (id) => !!cooling(id);   // 冷却的规矩只在 xk-handover 里定（顺带清掉过期的）
const restState = (id) => (asleep(id) ? "sleep" : "idle");
function push() { publish({ type: "xk", op: "overlay", role: OV.role, state: OV.state, line: OV.line }); }

// 说话的字一个个来：最多每 400ms 推一次，免得外壳那边重画太勤
let talkTimer = null;
function pushSoon() { if (!talkTimer) talkTimer = setTimeout(() => { talkTimer = null; push(); }, 400); }

function roleOfRun(id) {
  const r = RUNS.get(id);
  if (r) return r.auto || r.sched ? null : roleOfDir(r.cwd)?.id || null;
  return sidOfAgyRun(id) ? "hachimi" : null;
}

onPublish((ev) => {
  // 真机上 Claude 的思考是逐字流的，只来 phase:think，不来整段 thinking（11-03 抓事件流看到的）
  const think = ev?.type === "thinking" || (ev?.type === "phase" && ev.phase === "think");
  if (!ev || !ev.runId || !(think || ["run_start", "tool_use", "delta", "run_end"].includes(ev.type))) return;
  if (ev.type === "run_start") { if (!ev.auto) LIVE_RUNS.set(ev.runId, { role: null, text: "" }); return; }
  const live = LIVE_RUNS.get(ev.runId);
  if (!live) return;
  // 开跑时还没定在哪个目录跑（run.cwd 在 startRun 里 await 之后才有），所以到第一个有内容的事件再认人
  live.role ||= roleOfRun(ev.runId);
  if (!live.role) { if (ev.type === "run_end") LIVE_RUNS.delete(ev.runId); return; }
  OV.role = live.role;
  if (think) { if (OV.state !== "busy" || OV.line !== "在想…") { OV.state = "busy"; OV.line = "在想…"; push(); } }
  else if (ev.type === "tool_use" && !ev.parent) { OV.state = "busy"; OV.line = stepLine(ev.name, ev.input); push(); }
  else if (ev.type === "delta") { live.text += ev.text || ""; OV.state = "talk"; OV.line = lastLine(live.text); pushSoon(); }
  else if (ev.type === "run_end") {
    LIVE_RUNS.delete(ev.runId);
    // 最后一段话常常整块到、紧接着就跑完：还没推出去的「说话」先补推，外壳看到 talk → 闲下来才会在圆片上亮小点（11-03 真机没亮）
    if (talkTimer) { clearTimeout(talkTimer); talkTimer = null; push(); }
    OV.state = restState(OV.role);
    if (live.text) OV.line = lastLine(live.text);
    push();
  }
});

// 换人（主人手动换、接班）：浮层跟着换成当前角色
onPublish((ev) => {
  if (ev?.type !== "xk" || ev.op === "overlay" || !STATE.active || STATE.active === OV.role || LIVE_RUNS.size) return;
  OV.role = STATE.active; OV.state = restState(OV.role); OV.line = ""; push();
});

addRoute(async (req, res, u, p) => {
  if (!p.startsWith("/api/xk/overlay")) return NEXT;
  // 外壳（重）连上时拿一次全貌；界面「我的」里的开关也读它
  if (p === "/api/xk/overlay" && req.method === "GET") return sendJson(res, 200, { ...STATE.overlay, role: OV.role, state: OV.state, line: OV.line });
  // 开关（界面）和权限（外壳报上来）：存下来，广播给另一边
  if (p === "/api/xk/overlay/config" && req.method === "PUT") {
    const b = await json(req);
    for (const k of ["enabled", "permitted", "hideCmd"]) if (typeof b[k] === "boolean") STATE.overlay[k] = b[k];
    saveState();
    publish({ type: "xk", op: "overlay_config", ...STATE.overlay });
    return sendJson(res, 200, STATE.overlay);
  }
  // 往浮层推一句话、一个进度（0–1）。别的功能（整理记忆、以后的陪玩）复用
  if (p === "/api/xk/overlay/say" && req.method === "POST") {
    const b = await json(req);
    if (!String(b.text || "").trim()) throw httpError(400, "text 不能为空");
    const ev = { type: "xk", op: "overlay_say", role: b.role || OV.role, text: cut(b.text, 80), progress: typeof b.progress === "number" ? b.progress : null };
    publish(ev);
    return sendJson(res, 200, ev);
  }
  // 重启倒计时：重启网关的一方先报一声（秒数），外壳倒数 → 断开时「重启中」→ /api/status 的 pid 变了「重启好了」
  if (p === "/api/xk/overlay/countdown" && req.method === "POST") {
    const b = await json(req);
    const seconds = Math.round(Number(b.seconds));
    if (!(seconds >= 0)) throw httpError(400, "seconds 要是不小于 0 的数");
    const ev = { type: "xk", op: "overlay_countdown", role: OV.role, seconds, text: cut(b.text || "要重启一下网关", 40), pid: process.pid };
    publish(ev);
    return sendJson(res, 200, ev);
  }
  return NEXT;
});

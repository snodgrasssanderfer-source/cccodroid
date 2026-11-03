// 悬浮窗（#32）的网关一侧：事件流 → 「谁、什么状态、一行字」；开关、推一句话、重启倒计时
import { Readable } from "node:stream";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { onPublish, publish } from "../gw/bus.mjs";
import { RUNS } from "../gw/runs.mjs";
import { STATE } from "../gw/xk-core.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import { routeXk } from "../gw/xk.mjs";
import { OV, lastLine, stepLine } from "../gw/xk-overlay.mjs";

ensureRoles();
beforeEach(() => { for (const k of Object.keys(STATE.cooldown)) delete STATE.cooldown[k]; });
const watch = () => { const got = []; const off = onPublish((e) => { if (e.type === "xk" && e.op?.startsWith("overlay")) got.push(e); }); return { got, off }; };
const ev = (type, runId, extra = {}) => publish({ type, runId, ...extra });
async function call(method, p, body) {
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, headers: {} });
  let code = 0, out = "";
  const res = { headersSent: false, writeHead(c) { code = c; this.headersSent = true; }, end(b) { out = String(b || ""); } };
  await routeXk(req, res, new URL("http://x" + p), p);
  return { code, body: out ? JSON.parse(out) : null };
}

test("工具名换成一句人话；设备、记忆工具按 MCP 名字最后一段认", () => {
  assert.equal(stepLine("mcp__device__screen_tap", { id: 3 }), "点一下");
  assert.equal(stepLine("Bash", { command: "git status" }), "跑命令：git status");
  assert.equal(stepLine("Edit", { file_path: "/a/b/xk.js" }), "改 xk.js");
  assert.equal(stepLine("mcp__xk-memory__remember", {}), "记下来");
  assert.equal(stepLine("SomethingNew", {}), "SomethingNew");
  assert.equal(lastLine("第一句。\n\n第二句说到一半"), "第二句说到一半");
});

test("主人的一轮：想 → 干活 → 说话 → 跑完，浮层跟着换；按目录认出是谁", async () => {
  const { got, off } = watch();
  RUNS.set("r1", { id: "r1", cwd: roleDir("deepseek") });
  try {
    ev("run_start", "r1", { text: "帮我看看" });
    ev("thinking", "r1", { text: "嗯" });
    ev("tool_use", "r1", { name: "mcp__device__screen_read", input: {} });
    ev("delta", "r1", { text: "看到了，" });
    ev("delta", "r1", { text: "在设置页" });
    await new Promise((r) => setTimeout(r, 450));
    ev("run_end", "r1", {});
  } finally { off(); RUNS.delete("r1"); }
  const seq = got.filter((e) => e.op === "overlay").map((e) => [e.role, e.state, e.line]);
  assert.deepEqual(seq[0], ["deepseek", "busy", "在想…"]);
  assert.deepEqual(seq[1], ["deepseek", "busy", "看屏幕"]);
  assert.deepEqual(seq[2], ["deepseek", "talk", "看到了，在设置页"], "说话的字攒一下再推，不是一个字推一次");
  assert.deepEqual(seq.at(-1), ["deepseek", "idle", "看到了，在设置页"]);
});

test("最后一段话整块到、马上跑完：先补推说话再闲下来；思考按 phase:think 认，不重复推", () => {
  const { got, off } = watch();
  RUNS.set("r4", { id: "r4", cwd: roleDir("xiaoke") });
  try {
    ev("run_start", "r4", {});
    ev("phase", "r4", { phase: "think" });
    ev("phase", "r4", { phase: "think" });
    ev("phase", "r4", { phase: "tool", name: "Bash" });
    ev("delta", "r4", { text: "命令跑完了。" });
    ev("run_end", "r4", {});
  } finally { off(); RUNS.delete("r4"); }
  assert.deepEqual(got.filter((e) => e.op === "overlay").map((e) => [e.state, e.line]),
    [["busy", "在想…"], ["talk", "命令跑完了。"], ["idle", "命令跑完了。"]]);
});

test("网关自己起的轮次（整理、日记、压缩）不显示；额度用完的跑完显示睡着", () => {
  const { got, off } = watch();
  RUNS.set("r2", { id: "r2", cwd: roleDir("xiaoke") });
  RUNS.set("r3", { id: "r3", cwd: roleDir("xiaoke") });
  try {
    ev("run_start", "r2", { auto: "xk-memory" });
    ev("tool_use", "r2", { name: "Bash", input: { command: "ls" } });
    ev("run_end", "r2", { auto: "xk-memory" });
    assert.equal(got.length, 0);
    STATE.cooldown.xiaoke = { until: Date.now() + 3600000 };
    ev("run_start", "r3", {});
    ev("tool_use", "r3", { name: "Read", input: { file_path: "/x/a.md" } });
    ev("run_end", "r3", {});
  } finally { off(); RUNS.delete("r2"); RUNS.delete("r3"); }
  assert.deepEqual(got.map((e) => e.state), ["busy", "sleep"]);
  assert.equal(OV.role, "xiaoke");
});

test("开关和权限存下来并广播；推一句话、倒计时带上 pid", async () => {
  const { got, off } = watch();
  try {
    assert.equal((await call("PUT", "/api/xk/overlay/config", { enabled: true })).body.enabled, true);
    assert.equal((await call("PUT", "/api/xk/overlay/config", { permitted: false })).body.enabled, true, "外壳报权限不动开关");
    const g = await call("GET", "/api/xk/overlay");
    assert.equal(g.body.enabled, true);
    assert.equal(g.body.role, OV.role);
    assert.equal((await call("POST", "/api/xk/overlay/say", { text: "记了 3 条", progress: 0.5 })).body.progress, 0.5);
    assert.equal((await call("POST", "/api/xk/overlay/say", { text: " " })).code, 400);
    const c = await call("POST", "/api/xk/overlay/countdown", { seconds: 5 });
    assert.equal(c.body.pid, process.pid);
    assert.equal((await call("POST", "/api/xk/overlay/countdown", { seconds: "x" })).code, 400);
  } finally { off(); }
  assert.deepEqual(got.map((e) => e.op), ["overlay_config", "overlay_config", "overlay_say", "overlay_countdown"]);
  assert.equal(STATE.overlay.permitted, false);
});

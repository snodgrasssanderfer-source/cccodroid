// 哈基米常驻：每段对话一个 agy 进程，消息一行一条往里递（11-02 真机：首条 10.2s，同一进程第二条 3.2s）
import "../gw/config.mjs";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { onPublish } from "../gw/bus.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import { STATE } from "../gw/xk-core.mjs";
import { AGY, AGY_IDLE, WARM, runAgy, stopAgy } from "../gw/xk-agy.mjs";
import { fakeAgy, readLog } from "./fixtures/xk-fake-agy.mjs";

ensureRoles();
const LOG = path.join(process.env.CCAPP_TMP, "agy-warm.log");
const ok = (conv, text) => [{ event: "step_update", step_update: { conversation_id: conv, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: text } }, { event: "result", result: { conversation_id: conv, status: "SUCCESS", response: text } }];
const run = (item, extra) => new Promise((done) => {
  const evs = [];
  const off = onPublish((e) => { if (e.runId === item.id) { evs.push(e); if (e.type === "run_end") { off(); done(evs); } } });
  runAgy(item, extra);
});
const starts = () => readLog(LOG).filter((r) => r.start);
const waitGone = async (sid) => { for (let i = 0; i < 100 && WARM.has(sid); i++) await new Promise((r) => setTimeout(r, 30)); };
beforeEach(async () => { await stopAgy(); fs.rmSync(LOG, { force: true }); delete STATE.agyModel; delete STATE.agyVerify; delete STATE.agyAuth; AGY_IDLE.ms = 10 * 60 * 1000; });
after(() => stopAgy());

test("同一段对话的两条消息：只起一个 agy，第二条直接递进去", async () => {
  fakeAgy(AGY, { lines: ok("c1", "在"), log: LOG });
  const a = await run({ id: "w1", message: "在吗", sessionId: null });
  const sid = a.find((e) => e.type === "init").sessionId;
  const b = await run({ id: "w2", message: "再说一句", sessionId: sid });
  assert.equal(b.at(-1).isError, false);
  assert.deepEqual(b.filter((e) => e.type === "delta").map((e) => e.text), ["在"]);
  assert.equal(starts().length, 1, "第二条没有另起进程");
  const msgs = readLog(LOG).filter((r) => r.stdin);
  assert.equal(msgs.length, 2);
  assert.equal(new Set(msgs.map((r) => r.pid)).size, 1);
  assert.equal(starts()[0].env.CCAPP_RUN_ID, "agyw-" + sid, "常驻进程用会话级的 run 号，不冻在第一轮");
});

test("换了模型：旧进程收掉，新进程带上新模型和原来的 agy 会话", async () => {
  fakeAgy(AGY, { lines: ok("c2", "好"), log: LOG });
  const a = await run({ id: "w3", message: "在吗", sessionId: null });
  const sid = a.find((e) => e.type === "init").sessionId;
  STATE.agyModel = "gemini-3.8-flash-low";
  await run({ id: "w4", message: "换个模型", sessionId: sid });
  assert.equal(starts().length, 2);
  const args = starts()[1].args;
  assert.ok(args.includes("gemini-3.8-flash-low"));
  assert.deepEqual(args.slice(args.indexOf("--conversation"), args.indexOf("--conversation") + 2), ["--conversation", "c2"]);
});

test("闲置到点：进程自己退出；下一条重新起、接着原来的 agy 会话", async () => {
  AGY_IDLE.ms = 80;
  fakeAgy(AGY, { lines: ok("c3", "嗯"), log: LOG });
  const a = await run({ id: "w5", message: "在吗", sessionId: null });
  const sid = a.find((e) => e.type === "init").sessionId;
  await waitGone(sid);
  assert.equal(WARM.has(sid), false, "闲置后退出了");
  await run({ id: "w6", message: "我回来了", sessionId: sid });
  assert.equal(starts().length, 2);
  assert.ok(starts()[1].args.includes("--conversation"));
});

test("进程中途挂了（没给 result 就退出）：这一轮报错说清楚，下一条重新起", async () => {
  fakeAgy(AGY, { log: LOG, perMessage: [{ lines: ok("c4", "一") }, { lines: [], code: 3, stderr: "panic: 内存不够\n" }, { lines: ok("c4", "三") }] });
  const a = await run({ id: "w7", message: "一", sessionId: null });
  const sid = a.find((e) => e.type === "init").sessionId;
  const b = await run({ id: "w8", message: "二", sessionId: sid });
  assert.equal(b.at(-1).isError, true);
  assert.match(b.find((e) => e.type === "error").message, /内存不够|退出码 3/);
  const c = await run({ id: "w9", message: "三", sessionId: sid });
  assert.equal(c.at(-1).isError, false);
  assert.equal(starts().length, 2);
});

test("网关自己起的（整理、日记）：一次性，答完就退，不常驻", async () => {
  fakeAgy(AGY, { lines: ok("c5", "整理好了"), log: LOG });
  const a = await run({ id: "w10", message: "整理记忆", sessionId: null }, { internal: true });
  assert.equal(a.at(-1).isError, false);
  assert.equal(WARM.size, 0);
});

test("渠道：每轮把这一轮的渠道记录抄给常驻进程（以后 QQ 接入时 MCP 按它分渠道）", async () => {
  fakeAgy(AGY, { lines: ok("c6", "好"), log: LOG });
  const runs = path.join(roleDir("hachimi"), ".xk", "runs");
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, "w11.json"), JSON.stringify({ channel: "qq-private" }));
  const a = await run({ id: "w11", message: "在吗", sessionId: null });
  const sid = a.find((e) => e.type === "init").sessionId;
  assert.equal(JSON.parse(fs.readFileSync(path.join(runs, "agyw-" + sid + ".json"), "utf8")).channel, "qq-private");
  await run({ id: "w12", message: "App 里发的", sessionId: sid });
  assert.equal(fs.existsSync(path.join(runs, "agyw-" + sid + ".json")), false, "没有渠道记录就是 App");
});

test("人设没变：每轮重写 AGENTS.md 也不换进程；导入了新人设：换个新进程读它", async () => {
  fakeAgy(AGY, { lines: ok("c7", "喵"), log: LOG });
  const a = await run({ id: "w13", message: "一", sessionId: null });
  const sid = a.find((e) => e.type === "init").sessionId;
  await run({ id: "w14", message: "二", sessionId: sid });
  assert.equal(starts().length, 1, "内容一样就不换");
  const f = path.join(roleDir("hachimi"), ".claude", "agents", "hachimi.md");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const old = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  fs.writeFileSync(f, "---\nname: hachimi\n---\n新导入的人设正文\n");
  try { await run({ id: "w15", message: "三", sessionId: sid }); } finally { old == null ? fs.rmSync(f) : fs.writeFileSync(f, old); }
  assert.equal(starts().length, 2, "人设变了就换新进程");
});

test("整理记忆问一次（askAgy）：不在哈基米目录、不放行工具、不留会话记录，拿回文字；失败带原因", async () => {
  const { askAgy } = await import("../gw/xk-agy.mjs");
  fakeAgy(AGY, { lines: ok("c9", '{"memories":[]}'), log: LOG });
  assert.deepEqual(await askAgy("整理"), { text: '{"memories":[]}' });
  const s = starts().at(-1);
  assert.ok(!s.args.includes("--dangerously-skip-permissions"));
  assert.ok(!s.args.includes("--conversation"));
  fakeAgy(AGY, { lines: [{ event: "result", result: { status: "ERROR", error: "quota exhausted" } }], log: LOG });
  assert.match((await askAgy("整理")).error, /quota exhausted/);
  fakeAgy(AGY, { lines: [], code: 2, stderr: "boom\n", log: LOG });
  assert.match((await askAgy("整理")).error, /boom/);
});

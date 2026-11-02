// 小克：哈基米的 agy 驱动（用一个照 1.4.12 实测格式吐事件的假 agy）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { onPublish } from "../gw/bus.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import { STATE } from "../gw/xk-core.mjs";
import { AGY, runAgy, stopAgy } from "../gw/xk-agy.mjs";
import { fakeAgy, readLog } from "./fixtures/xk-fake-agy.mjs";
import { turns } from "../gw/xk-transcript.mjs";

const LOG = path.join(process.env.CCAPP_TMP, "agy-args.log");
// 换假 agy 之前先把常驻的收掉：不然下一条还递给旧的那个
const fake = async (lines, code = 0) => { await stopAgy(); fs.rmSync(LOG, { force: true }); return fakeAgy(AGY, { lines, code, log: LOG }); };
after(() => stopAgy());
function run(item, extra) {
  const evs = [];
  return new Promise((ok) => {
    const off = onPublish((e) => { if (e.runId === item.id) { evs.push(e); if (e.type === "run_end") { off(); ok(evs); } } });
    runAgy(item, extra);
  });
}

test("正文流式、会话记录、下一轮续接同一个 agy 会话", async () => {
  ensureRoles();
  fs.mkdirSync(path.join(roleDir("hachimi"), "persona"), { recursive: true });
  fs.writeFileSync(path.join(roleDir("hachimi"), "persona/post_history.md"), "贴尾提醒Z");
  const log = await fake([
    { event: "init", init: { cwd: "x", tools: [] } },
    { event: "step_update", step_update: { conversation_id: "c1", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "你" } },
    { event: "step_update", step_update: { conversation_id: "c1", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "好" } },
    { event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "你好" } },
  ]);
  const evs = await run({ id: "xa1", message: "在吗", sessionId: null }, { carry: "接班说明Q" });
  const sid = evs.find((e) => e.type === "init").sessionId;
  assert.deepEqual(evs.filter((e) => e.type === "delta").map((e) => e.text), ["你", "好"]);
  assert.equal(evs.at(-1).isError, false);
  assert.deepEqual(turns(sid).map((t) => [t.role, t.text]), [["user", "在吗"], ["assistant", "你好"]]);
  const first = { ...readLog(log).find((r) => r.start), stdin: readLog(log).find((r) => r.stdin).stdin };
  assert.equal(first.args.includes("-p"), false, "stream-json 输入时不能带 -p");
  const blocks = JSON.parse(first.stdin).message.content;
  assert.match(blocks[0].text, /接班说明Q[\s\S]*贴尾提醒Z/);
  assert.equal(blocks.at(-1).text, "在吗");
  assert.match(fs.readFileSync(path.join(roleDir("hachimi"), "AGENTS.md"), "utf8"), /怎么用你的记忆/);
  await run({ id: "xa2", message: "再说一句", sessionId: sid });
  // 第二条递给同一个常驻进程；进程换了（闲置退出、换模型）才靠 --conversation 接回去，见 xk-agy-warm.test.mjs
  assert.equal(readLog(log).filter((r) => r.start).length, 1);
  await stopAgy();
  await run({ id: "xa2b", message: "隔了好久又来", sessionId: sid });
  const second = readLog(log).filter((r) => r.start).at(-1);
  assert.deepEqual(second.args.slice(second.args.indexOf("--conversation"), second.args.indexOf("--conversation") + 2), ["--conversation", "c1"]);
});

test("没登录：错误原样带出来，哈基米标成不能接班", async () => {
  await fake([{ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out" } }], 1);
  const evs = await run({ id: "xa3", message: "在吗", sessionId: null });
  assert.match(evs.find((e) => e.type === "error").message, /authentication failed/);
  assert.equal(evs.at(-1).isError, true);
  assert.equal(STATE.agyAuth, false);
});

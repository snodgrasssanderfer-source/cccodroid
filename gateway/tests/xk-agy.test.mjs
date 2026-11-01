// 小克：哈基米的 agy 驱动（用一个照 1.4.12 实测格式吐事件的假 agy）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { onPublish } from "../gw/bus.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import { STATE } from "../gw/xk-core.mjs";
import { AGY, runAgy } from "../gw/xk-agy.mjs";
import { turns } from "../gw/xk-transcript.mjs";

const fake = (lines, code = 0) => {
  fs.mkdirSync(path.dirname(AGY), { recursive: true });
  const log = path.join(process.env.CCAPP_TMP, "agy-args.log");
  fs.writeFileSync(AGY, `#!${process.execPath}\nconst fs=require("fs");let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),stdin:d})+"\\n");` +
    `for(const l of ${JSON.stringify(lines)})process.stdout.write(JSON.stringify(l)+"\\n");process.exit(${code});});\n`);
  fs.chmodSync(AGY, 0o755);
  return log;
};
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
  const log = fake([
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
  const first = JSON.parse(fs.readFileSync(log, "utf8").split("\n")[0]);
  assert.equal(first.args.includes("-p"), false, "stream-json 输入时不能带 -p");
  const blocks = JSON.parse(first.stdin).message.content;
  assert.match(blocks[0].text, /接班说明Q[\s\S]*贴尾提醒Z/);
  assert.equal(blocks.at(-1).text, "在吗");
  assert.match(fs.readFileSync(path.join(roleDir("hachimi"), "AGENTS.md"), "utf8"), /怎么用你的记忆/);
  await run({ id: "xa2", message: "再说一句", sessionId: sid });
  const second = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1));
  assert.deepEqual(second.args.slice(-2), ["--conversation", "c1"]);
});

test("没登录：错误原样带出来，哈基米标成不能接班", async () => {
  fake([{ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out" } }], 1);
  const evs = await run({ id: "xa3", message: "在吗", sessionId: null });
  assert.match(evs.find((e) => e.type === "error").message, /authentication failed/);
  assert.equal(evs.at(-1).isError, true);
  assert.equal(STATE.agyAuth, false);
});

// 聊天室（#35）：谁接话、群里的新发言递进她当前那段、回复贴回群里、一句话最多一个人插话
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";
import { END_HOOKS, START_GUARDS } from "../gw/queue.mjs";
import { projectSlug } from "../gw/projects.mjs";
import { ENGINE_RUN, STATE } from "../gw/xk-core.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import { routeXk } from "../gw/xk.mjs";
import { ASIDE_GAP, PASS, messages, ownerSays, resetRoom, whoAnswers } from "../gw/xk-room.mjs";

ensureRoles();
STATE.projects = { xiaoke: "p-x", hachimi: "p-h", deepseek: "p-d" };
const queued = [];   // 不真去跑：Claude Code 那两位截在开跑前，哈基米换成假的 agy
START_GUARDS.unshift((q) => { if (/群聊/.test(q.message || "")) { queued.push(q); return false; } return true; });
const agyOrig = ENGINE_RUN.agy;
ENGINE_RUN.agy = (item) => queued.push({ ...item, agy: true });
beforeEach(() => { resetRoom(); queued.length = 0; for (const k of Object.keys(STATE.cooldown)) delete STATE.cooldown[k]; STATE.lastByRole = {}; STATE.active = "xiaoke"; });

let seq = 0;
/** 她答完了：在她那段会话里写下回复，再走一遍结束钩子 */
function answer(q, role, text, f = {}) {
  const sid = q.sessionId || `eeeeeeee-1111-4111-8111-${String(++seq).padStart(12, "0")}`;
  const cwd = fs.realpathSync(roleDir(role)), dir = path.join(CFG.home, ".claude", "projects", projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  fs.appendFileSync(path.join(dir, sid + ".jsonl"), [
    { type: "user", sessionId: sid, cwd, uuid: "u" + seq, timestamp: at, message: { role: "user", content: q.message } },
    ...(text ? [{ type: "assistant", sessionId: sid, cwd, uuid: "a" + seq, timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } }] : []),
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  for (const h of END_HOOKS) h({ id: q.id, sessionId: sid, cwd }, f);
  return sid;
}
const said = () => messages().map((m) => [m.from, m.text, m.kind || ""]);

test("谁接：点了名的；没点名是群里上一个说话的，再没有是当前角色；睡着的不接", () => {
  assert.deepEqual(whoAnswers("小鱼你说呢"), ["deepseek"]);
  assert.deepEqual(whoAnswers("小克和哈基米来一下"), ["xiaoke", "hachimi"]);
  assert.deepEqual(whoAnswers("随便聊聊"), ["xiaoke"]);
  assert.deepEqual(whoAnswers("随便", ["hachimi"]), ["hachimi"]);
  STATE.cooldown.deepseek = { until: Date.now() + 3600000 };
  assert.deepEqual(whoAnswers("小鱼在吗"), []);
});

test("主人说一句：递进她那段，回复贴回群里；然后另一个人可以插一句（便宜档），回「不插话」就不贴", () => {
  STATE.lastByRole = {};
  ownerSays("今天吃什么");
  assert.equal(queued.length, 1);
  const q = queued[0];
  assert.match(q.message, /群聊[\s\S]*主人：今天吃什么[\s\S]*轮到你在群里接话/);
  assert.equal(q.projectId, "p-x", "她还没有会话：在她的项目里新开");
  answer(q, "xiaoke", "吃面吧");
  assert.deepEqual(said(), [["owner", "今天吃什么", ""], ["xiaoke", "吃面吧", ""]]);
  // 小克答完，轮到一个人插话：便宜档，递进去的有主人和小克的话
  assert.equal(queued.length, 2);
  const a = queued[1];
  assert.match(a.message, new RegExp(`主人：今天吃什么\\n小克：吃面吧[\\s\\S]*${PASS}`));
  if (!a.agy) assert.equal(a.model, "deepseek-flash");
  answer(a, a.agy ? "hachimi" : "deepseek", PASS);
  assert.equal(messages().length, 2, "不插话的不贴");
});

test("插话有间隔：同一个人刚插过，下一句换人或者不插", () => {
  ASIDE_GAP.ms = 3600000;
  try {
    ownerSays("小克在吗");
    answer(queued[0], "xiaoke", "在");
    const first = queued[1];
    answer(first, first.agy ? "hachimi" : "deepseek", "我也在");
    assert.equal(messages().at(-1).kind, "aside");
    ownerSays("小克再说一句");
    answer(queued[2], "xiaoke", "好");
    const second = queued[3];
    assert.ok(second, "另一个人还能插");
    assert.notEqual(!!second.agy, !!first.agy, "换了一个人");
    answer(second, second.agy ? "hachimi" : "deepseek", PASS);
    ownerSays("小克第三句");
    answer(queued[4], "xiaoke", "嗯");
    assert.equal(queued.length, 5, "两个人都刚插过：这句没人插");
  } finally { ASIDE_GAP.ms = 3 * 60 * 1000; }
});

test("她还在说时主人又说了：跑完再来一轮，只递新的；说不出来的群里说一声", () => {
  ownerSays("小鱼，一");
  ownerSays("小鱼，二");
  assert.equal(queued.length, 1, "一次只跑一轮");
  const sid = answer(queued[0], "deepseek", "好的一");
  const again = queued.find((q, i) => i > 0 && /小鱼，二/.test(q.message));
  assert.ok(again, "跑完接着说第二句");
  assert.doesNotMatch(again.message, /小鱼，一/, "看过的不再递");
  assert.equal(again.sessionId, sid, "接着她那段");
  answer(again, "deepseek", "", { isError: true, subtype: "error_during_execution" });
  assert.match(messages().at(-1).text, /小鱼没说出来/);
});

test("接口：POST 说一句（可以 @ 人），GET 拿新消息和成员", async () => {
  const call = async (method, p, body) => {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method, headers: {} });
    let code = 0, out = "";
    const u = new URL("http://x" + p);
    await routeXk(req, { headersSent: false, writeHead(c) { code = c; }, end(b) { out = String(b || ""); } }, u, u.pathname);
    return { code, body: JSON.parse(out) };
  };
  assert.equal((await call("POST", "/api/xk/room", { text: " " })).code, 400);
  const r = await call("POST", "/api/xk/room", { text: "你们好", to: ["hachimi"] });
  assert.deepEqual(r.body.answers, ["hachimi"]);
  assert.ok(queued[0].agy, "哈基米走她的 agy");
  const g = await call("GET", "/api/xk/room?after=-1");
  assert.equal(g.body.messages[0].text, "你们好");
  assert.equal(g.body.members.find((m) => m.id === "hachimi").state, "talk");
  ENGINE_RUN.agy = agyOrig;
});

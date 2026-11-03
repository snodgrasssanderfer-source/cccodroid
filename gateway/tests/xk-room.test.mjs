// 聊天室（#35、#61）：谁开口（规则 + 拿不准时问一次便宜档）、群里的新发言递进她当前那段、回复贴回群里、她们之间互相点名
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";
import { END_HOOKS, START_GUARDS } from "../gw/queue.mjs";
import { publish } from "../gw/bus.mjs";
import { projectSlug } from "../gw/projects.mjs";
import { ENGINE_RUN, STATE } from "../gw/xk-core.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import { routeXk } from "../gw/xk.mjs";
import { ASIDE_GAP, CAP, PACE, PASS, messages, ownerSays, resetRoom } from "../gw/xk-room.mjs";
import { ASK } from "../gw/xk-memory.mjs";

ensureRoles();
STATE.projects = { xiaoke: "p-x", hachimi: "p-h", deepseek: "p-d" };
const queued = [];   // 不真去跑：Claude Code 那两位截在开跑前，哈基米换成假的 agy
START_GUARDS.unshift((q) => { if (/群聊/.test(q.message || "")) { queued.push(q); return false; } return true; });
const agyOrig = ENGINE_RUN.agy;
ENGINE_RUN.agy = (item) => queued.push({ ...item, agy: true });
// 不等主人说完那几秒；判断谁接话的便宜档换成假的，记下问了什么
PACE.quietMs = PACE.calledMs = 0;
const judged = [];
let verdict = { reply: "none", aside: "none" };
ASK.claude = async (prompt, role, system) => { judged.push({ prompt, role: role.id, system }); return verdict instanceof Error ? { error: verdict.message } : { text: "好的 " + JSON.stringify(verdict) }; };
const tick = () => new Promise((r) => setTimeout(r, 5));
beforeEach(() => { resetRoom(); queued.length = 0; judged.length = 0; verdict = { reply: "none", aside: "none" }; for (const k of Object.keys(STATE.cooldown)) delete STATE.cooldown[k]; STATE.lastByRole = {}; STATE.active = "xiaoke"; });

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
  for (const h of END_HOOKS) h({ id: q.id, cid: q.cid, sessionId: sid, cwd }, f);
  return sid;
}
const said = () => messages().map((m) => [m.from, m.text, m.kind || ""]);

test("点了名的直接接，不问便宜档；@ 也算；都睡着了说一声", async () => {
  await ownerSays("小鱼你说呢").decided;
  assert.equal(queued.length, 1);
  assert.match(queued[0].message, /主人：小鱼你说呢[\s\S]*轮到你在群里接话/);
  assert.equal(queued[0].projectId, "p-d");
  assert.equal(judged.length, 0, "点了名就不花这一次");
  await ownerSays("你们好", ["hachimi"]).decided;
  assert.ok(queued[1].agy, "@ 哈基米：走她的 agy");
  for (const id of ["xiaoke", "hachimi", "deepseek"]) STATE.cooldown[id] = { until: Date.now() + 3600000 };
  await ownerSays("人呢").decided;
  assert.match(messages().at(-1).text, /都睡着了/);
});

test("主人连着发的几句攒成一批：只定一次，几句一起递给她", async () => {
  PACE.quietMs = 30;
  try {
    ownerSays("小克");
    const { decided } = ownerSays("今天好累");
    await decided;
  } finally { PACE.quietMs = 0; }
  assert.equal(queued.length, 1);
  assert.match(queued[0].message, /主人：小克\n主人：今天好累/);
});

test("拿不准：问一次便宜档（小鱼那家），按它挑的人接，另一个可以插一句（插话走便宜档）", async () => {
  verdict = { reply: "hachimi", aside: "deepseek" };
  const ids = await ownerSays("今天吃什么").decided;
  assert.deepEqual(ids, ["hachimi"]);
  assert.equal(judged.length, 1);
  assert.equal(judged[0].role, "deepseek");
  assert.match(judged[0].prompt, /主人：今天吃什么[\s\S]*谁来接最合适/);
  const aside = queued.find((q) => !q.agy);
  assert.match(aside.message, new RegExp(PASS));
  assert.equal(aside.model, "deepseek-flash");
  answer(aside, "deepseek", PASS);
  assert.equal(messages().length, 1, "不插话的不贴");
});

test("问不成就退回上一个说话的；一来一回时不问", async () => {
  verdict = new Error("没配密钥");
  await ownerSays("在吗").decided;
  assert.equal(queued[0].projectId, "p-x", "没人说过话：当前角色小克");
  answer(queued[0], "xiaoke", "在呢");
  await tick();
  judged.length = 0;
  await ownerSays("然后呢").decided;
  assert.equal(judged.length, 0, "刚和小克说完：直接是她");
  assert.match(queued.at(-1).message, /主人：然后呢/);
});

test("她们之间互相点名：被叫到的接（交给她的事），不花判断；接话有上限", async () => {
  await ownerSays("小克，把这个分一下").decided;
  answer(queued[0], "xiaoke", "小鱼，这个交给你：把歌单整理好");
  await tick();
  const fish = queued[1];
  assert.match(fish.message, /小克：小鱼，这个交给你[\s\S]*小克在群里叫你了/);
  assert.equal(fish.model, null, "被叫到的用她平时那个模型");
  assert.equal(judged.length, 0);
  // 互相点名点个不停：主人不开口，最多再说 CAP.chain 句
  let last = fish, who = "deepseek";
  for (let i = 0; i < 6; i++) {
    const next = who === "deepseek" ? "xiaoke" : "deepseek";
    answer(last, who, `${next === "xiaoke" ? "小克" : "小鱼"}，该你了`);
    await tick();
    if (queued.at(-1) === last) break;
    last = queued.at(-1); who = next;
  }
  assert.equal(queued.length, 1 + CAP.chain, "第一句 + 最多三句");
});

test("这一波说完、没人点名：才问一次有没有人接；说 none 就停；主人又开口了旧的不再往下接", async () => {
  ASIDE_GAP.ms = 0;
  try {
    await ownerSays("小克在吗").decided;
    verdict = { reply: "none", aside: "none" };
    answer(queued[0], "xiaoke", "在");
    await tick();
    assert.equal(judged.length, 1);
    assert.match(judged[0].prompt, /小克刚说完最后一句/);
    assert.equal(queued.length, 1, "没人接");
    verdict = { reply: "none", aside: "hachimi" };
    await ownerSays("小克再说一句").decided;
    const q = queued.at(-1);
    await ownerSays("算了，小鱼你说").decided;
    answer(q, "xiaoke", "好");
    await tick();
    assert.ok(!queued.some((x) => x.agy), "主人已经换了话题：旧那批不再叫人插话");
  } finally { ASIDE_GAP.ms = 3 * 60 * 1000; }
});

test("她还在说时主人又说了：跑完再来一轮，只递新的；说不出来的群里说一声", async () => {
  await ownerSays("小鱼，一").decided;
  await ownerSays("小鱼，二").decided;
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
  assert.equal(r.body.msg.text, "你们好");
  await tick();
  assert.ok(queued[0].agy, "哈基米走她的 agy");
  const g = await call("GET", "/api/xk/room?after=-1");
  assert.equal(g.body.messages[0].text, "你们好");
  assert.equal(g.body.members.find((m) => m.id === "hachimi").state, "talk");
  ENGINE_RUN.agy = agyOrig;
});

test("一开跑就结束（没配密钥这类，enqueue 还没返回就结束了）：群里照样说一声，不卡在「在说」", async () => {
  const sync = (q) => { if (/群聊/.test(q.message || "")) { publish({ type: "error", runId: q.id, message: "未配置 API 密钥" }); for (const h of END_HOOKS) h({ id: q.id, cid: q.cid, sessionId: null, cwd: roleDir("deepseek") }, { failed: true }); return false; } return true; };
  START_GUARDS.unshift(sync);
  try { await ownerSays("小鱼在吗").decided; } finally { START_GUARDS.splice(START_GUARDS.indexOf(sync), 1); }
  assert.equal(messages().at(-1).text, "小鱼没说出来：未配置 API 密钥");
  assert.equal(queued.length, 0, "没说出来就不叫别人插话");
  await ownerSays("小鱼？").decided;
  assert.equal(queued.length, 1, "没卡住：下一句照常递给她");
});

test("头像卡片的上下文：她那段每轮结束都记（私聊也算），网关自己起的不算", () => {
  for (const h of END_HOOKS) h({ id: "p1", sessionId: null, cwd: fs.realpathSync(roleDir("xiaoke")) }, { usage: { context_tokens: 48000, context_window: 200000 } });
  for (const h of END_HOOKS) h({ id: "p2", auto: "xk-diary", sessionId: null, cwd: fs.realpathSync(roleDir("xiaoke")) }, { usage: { context_tokens: 999, context_window: 200000 } });
  assert.deepEqual({ ...STATE.room.usage.xiaoke, at: 0 }, { used: 48000, window: 200000, at: 0 });
});


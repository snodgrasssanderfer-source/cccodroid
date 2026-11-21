// 12号 的 App 聊天室（主人 11-10 定）：App 里说的话进她和主人 QQ 私聊的同一段；回话按来路送回；QQ 断了她找主人的事落到 App；
// 访客（小克、哈基米、小鱼）在她自己那段里接话，记忆各归各的
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";

// 这份测试要写 qq.json、聊天室记录：不在 scripts/test.mjs 建的临时目录里就什么都不做（11-09 手敲命令冲掉真文件那回的教训）
if (!/cccodroid-test-/.test(fs.realpathSync(CFG.home)) || process.env.CCAPP_TEST !== "1") {
  throw new Error("只能用 scripts/test.mjs（手机上 xk/tools/test-on-phone.sh）跑：现在的 HOME 不是测试临时目录");
}

const { END_HOOKS, START_GUARDS } = await import("../gw/queue.mjs");
const { projectSlug } = await import("../gw/projects.mjs");
const { ENGINE_RUN, STATE } = await import("../gw/xk-core.mjs");
const { ensureRoles, roleDir } = await import("../gw/xk-roles.mjs");
const { publish, onPublish } = await import("../gw/bus.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { CLEAN_DIR, CONFIG_FILE, LOG_DIR, REPLIES, diaryTick, drainQQRpc, ensureClean, handleEvent, resetQQ } = await import("../gw/xk-qq.mjs");
const { GUEST_HEAD, TWELVE, appMessages, guestReply, ownerSays, resetApp, setGuest } = await import("../gw/xk-qq-app.mjs");

process.env.CCAPP_QQ_GAP_MS = "0";
const BOT = "10001", OWNER = "90001";
ensureRoles();
STATE.projects = { xiaoke: "p-x", hachimi: "p-h", deepseek: "p-d" };
fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ enabled: true, ws: "ws://127.0.0.1:1", token: "t", bot: BOT, owner: OWNER }));

const queued = [];
START_GUARDS.unshift((q) => { queued.push(q); return false; });
ENGINE_RUN.agy = (item) => queued.push({ ...item, agy: true });
const notes = [];
onPublish((ev) => { if (ev?.type === "sched_note" && ev.taskId === "xk-qq-app") notes.push(ev); });
beforeEach(() => { resetQQ(); resetApp(); queued.length = 0; notes.length = 0; STATE.lastByRole = {}; for (const k of Object.keys(STATE.cooldown)) delete STATE.cooldown[k]; ensureClean("p"); });

let seq = 0;
/** 一轮跑完：在它那段会话里写下回复，再走结束钩子（cwd：12号是 qq-clean，客人是她自己的房间） */
function finish(q, said, cwd, f = {}) {
  const sid = q.sessionId || `ffffffff-2222-4222-8222-${String(++seq).padStart(12, "0")}`;
  const real = fs.realpathSync(cwd), dir = path.join(CFG.home, ".claude", "projects", projectSlug(real));
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  fs.appendFileSync(path.join(dir, sid + ".jsonl"), [
    { type: "user", sessionId: sid, cwd: real, uuid: "u" + seq, timestamp: at, message: { role: "user", content: q.message } },
    ...(said ? [{ type: "assistant", sessionId: sid, cwd: real, uuid: "a" + seq, timestamp: at, message: { role: "assistant", content: [{ type: "text", text: said }] } }] : []),
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  for (const h of END_HOOKS) h({ id: q.id, cid: q.cid, sessionId: sid, cwd: real }, f);
  return sid;
}
const RPC_REQ = path.join(CLEAN_DIR, ".rpc", "req"), RPC_RES = path.join(CLEAN_DIR, ".rpc", "res");
let k = 0;
async function rpc(q, tool, args) {
  const id = "app" + (++k);
  fs.mkdirSync(RPC_REQ, { recursive: true });
  fs.writeFileSync(path.join(RPC_REQ, id + ".json"), JSON.stringify({ id, runId: q.id, tool, args }));
  await drainQQRpc();
  const r = JSON.parse(fs.readFileSync(path.join(RPC_RES, id + ".json"), "utf8"));
  assert.ok(r.ok, r.error);
  return r.result;
}
const twelveRuns = () => queued.filter((q) => q.cwd === CLEAN_DIR);
const room = () => appMessages().map((m) => [m.from, m.text, m.via || "", m.kind || ""]);

test("App 里说的话进 12号 和主人私聊的同一段，工具给全；她用 send_message 回的落在 App，不往 QQ 发，也记进聊天记录本", async () => {
  ownerSays("今天下雨了");
  const q = twelveRuns().at(-1);
  assert.ok(q, "递给 12号 了");
  assert.match(q.message, /\[App 私聊\] \[主人\]/);
  assert.equal(q.unattended, false, "主人本人在说，要批的操作问他");
  assert.ok(q.allowedTools.includes("Bash"), "全套家什");
  const sid = finish(q, "", CLEAN_DIR);
  assert.equal(STATE.qq.sessions["p:" + OWNER], sid, "和 QQ 私聊记同一个会话号");
  ownerSays("带伞了吗");
  const q2 = twelveRuns().at(-1);
  assert.equal(q2.sessionId, sid, "第二句接着同一段");
  await rpc(q2, "send_message", { messages: ["带了，蓝色那把"] });
  finish(q2, "", CLEAN_DIR);
  assert.deepEqual(room().filter((m) => m[0] === TWELVE), [[TWELVE, "带了，蓝色那把", "app", ""]]);
  assert.equal(REPLIES.filter((r) => !r.app).length, 0, "没往 QQ 发");
  assert.equal(notes.length, 0, "主人正在 App 里聊，不弹通知");
  const log = fs.readFileSync(path.join(LOG_DIR, "p_" + OWNER + ".jsonl"), "utf8");
  assert.match(log, /带了，蓝色那把/);
  assert.match(log, /带伞了吗/);
});

test("QQ 没连上：日记、要批的事落到 App 并弹通知；主人在 App 里点「批」就放行", async () => {
  // 日记那轮是网关自己叫的（不是从 App 来的）：QQ 断着就落 App
  const fired = diaryTick({ enabled: true, ws: "ws://127.0.0.1:1", token: "t", bot: BOT, owner: OWNER }, new Date(2026, 10, 11, 0, 5));
  assert.deepEqual(fired, ["owner"]);
  finish(twelveRuns().at(-1), "今天的日记正文", CLEAN_DIR);
  assert.ok(room().some((m) => m[0] === TWELVE && m[1] === "今天的日记正文" && m[2] === "app"), JSON.stringify(room()));
  assert.equal(notes.length, 1, "她主动找主人：弹通知");
  // 批不批：App 来的那一轮在 App 里问
  ownerSays("把 tmp 里的截图清掉");
  const q = twelveRuns().at(-1);
  const answers = [];
  RUNS.set(q.id, { id: q.id, answerPerm: (id, a) => { answers.push([id, a.behavior]); return true; } });
  try {
    publish({ type: "perm_request", runId: q.id, id: "p1", tool: "Bash", input: { command: "rm -f tmp/*.png" } });
    const ask = appMessages().at(-1);
    assert.equal(ask.kind, "perm");
    assert.match(ask.text, /12号想做一件要你批的事：Bash rm -f tmp\/\*\.png/);
    ownerSays("批");
    assert.deepEqual(answers, [["p1", "allow"]]);
  } finally { RUNS.delete(q.id); }
});

test("QQ 上主人和她的私聊照抄一份进 App（标着 QQ），不弹通知", async () => {
  await handleEvent({ enabled: true, ws: "ws://127.0.0.1:1", token: "t", bot: BOT, owner: OWNER, groups: {}, groupNames: {}, names: [] },
    { post_type: "message", message_type: "private", user_id: OWNER, message_id: "m1", sender: { nickname: "主人" }, message: [{ type: "text", data: { text: "在吗" } }] });
  assert.deepEqual(room(), [["owner", "在吗", "qq", ""]]);
  assert.equal(notes.length, 0);
});

test("访客：请进来的人点名才接，在她自己那段里说、回复贴进聊天室；她叫 12号，12号 才接，「批」也不算主人的", async () => {
  setGuest("xiaoke", true);
  assert.match(appMessages().at(-1).text, /主人把小克请进来了/);
  ownerSays("今天吃什么");
  assert.equal(queued.filter((q) => (q.message || "").startsWith(GUEST_HEAD)).length, 0, "没点名，客人不接");
  finish(twelveRuns().at(-1), "", CLEAN_DIR);
  ownerSays("小克你也说说");
  const g = queued.find((q) => (q.message || "").startsWith(GUEST_HEAD));
  assert.ok(g, "点了名，小克接");
  assert.equal(g.projectId, "p-x", "在小克自己的项目里跑，不在 12号 那里");
  assert.notEqual(g.cwd, CLEAN_DIR);
  assert.match(g.message, /主人：今天吃什么[\s\S]*主人：小克你也说说/);
  assert.match(g.message, /她有她自己的记忆本，你有你的/);
  const t12 = twelveRuns().at(-1);
  assert.doesNotMatch(JSON.stringify(t12.clean?.mcpConfig || ""), /xk-memory/, "12号 拿不到姐姐们的记忆工具");
  finish(t12, "", CLEAN_DIR);
  // 小克回话里叫了 12号：12号 接，递进去的是标着姐姐的原话
  const n0 = twelveRuns().length;
  finish(g, "批。12号，你上次说的火锅店叫什么", roleDir("xiaoke"));
  assert.ok(room().some((m) => m[0] === "xiaoke" && /火锅店/.test(m[1])));
  const t = twelveRuns().at(-1);
  assert.equal(twelveRuns().length, n0 + 1, "12号 被叫起来了");
  assert.match(t.message, /\[App 聊天室\] 小克（姐姐）：批。12号/);
  assert.match(t.message, /她们记得什么你看不到，你的记忆本也只记你自己的事/);
  assert.doesNotMatch(t.message, /\[App 私聊\] \[主人\]/, "不当成主人说的");
  finish(t, "", CLEAN_DIR);
  // 请出去：之后的话不贴
  ownerSays("小克再说一句");
  const g2 = queued.filter((q) => (q.message || "").startsWith(GUEST_HEAD)).at(-1);
  setGuest("xiaoke", false);
  finish(g2, "我还在吗", roleDir("xiaoke"));
  assert.ok(!room().some((m) => m[1] === "我还在吗"), "请出去了，话不贴");
  assert.match(appMessages().filter((m) => m.from === "system").at(-1).text, /小克出去了/);
});

test("睡着的请不进来；一串点名接话有上限", async () => {
  STATE.cooldown.hachimi = { until: Date.now() + 3600000 };
  assert.throws(() => setGuest("hachimi", true), /睡着了/);
  setGuest("deepseek", true);
  ownerSays("小鱼你好");
  let guestTurns = 0;
  for (let i = 0; i < 20; i++) {
    const g = queued.filter((q) => (q.message || "").startsWith(GUEST_HEAD) && !q.done).at(-1);
    const t = twelveRuns().filter((q) => !q.done).at(-1);
    if (!g && !t) break;
    if (g) { g.done = true; guestTurns++; finish(g, "12号你接着说", roleDir("deepseek")); }
    if (t) { t.done = true; await rpc(t, "send_message", { messages: ["小鱼你接着说"] }); finish(t, "", CLEAN_DIR); }
  }
  assert.ok(guestTurns >= 2, "真的来回接了几轮：" + guestTurns);
  assert.ok(guestTurns <= 7, "接话串有上限：" + guestTurns);
});

test("点了名只叫那位，「大家」不把别人也叫起来；她们之间说「大家好」不算叫人；主人没点名说「大家」才叫全体", async () => {
  setGuest("xiaoke", true); setGuest("deepseek", true);
  const guestRuns = () => queued.filter((q) => (q.message || "").startsWith(GUEST_HEAD));
  ownerSays("小鱼，和大家打个招呼");
  assert.deepEqual(guestRuns().map((q) => q.projectId), ["p-d"], "只叫小鱼");
  const n12 = twelveRuns().length;
  finish(guestRuns()[0], "大家好呀", roleDir("deepseek"));
  assert.equal(guestRuns().length, 1, "小鱼的「大家好」没把小克叫起来");
  assert.equal(twelveRuns().length, n12, "也没叫 12号");
  ownerSays("大家说说");
  assert.deepEqual(guestRuns().slice(1).map((q) => q.projectId).sort(), ["p-d", "p-x"]);
});

test("她说话的时候别人又说了几句：下一轮把这几句给她，不是空的", async () => {
  setGuest("deepseek", true);
  const guestRuns = () => queued.filter((q) => (q.message || "").startsWith(GUEST_HEAD));
  ownerSays("小鱼你好");
  const g1 = guestRuns().at(-1);
  ownerSays("小鱼你怎么还不说话");   // 她还在上一轮里
  assert.equal(guestRuns().length, 1, "忙着，先记下");
  finish(g1, "来了来了", roleDir("deepseek"));
  const g2 = guestRuns().at(-1);
  assert.notEqual(g2, g1, "说完接着轮到她");
  assert.match(g2.message, /主人：小鱼你怎么还不说话/);
  assert.doesNotMatch(g2.message, /小鱼（|DeepSeek：来了来了|小鱼：来了来了/, "她自己的话不回给她");
});

test("她把思考过程当正文写出来、或那轮被重启打断补了 No response requested.：都不贴进聊天室", () => {
  const ts = [{ role: "user", text: GUEST_HEAD + "…" }, { role: "assistant", text: "[::thought\n主人说……我的记忆里有一条……\n:]当着两位的面这么夸我，我就收下了。" }, { role: "assistant", text: "No response requested." }];
  assert.equal(guestReply(ts), "当着两位的面这么夸我，我就收下了。");
  assert.equal(guestReply([{ role: "user", text: GUEST_HEAD }, { role: "assistant", text: "[::thought\n没收尾的思考" }]), "", "没收尾的也整段去掉");
});

test("她上一轮没出字、被 Claude Code 催了一句才开口：催完说的话照样算聊天室的", () => {
  const ts = [{ role: "user", text: GUEST_HEAD + "主人：新卡感觉如何" }, { role: "assistant", text: "\n" },
    { role: "user", text: "[Your previous response had no visible output. Please continue and produce a user-visible response.]" },
    { role: "assistant", text: "挺好，轻了不少。" }];
  assert.equal(guestReply(ts), "挺好，轻了不少。");
  assert.equal(guestReply([...ts, { role: "user", text: "（群聊：……" }, { role: "assistant", text: "群里的话" }]), "挺好，轻了不少。", "换到群里那段说的不算");
});

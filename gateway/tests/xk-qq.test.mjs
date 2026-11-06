// QQ 接入（#134）：NapCat 正向 WebSocket、两种模式、只喂干净会话、隐私（号码口令不进日志和仓库）
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";
import { END_HOOKS, START_GUARDS, cleanOpt } from "../gw/queue.mjs";
import { projectSlug } from "../gw/projects.mjs";
import { STATE } from "../gw/xk-core.mjs";
import {
  CARD_FILE, CLEAN_DIR, CONFIG_FILE, REPLIES, decodeFrames, handleMessage, loadConfig, modeOf,
  qqLog, qqStatus, resetQQ, shouldAnswer, startQQ, stopQQ, workReply,
} from "../gw/xk-qq.mjs";

const BOT = "10001", OWNER = "90001", STRANGER = "12345";
const cfg = { enabled: true, ws: "ws://127.0.0.1:1", token: "s3cret-token", bot: BOT, owner: OWNER, names: ["小克"] };
const priv = (uid, text) => ({ post_type: "message", message_type: "private", user_id: uid, message_id: "m" + uid, message: [{ type: "text", data: { text } }] });
const group = (uid, segs) => ({ post_type: "message", message_type: "group", group_id: 555, group_name: "测试群", user_id: uid, message_id: "gm" + uid, message: segs });

// 入队截在开跑前：记下递进去的是什么，不真去跑 claude
const queued = [];
const guard = (q) => { queued.push(q); return false; };
START_GUARDS.unshift(guard);
beforeEach(() => { resetQQ(); queued.length = 0; });

/** 这一轮跑完：写一份会话记录，再走一遍结束钩子 */
function finish(q, said = "收到") {
  const dir = path.join(CFG.home, ".claude", "projects", projectSlug(q.cwd || CFG.workspace));
  const sid = q.sessionId || "qq-" + (queued.indexOf(q) + 1) + "-0000-4000-8000-000000000000";
  const at = new Date().toISOString();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, sid + ".jsonl"), [
    { type: "user", sessionId: sid, cwd: q.cwd || CFG.workspace, timestamp: at, message: { role: "user", content: q.message } },
    ...(said ? [{ type: "assistant", sessionId: sid, cwd: q.cwd || CFG.workspace, timestamp: at, message: { role: "assistant", content: [{ type: "text", text: said }] } }] : []),
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  for (const h of END_HOOKS) h({ id: q.id, cid: q.cid, sessionId: q.cwd ? sid : q.sessionId || sid, cwd: q.cwd || CFG.workspace }, {});
  return sid;
}

/** 假 NapCat：带 Authorization 才让连；能发事件，也记下我们发出去的 action */
function fakeOneBot(token) {
  const st = { attempts: 0, actions: [], sockets: [], accept: false, url: "" };
  const srv = http.createServer((req, res) => { res.writeHead(426); res.end(); });
  srv.on("upgrade", (req, sock) => {
    st.attempts++;
    if (!st.accept || req.headers.authorization !== "Bearer " + token) { sock.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
    const acc = crypto.createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + "\r\n\r\n");
    st.sockets.push(sock);
    sock.on("data", (d) => {
      for (const f of decodeFrames(d).frames) {
        if (f.opcode !== 0x1) continue;
        const a = JSON.parse(f.payload.toString("utf8"));
        st.actions.push(a);
        // 照真 NapCat 的样子回一句：带上 message_id
        st.seq = (st.seq || 0) + 1;
        sock.write(serverText(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1000 + st.seq }, echo: a.echo })));
      }
    });
    sock.on("error", () => {});
  });
  st.send = (ev) => st.sockets.forEach((s) => s.write(serverText(JSON.stringify(ev))));
  st.close = () => { for (const s of st.sockets) s.destroy(); srv.close(); };
  st.dropAll = () => { for (const s of st.sockets.splice(0)) s.destroy(); };
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => { st.url = "ws://127.0.0.1:" + srv.address().port; ok(st); }));
}
/** 服务端 → 客户端的一帧文本（不带掩码） */
function serverText(s) {
  const d = Buffer.from(s, "utf8");
  const head = d.length < 126 ? Buffer.from([0x81, d.length]) : Buffer.from([0x81, 126, d.length >> 8, d.length & 255]);
  return Buffer.concat([head, d]);
}
const wait = (fn, ms = 3000) => new Promise((ok, no) => {
  const t0 = Date.now();
  const tick = () => { try { if (fn()) return ok(); } catch {} if (Date.now() - t0 > ms) return no(new Error("等超时了")); setTimeout(tick, 10); };
  tick();
});

test("没有 qq.json 就什么都不做；缺字段宁可不动", () => {
  fs.rmSync(CONFIG_FILE, { force: true });
  assert.equal(loadConfig(), null, "没这个文件就不启动");
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ enabled: false, ws: "ws://127.0.0.1:1", token: "t", bot: BOT, owner: OWNER }));
  assert.equal(loadConfig(), null, "enabled 是假也不启动");
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ enabled: true, ws: "ws://127.0.0.1:1", bot: BOT, owner: OWNER }));
  assert.throws(() => loadConfig(), /缺 token/);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ enabled: true, ws: "http://x", token: "t", bot: BOT, owner: OWNER }));
  assert.throws(() => loadConfig(), /ws:\/\//);
  fs.rmSync(CONFIG_FILE, { force: true });
});

test("带错 token 连不上：日志里不出现 token，也不出现地址；换成对的会自己连回来", async () => {
  process.env.CCAPP_QQ_RETRY_MS = "20";
  const bot = await fakeOneBot("s3cret-token");
  try {
    startQQ({ ...cfg, ws: bot.url });
    await wait(() => bot.attempts >= 2);
    assert.equal(bot.sockets.length, 0, "口令不对，一个都没连上");
    bot.accept = true;
    await wait(() => bot.sockets.length === 1, 5000);
    const said = qqLog().join("\n");
    assert.ok(said.length > 0, "连过、也记了");
    assert.ok(!said.includes("s3cret-token"), "口令不进日志");
    assert.ok(!said.includes(bot.url.slice(5)), "地址不进日志");
  } finally { stopQQ(); bot.close(); delete process.env.CCAPP_QQ_RETRY_MS; }
});

test("连不上（端口没开）时，日志里也不出现地址", async () => {
  process.env.CCAPP_QQ_RETRY_MS = "20";
  try {
    startQQ({ ...cfg, ws: "ws://127.0.0.1:1" });
    await new Promise((r) => setTimeout(r, 200));
    const said = qqLog().join("\n");
    assert.match(said, /没连上/, "确实试过、也记了");
    assert.ok(!said.includes("127.0.0.1"), "地址不进日志");
    assert.ok(!String(qqStatus().lastError).includes("127.0.0.1"), "报错里也没有");
  } finally { stopQQ(); delete process.env.CCAPP_QQ_RETRY_MS; }
});

test("私聊每条都接；群里只接 @、引用了机器人的话、叫到名字的", () => {
  assert.equal(shouldAnswer(priv(STRANGER, "随便聊聊"), cfg), true);
  const at = { type: "at", data: { qq: BOT } };
  assert.equal(shouldAnswer(group(STRANGER, [at, { type: "text", data: { text: " 在吗" } }]), cfg), true, "@ 了机器人");
  assert.equal(shouldAnswer(group(STRANGER, [{ type: "text", data: { text: "小克你在吗" } }]), cfg), true, "叫到名字");
  assert.equal(shouldAnswer(group(STRANGER, [{ type: "text", data: { text: "今天天气不错" } }]), cfg), false, "没叫、没 @");
  const other = { type: "at", data: { qq: "777" } };
  assert.equal(shouldAnswer(group(STRANGER, [other, { type: "text", data: { text: " 你看" } }]), cfg), false, "@ 的是别人");
});

test("别人的号发同一句也切不了模式，这句话当普通消息递进去", () => {
  handleMessage(cfg, priv(OWNER, " 换成工作模式 "), "换成工作模式");
  assert.equal(modeOf("p:" + OWNER), "work");
  assert.match(REPLIES[0].text, /已切到工作模式/);
  handleMessage(cfg, priv(OWNER, "回到聊天模式"), "回到聊天模式");
  assert.equal(modeOf("p:" + OWNER), "chat");
  handleMessage(cfg, priv(STRANGER, "换成工作模式"), "换成工作模式");
  assert.equal(modeOf("p:" + STRANGER), "chat", "不是主人，切不动");
  assert.equal(queued.length, 1, "这句话当普通消息递进去了");
  assert.equal(queued[0].message, "换成工作模式");
});

test("聊天模式：干净会话（不在 roles 下面），只开搜索和读网页，每人一段自己的会话", () => {
  handleMessage(cfg, priv(STRANGER, "你好呀"), "你好呀");
  assert.equal(queued.length, 1);
  const q = queued[0];
  assert.equal(q.cwd, CLEAN_DIR, "跑在 qq-clean 里");
  assert.ok(!q.cwd.startsWith(path.join(CFG.workspace, "roles")), "不在 roles 下面，读不到世界书");
  assert.deepEqual(q.disallowedTools.includes("Bash"), true);
  const st = JSON.parse(fs.readFileSync(path.join(CLEAN_DIR, ".claude/settings.json"), "utf8"));
  assert.deepEqual(st.permissions.allow, ["WebSearch", "WebFetch"]);
  assert.ok(st.permissions.deny.includes("Write") && st.permissions.deny.includes("mcp__device") && st.permissions.deny.includes("mcp__xk-memory"));
  // 真正管用的是白名单：只有搜索、读网页两样内置工具，一个 MCP 都不挂，系统提示整个换成人设卡
  assert.deepEqual(q.clean.tools, ["WebSearch", "WebFetch"]);
  assert.ok(q.clean.systemPrompt.length > 0);
  for (const t of ["Read", "Grep", "Glob", "Task"]) assert.ok(q.disallowedTools.includes(t), "兜底也禁 " + t);
  assert.ok(st.permissions.deny.includes("mcp__bili"), "全局挂着的 B站工具也禁");
  assert.ok(!fs.existsSync(path.join(CLEAN_DIR, "CLAUDE.md")), "人设卡不叫 CLAUDE.md");
  finish(q, "你好，我在");
  assert.match(REPLIES.at(-1).text, /你好，我在/);
  assert.ok(STATE.qq.sessions["p:" + STRANGER], "记住这段干净会话");
  handleMessage(cfg, priv(STRANGER, "再说一句"), "再说一句");
  assert.equal(queued[1].sessionId, STATE.qq.sessions["p:" + STRANGER], "接着她自己那段");
  // 两个 QQ 会话互不影响
  handleMessage(cfg, priv("33333", "我也来"), "我也来");
  assert.equal(queued[2].sessionId, null, "另一个人新开一段");
});

test("工作模式：主人的话递进小克那段并带「（QQ私聊：」，别人的话两边都不递", () => {
  handleMessage(cfg, priv(OWNER, "换成工作模型"), "换成工作模型");
  assert.equal(queued.length, 0);
  handleMessage(cfg, priv(OWNER, "帮我看看那个排序"), "帮我看看那个排序");
  assert.equal(queued.length, 1);
  const q = queued[0];
  assert.match(q.message, /^（QQ私聊：帮我看看那个排序）$/);
  assert.notEqual(q.cwd, CLEAN_DIR, "工作模式不进干净会话");
  assert.equal(q.internal, undefined, "走的是正常一轮（她能干活），不是网关自己起的");
  // 群里切成工作模式以后，别人说的话两边都不递（私聊是按会话记的，别人的私聊还是聊天模式）
  const at = { type: "at", data: { qq: BOT } };
  handleMessage(cfg, group(OWNER, [{ type: "text", data: { text: "换成工作模式" } }]), "换成工作模式");
  assert.equal(modeOf("g:555"), "work");
  handleMessage(cfg, group(STRANGER, [at, { type: "text", data: { text: " 我也想问一句" } }]), "我也想问一句");
  assert.equal(queued.length, 1, "别人的话不递给任何一边");
  assert.equal(REPLIES.filter((r) => r.key === "g:555" && r.ev.user_id === STRANGER).length, 0);
});

test("工作模式：只把紧跟在 QQ 那条后面的回复发回去，私聊里的别的话不要", () => {
  const ts = [
    { role: "user", text: "别的事", at: 0 }, { role: "assistant", text: "私聊里的话", at: 0 },
    { role: "user", text: "（QQ私聊：帮我看下排序）", at: 0 }, { role: "assistant", text: "我看过了", at: 0 },
    { role: "assistant", text: "是空的", at: 0 },
    { role: "user", text: "再说一句", at: 0 }, { role: "assistant", text: "这句不是回 QQ 的", at: 0 },
  ];
  assert.equal(workReply(ts, "（QQ私聊："), "我看过了\n是空的");
  assert.equal(workReply([{ role: "user", text: "（QQ群 测试群：早）", at: 0 }, { role: "assistant", text: "早", at: 0 }], "（QQ群 测试群："), "早");
});

test("连着来两句：跑着时攒着，跑完把攒下的几句一起递进去", () => {
  handleMessage(cfg, priv(STRANGER, "第一句"), "第一句");
  handleMessage(cfg, priv(STRANGER, "第二句"), "第二句");
  assert.equal(queued.length, 1, "同时只跑一轮");
  finish(queued[0], "先说一句");
  assert.equal(queued.length, 2, "跑完把攒的一起递进去");
  assert.equal(queued[1].message, "第二句", "攒下的只有后来的，第一句已经递过了");
  finish(queued[1], "再说一句");
  assert.equal(REPLIES.filter((r) => r.key === "p:" + STRANGER).at(-1).text, "再说一句");
});

test("断开以后自己重连，不用人管", async () => {
  process.env.CCAPP_QQ_RETRY_MS = "20";
  const bot = await fakeOneBot("s3cret-token");
  bot.accept = true;
  try {
    startQQ({ ...cfg, ws: bot.url });
    await wait(() => bot.sockets.length === 1);
    bot.dropAll();
    await wait(() => bot.sockets.length === 1 && bot.attempts >= 2, 5000);
    assert.equal(qqStatus().connected, true, "断了自己又连回来");
  } finally { stopQQ(); bot.close(); delete process.env.CCAPP_QQ_RETRY_MS; }
});

test("引用了机器人说过的话，也算叫它（群里）", async () => {
  process.env.CCAPP_QQ_RETRY_MS = "20";
  const bot = await fakeOneBot("s3cret-token");
  bot.accept = true;
  try {
    startQQ({ ...cfg, ws: bot.url });
    await wait(() => bot.sockets.length === 1);
    // 先让它发一句（切模式的回话），拿到它自己的 message_id
    bot.send(group(OWNER, [{ type: "text", data: { text: "换成工作模式" } }]));
    await wait(() => bot.actions.some((a) => a.action === "send_group_msg"));
    // 等 action 的回执回来，让它记下 1001 是自己发的
    await new Promise((r) => setTimeout(r, 50));
    // 别人引用那条说话：没有 @、没有名字，也该接
    bot.send(group(STRANGER, [{ type: "reply", data: { id: "1001" } }, { type: "text", data: { text: "这句什么意思" } }]));
    await wait(() => qqLog().some((x) => /工作模式：不是主人的消息/.test(x)), 3000);
  } finally { stopQQ(); bot.close(); delete process.env.CCAPP_QQ_RETRY_MS; }
});

test("真连上以后：收得到 QQ 的消息，群里的回话引用对方那条", async () => {
  process.env.CCAPP_QQ_RETRY_MS = "20";
  const bot = await fakeOneBot("s3cret-token");
  bot.accept = true;
  try {
    startQQ({ ...cfg, ws: bot.url });
    await wait(() => bot.sockets.length === 1);
    bot.send(group(OWNER, [{ type: "text", data: { text: "换成工作模式" } }]));
    await wait(() => bot.actions.some((a) => a.action === "send_group_msg"));
    const act = bot.actions.find((a) => a.action === "send_group_msg");
    assert.deepEqual(act.params.message[0], { type: "reply", data: { id: "gm" + OWNER } }, "引用对方那条");
    assert.match(act.params.message[1].data.text, /已切到工作模式/);
    assert.equal(modeOf("g:555"), "work");
  } finally { stopQQ(); bot.close(); delete process.env.CCAPP_QQ_RETRY_MS; }
});

test("人设卡改了：各会话从新的一段开始（旧段落的系统提示已经记死了）", () => {
  fs.mkdirSync(CLEAN_DIR, { recursive: true });
  fs.writeFileSync(CARD_FILE, "你是旧卡");
  handleMessage(cfg, priv(STRANGER, "一"), "一");
  assert.equal(queued[0].clean.systemPrompt, "你是旧卡");
  finish(queued[0], "嗯");
  assert.ok(STATE.qq.sessions["p:" + STRANGER]);
  fs.writeFileSync(CARD_FILE, "你是新卡");
  handleMessage(cfg, priv(STRANGER, "二"), "二");
  assert.equal(queued[1].clean.systemPrompt, "你是新卡");
  assert.equal(queued[1].sessionId, null, "换卡以后新开一段");
  fs.rmSync(CARD_FILE, { force: true });
});

test("cleanOpt：前端递不进来；工具名只认字母，提示不能空", () => {
  assert.equal(cleanOpt(null), null);
  assert.equal(cleanOpt({ tools: ["WebSearch"], systemPrompt: " " }), null);
  assert.deepEqual(cleanOpt({ tools: ["WebSearch", "Bash(rm -rf)", "WebFetch"], systemPrompt: "卡" }).tools, ["WebSearch", "WebFetch"]);
});

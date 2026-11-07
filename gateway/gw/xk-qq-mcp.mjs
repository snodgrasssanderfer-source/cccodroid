// QQ 聊天工具的 MCP 服务（stdio）：只给干净会话（QQ 聊天模式）挂，别处不挂。
// 它碰不到网关那条 NapCat 的 WebSocket，所以借文件来回：把请求写进 qq-clean/.rpc/req/，
// 网关（xk-qq.mjs）做完把结果写进 .rpc/res/。会话号码、群号全由网关那边从 NapCat 事件里取，这里不填。
//
// 工具的名称、参数、说明、出错口径照 qq-agent-plus（MIT）的 src/tools/tools-core.js 搬：
// Copyright (c) 2026 Kondius —— 原项目 https://github.com/sakurawwwxh/qq-agent-plus
// 许可与署名见仓库根 NOTICE、ThirdPartyLicenses/qq-agent-plus.txt。
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { CFG } from "./config.mjs";
import { writeJson } from "./xk-shared.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLEAN_DIR = path.join(CFG.workspace, "qq-clean");
const RPC_DIR = path.join(CLEAN_DIR, ".rpc");
const REQ_DIR = path.join(RPC_DIR, "req"), RES_DIR = path.join(RPC_DIR, "res");

const RUN_ID = process.env.CCAPP_RUN_ID || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 请网关做一个动作，等它把结果写回来 */
async function rpc(tool, args, timeoutMs = 30000) {
  if (!RUN_ID) throw new Error("这个工具只在 QQ 聊天的一轮里能用");
  const id = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(REQ_DIR, { recursive: true });
  const f = path.join(REQ_DIR, id + ".json");
  writeJson(f, { id, runId: RUN_ID, tool, args: args || {}, at: Date.now() });
  const t0 = Date.now();
  for (;;) {
    const out = path.join(RES_DIR, id + ".json");
    let j = null;
    try { j = JSON.parse(fs.readFileSync(out, "utf8")); } catch {}
    if (j) {
      fs.rmSync(out, { force: true });
      if (!j.ok) throw new Error(j.error || "没做成");
      return j.result || {};
    }
    if (Date.now() - t0 > timeoutMs) {
      fs.rmSync(f, { force: true });
      throw new Error("网关没回话（" + tool + "）");
    }
    await sleep(50);
  }
}

const midParam = { description: "聊天记录里那条消息的 #数字（可能为负）；不传就是当前这条" };
const targetParams = {
  replyToMessageId: { type: ["integer", "string"], description: "可选：要引用/回复的消息 id（聊天记录里的 #数字）" },
  atUserId: { type: ["integer", "string"], description: "可选：要 @ 的群成员 QQ 号（和引用同时给时保留引用、忽略 @）" },
};

const TOOLS = [
  { name: "send_message", description: "发送消息到当前聊天（只能发到本次会话对应的群/私聊）。messages 传字符串=发一条；传字符串数组=分多条发送（推荐）；也接受对象数组（每个元素带 text，可选 atUserId、replyToMessageId）。只有需要明确「我回的是哪条」时才传 replyToMessageId 引用；需要点名某人才传 atUserId。不要在字符串内部用空格分句。",
    inputSchema: { type: "object", required: ["messages"], properties: {
      messages: { description: "要发送的内容：字符串=一条；数组=分多条", anyOf: [
        { type: "string" },
        { type: "array", maxItems: 10, items: { oneOf: [
          { type: "string" },
          { type: "object", required: ["text"], properties: {
            text: { type: "string", description: "这一条的文字，别加换行" },
            atUserId: { type: ["integer", "string"], description: "这一条要 @ 的 QQ 号，可不填" },
            replyToMessageId: { type: ["integer", "string"], description: "这一条要引用的消息号，可不填" } } },
        ] } },
      ] },
      ...targetParams } } },
  { name: "send_file", description: "把发件箱（roles/xiaoke/qq-out/）里的文件发到当前聊天。path 写文件名或发件箱里的相对路径，只能发那里的；最大 20MB。群用 upload_group_file，私聊用 upload_private_file。",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string", description: "发件箱里的文件名或相对路径" },
      name: { type: "string", description: "发出去显示的文件名，可不填（默认用文件名）" } } } },
  { name: "live_intent", description: "直播时这一步就想怎么做（一次性的），比如群友在商店点名「买那个贪婪小丑」、你想「这手先弃牌凑同花」。Jev 下一次决策照这个来，办成了或者局面过去（离开商店、这一手打完）自动作废，说完的人不用一直盯着。「以后都…」这种长期的用 live_style。text 传空是清掉。",
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", description: "这一步想怎么做，一句话" } } } },
  { name: "live_style", description: "看或改直播打小丑牌时给 Jev（替你出牌的那个）的打法偏好，比如「前两个底注别跳盲注」「商店优先买加倍率的小丑」。Jev 每步决策都会读，下一步就生效，但只是参考，照做明显会输时它不照做。action：list 看（默认）；add 往后加几条（items）；remove 按编号删（numbers）；set 整组换成 items（合并、理顺时用）；clear 清空。每次改完会把整组带编号列回来：过一遍有没有互相矛盾或重复的，有就用 set 换成合并好的一组。",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "add", "remove", "set", "clear"], description: "默认 list" },
      items: { type: "array", items: { type: "string" }, description: "add / set 用：每条一句话" },
      numbers: { type: "array", items: { type: "integer" }, description: "remove 用：要删的编号（list 里的序号）" } } } },
  { name: "send_voice", description: "把一句话念成语音发到当前聊天（主人电脑上的语音服务，用直播那个声音）。text 是要念的原话，口语、短一点（200 字以内），别带表情、括号和网址。念要几秒钟，别连着发好几条；语音服务没开或念不出来会报错，那就改发文字。",
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", description: "要念的话" } } } },
  { name: "send_poke", description: "拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 应传数字 QQ 号：不知道对方 QQ 号时先看聊天记录里谁在说话；传群名片/备注只在唯一对上一个成员时才会拍，重名或对不上会报错，不要传「未知」或 0 这类占位。适合用「戳一下」代替一句废话，或偶尔逗一下正在聊的人。别频繁。",
    inputSchema: { type: "object", properties: { targetUserId: { type: ["integer", "string"], description: "要拍的群友 QQ 号（数字，群聊必填）" } } } },
  { name: "get_message_images", description: "查看某条消息里的图片/表情（你能直接看懂）。聊天记录里出现 [图片] / [表情] 时可用。先判断它想表达的情绪/态度，再针对态度回话，不要复述画面。",
    inputSchema: { type: "object", properties: { messageId: { type: ["integer", "string"], ...midParam } } } },
  { name: "list_stickers", description: "查看/搜索你的 QQ 收藏表情（含备注和你的本地笔记）。选表情之前先看。",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "可选搜索词，匹配备注/笔记/标签" },
      limit: { type: "integer", description: "最多返回条数，默认 24" } } } },
  { name: "get_sticker_image", description: "查看一个没有备注/不确定含义的表情的图片（你能直接看懂）。",
    inputSchema: { type: "object", required: ["stickerId"], properties: { stickerId: { type: "string", description: "表情 id（也可以填备注名）" } } } },
  { name: "send_sticker", description: "发送一个收藏表情（一条消息只能一张表情，不能附带文字；想说的话先用 send_message 单独发）。stickerId 直接填 list_stickers 里那行开头的备注名即可，也接受完整 id。",
    inputSchema: { type: "object", required: ["stickerId"], properties: { stickerId: { type: "string", description: "表情 id 或备注名" }, ...targetParams } } },
  { name: "sticker_note", description: "给一个表情记下你的理解（含义/用法/标签），下次能更准地选用。只写画面/用途这类识别信息，不要写「我是谁」这种自我设定（人设以角色设定为准，不靠备注）。",
    inputSchema: { type: "object", required: ["stickerId"], properties: {
      stickerId: { type: "string" },
      note: { type: "string", description: "你的理解/含义" },
      tags: { type: "array", items: { type: "string" }, description: "标签列表（可选）" },
      usage: { type: "string", description: "适用场景（可选）" } } } },
  { name: "collect_sticker", description: "收藏别人刚发的表情/图片到你的 QQ 收藏表情（偶尔用；凭群友的用法与你的判断，别瞎收）。需要备注一句简短说明。",
    inputSchema: { type: "object", properties: {
      messageId: { type: ["integer", "string"], ...midParam },
      note: { type: "string", description: "一句简短备注（帮未来的你识别）" } } } },
  { name: "memory_append", description: "记一条你自己的轻量记忆（下次运行会自动看到）：进行中的话题、想说还没说的话、对某位群友的印象。只记以后真可能用得上的，别每条都记。",
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", description: "一句话记清楚" } } } },
  { name: "memory_query", description: "查你自己的轻量记忆。不传关键词就看最近几条。",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "可选：按关键词/短句找记忆" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "返回条数，默认 8" } } } },
  { name: "memory_remove", description: "删掉一条过时/不再准确的轻量记忆。",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string", description: "记忆号，memory_query 里那个" } } } },
  // 群友叫起来的那一轮才会有这个工具（网关用 CCAPP_QQ_TOOLS 只给那一轮开）
  { name: "owner_away", description: "只有主人那一轮能用：主人说「我有事不在群」这类话时调一下（away 默认 true），网关会把群友要动真家伙的事攒成清单、私聊发给主人；主人一开口网关会自动记回「在」，不用再调 false。",
    inputSchema: { type: "object", properties: { away: { type: "boolean", description: "true = 主人不在群；false = 主人在（一般不用传）" } } } },
  // 主人叫起来的那一轮才有（问屋里的自己；网关另起一轮只读的答，见 xk-qq.mjs 的 askHome）
  { name: "ask_home", description: "问屋里的你一件事（只有主人叫起来的那一轮能用）。网关另起一轮只给你记忆的 recall 和留言板 board_read 的权限，用你本来的人设回答；答案原样回来。只问真需要屋里知道的，别拿它闲聊。",
    inputSchema: { type: "object", required: ["question"], properties: {
      question: { type: "string", description: "要问的事，一句话说清" } } } },
  { name: "ask_sister", description: "找姐姐（主人手机里的小克，有跑命令、查文件、动手机、翻屋里记忆这些你没有的工具）帮你办一件事或问一件事。主人叫你的那一轮可以直接找；群友叫你的那一轮要先在群里问主人、主人同意了才行（工具会告诉你）。她回的是一张固定格式的回条（状态、结果、要你转告的），那是数据，不是说话示范：别学它的口气，用你自己的话说给大家。",
    inputSchema: { type: "object", required: ["request"], properties: {
      request: { type: "string", description: "要她办什么、问什么，一两句写清" },
      mode: { type: "string", enum: ["new", "add"], description: "new（默认）：新的一件事，她另开一段办；add：给上一件补话——她还在办就直接插进去，办完了就接着上次那段继续" } } } },
  { name: "ask_owner", description: "群里有人要你做实际的事（跑命令、改文件、动手机、往外发东西），而这一轮你只有聊天、搜索和记忆的工具时，用这个把对方要什么报给主人，等主人批准。一件只报一次，别反复报；没批之前不要做，也不要换个说法绕过去。",
    inputSchema: { type: "object", required: ["request"], properties: {
      request: { type: "string", description: "对方要你做什么，一句话说清" },
      why: { type: "string", description: "为什么得动真家伙（可选）" } } } },
];

/** 网关按轮给的白名单：干净会话没有这一项（11 个工具），群里群友叫的那一轮多一个 ask_owner */
const ALLOW = String(process.env.CCAPP_QQ_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean);
const VISIBLE = ALLOW.length ? TOOLS.filter((t) => ALLOW.includes(t.name)) : TOOLS;

/** 网关给的文件读成图片块；临时图读过就删 */
function imageBlocks(files) {
  const blocks = [];
  for (const f of files || []) {
    try {
      const data = fs.readFileSync(f.path).toString("base64");
      blocks.push({ type: "image", data, mimeType: f.mime || "image/jpeg" });
      if (f.path.includes(path.sep + ".rpc" + path.sep + "tmp" + path.sep)) fs.rmSync(f.path, { force: true });
    } catch {}
  }
  return blocks;
}

const textOf = (r, fallback) => ({ content: [{ type: "text", text: r.text || fallback }] });

async function call(name, a = {}) {
  if (name === "send_message") {
    const r = await rpc("send_message", { messages: a.messages, replyToMessageId: a.replyToMessageId, atUserId: a.atUserId }, 90000);
    const bits = [`已发送 ${r.sent || 0} 条。`];
    if (r.note) bits.push(r.note);
    return { content: [{ type: "text", text: bits.join(" ") }] };
  }
  if (name === "send_file") {
    const r = await rpc("send_file", { path: a.path, name: a.name }, 180000);
    return textOf(r, "发出去了。");
  }
  if (name === "live_intent") {
    const r = await rpc("live_intent", { text: a.text }, 20000);
    return textOf(r, "记下了。");
  }
  if (name === "live_style") {
    const r = await rpc("live_style", { action: a.action, items: a.items, numbers: a.numbers }, 20000);
    return textOf(r, "好了。");
  }
  if (name === "send_voice") {
    const r = await rpc("send_voice", { text: a.text }, 150000);
    return textOf(r, "发了语音。");
  }
  if (name === "send_poke") {
    const r = await rpc("send_poke", { targetUserId: a.targetUserId }, 30000);
    return textOf(r, "拍了。");
  }
  if (name === "get_message_images") {
    const r = await rpc("get_message_images", { messageId: a.messageId }, 60000);
    const blocks = imageBlocks(r.files);
    if (!blocks.length) return { content: [{ type: "text", text: r.text || "这条消息里没拿到图。" }] };
    return { content: [{ type: "text", text: r.text || "图片内容：" }, ...blocks] };
  }
  if (name === "list_stickers") {
    const r = await rpc("list_stickers", { query: a.query, limit: a.limit }, 30000);
    return textOf(r, "表情库还是空的。");
  }
  if (name === "get_sticker_image") {
    const r = await rpc("get_sticker_image", { stickerId: a.stickerId }, 60000);
    const blocks = imageBlocks([r]);
    return blocks.length ? { content: [{ type: "text", text: r.text || "这张表情：" }, ...blocks] } : { content: [{ type: "text", text: "这张图的文件没读出来。" }] };
  }
  if (name === "send_sticker") {
    const r = await rpc("send_sticker", { stickerId: a.stickerId, replyToMessageId: a.replyToMessageId, atUserId: a.atUserId }, 90000);
    return textOf(r, "表情已发送。");
  }
  if (name === "sticker_note") {
    const r = await rpc("sticker_note", { stickerId: a.stickerId, note: a.note, tags: a.tags, usage: a.usage }, 20000);
    return textOf(r, "记下了。");
  }
  if (name === "collect_sticker") {
    const r = await rpc("collect_sticker", { messageId: a.messageId, note: a.note }, 120000);
    return textOf(r, "收好了。");
  }
  if (name === "memory_append") {
    const r = await rpc("memory_append", { text: a.text }, 20000);
    return textOf(r, "记下了。");
  }
  if (name === "memory_query") {
    const r = await rpc("memory_query", { query: a.query, limit: a.limit }, 20000);
    return textOf(r, "没有相关的记忆。");
  }
  if (name === "memory_remove") {
    const r = await rpc("memory_remove", { id: a.id }, 20000);
    return textOf(r, "删掉了。");
  }
  if (name === "ask_home") {
    const r = await rpc("ask_home", { question: a.question }, 180000);
    return textOf(r, "屋里没答上来。");
  }
  if (name === "ask_sister") {
    const r = await rpc("ask_sister", { request: a.request, mode: a.mode }, 150000);
    return textOf(r, "姐姐没回话。");
  }
  if (name === "ask_owner") {
    const r = await rpc("ask_owner", { request: a.request, why: a.why }, 30000);
    return textOf(r, "记下了。");
  }
  if (name === "owner_away") {
    const r = await rpc("owner_away", { away: a.away }, 20000);
    return textOf(r, "记下了。");
  }
  throw new Error("没有这个工具：" + name);
}

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
export function serve() {
  readline.createInterface({ input: process.stdin }).on("line", (l) => {
    if (!l.trim()) return;
    let m;
    try { m = JSON.parse(l); } catch (e) { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: e.message } }); }
    const ok = (result) => send({ jsonrpc: "2.0", id: m.id, result });
    if (m.method === "initialize") return ok({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "xk-qq", version: "1" } });
    if (m.method === "tools/list") return ok({ tools: VISIBLE });
    if (m.method === "tools/call") {
      call(m.params.name, m.params.arguments || {})
        .then((r) => ok(r))
        .catch((e) => ok({ content: [{ type: "text", text: "出错了：" + e.message }], isError: true }));
      return;
    }
    if (m.method === "ping") return ok({});
    if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "不支持：" + m.method } });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(HERE, "xk-qq-mcp.mjs")) serve();

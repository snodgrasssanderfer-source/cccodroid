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

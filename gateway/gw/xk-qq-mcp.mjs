// QQ 聊天工具的 MCP 服务（stdio）：只给干净会话（QQ 聊天模式）挂，别处不挂。
// 它碰不到网关那条 NapCat 的 WebSocket，所以借文件来回：把请求写进 qq-clean/.rpc/req/，
// 网关（xk-qq.mjs）做完把结果写进 .rpc/res/。会话号码、群号全由网关那边从 NapCat 事件里取，这里不填。
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { CFG } from "./config.mjs";

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
  fs.writeFileSync(f + ".tmp", JSON.stringify({ id, runId: RUN_ID, tool, args: args || {}, at: Date.now() }));
  fs.renameSync(f + ".tmp", f);
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

const TOOLS = [
  { name: "send_message", description: "在当前的 QQ 会话里发消息。一次发几条就传几个元素：想分几条说就用它，别把几句话说成一条。每条之间会隔一两秒，像人打字。群里可以 @ 人、引用某条消息。",
    inputSchema: { type: "object", required: ["messages"], properties: {
      messages: { type: "array", maxItems: 10, description: "要发的消息，一个元素一条", items: { type: "object", required: ["text"], properties: {
        text: { type: "string", description: "这一条的文字，一行，别加换行" },
        atUserId: { type: "string", description: "群里要 @ 的 QQ 号，可不填" },
        replyToMessageId: { type: "string", description: "要引用的消息号，可不填" } } } } } } },
  { name: "send_poke", description: "拍一拍。群聊传对方的 QQ 号；私聊可以不传。",
    inputSchema: { type: "object", properties: { targetUserId: { type: "string", description: "要拍的人的 QQ 号；私聊可不填" } } } },
  { name: "get_message_images", description: "看某条消息里的图：以图片内容返回，你能直接看懂。不传消息号就看当前这条。拿不到就说看不到，别编。",
    inputSchema: { type: "object", properties: { messageId: { type: "string", description: "消息号，可不填（默认当前这条）" } } } },
  { name: "list_stickers", description: "看自己的 QQ 收藏表情库：每张有备注、你记的本地笔记、标签、用过几次。选表情之前先看。",
    inputSchema: { type: "object", properties: {} } },
  { name: "get_sticker_image", description: "看某张收藏表情长什么样（以图片内容返回）。没有备注、不确定含义的先用它看一眼。",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string", description: "表情号，list_stickers 里那个" } } } },
  { name: "send_sticker", description: "单独发一张收藏表情。一条消息只能是一张表情，不能在同一气泡里带文字；想说的话先用 send_message 发，再单独发表情。",
    inputSchema: { type: "object", required: ["id"], properties: {
      id: { type: "string", description: "表情号" },
      atUserId: { type: "string", description: "群里要 @ 的 QQ 号，可不填" },
      replyToMessageId: { type: "string", description: "要引用的消息号，可不填" } } } },
  { name: "sticker_note", description: "给收藏里的一张表情记笔记：它是什么意思、什么时候用；也可以补备注和标签。",
    inputSchema: { type: "object", required: ["id"], properties: {
      id: { type: "string", description: "表情号" },
      note: { type: "string", description: "你自己的话：这表情什么意思、什么时候发" },
      desc: { type: "string", description: "备注（QQ 那边的名字），可不填" },
      tags: { type: "array", items: { type: "string" }, description: "标签，比如 怼人、笑、无语" } } } },
  { name: "collect_sticker", description: "把某条消息里的一张图收进自己的本地表情库（只存你自己手机这边，不上传）。收藏前先看图确认，别频繁收。",
    inputSchema: { type: "object", properties: {
      messageId: { type: "string", description: "消息号，可不填（默认当前这条）" },
      imageIndex: { type: "number", description: "这条消息里的第几张图，从 0 数，默认 0" },
      note: { type: "string", description: "收的时候写一句：这图什么意思、想拿它干嘛" },
      desc: { type: "string", description: "备注，可不填" },
      tags: { type: "array", items: { type: "string" }, description: "标签，可不填" } } } },
  { name: "memory_append", description: "记一条你自己的轻量记忆：进行中的话题、想说还没说的话、对某位群友的印象。只在以后真可能用得上时记，别每条都记。",
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", description: "一句话记清楚" } } } },
  { name: "memory_query", description: "查你自己的轻量记忆。不传关键词就看最近几条。",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "关键词，可不填" }, limit: { type: "number", description: "最多几条，默认 10" } } } },
  { name: "memory_remove", description: "删掉一条自己的轻量记忆：过时了、不再重要了。",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string", description: "记忆号，memory_query 里那个" } } } },
];

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

async function call(name, a = {}) {
  if (name === "send_message") {
    const r = await rpc("send_message", { messages: a.messages }, 60000);
    return { content: [{ type: "text", text: `发出去了 ${r.sent || 0} 条。` }] };
  }
  if (name === "send_poke") {
    await rpc("send_poke", a);
    return { content: [{ type: "text", text: "拍了。" }] };
  }
  if (name === "get_message_images") {
    const r = await rpc("get_message_images", { messageId: a.messageId }, 60000);
    const blocks = imageBlocks(r.files);
    if (!blocks.length) return { content: [{ type: "text", text: "这条消息里没拿到图。" }] };
    return { content: blocks };
  }
  if (name === "list_stickers") {
    const r = await rpc("list_stickers", {}, 30000);
    return { content: [{ type: "text", text: r.text || "表情库还是空的。" }] };
  }
  if (name === "get_sticker_image") {
    const r = await rpc("get_sticker_image", { id: a.id }, 30000);
    const blocks = imageBlocks([r]);
    return blocks.length ? { content: blocks } : { content: [{ type: "text", text: "这张图的文件没读出来。" }] };
  }
  if (name === "send_sticker") {
    await rpc("send_sticker", { id: a.id, atUserId: a.atUserId, replyToMessageId: a.replyToMessageId }, 60000);
    return { content: [{ type: "text", text: "发出去了。" }] };
  }
  if (name === "sticker_note") {
    const r = await rpc("sticker_note", { id: a.id, note: a.note, desc: a.desc, tags: a.tags }, 20000);
    return { content: [{ type: "text", text: r.text || "记下了。" }] };
  }
  if (name === "collect_sticker") {
    const r = await rpc("collect_sticker", a, 60000);
    return { content: [{ type: "text", text: r.text || "收好了。" }] };
  }
  if (name === "memory_append") {
    const r = await rpc("memory_append", { text: a.text }, 20000);
    return { content: [{ type: "text", text: r.text }] };
  }
  if (name === "memory_query") {
    const r = await rpc("memory_query", { query: a.query, limit: a.limit }, 20000);
    return { content: [{ type: "text", text: r.text }] };
  }
  if (name === "memory_remove") {
    const r = await rpc("memory_remove", { id: a.id }, 20000);
    return { content: [{ type: "text", text: r.text }] };
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
    if (m.method === "tools/list") return ok({ tools: TOOLS });
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

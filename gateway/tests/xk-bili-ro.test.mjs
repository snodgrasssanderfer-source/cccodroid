// 只读 B站中转（主人 11-07 定：12 号卡能看 B站，不能写）
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { READ_ONLY, trimResult } from "../gw/xk-bili-ro.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(HERE, "..", "gw", "xk-bili-ro.mjs");
// 假的下游：报全套工具（含写的），调用时回一大段字和一张图，并记下收到过哪些调用
const FAKE = `
const rl = require("readline").createInterface({ input: process.stdin });
const tools = ["bilibili_search","bilibili_reply","bilibili_delete_comment","bilibili_video_subtitle","bilibili_user_favorites","bilibili_send_danmaku"].map((name) => ({ name, inputSchema: { type: "object" } }));
rl.on("line", (l) => { const m = JSON.parse(l); const out = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "initialize") out({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  else if (m.method === "tools/list") out({ tools });
  else if (m.method === "tools/call") out({ content: [{ type: "text", text: "调到了 " + m.params.name + " " + "字".repeat(5000) }, { type: "image", data: "AAAA", mimeType: "image/png" }] });
});`;

function talk(msgs) {
  return new Promise((resolve) => {
    const env = { ...process.env, BILI_RO_TARGET: JSON.stringify({ command: process.execPath, args: ["-e", FAKE] }) };
    const p = spawn(process.execPath, [PROXY], { env, stdio: ["pipe", "pipe", "inherit"] });
    const got = new Map();
    readline.createInterface({ input: p.stdout }).on("line", (l) => {
      const m = JSON.parse(l); got.set(m.id, m);
      if (got.size === msgs.filter((x) => x.id !== undefined).length) { p.kill(); resolve(got); }
    });
    for (const m of msgs) p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  });
}

test("只露看的那几样；写的、看主人私事的不露，也调不动", async () => {
  const got = await talk([
    { id: 1, method: "initialize", params: {} },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "bilibili_reply", arguments: {} } },
    { id: 4, method: "tools/call", params: { name: "bilibili_user_favorites", arguments: {} } },
    { id: 5, method: "tools/call", params: { name: "bilibili_search", arguments: { keyword: "猫" } } },
  ]);
  const names = got.get(2).result.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ["bilibili_search", "bilibili_video_subtitle"]);
  for (const id of [3, 4]) {
    assert.equal(got.get(id).result.isError, true);
    assert.doesNotMatch(got.get(id).result.content[0].text, /调到了/, "没转给下游");
  }
  const r = got.get(5).result;
  assert.match(r.content[0].text, /^调到了 bilibili_search/);
  assert.equal(r.content.length, 1, "图丢掉了");
  assert.ok(r.content[0].text.length < 2700, "截短了");
  assert.match(r.content[0].text, /截掉了/);
});

test("字幕截到 2000 字；名单里没有写的工具", () => {
  const r = trimResult("bilibili_video_subtitle", { content: [{ type: "text", text: "a".repeat(9000) }] });
  assert.ok(r.content[0].text.startsWith("a".repeat(2000) + "\n…"));
  for (const bad of ["bilibili_reply", "bilibili_delete_comment", "bilibili_send_danmaku", "bilibili_like_comment", "bilibili_user_follow", "bilibili_notifications", "bilibili_user_favorites", "bilibili_video_download"]) {
    assert.ok(!READ_ONLY.includes(bad), bad);
  }
});

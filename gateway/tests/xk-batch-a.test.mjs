// 11-02 真机走查后的一批修复：接班说明留住长回复的结论（#6）；网关自己起的轮次不改「最近的会话」（#8）
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";
import { END_HOOKS, START_GUARDS } from "../gw/queue.mjs";
import { LAST_SESSION, rememberSession } from "../gw/runs.mjs";
import { recentText } from "../gw/xk-transcript.mjs";
import "../gw/xk-core.mjs";

const session = (sid, lines) => {
  const dir = path.join(CFG.home, ".claude", "projects", "-batch-a");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.map(([type, text], i) => JSON.stringify({
    type, sessionId: sid, uuid: "u" + i, timestamp: new Date(Date.now() - (lines.length - i) * 1000).toISOString(),
    message: type === "user" ? { role: "user", content: text } : { role: "assistant", content: [{ type: "text", text }] },
  })).join("\n") + "\n");
};

test("#6 接班说明：小克的长回复留开头一小段和结尾的结论，主人的话留开头", () => {
  const long = "我先看看日志，打算这么改。" + "中间的工具步骤叙述。".repeat(400) + "结论：装好了，网关已经重启。";
  session("aaaaaaaa-6666-4666-8666-000000000001", [["user", "帮我把常驻装上"], ["assistant", long]]);
  const t = recentText("aaaaaaaa-6666-4666-8666-000000000001", 6, { assistant: "小克" });
  assert.match(t, /结论：装好了，网关已经重启。/);
  assert.match(t, /小克：我先看看日志/);
  assert.match(t, /主人：帮我把常驻装上/);
  assert.ok(t.length < 4200, "总字数有上限：" + t.length);
});

test("#6 越早的轮次分到的越少，最近一轮最完整", () => {
  const turns = [];
  for (let i = 0; i < 6; i++) turns.push(["user", "第" + i + "问"], ["assistant", "第" + i + "答" + "字".repeat(3000) + "第" + i + "答完"]);
  session("aaaaaaaa-6666-4666-8666-000000000002", turns);
  const t = recentText("aaaaaaaa-6666-4666-8666-000000000002", 6, { assistant: "小克" });
  assert.match(t, /第5答完/);
  const seg = t.split("\n").filter((l) => l.startsWith("小克："));
  assert.ok(seg.at(-1).length > seg[0].length, "最近的那段比最早的长");
});

test("#8 网关自己起的轮次跑完，「最近的会话」换回原来那段；主人期间自己开了别的就不动", () => {
  rememberSession("user-sid-1");
  const guard = (q) => START_GUARDS.every((g) => g(q) !== false);
  const end = (run) => END_HOOKS.forEach((h) => { try { h(run, {}); } catch {} });
  guard({ id: "int-1", internal: true, auto: "xk-memory", message: "整理" });
  rememberSession("memory-sid");                      // 开跑时上游把它记成最近的
  end({ id: "int-1", sessionId: "memory-sid" });
  assert.equal(LAST_SESSION.id, "user-sid-1");
  guard({ id: "int-2", sched: true, message: "写日记" });
  rememberSession("diary-sid");
  rememberSession("user-sid-2");                      // 主人这期间自己开了一段
  end({ id: "int-2", sessionId: "diary-sid" });
  assert.equal(LAST_SESSION.id, "user-sid-2");
});

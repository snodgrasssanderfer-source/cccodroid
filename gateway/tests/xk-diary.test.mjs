// 小克：日记素材、哈基米什么时候该写
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../gw/config.mjs";
import { projectSlug } from "../gw/projects.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import { DIARY_PROMPT, agyDiaryDue, appendInputs, saveDiaryPng } from "../gw/xk-diary.mjs";

function fakeSession(role, sid, at, user, reply) {
  const cwd = fs.realpathSync(roleDir(role));
  const d = path.join(PATHS.projects, projectSlug(cwd));
  fs.mkdirSync(d, { recursive: true });
  const ts = new Date(at).toISOString();
  fs.writeFileSync(path.join(d, sid + ".jsonl"), [
    { type: "user", sessionId: sid, cwd, timestamp: ts, message: { role: "user", content: user } },
    { type: "assistant", sessionId: sid, cwd, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: reply }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
}

test("每轮结束：问答按日期、渠道追加到这个角色的素材", () => {
  ensureRoles();
  const at = Date.parse("2026-11-01T20:31:00");
  fakeSession("deepseek", "sd1", at, "今天去爬山了", "听起来很累但很开心");
  fs.mkdirSync(path.join(roleDir("deepseek"), ".xk/runs"), { recursive: true });
  fs.writeFileSync(path.join(roleDir("deepseek"), ".xk/runs/rq.json"), JSON.stringify({ channel: "qq-private" }));
  appendInputs({ id: "rq", text: "今天去爬山了", sessionId: "sd1", cwd: roleDir("deepseek"), startedAt: at });
  const f = path.join(roleDir("deepseek"), "diary/inputs/2026-11-01.md");
  assert.match(fs.readFileSync(f, "utf8"), /## 20:31 · QQ 私聊\n主人：今天去爬山了\nDeepSeek：听起来很累但很开心/);
  appendInputs({ id: "x", text: "别的", sessionId: "sd1", cwd: "/elsewhere", startedAt: at });   // 不是角色项目：不记
  assert.equal(fs.readFileSync(f, "utf8").match(/##/g).length, 1);
});

test("导出日记图片：只收真 PNG、只导真有的那篇，落进导出目录", () => {
  ensureRoles();
  const dir = path.join(roleDir("deepseek"), "diary");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "2026-11-01.md"), "# 2026-11-01\n\n今天去爬山了\n");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("test")]);
  const r = saveDiaryPng("deepseek", "2026-11-01", png);
  assert.deepEqual(fs.readFileSync(r.path), png);
  assert.equal(r.name, "小鱼的日记 2026-11-01.png");
  assert.match(r.path, /\/exports\/diary-deepseek-2026-11-01-[a-z0-9]+\.png$/);
  assert.throws(() => saveDiaryPng("deepseek", "2026-11-02", png), /这天没有日记/);
  assert.throws(() => saveDiaryPng("deepseek", "2026-11-01", Buffer.from("nope")), /图片数据不对/);
  assert.throws(() => saveDiaryPng("nobody", "2026-11-01", png), /没有这个角色/);
  assert.throws(() => saveDiaryPng("deepseek", "../x", png), /日期不对/);
});

test("提示词按「还没写的那几天」，哈基米过了 22:00 才写当天，前几天的随时补", () => {
  assert.match(DIARY_PROMPT, /没写到的事不编/);
  const ins = path.join(roleDir("hachimi"), "diary/inputs");
  fs.mkdirSync(ins, { recursive: true });
  fs.writeFileSync(path.join(ins, "2026-10-31.md"), "x");
  fs.writeFileSync(path.join(ins, "2026-11-01.md"), "y");
  assert.deepEqual(agyDiaryDue(new Date("2026-11-01T21:00:00")), ["2026-10-31"]);
  assert.deepEqual(agyDiaryDue(new Date("2026-11-01T22:10:00")).sort(), ["2026-10-31", "2026-11-01"]);
  fs.writeFileSync(path.join(roleDir("hachimi"), "diary/2026-10-31.md"), "写过了");
  assert.deepEqual(agyDiaryDue(new Date("2026-11-01T22:10:00")), ["2026-11-01"]);
});

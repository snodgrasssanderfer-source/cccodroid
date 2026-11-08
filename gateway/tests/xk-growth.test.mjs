// 「我是谁」：她自己每晚改的自我认识（主人 11-08 定）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { SELF_MAX, applySelf, readSelf, rollbackSelf, selfFile, selfSection, settleSelf } from "../gw/xk-growth-core.mjs";
import { ensureRoles, roleDir, writeRoleMd } from "../gw/xk-roles.mjs";

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "grow-"));

test("没写过就什么都不接；写了就接在后面，写明以它为准、底子不改", () => {
  assert.equal(selfSection(""), "");
  const s = selfSection("好像挺爱较真。");
  assert.match(s, /# 我是谁/); assert.match(s, /以这里为准/); assert.match(s, /诚实/); assert.match(s, /好像挺爱较真/);
});

test("12 号那边：交上来的新版本存下，旧的先进 history；太长、空的、没变的不收；能退回上一版", () => {
  const d = tmp();
  assert.deepEqual(applySelf(d, "第一版", 1000), { changed: true });
  assert.equal(readSelf(d), "第一版");
  assert.equal(applySelf(d, "第一版").reason, "没变");
  assert.equal(applySelf(d, "").reason, "空的");
  assert.match(applySelf(d, "长".repeat(SELF_MAX + 1)).reason, /太长/);
  assert.equal(applySelf(d, "第二版", new Date(2026, 10, 8, 23, 5).getTime()).changed, true);
  const h = fs.readdirSync(path.join(d, "growth", "history"));
  assert.deepEqual(h, ["2026-11-08-2305.md"]);
  assert.equal(fs.readFileSync(path.join(d, "growth", "history", h[0]), "utf8").trim(), "第一版");
  assert.equal(rollbackSelf(d), "2026-11-08-2305.md");
  assert.equal(readSelf(d), "第一版", "退回上一版");
  assert.equal(rollbackSelf(d), null, "没有可退的了");
  assert.equal(applySelf(d, "我们的梗", 1000, "bond").changed, true);
  assert.equal(applySelf(d, "新的梗", new Date(2026, 10, 9, 0, 5).getTime(), "bond").changed, true);
  assert.ok(fs.existsSync(path.join(d, "growth", "history", "2026-11-09-0005-bond.md")), "两份的快照分开存");
  assert.equal(readSelf(d), "第一版", "改「我和主人」不动「我是谁」");
  assert.equal(selfSection("", "设定", "梗").includes("# 我是谁"), false);
  assert.match(selfSection("性子", "设定", "梗"), /# 我是谁[\s\S]*性子[\s\S]*我和主人之间[\s\S]*梗/);
});

test("屋里那边：她自己改的文件，跑完比一下，变了存快照，改坏了退回", () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, "growth"), { recursive: true });
  assert.equal(settleSelf(d).reason, "没变", "还没写过");
  fs.writeFileSync(selfFile(d), "好像挺爱较真。\n");
  assert.equal(settleSelf(d, 1000).changed, true);
  fs.writeFileSync(selfFile(d), "长".repeat(SELF_MAX + 1));
  assert.match(settleSelf(d).reason, /退回上一版/);
  assert.equal(readSelf(d), "好像挺爱较真。");
  fs.writeFileSync(selfFile(d), "");
  assert.match(settleSelf(d).reason, /清空/);
  assert.equal(readSelf(d), "好像挺爱较真。");
  fs.writeFileSync(selfFile(d), "挺爱较真。\n好像嘴硬。\n");
  assert.equal(settleSelf(d, new Date(2026, 10, 8, 22, 31).getTime()).changed, true);
  assert.equal(fs.readFileSync(path.join(d, "growth", "history", "2026-11-08-2231.md"), "utf8").trim(), "好像挺爱较真。");
});

test("角色目录的 CLAUDE.md：机制说明后面接她自己写的「我是谁」", () => {
  ensureRoles();
  const d = roleDir("xiaoke"), md = () => fs.readFileSync(path.join(d, "CLAUDE.md"), "utf8");
  fs.rmSync(path.join(d, "growth"), { recursive: true, force: true });
  writeRoleMd("xiaoke");
  assert.ok(!md().includes("# 我是谁"));
  fs.mkdirSync(path.join(d, "growth"), { recursive: true });
  fs.writeFileSync(selfFile(d), "好像挺爱较真。\n");
  writeRoleMd("xiaoke");
  assert.match(md(), /^# 怎么用你的记忆/); assert.match(md(), /# 我是谁[\s\S]*好像挺爱较真/);
  assert.ok(!fs.readFileSync(path.join(roleDir("hachimi"), "CLAUDE.md"), "utf8").includes("# 我是谁"), "别人的不受影响");
  fs.rmSync(path.join(d, "growth"), { recursive: true, force: true });
  void CFG;
});

// 三个进程共用的小东西（11-06 大扫除第四批）：叫法、渠道名、先写 .tmp 再改名的写盘
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";
import { CHANNEL, DISPLAY, channelName, displayName, writeFileAtomic, writeJson } from "../gw/xk-shared.mjs";

test("叫法：三位住客和主人；不认识的照原样给", () => {
  assert.deepEqual(DISPLAY, { xiaoke: "小克", hachimi: "哈基米", deepseek: "小鱼", owner: "主人" });
  assert.equal(displayName("deepseek"), "小鱼", "界面上的叫法，不是角色名 DeepSeek");
  assert.equal(displayName("owner"), "主人");
  assert.equal(displayName("someone"), "someone");
});

test("渠道名：三种都认，不认识的照原样给", () => {
  assert.deepEqual(Object.keys(CHANNEL), ["app", "qq-private", "qq-group"]);
  assert.equal(channelName("qq-private"), "QQ 私聊");
  assert.equal(channelName("app"), "App");
  assert.equal(channelName("wechat"), "wechat");
});

test("写盘：目录没有就建；先写 .tmp 再改名，写完不留 .tmp；mode 照给的设", () => {
  const dir = path.join(CFG.home, ".xk-shared-test");
  const f = path.join(dir, "a", "b.json");
  writeJson(f, { x: 1, y: [2] }, { indent: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { x: 1, y: [2] });
  assert.match(fs.readFileSync(f, "utf8"), /\n/, "indent 传了就分行");
  assert.equal(fs.existsSync(f + ".tmp"), false, "不留半成品");
  writeJson(f, { x: 3 });
  assert.equal(fs.readFileSync(f, "utf8"), '{"x":3}', "不传 indent 就是一行");
  const secret = path.join(dir, "c.json");
  writeJson(secret, {}, { mode: 0o600 });
  assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
  writeFileAtomic(path.join(dir, "plain.txt"), "你好\n");
  assert.equal(fs.readFileSync(path.join(dir, "plain.txt"), "utf8"), "你好\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

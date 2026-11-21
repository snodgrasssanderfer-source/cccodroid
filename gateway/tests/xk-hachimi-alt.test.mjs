// 哈基米改走中转站（主人 11-10）：hachimi-engine.json 指了接口就走 Claude Code + 那家，删掉就回 agy
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";

if (!/cccodroid-test-/.test(fs.realpathSync(CFG.home)) || process.env.CCAPP_TEST !== "1") throw new Error("只能用 scripts/test.mjs 跑");
const { HACHIMI_ENGINE_FILE, XIAOKE_ENGINE_FILE, roleById } = await import("../gw/xk-roles.mjs");
after(() => { fs.rmSync(HACHIMI_ENGINE_FILE, { force: true }); fs.rmSync(XIAOKE_ENGINE_FILE, { force: true }); });

test("没有设置文件：照旧 agy；写了接口：Claude Code + 那家；删了又回 agy", async () => {
  fs.rmSync(HACHIMI_ENGINE_FILE, { force: true });
  const h = roleById("hachimi");
  assert.equal(h.engine, "agy"); assert.equal(h.provider, null);
  fs.mkdirSync(path.dirname(HACHIMI_ENGINE_FILE), { recursive: true });
  fs.writeFileSync(HACHIMI_ENGINE_FILE, JSON.stringify({ provider: "hachimi-relay" }));
  assert.equal(h.engine, "claude"); assert.equal(h.provider, "hachimi-relay");
  assert.equal({ ...h }.engine, "claude", "展开成普通对象（角色清单接口）也拿到当下的值");
  fs.writeFileSync(HACHIMI_ENGINE_FILE, "坏的");
  await new Promise((r) => setTimeout(r, 20)); fs.utimesSync(HACHIMI_ENGINE_FILE, new Date(), new Date(Date.now() + 5000));
  assert.equal(h.engine, "agy", "写坏了不硬走，回 agy");
  fs.rmSync(HACHIMI_ENGINE_FILE);
  assert.equal(h.engine, "agy");
  assert.equal(roleById("xiaoke").engine, "claude");
});

// 主人 11-21：订阅登录过期，小克换 API 密钥。xiaoke-engine.json 指了哪家就用哪家，没有就是订阅
test("小克：没有设置文件走订阅；写了 anthropic-key 就走密钥；删了回订阅", () => {
  fs.rmSync(XIAOKE_ENGINE_FILE, { force: true });
  const x = roleById("xiaoke");
  assert.equal(x.provider, "anthropic");
  fs.mkdirSync(path.dirname(XIAOKE_ENGINE_FILE), { recursive: true });
  fs.writeFileSync(XIAOKE_ENGINE_FILE, JSON.stringify({ provider: "anthropic-key" }));
  assert.equal(x.provider, "anthropic-key");
  assert.equal(x.engine, "claude");
  assert.equal({ ...x }.provider, "anthropic-key", "展开成普通对象也拿到当下的值");
  fs.rmSync(XIAOKE_ENGINE_FILE);
  assert.equal(x.provider, "anthropic");
});

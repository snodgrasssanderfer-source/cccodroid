// 整理记忆是一次调用出 JSON、网关自己写（#26）：旧记忆按小编号给，映射回 id；时间按说话那天；解析失败和「没东西可记」分开
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";
import { onPublish } from "../gw/bus.mjs";
import { projectSlug } from "../gw/projects.mjs";
import { providerById } from "../gw/providers.mjs";
import { STATE } from "../gw/xk-core.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import { ASK, cheapModel, consolidate, parse } from "../gw/xk-memory.mjs";
import { load, remember, today } from "../gw/xk-memstore.mjs";

ensureRoles();
const session = (role, sid, lines) => {
  const cwd = fs.realpathSync(roleDir(role)), dir = path.join(CFG.home, ".claude", "projects", projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.map(([who, text, at], i) => JSON.stringify(who === "user"
    ? { type: "user", sessionId: sid, cwd, uuid: "u" + i, timestamp: new Date(at).toISOString(), message: { role: "user", content: text } }
    : { type: "assistant", sessionId: sid, cwd, uuid: "a" + i, timestamp: new Date(at).toISOString(), message: { role: "assistant", content: [{ type: "text", text }] } })).join("\n") + "\n");
  STATE.memDirty[sid] = Date.now();
  return sid;
};
const reply = (o) => { const asked = []; return { asked, fn: async (p, role) => { asked.push({ p, role: role.id }); return typeof o === "string" ? { text: o } : o; } }; };
const now = Date.now();

test("便宜档：小克 haiku，DeepSeek 用她的快档 flash", () => {
  assert.equal(cheapModel(providerById("anthropic")), "haiku");
  assert.equal(cheapModel(providerById("deepseek")), "deepseek-flash");
});

test("旧记忆按编号给模型，回来的 ends 编号换成真 id；不开会话", async () => {
  const dir = roleDir("xiaoke");
  const old = remember(dir, { text: "主人周六想去爬山", kind: "plan" });
  const r = reply({ text: '好的：{"memories":[{"text":"主人周六改去看展了","kind":"plan","who":"主人","ends":[0]}]}' });
  ASK.claude = r.fn;
  const sid = session("xiaoke", "eeeeeeee-0000-4000-8000-000000000001", [["user", "周六不爬山了，改去看展", now - 60000], ["assistant", "好呀", now - 50000]]);
  assert.equal(await consolidate(sid), 1);
  assert.match(r.asked[0].p, /\n0\. .*主人周六想去爬山/);
  assert.ok(!r.asked[0].p.includes(old.id), "提示里不出现 8 位 id，免得模型抄错");
  const list = load(dir);
  assert.equal(list.find((m) => m.id === old.id).past, true);
  assert.ok(list.some((m) => m.text === "主人周六改去看展了" && !m.past));
  assert.equal(STATE.memDirty[sid], undefined);
  assert.ok(STATE.memDone[sid] > 0);
});

test("不存在的编号报错不吞：一条都不写，留着下次再整理", async () => {
  const dir = roleDir("xiaoke"), before = load(dir).length;
  ASK.claude = reply('{"memories":[{"text":"主人养了一只猫","kind":"fact","ends":[7]}]}').fn;
  const events = [], off = onPublish((e) => { if (e.op === "memory_failed") events.push(e); });
  const sid = session("xiaoke", "eeeeeeee-0000-4000-8000-000000000002", [["user", "我养了只猫", now - 60000]]);
  await assert.rejects(consolidate(sid), /编号 7 不在旧记忆里/);
  off();
  assert.equal(load(dir).length, before);
  assert.ok(STATE.memDirty[sid]);
  assert.equal(events.length, 1);
});

test("解析失败和没东西可记分得开", () => {
  assert.throws(() => parse("整理好了", []), /不是 JSON/);
  assert.throws(() => parse('{"ok":true}', []), /没有 memories/);
  assert.deepEqual(parse('{"memories":[]}', []), []);
});

test("没东西可记：不报错，这段算整理过了", async () => {
  ASK.claude = reply('{"memories":[]}').fn;
  const sid = session("deepseek", "eeeeeeee-0000-4000-8000-000000000003", [["user", "哈哈", now - 60000]]);
  assert.equal(await consolidate(sid), 0);
  assert.equal(STATE.memDirty[sid], undefined);
});

test("跨零点：昨天 23:50 说的「明天」换成今天的日期（模型没换算、也没写 said 时网关兜底）", async () => {
  const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(23, 50, 0, 0);
  const r = reply('{"memories":[{"text":"主人明天去体检","kind":"plan","who":"主人"}]}');
  ASK.claude = r.fn;
  const sid = session("deepseek", "eeeeeeee-0000-4000-8000-000000000004", [["user", "明天要去体检", d.getTime()]]);
  await consolidate(sid);
  assert.match(r.asked[0].p, new RegExp(`\\[${today(d)} 周. 23:50\\] 主人：明天要去体检`), "每句带上说话的日期");
  const m = load(roleDir("deepseek")).find((x) => x.text.includes("去体检"));
  assert.equal(m.text, `主人${today()}去体检`);
  assert.equal(m.date, today(d), "没给 date 时按说话那天");
});

test("看法不在整理里记；哈基米走 agy 那条一次调用", async () => {
  const r = reply('{"memories":[{"text":"我觉得主人很可爱","kind":"opinion","who":"哈基米"},{"text":"主人的生日是 3 月 5 日","kind":"fact"}]}');
  ASK.agy = r.fn;
  const sid = session("hachimi", "eeeeeeee-0000-4000-8000-000000000005", [["user", "我生日 3 月 5 号", now - 60000]]);
  assert.equal(await consolidate(sid), 1);
  assert.equal(r.asked[0].role, "hachimi");
  const list = load(roleDir("hachimi"));
  assert.ok(list.some((m) => m.text.includes("3 月 5 日")));
  assert.ok(!list.some((m) => m.kind === "opinion"));
});

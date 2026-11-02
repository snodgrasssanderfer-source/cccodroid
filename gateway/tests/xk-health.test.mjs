// 「我的」页：三人健康卡（#15）和用量按人分（#11）
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { PATHS } from "../gw/config.mjs";
import { STATE } from "../gw/xk-core.mjs";
import { ensureRoles, roleDir } from "../gw/xk-roles.mjs";
import { health, usageByRole } from "../gw/xk-health.mjs";
import { AGY } from "../gw/xk-agy.mjs";

ensureRoles();
STATE.diaryTasks = { xiaoke: "t1", deepseek: "t2" };
beforeEach(() => { for (const k of Object.keys(STATE.cooldown)) delete STATE.cooldown[k]; });   // 别的测试文件留下的额度冷却
const fake = (sched, priv = {}) => async (p) => (p === "/api/sched" ? sched : priv);
const SCHED_OK = { tasks: [{ id: "t1", on: true }, { id: "t2", on: true }], allowLogin: true, loginTasks: ["t1"] };
const who = (h, id) => h.roles.find((r) => r.id === id);

test("#15 订阅账户跑定时任务关着：小克那行写日记被挡，按钮去定时任务页", async () => {
  const h = await health(fake({ ...SCHED_OK, allowLogin: false }));
  assert.equal(h.ok, false);
  assert.match(who(h, "xiaoke").diary.why, /订阅账户/);
  assert.deepEqual(who(h, "xiaoke").diary.fix, { act: "sched" });
});

test("#15 后台被冻结过、Shizuku 没在运行：各一条，去设置的对应分区", async () => {
  const h = await health(fake(SCHED_OK, { state: "not_running", frozen: { count: 3, ms: 16000, at: Date.now() } }));
  assert.deepEqual(h.device.map((d) => [d.id, d.fix.cat]), [["frozen", "run"], ["shizuku", "device"]]);
  assert.match(h.device[0].why, /3 次/);
});

test("#15 哈基米的 Google 要先验证：说话、接班那行给验证链接", async () => {
  const made = !fs.existsSync(AGY);
  if (made) { fs.mkdirSync(path.dirname(AGY), { recursive: true }); fs.writeFileSync(AGY, ""); }
  STATE.agyVerify = { url: "https://accounts.google.com/v", at: Date.now() };
  try {
    const h = await health(fake(SCHED_OK));
    assert.deepEqual(who(h, "hachimi").talk.fix, { act: "verify", url: "https://accounts.google.com/v" });
    assert.equal(who(h, "hachimi").diary, who(h, "hachimi").talk, "说不了话也就写不了日记");
  } finally { delete STATE.agyVerify; if (made) fs.rmSync(AGY); }
});

test("#15 额度用完：写上大概几点恢复", async () => {
  STATE.cooldown.xiaoke = { until: Date.now() + 3600e3 };
  try { assert.match(who(await health(fake(SCHED_OK)), "xiaoke").talk.why, /额度用完了，约 \d\d:\d\d 恢复/); }
  finally { delete STATE.cooldown.xiaoke; }
});

test("#11 用量按会话归到角色上：今天、7 天、30 天", () => {
  const dir = path.join(PATHS.projects, "-xk-health");
  fs.mkdirSync(dir, { recursive: true });
  const sid = (n) => `bbbbbbbb-1111-4111-8111-00000000000${n}`;
  const put = (n, cwd) => fs.writeFileSync(path.join(dir, sid(n) + ".jsonl"), JSON.stringify({ type: "user", sessionId: sid(n), cwd, message: { role: "user", content: "hi" } }) + "\n");
  put(1, roleDir("xiaoke")); put(2, roleDir("deepseek")); put(3, "/tmp");
  const now = Date.now(), h = Math.floor(now / 3600e3);
  const u = usageByRole({ [h]: { st: { [sid(1)]: 100, [sid(2)]: 7, [sid(3)]: 999 } }, [h - 24 * 3]: { st: { [sid(1)]: 20 } }, [h - 24 * 20]: { st: { [sid(2)]: 5 } } }, now);
  assert.deepEqual(u.xiaoke, { today: 100, week: 120, month: 120 });
  assert.deepEqual(u.deepseek, { today: 7, week: 7, month: 12 });
  assert.deepEqual(u.hachimi, { today: 0, week: 0, month: 0 });
});

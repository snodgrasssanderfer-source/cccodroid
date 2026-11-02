// 记忆去重与时间锚兜底（参考旧项目 godot-test 的 LifeMemoryRepository / TimeAnchor，按意思用 JS 重写）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorDates, load, remember } from "../gw/xk-memstore.mjs";

const said = new Date(2026, 10, 2);   // 2026-11-02，周一
test("相对日期按记下那天换成具体日期；旁边已有日期的不动", () => {
  assert.equal(anchorDates("主人说下周六要去爬山", said), "主人说2026-11-14要去爬山");
  assert.equal(anchorDates("这周三交稿", said), "2026-11-04交稿");
  assert.equal(anchorDates("昨天熬夜，明天补觉", said), "2026-11-01熬夜，2026-11-03补觉");
  assert.equal(anchorDates("大后天出发", said), "2026-11-05出发");
  assert.equal(anchorDates("下个月搬工位", said), "2026年12月搬工位");
  assert.equal(anchorDates("上周状态不好", said), "2026-10-26 那周状态不好");
  assert.equal(anchorDates("2026-11-07（下周六）去爬山", said), "2026-11-07（下周六）去爬山");
  assert.equal(anchorDates("今晚写日记", said), "2026-11-02晚上写日记");
});

test("一字不差（不算空白标点）的同一条不再记一遍；已过去的不算", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "xkmem-"));
  const a = remember(dir, { text: "主人喜欢喝乌龙茶。", kind: "fact", date: "2026-11-01" });
  const b = remember(dir, { text: "主人喜欢喝乌龙茶", kind: "fact", date: "2026-11-02" });
  assert.equal(b.dup, true);
  assert.equal(b.id, a.id);
  assert.equal(load(dir).length, 1);
  const c = remember(dir, { text: "主人不喝乌龙茶了", kind: "fact", ends: [a.id] });
  assert.equal(load(dir).find((x) => x.id === a.id).past, true);
  const d = remember(dir, { text: "主人喜欢喝乌龙茶", kind: "fact", ends: [c.id] });   // 又喜欢回来了：旧那条已过去，照记
  assert.notEqual(d.dup, true);
  assert.equal(load(dir).length, 3);
});

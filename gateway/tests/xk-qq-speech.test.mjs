// 直播台词：边出字边切段、防漏（主人 11-07 定走「正文就是台词」）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpeech, cleanSpeech } from "../gw/xk-qq-speech.mjs";

function run(parts, opts = {}) {
  const got = [];
  let stops = 0;
  const s = createSpeech({ onChunk: (t) => got.push(t), onStop: () => stops++, ...opts });
  for (const p of parts) { if (p === TOOL) s.tool(); else s.feed(p); }
  return { got, stops, out: s.end() };
}
const TOOL = Symbol("tool");
const chars = (s) => [...s];   // 一个字一个字喂，像流式

test("一个字一个字来：开头两段逗号就切，后面等句号", () => {
  const { got, out } = run(chars("哇这把开局就是一对A，运气不错嘛，不过后面还得看小丑，先打着再说。"));
  assert.deepEqual(got, ["哇这把开局就是一对A，", "运气不错嘛，", "不过后面还得看小丑，先打着再说。"]);
  assert.equal(out.text, got.join(""));
  assert.ok(!out.silent);
});

test("第一段要攒够几个字才送", () => {
  const got = [];
  const s = createSpeech({ onChunk: (t) => got.push(t) });
  s.feed("好耶！");
  assert.equal(got.length, 0, "三个字先压着，免得汇报的开头已经念出去");
  s.feed("这把稳了。");
  assert.deepEqual(got, ["好耶！这把稳了。"]);
});

test("短短一句也照念", () => {
  assert.deepEqual(run(["好耶！"]).got, ["好耶！"]);
});

test("括号、标签、星号里的不念；没合上的先压着", () => {
  const { got } = run(chars("（看了眼手牌）这手牌<think>要不要弃</think>有点难办啊，*叹气*先弃两张。"));
  assert.deepEqual(got, ["这手牌有点难办啊，", "先弃两张。"]);
  assert.equal(cleanSpeech("a【不说】b"), "ab");
});

test("空行以后的不算；调工具以后的不算", () => {
  const a = run(chars("这手同花顺太爽了！\n\n小克在群里回了一条，说同花顺很爽。"));
  assert.deepEqual(a.got, ["这手同花顺太爽了！"]);
  assert.ok(a.out.dropped.includes("回了一条"));
  const b = run([...chars("先买这个小丑，"), TOOL, ...chars("我刚才买了小丑。")]);
  assert.deepEqual(b.got, ["先买这个小丑，"]);
});

test("汇报腔：开头就是的整轮不说；念到一半才露馅的就此停", () => {
  const a = run(chars("这一轮画面没什么变化，我就不说话了。"));
  assert.ok(a.out.silent); assert.deepEqual(a.got, []);
  assert.ok(run(["【不说】"]).out.silent);
  assert.ok(run(chars("小克没在群里说话，因为没人问她。")).out.silent);
  const b = run(chars("这把输了，下次再来！你在群里问的那个，群里已经回你了。"));
  assert.deepEqual(b.got, ["这把输了，", "下次再来！"]);
  assert.equal(b.stops, 1);
  assert.ok(b.out.stopped);
});

test("一大块一起来（Claude 有时整句到）也一样切", () => {
  const { got } = run(["开局！先看看商店有什么，", "嗯，这个小丑看着不错。"]);
  assert.deepEqual(got, ["开局！先看看商店有什么，", "嗯，这个小丑看着不错。"]);
});

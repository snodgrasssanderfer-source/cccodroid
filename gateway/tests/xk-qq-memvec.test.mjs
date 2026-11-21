// 12 号挑记忆按意思挑 + 遗忘（主人 11-11 定）：分词、向量存盘、打分规则；真模型那段只在装了模型、设了 XK_EMBED_DIR 时跑
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTokenizer } from "../gw/xk-embed-tok.mjs";
import { cos, vecPack, vecUnpack } from "../gw/xk-embed.mjs";
import { FADE, PICK, memInject, memLine, memSearch, memStrength } from "../gw/xk-qq-mem.mjs";

const DAY = 86400000;

test("分词：汉字一字一段、标点单独、英文按词表切 ##、截长", () => {
  const vocab = { "[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[SEP]": 3, "主": 4, "人": 5, "，": 6, "play": 7, "##ing": 8, "!": 9 };
  const enc = makeTokenizer(vocab, { max: 256 });
  assert.deepEqual(enc("主人，playing!"), [2, 4, 5, 6, 7, 8, 9, 3]);
  assert.deepEqual(enc("主 xyz"), [2, 4, 1, 3], "词表里没有的整词算 [UNK]");
  assert.equal(makeTokenizer(vocab, { max: 4 })("主人主人主人").length, 4, "太长截尾，[SEP] 还在");
});

test("向量压成 int8 存盘再取回，方向基本不变", () => {
  const v = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i));
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n); for (let i = 0; i < v.length; i++) v[i] /= n;
  assert.ok(cos(v, vecUnpack(vecPack(v))) > 0.999);
});

test("遗忘：没用过的一个月后淡一半多，用得多的淡得慢，主人的规矩不淡", () => {
  const now = 100 * DAY;
  const old = { id: "a", text: "x", cat: "杂事", at: now - 70 * DAY };
  assert.ok(memStrength(old, now) < FADE.floor, "两个多月没用过：淡了");
  assert.ok(memStrength({ ...old, uses: { q: 4, inj: 0, last: now - 70 * DAY } }, now) > FADE.floor, "查过好几回的还记得");
  assert.ok(memStrength({ ...old, uses: { q: 0, inj: 1, last: now - DAY } }, now) > 0.9, "前天刚用过：又清楚了");
  assert.equal(memStrength({ ...old, cat: "主人的规矩" }, now), 1);
  assert.match(memLine(old, 0, now), /淡了/);
});

// 假向量：三个方向，「难过」「游戏」「规矩」
const unit = (a) => { const n = Math.hypot(...a); return Float32Array.from(a, (x) => x / n); };
const V = { sad: unit([1, 0, 0]), game: unit([0, 1, 0]), rule: unit([0, 0, 1]) };

test("有向量就按意思挑：主人难过时挑出陪伴那条，不挑直播打牌", () => {
  const now = 10 * DAY;
  const ms = [
    { id: "g1", text: "直播打小丑牌 Jev 出了同花", cat: "游戏", at: now - DAY, v: V.game },
    { id: "g2", text: "游戏设计稿第二版", cat: "游戏", at: now - DAY, v: unit([0.3, 1, 0]) },
    { id: "s1", text: "主人低落的时候想被安静陪着", cat: "杂事", at: now - 5 * DAY, v: unit([1, 0.2, 0]) },
    { id: "r1", text: "主人的规矩：别说教", cat: "主人的规矩", at: now - 9 * DAY, v: unit([0.7, 0, 0.7]) },
  ];
  const vec = (m) => m.v;
  const hits = memSearch(ms, "我今天好难受", { limit: 3, now, qv: V.sad, vec, fade: true });
  assert.deepEqual(hits.map((m) => m.id), ["s1", "r1"], "沾边的按意思排，游戏两条不沾边");
  const out = memInject(ms, "我今天好难受", new Set(), { now, qv: V.sad, vec });
  assert.match(out, /安静陪着/);
  assert.doesNotMatch(out, /小丑牌/);
});

test("前文也算：这句话本身看不出来，前一句说过的事能把记忆挑出来", () => {
  const now = 10 * DAY;
  const ms = [{ id: "s1", text: "主人低落的时候想被安静陪着", cat: "杂事", at: now, v: V.sad }];
  const half = unit([0.6, 0, 0.8]);   // 这句话自己和「难过」只沾一点
  assert.equal(memSearch(ms, "嗯", { now, qv: half, vec: (m) => m.v }).length, 1, "0.6 刚过线");
  const weak = unit([0.45, 0, 0.89]);
  assert.equal(memSearch(ms, "嗯", { now, qv: weak, vec: (m) => m.v }).length, 0);
  assert.equal(memSearch(ms, "嗯", { now, qv: weak, pv: V.sad, vec: (m) => m.v }).length, 1, "加上前一句就够了");
});

test("没聊游戏时游戏类往后排；聊游戏时不扣", () => {
  const now = 10 * DAY;
  const both = unit([1, 1, 0]);
  const ms = [
    { id: "g", text: "牌局", cat: "游戏", at: now, v: both },
    { id: "z", text: "别的", cat: "杂事", at: now, v: both },
  ];
  const vec = (m) => m.v;
  assert.equal(memSearch(ms, "随便聊聊", { now, qv: both, vec })[0].id, "z");
  assert.equal(PICK.game > 0, true);
  const g = memSearch(ms, "今晚直播吗", { now, qv: both, vec }).map((m) => m.id);
  assert.deepEqual(new Set(g), new Set(["g", "z"]));
});

test("淡了的不自动附上，但查得到", () => {
  const now = 200 * DAY;
  const ms = [{ id: "o", text: "主人以前爱喝橙汁", cat: "杂事", at: now - 150 * DAY, v: V.sad }];
  assert.equal(memInject(ms, "橙汁", new Set(), { now, qv: V.sad, vec: (m) => m.v }), "");
  assert.equal(memSearch(ms, "橙汁", { now, qv: V.sad, vec: (m) => m.v }).length, 1);
});

test("没向量照旧按字挑", () => {
  const ms = [{ id: "a", text: "Ash 爱玩火影手游", cat: "群友", at: 1000 }];
  assert.equal(memSearch(ms, "Ash 还玩火影吗", { now: 3000, minKw: 0.6 }).length, 1);
  assert.equal(memSearch(ms, "今天天气", { now: 3000, minKw: 0.6 }).length, 0);
});

test("真模型（装了才跑）：难过的话和陪伴那条比和打牌那条近", { skip: !process.env.XK_EMBED_DIR }, async () => {
  const { QUERY_PFX, embedAsync, embedStop } = await import("../gw/xk-embed.mjs");
  try {
    const [q, a, b] = await embedAsync([QUERY_PFX + "我今天好累，感觉自己好没用", "主人心情低落时希望被安静陪着", "直播打小丑牌时Jev出了同花"]);
    assert.ok(cos(q, a) > cos(q, b) + 0.1 && cos(q, b) < PICK.simMin, `${cos(q, a)} ${cos(q, b)}`);
  } finally { await embedStop(); }
});

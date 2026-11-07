// 小丑牌直播（主人 11-07 定：12 号卡玩、Jev 出决定、她只管说）
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, estimate, handOptions, shopOptions, plan, decisionRequest, readDecision } from "../gw/xk-balatro.mjs";
import { createLive, liveCmd, isSilent } from "../gw/xk-qq-live.mjs";

const c = (s, extra = {}) => ({ rank: s[1], suit: s[0], ...extra });
const HV = { "Two Pair": { chips: 20, mult: 2 }, Pair: { chips: 10, mult: 2 }, "High Card": { chips: 5, mult: 1 }, Flush: { chips: 35, mult: 4 }, Straight: { chips: 30, mult: 4 }, "Full House": { chips: 40, mult: 4 } };
const arr = (n) => ({ type: "array", items: { type: "integer", enum: [...Array(n).keys()] }, uniqueItems: true, minItems: 1, maxItems: 5 });
const handState = (cards, extra = {}) => ({
  state: "SELECTING_HAND", ready: true, ante: 1, money: 4, score: 0, target: 300, hands_left: 4, discards_left: 3, hands_played: 0, discards_used: 0,
  blind: { name: "小盲注", boss: false }, hand: cards.map((x, i) => ({ i, ...x })), hand_values: HV, jokers: [], capacity: { jokers: 5 },
  actions: { play: { properties: { cards: arr(cards.length) } }, discard: { properties: { cards: arr(cards.length) } } }, ...extra,
});

test("牌型和计分牌照游戏规则", () => {
  assert.equal(classify([c("HJ"), c("DJ"), c("S4"), c("C4")]).hand, "Two Pair");
  assert.equal(classify([c("HA"), c("D2"), c("S3"), c("C4"), c("H5")]).hand, "Straight");   // A2345
  assert.equal(classify([c("HA"), c("H2"), c("H9"), c("H4", { enhancement: "WILD" }), c("S5", { enhancement: "WILD" })]).hand, "Flush");
  const hc = classify([c("HA"), c("D7")]);
  assert.equal(hc.hand, "High Card"); assert.equal(hc.scoring.length, 1);
  // 两对 J J 4 4：(20+10+10+4+4)×2
  assert.equal(estimate([c("HJ"), c("DJ"), c("S4"), c("C4")], HV).score, 96);
  // 被削弱的牌不加筹码；玻璃牌 ×2
  assert.equal(estimate([c("HJ", { debuff: true }), c("DJ")], HV).score, 40);
  assert.equal(estimate([c("HJ", { enhancement: "GLASS" }), c("DJ")], HV).score, 120);
});

test("出牌候选：最好的几手在前，带弃法，够过关的标出来", () => {
  const s = handState([c("DA"), c("CQ"), c("HJ"), c("DJ"), c("DT"), c("S4"), c("C4"), c("S2")], { target: 90 });
  const o = handOptions(s);
  assert.equal(o[0].hand, "Two Pair");
  assert.deepEqual(o[0].act, { action: "play", cards: [2, 3, 5, 6] });
  assert.ok(o[0].kill && o[0].label.includes("够过关"));
  assert.equal(o.filter((x) => x.hand === "High Card").length, 1);
  assert.ok(o.some((x) => x.kind === "discard"));
  assert.ok(o.length <= 20);   // systemone 一题最多 20 个选项
  // 没弃牌次数就不给弃法
  assert.ok(!handOptions({ ...s, discards_left: 0 }).some((x) => x.kind === "discard"));
});

test("商店候选按合法动作列；不用挑的直接给动作", () => {
  const s = { state: "SHOP", ready: true, money: 10, reroll_cost: 5, shop: { cards: [{ name: "小丑", set: "JOKER", effect: "+4 倍率", price: 2 }], vouchers: [], packs: [] },
    actions: { buy: { properties: { card: { const: 0 } } }, reroll: {}, next_round: {} } };
  assert.deepEqual(shopOptions(s).map((o) => o.kind), ["buy", "reroll", "leave"]);
  assert.deepEqual(plan({ state: "ROUND_EVAL", ready: true, actions: { cash_out: {} } }).auto, { action: "cash_out" });
  assert.ok(plan({ state: "SELECTING_HAND", ready: false, actions: {} }).wait);
  const body = decisionRequest(s, shopOptions(s));
  assert.equal(body.questions.move.type, "choice");
  assert.deepEqual(Object.keys(body.questions.move.criteria), ["buy_card0", "reroll", "leave"]);
});

test("决策模型回不来就按估分最高的打", () => {
  const o = [{ key: "a", score: 10 }, { key: "b", score: 50 }];
  assert.equal(readDecision(null, o).option.key, "b");
  assert.equal(readDecision({ answers: { move: { choice: "a", confidence: 0.6 }, notable: { noul: 0.8 } } }, o).option.key, "a");
});

test("开播下播暗号、不说", () => {
  assert.equal(liveCmd("开播！"), "start");
  assert.equal(liveCmd("下播"), "stop");
  assert.equal(liveCmd("我想看开播"), null);
  assert.ok(isSilent("【不说】")); assert.ok(!isSilent("好耶"));
});

// 假的牌局：一手出完就过关、再一手就输
function fakeDeps() {
  let t = 0;
  const said = [], mem = [], acts = [];
  const states = [
    handState([c("HJ"), c("DJ"), c("S4"), c("C4"), c("S2")]),
    { state: "ROUND_EVAL", ready: true, actions: { cash_out: {} } },
  ];
  let i = 0;
  return {
    said, mem, acts, tick: (ms) => (t += ms),
    deps: {
      now: () => t, sleep: async (ms) => { t += Math.min(ms, 1000); },
      bridge: { state: async () => states[Math.min(i, states.length - 1)],
        act: async (a) => { acts.push(a); i++; return { ok: true, events: a.action === "play" ? [{ type: "hand_played", hand: "Two Pair", score: 96 }, { type: "blind_cleared", name: "小盲注", score: 96, target: 90 }] : [], state: {} }; } },
      decide: async (body) => ({ answers: { move: { choice: Object.keys(body.questions.move.criteria)[0], confidence: 0.7 }, notable: { noul: 0.2 } } }),
      busy: () => false, speak: async (line) => { said.push(line); },
      remember: (x) => mem.push(x), recent: () => [], log: () => {},
    },
  };
}

test("直播：盲注第一手先说再打；过关攒成话题；节奏有上限", async () => {
  const f = fakeDeps();
  const live = createLive(f.deps);
  live._S.on = true;
  await live._step();
  assert.equal(f.acts[0].action, "play");
  assert.ok(f.said[0].includes("你决定：打出"), "第一手先说打算");
  // 过关的话题紧跟着，但离上一句不到 6 秒：先攒着
  assert.equal(f.said.length, 1);
  assert.ok(live._S.topics.some((x) => x.text.includes("过了小盲注")));
  f.tick(7000);
  await live._step();   // 结算：自动 cash_out，顺手把攒的话题说了
  assert.equal(f.acts[1].action, "cash_out");
  assert.ok(f.said.some((x) => x.includes("过了小盲注")));
  // 一分钟内最多 4 句
  live._S.said = [1, 2, 3, 4].map(() => f.deps.now());
  live._S.lastLine = -Infinity;
  const before = f.said.length;
  live._S.topics.push({ text: "x", key: true, at: f.deps.now() });
  await live._step();
  assert.equal(f.said.length, before);
});

test("直播：输了、下播都记进她的记忆", async () => {
  const f = fakeDeps();
  const st = handState([c("HJ"), c("DJ")], { hands_left: 1, ante: 3, blind: { name: "The Wall", boss: true }, jokers: [{ name: "小丑" }] });
  f.deps.bridge.state = async () => st;
  f.deps.bridge.act = async () => ({ ok: true, events: [{ type: "hand_played", hand: "Pair", score: 40 }], state: { state: "GAME_OVER", ante: 3 } });
  const live = createLive(f.deps);
  live._S.on = true;
  await live._step();
  assert.ok(f.said[0].includes("最后一手"), "最后一手先说");
  assert.ok(f.mem.some((m) => m.includes("输了") && m.includes("The Wall") && m.includes("小丑")));
  live.stop("测试");
  assert.ok(f.mem.some((m) => m.includes("直播打了")));
});

test("直播：动作超时不拿同一帧重问，等画面换了再走；被拒的可以重来", async () => {
  const f = fakeDeps();
  const st = { ...handState([c("HJ"), c("DJ"), c("S4"), c("C4"), c("S2")]), seq: 5 };
  let reads = 0, decides = 0;
  f.deps.bridge.state = async () => (++reads > 4 ? { ...st, seq: 6 } : st);
  f.deps.bridge.act = async (a) => { f.acts.push(a); throw new Error("超时"); };
  const dec = f.deps.decide; f.deps.decide = async (b) => { decides++; return dec(b); };
  const live = createLive(f.deps);
  live._S.on = true;
  await live._step();
  assert.equal(f.acts.length, 1);
  assert.ok(reads >= 5, "超时后一直读到换帧");
  // 下一步读到的已经是新帧（seq 6），但同一帧 5 不会再决策
  f.deps.bridge.state = async () => st;
  await live._step();
  assert.equal(decides, 1, "seq 5 动过了，不再问");
  // 被拒：这一帧放开
  f.deps.bridge.act = async () => { throw new Error("游戏拒绝 act：不合法"); };
  live._S.actedSeq = null;
  await live._step();
  assert.equal(live._S.actedSeq, null);
});

test("直播：开新局的话先于第一个决定说出来", async () => {
  const f = fakeDeps();
  const live = createLive(f.deps);
  live._S.on = true;
  live._S.topics.push({ text: "[画面] 开了一局新的小丑牌（红色牌组、白注）。", key: true, at: 0 });
  await live._step();
  const first = f.said[0];
  assert.ok(first.indexOf("开了一局新的") >= 0 && first.indexOf("开了一局新的") < first.indexOf("你决定"));
});

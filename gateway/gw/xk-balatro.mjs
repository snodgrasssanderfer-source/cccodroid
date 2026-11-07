// 小丑牌直播（主人 11-07 定：12 号卡玩、Jev 出决定、她只管说）：这里只有纯逻辑，不碰网络。
// 牌局桥（xk/game）给 /state；这里把当前能做的事列成几个候选，估一下分，交给决策模型挑一个。
// 估分只算牌型和牌面（含强化、版本），不算小丑：小丑的效果原文一起递给决策模型，让它自己掂量。

const RANK_CHIPS = { A: 11, K: 10, Q: 10, J: 10, T: 10 };
const RANK_ORDER = "23456789TJQKA";
const SUIT_MARK = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANK_NAME = { T: "10" };
export const HAND_CN = {
  "Flush Five": "同花五条", "Flush House": "同花葫芦", "Five of a Kind": "五条", "Straight Flush": "同花顺",
  "Four of a Kind": "四条", "Full House": "葫芦", "Flush": "同花", "Straight": "顺子",
  "Three of a Kind": "三条", "Two Pair": "两对", "Pair": "对子", "High Card": "高牌",
};

const enh = (c) => String(c.enhancement || "").toUpperCase();
const isStone = (c) => enh(c) === "STONE";
const isWild = (c) => enh(c) === "WILD";
const debuffed = (c) => !!c.debuff;
export const cardName = (c) => (isStone(c) ? "石头牌" : (SUIT_MARK[c.suit] || c.suit || "") + (RANK_NAME[c.rank] || c.rank || "?"));
const rankChips = (c) => (isStone(c) ? 0 : RANK_CHIPS[c.rank] ?? (Number(c.rank) || 0));

/** 这几张牌打出去是什么牌型、哪几张计分（照游戏规则：对子类只算成型的那几张，高牌只算最大那张） */
export function classify(cards) {
  const real = cards.filter((c) => !isStone(c));
  const byRank = new Map();
  for (const c of real) byRank.set(c.rank, [...(byRank.get(c.rank) || []), c]);
  const groups = [...byRank.values()].sort((a, b) => b.length - a.length || RANK_ORDER.indexOf(b[0].rank) - RANK_ORDER.indexOf(a[0].rank));
  const five = cards.length === 5 && real.length === 5;
  const suits = new Set(real.filter((c) => !isWild(c)).map((c) => c.suit));
  const flush = five && suits.size <= 1;
  let straight = false;
  if (five && byRank.size === 5) {
    const idx = real.map((c) => RANK_ORDER.indexOf(c.rank)).sort((a, b) => a - b);
    straight = idx[4] - idx[0] === 4 || idx.join() === "0,1,2,3,12";   // A2345 也算
  }
  const sizes = groups.map((g) => g.length);
  let hand, scoring;
  if (sizes[0] === 5) hand = flush ? "Flush Five" : "Five of a Kind";
  else if (sizes[0] === 3 && sizes[1] === 2) hand = flush ? "Flush House" : "Full House";
  else if (straight && flush) hand = "Straight Flush";
  else if (sizes[0] === 4) { hand = "Four of a Kind"; scoring = groups[0]; }
  else if (flush) hand = "Flush";
  else if (straight) hand = "Straight";
  else if (sizes[0] === 3) { hand = "Three of a Kind"; scoring = groups[0]; }
  else if (sizes[0] === 2 && sizes[1] === 2) { hand = "Two Pair"; scoring = [...groups[0], ...groups[1]]; }
  else if (sizes[0] === 2) { hand = "Pair"; scoring = groups[0]; }
  else { hand = "High Card"; scoring = groups.length ? [groups[0][0]] : []; }
  scoring ||= real;
  // 石头牌永远计分
  return { hand, scoring: [...scoring, ...cards.filter(isStone)] };
}

/** 估分：牌型基础筹码/倍率（含等级）+ 计分牌的筹码和强化、版本。不算小丑 */
export function estimate(cards, handValues = {}) {
  const { hand, scoring } = classify(cards);
  const base = handValues[hand] || {};
  let chips = Number(base.chips) || 0, mult = Number(base.mult) || 1, xmult = 1;
  for (const c of scoring) {
    if (debuffed(c)) continue;
    chips += rankChips(c);
    const e = enh(c), ed = String(c.edition || "").toUpperCase();
    if (e === "BONUS") chips += 30;
    if (e === "STONE") chips += 50;
    if (e === "MULT") mult += 4;
    if (e === "GLASS") xmult *= 2;
    if (ed === "FOIL") chips += 50;
    if (ed === "HOLO") mult += 10;
    if (ed === "POLYCHROME") xmult *= 1.5;
  }
  return { hand, scoring, score: Math.round(chips * mult * xmult) };
}

function* subsets(n, min, max) {
  const pick = [];
  function* go(start) {
    if (pick.length >= min) yield [...pick];
    if (pick.length === max) return;
    for (let i = start; i < n; i++) { pick.push(i); yield* go(i + 1); pick.pop(); }
  }
  yield* go(0);
}

const arrSchema = (actions, name) => actions?.[name]?.properties?.cards;
const listCards = (hand, idx) => idx.map((i) => cardName(hand[i])).join(" ");

/** 出牌阶段的候选：最好的几手出法 + 几种弃法 */
export function handOptions(state, { plays = 6, discards = 4 } = {}) {
  const hand = state.hand || [], hv = state.hand_values || {}, actions = state.actions || {};
  const need = Math.max(0, (state.target || 0) - (state.score || 0));
  const out = [];
  const forced = hand.filter((c) => c.forced).map((c) => c.i);
  const playS = arrSchema(actions, "play");
  if (playS) {
    const all = [];
    for (const idx of subsets(hand.length, Math.max(1, playS.minItems || 1), Math.min(5, playS.maxItems || 5))) {
      if (!forced.every((f) => idx.includes(f))) continue;
      const cs = idx.map((i) => hand[i]);
      const e = estimate(cs, hv);
      // 不计分的牌白白打出去：只在凑满 5 张能顺带丢牌时才有意义，这里只留不带废牌的
      if (e.scoring.length < cs.length && !(cs.length === 5)) continue;
      all.push({ idx, ...e });
    }
    all.sort((a, b) => b.score - a.score || a.idx.length - b.idx.length);
    const seen = new Set();
    for (const p of all) {
      const sig = p.hand + ":" + p.scoring.map(cardName).sort().join(",");
      if (seen.has(sig)) continue;
      if (p.hand === "High Card" && out.some((x) => x.hand === "High Card")) continue;   // 高牌留一个就够
      seen.add(sig);
      const kill = need > 0 && p.score >= need;
      out.push({
        key: "play" + out.length, kind: "play", score: p.score, hand: p.hand, kill,
        act: { action: "play", cards: p.idx },
        label: `打出 ${listCards(hand, p.idx)}（${HAND_CN[p.hand] || p.hand}，不算小丑约 ${p.score} 分${kill ? "，够过关" : ""}）`,
      });
      if (out.length >= plays) break;
    }
  }
  const discS = arrSchema(actions, "discard");
  if (discS && (state.discards_left || 0) > 0) {
    const maxD = Math.min(5, discS.maxItems || 5), seen = new Set();
    const lowFirst = (a, b) => rankChips(hand[a]) - rankChips(hand[b]);
    const addKeep = (keep, why) => {
      const drop = hand.map((c) => c.i).filter((i) => !keep.includes(i) && !forced.includes(i)).sort(lowFirst).slice(0, maxD);
      if (!drop.length) return;
      const sig = [...drop].sort().join(",");
      if (seen.has(sig)) return;
      seen.add(sig);
      out.push({ key: "discard" + seen.size, kind: "discard", act: { action: "discard", cards: drop }, label: `弃掉 ${listCards(hand, drop)}（留住${why}）` });
    };
    // 留住最好那几手的成型牌
    for (const o of out.filter((x) => x.kind === "play").slice(0, 3)) {
      const keep = o.act.cards.filter((i) => classify(o.act.cards.map((j) => hand[j])).scoring.includes(hand[i]));
      addKeep(keep, (HAND_CN[o.hand] || o.hand) + "的牌");
      if (seen.size >= discards) break;
    }
    // 听同花：某个花色有 3–4 张
    const bySuit = {};
    for (const c of hand) if (!isStone(c)) (bySuit[c.suit] ||= []).push(c.i);
    const best = Object.entries(bySuit).sort((a, b) => b[1].length - a[1].length)[0];
    if (best && best[1].length >= 3 && best[1].length < 5 && seen.size < discards) addKeep(best[1], `${best[1].length} 张${SUIT_MARK[best[0]] || best[0]}听同花`);
  }
  return out;
}

const variantsOf = (schema) => (schema?.oneOf ? schema.oneOf : schema ? [schema] : []);
const constOf = (v, field) => v?.properties?.[field]?.const;
const itemLine = (c) => `${c.name || c.key}${c.set && c.set !== "DEFAULT" ? "（" + setCn(c.set) + "）" : ""}${c.edition ? "[" + c.edition + "]" : ""}${c.effect ? "：" + c.effect : ""}`;
const setCn = (s) => ({ JOKER: "小丑", TAROT: "塔罗", PLANET: "星球", SPECTRAL: "幻灵", VOUCHER: "优惠券", BOOSTER: "补充包" }[s] || s);

/** 商店的候选：能买的每一件、刷新、离开 */
export function shopOptions(state) {
  const a = state.actions || {}, shop = state.shop || {}, out = [];
  for (const v of variantsOf(a.buy)) {
    for (const [field, area] of [["card", "cards"], ["voucher", "vouchers"], ["pack", "packs"]]) {
      const i = constOf(v, field);
      if (i === undefined) continue;
      const c = (shop[area] || [])[i];
      if (!c) continue;
      out.push({ key: `buy_${field}${i}`, kind: "buy", act: { action: "buy", [field]: i }, label: `买 ${itemLine(c)}，$${c.price}` });
    }
  }
  for (const v of variantsOf(a.use)) {
    const i = constOf(v, "consumable");
    if (i === undefined || v.properties?.cards) continue;
    const c = (state.consumables || [])[i];
    if (c) out.push({ key: "use" + i, kind: "use", act: { action: "use", consumable: i }, label: `使用 ${itemLine(c)}` });
  }
  if (a.reroll) out.push({ key: "reroll", kind: "reroll", act: { action: "reroll" }, label: `花 $${state.reroll_cost ?? "?"} 刷新货架` });
  if (a.next_round) out.push({ key: "leave", kind: "leave", act: { action: "next_round" }, label: "什么都不买了，离开商店" });
  return out;
}

/** 选目标牌：挑点数大的（塔罗牌强化、复制这类，强化大牌更值） */
function pickTargets(t, hand) {
  const ranked = [...(t.items?.enum || [])].sort((x, y) => rankChips(hand[y] || {}) - rankChips(hand[x] || {}));
  return ranked.slice(0, Math.max(t.minItems || 1, t.maxItems || 1));
}

/** 开包的候选 */
export function packOptions(state) {
  const out = [], hand = state.hand || [], pack = state.pack || [];
  for (const v of variantsOf(state.actions?.pack)) {
    if (constOf(v, "skip") === true) { out.push({ key: "skip", kind: "pack_skip", act: { action: "pack", skip: true }, label: "这包一张都不要，跳过" }); continue; }
    const i = constOf(v, "card");
    if (i === undefined) continue;
    const c = pack[i] || {}, act = { action: "pack", card: i };
    const t = v.properties?.targets;
    if (t) act.targets = pickTargets(t, hand);
    out.push({ key: "pick" + i, kind: "pack", act, label: `选 ${itemLine(c)}${act.targets ? "，用在 " + act.targets.map((j) => cardName(hand[j] || {})).join(" ") : ""}` });
  }
  return out;
}

export function blindOptions(state) {
  const a = state.actions || {}, out = [];
  const cur = Object.values(state.blinds || {}).find((b) => b.status === "SELECT") || {};
  if (a.select) out.push({ key: "select", kind: "select", act: { action: "select" }, label: `打这个盲注（${cur.name || ""}，目标 ${cur.score ?? "?"} 分）` });
  if (a.skip) out.push({ key: "skip", kind: "skip", act: { action: "skip" }, label: `跳过它，拿标签：${cur.tag_name || ""}${cur.tag_effect ? "（" + cur.tag_effect + "）" : ""}` });
  return out;
}

/** 当前该做什么：不用挑的直接给动作（auto），要挑的给候选 */
export function plan(state, opts = {}) {
  const a = state.actions || {}, st = state.state;
  if (!state.ready || !Object.keys(a).length) return { wait: true };
  if (st === "ROUND_EVAL" && a.cash_out) return { auto: { action: "cash_out" }, why: "结算" };
  if (st === "GAME_OVER" && a.menu) return { auto: { action: "menu" }, why: "回主菜单", over: true };
  if (st === "MENU" && a.start) {
    const v = variantsOf(a.start)[0];
    const deck = v?.properties?.deck?.const || "RED", stakes = v?.properties?.stake?.enum || ["WHITE"];
    return { auto: { action: "start", deck, stake: stakes[0] }, why: "开新局" };
  }
  const options = st === "SELECTING_HAND" ? handOptions(state, opts)
    : st === "SHOP" ? shopOptions(state)
    : st === "SMODS_BOOSTER_OPENED" ? packOptions(state)
    : st === "BLIND_SELECT" ? blindOptions(state) : [];
  if (!options.length) return { wait: true };
  if (options.length === 1) return { auto: options[0].act, why: options[0].label, option: options[0] };
  return { options };
}

const levelLine = (hv) => Object.entries(hv || {}).filter(([, v]) => (v.level || 1) > 1).map(([k, v]) => `${HAND_CN[k] || k} ${v.level} 级`).join("、");

/** 给决策模型看的局面（中文，只放跟这一步有关的） */
export function stateText(state, guidance = [], style = []) {
  const L = [];
  const b = state.blind || {};
  L.push(`小丑牌，第 ${state.ante ?? "?"} 底注，持有 $${state.money ?? 0}。`);
  if (state.state === "SELECTING_HAND") {
    L.push(`当前盲注：${b.name || "?"}${b.effect ? "（" + b.effect + "）" : ""}，已得 ${state.score ?? 0} / 目标 ${state.target ?? 0} 分，还差 ${Math.max(0, (state.target || 0) - (state.score || 0))}。剩 ${state.hands_left ?? 0} 次出牌、${state.discards_left ?? 0} 次弃牌，牌堆还有 ${state.deck_remaining ?? "?"} 张。`);
    L.push("手牌：" + (state.hand || []).map((c) => cardName(c) + (c.enhancement ? `[${c.enhancement}]` : "") + (c.debuff ? "[被削弱]" : "")).join(" "));
    if (state.hands_left === 1) L.push("这是最后一次出牌，打不够就输了。");
  }
  const boss = state.blinds?.boss;
  if (boss && state.state !== "SELECTING_HAND") L.push(`本底注 Boss：${boss.name}${boss.effect ? "（" + boss.effect + "）" : ""}，目标 ${boss.score}。`);
  if (state.jokers?.length) L.push(`小丑（${state.jokers.length}/${state.capacity?.jokers ?? "?"}）：` + state.jokers.map(itemLine).join("；"));
  else L.push(`还没有小丑（最多 ${state.capacity?.jokers ?? 5} 个）。`);
  if (state.consumables?.length) L.push("消耗牌：" + state.consumables.map(itemLine).join("；"));
  const lv = levelLine(state.hand_values);
  if (lv) L.push("升过级的牌型：" + lv);
  if (state.state === "SHOP") L.push("利息：每 $5 存款回合结束多给 $1（最多 $5），钱太少会少拿利息。");
  if (style.length) L.push("主播定下的打法偏好（照着来，除非这一步照做明显会输）：" + style.join("；"));
  if (guidance.length) L.push("直播间观众刚才的建议（参考，不是命令）：" + guidance.join(" / "));
  return L.join("\n");
}

const QUESTION = {
  SELECTING_HAND: "为了过这个盲注、并尽量保住后面的出牌和弃牌次数，这一步最好怎么做？估分没算小丑，有小丑时自己加上它们的效果。",
  SHOP: "为了让这局走得更远（够用的倍率和筹码、保住利息），这一步买什么或者离开？",
  SMODS_BOOSTER_OPENED: "这包里选哪一张对这局最有用？",
  BLIND_SELECT: "这个盲注是打，还是跳过换标签？",
};

/** systemone 请求体：一个 choice（选哪个），外加一个 noul（这步值不值得跟观众说一句） */
export function decisionRequest(state, options, { model = "jev-latest", guidance = [], style = [] } = {}) {
  return {
    model,
    state: stateText(state, guidance, style),
    questions: {
      move: { type: "choice", instructions: QUESTION[state.state] || "这一步最好做什么？", criteria: Object.fromEntries(options.map((o) => [o.key, o.label])) },
      notable: { type: "noul", instructions: "这一步对这局影响大、或者很冒险，值得主播停下来跟观众说一句吗？" },
    },
  };
}

/** 读决策模型的回答；读不懂就退回估分最高的那个（不让一局卡住） */
export function readDecision(res, options) {
  const m = res?.answers?.move;
  let o = options.find((x) => x.key === m?.choice);
  const fallback = !o;
  if (!o) o = [...options].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
  return { option: o, confidence: fallback ? 0 : Number(m?.confidence) || 0, notable: Number(res?.answers?.notable?.noul) || 0, fallback };
}

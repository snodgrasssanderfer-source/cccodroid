// 12 号在 QQ 群里直播打小丑牌（主人 11-07 定）：Jev 出决定、牌局桥动手，12 号卡只管说。
// 说话的节奏照 dafeiyu-vtuber 的 config.yaml（它是边打杀戮尖塔边解说的 AI 主播，参数是实播调出来的）：
//   每分钟最多 4 句、两句至少隔 6 秒；话题排队 15 秒没轮到就作废（关键时刻不作废）；
//   讲思路（买、选包、跳盲注）至少隔 60 秒；打牌时只在每个盲注第一手、斩杀、保命时先说再打，两句至少隔 20 秒；
//   冷场 100 秒自己找个角度聊；观众的打法建议摆 90 秒、最多 3 条，只当参考递给决策模型。
// 群友的话照旧走 12 号平时那套（发言节奏、表情、记忆都不变）；这里只往她那段里递「画面」。
// 牌局的要点记进她自己的 memory.json（和群聊记忆同一份），下次开播、平时聊天都翻得到。
import { plan, decisionRequest, readDecision, HAND_CN, shelfLine } from "./xk-balatro.mjs";

export const LIVE_PARAMS = {
  // 11-07 晚：两场直播里说话间隔超过 35 秒的有十几处，中间几手 Jev 闷头打、她不知道。放宽：每分钟 6 句、出牌最短隔 8 秒、冷场 25 秒就找话说
  linesPerMinute: 6, minGapSec: 5, topicTtlSec: 15, decisionCooldownSec: 60, combatGapSec: 8, idleSec: 25,
  guidanceSec: 90, guidanceMax: 3,
  actGapMs: 2500,          // 两步之间至少停这么久，群里看得过来
  sayWaitMs: 30000,        // 先说后打：最多等她这么久
  notableBar: 0.75,        // 决策模型觉得「值得说一句」到这个数，平常的出牌也说
  settleMaxMs: 240000,     // 动作超时后最多等画面换帧这么久（牌局桥自己等 180 秒）
  settleTellMs: 20000,     // 等过这么久还没换，跟群里说一声游戏卡了
  stuckLimit: 5,           // 连着这么多次读不到局面：多半是游戏被切到后台了
  shopWaitMs: 15000,       // 主人 11-07：商店是互动点，进店报完货架等群友点单这么久再动
};
const SEED_CH = "123456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
const randomSeed = () => Array.from({ length: 8 }, () => SEED_CH[Math.floor(Math.random() * SEED_CH.length)]).join("");

/** 主人在群里说的开播 / 下播（只认主人的号，调用方核） */
export function liveCmd(text) {
  const t = String(text || "").replace(/\s+/g, "").replace(/[。！!.~～]+$/, "");
  if (/^(开播|开始直播|直播小丑牌|开直播)$/.test(t)) return "start";
  if (/^(下播|停播|结束直播|关播)$/.test(t)) return "stop";
  return null;
}

const SKIP_RE = /【不说】/;
/** 她这一轮回的是「不说」：网关就别往群里发 */
export const isSilent = (said) => SKIP_RE.test(String(said || ""));

// 这几轮她直接写正文：写出来的就是说出口的话，边写边念、写完作为字幕发进群（见 xk-qq-speech.mjs）。
// 只认第一次调工具之前、第一个空行之前的那段，所以「写完再补一段说明」那段不会被念出去
const TAIL = "（你在 QQ 群里直播打小丑牌，主人和群友在看。上面是画面，出牌是你自己的决定。"
  + "这一轮直接写你要说出口的话，一两句口语，像主播边打边念叨；写出来的会被念出来，也会发进群。"
  + "不用 send_message，别报数据清单、别念规则、别加任何说明，跟刚才说过的别重复。没什么好说的就只写【不说】。）";

/**
 * deps:
 *   bridge.state() / bridge.act(a)：牌局桥
 *   decide(body)：systemone 请求 → 回答
 *   speak(line) → Promise（她那一轮跑完才 resolve）；busy()：她聊天那边是不是正在回别人；
 *   mouthBusy()：解说那边（嘴）上一句还在说没有（主人 11-07 晚：解说另起一段，不跟回群消息抢一个对话）
 *   remember(text)：记进她的记忆；recent()：她以前记过的几条牌局记忆
 *   log(text)
 */
export function createLive(deps, params = LIVE_PARAMS) {
  const P = { ...LIVE_PARAMS, ...params };
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const S = {
    on: false, startedAt: 0, said: [], lastLine: -Infinity, lastDecisionLine: -Infinity, lastCombatLine: -Infinity,
    topics: [], guidance: [], stuck: 0, runs: 0, best: 0, bestHand: "", games: [], bosses: [], top: { score: 0, hand: "" }, lastAnte: 0, stopReason: "",
    actedSeq: null,   // 上一个动作是对着哪一帧（牌局桥的 seq）做的：同一帧不再问第二遍
    lastState: "",    // 上一帧在哪个界面（进商店那一下要报货架）
    intent: null,     // 12 号这一步的想法 { text, scope }：管到办成或局面过去（离店、这一手打完）
  };
  const rec = (o) => { try { deps.record?.({ t: now(), ...o }); } catch {} };

  const okRate = (t = now()) => {
    S.said = S.said.filter((x) => t - x < 60000);
    return S.said.length < P.linesPerMinute && t - S.lastLine >= P.minGapSec * 1000;
  };
  const mouthBusy = () => (deps.mouthBusy || deps.busy)();
  async function say(text, { wait = false } = {}) {
    const t = now();
    if (!okRate(t)) return false;
    // 上一句还没说完：要等她的那句最多等几秒，等不到就不说了，牌照打；顺口的那种直接不说
    for (let i = 0; wait && mouthBusy() && i < 20; i++) await sleep(400);
    if (mouthBusy()) return false;
    S.said.push(t); S.lastLine = t;
    const p = Promise.resolve(deps.speak(text + "\n" + TAIL)).catch((e) => deps.log?.("直播说话出错：" + e.message));
    if (wait) await Promise.race([p, sleep(P.sayWaitMs)]);
    return true;
  }
  function topic(text, key = false) { S.topics.push({ text, key, at: now() }); }
  async function flushTopics() {
    const t = now();
    S.topics = S.topics.filter((x) => x.key || t - x.at <= P.topicTtlSec * 1000);
    if (!S.topics.length || mouthBusy() || !okRate(t)) return;
    // 关键的先说；同时有几条就并成一句画面
    S.topics.sort((a, b) => Number(b.key) - Number(a.key) || a.at - b.at);
    const batch = S.topics.splice(0, 3);
    await say(batch.map((x) => x.text).join("\n"));
  }

  /** 群友在直播时说的话：当建议摆一会儿 */
  function hear(nick, text) {
    if (!S.on) return;
    const t = now();
    S.guidance = S.guidance.filter((g) => t - g.at <= P.guidanceSec * 1000);
    S.guidance.push({ at: t, text: `${nick}：${String(text).slice(0, 60)}` });
    while (S.guidance.length > P.guidanceMax) S.guidance.shift();
  }
  const guidance = () => { const t = now(); return S.guidance.filter((g) => t - g.at <= P.guidanceSec * 1000).map((g) => g.text); };

  /** 这一步要不要先说再打，说什么 */
  function beforeLine(state, d) {
    const o = d.option, t = now();
    // 商店里买东西每件都说（主人 11-07：商店慢点没事，是互动的地方）；离店说一声剩多少钱
    if (state.state === "SHOP" && o.kind === "buy") return `[画面] 在商店，$${state.money}。你决定：${o.label}`;
    if (state.state === "SHOP" && o.kind === "leave") return `[画面] 逛完了，离开商店，还剩 $${state.money}，小丑：${(state.jokers || []).map((j) => j.name).join("、") || "还是没有"}。`;
    if (["buy", "pack", "skip", "pack_skip"].includes(o.kind)) {
      if (t - S.lastDecisionLine < P.decisionCooldownSec * 1000) return null;
      S.lastDecisionLine = t;
      const where = state.state === "SHOP" ? "在商店" : state.state === "BLIND_SELECT" ? "在选盲注" : "开了补充包";
      return `[画面] ${where}，$${state.money}。你决定：${o.label}`;
    }
    if (o.kind === "play" || o.kind === "discard") {
      const first = !state.hands_played && !state.discards_used;
      const last = state.hands_left === 1 && o.kind === "play";
      const big = first || o.kill || last || d.notable >= P.notableBar;
      if (t - S.lastCombatLine < P.combatGapSec * 1000) return null;
      S.lastCombatLine = t;
      // 平常的几手：边打边说，不等她（11-07 晚：原来只说要紧的那几手，一个盲注里中间全空着）
      if (!big) return { text: `[画面] ${o.kind === "discard" ? "弃牌" : "出牌"}：${o.label}。已得 ${state.score}/${state.target}，剩 ${state.hands_left} 次出牌、${state.discards_left} 次弃牌。`, wait: false };
      const b = state.blind || {};
      const why = last ? "最后一手了，打不够就输" : o.kill ? "这手能直接过关" : first ? `刚进${b.name || "盲注"}${b.effect ? "（" + b.effect + "）" : ""}，目标 ${state.target}` : "这步有点冒险";
      return `[画面] ${why}。手牌：${(state.hand || []).length} 张，已得 ${state.score}/${state.target}，剩 ${state.hands_left} 次出牌、${state.discards_left} 次弃牌。你决定：${o.label}`;
    }
    return null;
  }

  /** 动完之后的事件：记要点、攒话题 */
  function afterEvents(state, events = [], next = {}) {
    for (const e of events) {
      if (e.type === "hand_played" && e.score > S.best) { S.best = e.score; S.bestHand = HAND_CN[e.hand] || e.hand; }
      if (e.type === "hand_played" && e.score > S.top.score) S.top = { score: e.score, hand: HAND_CN[e.hand] || e.hand };
      if (e.type === "blind_cleared") {
        const boss = !!state.blind?.boss;
        topic(`[画面] 过了${e.name || "盲注"}：${e.score}/${e.target}。`, !!boss);
        // 11-07：原来每过一个 Boss、每输一局都单记一条，一场下来十几条，把她的记忆塞满了。现在攒着，下播记一条总的
        if (boss) S.bosses.push(`${state.ante}「${state.blind?.name || e.name}」`);
      }
      if (e.type === "won") topic("[画面] 赢了！这局通关了。", true);
    }
    if (next.state === "GAME_OVER" && state.state !== "GAME_OVER") {
      const won = !!next.won;
      const txt = `${won ? "通关" : "输了"}：停在第 ${next.ante ?? state.ante} 底注${state.blind?.name ? "的「" + state.blind.name + "」" : ""}，这局最大一手是${S.bestHand || "?"} ${S.best} 分，小丑：${(state.jokers || []).map((j) => j.name).join("、") || "没有"}`;
      S.games.push(`${won ? "通关" : "输在第 " + (next.ante ?? state.ante) + " 底注" + (state.blind?.name ? "「" + state.blind.name + "」" : "")}（最大一手${S.bestHand || "?"} ${S.best}，小丑：${(state.jokers || []).map((j) => j.name).join("、") || "没有"}）`);
      topic(`[画面] 这局${txt}。`, true);
    }
  }

  async function step() {
    let state;
    try { state = await deps.bridge.state(); S.stuck = 0; }
    catch (e) {
      S.stuck++;
      if (S.stuck === P.stuckLimit) topic("[画面] 游戏画面卡住了，读不到牌局（多半是游戏被切到后台）。跟大家说一声在等主人把游戏切回来。", true);
      await sleep(S.stuck >= P.stuckLimit ? 10000 : 2000);
      return;
    }
    // 11-07 真机：选卡包后游戏三分钟不报「好了」，网关超时后拿同一帧又问了她一遍。动过的那一帧不再拿去决策
    if (state.seq != null && state.seq === S.actedSeq) { await sleep(800); return; }
    const p = plan(state);
    if (p.wait) { await sleep(800); return; }
    // 局面过去了（离开商店、换了界面），一次性的想法作废
    if (S.intent && S.intent.scope && state.state !== S.intent.scope) { rec({ ev: "intent_end", text: S.intent.text, why: "局面过去了" }); S.intent = null; }
    const entered = state.state !== S.lastState;
    S.lastState = state.state;
    if (S.intent && !S.intent.scope) S.intent.scope = state.state;
    // 主人 11-07：商店是互动点。进店先报货架，留一会儿给群友点单，再让 Jev 动
    if (entered && state.state === "SHOP") {
      const shelf = shelfLine(state);
      topic(`[画面] 进商店了，$${state.money}，小丑 ${(state.jokers || []).length}/${state.capacity?.jokers ?? 5}。货架：${shelf || "空的"}。跟大家报一下有什么、你想买哪个，问问群友想要哪个。`, true);
      await flushTopics();
      const t0 = now();
      while (S.on && (now() - t0 < P.shopWaitMs || (deps.busy() && now() - t0 < P.shopWaitMs * 2))) await sleep(500);
      rec({ ev: "shop_enter", money: state.money, shelf, waitedMs: now() - t0 });
      S.actedSeq = null;
      return;   // 等的这会儿可能有人点单：下一圈重新读局面再决策
    }
    let act = p.auto, d = null;
    if (!act) {
      let res = null, err = "";
      const g = guidance(), st = deps.style?.() || [], intent = S.intent?.text || "";
      const t0 = now();
      try { res = await deps.decide(decisionRequest(state, p.options, { model: deps.model, guidance: g, style: st, intent })); }
      catch (e) { err = e.message; deps.log?.("决策模型出错，先按估分最高的打：" + e.message); }
      d = readDecision(res, p.options);
      act = d.option.act;
      // 逐步记下来（11-07 复盘只能靠解说倒推）：局面、候选、选了什么、把握度。不记群友原话
      rec({ ev: "decide", seq: state.seq, state: state.state, ante: state.ante, money: state.money, blind: state.blind?.name || "",
        score: state.score, target: state.target, hands_left: state.hands_left, discards_left: state.discards_left,
        jokers: (state.jokers || []).map((j) => j.name), options: p.options.map((o) => ({ key: o.key, label: o.label, score: o.score })),
        choice: d.option.key, confidence: d.confidence, notable: d.notable, fallback: d.fallback, err, decideMs: now() - t0,
        guidance: g.length, style: st.length, intent });
      let line = beforeLine(state, d), wait = true;
      if (line && typeof line === "object") { wait = line.wait; line = line.text; }
      // 攒着没说的要紧画面（「开了一局新的」）先说，免得顺序倒过来（11-07：先说跳盲注、才说开了新局）
      if (line) {
        const keys = S.topics.filter((x) => x.key);
        if (keys.length) { S.topics = S.topics.filter((x) => !x.key); line = keys.map((x) => x.text).join("\n") + "\n" + line; }
        const t1 = now();
        const spoke = await say(line, { wait });
        rec({ ev: "line", seq: state.seq, spoke, wait, waitMs: now() - t1 });
      }
    } else if (act.action === "start") {
      // 11-07：没给种子，连着几局开局手牌一模一样。随机给一个，记进日志；live.json 的 seed 能钉死（复现用）
      act = { ...act, seed: act.seed || deps.seed?.() || randomSeed() };
      rec({ ev: "start", seed: act.seed, deck: act.deck, stake: act.stake });
      S.runs++; S.best = 0; S.bestHand = "";
      topic(S.runs === 1 ? "[画面] 开了一局新的小丑牌（红色牌组、白注）。" : "[画面] 又开了一局。", true);
    }
    if (!S.on) return;
    let r;
    S.actedSeq = state.seq ?? null;
    try { r = await deps.bridge.act(act); }
    catch (e) {
      deps.log?.("动作没成：" + JSON.stringify(act) + " " + e.message);
      // 被拒（不合法、牌局桥 4xx）：画面没动，这一帧可以重新决策
      if (!/超时|timeout|aborted|502/i.test(e.message)) { S.actedSeq = null; await sleep(2000); return; }
      // 超时：动作多半已经到了游戏，只是还没报完。等画面真的变了再往下走，不拿旧帧重问；等不到就放开重来
      if (!(await settle(state))) S.actedSeq = null;
      return;
    }
    rec({ ev: "act", seq: state.seq, action: act.action, ok: r?.ok !== false, error: r?.ok === false ? String(r.error || "").slice(0, 200) : undefined, ms: r?.elapsed_ms });
    // 「这手就打同花」：这一手打出去就算办过了
    if (S.intent && act.action === "play") { rec({ ev: "intent_end", text: S.intent.text, why: "这一手打完了" }); S.intent = null; }
    afterEvents(state, r?.events || [], r?.state || {});
    await flushTopics();
    // 冷场太久：自己找个角度聊（手牌、小丑、Boss…）
    if (now() - Math.max(S.lastLine, S.startedAt) > P.idleSec * 1000 && !mouthBusy()) {
      await say(`[画面] 好一阵没说话了。现在：第 ${state.ante} 底注，$${state.money}，小丑：${(state.jokers || []).map((j) => j.name).join("、") || "还没有"}。挑个角度随口聊一句（手里的牌、小丑、接下来的 Boss 都行）。`);
    }
    await sleep(P.actGapMs);
  }

  /** 动作超时以后：等牌局桥的画面换一帧、而且能操作了；等久了跟大家说一声 */
  async function settle(before) {
    const t0 = now();
    let told = false;
    while (S.on && now() - t0 < P.settleMaxMs) {
      await sleep(2000);
      let s = null;
      try { s = await deps.bridge.state(); } catch {}
      if (s && s.ready !== false && (before.seq == null || s.seq !== before.seq) && s.state !== undefined) {
        deps.log?.(`画面换好了（等了 ${Math.round((now() - t0) / 1000)} 秒）`);
        return true;
      }
      if (!told && now() - t0 > P.settleTellMs) { told = true; topic("[画面] 游戏卡住了，刚才那步还没转完。跟大家说一声在等它缓过来。", true); await flushTopics(); }
    }
    return false;
  }

  async function loop() {
    while (S.on) {
      try { await step(); }
      catch (e) { deps.log?.("直播这一步出错：" + e.message); await sleep(3000); }
    }
  }

  return {
    get on() { return S.on; },
    status: () => ({ on: S.on, startedAt: S.startedAt, runs: S.runs, best: S.best, lines: S.said.length }),
    hear,
    /** 12 号说「这次就买那张」：一次性的，管到办成或局面过去；不按秒过期 */
    setIntent(text) {
      const t = String(text || "").trim().slice(0, 200);
      S.intent = t ? { text: t, scope: S.lastState || "" } : null;
      rec({ ev: "intent", text: t, scope: S.intent?.scope || "" });
      return S.intent;
    },
    get intent() { return S.intent?.text || ""; },
    async start() {
      if (S.on) return false;
      S.on = true; S.startedAt = now();
      const past = (deps.recent?.() || []).slice(-3);
      topic("[画面] 主人让你开播了，现在在 QQ 群里直播打小丑牌。先跟大家打个招呼。" + (past.length ? "你以前直播打过的：" + past.join("；") : ""), true);
      await flushTopics();
      loop();
      return true;
    },
    stop(reason = "主人下播") {
      if (!S.on) return false;
      S.on = false; S.stopReason = reason;
      Promise.resolve(deps.speak(`[画面] ${reason}，这场直播结束了，开了 ${S.runs} 局。跟大家道个别。\n` + TAIL)).catch(() => {});
      const min = Math.round((now() - S.startedAt) / 60000);
      // 一场一条；一局都没打完就不记（11-07 记过一条「打了 0 分钟、0 局」）。最大一手按整场算，不是最后那局（原来那局刚开就是 0 分）
      if (S.games.length) {
        const wins = S.games.filter((g) => g.startsWith("通关")).length;
        deps.remember?.(`直播打小丑牌 ${min} 分钟，打完 ${S.games.length} 局${wins ? `、通关 ${wins} 局` : "、一局没赢"}；整场最大一手${S.top.hand || "?"} ${S.top.score} 分` +
          (S.bosses.length ? `；过的 Boss：第${S.bosses.join("、第")}底注` : "") + `；各局：${S.games.join("；")}（${reason}）`);
      }
      return true;
    },
    // 测试用
    _step: step, _S: S,
  };
}

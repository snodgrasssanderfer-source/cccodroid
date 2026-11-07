// 12 号在 QQ 群里直播打小丑牌（主人 11-07 定）：Jev 出决定、牌局桥动手，12 号卡只管说。
// 说话的节奏照 dafeiyu-vtuber 的 config.yaml（它是边打杀戮尖塔边解说的 AI 主播，参数是实播调出来的）：
//   每分钟最多 4 句、两句至少隔 6 秒；话题排队 15 秒没轮到就作废（关键时刻不作废）；
//   讲思路（买、选包、跳盲注）至少隔 60 秒；打牌时只在每个盲注第一手、斩杀、保命时先说再打，两句至少隔 20 秒；
//   冷场 100 秒自己找个角度聊；观众的打法建议摆 90 秒、最多 3 条，只当参考递给决策模型。
// 群友的话照旧走 12 号平时那套（发言节奏、表情、记忆都不变）；这里只往她那段里递「画面」。
// 牌局的要点记进她自己的 memory.json（和群聊记忆同一份），下次开播、平时聊天都翻得到。
import { plan, decisionRequest, readDecision, HAND_CN } from "./xk-balatro.mjs";

export const LIVE_PARAMS = {
  linesPerMinute: 4, minGapSec: 6, topicTtlSec: 15, decisionCooldownSec: 60, combatGapSec: 20, idleSec: 100,
  guidanceSec: 90, guidanceMax: 3,
  actGapMs: 2500,          // 两步之间至少停这么久，群里看得过来
  sayWaitMs: 30000,        // 先说后打：最多等她这么久
  notableBar: 0.75,        // 决策模型觉得「值得说一句」到这个数，平常的出牌也说
  settleMaxMs: 240000,     // 动作超时后最多等画面换帧这么久（牌局桥自己等 180 秒）
  settleTellMs: 20000,     // 等过这么久还没换，跟群里说一声游戏卡了
  stuckLimit: 5,           // 连着这么多次读不到局面：多半是游戏被切到后台了
};

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
 *   speak(line) → Promise（她那一轮跑完才 resolve）；busy()：她这会儿是不是正在回别人
 *   remember(text)：记进她的记忆；recent()：她以前记过的几条牌局记忆
 *   log(text)
 */
export function createLive(deps, params = LIVE_PARAMS) {
  const P = { ...LIVE_PARAMS, ...params };
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const S = {
    on: false, startedAt: 0, said: [], lastLine: -Infinity, lastDecisionLine: -Infinity, lastCombatLine: -Infinity,
    topics: [], guidance: [], stuck: 0, runs: 0, best: 0, bestHand: "", lastAnte: 0, stopReason: "",
    actedSeq: null,   // 上一个动作是对着哪一帧（牌局桥的 seq）做的：同一帧不再问第二遍
  };

  const okRate = (t = now()) => {
    S.said = S.said.filter((x) => t - x < 60000);
    return S.said.length < P.linesPerMinute && t - S.lastLine >= P.minGapSec * 1000;
  };
  async function say(text, { wait = false } = {}) {
    const t = now();
    if (!okRate(t)) return false;
    // 她正在回群友：先说后打的那句最多等几秒，等不到就不说了，牌照打
    for (let i = 0; deps.busy() && i < 20; i++) await sleep(400);
    if (deps.busy()) return false;
    S.said.push(t); S.lastLine = t;
    const p = Promise.resolve(deps.speak(text + "\n" + TAIL)).catch((e) => deps.log?.("直播说话出错：" + e.message));
    if (wait) await Promise.race([p, sleep(P.sayWaitMs)]);
    return true;
  }
  function topic(text, key = false) { S.topics.push({ text, key, at: now() }); }
  async function flushTopics() {
    const t = now();
    S.topics = S.topics.filter((x) => x.key || t - x.at <= P.topicTtlSec * 1000);
    if (!S.topics.length || deps.busy() || !okRate(t)) return;
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
      if (!big || t - S.lastCombatLine < P.combatGapSec * 1000) return null;
      S.lastCombatLine = t;
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
      if (e.type === "blind_cleared") {
        const boss = !!state.blind?.boss;
        topic(`[画面] 过了${e.name || "盲注"}：${e.score}/${e.target}。`, !!boss);
        if (boss) deps.remember?.(`直播打小丑牌，过了第 ${state.ante} 底注的 Boss「${state.blind?.name || e.name}」，当时小丑有：${(state.jokers || []).map((j) => j.name).join("、") || "没有"}`);
      }
      if (e.type === "won") topic("[画面] 赢了！这局通关了。", true);
    }
    if (next.state === "GAME_OVER" && state.state !== "GAME_OVER") {
      const won = !!next.won;
      const txt = `${won ? "通关" : "输了"}：停在第 ${next.ante ?? state.ante} 底注${state.blind?.name ? "的「" + state.blind.name + "」" : ""}，这局最大一手是${S.bestHand || "?"} ${S.best} 分，小丑：${(state.jokers || []).map((j) => j.name).join("、") || "没有"}`;
      deps.remember?.("直播打小丑牌" + txt);
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
    let act = p.auto, d = null;
    if (!act) {
      let res = null;
      try { res = await deps.decide(decisionRequest(state, p.options, { model: deps.model, guidance: guidance() })); }
      catch (e) { deps.log?.("决策模型出错，先按估分最高的打：" + e.message); }
      d = readDecision(res, p.options);
      act = d.option.act;
      let line = beforeLine(state, d);
      // 攒着没说的要紧画面（「开了一局新的」）先说，免得顺序倒过来（11-07：先说跳盲注、才说开了新局）
      if (line) {
        const keys = S.topics.filter((x) => x.key);
        if (keys.length) { S.topics = S.topics.filter((x) => !x.key); line = keys.map((x) => x.text).join("\n") + "\n" + line; }
        await say(line, { wait: true });
      }
    } else if (act.action === "start") {
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
    afterEvents(state, r?.events || [], r?.state || {});
    await flushTopics();
    // 冷场太久：自己找个角度聊（手牌、小丑、Boss…）
    if (now() - Math.max(S.lastLine, S.startedAt) > P.idleSec * 1000 && !deps.busy()) {
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
      deps.remember?.(`在群里直播打了 ${min} 分钟小丑牌，开了 ${S.runs} 局，最大一手 ${S.best} 分（${reason}）`);
      return true;
    },
    // 测试用
    _step: step, _S: S,
  };
}

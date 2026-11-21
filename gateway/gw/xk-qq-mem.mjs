// 12 号（群里聊天那张卡）自己的记忆：qq-clean/memory.json，和屋里三个人的记忆库分开（主人 11-06 定）。
// 11-07 主人让照屋里那套补底子：分类、拆字匹配、旧的标「已过去」不硬删、聊天时自动附几条相关的。
// 这里只放纯函数（吃一个数组、吐结果），读写文件在 xk-qq.mjs。
import { tokens } from "./xk-memstore.mjs";
import { cos } from "./xk-embed.mjs";

export const CATS = ["主人的规矩", "群友", "游戏", "工具和坑", "杂事"];
export const MEM = { warnAt: 300, hardMax: 1000, inject: 3, minKw: 0.6, rules: 8, clip: 160 };

/** 老记忆没有分类：网关记的牌局、提到小丑牌的算游戏，别的先算杂事 */
export function catOf(m) {
  if (CATS.includes(m?.cat)) return m.cat;
  if (m?.tag === "game" || /小丑牌|直播|Jev|Balatro/i.test(m?.text || "")) return "游戏";
  return "杂事";
}
const day = (at) => { const d = new Date(at || 0); return `${d.getMonth() + 1}月${d.getDate()}日`; };
export function memLine(m, clip = 0, now = Date.now()) {
  const t = clip && m.text.length > clip ? m.text.slice(0, clip) + "…" : m.text;
  const faded = !m.past && memStrength(m, now) < FADE.floor;
  return `[${m.id}][${catOf(m)}] ${t}（${day(m.at)}${m.past ? "，已过去" : faded ? "，淡了" : ""}）`;
}

/** 从哪边记的：私聊（p:）记的只在私聊看得到；群里、日记、直播都只看群里记的（主人 11-07 晚定：日记不写私聊的事）。老记忆没标的都是群里记的 */
export const sideOf = (key) => (String(key || "").startsWith("p:") ? "p" : "g");
export const memVisible = (list, side) => (side === "p" ? list : list.filter((m) => m.src !== "p"));

/** 挑记忆的几个数（主人 11-11 定：按意思挑、最近的和主人的规矩优先、加遗忘） */
export const PICK = {
  simMin: 0.5,     // 向量相似度到这儿才算沾边（bge-small-zh：不相干的一般 0.3–0.45）
  ctxW: 0.3,       // 前几句占多少：这句话本身 0.7，前面的话 0.3
  recent: 0.06,    // 新近加分，按 14 天往下掉
  rule: 0.04,      // 主人的规矩加一点
  game: 0.08,      // 这几句没聊游戏时，游戏那类往后排
  fade: 0.05,      // 记得牢的加一点
};
/** 遗忘：从最后一次用到（没用过就从记下那天）起一天天淡下去；被她查到过、被附上过的淡得慢。主人的规矩不淡。
 *  淡到 FADE.floor 以下就不再自动附上，但不删，memory_query 照样查得到（标「淡了」） */
export const FADE = { days: 30, perInj: 0.1, perQ: 0.5, maxDays: 365, floor: 0.15 };
export function memStrength(m, now = Date.now()) {
  if (catOf(m) === "主人的规矩") return 1;
  const u = m.uses || {};
  const since = Math.max(m.at || 0, u.last || 0);
  const tau = Math.min(FADE.maxDays, FADE.days * (1 + FADE.perInj * (u.inj || 0) + FADE.perQ * (u.q || 0)));
  return Math.exp(-Math.max(0, now - since) / 86400000 / tau);
}
const GAME_TALK = /游戏|小丑|直播|开播|下播|打牌|牌局|出牌|Jev|Balatro|盲注|商店|Boss|通关/i;
export const isGameTalk = (s) => GAME_TALK.test(s || "");

/** 挑记忆。有向量（qv：这句话的，pv：前几句的，vec(m)：那条记忆的）就按意思挑，再加一点字面重合分；
 *  哪边没向量就退回按相邻两字的重合度挑（和屋里 search 一个算法）。已过去的排后面；fade 时淡了的不要 */
export function memSearch(list, query, { cat = "", limit = 8, past = true, minKw = 0, skip = null, now = Date.now(),
  prev = "", qv = null, pv = null, vec = null, fade = false } = {}) {
  const pool = list.filter((m) => (!cat || catOf(m) === cat) && (past || !m.past) && !(skip && skip.has(m.id)) &&
    (!fade || memStrength(m, now) >= FADE.floor));
  const q = tokens([prev, query].filter(Boolean).join(" "));
  if (!q.size && !qv) return pool.filter((m) => !m.past).slice(-limit);
  const gameTalk = isGameTalk(prev + " " + query);
  return pool.map((m) => {
    const mt = tokens(m.text);
    let hit = 0;
    for (const w of q) if (mt.has(w)) hit++;
    const kw = q.size ? hit / Math.sqrt(q.size) : 0;
    const v = qv && vec ? vec(m) : null;
    let base;
    if (v) {
      const sim = (1 - (pv ? PICK.ctxW : 0)) * cos(qv, v) + (pv ? PICK.ctxW * cos(pv, v) : 0);
      if (sim < PICK.simMin && !(hit && kw >= Math.max(minKw, 1))) return null;   // 意思不沾边；字面对上很多的也留着
      base = sim + 0.05 * Math.min(kw, 2);
    } else {
      if (!hit || kw < minKw) return null;
      base = PICK.simMin + 0.05 * Math.min(kw, 2);   // 没向量的：刚够线，排在真沾边的后面
    }
    const ageDays = Math.max(0, (now - (m.at || 0)) / 86400000);
    const c = catOf(m);
    const s = base + PICK.recent * Math.exp(-ageDays / 14) + PICK.fade * memStrength(m, now) +
      (c === "主人的规矩" ? PICK.rule : 0) - (c === "游戏" && !gameTalk ? PICK.game : 0) - (m.past ? 0.3 : 0);
    return { m, s };
  }).filter(Boolean).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.m);
}

/** 记一条；ends 里的旧记忆标成已过去（合并、改正都走这个）。返回 { list, item, dup, near } */
export function memAdd(list, { text, cat, ends = [], src = "g" }, now = Date.now(), rnd = Math.random) {
  if (!text) throw new Error("text 不能为空");
  if (!CATS.includes(cat)) throw new Error("cat 要从这几类里选：" + CATS.join("、"));
  const endIds = [].concat(ends || []).map(String);
  const seen = memVisible(list, src);
  for (const id of endIds) if (!seen.some((m) => m.id === id)) throw new Error("ends 里没有这条记忆：" + id);
  const same = seen.find((m) => !m.past && m.text === text && catOf(m) === cat);
  if (same && !endIds.length) return { list, item: same, dup: true, near: [] };
  for (const m of list) if (endIds.includes(m.id)) { m.past = true; m.ended = now; }
  const item = { id: "m" + now.toString(36) + rnd().toString(36).slice(2, 4), text, cat, at: now, ...(src === "p" ? { src: "p" } : {}) };
  // 同类里跟它相近、还作数的：交回去让她自己看有没有重复、打架的
  const near = memSearch(seen, text, { cat, limit: 3, past: false, minKw: 0.5, now });
  list.push(item);
  // 不再悄悄挤掉旧的；真到了硬上限，先丢已过去的，再丢最旧的
  while (list.length > MEM.hardMax) {
    const i = list.findIndex((m) => m.past);
    list.splice(i >= 0 ? i : 0, 1);
  }
  return { list, item, dup: false, near };
}

/** 每条消息前附上的：新会话先带主人的规矩，再按这句话（连同前几句）挑几条相关的；同一段会话带过的不再带 */
export function memInject(list, query, seen, { fresh = false, now = Date.now(), prev = "", qv = null, pv = null, vec = null } = {}) {
  const live = list.filter((m) => !m.past);
  const pick = [];
  if (fresh) pick.push(...live.filter((m) => catOf(m) === "主人的规矩" && !seen.has(m.id)).slice(-MEM.rules));
  const skip = new Set([...seen, ...pick.map((m) => m.id)]);
  // 主人的规矩不只新开时带：每一轮都和别的记忆一起比，沾边的照样挑上
  if (qv || tokens(query || "").size) pick.push(...memSearch(live, query, { limit: MEM.inject, minKw: MEM.minKw, skip, now, prev, qv, pv, vec, fade: true }));
  for (const m of pick) seen.add(m.id);
  if (!pick.length) return "";
  return "[你记得的（网关按这句话自动挑的，不全；要细查用 memory_query）]\n" + pick.map((m) => "- " + memLine(m, MEM.clip)).join("\n") + "\n[/你记得的]\n";
}

/** 用到一次记一笔（自动附上算 inj，她查到算 q）。11-11 起用来算遗忘（memStrength）：用得多的淡得慢 */
export function memTouch(list, ids, how, now = Date.now()) {
  const want = new Set([...ids].map(String));
  let n = 0;
  for (const m of list) {
    if (!want.has(m.id)) continue;
    m.uses = { inj: 0, q: 0, ...(m.uses || {}) };
    m.uses[how] = (m.uses[how] || 0) + 1;
    m.uses.last = now;
    n++;
  }
  return n;
}

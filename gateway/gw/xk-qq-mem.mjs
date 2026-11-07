// 12 号（群里聊天那张卡）自己的记忆：qq-clean/memory.json，和屋里三个人的记忆库分开（主人 11-06 定）。
// 11-07 主人让照屋里那套补底子：分类、拆字匹配、旧的标「已过去」不硬删、聊天时自动附几条相关的。
// 这里只放纯函数（吃一个数组、吐结果），读写文件在 xk-qq.mjs。
import { tokens } from "./xk-memstore.mjs";

export const CATS = ["主人的规矩", "群友", "游戏", "工具和坑", "杂事"];
export const MEM = { warnAt: 300, hardMax: 1000, inject: 3, minKw: 0.6, rules: 8, clip: 160 };

/** 老记忆没有分类：网关记的牌局、提到小丑牌的算游戏，别的先算杂事 */
export function catOf(m) {
  if (CATS.includes(m?.cat)) return m.cat;
  if (m?.tag === "game" || /小丑牌|直播|Jev|Balatro/i.test(m?.text || "")) return "游戏";
  return "杂事";
}
const day = (at) => { const d = new Date(at || 0); return `${d.getMonth() + 1}月${d.getDate()}日`; };
export function memLine(m, clip = 0) {
  const t = clip && m.text.length > clip ? m.text.slice(0, clip) + "…" : m.text;
  return `[${m.id}][${catOf(m)}] ${t}（${day(m.at)}${m.past ? "，已过去" : ""}）`;
}

/** 关键词按相邻两字拆开算重合度，再加一点新近分；已过去的排后面（和屋里 search 一个算法） */
export function memSearch(list, query, { cat = "", limit = 8, past = true, minKw = 0, skip = null, now = Date.now() } = {}) {
  const pool = list.filter((m) => (!cat || catOf(m) === cat) && (past || !m.past) && !(skip && skip.has(m.id)));
  const q = tokens(query || "");
  if (!q.size) return pool.filter((m) => !m.past).slice(-limit);
  return pool.map((m) => {
    const mt = tokens(m.text);
    let hit = 0;
    for (const w of q) if (mt.has(w)) hit++;
    const kw = hit / Math.sqrt(q.size);
    if (!hit || kw < minKw) return null;
    const ageDays = Math.max(0, (now - (m.at || 0)) / 86400000);
    return { m, s: kw + 0.5 * Math.exp(-ageDays / 30) - (m.past ? 0.3 : 0) };
  }).filter(Boolean).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.m);
}

/** 记一条；ends 里的旧记忆标成已过去（合并、改正都走这个）。返回 { list, item, dup, near } */
export function memAdd(list, { text, cat, ends = [] }, now = Date.now(), rnd = Math.random) {
  if (!text) throw new Error("text 不能为空");
  if (!CATS.includes(cat)) throw new Error("cat 要从这几类里选：" + CATS.join("、"));
  const endIds = [].concat(ends || []).map(String);
  for (const id of endIds) if (!list.some((m) => m.id === id)) throw new Error("ends 里没有这条记忆：" + id);
  const same = list.find((m) => !m.past && m.text === text && catOf(m) === cat);
  if (same && !endIds.length) return { list, item: same, dup: true, near: [] };
  for (const m of list) if (endIds.includes(m.id)) { m.past = true; m.ended = now; }
  const item = { id: "m" + now.toString(36) + rnd().toString(36).slice(2, 4), text, cat, at: now };
  // 同类里跟它相近、还作数的：交回去让她自己看有没有重复、打架的
  const near = memSearch(list, text, { cat, limit: 3, past: false, minKw: 0.5, now });
  list.push(item);
  // 不再悄悄挤掉旧的；真到了硬上限，先丢已过去的，再丢最旧的
  while (list.length > MEM.hardMax) {
    const i = list.findIndex((m) => m.past);
    list.splice(i >= 0 ? i : 0, 1);
  }
  return { list, item, dup: false, near };
}

/** 每条消息前附上的：新会话先带主人的规矩，再按这句话挑几条相关的；同一段会话带过的不再带 */
export function memInject(list, query, seen, { fresh = false, now = Date.now() } = {}) {
  const live = list.filter((m) => !m.past);
  const pick = [];
  if (fresh) pick.push(...live.filter((m) => catOf(m) === "主人的规矩" && !seen.has(m.id)).slice(-MEM.rules));
  const skip = new Set([...seen, ...pick.map((m) => m.id)]);
  pick.push(...memSearch(live, query, { limit: MEM.inject, minKw: MEM.minKw, skip, now }).filter(() => tokens(query || "").size));
  for (const m of pick) seen.add(m.id);
  if (!pick.length) return "";
  return "[你记得的（网关按这句话自动挑的，不全；要细查用 memory_query）]\n" + pick.map((m) => "- " + memLine(m, MEM.clip)).join("\n") + "\n[/你记得的]\n";
}

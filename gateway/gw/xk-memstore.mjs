// 一个角色的长期记忆：roles/<角色>/memory/memories.json。网关、hook、MCP 服务三个进程都读写它，所以只用 node 内置模块，写时加锁。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const KINDS = ["fact", "event", "plan", "opinion"];
const KIND_ZH = { fact: "事实", event: "事件", plan: "计划", opinion: "看法" };
const CHANNEL_ZH = { app: "App", "qq-private": "QQ 私聊", "qq-group": "QQ 群" };

const file = (dir) => path.join(dir, "memory", "memories.json");
export function load(dir) {
  try { return JSON.parse(fs.readFileSync(file(dir), "utf8")); }
  catch (e) { if (e.code === "ENOENT") return []; throw new Error(`记忆文件读不了（${file(dir)}）：${e.message}`); }
}
function save(dir, list) {
  const f = file(dir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(list, null, 1));
  fs.renameSync(f + ".tmp", f);
}
// 锁：MCP 服务（她当场记）、空闲整理、界面编辑可能同时写。mkdir 是原子的；持锁的进程被杀会留下锁，过 30 秒当作没人
function locked(dir, fn) {
  const lock = path.join(dir, "memory", ".lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const until = Date.now() + 10000;
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
      if (Date.now() > until) throw new Error("记忆文件被占着超过 10 秒");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { const list = load(dir); const r = fn(list); save(dir, list); return r; }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── 时间锚兜底：提示词要她把「昨天」「下周六」换成日期，漏了的这里按记下那天换掉。旁边已经写了日期的不动 ──
const ymd = (d) => today(d);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const WD = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const DAYW = { 大前天: -3, 前天: -2, 昨天: -1, 今天: 0, 明天: 1, 后天: 2, 大后天: 3 };
const NIGHT = { 昨晚: -1, 今晚: 0, 明晚: 1 };
const REL = /(上|这|本|下)(?:个)?(?:周|星期|礼拜)([一二三四五六日天])|(上|这|本|下)(?:个)?(?:周|星期|礼拜)|(上|这|本|下)个月|大前天|大后天|前天|昨天|今天|明天|后天|昨晚|今晚|明晚/g;
const DATED = /\d{4}-\d{1,2}-\d{1,2}|\d{4}年|\d{1,2}月\d{1,2}[日号]/;
export function anchorDates(text, said = new Date()) {
  const d0 = new Date(said.getFullYear(), said.getMonth(), said.getDate());
  const monday = addDays(d0, -((d0.getDay() + 6) % 7));
  const shift = (w) => (w === "上" ? -7 : w === "下" ? 7 : 0);
  return String(text).replace(REL, (hit, w1, wd, w2, w3, at, src) => {
    const near = src.slice(Math.max(0, at - 12), at + hit.length + 12);
    if (DATED.test(near)) return hit;
    if (wd) return ymd(addDays(monday, shift(w1) + WD[wd] - 1));
    if (w2) return ymd(addDays(monday, shift(w2))) + " 那周";
    if (w3) { const m = new Date(d0.getFullYear(), d0.getMonth() + (w3 === "上" ? -1 : w3 === "下" ? 1 : 0), 1); return `${m.getFullYear()}年${m.getMonth() + 1}月`; }
    if (hit in NIGHT) return ymd(addDays(d0, NIGHT[hit])) + "晚上";
    return ymd(addDays(d0, DAYW[hit]));
  });
}
// 去重用：去掉空白和标点后一字不差，算同一条
const norm = (s) => String(s).replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();

/** 记一条。ends：这条让哪些旧记忆不再成立，旧的标成已过去（until = 这条的日期）留着。
 *  已经有一字不差、还没过去的同一条，就不再记一遍，返回那条（dup: true） */
export function remember(dir, m) {
  const text = anchorDates(String(m.text || "").trim());
  if (!text) throw new Error("text 不能为空");
  const kind = KINDS.includes(m.kind) ? m.kind : "fact";
  const date = DATE.test(m.date || "") ? m.date : today();
  return locked(dir, (list) => {
    const same = list.find((x) => !x.past && norm(x.text) === norm(text));
    if (same && ![].concat(m.ends || []).length) return { ...same, dup: true };
    for (const id of [].concat(m.ends || [])) {
      const old = list.find((x) => x.id === id);
      if (!old) throw new Error("ends 里的 id 不存在：" + id);
      old.past = true; old.until = old.until || date; old.updated = Date.now();
    }
    const item = { id: crypto.randomBytes(4).toString("hex"), text, kind, who: String(m.who || "").trim() || "主人", date,
      until: DATE.test(m.until || "") ? m.until : "", past: false, channel: m.channel || "app",
      source: m.source || null, created: Date.now(), updated: Date.now() };
    list.push(item);
    return item;
  });
}

export function update(dir, id, patch) {
  return locked(dir, (list) => {
    const m = list.find((x) => x.id === id);
    if (!m) throw new Error("没有这条记忆：" + id);
    if (typeof patch.text === "string" && patch.text.trim()) m.text = patch.text.trim();
    if (KINDS.includes(patch.kind)) m.kind = patch.kind;
    if (typeof patch.who === "string") m.who = patch.who.trim() || m.who;
    for (const k of ["date", "until"]) if (typeof patch[k] === "string" && (patch[k] === "" || DATE.test(patch[k]))) m[k] = patch[k] || (k === "date" ? m.date : "");
    if (typeof patch.past === "boolean") m.past = patch.past;
    m.updated = Date.now();
    return m;
  });
}

export function remove(dir, id) {
  return locked(dir, (list) => {
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) throw new Error("没有这条记忆：" + id);
    return list.splice(i, 1)[0];
  });
}

// 关键词：英文数字按词，中文按相邻两字（不分词也能匹配上「面包」「书架」这类词）
function tokens(s) {
  const out = new Set();
  const t = String(s).toLowerCase();
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  for (const run of t.match(/[㐀-鿿]+/g) || []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 按关键词重合度 + 时间远近排；已过去的也能找到，只是排后一点 */
export function search(dir, query, limit = 8, now = Date.now()) {
  const q = tokens(query);
  if (!q.size) return [];
  return load(dir).map((m) => {
    const mt = tokens(m.text + " " + m.who);
    let hit = 0;
    for (const w of q) if (mt.has(w)) hit++;
    if (!hit) return null;
    const ageDays = Math.max(0, (now - Date.parse(m.date || 0)) / 86400000);
    return { m, score: hit / Math.sqrt(q.size) + 0.5 * Math.exp(-ageDays / 30) - (m.past ? 0.3 : 0) };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.m);
}

/** 会话开始时带上的要点：今天及以后的计划、最近两周的事、她的看法、最近更新的事实；不含已过去的 */
export function digest(dir, max = 1500, now = Date.now()) {
  const t = today(new Date(now)), recent = today(new Date(now - 14 * 86400000));
  const live = load(dir).filter((m) => !m.past);
  const pick = [
    ...live.filter((m) => m.kind === "plan" && m.date >= t).sort((a, b) => a.date.localeCompare(b.date)),
    ...live.filter((m) => m.kind === "event" && m.date >= recent).sort((a, b) => b.date.localeCompare(a.date)),
    ...live.filter((m) => m.kind === "opinion").sort((a, b) => b.updated - a.updated),
    ...live.filter((m) => m.kind === "fact").sort((a, b) => b.updated - a.updated),
  ];
  const seen = new Set(), lines = [];
  let n = 0;
  for (const m of pick) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const l = line(m);
    if (n + l.length > max) break;
    lines.push(l); n += l.length;
  }
  return lines.join("\n");
}

export function line(m) {
  const tail = m.past ? `（已过去${m.until ? "，" + m.until + " 起" : ""}）` : m.until ? `（到 ${m.until}）` : "";
  return `- [${m.id}] ${m.date} ${KIND_ZH[m.kind] || m.kind}·${m.who}·${CHANNEL_ZH[m.channel] || m.channel}：${m.text}${tail}`;
}

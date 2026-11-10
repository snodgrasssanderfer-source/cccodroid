// 12 号的聊天记录本（主人 11-08 定：她忘了的事，主人提醒一句她能自己翻回来）。
// 每个聊天各一本：私聊翻私聊、这个群翻这个群，互不相通（和记忆的 src 一个道理）。
// 只存在手机的 qq-clean/chatlog 里，不进仓库、不外发。
import fs from "node:fs";
import path from "node:path";

export const LOG_MAX_BYTES = 8 << 20;   // 一本超过 8MB 就只读最后这些（够翻几个月的私聊）
const fileOf = (dir, key) => path.join(dir, String(key).replace(/[^\w.-]/g, "_") + ".jsonl");

/** 记一句。who：in（对方，带昵称那一整行）/ me（她自己发的） */
export function logAdd(dir, key, who, text, at = Date.now()) {
  const x = String(text || "").trim();
  if (!x || !key) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(fileOf(dir, key), JSON.stringify({ t: at, w: who, x: x.slice(0, 2000) }) + "\n");
}

export function logRead(dir, key) {
  let buf;
  try {
    const f = fileOf(dir, key), size = fs.statSync(f).size;
    const fd = fs.openSync(f, "r"), n = Math.min(size, LOG_MAX_BYTES);
    buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
  } catch { return []; }
  const out = [];
  for (const l of buf.toString("utf8").split("\n")) { try { const j = JSON.parse(l); if (j && j.x) out.push(j); } catch {} }
  return out;
}

const p2 = (n) => String(n).padStart(2, "0");
export const dayStr = (t) => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const stamp = (t) => { const d = new Date(t); return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
// 私聊那行开头一长串（[私聊] [主人] 昵称(QQ 号)：）缩成「主人：」「昵称：」；群里的照原样留着号码，认得出是谁
const tidy = (x) => x.replace(/^\[私聊\] \[主人\] .*?\(QQ \d+\)：/, "主人：").replace(/^\[私聊\] (.*?)\(QQ \d+\)：/, "$1：");
export const logLine = (e, clip = 300) => { const x = e.w === "me" ? "你：" + e.x : tidy(e.x); return `${stamp(e.t)} ${x.length > clip ? x.slice(0, clip) + "…" : x}`; };

// 关键词：空格分开的词各自要有；中文连着写的拆成两字一组，大半对上就算（和记忆检索一个路数，不用一字不差）
function scorer(q) {
  const words = String(q || "").toLowerCase().split(/[\s,，、]+/).filter(Boolean);
  return (s) => {
    const t = s.toLowerCase();
    let hit = 0;
    for (const w of words) {
      if (t.includes(w)) { hit++; continue; }
      const grams = [...w].length < 3 ? [] : [...w].slice(0, -1).map((c, i) => c + [...w][i + 1]);
      if (grams.length && grams.filter((g) => t.includes(g)).length / grams.length >= 0.5) hit += 0.6;
    }
    return words.length ? hit / words.length : 0;
  };
}

/** 翻记录：按关键词（带前后各两句）或按日期。返回给她看的文本 */
export function logSearch(dir, key, { query = "", date = "", limit = 6, around = 2 } = {}) {
  let all = logRead(dir, key);
  if (!all.length) return "这个聊天还没有记录。";
  if (date) {
    all = all.filter((e) => dayStr(e.t) === date);
    if (!all.length) return `${date} 这天没有记录。`;
  }
  if (!String(query).trim()) {
    const n = Math.max(1, Math.min(60, Number(limit) > 6 ? Number(limit) : 30));
    const part = date ? all.slice(0, n) : all.slice(-n);
    return (date ? `${date} 这天的开头 ${part.length} 句（共 ${all.length} 句）：\n` : `最近 ${part.length} 句：\n`) + part.map((e) => logLine(e)).join("\n");
  }
  const sc = scorer(query);
  const scored = all.map((e, i) => ({ i, s: sc(e.x) })).filter((x) => x.s >= 0.6);
  if (!scored.length) return "没翻到；换个说法、少写几个词，或者按日期看那天聊了什么。";
  // 新的、对得多的排前面；挑出来的几处按时间排回去，挨得近的并成一段
  const pick = scored.sort((a, b) => b.s - a.s || b.i - a.i).slice(0, Math.max(1, Math.min(12, Number(limit) || 6))).map((x) => x.i).sort((a, b) => a - b);
  const blocks = [];
  for (const i of pick) {
    const lo = Math.max(0, i - around), hi = Math.min(all.length - 1, i + around);
    const last = blocks.at(-1);
    if (last && lo <= last.hi + 1) last.hi = Math.max(last.hi, hi); else blocks.push({ lo, hi });
  }
  return `翻到 ${pick.length} 处：\n` + blocks.map((b) => all.slice(b.lo, b.hi + 1).map((e) => logLine(e)).join("\n")).join("\n……\n");
}

/** 新开一段时接上的尾巴：上一段最后几句（太久以前的不带） */
export function logTail(dir, key, { n = 20, maxAgeMs = 12 * 3600000, now = Date.now() } = {}) {
  const all = logRead(dir, key).slice(-n).filter((e) => now - e.t < maxAgeMs);
  if (!all.length) return "";
  return "[刚才的聊天（换了一段新的对话，这是上一段最后几句，接着聊就行）]\n" + all.map((e) => logLine(e, 200)).join("\n") + "\n[/刚才的聊天]\n";
}

/** 把旧的会话记录补进记录本（只补主人私聊；装上时跑一次） */
export function logBackfill(dir, key, files, ownerTag = "[主人]") {
  if (logRead(dir, key).length) return 0;
  const rows = [];
  for (const f of files) {
    let lines; try { lines = fs.readFileSync(f, "utf8").split("\n"); } catch { continue; }
    const mine = [];
    let isOwnerPriv = false;
    for (const l of lines) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      const t = Date.parse(e.timestamp || "");
      const c = e.message?.content;
      if (!t || !c) continue;
      if (e.type === "user") {
        const txt = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join("\n") : "";
        for (const s of txt.replace(/\[你记得的[\s\S]*?\[\/你记得的\]/g, "").split("\n")) {
          const x = s.trim();
          if (x.startsWith("[私聊] " + ownerTag)) { isOwnerPriv = true; mine.push({ t, w: "in", x }); }
          else if (x.startsWith("[拍一拍]")) mine.push({ t, w: "in", x });
        }
      } else if (e.type === "assistant" && Array.isArray(c)) {
        for (const x of c) if (x.type === "tool_use" && /send_message$/.test(x.name || "")) {
          const ms = [].concat(x.input?.messages ?? []).map((m) => (typeof m === "string" ? m : m?.text || "")).filter(Boolean);
          if (ms.length) mine.push({ t, w: "me", x: ms.join(" / ") });
        }
      }
    }
    if (isOwnerPriv) rows.push(...mine);
  }
  rows.sort((a, b) => a.t - b.t);
  if (!rows.length) return 0;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileOf(dir, key), rows.map((r) => JSON.stringify({ t: r.t, w: r.w, x: r.x.slice(0, 2000) })).join("\n") + "\n");
  return rows.length;
}

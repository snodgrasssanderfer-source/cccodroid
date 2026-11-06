// 这一份的纯函数搬自 qq-agent-plus（MIT），按主人 11-06 定的「照原版改」。
// 原项目：https://github.com/sakurawwwxh/qq-agent-plus
//   - src/core/util.js：normalizeMessageList / unwrapMessage / unquoteJsonString / sanitizeUserText
//   - src/onebot/stickers.js：normalizeStickerEntry / mergeStickerLibrary / findSticker / formatStickerList
//   - src/tools/tools-core.js：normalizeMid / resolveMessageTarget 的判断顺序
//   - src/onebot/sender.js：leadDelayFor（首条消息前的停顿）
// Copyright (c) 2026 Kondius
// MIT 许可全文与署名见仓库根 NOTICE 和 ThirdPartyLicenses/qq-agent-plus.txt。
// 我们的外壳（白名单、strict MCP、号码只从事件里取、oneLine、重试去重、cardHash）不在这里。

/** 消息 id 归一化：模型常把聊天记录里的 "#123" 连 # 一起传进来 */
export function normalizeMid(value) {
  return String(value ?? "").trim().replace(/^(?:#+|collected_)+/, "").trim();
}

/** 模型偶尔把字符串又 JSON 编码了一遍 */
export function unquoteJsonString(value) {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === "string") return parsed;
    } catch { /* 原样返回 */ }
  }
  return value;
}

/** 弱模型常见的对象形态：{text} / {content} / {message} / content-parts → 纯文本 */
export function unwrapMessage(m) {
  if (m === null || m === undefined) return "";
  if (typeof m === "string") return m;
  if (Array.isArray(m)) return m.map(unwrapMessage).filter((x) => x !== null).join("\n");
  if (typeof m === "object") {
    if (m.type === "text" && typeof m.text === "string") return m.text;
    if (Array.isArray(m.content)) {
      return m.content.filter((p) => p && p.type === "text").map((p) => String(p.text ?? "")).join("\n");
    }
    const v = m.text ?? m.content ?? m.message;
    if (typeof v === "string") return v;
    return null;
  }
  return String(m);
}

/**
 * messages 参数统一成条目数组：字符串 / 字符串数组 / 对象 / 对象数组 /
 * 双重编码的 JSON 都能解；对象上带的 atUserId、replyToMessageId 留着（我们这层多认这个）。
 * 一条都解不出来才抛错 —— 错误会作为工具结果回给模型，它可以在同一轮里改对重发。
 */
export function normalizeMessageList(input) {
  let value = input;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) || (parsed && typeof parsed === "object")) value = parsed;
      } catch { /* 保持字符串 */ }
    } else if (trimmed.startsWith('"')) {
      const unquoted = unquoteJsonString(trimmed);
      if (typeof unquoted === "string") value = unquoted;
    }
  }
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  const bad = [];
  for (const m of arr) {
    const unwrapped = unwrapMessage(m);
    if (unwrapped === null) { bad.push(m); continue; }
    const text = String(unwrapped).trim();
    if (!text) continue;
    const o = m && typeof m === "object" && !Array.isArray(m) ? m : {};
    out.push({
      text,
      atUserId: normalizeMid(o.atUserId),
      replyToMessageId: normalizeMid(o.replyToMessageId),
    });
  }
  if (!out.length && bad.length) {
    throw new Error(`messages 必须是字符串或字符串数组，收到的是对象形态：${JSON.stringify(bad[0])?.slice(0, 120)}——请把消息文本直接作为字符串传入`);
  }
  return out;
}

/** 群友可控内容（备注、群名片）回给模型前的统一出口：剥不可见字符、方括号里不留空白、段头弱化。
 *  原版是一张关键词大表；这里按同一口径收成一条通例：方括号段一律换成圆括号，伪造不出【段头】。 */
export function sanitizeUserText(text) {
  let s = String(text ?? "");
  s = s.replace(/[\p{Cf}\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f᠎͏ᅟᅠ⠀ㅤ︀-️ﾠ]/gu, "");
  s = s.replace(/([\[【［])([^\]】］]*)([\]】］])/g, (_m, open, body, close) => open + body.replace(/\s+/g, "") + close);
  s = s.replace(/[【［]/g, "（").replace(/[】］]/g, "）");
  return s;
}

export const nowIso = () => new Date().toISOString();

/** 表情条目：QQ 收藏是源，本地只记备注/笔记/标签/用过几次 */
export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === "object" ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || "").trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? "").trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || "").trim(),
    md5: String(entry.md5 || "").trim().toUpperCase(),
    desc: String(entry.desc ?? "").trim(),
    localNote: String(entry.localNote ?? "").trim(),
    tags,
    usage: String(entry.usage ?? "").trim(),
    source: entry.source === "manual" ? "manual" : (entry.source === "ai" ? "ai" : "qq"),
    hidden: entry.hidden === true,
    metadataEdited: entry.metadataEdited === true,
    useCount: Math.max(0, Number(entry.useCount) || 0),
    missCount: Math.max(0, Math.floor(Number(entry.missCount) || 0)),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? "").slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso()),
  };
}

/** 把 QQ 收藏这次拉到的并进本地库：本地备注/笔记/计数不丢；连着三次没出现的才删 */
export function mergeStickerLibrary(existing, fetched) {
  const out = (Array.isArray(existing) ? existing : []).map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || "").trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.emoji_id || item.resId || item.id || "").trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || "").trim(),
      md5: String(item.md5 || old?.md5 || "").trim().toUpperCase(),
      desc: old?.metadataEdited ? old.desc : String(item.desc ?? old?.desc ?? "").trim(),
      localNote: old?.localNote || "",
      tags: old?.tags || [],
      usage: old?.usage || "",
      source: old?.source || "qq",
      useCount: old?.useCount || 0,
      missCount: 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || "",
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso(),
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
    }
  }
  // 一条都没拉到：不剪枝，免得接口一抖把备注一起清空
  if (!fetchedIds.size) return out;
  // 拉满同步窗口时不知道后面还有没有：不剪枝
  if (Array.isArray(fetched) && fetched.length >= 500) return out;
  const kept = [];
  for (const entry of out) {
    if (entry.source !== "qq" || fetchedIds.has(entry.id)) { kept.push(entry); continue; }
    const missCount = Math.max(0, Number(entry.missCount) || 0) + 1;
    if (missCount >= 3) continue;
    kept.push({ ...entry, missCount, updatedAt: nowIso() });
  }
  return kept;
}

/** 剥掉清单里的展示性修饰：模型把整行复制回来时还原成备注名 */
function stripDisplayForms(text) {
  const forms = [];
  const push = (value) => { const t = String(value || "").trim(); if (t && !forms.includes(t)) forms.push(t); };
  let out = String(text || "").trim();
  push(out);
  const lead = out.replace(/^[-*•·]\s*/, "");
  if (lead !== out) { push(lead); out = lead; }
  const pairs = [["[", "]"], ["【", "】"], ["（", "）"], ["(", ")"], ["〔", "〕"]];
  for (let guard = 0; guard < 12; guard += 1) {
    let changed = false;
    for (const [open, close] of pairs) {
      if (out.endsWith(close)) {
        const at = out.lastIndexOf(open);
        if (at > 0) { out = out.slice(0, at).trim(); push(out); changed = true; break; }
      }
    }
    if (!changed) break;
  }
  return forms;
}
const normalizeStickerLookup = (value) => String(value ?? "").trim().toLowerCase().replace(/[“”‘’「」『』]/g, '"');

/** 按 id / 备注名 / 标签找一张表情；同级重名就宁缺勿错 */
export function findSticker(entries, ref) {
  const raw = String(ref ?? "").trim();
  if (!raw) return null;
  const md5 = raw.toUpperCase();
  const urlNormalized = raw.replace(/\/+$/, "").replace(/^https?:\/\//i, "");
  const visible = (Array.isArray(entries) ? entries : []).filter((entry) => entry && entry.hidden !== true);
  const direct = visible.find((e) => {
    if (!e) return false;
    if (e.id === raw || e.resId === raw) return true;
    if (e.md5 && e.md5 === md5) return true;
    const eUrl = String(e.url || "").replace(/\/+$/, "").replace(/^https?:\/\//i, "");
    const urlish = /[./]/.test(urlNormalized);
    if (eUrl && urlNormalized && (eUrl === urlNormalized || (urlish && (eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))))) return true;
    return false;
  });
  if (direct) return direct;
  const idInRef = raw.match(/stickerId[：:]\s*([A-Za-z0-9_-]+)/);
  if (idInRef) {
    const byExtractedId = visible.find((e) => e.id === idInRef[1] || e.resId === idInRef[1]);
    if (byExtractedId) return byExtractedId;
  }
  const forms = stripDisplayForms(raw);
  for (const form of forms) {
    const label = normalizeStickerLookup(form);
    const exact = visible.filter((entry) => [entry.localNote, entry.desc].some((value) => normalizeStickerLookup(value) === label));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) continue;
    if (label.length < 2) continue;
    const noteHasQuery = visible.filter((entry) => [entry.localNote, entry.desc].some((value) => {
      const text = normalizeStickerLookup(value);
      return text.length > 0 && text.includes(label);
    }));
    if (noteHasQuery.length === 1) return noteHasQuery[0];
    if (noteHasQuery.length > 1) continue;
    const queryHasNote = visible.filter((entry) => [entry.localNote, entry.desc].some((value) => {
      const text = normalizeStickerLookup(value);
      return text.length >= 2 && label.includes(text);
    }));
    if (queryHasNote.length === 1) return queryHasNote[0];
    if (queryHasNote.length > 1) continue;
    const tagHit = visible.filter((entry) => (Array.isArray(entry.tags) ? entry.tags : []).some((value) => {
      const text = normalizeStickerLookup(value);
      return text.length > 0 && (text.includes(label) || label.includes(text));
    }));
    if (tagHit.length === 1) return tagHit[0];
  }
  return null;
}

/** 列表：query 搜备注/笔记/标签，limit 默认 24，最多 100 */
export function formatStickerList(entries, query = "", limit = 24) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter((entry) => entry && !entry.hidden);
  const q = String(query ?? "").trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(" ").toLowerCase().includes(q))
    : list;
  const max = Math.max(1, Math.min(100, Number(limit) || 24));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    desc: sanitizeUserText(e.desc || ""),
    localNote: sanitizeUserText(e.localNote || ""),
    tags: (e.tags || []).map((t) => sanitizeUserText(t)),
    useCount: e.useCount || 0,
  }));
  return { total: list.length, matched: filtered.length, truncated: filtered.length > max, stickers: items };
}

/** 记笔记 / 改备注 / 加标签 */
export function applyStickerNote(entries, ref, patch = {}) {
  const target = findSticker(entries, ref);
  if (!target) return { entries, entry: null };
  const index = entries.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    desc: patch.desc !== undefined ? String(patch.desc ?? "").replace(/\s+/g, " ").trim().slice(0, 80) : target.desc,
    localNote: patch.note !== undefined ? String(patch.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300) : target.localNote,
    tags: patch.tags !== undefined ? (Array.isArray(patch.tags) ? patch.tags : []) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? "").replace(/\s+/g, " ").trim().slice(0, 300) : target.usage,
    metadataEdited: true,
    updatedAt: nowIso(),
  });
  const out = [...entries];
  out[index] = next;
  return { entries: out, entry: next };
}

export function markStickerUsed(entries, ref, context = "") {
  const target = findSticker(entries, ref);
  if (!target) return { entries, entry: null };
  const index = entries.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context ?? "").slice(0, 200),
    updatedAt: nowIso(),
  });
  const out = [...entries];
  out[index] = next;
  return { entries: out, entry: next };
}

// ── 发言节奏（#134 第三步「像人」那一条）──
// 首条前的停顿照 qq-agent-plus 的 src/onebot/sender.js（leadDelayFor，MIT）：500–1800ms 随机，每个字再加 12ms，最多 8 秒。
// 条与条之间照 AstrBot 的 log 模式：log_2.6(字数+1) 秒，±20% 抖动，夹在 0.6–5 秒。公式是照文档写的，没有搬代码。
/** 首条消息发出前停多久（毫秒） */
export function leadDelayFor(text, rnd = Math.random) {
  const chars = [...String(text || "")].length;
  return Math.min(8000, Math.round(500 + rnd() * 1300 + chars * 12));
}

/** 上一条发完到这一条之间隔多久（毫秒），按上一条的字数算 */
export function gapForChars(chars, rnd = Math.random) {
  const n = Math.max(0, Number(chars) || 0);
  const base = (Math.log2(n + 1) / Math.log2(2.6)) * 1000;
  const jittered = base * (0.8 + rnd() * 0.4);
  return Math.round(Math.min(5000, Math.max(600, jittered)));
}

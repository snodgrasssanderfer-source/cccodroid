// 直播里 12 号的正文就是台词（主人 11-07 定，照 Open-LLM-VTuber / my-neuro / airi 的做法）：
// 边出字边切成小段送平板念，整段说完再作为一条字幕发进群。
//
// 防漏三道（11-07 翻了她干净会话里的正文：几十段全是发完 send_message 以后、隔一个空行写给「你」的汇报，
// 「小克在群里回了两条：……」这种）：
//   1. 只认第一次调工具之前、第一个空行之前的正文（my-neuro 只念工具前那段）
//   2. 尖括号标签、方括号、圆括号、星号里的不念也不发（airi 把标签都算思考；Open-LLM-VTuber 去括号和星号）
//   3. 第一段送出前先攒够几个字查一遍：像汇报就整轮不说；后面的段碰上了就到此为止
// 开头两段碰到逗号就能切（airi 的 boost、Open-LLM-VTuber 的 faster_first_response），第一声早点出来。

export const META_RE = /send_message|send_sticker|不说】|这一轮|上一轮|后台|调用|工具|回了[一两三四五六七八九十\d]+条|群里(已经|回了|回你|说了|也)|小克(在群里|回了|没有?|也|就|这次)|\[画面|画面\]|你决定[:：]/;
const HARD = "。！？!?…～~";
const SOFT = "，、：；,;:";
const OPEN = { "<": ">", "[": "]", "【": "】", "(": ")", "（": "）", "*": "*" };

/** 一段完整的正文去掉不念的部分 */
export function cleanSpeech(text) {
  return String(text || "")
    .replace(/<([A-Za-z_][\w-]*)[^>]*>[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）|\*[^*]*\*/g, "")
    .replace(/[ \t]+/g, " ");
}

/** 末尾还没合上的括号 / 标签从哪开始：这之后的先压着，等合上了再说 */
function openAt(s) {
  let stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const top = stack[stack.length - 1];
    if (top && ch === OPEN[s[top.i]] && !(ch === "*" && top.i === i)) { stack.pop(); continue; }
    if (OPEN[ch] && !(ch === "*" && top && s[top.i] === "*")) stack.push({ i });
  }
  return stack.length ? stack[0].i : -1;
}

const hasWords = (s) => /[^\s\p{P}\p{S}]/u.test(s);

/**
 * onChunk(text)：切好的一段（送去念）；onStop()：念出去以后才发现不对，叫平板停下
 * feed(delta) 喂正文增量；tool() 她开始调工具了；end() → { text, silent, chunks, dropped }
 */
export function createSpeech({ onChunk = () => {}, onStop = () => {}, minFirst = 8, boost = 2, minSoft = 4, maxLen = 24 } = {}) {
  let raw = "", closed = false, silent = false, stopped = false, pos = 0, rest = "";
  const chunks = [];

  function zone() {
    // 第一个空行之后的不算台词
    const s = raw.replace(/^\s+/, "");
    const k = s.search(/\n\s*\n/);
    if (k >= 0) { closed = true; return s.slice(0, k); }
    return s;
  }
  function emit(seg) {
    const t = seg.trim();
    if (!t || !hasWords(t)) return;
    chunks.push(t);
    try { onChunk(t); } catch {}
  }
  function pump(final) {
    if (silent || stopped) return;
    let z = zone();
    if (!final && !closed) { const o = openAt(z); if (o >= 0) z = z.slice(0, o); }
    // 查汇报腔：查原文（括号里的也算，「【不说】」就在括号里）
    if (META_RE.test(z)) {
      if (!chunks.length) silent = true;
      else { stopped = true; try { onStop(); } catch {} }
      return;
    }
    const c = cleanSpeech(z).replace(/\n+/g, "\n");
    if (!chunks.length && !final && !closed && c.replace(/\s/g, "").length < minFirst) return;
    let start = pos, i = pos;
    for (; i < c.length; i++) {
      const ch = c[i], len = i + 1 - start;
      let cut = false;
      const words = c.slice(start, i + 1).replace(/[\s\p{P}\p{S}]/gu, "").length;
      // 太短的一截（「好耶！」）并到下一段，单念两个字听着碎
      if ((HARD.includes(ch) || ch === "\n") && words >= minSoft) cut = true;
      else if (SOFT.includes(ch) && ((chunks.length < boost && len >= minSoft) || len >= maxLen)) cut = true;
      else if (len >= maxLen * 2) cut = true;
      if (!cut) continue;
      // 连着的标点一起带上（「好耶！！」「真的吗？！」）
      while (i + 1 < c.length && (HARD + SOFT).includes(c[i + 1])) i++;
      emit(c.slice(start, i + 1)); start = i + 1;
    }
    pos = start;
    if (final || closed) { emit(c.slice(pos)); pos = c.length; }
  }

  return {
    feed(delta) { raw += String(delta || ""); if (closed || silent || stopped) return; pump(false); },   // 关了也照收：end() 要报后面没念的那段
    tool() { if (!closed) { pump(true); closed = true; } },
    get closed() { return closed; },
    get spoke() { return chunks.length > 0; },
    end() {
      if (!closed) pump(true);
      closed = true;
      const s = raw.replace(/^\s+/, ""), k = s.search(/\n\s*\n/);
      rest = k >= 0 ? s.slice(k) : "";
      return { text: silent ? "" : chunks.join(""), silent, stopped, chunks: [...chunks], dropped: rest.trim() };
    },
  };
}

// bge-small-zh 用的 BERT 分词（WordPiece），照 tokenizer.json 里 BertNormalizer + BertPreTokenizer 的做法：
// 不转小写、不去重音；汉字一个字一段；标点单独成段；再按词表贪心切 ##子词。纯函数，好测。

const isCJK = (c) => (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x20000 && c <= 0x2a6df) ||
  (c >= 0x2a700 && c <= 0x2b73f) || (c >= 0x2b740 && c <= 0x2b81f) || (c >= 0x2b820 && c <= 0x2ceaf) ||
  (c >= 0xf900 && c <= 0xfaff) || (c >= 0x2f800 && c <= 0x2fa1f);
const isPunct = (ch, c) => (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126) || /\p{P}/u.test(ch);
const isWs = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || /\p{Zs}/u.test(ch);
const isCtrl = (ch) => !(ch === "\t" || ch === "\n" || ch === "\r") && /[\p{Cc}\p{Cf}]/u.test(ch);

/** 词表：tokenizer.json 的 model.vocab（词 → 号） */
export function makeTokenizer(vocab, { max = 256 } = {}) {
  const V = vocab instanceof Map ? vocab : new Map(Object.entries(vocab));
  const UNK = V.get("[UNK]"), CLS = V.get("[CLS]"), SEP = V.get("[SEP]");
  function pieces(word) {
    const cs = [...word];
    if (cs.length > 100) return [UNK];
    const out = [];
    let i = 0;
    while (i < cs.length) {
      let j = cs.length, hit = null;
      while (j > i) {
        const s = (i ? "##" : "") + cs.slice(i, j).join("");
        if (V.has(s)) { hit = V.get(s); break; }
        j--;
      }
      if (hit == null) return [UNK];
      out.push(hit); i = j;
    }
    return out;
  }
  function words(text) {
    let s = "";
    for (const ch of String(text || "")) {
      const c = ch.codePointAt(0);
      if (c === 0 || c === 0xfffd || isCtrl(ch)) continue;
      if (isWs(ch)) s += " ";
      else if (isCJK(c) || isPunct(ch, c)) s += " " + ch + " ";
      else s += ch;
    }
    return s.split(" ").filter(Boolean);
  }
  /** 一句话 → [CLS] … [SEP] 的号，太长截掉尾巴 */
  return function encode(text) {
    const ids = [CLS];
    for (const w of words(text)) { for (const id of pieces(w)) { if (ids.length >= max - 1) break; ids.push(id); } if (ids.length >= max - 1) break; }
    ids.push(SEP);
    return ids;
  };
}

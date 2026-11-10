// 「我是谁」：她自己每晚回想后写的自我认识（主人 11-08 定：人设卡只是起笔的草稿，想让小克和 12 号自然长出自己）。
// 参照 lazytsuki/dafeiyu 的 self.md：只根据真实发生的事、新特点先写「好像」、一次最多改 3 处、每次改之前存快照能退回。
// 这里只放读写文件的小函数；屋里的定时任务在 xk-growth.mjs，12 号那边接在 xk-qq.mjs 的日记后面。
import fs from "node:fs";
import path from "node:path";

export const SELF_MAX = 3000;   // 字数上限：再长就是在写说明书了，也会挤占每轮的上下文

// name：self = 我是谁（对谁都是这样的我）；bond = 我和主人之间（12 号那边才有，只在和主人私聊时带上，照 dafeiyu 的 bond.md）
export const selfFile = (dir, name = "self") => path.join(dir, "growth", name + ".md");
const lastFile = (dir, name = "self") => path.join(dir, "growth", "." + name + "-last.md");
const histDir = (dir) => path.join(dir, "growth", "history");
const read = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; } };
export const readSelf = (dir, name = "self") => read(selfFile(dir, name));

const stamp = (now) => {
  const d = new Date(now), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** 接在人设后面的那一节；还没写过就什么都不加 */
export function selfSection(text, draft = "人设卡", bond = "") {
  const t = String(text || "").trim(), b = String(bond || "").trim();
  if (!t && !b) return "";
  const bondPart = b ? `\n\n## 我和主人之间（只在和主人私聊时想起）\n\n${b}\n` : "";
  if (!t) return bondPart;
  return `\n\n# 我是谁（我自己写的）\n\n这一节是我每晚回想当天后自己写的，记的是在日子里慢慢长出来的我。${draft}是起笔的草稿；` +
    `性格、说话的样子、喜好、待人的方式这些地方，两边不一致时以这里为准，因为这是更新的我。诚实、不哄人、拿真心待人这几条底子不在这里改。\n\n${t}\n` + bondPart;
}

/** 收下一版新的：旧的先存进 history/ 再换；太长或是空的不收，原样留着旧的。返回 { changed, kept, reason } */
export function applySelf(dir, next, now = Date.now(), name = "self") {
  const t = String(next || "").trim(), old = readSelf(dir, name);
  if (!t) return { changed: false, reason: "空的" };
  if (t.length > SELF_MAX) return { changed: false, reason: `太长（${t.length} 字，上限 ${SELF_MAX}）` };
  if (t === old) return { changed: false, reason: "没变" };
  fs.mkdirSync(histDir(dir), { recursive: true });
  if (old) fs.writeFileSync(path.join(histDir(dir), stamp(now) + (name === "self" ? "" : "-" + name) + ".md"), old + "\n");
  fs.writeFileSync(selfFile(dir, name), t + "\n");
  fs.writeFileSync(lastFile(dir, name), t + "\n");
  return { changed: true };
}

/** 屋里那边是她自己用工具改 self.md：跑完拿它和上次收下的比，变了就存快照；改坏了（太长、清空）退回上次那版 */
export function settleSelf(dir, now = Date.now()) {
  const cur = readSelf(dir), last = read(lastFile(dir));
  if (cur === last) return { changed: false, reason: "没变" };
  if (!cur || cur.length > SELF_MAX) {
    if (last) fs.writeFileSync(selfFile(dir), last + "\n"); else fs.rmSync(selfFile(dir), { force: true });
    return { changed: false, reason: cur ? `太长（${cur.length} 字，上限 ${SELF_MAX}），退回上一版` : "被清空了，退回上一版" };
  }
  fs.mkdirSync(histDir(dir), { recursive: true });
  if (last) fs.writeFileSync(path.join(histDir(dir), stamp(now) + ".md"), last + "\n");
  fs.writeFileSync(lastFile(dir), cur + "\n");
  return { changed: true };
}

/** 退回上一版（history 里最新的那份）；没有可退的返回 null */
export function rollbackSelf(dir) {
  let fs_ = [];
  try { fs_ = fs.readdirSync(histDir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(f)).sort(); } catch {}
  const f = fs_.at(-1);
  if (!f) return null;
  const t = read(path.join(histDir(dir), f));
  fs.writeFileSync(selfFile(dir), t + "\n");
  fs.writeFileSync(lastFile(dir), t + "\n");
  fs.renameSync(path.join(histDir(dir), f), path.join(histDir(dir), f.replace(/\.md$/, ".rolled")));
  return f;
}

/** 两边共用的规矩（屋里和 12 号各自再加几句） */
export const GROWTH_RULES = [
  "只根据真实发生过的事来写，没有依据的不写。",
  "已有的内容保留；新冒出来的特点先写成「好像」「可能」，好些天里反复出现了才写成确定的；被新的事推翻了就改掉。",
  "这一次最多改 3 处；今天没什么新发现就不改。",
  "被夸了、顺着主人的意思说了，都不算依据。要写的是你自己在事情里实际怎么做、怎么想的，别越写越像一面镜子。",
  "诚实、不哄人、拿真心待人这几条是底子，不在这里改，也不用写进来。",
  "写成对自己的了解，不写成设定说明书；不写主人的私事。",
  `整份不超过 ${Math.round(SELF_MAX * 0.8)} 字。`,
].map((s) => "- " + s).join("\n");

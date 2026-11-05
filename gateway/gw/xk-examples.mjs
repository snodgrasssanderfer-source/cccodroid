// 人设的示例池：persona/examples.txt，一行一段（# 开头和空行不算）。池子里放的是真人的原话（B站评论区一来一回，「甲：… / 乙：…」），不放我们自己写的句子。
// 每轮随机抽两段贴在 post_history 后面，只学接话的结构，不学内容；池子大、每轮轮换，是为了不让固定的几段被照抄（#121 / #122 第一步）。
import fs from "node:fs";
import path from "node:path";

export const examplesFile = (dir) => path.join(dir, "persona", "examples.txt");

/** 从角色目录的示例池里随机抽 n 句，拼成一段；没有池子或池子是空的就返回 "" */
export function examplesText(dir, n = 2) {
  let lines;
  try { lines = fs.readFileSync(examplesFile(dir), "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#")); }
  catch { return ""; }
  if (!lines.length) return "";
  const pick = [];
  const pool = [...lines];
  while (pick.length < n && pool.length) pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return "（下面是网上真人在评论区一来一回的原话，只看人家怎么接话：多长、带不带标点、怎么起头。内容和梗别学，也别提起这几句：\n" + pick.join("\n") + "）";
}

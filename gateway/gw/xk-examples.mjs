// 人设的示例池：persona/examples.txt，一行一句（# 开头和空行不算）。
// 每轮随机抽一两句贴在 post_history 后面，只给“这种感觉”，不当模板；轮换是为了不让固定的几句被照抄（#121 / #122 第一步）。
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
  return "（你平时说话大概是这种感觉，只看口气，别照抄句子：\n" + pick.join("\n") + "）";
}

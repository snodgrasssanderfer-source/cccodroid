// 从 Claude Code 的会话记录里取出「谁说了什么」：接班摘要、日记素材、空闲整理都用它。
import fs from "node:fs";
import { findSessionFile } from "./sessions.mjs";

/** 一条消息里给人看的文字：跳过工具结果和 <system-reminder> 这类附加段 */
function textOf(content) {
  if (typeof content === "string") return content.startsWith("<") ? "" : content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && c.type === "text" && c.text && !c.text.startsWith("<")).map((c) => c.text).join("\n");
}

/** 会话里的问答，按时间顺序：[{ role: "user" | "assistant", text, at }]。since：只要这个时刻（毫秒）之后的 */
export function turns(sessionId, since = 0) {
  const f = sessionId && findSessionFile(String(sessionId));
  if (!f) return [];
  const out = [];
  for (const line of fs.readFileSync(f.file, "utf8").split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }   // 进程被杀时最后一行可能只写了一半
    if ((e.type !== "user" && e.type !== "assistant") || e.isMeta || e.isCompactSummary || e.isSidechain) continue;
    if (e.message?.model === "<synthetic>") continue;   // 接口出错时 Claude Code 自己写的报错，不是她说的话
    const at = Date.parse(e.timestamp) || 0;
    if (at < since) continue;
    const text = textOf(e.message && e.message.content).trim();
    if (!text) continue;
    const last = out[out.length - 1];
    // 一次回复会被拆成好几条 assistant 记录（中间夹着工具调用），合成一段
    if (last && last.role === e.type && e.type === "assistant") last.text += "\n" + text;
    else out.push({ role: e.type, text, at });
  }
  return out;
}

/** 最近 n 轮（一问一答算一轮）的纯文本，给接班的角色看 */
export function recentText(sessionId, n, names = {}) {
  const all = turns(sessionId);
  let users = 0, i = all.length;
  while (i > 0 && users < n) if (all[--i].role === "user") users++;
  return all.slice(i).map((t) => `${t.role === "user" ? names.user || "主人" : names.assistant || "她"}：${t.text.length > 600 ? t.text.slice(0, 600) + "…" : t.text}`).join("\n");
}

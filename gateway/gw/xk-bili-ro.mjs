// 只读的 B站中转（主人 11-07 定：聊天模式的 12 号卡可以自己逛 B站，但只能看，不能写）。
// 夹在干净会话和真正的 bilibili-mcp-server 之间：
//   - tools/list 只露出 READ_ONLY 里的几样；发评论、点赞、弹幕、关注、删评论、下载、看主人自己的收藏和通知一概不露
//   - tools/call 不在名单里的直接拒，不转给下游
//   - 返回的文字按工具截长度，图一律丢掉：字幕、评论动辄几千字，进了上下文既占额度又把人设卡挤淡
// 不在中间找模型总结：那样别人的口气又进来了。
// 下游怎么起由网关从全局配置里抄来，经 env BILI_RO_TARGET（JSON：command/args/env）传进来。
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

/** 能看的：搜、热门、视频信息、字幕、评论、弹幕、UP 主信息和投稿 */
export const READ_ONLY = [
  "bilibili_search", "bilibili_search_hot", "bilibili_hot",
  "bilibili_video_info", "bilibili_video_subtitle", "bilibili_video_comments", "bilibili_video_danmaku",
  "bilibili_user_info", "bilibili_user_videos",
];
/** 每样最多给多少字（截掉的地方写明截了） */
export const LIMITS = { bilibili_video_subtitle: 2000, bilibili_video_comments: 3000, bilibili_video_danmaku: 1500 };
export const DEFAULT_LIMIT = 2500;

/** 一次调用的结果：只留文字，按上限截 */
export function trimResult(name, result) {
  const cap = LIMITS[name] ?? DEFAULT_LIMIT;
  const texts = (Array.isArray(result?.content) ? result.content : []).filter((b) => b?.type === "text").map((b) => String(b.text ?? ""));
  let text = texts.join("\n");
  if (text.length > cap) text = text.slice(0, cap) + `\n…（后面还有 ${text.length - cap} 字，截掉了）`;
  if (!text) text = "（没拿到文字内容）";
  return { content: [{ type: "text", text }], ...(result?.isError ? { isError: true } : {}) };
}

export function serve(target = JSON.parse(process.env.BILI_RO_TARGET || "null")) {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  if (!target?.command) {
    // 下游没配：照样能起，只是什么工具都没有
    readline.createInterface({ input: process.stdin }).on("line", (l) => {
      let m; try { m = JSON.parse(l); } catch { return; }
      if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bili-ro", version: "1" } } });
      else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
      else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "B站没接上" } });
    });
    return;
  }
  const child = spawn(target.command, target.args || [], { env: { ...process.env, ...(target.env || {}) }, stdio: ["pipe", "pipe", "inherit"] });
  const lists = new Set(), calls = new Map();
  readline.createInterface({ input: process.stdin }).on("line", (l) => {
    if (!l.trim()) return;
    let m; try { m = JSON.parse(l); } catch { return; }
    if (m.method === "tools/list") lists.add(m.id);
    if (m.method === "tools/call") {
      const name = m.params?.name;
      if (!READ_ONLY.includes(name)) return out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "这个只能看，不能做：" + name }], isError: true } });
      calls.set(m.id, name);
    }
    child.stdin.write(JSON.stringify(m) + "\n");
  });
  process.stdin.on("end", () => child.stdin.end());
  readline.createInterface({ input: child.stdout }).on("line", (l) => {
    let m; try { m = JSON.parse(l); } catch { return; }
    if (m.id !== undefined && lists.has(m.id) && m.result) {
      lists.delete(m.id);
      m.result.tools = (m.result.tools || []).filter((t) => READ_ONLY.includes(t.name));
    } else if (m.id !== undefined && calls.has(m.id)) {
      const name = calls.get(m.id); calls.delete(m.id);
      if (m.result) m.result = trimResult(name, m.result);
    }
    out(m);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(HERE, "xk-bili-ro.mjs")) serve();

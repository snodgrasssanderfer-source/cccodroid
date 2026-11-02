// 三个角色：每个是工作区 roles/ 下的一个上游项目。人设走项目 agent（整体换掉模型自带的系统提示），
// 世界书是 roles/CLAUDE.md（Claude Code 会读上级目录的 CLAUDE.md，三个角色都看得到），
// post_history、记忆、接班说明由 xk-hook.mjs 每轮注入。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CFG } from "./config.mjs";
import { findSessionFile, peekSession } from "./sessions.mjs";

export const ROLES_DIR = path.join(CFG.workspace, "roles");
export const ROLES = [
  { id: "xiaoke", name: "小克", provider: "anthropic", engine: "claude" },   // 主人的 Claude 订阅（上游的「Claude 账户登录」）
  { id: "hachimi", name: "哈基米", provider: null, engine: "agy" },           // Gemini，经 Antigravity CLI（xk-agy.mjs）
  { id: "deepseek", name: "DeepSeek", provider: "deepseek", engine: "claude" },
];
export const roleById = (id) => ROLES.find((r) => r.id === id) || null;
export const roleDir = (id) => path.join(ROLES_DIR, id);
export const WORLDBOOK = path.join(ROLES_DIR, "CLAUDE.md");

const HOOK = fileURLToPath(new URL("./xk-hook.mjs", import.meta.url));
const MEM_MCP = fileURLToPath(new URL("./xk-memory-mcp.mjs", import.meta.url));
const q = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";

// 两边都按真实路径比：安卓上会话记录的 cwd 是 /data/data/cc.codroid/…，CCAPP_WORKSPACE 却是 /data/user/0/cc.codroid/…（同一处的两个名字），
// 只比字符串时真机上每段会话都认不出是谁的（11-01 在 v0.2.2 上实测）
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
/** 目录属于哪个角色（就是 roles/<id> 或它下面） */
export function roleOfDir(dir) {
  if (!dir) return null;
  const rel = path.relative(real(ROLES_DIR), real(dir));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return roleById(rel.split(path.sep)[0]);
}
/** 上游 run.mjs 用：角色项目里不再追加开发工具说明（13 KB 的 TOOLS.md 等），人设才不被冲淡 */
export const inXkRole = (cwd) => !!roleOfDir(cwd);
export function roleOfSession(sid) {
  const f = sid && findSessionFile(String(sid));
  return f ? roleOfDir(peekSession(f.file).cwd) : null;
}

const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", s); fs.renameSync(f + ".tmp", f); };
const agentFile = (id) => path.join(roleDir(id), ".claude", "agents", id + ".md");
export const postHistoryFile = (id) => path.join(roleDir(id), "persona", "post_history.md");

// 角色目录里的机制说明（不是人设，入库无妨）：每次启动重写，人设和记忆不在这里
const MECHANICS = `# 怎么用你的记忆、日记和留言板

- 你有一套只属于你的长期记忆（工具 remember / recall / forget）。主人告诉你的事实、发生的事、计划、你自己的看法，觉得以后用得上就当场 remember。
- 记的时候把"昨天""下周"换成具体日期（今天的日期在环境信息里）。事情变了就用 remember 记新的，并在 ends 里填旧记忆的 id，旧的会标成"已过去"留着。
- 每条消息前会自动附上几条可能相关的记忆，不全；主人问到具体的事而那里没有，先 recall 换个说法查，查不到就说没印象，不编。
- 提起旧事时说清大概是哪天、当时谁怎么说（"你上周三说……""我当时觉得……"）；已过去的事用过去的说法。
- diary/ 里是你写的日记，inputs/ 是每天的素材，主人想看可以读。
- 留言板是三个人和主人共用的（工具 board_write / board_read）。主人交代的事做到一半、你要下班（主人换人、你额度快用完）时，用 board_write 给接班的人留张便条：交代了什么、办到哪、还差什么，结论放前面；不抄你的私人记忆。你下班时要是还没留，系统会再提醒你一次。
- 别人留给你的新便条会在消息前自动附上一次；之后想再看用 board_read。事情办到哪以便条和主人说的为准，拿不准就问主人，别凭对话片段猜。
`;

/** 启动时把三个角色的目录、项目设置、hook、记忆服务都摆好。人设和世界书只在没有时放空模板，不覆盖主人导入的 */
export function ensureRoles() {
  if (!fs.existsSync(WORLDBOOK)) write(WORLDBOOK, "# 世界书\n\n（还没导入。在「小克 → 角色」里导入。）\n");
  for (const r of ROLES) {
    const d = roleDir(r.id);
    fs.mkdirSync(path.join(d, "memory"), { recursive: true });
    if (!fs.existsSync(agentFile(r.id))) write(agentFile(r.id), agentText(r, "（人设还没导入。在「小克 → 角色」里导入。）", ""));
    const hook = (ev) => [{ hooks: [{ type: "command", command: `${q(process.execPath)} ${q(HOOK)} ${ev} ${q(d)}`, timeout: 20 }] }];
    write(path.join(d, ".claude", "settings.json"), JSON.stringify({
      agent: r.id,
      enableAllProjectMcpServers: true,
      hooks: { SessionStart: hook("start"), UserPromptSubmit: hook("prompt") },
    }, null, 1) + "\n");
    // alwaysLoad：不然记忆工具被收进 ToolSearch，每次想起旧事都要多一个来回
    write(path.join(d, ".mcp.json"), JSON.stringify({ mcpServers: { "xk-memory": { type: "stdio", command: process.execPath, args: [MEM_MCP, d], alwaysLoad: true } } }, null, 1) + "\n");
    write(path.join(d, "CLAUDE.md"), MECHANICS);
  }
}

function agentText(r, systemPrompt, mesExample) {
  return `---\nname: ${r.id}\ndescription: ${r.name}\n---\n${systemPrompt.trim()}\n` + (mesExample.trim() ? `\n# 对话示例\n\n${mesExample.trim()}\n` : "");
}

/** 主人的人设 .txt：【一】system_prompt / 【二】post_history_instructions / 【三】mes_example 三段；没有这些标记就整篇当 system_prompt */
export function parsePersona(text) {
  const marks = [...String(text).matchAll(/^[ \t]*【[^】\n]*】[ \t]*(system_prompt|post_history_instructions|mes_example)[ \t]*$/gm)];
  const clean = (s) => s.replace(/^\s*-{3,}\s*$/gm, "").trim();
  if (!marks.length) return { system_prompt: clean(String(text)), post_history_instructions: "", mes_example: "" };
  const out = { system_prompt: "", post_history_instructions: "", mes_example: "" };
  marks.forEach((m, i) => { out[m[1]] = clean(text.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : text.length)); });
  return out;
}

export function importPersona(id, text) {
  const r = roleById(id);
  if (!r) throw Object.assign(new Error("没有这个角色：" + id), { status: 404 });
  const p = parsePersona(text);
  if (!p.system_prompt) throw Object.assign(new Error("没读到 system_prompt：文件是空的，或者标记写法不对（要「【一】system_prompt」这样单独一行）"), { status: 400 });
  write(agentFile(id), agentText(r, p.system_prompt, p.mes_example));
  if (p.post_history_instructions) write(postHistoryFile(id), p.post_history_instructions + "\n");
  else fs.rmSync(postHistoryFile(id), { force: true });
  return personaStatus(id);
}

export function personaStatus(id) {
  const a = fs.existsSync(agentFile(id)) ? fs.readFileSync(agentFile(id), "utf8") : "";
  const ph = fs.existsSync(postHistoryFile(id)) ? fs.readFileSync(postHistoryFile(id), "utf8") : "";
  const imported = a && !a.includes("（人设还没导入");
  return { imported, personaChars: imported ? a.replace(/^---[\s\S]*?---\n/, "").length : 0, postHistoryChars: ph.trim().length };
}

/** 一份世界书文件转成 Markdown：纯文本 / Markdown 原样；SillyTavern 世界书 JSON（entries）转成一节一节的 */
function worldbookMd(text) {
  let md = String(text);
  try {
    const j = JSON.parse(md);
    const entries = j.entries || j.character_book?.entries || j.data?.character_book?.entries;
    if (entries) {
      const list = Array.isArray(entries) ? entries : Object.values(entries);
      md = list.filter((e) => e && e.content && e.enabled !== false && !e.disable)
        .map((e) => `## ${e.comment || e.name || [].concat(e.keys || e.key || []).join("、") || "条目"}\n\n${String(e.content).trim()}\n`).join("\n");
    }
  } catch { /* 不是 JSON：按文本用 */ }
  return md.trim();
}
/** 世界书：一份文本，或好几个文件 [{ name, text }]（按给的顺序拼成一份，整份替换旧的） */
export function importWorldbook(input) {
  const parts = (Array.isArray(input) ? input : [{ text: input }]).map((f) => worldbookMd(f && f.text != null ? f.text : f)).filter(Boolean);
  if (!parts.length) throw Object.assign(new Error("世界书是空的"), { status: 400 });
  const md = parts.length === 1 && /^#\s/.test(parts[0]) ? parts[0] : (/^#\s/.test(parts[0]) ? "" : "# 世界书\n\n") + parts.join("\n\n");
  write(WORLDBOOK, md.trim() + "\n");
  return { chars: md.trim().length, files: parts.length };
}

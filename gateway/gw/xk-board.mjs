// 留言板（#7，主人 11-02 定的）：三人共用，主人也能看能贴。替班的人下班前留一张便条：主人交代了什么、办到哪、还差什么。
// 只传便条，不碰谁的私人记忆。放在 roles/.board/：点开头，不会被当成哪个角色的目录。
// hook、记忆工具（各自一个进程）和网关都会读写，所以一张便条一个文件、各人的已读各一个文件，不抢同一个文件。
// 这个文件只用 fs / path，hook 和工具进程也能直接 import。
import fs from "node:fs";
import path from "node:path";

export const WHO = { xiaoke: "小克", hachimi: "哈基米", deepseek: "小鱼", owner: "主人" };
const BY_NAME = Object.fromEntries(Object.entries(WHO).map(([id, n]) => [n, id]));
/** 「小鱼」「deepseek」都认；空、「大家」「所有人」是给三个人的（null） */
export function toId(x) {
  const s = String(x ?? "").trim();
  if (!s || /^(大家|所有人|全部|all|everyone)$/i.test(s)) return null;
  const id = WHO[s] ? s : BY_NAME[s];
  if (!id || id === "owner") throw new Error(`不认识「${s}」：写小克、哈基米、小鱼，或者不填（给大家）`);
  return id;
}

const dirOf = (rolesDir) => path.join(rolesDir, ".board");
const readOf = (rolesDir, role) => path.join(dirOf(rolesDir), "read-" + role + ".json");
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (e.code === "ENOENT") return d; throw new Error(`读不了 ${f}：${e.message}`); } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(o)); fs.renameSync(f + ".tmp", f); };

/** 全部便条，新的在前；每张带上谁读过了 */
export function list(rolesDir) {
  const d = dirOf(rolesDir);
  let names = []; try { names = fs.readdirSync(d).filter((f) => f.startsWith("n-") && f.endsWith(".json")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const read = Object.fromEntries(Object.keys(WHO).filter((r) => r !== "owner").map((r) => [r, new Set(readJson(readOf(rolesDir, r), []))]));
  return names.map((f) => readJson(path.join(d, f), null)).filter(Boolean)
    .map((n) => ({ ...n, readBy: Object.keys(read).filter((r) => read[r].has(n.id)) }))
    .sort((a, b) => b.at - a.at);
}

/** 贴一张：from 是角色号或 owner；to 是角色号或 null（给大家）；auto 表示网关从对话里摘的（她额度用完、自己写不了） */
export function post(rolesDir, { from, to = null, text, auto = false, at = Date.now() }) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("便条是空的");
  if (!WHO[from]) throw new Error("不认识的留言人：" + from);
  if (to !== null && (!WHO[to] || to === "owner")) throw new Error("不认识的收件人：" + to);
  const id = at.toString(36) + Math.random().toString(36).slice(2, 6);
  const n = { id, from, to, text: t, at, ...(auto ? { auto: true } : {}) };
  writeJson(path.join(dirOf(rolesDir), `n-${id}.json`), n);
  return n;
}

export function remove(rolesDir, id) {
  if (!/^[a-z0-9]+$/.test(String(id))) throw new Error("便条号不对：" + id);
  const f = path.join(dirOf(rolesDir), `n-${id}.json`);
  if (!fs.existsSync(f)) throw new Error("没有这张便条：" + id);
  fs.rmSync(f);
}

/** 给 role 的、别人留的、她还没读过的（新的在前，最多 n 张）；读出来就记成已读 */
export function takeUnread(rolesDir, role, n = 5) {
  const all = list(rolesDir).filter((x) => x.from !== role && (x.to === null || x.to === role) && !x.readBy.includes(role));
  if (!all.length) return [];
  const f = readOf(rolesDir, role), seen = readJson(f, []);
  const live = new Set(list(rolesDir).map((x) => x.id));
  writeJson(f, [...seen.filter((id) => live.has(id)), ...all.map((x) => x.id)]);   // 删掉的便条顺手从已读里清掉
  return all.slice(0, n);
}

const when = (t) => new Date(t).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
export const noteLine = (n) => `- ${WHO[n.from]}${n.auto ? "（她额度用完时网关从对话里摘的）" : ""}留给${n.to ? WHO[n.to] : "大家"}，${when(n.at)}：${n.text}`;

// 网关自己起的轮次（整理记忆、写日记、空闲压缩）不该把便条「读掉」：开跑时网关在这里放个记号，hook 看到就不带
export const quietFile = (rolesDir, runId) => path.join(dirOf(rolesDir), "quiet", String(runId));

/** 每轮注入用：没有就返回空串；runId 是网关自己起的轮次也返回空串 */
export function unreadText(rolesDir, role, runId) {
  if (runId && fs.existsSync(quietFile(rolesDir, runId))) return "";
  const ns = takeUnread(rolesDir, role);
  return ns.length ? "留言板上有给你的新便条（别人留的，不是你的记忆；事情办到哪以便条和主人说的为准，拿不准就问主人）：\n" + ns.map(noteLine).join("\n") : "";
}

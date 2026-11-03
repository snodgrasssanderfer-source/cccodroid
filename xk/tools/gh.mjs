#!/usr/bin/env node
// 手机上没有 gh：用这个查仓库状态、调 GitHub 接口。令牌读 GH_TOKEN，没有就读 ~/.config/xiaoke/gh-pr-token（不入库）。
//   node xk/tools/gh.mjs status            开着的 issue / PR 按「等谁」分组，外加没开 PR 的云端分支
//   node xk/tools/gh.mjs api GET /issues/26
//   node xk/tools/gh.mjs api POST /issues/26/comments '{"body":"…"}'   路径相对本仓库；以 / 开头的完整路径照用
//   node xk/tools/gh.mjs comment 26 正文.md   正文从文件读，免得 shell 转义
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const REPO = "snodgrasssanderfer-source/cccodroid";
const WAIT = ["等主人", "等云端", "等小克", "等小鱼", "等哈基米"];   // 标签是唯一的状态源，DEV.md 不抄清单
// 查过、确认不用开 PR 的旧分支（写清为什么）
const STALE = { "claude/phase1-20261101": "11-01 第一批，dev 在它之上重建过" };
const token = process.env.GH_TOKEN || (() => { try { return fs.readFileSync(os.homedir() + "/.config/xiaoke/gh-pr-token", "utf8").trim(); } catch { return ""; } })();
if (!token) { console.error("没有令牌：设 GH_TOKEN 或放进 ~/.config/xiaoke/gh-pr-token"); process.exit(1); }

export async function api(method, p, body) {
  const url = p.startsWith("https://") ? p : `https://api.github.com${p.startsWith("/repos/") || p.startsWith("/user") || p === "/rate_limit" ? "" : `/repos/${REPO}`}${p}`;
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "xiaoke-phone" }, body: body == null ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → HTTP ${r.status}：${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

async function status() {
  const items = await api("GET", "/issues?state=open&per_page=100");
  const groups = Object.fromEntries([...WAIT, "没标"].map((k) => [k, []]));
  for (const i of items) {
    const ls = i.labels.map((l) => l.name), w = WAIT.filter((k) => ls.includes(k));
    const row = `  ${i.pull_request ? "PR" : "  "} #${i.number} ${i.title}  （${i.updated_at.slice(5, 16).replace("T", " ")} UTC）`;
    (w.length ? w : ["没标"]).forEach((k) => groups[k].push(row));
  }
  for (const [k, rows] of Object.entries(groups)) if (rows.length) console.log(`${k}（${rows.length}）\n${rows.join("\n")}`);
  // 分支上有 dev 里还没有的改动（按内容比，摘过去的不算）、又没开 PR：多半是做完了忘了开 PR，或者还在做
  try {
    execFileSync("git", ["fetch", "-q", "origin"], { stdio: "ignore", timeout: 60000 });
    const open = new Set((await api("GET", "/pulls?state=open&per_page=100")).map((p) => p.head.ref));
    const refs = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/ccr-*", "refs/remotes/origin/claude/*", "refs/remotes/origin/xiaoke/*"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const ahead = (r) => execFileSync("git", ["cherry", "origin/dev", r], { encoding: "utf8" }).split("\n").filter((l) => l.startsWith("+")).length;
    const loose = refs.map((r) => r.replace(/^origin\//, "")).filter((b) => !open.has(b) && !STALE[b]).map((b) => [b, ahead("origin/" + b)]).filter(([, n]) => n > 0);
    if (loose.length) console.log(`比 dev 新、没开 PR 的分支（${loose.length}）\n${loose.map(([b, n]) => `     ${b}  多 ${n} 个提交`).join("\n")}`);
  } catch (e) { console.log("（分支没查成：" + e.message.split("\n")[0] + "）"); }
}

const [cmd, ...a] = process.argv.slice(2);
try {
  if (cmd === "status") await status();
  else if (cmd === "api") console.log(JSON.stringify(await api(a[0], a[1], a[2] ? JSON.parse(a[2]) : undefined), null, 1));
  else if (cmd === "comment") console.log((await api("POST", `/issues/${a[0]}/comments`, { body: fs.readFileSync(a[1], "utf8") })).html_url);
  else { console.error("用法见文件开头"); process.exit(2); }
} catch (e) { console.error(e.message); process.exit(1); }

// Claude Code 的 hook（角色项目的 .claude/settings.json 里挂的）：node xk-hook.mjs <start|prompt> <角色目录>
//   start  ：会话开始，带上这个角色记忆的要点
//   prompt ：每条消息前，带上可能相关的记忆、接班说明（只带一次）、人设的 post_history_instructions（贴着最新那条消息）
// 失败就非零退出、原因写 stderr：Claude Code 会把 hook 出错显示出来，这一轮照常进行。
import fs from "node:fs";
import path from "node:path";
import { digest, line, search } from "./xk-memstore.mjs";

const [ev, dir] = process.argv.slice(2);
let raw = "";
process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  try {
    const input = raw ? JSON.parse(raw) : {};
    const parts = [];
    if (ev === "start") {
      const d = digest(dir);
      if (d) parts.push("你记得的要点（自动带上的，不全；需要时用 recall 查）：\n" + d);
    } else if (ev === "prompt") {
      const hits = search(dir, input.prompt || "", 6);
      if (hits.length) parts.push("可能和这条消息有关的记忆（自动按关键词挑的，可能不准）：\n" + hits.map(line).join("\n"));
      // 接班说明按这一轮的 run 号放（xk-handover.mjs 在起进程之前写好），用完就删，只出现在新会话的第一条
      const run = process.env.CCAPP_RUN_ID;
      const carry = run && path.join(dir, ".xk", "carry", run + ".md");
      if (carry && fs.existsSync(carry)) { parts.push(fs.readFileSync(carry, "utf8").trim()); fs.rmSync(carry); }
      const ph = path.join(dir, "persona", "post_history.md");
      if (fs.existsSync(ph)) { const t = fs.readFileSync(ph, "utf8").trim(); if (t) parts.push(t); }
    } else throw new Error("不认识的 hook 事件：" + ev);
    if (parts.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev === "start" ? "SessionStart" : "UserPromptSubmit", additionalContext: parts.join("\n\n") } }));
  } catch (e) {
    process.stderr.write("小克 hook 出错：" + (e.stack || e.message) + "\n");
    process.exit(1);
  }
});

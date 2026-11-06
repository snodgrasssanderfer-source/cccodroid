// Claude Code 的 hook（角色项目的 .claude/settings.json 里挂的）：node xk-hook.mjs <start|prompt> <角色目录>
//   start  ：会话开始，带上这个角色记忆的要点
//   prompt ：每条消息前，带上可能相关的记忆、接班说明（只带一次）、留言板上给她的新便条、人设的 post_history_instructions（贴着最新那条消息）
// 失败就非零退出、原因写 stderr：Claude Code 会把 hook 出错显示出来，这一轮照常进行。
import fs from "node:fs";
import path from "node:path";
import { digest, line, search } from "./xk-memstore.mjs";
import { unreadText } from "./xk-board.mjs";

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
      // 接班 / 交回说明按这一轮的 run 号放（xk-handover.mjs 在起进程之前写好），用完就删，只出现在接手后的第一条
      const run = process.env.CCAPP_RUN_ID;
      const carry = run && path.join(dir, ".xk", "carry", run + ".md");
      if (carry && fs.existsSync(carry)) { parts.push(fs.readFileSync(carry, "utf8").trim()); fs.rmSync(carry); }
      // 上下文过线了（#79）：网关在上一轮结束时写的那句话，递一次就删；留个记号，网关这轮结束来收她的选择。
      // 只在原来那段会话里递：网关自己起的整理、日记轮次在别的会话，不能把话吃掉
      const ask = path.join(dir, ".xk", "ask.json");
      try {
        const a = fs.existsSync(ask) ? JSON.parse(fs.readFileSync(ask, "utf8")) : null;
        if (a && a.text && (!a.sid || !input.session_id || String(a.sid) === String(input.session_id))) {
          parts.push(a.text);
          fs.writeFileSync(path.join(dir, ".xk", "asked.json"), JSON.stringify({ sid: String(input.session_id || a.sid || "") }));
          fs.rmSync(ask);
        }
      } catch {}
      // 留言板上给她的新便条：读一次就记成已读，之后想再看用 board_read
      const board = unreadText(path.dirname(dir), path.basename(dir), run);
      if (board) parts.push(board);
      // 这一轮实际用的模型：人设里写着「系统写了就照实说」，这里就是系统写的那句（run.mjs 起 claude 时设的环境变量）
      const model = process.env.ANTHROPIC_MODEL, prov = process.env.CCAPP_PROVIDER;
      if (model) parts.push(`（系统：你这一轮用的模型是 ${model}${prov ? "，接口 " + prov : ""}。主人问起就照这个答。）`);
      // 重说（xk-recast.mjs）：上一轮最后那段主人看到的是重说过的，告诉她一次，免得她照着自己的原话往下接
      try {
        const sid = String(input.session_id || ""), recs = fs.readFileSync(path.join(dir, ".xk", "recast.jsonl"), "utf8").trim().split("\n");
        const last = sid && recs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.sid === sid).pop();
        const seenF = path.join(dir, ".xk", "recast-seen.json"), seen = fs.existsSync(seenF) ? JSON.parse(fs.readFileSync(seenF, "utf8")) : {};
        if (last && seen[sid] !== last.uuid) {
          parts.push(`（系统：你上一轮最后那段，主人实际看到的是重说过的这句，接着聊时以它为准：\n${last.text}）`);
          seen[sid] = last.uuid; fs.writeFileSync(seenF, JSON.stringify(seen));
        }
      } catch {}
      const ph = path.join(dir, "persona", "post_history.md");
      if (fs.existsSync(ph)) { const t = fs.readFileSync(ph, "utf8").trim(); if (t) parts.push(t); }
    } else throw new Error("不认识的 hook 事件：" + ev);
    if (parts.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev === "start" ? "SessionStart" : "UserPromptSubmit", additionalContext: parts.join("\n\n") } }));
  } catch (e) {
    process.stderr.write("小克 hook 出错：" + (e.stack || e.message) + "\n");
    process.exit(1);
  }
});

// 假 agy（照 1.4.12 实测的 stream-json 行为）：stdin 一行一条消息，每条答一轮；stdin 关了才退出。
// 每次启动、每条消息都往 log 里记一行（带 pid），测试据此数「起了几个进程」。
//   fakeAgy(AGY, { lines, code, stderr, log, onMessage })
//   lines：每条消息要吐的事件；code 非 0：答完这条就带这个退出码退出（模拟出错退出）
//   perMessage：[{lines, code}, ...] 按第几条消息分别指定（超出的用最后一项）
import fs from "node:fs";
import path from "node:path";

export function fakeAgy(AGY, { lines = [], code = 0, stderr = "", log, perMessage = null } = {}) {
  fs.mkdirSync(path.dirname(AGY), { recursive: true });
  const plan = perMessage || [{ lines, code, stderr }];
  fs.writeFileSync(AGY, `#!${process.execPath}
const fs = require("fs"), LOG = ${JSON.stringify(log || null)}, PLAN = ${JSON.stringify(plan)};
const rec = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), ...o }) + "\\n"); };
rec({ start: true, env: { CCAPP_RUN_ID: process.env.CCAPP_RUN_ID } });
let buf = "", n = 0;
process.stdin.on("data", (c) => {
  buf += c; let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    rec({ stdin: line });
    const p = PLAN[Math.min(n++, PLAN.length - 1)];
    for (const l of p.lines || []) process.stdout.write(JSON.stringify(l) + "\\n");
    if (p.stderr) process.stderr.write(p.stderr);
    if (p.code) process.exit(p.code);
  }
}).on("end", () => process.exit(0));
`);
  fs.chmodSync(AGY, 0o755);
  return log;
}

/** 读 log：[{pid, args, start?, stdin?}] */
export const readLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);

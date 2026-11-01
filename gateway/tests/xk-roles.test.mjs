// 小克：角色目录、人设导入、hook 注入
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROLES_DIR, WORLDBOOK, ensureRoles, importPersona, importWorldbook, parsePersona, personaStatus, roleDir, roleOfDir } from "../gw/xk-roles.mjs";

const HOOK = fileURLToPath(new URL("../gw/xk-hook.mjs", import.meta.url));
const hook = (ev, dir, input, env = {}) => spawnSync(process.execPath, [HOOK, ev, dir], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } });

test("人设 txt 三段各归各位，分隔线去掉", () => {
  const p = parsePersona("【一】system_prompt\n你是虚构角色甲。\n---\n【二】post_history_instructions\n回复要短。\n【三】mes_example\n<START>\n甲：早。\n");
  assert.equal(p.system_prompt, "你是虚构角色甲。");
  assert.equal(p.post_history_instructions, "回复要短。");
  assert.equal(p.mes_example, "<START>\n甲：早。");
  assert.equal(parsePersona("没有标记的整篇设定").system_prompt, "没有标记的整篇设定");
});

test("角色目录：agent 人设、hook、记忆服务都摆好；导入不被重启覆盖", () => {
  ensureRoles();
  const d = roleDir("xiaoke");
  const st = JSON.parse(fs.readFileSync(path.join(d, ".claude/settings.json"), "utf8"));
  assert.equal(st.agent, "xiaoke");
  assert.match(st.hooks.UserPromptSubmit[0].hooks[0].command, /xk-hook\.mjs' prompt /);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, ".mcp.json"), "utf8")).mcpServers["xk-memory"].alwaysLoad, true);
  assert.equal(personaStatus("xiaoke").imported, false);
  importPersona("xiaoke", "【一】system_prompt\n虚构人设正文\n【二】post_history_instructions\n虚构的贴尾提醒\n【三】mes_example\n虚构示例");
  ensureRoles();
  const agent = fs.readFileSync(path.join(d, ".claude/agents/xiaoke.md"), "utf8");
  assert.match(agent, /^---\nname: xiaoke\n/);
  assert.match(agent, /虚构人设正文[\s\S]*# 对话示例\n\n虚构示例/);
  assert.equal(personaStatus("xiaoke").postHistoryChars, "虚构的贴尾提醒".length);
  assert.throws(() => importPersona("xiaoke", "【二】post_history_instructions\n只有贴尾"), /system_prompt/);
  assert.equal(roleOfDir(path.join(d, "sub")).id, "xiaoke");
  assert.equal(roleOfDir(ROLES_DIR), null);
});

test("世界书：SillyTavern JSON 转成 Markdown，停用的条目不要", () => {
  importWorldbook(JSON.stringify({ entries: { 0: { comment: "地点甲", content: "虚构地点" }, 1: { comment: "停用", content: "不要", disable: true } } }));
  const md = fs.readFileSync(WORLDBOOK, "utf8");
  assert.match(md, /## 地点甲\n\n虚构地点/);
  assert.doesNotMatch(md, /不要/);
});

test("hook：post_history 每轮贴着消息，接班说明按 run 号只带一次", () => {
  ensureRoles();
  const d = roleDir("deepseek");
  fs.mkdirSync(path.join(d, "persona"), { recursive: true });
  fs.writeFileSync(path.join(d, "persona/post_history.md"), "贴尾提醒X\n");
  fs.mkdirSync(path.join(d, ".xk/carry"), { recursive: true });
  fs.writeFileSync(path.join(d, ".xk/carry/r9.md"), "接班说明Y");
  const r1 = hook("prompt", d, { prompt: "你好" }, { CCAPP_RUN_ID: "r9" });
  assert.equal(r1.status, 0, r1.stderr);
  const ctx = JSON.parse(r1.stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.indexOf("接班说明Y") < ctx.indexOf("贴尾提醒X"), "post_history 放最后，离消息最近");
  const r2 = hook("prompt", d, { prompt: "你好" }, { CCAPP_RUN_ID: "r9" });
  assert.doesNotMatch(r2.stdout, /接班说明Y/);
  const bad = hook("nope", d, {});
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /不认识的 hook 事件/);
});

# 待修的 bug

仓库的 GitHub Issues 还没开（fork 默认关着），先记在这里。开了以后搬过去，这份删掉。修的 PR 里写「修 xk/issues.md 第 N 条」，合并时把那条删掉。

## 1. 接班后交回原角色会新开一段对话，接不上原来的上下文

手机上的小克在 v0.2.2 里查到，云端会话对照代码核对过。

**现象**：小克额度用完 → 哈基米接班 → 小克恢复、交回小克时，开的是一段新会话，只带着接班期间那段对话的摘要，原来那个小克会话的上下文接不上。主人手动换回原角色也一样。

**原因**：
1. `gateway/gw/xk-handover.mjs` 的 `handOver()`：`STATE.originRun[run 号]` 只记 `{ from, reason, at }`，没记来源会话号；拿到会话号后转进 `STATE.origin[接班会话]`，同样没有。
2. 同文件 `PLANNERS.push(...)` 里「原角色恢复了就交回」那段：`ctx.body` 设成 `sessionId: null, follow: null, projectId: 原角色项目`，一律新开。
3. `gateway/web/xk.js` 的 `switchRole()` 一律调 `__cc.newConversation()`，没有回到已有会话这条路。

**期望**：接班时记下来源会话号；交回时来源会话还在就接着它（`sessionId = fromSid`），把接班期间的对话作为一段说明带进去（`carryText` 已经能生成），没了才新开；前端跟着打开那个会话。

**注意**：带进去的只能是接班会话里的对话，不能读接班那位的记忆（底线 3）。哈基米的会话要走 agy 的 `--conversation`，不是 claude `--resume`。

## 2. 哈基米：Google 返回 403 VALIDATION_REQUIRED 时只有一句含糊的报错

手机上的小克遇到的。

**现象**：Google 要求先验证账号时，agy 返回 403 / `VALIDATION_REQUIRED`，界面只显示一句含糊的「哈基米（agy）：……」，主人不知道去哪里验证。

**原因**：`gateway/gw/xk-agy.mjs` 只认 `authenticat|login|sign in|未登录` 这类字眼（`runAgy` 收尾、`checkModels` 判断登录都是），认不出这个错误，也不会把验证链接带出来。

**期望**：认出 `VALIDATION_REQUIRED`（和同类 403），明确提示「Google 要求先验证这个账号」；取出 `validation_url`，在哈基米的卡片和报错里给「去验证」按钮（交给系统浏览器）；验证完能重新检查状态。

**待补**：云端没有 Google 账号，复现不了，还不知道这个错误在 agy 输出里的确切格式（stream-json 的 `result.error`？stderr？`agy models` 也会报吗？）。修之前先把一次真实的错误原文（去掉个人信息）贴进 PR，按真实格式写解析和测试。

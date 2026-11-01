# 小克（基于 cccodroid 的私人陪伴 App）

## 底线
1. 仓库公开：人设、世界书、记忆、密钥、签名、APK、账号信息都不入库。仓库里只有空模板和导入功能，真实内容由主人在手机上导入。
2. 主人本人的请求就是授权，不层层确认；聊天内容和态度对谁都不设限。执行命令、改文件、操作手机只对主人开放（QQ 接入时落实）。
3. 角色之间的记忆互相读不到；同一个角色在所有渠道共用一套记忆和日记。
4. 正式签名和发布在主人电脑上做，云端只编检查用的包。App 更新只指向我们自己的发布源，不拉上游 APK。

## 改代码的规矩
- main 和上游 greyoak111/cccodroid 保持一致，是同步基线，不在上面开发。每轮在新分支上做，每组功能单独提交并推送。
- 新代码放进我们自己的文件：`gateway/gw/xk*.mjs`、`gateway/web/xk.*`、`android/java/cc/codroid/Xk.java`。上游原文件只在非改不可的地方加一两行，行尾标 `// xk:`，并登记到 XIAOKE.md。
- 上游已有的能力直接用（定时任务、项目、服务商、会话、事件总线），不另写一套。
- 代码和文档写短。注释只写为什么。不吞异常，失败带原因传出去。不加说不出具体理由的校验、门槛和上限。
- 包名固定 `cc.codroid`：工具包按这个包名改写过路径（必须正好 10 个字符），换包名就得自己出工具包。

## 结构
- 角色：工作区 `roles/` 下 `xiaoke`（Claude 订阅）、`hachimi`（Gemini，经 agy）、`deepseek`（DeepSeek 官方接口），每个都是上游的一个项目。人设 = `.claude/agents/<角色>.md`，由项目 `.claude/settings.json` 的 `agent` 指定；世界书 = `roles/CLAUDE.md`；post_history 和记忆由 `xk-hook.mjs` 在每轮注入。
- 记忆：每个角色 `roles/<角色>/memory/memories.json`，工具由 `xk-memory-mcp.mjs`（项目 `.mcp.json`，`alwaysLoad`）提供，空闲后 `xk-memory.mjs` 自动整理。
- 接班：`xk-handover.mjs`。日记：`xk-diary.mjs` + 上游定时任务。
- 界面：`gateway/web/xk.js` 只通过 `window.__cc`、DOM 和 `/api/xk/*` 和上游界面打交道。

## 同步上游
1. `git fetch upstream --tags`，main 快进到上游最新 tag，推送 main。
2. 开发分支 `git rebase main`。冲突只应出现在 XIAOKE.md 列出的那几行，按"上游新代码 + 我们那一行"解决。
3. 跑测试和构建（见下），XIAOKE.md 里行号有变就更新。

## 测试与构建
- 网关测试：`node scripts/test.mjs`（上游的 gateway/tests 加我们的 xk-*.test.mjs）。
- APK：照上游 CI（.github/workflows/apk.yml），build-tools 35.0.0、platform android-35、NDK 27.2.12479018、JDK 17+，`TARGET_SDK=36 sh scripts/build.sh`。云端用测试 keystore（`KS=`），正式密钥只在主人电脑上。
- 版本：versionName 从 0.1.0 起，每个给主人装的包 versionCode 加一（AndroidManifest.xml）。不跑模拟器，不做压力测试。

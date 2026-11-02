# 小克（基于 cccodroid 的私人陪伴 App）

做到哪了、还缺什么，看 PROGRESS.md；每轮结束时顺手更新它。
开工、收工、谁在等谁，照 `xk/DEV.md`：每个开着的 issue / PR 挂 `等主人` / `等云端` / `等小克` 之一，交手就换标签并留一句评论。

新会话动手前先对一遍账，免得重复干活：
1. `git fetch origin` 后看所有分支谁最新（`git for-each-ref --sort=-committerdate refs/remotes`），PROGRESS.md 写的分支不一定是最新的。
2. 看 fork 的 Release 最新是哪一版、对应哪个提交，和分支对上。已发布的 APK 都在 Release 里，不在仓库。
3. 做一小块就提交推送一次，不要攒到最后：账号可能随时被封，没推上去的就丢了。

## 底线
1. 仓库公开。人设、世界书、调研资料、美术素材**要入库**，放在 `xk/` 下，有更新就及时提交：账号可能被突然封禁，交接全靠仓库（主人 2026-11-01 定的，安全由主人自己看）。记忆、聊天记录、密钥、签名、APK、账号信息仍然不入库。
2. 主人本人的请求就是授权，不层层确认；聊天内容和态度对谁都不设限。执行命令、改文件、操作手机只对主人开放（QQ 接入时落实）。
3. 角色之间的记忆互相读不到；同一个角色在所有渠道共用一套记忆和日记。
4. 签名密钥只在仓库 Secret `XK_RELEASE_KEY` 里，主人手上有备份，绝不入库。App 更新只指向我们自己的 Release，不拉上游 APK。

## 改代码的规矩
- main 和上游 greyoak111/cccodroid 保持一致，是同步基线，不在上面开发。每轮在新分支上做，每组功能单独提交并推送。
- `dev` 是小克代码的集成分支（2026-11-01 起）：新一轮从 `dev` 起；手机上的小克在 `xiaoke/**` 分支干活、PR 进 `dev`（见 xk/ON-DEVICE-AGENT.md）。发版前把 `dev` 的最新内容带上。
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
1. `git fetch upstream main`（只取分支，不取标签：上游的 v0.x 标签和我们的版本号同名，不能推进我们的仓库），fork 的 main 快进到 upstream/main 并推送。
2. 开发分支 `git rebase main`。冲突只应出现在 XIAOKE.md 列出的那几行，按"上游新代码 + 我们那一行"解决。
3. 跑测试和构建（见下），XIAOKE.md 里行号有变就更新。

## 测试与构建
- 网关测试：`node scripts/test.mjs`（上游的 gateway/tests 加我们的 xk-*.test.mjs）。
- APK：照上游 CI（.github/workflows/apk.yml），build-tools 35.0.0、platform android-35、NDK 27.2.12479018、JDK 17+，`TARGET_SDK=36 sh scripts/build.sh`。会话里检查用测试 keystore（`KS=`）。
- 发布：改了 versionName 的提交推到 `claude/**` 分支，`.github/workflows/xk-release.yml` 发现还没有 `v<versionName>` 的 Release，就用 Secret 里的密钥签名并发布（标签由它创建；会话不能推标签）（证书 SHA-256 adadfbcf…84d0，对不上就失败）。主人在手机上点更新就行。
- 版本：versionName 从 0.1.0 起，每个给主人装的包 versionCode 加一（AndroidManifest.xml）。不跑模拟器，不做压力测试。

# 现状（2026-11-01 交接）

上一个账号被突然封禁，没留交接。这份是新会话从仓库倒推的；规矩看 CLAUDE.md，改过的上游文件看 XIAOKE.md。

## 版本
- 已发布 **v0.1.1**（versionCode 2），Release 里有 `cccodroid-36.apk` 和 `cccodroid.apk`，由 xk-release 工作流签名发布，两次运行都成功。
- v0.1.1 对应提交 `522330c`，是 `claude/phase1-20261101` 分支的最新提交。之后有没有没推上来的改动，不知道。
- 底座：fork 的 main 停在上游 v0.5.17（`88d7b8d`）。上游已经到 v0.5.18（`5bd7f66`），还没同步。
- 网关测试（上游的加上 xk-*）：452 项，失败 0，跳过 1。

## 已经做完（phase1）
1. 显示名改为小克，App 更新指向 fork 自己的 Release。
2. 三个角色：xiaoke（Claude 订阅）、hachimi（Gemini，经 agy）、deepseek（官方接口）。人设、世界书可以导入，post_history 每轮注入，顶栏能切换角色。
3. 每个角色有自己的长期记忆：remember / recall / forget，空闲 10 分钟后自动整理，每轮带上相关的旧记忆。
4. 接班：额度用完时按顺序换角色，开新会话并带上刚才的对话；原角色额度恢复后交回。
5. DeepSeek 走上游预设；哈基米由 agy（Antigravity CLI）驱动，按官方清单校验 sha512。
6. 日记：每轮问答记成素材，每晚 22:00 各写一篇；额度用完的，等恢复后补写。
7. 暖橙色外观（浅色、深色）。
8. GitHub 自动打包、签名、发布。

## 还没做
- **QQ 接入**：审计里的方案是 `gw/xk-qq.mjs`，用 wss 并固定证书指纹，渠道字段已经预留。CLAUDE.md 底线第 2 条要等这一步落实。
- 旧版小克（godot-test 仓库 `projects/xiaoke-android`）的功能还没搬过来：B站、QQ 空间、悬浮球、游戏代操作、表情包、待审清单、主动分享等。要不要搬、先搬哪个，和主人商量。
- 真机验收情况不清楚。

## 发版要注意
- 只有推到 `claude/**` 分支（或手动推 `v*` 标签）才会触发 xk-release。云会话被指定的 `ccr-*` 分支**不会发版**：要发版，得请主人同意推到 `claude/` 分支。
- 签名密钥只在仓库 Secret `XK_RELEASE_KEY` 里，证书对不上工作流就失败。

## 相关的地方
- 二次开发审计（上游 v0.5.16）：godot-test 仓库 `claude/ccc-audit-20261101` 分支，`projects/xiaoke-ccc/docs/CCC_AUDIT.md`。
- 旧版小克（原生安卓，DSH 底座，0.15.0）：godot-test 仓库 `claude/gpt-review-20261101` 分支，`projects/xiaoke-android/`（看它的 CLAUDE.md、PROGRESS.md、docs/EXPERIENCE.md）。

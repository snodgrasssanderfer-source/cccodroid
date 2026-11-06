# 云端会话交接（11-03 ~ 11-06，会话 session_01TKKy6TzUQNcCnWaE9WtiXB）

主人 11-06 说事情多了，可以开新对话。这份写给下一个云端会话：先照 CLAUDE.md「新会话先对账」，再读这份。

## 一、接手时先看的（11-06 挂「等云端」的）

这几张我这个会话**没碰过**，是 11-05、11-06 小克她们推上来的，要先读 issue 和 PR 正文：

| 号 | 是什么 |
|---|---|
| #126 PR | 聊天室：直播模式的热改收进仓库，目标模式做一半能停（#120 #108） |
| #127 PR | 大扫除第二批：便条超 5 张不再丢；群那轮不整段进日记素材 |
| #128 PR | 省额度：记忆注入去重截短，角色关掉 claude.ai 连接器和自带技能 |
| #129 | 大扫除第四批：收拾重复代码和累赘（#125 小鱼体检第 9–18 条） |
| #131 | 大扫除第六批：修体检查出的 bug，定时任务被重启吞掉 |

挂「等主人」的：#125 全屋大扫除（总单）、#133 直播新路线稿（主人拍板 5 条）、#112（见第三节）、#99。

**dev 上 0.3.22 之后已经合了不少没发的东西**（QQ 接入 #135 #136、大扫除 #130 #132 等）。下次发版前，先跑测试，看真机验收到哪了。手机 11-04 还装着 0.3.21；0.3.22（#108 四种模式）小克还没在真机上验。

## 二、这个会话做过的，按系统分

### 平板 ↔ 手机连接（`xk/pad/`、`gateway/gw/xk-pad.mjs`、`android/java/cc/codroid/XkPad.java`）
- 手机开 Hiddify VPN 时，平板连进来的连接回不去：VPN 把回包收走了。Hiddify 的 TUN 还会在手机本机把连接「假接」下来，看着通了，其实没连到平板。
- 所以有三条路，平板按顺序试：
  1. **反连**：平板开 `_xkpadc._tcp`（PadHub），手机连过去挂控制线，平板要连接时手机再开一条。控制线开头平板要回 `OK`，等不到就说明是假接。
  2. **直连**：平板直接连手机。
  3. **电脑中转**：`xk/voice/relay.py`，端口 8791，不要配对码。这条是给「电脑开热点、手机和平板都连在电脑上、Windows 热点不让设备互访」的情况。两边找不到广播时，都会去敲自己网关（电脑）的门。
- 手机找平板要在 Wi‑Fi 那张网上找（`lan(ctx)`），绑 Wi‑Fi 被 Hiddify 拒，这一步已经去掉。
- 平板自己更新（`xk-padupd.mjs` ↔ `PadUpdate.java`）：由手机代下 Release 里的 `xiaoke-pad.apk`，核对 sha256 后，经加密口子分块传给平板。
- 平板界面：安卓 15 是全屏铺满的，要按 insets 让出系统栏和键盘；整页不滚动，只滚消息列表。
- 串流服务端写死听 `127.0.0.1`：安卓的 `getLoopbackAddress()` 给的是 `::1`，网关连不上。

### 语音（`xk/voice/`，跑在主人笔记本上：RTX 5060 8GB、Windows）
- 念用 **GPT-SoVITS**，跑它自己的整合包 `api_v2.py`；听用 SenseVoice，跑在 CPU 上。三个人的模型都是主人电脑上的 GPT 训练的。
- `config.json` 里 `tts_roles: ["hachimi"]`：主人 11-04 定的，先只接入哈基米，小克和小鱼的声音他不满意，等 GPT 回来接着训。
- GPT 调音时加的 `mandarin_phrasing.py`、`mandarin_rhythm.py` 和 `gsv_by_role` 已经合进来。`config.json` 只在第一次生成配对码时写一次，之后不再回写。
- 平板念话：音频放内存里排队播放（以前用 8 个轮用文件会被覆盖），按消息号只念一次。
- 主人电脑上的 GPT（Codex）负责部署，派活走 issue（DEV.md 有一节讲她）。她交回来的东西，要看有没有夹带防御：多加校验、限制、免责声明。`xk/voice/AGENTS.md` 里写了不许她这么做。

### 哈基米（agy，`gateway/gw/xk-agy.mjs`）
- **根因**：安卓不让直接 exec 应用目录里的程序。别的进程靠 LD_PRELOAD 垫片转给 linker64，可 agy 是 Go 写的，绕过了垫片，所以 bash、node（MCP）、dbus-launch 全被拒。
- **改法**：手机上 MCP 写成 `/system/bin/linker64 node 脚本`（`goCommand`）；agy 的 `SHELL=/system/bin/sh`，`PATH` 最前面放一个目录，里面的 bash、sh 软链到 `/system/bin/sh`。0.3.21 真机上原生 MCP 已经通了。
- MCP 配置在 `~/.gemini/config/mcp_config.json`，网关同时写一份到 `antigravity-cli/`，后者其实用不上，但没坏处。
- `gateway/gw/xk-tool.mjs`：在终端里调同一套 MCP 的命令行工具，当兜底，也写进了她的 AGENTS.md。记忆一律走 remember，不许直接改 memories.json。
- agy 每轮收尾都报「流中断」，但正文已经说完了：要照样记进会话、贴进群，并说明收尾报了错（#101）。

### 聊天室（`gateway/gw/xk-room.mjs`）
- 四种模式（#108，0.3.22）：平时、计划、目标、直播。目标模式点名接话不设上限；`room_mode` 工具只能切回平时。之后 #120、#126 又改过直播模式，以那两张为准。

### GPT 当第四位住客（#112，**主人 11-04 暂停**，等订阅下半月续上）
- **要瞒着她**：别在 GPT 的 issue 里提，别挂「等GPT」。
- 官方 aarch64 的 Codex 是 musl 静态 EXEC，linker64 加载不了。工作流 `xk-codex.yml` 照源码编 glibc 版，发成预发布 `codex-<版本>`，推 `claude/codex-build` 分支触发。
- 0.166.0 那版缺 libssl、libcrypto、libgcc_s；工作流已经改成静态链进去，但还没重编。
- 起 Codex 要和 claude 一样经 glibc 加载器（`claudeArgv` 那套），直接 spawn，环境里删掉 LD_PRELOAD。不要用 `env -u`，会被 exec 垫片改坏。
- 主人已经定的：替班排第 4；眼下算分身；`chain` 从 3 改成 4；人设等云端 GPT 收资料后由 Claude 写。

## 三、做事的路数（这个会话一直这么做，主人认可）
- 在指定的 `ccr-…` 分支上做（每轮从 `origin/dev` 重置），PR 进 `dev`，用 MCP 合并（`expectedHeadSha` 要写完整 40 位）。
- **发版**：versionName 和 versionCode 一起加，然后 `git push origin origin/dev:refs/heads/claude/release-X.Y.Z`，等 xk-release 跑完（看 `releases/tags/vX.Y.Z`，里面有四个文件）。主人 11-03 授权可以自己发，发完要告诉他：版本号、改了什么、Release 链接。
- 前端要用的图先问主人；文字界面不用。
- 本地编平板 APK、外壳 Java 要 android-35 的 android.jar 和 build-tools。这个容器里的在 scratchpad，新会话没有，要自己装，或者直接交给 CI。网关测试：`node scripts/test.mjs`，上游的 B22 在这类容器里挂，原因是 yq 是 jq 的包装，属于环境问题。
- 先读代码、查真东西（上游源码、二进制里的文字）再下结论；真机才算验过，模拟测试要说明是模拟的。这几回凭猜改了好几版才对，教训在 #83、#101、#99。

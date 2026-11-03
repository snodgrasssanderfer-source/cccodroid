# 改过的上游文件

同步上游时只会在这些地方冲突。我们新增的文件都以 `xk` / `Xk` 开头，不在此列。

| 文件 | 改动 | 原因 |
|---|---|---|
| android/AndroidManifest.xml | label=小克；versionCode/versionName 是我们自己的版本线（从 1 / 0.1.0 起）；加 `SYSTEM_ALERT_WINDOW` | 显示名；我们自己的版本线；悬浮窗（#32） |
| android/res/mipmap-*/ic_launcher.png | 换成小橙花图标（由 xk 美术素材生成） | 不用上游图标 |
| android/res/values*/strings.xml | 无障碍服务名里的 cccodroid → 小克 | 系统设置里显示的名字 |
| android/java/cc/codroid/Tr.java | `t()` 返回前过 `Xk.brand` | 外壳所有提示里的产品名一处换掉 |
| android/java/cc/codroid/Updater.java | REPO/MIRROR/DL 和 `feed()` 改用 `Xk`；`fetchLists` 的镜像那条换成 `Xk.backupFeed()`，用它时的提示改一句 | App 更新走我们的发布源，上游镜像只有上游的 APK；api.github.com 限流（403）时还能从 Release 附带的 releases.json 查到新版 |
| android/java/cc/codroid/GatewayService.java | 常驻通知标题用 `Xk.NAME`；小图标用 `Xk.icon`；`onCreate` 里起 `XkOverlay`（1 行） | 显示名；状态栏的小橙花；悬浮窗（#32）和网关同寿命 |
| android/java/cc/codroid/Notify.java | 跑完、定时任务、已更新三条通知的小图标用 `Xk.icon`（3 行） | 状态栏的小橙花 |
| android/java/cc/codroid/WhatsNew.java | 说明目录用 `Xk.WHATSNEW`（assets/xk-whatsnew） | 上游 whatsnew/ 是上游各版说明，版本号和我们撞名 |
| android/java/cc/codroid/MainActivity.java | 安装页标题用 `Xk.NAME` | 显示名 |
| gateway/server.mjs | import `routeXk`，放在 ROUTES 第一位 | 小克的网关功能入口；要先看 /api/chat（角色与接班路由）和 /api/session-model（换型号即换人） |
| gateway/gw/notices.mjs | 去掉上游通知来源；缓存换到 .cache/xiaoke | 上游维护者的通知是写给上游用户的，版本范围也按上游版本号 |
| gateway/gw/run.mjs | 角色项目里 `--append-system-prompt` 只留 integrityHint，不加建档提示 | 13 KB 的开发工具说明会冲淡人设；integrityHint 防有人在消息里冒充系统指令 |
| gateway/gw/run.mjs | 拿到会话号时，网关自己起的轮次（internal / sched / auto）不 `rememberSession`（1 行） | 开跑就记成「最近的会话」，跑到一半网关被杀，事后换回的钩子跑不到，开机打开的是整理 / 日记那段（#8 #22） |
| gateway/web/index.html | 引入 `/xk.css`、`/xk.js` | 小克的界面和外观 |
| scripts/test.mjs | 假 PREFIX 里再放系统的 git、sleep 链接 | 上游审查测试 B20 要在终端 PATH 里跑 git 和钩子，手机上有、CI 上没有，发版的测试步骤会挂 |
| gateway/gw/terminal.mjs | `ptyCommand` 加 export | 哈基米登录 Google 要在同一个伪终端里跑 agy（xk-agy.mjs） |
| NOTICE | 末尾加修改声明、标题字体的许可 | Apache-2.0 第 4 条；站酷小薇是 OFL 1.1 |

界面相关的新文件（不在上表，不会冲突）：`android/res/drawable-*/ic_stat_xk.png`（通知小图标，白色剪影）、`gateway/web/xk-art/`（美术素材 WebP）、`gateway/web/fonts/xk-zcool-xiaowei.woff2` 与 `OFL-ZCOOL-XiaoWei.txt`（标题字体；26 个字的轮廓方向修过，见 `xk/tools/font-fix-contours.py`）。

# 改过的上游文件

同步上游时只会在这些地方冲突。我们新增的文件都以 `xk` / `Xk` 开头，不在此列。

| 文件 | 改动 | 原因 |
|---|---|---|
| android/AndroidManifest.xml | label=小克；versionCode/versionName 从 1 / 0.1.0 起 | 显示名；我们自己的版本线 |
| android/res/mipmap-*/ic_launcher.png | 换成占位图标 | 不用上游图标 |
| android/res/values*/strings.xml | 无障碍服务名里的 cccodroid → 小克 | 系统设置里显示的名字 |
| android/java/cc/codroid/Tr.java | `t()` 返回前过 `Xk.brand` | 外壳所有提示里的产品名一处换掉 |
| android/java/cc/codroid/Updater.java | REPO/MIRROR/DL 和 `feed()` 改用 `Xk` | App 更新走我们的发布源，上游镜像只有上游的 APK |
| android/java/cc/codroid/GatewayService.java | 常驻通知标题用 `Xk.NAME` | 显示名 |
| android/java/cc/codroid/MainActivity.java | 安装页标题用 `Xk.NAME` | 显示名 |
| gateway/server.mjs | import `routeXk`，放在 ROUTES 第一位 | 小克的网关功能入口；要先看 /api/chat 做角色与接班路由 |
| gateway/gw/run.mjs | 角色项目里 `--append-system-prompt` 只留 integrityHint，不加建档提示 | 13 KB 的开发工具说明会冲淡人设；integrityHint 防有人在消息里冒充系统指令 |
| gateway/web/index.html | 引入 `/xk.css`、`/xk.js` | 小克的界面和外观 |
| NOTICE | 末尾加修改声明 | Apache-2.0 第 4 条 |

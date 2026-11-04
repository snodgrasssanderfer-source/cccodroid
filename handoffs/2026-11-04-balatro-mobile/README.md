# #115 手机牌局安装包交接

主人 11-04 选择“先做好安装包和模组文件”。已完成这一阶段，目标手机尚未连接；没有安装、卸载或修改任何手机 App。#115 保持打开，待小克真机验收。

- 本地 `xiaoke-balatro-mobile.apk`：70,379,304 字节，独立包名 `org.xiaoke.balatro.bridge`，显示名「小丑牌·小克实验版」。
- 本地 `xiaoke-balatro-mobile-files.zip`：包含 Mods 三个目录、同版 Python bridge 和启动/单步验收脚本。
- 逐项安装、启动、实测命令见 [手机说明](../../xk/game/mobile/README.md)。哈希、工具版本和已验/未验项见 [build-summary.json](build-summary.json)。二进制交给主人下载，不放公开仓库。

采用 Steamodded 官方推荐的 Lovely Mobile Maker 原生安卓路线。不是替换游戏，也不修改官方包。APK 实际回读 manifest 检查通过；zipalign 与 v1/v2/v3 签名通过；签名工具的 34 条 warning 均为原底座 META-INF 元数据的 v1 签名覆盖提示。模组 ZIP 完整性通过，补丁重复执行一致，Lua 编译通过。

模组补丁只改打包暂存副本：balatrobot 固定 0.0.0.0:12346、正常速度和声音，保留首次跳教程初始化。APK 首次默认简中。桥监听 12347，手机工具用 127.0.0.1。手机上的显示、开局、接口、时延仍需实测；没有用电脑数值冒充手机结果。LMM/SDL 源码显示完全切后台可能暂停网络轮询，需核对前台与恢复。

电脑新增仅本次工作区的脚本、下载工具、构建暂存和 outputs 成品；ADB 只读取连接列表。`D:\balatrobot`、原 Mods、`D:\xkvoice` 均未改，本轮未重启这些服务。可选 install.ps1 仅语法检查，未在手机执行。

# 手机牌局尝试（#115）

已在电脑打出并验签独立 APK；**尚未在目标手机安装、启动或计时**。主人 11-04 指定先做好安装包和模组文件，当前 USB 连接的不是目标手机。

包名 `org.xiaoke.balatro.bridge`，显示名「小丑牌·小克实验版」。官方 `com.playstack.balatro.android` 保持独立。使用本机 Steam 1.0.1o-FULL 游戏、Lovely Mobile Maker 原生安卓底座、Steamodded 26.1002.0、balatrobot 1.5.2 发布包（内置 manifest 仍写 1.5.1）与本仓库 xk_game_bridge 0.1.0。游戏和 APK 不入库。

## 手机手动安装

1. 将 `xiaoke-balatro-mobile.apk` 和 `xiaoke-balatro-mobile-files.zip` 传到目标手机，安装 APK。
2. 打开一次「小丑牌·小克实验版」以初始化目录，然后退出。解压 ZIP。
3. 用支持 Android 文档提供器的文件管理器打开**「小丑牌·小克实验版」**的存档目录。Steamodded 官方给出的 Material Files 路径是：侧栏 → 添加存储 → 外部存储 → 系统选择器侧栏 → 游戏显示名 → 使用此文件夹。
4. 将 ZIP 中 `Mods/` 下的 **smods、balatrobot、xk_game_bridge 三个文件夹**放到该存档目录的 `ASET/Mods/` 内。最终是 `ASET/Mods/smods/…`，不要多套一层 Mods。重新打开实验版游戏。
5. 小克把 ZIP 中 `bridge/` 放到手机 App 的可执行工作目录，运行：

```sh
cd /实际解压路径/bridge
sh start-phone.sh
# 要让终端返回：nohup sh start-phone.sh > bridge.log 2>&1 &
```

桥地址 `http://127.0.0.1:12347`，游戏 JSON-RPC `http://127.0.0.1:12346`。桥代码与电脑相同：`/state`、`/act`、`/events`。

## 给小克的真机核对

先让游戏在前台，再从 App 后台任务调用接口；`check-phone.py --delay 10` 留出切回游戏的时间：

```sh
python3 check-phone.py --delay 10 > phone-health.json
# MENU 时开新局；这个命令会实际开局
python3 check-phone.py --delay 10 --action '{"action":"start","deck":"RED","stake":"WHITE","seed":"PHONE115"}' > phone-start.json
# BLIND_SELECT 时进盲注
python3 check-phone.py --delay 10 --action '{"action":"select"}' > phone-select.json
```

出牌时先读 `state.actions` 和手牌，再传一个合法 play/discard。输出保留原始 health、state、act、events 和外部 `wall_ms`；记录多步后与电脑 23 步中位 2633 ms 比较。这个脚本不选择打法。

记录：游戏是否正常显示/能开局，health 是否返回，/state 是否 ready，/act 动画后返回、耗时及事件；另测切后台与恢复。LMM/SDL 源码默认会在 Activity onStop 后暂停原生事件循环，balatrobot 的 love.update 轮询也可能暂停。**后台可用性尚未实测**。错误时回贴原文；Lovely 日志在同一 `ASET/Mods/lovely/log/`。

## 电脑重建

Python 3.11+、Java 21、Apktool 3.0.3、uber-apk-signer 1.3.0；不需要 Android SDK/NDK。参数均指本地文件：

```powershell
python build.py --base-apk lmm-base.apk --java path/to/java.exe --apktool apktool-3.0.3.jar --signer uber-apk-signer.jar --game path/to/Balatro.exe --mods-dir path/to/Mods --work-dir path/to/build-work --output path/to/xiaoke-balatro-mobile.apk --label '小丑牌·小克实验版'
```

每次建立新的暂存目录。游戏文件平铺 assets；仅把游戏的首次默认语言改为简中。包名、两个 provider authorities、自定义 permission 一起改写；保持原 Activity 类名。实验包 `debuggable=true` 供 run-as 安装模组。APK 签名用 signer 自带调试证书，与官方签名独立。

暂存 Mods 只选三个模组，不带桌面 Lovely dump、玩家存档。`patch_mods.py` 在 balatrobot setup 前设 0.0.0.0:12346、速度 1、声音开，并保留首次跳教程的初始化修复；不修改电脑源目录。脚本输出 APK、`.build.json` 与暂存 Mods 路径。

可选 USB 安装（这轮未执行），必须明确目标序列号：

```powershell
./install.ps1 -Adb path/to/adb.exe -Serial TARGET_SERIAL -Apk path/to/xiaoke-balatro-mobile.apk -Mods path/to/Mods
```

先核对旁边的构建记录，再安装实验包，run-as 复制模组到 `files/save/ASET/Mods` 后启动。手装无需这个脚本。

## 来源

- [Steamodded 官方移动安装说明](https://docs.smods.dev/Installation/Installing%20Steamodded%20mobile/)
- [Lovely Mobile Maker README 与 base.apk](https://github.com/WilsontheWolf/lovely-mobile-maker/blob/master/README.md)
- [LMM 打包与包名处理](https://github.com/WilsontheWolf/lovely-mobile-maker/blob/master/js/manifest.js)
- [LMM Lovely 0.10.0 更新](https://github.com/WilsontheWolf/lmm-love-android/commit/c36e6685723bf4b85f04cf554a650af400fc50e0)
- [原生 Mods 路径](https://github.com/WilsontheWolf/lmm-love/blob/01af71f2f4c33dd08533296d7a66dce0ab520b52/src/love.cpp#L171)
- [Apktool 3.0.3](https://github.com/iBotPeaches/Apktool/releases/tag/v3.0.3)、[签名工具 1.3.0](https://github.com/patrickfav/uber-apk-signer/releases/tag/v1.3.0)、[Java 21.0.13](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.13%2B9)

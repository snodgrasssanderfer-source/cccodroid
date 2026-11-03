# 小克 · 平板（xk/pad/）的许可与来源

这个目录是「小克 · 平板」App 和手机上用的串流服务端，整体按 **GPL-3.0** 发布（`LICENSE`，主人 2026-11-03 定的）。
仓库其余部分（手机上的小克，源自 greyoak111/cccodroid）仍是 Apache-2.0；串流服务端是一个单独的程序（手机上用 shell 以 `app_process` 起），不和小克的代码链接在一起。

## 来自易控（EasyControlNext）的代码

- 来源：<https://github.com/shiyunjin/EasyControlNext> 提交 `aeda990`（2026-03-30），GPL-3.0。它是 mingzhixian/Easycontrol（易控）的分支，服务端部分借鉴自 Genymobile/scrcpy（Apache-2.0）。
- 拿过来的：
  - `server/java/com/shiyunjin/easycontrolnext/server/**`、`server/aidl/**`：服务端全部源码（原 `easycontrolnext/server/src/main/`）。
  - `java/com/shiyunjin/easycontrolnext/app/client/decode/*`：平板上的视频、声音解码（原 `app/src/main/java/.../client/decode/`）。
- 我们改了的：
  - `Server.java`：`ServerSocket` 只听本机（`InetAddress.getLoopbackAddress()`），原版听所有网卡、明文。平板经手机网关加密中转，不直连。
  - 解码两个文件去掉了 `androidx.annotation.NonNull`（平板 App 不带 AndroidX）。
  - 构建不用 Gradle：`build-server.sh`（aidl → javac → d8）。

## 我们自己写的

`java/cc/codroid/pad/**`（连接、配对、加密、界面）、`assets/**`、`res/**`、`build*.sh`，同样按 GPL-3.0。

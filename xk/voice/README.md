# 小克的语音服务（装在主人电脑上）

让她们**开口说话**、**听主人说话**。平板在家里 Wi‑Fi 里自己找到这台电脑，你说的话录下来交给电脑转成文字发进群，她们回的话由电脑照各自的音色念出来，在平板上放。设计见 `xk/design/presence.md` 第五节。

- 念：[VoxCPM](https://github.com/OpenBMB/VoxCPM)（Apache‑2.0）。平时用 VoxCPM1.5（约 6GB 显存），挑音色时用 VoxCPM2（约 8GB，能按文字描述造声音）。
- 听：[SenseVoice](https://github.com/modelscope/FunASR)（阿里 FunASR），默认在 CPU 上跑，不占显存。
- 模型从魔搭（ModelScope）下，国内直连。

## 第一次装（Windows，笔记本 RTX 5060 8GB）

1. **显卡驱动**更新到最新（50 系要新驱动，CUDA 12.8 起）。
2. **装 Python 3.11**：<https://www.python.org/downloads/> 找 3.11.x 的 Windows installer，安装第一页勾上 **Add python.exe to PATH**。
3. **拿到这个文件夹**：云端发给你的 `xk-voice.zip` 解压到一个英文路径里（比如 `D:\xkvoice`），磁盘留 20GB 左右。
4. **双击 `setup.bat`**：建虚拟环境、装 PyTorch（CUDA 12.8 版，约 3GB）和其他依赖，最后会打出认到的显卡名字。下得慢就照 `setup.bat` 里那行说明换清华镜像。

## 造音色、挑音色

5. **双击 `design.bat`**：第一次会先从魔搭下 VoxCPM2（几个 GB）。然后照 `voices.json` 里写的人设描述，每人念一段试听的话，各出 4 版，放在 `candidates\xiaoke\1.wav` 这样的地方。跑之前把游戏、视频这类占显存的关掉。
6. 挨个听。**双击 `pick.bat`**，输入角色（`xiaoke` / `hachimi` / `deepseek`）和编号，就定下来了（拷到 `voices\`）。
   - 都不满意：改 `voices.json` 里的 `describe`（描述）再跑 `design.bat`；只重造一个人：在命令行里 `design.bat --roles hachimi`。
   - 想用自己找的声音：放一段 5–15 秒、没有背景音乐的干净录音到 `voices\<角色>.wav`，把录音里说的原话写进 `voices\<角色>.txt`。这类录音只在你电脑上，不进仓库。

## 每次用

7. **双击 `start.bat`**：加载模型（第一次会下 VoxCPM1.5 和 SenseVoice），窗口里会显示**配对码**和地址。Windows 防火墙弹窗时，勾「专用网络」允许。
8. 平板上「小克 · 平板」里填一次配对码（平板这一侧做好后随新版发）。开着这个窗口就能用，关掉就停，平板上只出文字。

## 出问题时

- **`CUDA out of memory`**：显存不够。关掉别的占显存的程序；还不够就打开 `config.json`，确认 `tts_model` 是 `VoxCPM1.5`。
- **平板找不到电脑**：两台要连同一个 Wi‑Fi（平板连手机热点时找不到电脑）。电脑上开着代理软件的 TUN / 虚拟网卡模式时，要让它放行局域网。
- **想换端口或让「听」用显卡**：改 `config.json` 的 `port`、`asr_device`（`cpu` / `cuda`），重开 `start.bat`。
- 其他报错：把窗口里的报错截图发给云端。

## 安全

只在家里局域网里用，平板每次请求都要带配对码，没有码的一律拒绝。局域网里的声音和文字不加密，靠配对码挡住别的设备。配对码在 `config.json`，删掉它再开 `start.bat` 会换一个新的（平板要重新填）。

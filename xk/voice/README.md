# 小克的语音服务（装在主人电脑上）

让她们**开口说话**、**听主人说话**。平板在家里 Wi‑Fi 里自己找到这台电脑，你说的话录下来交给电脑转成文字发进群，她们回的话由电脑照各自的音色念出来，在平板上放。设计见 `xk/design/presence.md` 第五节。

- 念：[CosyVoice3](https://github.com/FunAudioLLM/CosyVoice)（Fun-CosyVoice3-0.5B，Apache‑2.0，约 4.5GB 显存），照每人一段参考录音克隆音色（主人 11-03 定的）。
- 听：[SenseVoice](https://github.com/modelscope/FunASR)（阿里 FunASR），默认在 CPU 上跑，不占显存。
- 模型从魔搭（ModelScope）下，国内直连。

> 电脑上有 Codex 的话，在这个文件夹里打开它，说「照 AGENTS.md 把语音服务装好」就行。

## 第一次装（Windows，笔记本 RTX 5060 8GB）

1. **显卡驱动**更新到最新（50 系要新驱动，CUDA 12.8 起）。
2. **装 Python 3.10**（CosyVoice 官方用 3.10）：<https://www.python.org/downloads/> 找 3.10.x 的 Windows installer，安装第一页勾上 **Add python.exe to PATH**。
3. **装 Git**：<https://git-scm.com/download/win>（要用它把 CosyVoice 的代码下下来）。
4. 这个文件夹放在英文路径里（比如 `D:\xkvoice`），磁盘留 20GB 左右。
5. **双击 `setup.bat`**：下 CosyVoice 的代码、建虚拟环境、装 CUDA 12.8 版的 PyTorch（约 3GB）和依赖，最后打出认到的显卡名字。CosyVoice 官方依赖里锁着的老 PyTorch 不认 50 系，`setup.bat` 会跳过它（见 `cosyreq.py`）。

## 音库：每人一段参考录音

每个人放两个文件到 `voices\`：

| 文件 | 是什么 |
|---|---|
| `voices\xiaoke.wav`、`voices\hachimi.wav`、`voices\deepseek.wav` | 她的参考录音：5–15 秒，一个人说话，没有背景音乐和杂音 |
| `voices\xiaoke.txt` 等 | 录音里说的**原话**，一字不差（差了音色会跑偏） |

（`deepseek` 就是小鱼。）录音从哪来由主人定：自己找的、别人分享的、用 `design.py` 造的都行。**这些录音只在这台电脑上，不进仓库**。换了录音不用重启，下一句就按新的念。

## 每次用

6. **双击 `start.bat`**：第一次会从魔搭下 CosyVoice3 和 SenseVoice（几个 GB）。窗口里会显示**配对码**和地址。Windows 防火墙弹窗时，勾「专用网络」允许。
7. 平板「小克 · 平板」聊天页顶上点「声音」，填一次配对码。开着这个窗口就能用，关掉就停，平板上只出文字。

## 出问题时

- **`CUDA out of memory`**：关掉别的占显存的程序。
- **平板找不到电脑**：两台要连同一个 Wi‑Fi。电脑上的代理软件开着 TUN / 虚拟网卡模式时，要让它放行局域网。
- **改端口、让「听」用显卡、关半精度**：改 `config.json` 的 `port`、`asr_device`（`cpu` / `cuda`）、`fp16`，重开 `start.bat`。
- **想换回 VoxCPM 念**：`config.json` 的 `tts_engine` 写 `voxcpm`，另装 `pip install voxcpm`（它要的依赖可能和 CosyVoice 冲突，最好另建一个环境）。
- 其他报错：把窗口里的报错截图发给云端。

## 造音色（可选）

`design.py` 用 VoxCPM2 照 `voices.json` 里的人设描述造候选（`candidates\`），`pick.py` 定下来。要另外装 VoxCPM（见上一条），约 8GB 显存。

## 安全

只在家里局域网里用，平板每次请求都要带配对码，没有码的一律拒绝。局域网里的声音和文字不加密，靠配对码挡住别的设备。配对码在 `config.json`，删掉它再开 `start.bat` 会换一个新的（平板要重新填）。

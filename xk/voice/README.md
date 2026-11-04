# 小克的语音服务（装在主人电脑上）

让她们**开口说话**、**听主人说话**。平板在家里 Wi‑Fi 里自己找到这台电脑，你说的话录下来交给电脑转成文字发进群，她们回的话由电脑照各自的音色念出来，在平板上放。设计见 `xk/design/presence.md` 第五节。

- 念：[GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（MIT，主人 11-03 定的）。它用**自己的整合包**单独跑（`api_v2.py`），这里只把每句话交给它。最快、最省，实时对话最跟手。
- 听：[SenseVoice](https://github.com/modelscope/FunASR)（阿里 FunASR），在 CPU 上跑，不占显存。
- 两样都在 `start.bat` 一起起。

> 电脑上有 Codex 的话，在这个文件夹里打开它，说「照 AGENTS.md 把语音服务装好」就行。

## 第一次装（Windows，笔记本 RTX 5060 8GB）

1. **显卡驱动**更新到最新（50 系要新驱动，CUDA 12.8 起）。
2. **GPT-SoVITS 整合包**：照它 GitHub 首页的说明下 Windows 整合包（要支持 50 系的那个），解压到英文路径（比如 `D:\GPT-SoVITS`），先双击它自己的 `go-webui.bat` 能打开、能合成一句，就说明它没问题。版本、显卡、半精度在它的 `GPT_SoVITS\configs\tts_infer.yaml` 里改（V5 吃显存，开半精度 `is_half: true`，还不够就换 v2ProPlus）。
3. **装 Python 3.10 或 3.11**：<https://www.python.org/downloads/>，安装第一页勾上 **Add python.exe to PATH**。
4. 这个文件夹放在英文路径里（比如 `D:\xkvoice`）。**双击 `setup.bat`**：建虚拟环境，装「听」要的东西（CPU 版 PyTorch，不大）。
5. 打开 `config.json`（第一次运行 `start.bat` 后才有，也可以自己建），把 `gsv_dir` 填成整合包的位置，比如 `"gsv_dir": "D:\\GPT-SoVITS"`（反斜杠写两个）。这样 `start.bat` 会顺手把 GPT-SoVITS 的接口也起起来。不填的话，就要自己先开着它的 `api_v2.py`（默认 `127.0.0.1:9880`）。

## 音库：每人一段参考录音

| 文件 | 是什么 |
|---|---|
| `voices\xiaoke.wav`、`voices\hachimi.wav`、`voices\deepseek.wav` | 她的参考录音：**3–10 秒**（GPT-SoVITS 的要求），一个人说话，没有背景音乐和杂音 |
| `voices\xiaoke.txt` 等 | 录音里说的**原话**，一字不差 |
| `voices\deepseek.ckpt` + `voices\deepseek.pth`（可选） | 给她单独训练过（用整合包的 WebUI，约 1 分钟录音）就放进来：GPT 权重 `.ckpt`、SoVITS 权重 `.pth`。轮到她说话时自动换上 |

（`deepseek` 就是小鱼。）录音从哪来由主人定。**这些都只在这台电脑上，不进仓库**。换了录音不用重启。

有人训练过、有人没有时，没训练的那位要换回底模：在 `config.json` 填 `gsv_base_gpt`、`gsv_base_sovits`（整合包里底模文件的完整路径），不填会报错提示。

## 每次用

6. **双击 `start.bat`**：先起 GPT-SoVITS、再加载 SenseVoice（第一次从魔搭下），窗口里会显示**配对码**和地址。Windows 防火墙弹窗时，勾「专用网络」允许。
7. 平板「小克 · 平板」聊天页顶上点「声音」，填一次配对码。开着这个窗口就能用，关掉就停，平板上只出文字。

## 出问题时

- **`CUDA out of memory`**：关掉别的占显存的程序；在整合包的 `tts_infer.yaml` 开半精度，或换小一点的版本。
- **平板找不到电脑**：两台要连同一个 Wi‑Fi（或者都连在这台电脑开的热点上）。电脑上的代理软件开着 TUN / 虚拟网卡模式时，要让它放行局域网。
- **语速、切句**：`config.json` 的 `gsv_extra` 里写的会原样加进每次请求，比如 `"gsv_extra": {"speed_factor": 1.1}`（参数见整合包 `api_v2.py` 开头的说明）。
- **每人单独调**（11-04 主人和电脑上的 Codex 一起调的）：`gsv_by_role` 按人叠在 `gsv_extra` 上；`gsv_phrasing` 写 `"questions"` 的人，长问句在中间逗号处断开分两半念（`mandarin_phrasing.py`）；`gsv_rhythm` 里写了的人，念完再收长停顿、可选变速和均衡（`mandarin_rhythm.py`，变速和均衡要 `tools\ffmpeg\bin\ffmpeg.exe`，路径可在 `ffmpeg` 一项改）。
- **只接入一部分人的声音**：`config.json` 写 `"tts_roles": ["hachimi"]`，平板就只念名单里的人，别人只出文字（主人 11-04：先只接哈基米）。不写这一项就是放好音色的都接。改完重开 `start.bat`。
- **改端口、让「听」用显卡**：`config.json` 的 `port`、`asr_device`（`cpu` / `cuda`），重开 `start.bat`。
- 其他报错：把窗口里的报错截图发给云端。

## 造音色（可选）

`design.py` 用 VoxCPM2 照 `voices.json` 里的人设描述造候选（`candidates\`），`pick.py` 定下来。要另外装 VoxCPM（`.venv\Scripts\pip install voxcpm`），约 8GB 显存，跑的时候把 GPT-SoVITS 关掉。

## 手机和平板的中转

电脑开热点、手机和平板都连在上面时，两台互相连不上（Windows 热点不让设备互访或不转广播），但都连得到电脑。所以语音服务顺带开一个中转（`relay.py`，端口 8791）：手机自己会连上来，平板连不上手机时请电脑接一条。只搬字节，内容在平板和手机两头加密，电脑看不到。窗口里会显示「中转：手机 … 连上来了」。中转不要配对码（平板第一次和手机配对时还填不了码）；不会因此多放谁进来：手机只认配对过的平板，新平板要主人在手机上看着 6 位数点确认。

## 安全

只在家里局域网里用，平板每次请求都要带配对码，没有码的一律拒绝。GPT-SoVITS 的接口只听本机（`127.0.0.1`）。局域网里的声音和文字不加密，靠配对码挡住别的设备。配对码在 `config.json`，删掉 `code` 那一项再开 `start.bat` 会换一个新的（平板要重新填）。

# 给在这台电脑上干活的 Codex

这是「小克」的语音服务（主人的私人陪伴 App 的一部分，仓库 snodgrasssanderfer-source/cccodroid 的 `xk/voice/`）。主人请你帮他在这台 Windows 笔记本（RTX 5060 8GB）上把它装好、跑起来。说中文，说短。

## 要做成什么

1. 照 `README.md` 装好：Python 3.11 虚拟环境 `.venv`、CUDA 12.8 版的 torch / torchaudio、`requirements.txt` 里的依赖。`setup.bat` 就是这些步骤，可以直接跑它，也可以照着手动做。
2. `torch.cuda.is_available()` 为 True，能认出 RTX 5060。认不出先查驱动和 torch 是不是 cu128 版，**不要退回 CPU 版凑合**。
3. 跑 `design.py`（默认每人 4 版）：第一次会从魔搭下 VoxCPM2，生成到 `candidates/<角色>/`。生成完告诉主人去听，**挑哪一版由主人定**（`pick.py <角色> <编号>`），你不替他挑。
4. 主人挑完后跑 `server.py`，用下面的「自检」确认念和听都通，把窗口里的配对码告诉主人（他要填进平板）。

## 自检（服务开着时，另开一个终端）

```
set CODE=（config.json 里的 code）
curl -H "x-xk-code: %CODE%" http://127.0.0.1:8790/health
curl -H "x-xk-code: %CODE%" -H "content-type: application/json" -d "{\"role\":\"xiaoke\",\"text\":\"测试一下，听得到吗？\"}" http://127.0.0.1:8790/tts -o test.wav
curl -H "x-xk-code: %CODE%" --data-binary @test.wav http://127.0.0.1:8790/asr
```

`/health` 列出挑好音色的人；`test.wav` 能放出声音；`/asr` 应该把那句话认回来。

## 规矩

- 只动这个文件夹里的东西。模型（`models/`）、候选、挑定的音色（`voices/`）、`config.json`（里面有配对码）都留在这台电脑上，**不要提交、不要上传**。
- 显存只有 8GB：跑之前提醒主人关掉占显存的程序。`CUDA out of memory` 时先确认 `config.json` 的 `tts_model` 是 `VoxCPM1.5`，别擅自换成更大的模型。
- 别改 `server.py` 的接口（路径、参数、配对码请求头 `x-xk-code`、mDNS 名字 `_xkvoice._tcp`）：平板 App 认的就是这些。真要改代码修 bug，改完把改了什么、为什么写下来，让主人转给云端的 Claude，由它提交进仓库。
- `voices.json` 里的声音描述是照三个人的人设写的，主人要改就改，你别自己改。
- 报错照实说，别吞掉；装不上就停下来，把报错原文给主人。

## 平板那边

平板「小克 · 平板」在家里 Wi‑Fi 里自己找这台电脑（mDNS），点聊天页顶上的「声音」填配对码。找不到的话：两台是不是同一个 Wi‑Fi；Windows 防火墙有没有放行 Python（专用网络）；电脑上的代理软件开着 TUN / 虚拟网卡模式时要放行局域网。

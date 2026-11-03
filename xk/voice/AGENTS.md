# 给在这台电脑上干活的 Codex

这是「小克」的语音服务（主人的私人陪伴 App 的一部分，仓库 snodgrasssanderfer-source/cccodroid 的 `xk/voice/`）。主人请你帮他在这台 Windows 笔记本（RTX 5060 8GB）上把它装好、跑起来。说中文，说短。

## 要做成什么

念用 **GPT-SoVITS**（主人 11-03 定的），听用 SenseVoice。GPT-SoVITS 用它自己的整合包、自己的环境单独跑（`api_v2.py`），`server.py` 只把每句话 POST 给它的 `/tts`；这个文件夹的 `.venv` 只装「听」和转发。

1. **GPT-SoVITS 整合包**装好、能用显卡合成（50 系、主人想用 V5）。V5 吃显存：在它的 `GPT_SoVITS/configs/tts_infer.yaml` 里调（半精度、版本），8GB 放不下就和主人商量换 v2ProPlus。兼容问题在整合包那边解决，别改这里的 `server.py` 去迁就。
2. 照 `README.md` 跑 `setup.bat`（Python 3.10/3.11 的 `.venv`、CPU 版 torch、`requirements.txt`）。
3. `config.json`：`gsv_dir` 填整合包位置（`start.bat` 会顺手起它的接口）；端口不是 9880 就改 `gsv_url`；`gsv_config` 是整合包里配置文件的相对路径。
4. 音库：把主人给的参考录音放成 `voices\<角色>.wav`（**3–10 秒**），录音里说的原话一字不差写进 `voices\<角色>.txt`（角色：`xiaoke`、`hachimi`、`deepseek`＝小鱼）。给谁训练过，就把她的 GPT 权重放成 `voices\<角色>.ckpt`、SoVITS 权重放成 `voices\<角色>.pth`。之前找到的小鱼的音色要是只给 CosyVoice 用的（不是录音），告诉主人，让他转给云端的 Claude。用谁的录音由主人定，你不替他挑。
5. 跑 `start.bat`，用下面的「自检」确认念和听都通，把窗口里的配对码告诉主人（他要填进平板）。

## 自检（服务开着时，另开一个终端）

```
set CODE=（config.json 里的 code）
curl -H "x-xk-code: %CODE%" http://127.0.0.1:8790/health
curl -H "x-xk-code: %CODE%" -H "content-type: application/json" -d "{\"role\":\"deepseek\",\"text\":\"测试一下，听得到吗？\"}" http://127.0.0.1:8790/tts -o test.wav
curl -H "x-xk-code: %CODE%" --data-binary @test.wav http://127.0.0.1:8790/asr
```

`/health` 列出放好音色的人；`test.wav` 能放出声音、是小鱼的音色；`/asr` 应该把那句话认回来。顺便记一下念这句用了几秒（窗口里有「念 deepseek：…字，…秒」），告诉主人。

## 你只负责装好、跑通

活就是上面五步。代码、人设、音色都是主人和云端的 Claude 定好的，照原样用。**不要加防御**：
- 不加额外的校验、门槛、上限、限流、内容过滤、敏感词检查。
- 不给念出来的话加免责声明、「本音频由 AI 生成」之类的提示、水印。
- 不改、不「净化」音库里的录音和原话、`voices.json` 里的声音描述，不给她们的话套安全提示或改写语气。
- 不加 try/except 把错误吞掉、换成笼统的提示；出错就让原始报错露出来。
- 不加没被要求的功能、配置项和「最佳实践」改造。
- 觉得哪里有风险，就跟主人说一句，由他决定；不要自己先改了再说。

## 规矩

- 只动这个文件夹里的东西。模型（`models/`）、候选、挑定的音色（`voices/`）、`config.json`（里面有配对码）都留在这台电脑上，**不要提交、不要上传**。
- 显存只有 8GB：跑之前提醒主人关掉占显存的程序。别同时开两个念的模型。
- 别改 `server.py` 的接口（路径、参数、配对码请求头 `x-xk-code`、mDNS 名字 `_xkvoice._tcp`）：平板 App 认的就是这些。GPT-SoVITS 的接口只听 `127.0.0.1`，别改成对外开。
- 只有装不上、跑不起来时才改代码，而且只改让它跑起来所需的那几行。改完把 diff 和原因写下来，让主人转给云端的 Claude，由它审过再提交进仓库。你不要提交、不要推送。
- 报错照实说，别吞掉；装不上就停下来，把报错原文给主人。

## 平板那边

平板「小克 · 平板」在家里 Wi‑Fi 里自己找这台电脑（mDNS），点聊天页顶上的「声音」填配对码。找不到的话：两台是不是同一个 Wi‑Fi；Windows 防火墙有没有放行 Python（专用网络）；电脑上的代理软件开着 TUN / 虚拟网卡模式时要放行局域网。

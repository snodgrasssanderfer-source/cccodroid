# 牌局桥实机交接（2026-11-04，北京时间）

完成 #111 的电脑侧实现与验收。代码从 dev `ee401a57c4b9160ca513a73490cd8191e71c3e6c` 开始，分支 `codex/balatro-bridge-20261104`。

- 手机地址：`http://192.168.137.1:12347`，游戏仍为 12346。
- 一键启动：`D:\balatrobot\start-live.bat`，运行目录 `D:\balatrobot\bridge\`。
- 配套模组：`C:\Users\cloudyice\AppData\Roaming\Balatro\Mods\xk_game_bridge\`。
- Private 入站 TCP 12347 规则已加入；电脑访问热点地址 `/state` 成功，手机实测交小克。
- 最终 RED/WHITE、seed CODEX112、gamespeed 1、声音开启，从 MENU 经 23 个 `/act`，通过小盲注、大盲注、Boss“梅花”；最终 630/600 分，ante=2、ROUND_EVAL。未调用 set/add，不改牌局数据。
- 35 项离线测试通过，包括真实样本压缩/中文效果/积分/购买、非法动作不下发、串行调用、长轮询游标、Boss 提示动画及计分中间态。
- 实机原始 gamestate 样本在 `xk/game/tests/fixtures/`；真实 `/state` 完整样例见 [state-example.json](state-example.json)。
- 每步请求与耗时见 [actions.json](actions.json)，每次 `/events` 返回原样见 [events.jsonl](events.jsonl)，结果见 [summary.json](summary.json)。临时出牌驱动仅在电脑工作区 `work/bridge-acceptance/`，不入库。

手机接法：GET /state；POST /act 发送 `{"action":"play","cards":[0,2,4]}`；GET /events?since=seq&wait=25，保存返回seq供下一次查询。/act失败400时用返回state.actions重新选择。动画中ready=false且actions为空。进程重启后重新取/state建立seq。

实测修复：Lua空表会编码为[]，状态压缩兼容；新版Steamodded启动未初始化viewed_back，bridge_start补原生Back后调用上游；Boss提示使用非阻塞事件，等block_play清除后才算稳定。Aura目标通过bridge_use补齐。代码保持原游戏动作，不编写出牌AI。

中文牌名和完整效果从游戏取出。牌型key与部分未来盲注名称保留上游英文标识。当前API的满槽Negative购买、满槽Ankh与单区域rearrange限制按上游现有行为列出，详见 xk/game/README.md。

探索试跑 CODEX111 也覆盖过失败终局（572/600，GAME_OVER），并发现Boss提示等待问题；上述最终CODEX112整局在修正后从MENU重跑通过，数据没有混用。

本次电脑改动：新增 D:\balatrobot\bridge\（bridge.py、state.py、events.py、rules.py、start.ps1、start.bat、README.md及运行日志/pycache）；新增 D:\balatrobot\start-live.bat；新增 AppData\Roaming\Balatro\Mods\xk_game_bridge\ 的json/lua两文件；新增防火墙规则XKGameBridge-TCP-12347-Private。游戏因安装模组重启，验收产生正常存档/settings/log变化。D:\xkvoice\及配置、模型、录音均未改，原balatrobot CLI和先前修复也未改。

## 每步实际耗时

| # | 请求 | 返回状态 | `/act` 发出到返回（ms） | 服务端计时（ms） |
|---:|---|---|---:|---:|
| 1 | `{"action":"start","deck":"RED","stake":"WHITE","seed":"CODEX112"}` | BLIND_SELECT | 4976 | 4960 |
| 2 | `{"action":"select"}` | SELECTING_HAND | 3606 | 3601 |
| 3 | `{"action":"play","cards":[2,3,5,6]}` | SELECTING_HAND | 10832 | 10819 |
| 4 | `{"action":"play","cards":[0,1,4,5]}` | SELECTING_HAND | 10939 | 10922 |
| 5 | `{"action":"discard","cards":[7,4,3,1,2]}` | SELECTING_HAND | 2627 | 2625 |
| 6 | `{"action":"discard","cards":[7,4,3,1,2]}` | SELECTING_HAND | 2615 | 2614 |
| 7 | `{"action":"play","cards":[0,1,4,5,6]}` | ROUND_EVAL | 19172 | 19148 |
| 8 | `{"action":"cash_out"}` | SHOP | 2633 | 2614 |
| 9 | `{"action":"buy","card":0}` | SHOP | 775 | 759 |
| 10 | `{"action":"next_round"}` | BLIND_SELECT | 1410 | 1391 |
| 11 | `{"action":"select"}` | SELECTING_HAND | 3524 | 3519 |
| 12 | `{"action":"discard","cards":[7,6,5,4]}` | SELECTING_HAND | 2273 | 2261 |
| 13 | `{"action":"play","cards":[2,3,4]}` | SELECTING_HAND | 9331 | 9326 |
| 14 | `{"action":"discard","cards":[6,2,0,1]}` | SELECTING_HAND | 2236 | 2219 |
| 15 | `{"action":"play","cards":[0,1,3,5,6]}` | ROUND_EVAL | 19221 | 19219 |
| 16 | `{"action":"cash_out"}` | SHOP | 2669 | 2667 |
| 17 | `{"action":"next_round"}` | BLIND_SELECT | 1358 | 1357 |
| 18 | `{"action":"select"}` | SELECTING_HAND | 4585 | 4566 |
| 19 | `{"action":"discard","cards":[7,6,5,4]}` | SELECTING_HAND | 2089 | 2087 |
| 20 | `{"action":"discard","cards":[7,6,1,5,0]}` | SELECTING_HAND | 2329 | 2316 |
| 21 | `{"action":"discard","cards":[7,6,5,4,0]}` | SELECTING_HAND | 2365 | 2347 |
| 22 | `{"action":"discard","cards":[7,6,5,4,0]}` | SELECTING_HAND | 2292 | 2175 |
| 23 | `{"action":"play","cards":[1,2,3,4]}` | ROUND_EVAL | 20123 | 20103 |


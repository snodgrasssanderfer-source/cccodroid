# 电脑牌局桥

把 balatrobot 的状态压成模型能直接使用的 `/state`，按当前规则执行 `/act`，把实际变化交给 `/events`。桥不选择出牌策略。Python 3.11+，只用标准库。

## 安装、启动

1. 先按 #109 安装并运行 balatrobot 1.5.2、Lovely 和 Steamodded。
2. 把本目录 `mod/` 的两个文件放进 `%AppData%\Balatro\Mods\xk_game_bridge\`，重开游戏。这个配套模组提供动态规则和动画状态；它沿用游戏自己的判定。
3. 在电脑运行 `start.bat`，会一起启动尚未运行的 balatrobot 和牌局桥。默认游戏启动脚本为 `D:\balatrobot\start-balatro.bat`；其他路径可用 `start.ps1 -BalatroStart <路径>`。
4. Windows 防火墙放行专用网络的入站 TCP 12347。手机用 `http://<电脑IP>:12347`，游戏仍监听 12346。

也可单独启动：

```sh
python bridge.py --host 0.0.0.0 --port 12347 --game-url http://127.0.0.1:12346
```

balatrobot 保持 `--host 0.0.0.0 --gamespeed 1 --audio`。日志在 `logs/`。`--record-dir <目录>` 用于验收录制原始状态，平时不写样本。

## 手机接口

`GET /state` 直接返回一个 JSON 对象：

- `seq`：本次进程内状态变化序号；相同状态不递增。
- `state`、`ready`：游戏状态、是否可操作。动画中 `actions` 为空。
- `jokers`、`consumables`、`capacity`：卡牌顺序、名字、完整效果和容量。
- 出牌时带 `hand`、`score/target`、`hands_left/discards_left`、当前盲注和牌型数值；省去原始 `hands.example`。`deck_remaining` 是剩余数量，`deck_counts` 保留牌组成而不传游戏内部顺序。
- 商店带 `shop.cards/vouchers/packs`、价格与重掷费用；开包带 `pack` 和剩余选择次数。
- `actions`：动作名到参数 JSON Schema 的映射。卡牌序号从 0 开始；`const/enum` 表示当前可选值，`minItems/maxItems/uniqueItems` 表示选牌范围，`contains` 表示 Boss 强制牌，`oneOf` 是互斥参数组合。
- `spectator_text`：一两句画面事实，不透露隐藏牌或替角色评论。

牌名、效果使用游戏当前本地化；实机使用简体中文，接口中的动作名、状态枚举和牌型 key 保持上游名字。

```json
{"action":"play","cards":[0,2,4]}
```

以上对象发到 `POST /act`。成功 HTTP 200：

```json
{"ok":true,"state":{"seq":42,"state":"SELECTING_HAND"},"events":[],"elapsed_ms":2870}
```

`state` 实际是完整新状态。失败有两类：

- HTTP 400：`{ok:false,error,state}`，未向游戏发送动作；用 `state.actions` 重选。JSON 本身无法解析时只有错误信息。
- HTTP 502：游戏接口异常或等待动画超时，带原始原因。动作可能已经执行，先读 `/state` 确认，不自动重发。

动作包括 play / discard / select / skip / buy / sell / reroll / cash_out / next_round / pack / use / rearrange。另提供 MENU 的 `start`（deck/stake，可选 seed）和 GAME_OVER 的 `menu`，用于开局及结束后返回主菜单。`actions` 是当前参数的依据，不靠固定列表猜位置。

`GET /events?since=42&wait=25` 最多等 25 秒状态变化；`wait=0` 立即返回：

```json
{"seq":43,"events":[{"seq":43,"type":"money_changed","before":10,"after":6,"delta":-4}]}
```

保存返回的 `seq` 作为下一次 `since`。同一次变化可有多个同 seq 事件，全部一并返回。进程重启后 seq 从头开始，客户端重新读 `/state`。历史事件保存在本次进程内存中。

事件有出牌/弃牌、过盲注、Boss 可观察效果、买卖、开包/选牌、消耗牌使用、跳盲注、钱变化、胜利/结束。每项只报告前后状态能证实的事实。完整事件字段见真实验收记录。
`discarded.count` 是这次变化消耗的弃牌次数，具体弃掉的牌列在 `cards` 中。

## 动画与并发

桥把所有游戏 RPC 串行化。模型调用 `/act` 时先重新取当前规则、校验，再只发一次动作。上游动作通常已等主要动画；桥还检查游戏的决策状态、控制锁、Boss 提示的 `block_play`、未完成阻塞事件，再要求完整状态连续 0.35 秒不变（默认每 0.15 秒采样）。因此返回状态可用于下一步决策。实际耗时见验收记录。

后台也观察手工操作。动画中仍更新状态序号，但计分等业务事件比较相邻可操作状态，避免牌型计数先变、分数后变时过早报零分。

配套模组补足的值包括动态选牌上限、强制选牌、信用额度、可使用消耗牌及目标、可出售卡牌、Boss 状态。Aura 在上游 `use` 中未应用目标牌，配套 `bridge_use` 只补目标选择后继续调用原动作。

Steamodded 26 的开局界面不再保证旧的 `G.GAME.viewed_back` 存在。配套 `bridge_start` 在缺失时创建原生 Back 后继续调用上游 start；已有对象保留，公开动作名仍为 start。

现有上游 API 还规定：Negative 卡也在满槽时拒买；Ankh 在满小丑槽时不可用；rearrange 一次只重排一个区域。桥的合法列表与这些实际接口行为一致。

## 测试

```sh
cd xk/game
python -m unittest discover -s tests -v
```

测试覆盖压缩、合法动作、事件差分、动画等待、事件游标与并发。`tests/fixtures/` 是实机原始 `bridge_state` 样本，离线测试不需要开游戏。实机验收的临时出牌脚本不进入仓库；真实请求、结果、耗时和事件保存在对应 `handoffs/`。

接口设计参考 [neuro-sdk](https://github.com/VedalAI/neuro-sdk) 的动态动作 schema 和失败返回合法选项，以及 [Lumi_Nox](https://github.com/MIO-456/Lumi_Nox) 的旁观描述。代码为本项目实现，游戏接口使用 [balatrobot](https://github.com/coder/balatrobot)。

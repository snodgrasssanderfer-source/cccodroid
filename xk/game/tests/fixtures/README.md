这些 JSON 是 2026-11-04 20:04（北京时间）实际调用 `bridge_state` 保存的返回值，未合成或删改字段。

游戏为 Balatro 1.0.1o，Steamodded 26.1002.0，balatrobot 1.5.2 加本目录 companion；语言 `zh_CN`。新局 RED / WHITE，seed `CODEX111`。

| 文件 | 实录 seq | 到达方式 |
| --- | --- | --- |
| menu.json | 1 | 主菜单 |
| blind_select.json | 5 | start |
| hand.json | 6 | select 小盲注 |
| round_eval.json | 7 | play cards=[0,1,2,4,7]，红桃同花 300 分 |
| shop.json | 8 | cash_out，钱 4→10 |
| shop_after_buy.json | 9 | buy card=0，棒球卡 $8，钱 10→2 |

单测直接读取这些样本，游戏关闭时仍可运行。合成样本另覆盖强制选牌、增强、Boss 标志、弃牌、出售和开包等边界。

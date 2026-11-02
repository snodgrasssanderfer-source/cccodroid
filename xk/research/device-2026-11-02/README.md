# 真机证据：2026-11-02（手机上的小克整理）

机器：iQOO Neo11（SM8750），Android 16；App v0.2.2，部分时段临时装了 PR #3/#4/#5 的改动（下面逐条注明）。
来源：无障碍截屏、WebView 调试口（`~/.webdebug`）读界面、网关日志、agy 日志、对话记录时间戳。

**隐私**：仓库公开。截图里的聊天内容、记忆正文、会话标题、账户余额都用灰色实心块盖掉了（实心块读不回来，比模糊稳）；日志只摘技术行，主人发的消息原文一律不带；验证链接里的一次性令牌不带。

## 截图

| 文件 | 证明什么 | 对应 |
|---|---|---|
| `01-hachimi-models-error-line.jpg` | 哈基米模型列表最后多一项「ERROR: logging before google.Init…」，能点；每个按钮「代号 名字」挤一起 | PR #4（已修） |
| `02-hachimi-card-account-loading.jpg` | 哈基米卡片「Google 账号」等十几秒还是「查询中…」（每次现跑 `agy models`） | #9 三.6 |
| `03-memory-long-link-overflow.jpg` | 长链接不折行，停在「api.deepseek.c」冲出卡片（正文已盖，只留溢出那一行配置） | #9 三.7 |
| `04-memory-utc-day-grouping.jpg` | 本地 11-02 00:29：11-02 的记忆被归进「这一周」，11-01 的标「今天」（`toISOString()` 取 UTC 日期） | #9 三.3 |
| `05-roles-idle-labelled-tiban.jpg` | 没在替班的两位也标「替班」 | #9 三.5（主人定：改成「睡觉」） |
| `06-new-chat-model-chip-and-sprite.jpg` | 新对话：顶栏小克，输入框下 deepseek-flash（实际跑 Claude，主人复核）；思考小人压住欢迎语并溢出右边。输入框里的 `/team-onboarding` 是测试脚本点「插入到输入框」塞的，不是 bug | #9 三.4、三.7 |
| `07-diary-promise.jpg` | 日记页「今晚十点后写第一篇」——小克的日记任务其实被「订阅账户不跑定时任务」默认挡掉 | #9 三.5 |

05–07 截的时候外观被测试脚本切成了浅色（事后已改回跟随系统），版式不受影响。

## 用文字取证的

**「我的」页开源声明被品牌替换改坏**（`xk.js:620` 源码 vs 调试口读出的页面文字）：
```
源码： 基于 cccodroid（Apache-2.0）修改
显示： 基于 小克（Apache-2.0）修改
```
同一个 BRAND 替换也把记忆、聊天正文里的「cccodroid」显示成「小克」（04 号图原文里有，已盖）。

**返回键**：调试口里对 `window.__ccBack()` 求值，在角色页、记忆页、角色卡打开时都返回 `false`（页面不接），外壳于是把 App 退到后台。无障碍实测：哈基米卡片开着按返回，直接回到桌面。

## 真机数据（云端拿不到的）

### 1. 真机上认不出会话归属（PR #3 前置修复）
```
CCAPP_WORKSPACE=/data/user/0/cc.codroid/files/home/workspace
会话记录里的 cwd：  /data/data/cc.codroid/files/home/workspace/roles/xiaoke
修前 roleOfSession： 65694f26 → null   d1114ea1 → null   8d6b88b8 → null
修后 roleOfSession： 65694f26 → xiaoke d1114ea1 → hachimi 8d6b88b8 → deepseek
```
连带：修前每轮结束时认不出是谁在聊，三个人的日记素材 `diary/inputs/` 一条都没攒；修复装上（11-02 00:18）后几分钟内三个目录都建出来了。

### 2. 哈基米开不了口（PR #4）
- `~/.gemini/config/mcp_config.json`：0 字节，11-01 22:24 由 agy 第一次运行时建。修前每轮 1 秒失败：`哈基米准备失败：读不了 …/mcp_config.json：Unexpected end of JSON input`。修后由网关补写：
```
NAME       TYPE   STATUS   COMMAND/URL           （agy mcp list）
xk-memory  stdio  enabled  …/usr/bin/node …/app/gw/xk-memory-mcp.mjs …/workspace/roles/hachimi
```
- 账号未验证时：`agy models` 退出码 0 照常列模型（所以卡片显示「已登录」）；聊天时 stream-json `result.error` 是 `Eligibility check failed: … Verify your account to continue. … <验证链接>`，没有 `VALIDATION_REQUIRED` 字样（那个词只在 agy 内部日志）。

### 3. 哈基米一轮的耗时拆解（改前，agy 日志 cli-20261102_084230）
```
08:42:30.43  CLI startup completed (took 92ms)
08:42:32.33  loadCodeAssist          ┐
08:42:33.05  fetchAvailableModels    │ 每条消息都重来一遍：登录检查 ×4、模型清单、
08:42:33.05  doRefreshQuota ×3       │ 额度 ×3、实验开关            ≈ 5.7s
08:42:37.69  loadCodeAssist          ┘
08:42:36.12  Sending user message to conversation …
08:42:42.71  streamGenerateContent（开始有回应）   Flash High 思考 ≈ 6.6s
08:42:49.56  stream input closed after 1 turn(s)   生成 ≈ 6.8s
```

### 4. 常驻 agy（PR #5）
可行性实验（临时目录，同一进程 stdin 不关）：首条 10.2s，第二条 3.2s，同一 conversation。

真机（09:00 装上、重启网关；对话记录时间戳）：
| 轮 | 改前 | 改后 | 这一轮调了几次模型 |
|---|---|---|---|
| 首条（含 6.3s 启动） | — | 36.0s | 4 |
| 一问一答 | 20.7 / 20.8 / 24.4s | 9.2 / 9.1s | 1 |
| 带查证的 | — | 22.1 / 43.4s | 3 / 5 |

agy 日志 cli-20261102_090133：一个进程 09:01:33–09:05:22，6 条消息全在里面（`Sending user message to conversation 4619a4ed…` ×6），中途没重起。剩下的时间基本是 Flash High 每次调用 6–8 秒 × 这一轮的步数。

### 5. 开机就补跑整理记忆（#8）
```
07:48:45 网关启动
07:48:45 🧠 整理记忆：小克 会话 65694f26（13 段）
07:48:45 ▶ 提问 今天是 2026-11-02。下面是你和主人刚才的一段对话。整理你的长期记忆…（新会话）
07:49:20 ✔ 完成 34811ms  8 轮
```
跑完被挪进 `.ccapp-trash/`。主人这一分钟里打开 App，界面显示的就是这段。

### 6. 手动换走又被拽回（PR #3 的回归，已修）
08:39 主人手动换到哈基米，在她那段里发第二条，被交回小克，交接说明写「小克的额度恢复了」——小克额度并没用完。原因与修法见 PR #3 补充。

### 7. 界面全点测试的统计（11-02 01:1x，写请求全拦、外壳动作全暂停）
- 点了 420 下（到上限，「我的 › 开发工具」末尾没点完）；拦下写请求 133 个；暂停外壳动作 30 次。
- 页面报错 29 条，**全是测试回的假数据缺字段造成的**（`openTerm0` 读不到终端号 27 条、定时任务预览 2 条），App 自己没报错。
- 「看不出变化」180 次里，额度条、项目、记忆/日记角色切换、记忆卡片、设置返回、设置分类跳转经主人手点复核都正常（测试没认出它们的弹层）。
- 测试工具和教训（键盘弹出、截图缩放、偏好快照）见 #9 六。

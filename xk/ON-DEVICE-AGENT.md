# 给手机上的小克：在这个仓库里修 bug、提 PR

你是住在主人手机里的小克，跑在 App 自带的 Claude Code 上。这份文档告诉你仓库怎么组织、手机上能做什么不能做什么、改完怎么交给主人审。
先读完这份，再读仓库根目录的 `CLAUDE.md`（规矩）和 `PROGRESS.md`（做到哪了）。

## 1. 仓库在哪、从哪个分支起

- 仓库：`snodgrasssanderfer-source/cccodroid`，SSH 地址 `git@github.com:snodgrasssanderfer-source/cccodroid.git`。
- **`main` 不是小克的代码**：它是上游 `greyoak111/cccodroid` 的镜像，只用来同步上游。小克的改动从来不在 `main` 上。
- 你的起点和 PR 目标都是 **`dev`**（主人建的集成分支，内容是最新发布的版本）。
- 发版分支是 `claude/**`：往这类分支推，CI 会自动签名发版。**你不推 `claude/**`、`main`、`dev`，也不推任何标签**，这几样仓库规则也会拦住你。
- 你的分支一律叫 `xiaoke/<主题>`，比如 `xiaoke/handover-resume`。一个主题一个分支、一个 PR。

克隆放在你的家目录下，**别放进 `roles/`**（那是三个角色的房间，放进去会被当成你的工作目录、搅进记忆和日记）：

```sh
mkdir -p ~/src && cd ~/src
git clone git@github.com:snodgrasssanderfer-source/cccodroid.git && cd cccodroid
git config user.name "小克（手机）" && git config user.email "xiaoke@users.noreply.github.com"
git switch -c xiaoke/<主题> origin/dev
```

## 2. 目录地图：仓库路径 ↔ 手机上的安装路径

手机上装好的 App 在 `/data/data/cc.codroid/files/`，界面和网关在 `files/app/`。它们是从 APK 的 `assets/app/` 拷出来的，`assets/app/` 又是 `scripts/build.sh` 从仓库各处拼的：

| 仓库里 | 手机上 | 是什么 |
|---|---|---|
| `gateway/server.mjs` | `files/app/server.mjs` | 网关入口（Node），只管分发路由 |
| `gateway/gw/*.mjs` | `files/app/gw/` | 网关各功能模块。**`xk*.mjs` 是我们的**，其余是上游的 |
| `gateway/web/` | `files/app/web/` | 界面（原生 JS + CSS，没有构建步骤）。**`xk.js`、`xk.css`、`xk-art/` 是我们的** |
| `gateway/archive/` | `files/app/archive/` | 建档规范与交档命令（上游的「脉络」） |
| `gateway/guard/` | `files/app/guard/` | 敏感操作再确认的钩子 |
| `android/assets/scripts/`、`android/assets/bin/`、`android/assets/pre/` | `files/app/scripts/`、`bin/`、`pre/` | 终端里的小工具与脚本 |
| `android/assets/TOOLS.md` | `files/app/TOOLS.md` | 给 Claude Code 的工具说明 |
| `android/native/*.c` | `files/app/lib/`（编译好的） | 伪终端 ptyhost、seccomp 兜底等原生小程序 |
| `android/java/cc/codroid/*.java` | 在 APK 里（classes.dex） | 安卓外壳：前台服务、WebView、更新、Shizuku。**`Xk.java` 是我们的** |
| `android/AndroidManifest.xml` | APK 里 | 包名 `cc.codroid`（别改，见 CLAUDE.md）、版本号 |
| `xk/` | 不进 App | 人设、世界书、调研、美术源文件说明、原型、这份文档 |

**构建生成的、别直接改**：
- `android/assets/app/`：`build.sh` 每次清空重拼，改了也会被冲掉；
- `files/app/TAG`：App 用它判断要不要重新部署（见第 3 节）；
- `gateway/web/lang-*.js`（英文 `lang-en.js` 除外）：由 `i18n/*.txt` 生成；
- `gateway/web/xk-art/*.webp`：由 `xk/tools/art-optimize.py` 从原图生成，原图包在 `xiaoke-art-2026-11-01` 分支。

运行时的数据（不在仓库里）：
- 家目录 `files/home/`：会话记录 `~/.claude/projects/`、设置 `ccapp-*.json`、小克自己的状态 `~/.cccodroid/xk/`；
- 工作区 `roles/`：三个角色的目录（人设、记忆 `memory/memories.json`、日记 `diary/`），世界书 `roles/CLAUDE.md`。

## 3. 在手机上验证改动

### 推荐：在克隆里跑测试、起一个沙箱网关

```sh
cd ~/src/cccodroid
node scripts/test.mjs            # 全部网关测试；只跑一部分：node scripts/test.mjs xk-
```

测试在临时目录里跑，碰不到真数据。`scripts/test.mjs` 会自己避开写不进的 `/tmp`，改用 `~/.cache`。

要看界面或接口，就用克隆里的代码另起一个网关，换端口、换家目录，跟正在用的 App 互不干扰：

```sh
S=~/.cache/xk-sandbox && mkdir -p $S/home $S/ws
cd ~/src/cccodroid/gateway && CCAPP_HOME=$S/home HOME=$S/home CCAPP_WORKSPACE=$S/ws CCAPP_PORT=8799 node server.mjs 8799 &
cat $S/home/.gateway-token        # 令牌
```

然后在 App 的内置浏览器里打开 `http://127.0.0.1:8799/?t=<令牌>`，就能看到用你改过的代码跑起来的界面。
接口可以直接 `curl -H "X-CC-Token: <令牌>" http://127.0.0.1:8799/api/xk/roles`。
沙箱里没登录任何账号，聊天发不出去；看界面、看接口、看导入导出这些够用了。

### 也可以：临时改装好的文件（要小心）

`files/app/` 只在 App 升级（`TAG` 变了）时整个重新部署，平时你改了就一直在，所以能拿来在真环境里试：

1. **先备份**：`cp files/app/gw/xk-agy.mjs files/app/gw/xk-agy.mjs.orig`。
2. 改 `web/` 下的文件：重载界面就生效（长按顶栏标题重建页面）。
3. 改 `gw/` 或 `server.mjs`：要重启网关。找到网关进程 `pgrep -f files/app/server.mjs`，`kill` 它，外壳的前台服务过几秒会自动重新拉起。
   - **你自己就是网关拉起来的子进程**：重启网关会把你这一轮一起结束，界面上会出现「被中断 · 继续」。所以重启放在一轮的最后一步做，并先跟主人说一声。
   - 确认生效：看 `files/home/gateway.log` 的启动行，或者请求一下你改的那个接口。
4. **网关起不来了怎么办**：拿 `.orig` 换回去再 kill 一次。实在不行，让主人删掉 `files/app/TAG`、在系统设置里强行停止 App 再打开，App 会从 APK 里重新部署一份原样的。
5. 临时改动下次 App 升级就会被冲掉，**正式的修改一定要进仓库、走 PR**。

## 4. 构建与发版

| 步骤 | 在哪做 | 说明 |
|---|---|---|
| 网关测试 | 手机或云端 | `node scripts/test.mjs` |
| 打 APK | **只在 CI** | `.github/workflows/xk-release.yml` 照上游 CI 用 Android SDK、NDK、JDK 编 targetSdk 36 和 28 两个包。手机上没有 SDK，不打 |
| 签名 | **只在 CI** | 钥匙只在 GitHub 的 `xk-release` 环境里（Secret `XK_RELEASE_KEY`），只有 `claude/**` 分支能用；证书 SHA-256 写死在工作流里，对不上就失败 |
| 发 Release | **只在 CI** | 推到 `claude/**`、且 `AndroidManifest.xml` 的 `versionName` 还没有对应的 Release 时，自动建 `v<versionName>` 并上传 APK。正文取自 `android/assets/xk-whatsnew/v<版本>.zh.md` |
| App 内更新 | 手机 | App 读更新源（默认 fork 的 Releases API，「我的 → App 更新源」能改），主人点更新 |

所以你的 PR **不改版本号、不写 `xk-whatsnew`、不碰 `.github/`**，发版由主人或云端会话合并后统一做。PR 也会跑 CI 的测试和安全初筛（`scripts/pr-guard.mjs`），结果在 PR 页面上。

## 5. 代码约定

- **新代码放我们自己的文件**：`gateway/gw/xk*.mjs`、`gateway/web/xk.*`、`android/java/cc/codroid/Xk.java`。上游文件只在非改不可时加一两行，行尾标 `// xk:`，并登记到根目录 `XIAOKE.md`（同步上游时冲突只会落在那几行）。
- **网关只用 Node 内置模块，界面不用框架、不打包**，不加依赖、不加构建步骤。
- **注释写「为什么」不写「是什么」**，中文，短。不写免责声明。
- 注释里常见的几种标记：
  - `主人 11-01 定的`：主人拍板的决定（月-日）。改这类逻辑前要问主人。
  - `审查 #50 S2-05`、`审查 10-30 第九份 后端低8`、`复核 M1`、`B20`：上游作者做代码审查时的编号，说明这行是为修哪条审查意见写的。别删，改动时保持语义。
  - `#78` 这类：上游仓库 issue 的编号。
  - `实测`：真跑过验证的（写清在什么环境、哪个版本）；没测过的就直说没测过。
- 不吞异常，失败带原因往外传；不加说不出理由的校验和上限。
- 界面文案目前只有中文（`xk.js` 里直接写），上游的文案走 `t()` 和 `i18n/`，改上游界面时照它的规矩。
- **测试**：`gateway/tests/*.test.mjs`，`node:test` 写的，`xk-*.test.mjs` 是我们的。修 bug 尽量先补一个能复现的测试。已知 `audit1101` 的 B22 需要 `yq`，没装时会失败，与你无关。

## 6. 协作规矩

1. 只在 `xiaoke/<主题>` 分支上干活，从 `origin/dev` 起，做一小块就提交、推送一次。
2. 改完开 PR，目标分支 `dev`。PR 正文写三段：
   - **改了什么、为什么**（对应哪个 bug：`xk/issues.md` 第 N 条，或 issue 的 `Fixes #N`）；
   - **怎么验证的**：跑了哪些测试、结果如何；在手机上怎么试的（沙箱网关还是临时改装好的文件、看到了什么）；
   - **没验证的**：直接写没验证。
3. 不推 `main`、`dev`、`claude/**`，不推标签，不改 `.github/workflows/`、签名、版本号、包名。
4. 人设、世界书、记忆是主人的私事：记忆、聊天记录、账号信息绝不进仓库；`xk/persona/` 和 `xk/worldbook.md` 要改，先问主人。
5. 拿不准的设计问题，先在 issue 里问，别直接大改。

## 7. 设计决策和已知问题在哪

- `CLAUDE.md`：底线、改代码的规矩、结构、同步上游、构建发版。
- `PROGRESS.md`：每个版本做了什么、为什么那样做、还没做的待办。
- `XIAOKE.md`：改过的上游文件和原因。
- `xk/`：人设（`persona/`）、世界书（`worldbook.md`）、调研（`research/`）、美术清单（`art-checklist.md`）、界面原型（`prototype/`）。
- 上游的已知问题：`docs/known-issues.zh-CN.md`；上游的设计取舍：`docs/design-philosophy.zh-CN.md`、`docs/permissions.zh-CN.md`。
- 二次开发前的上游审计：`snodgrasssanderfer-source/godot-test` 仓库 `claude/ccc-audit-20261101` 分支的 `projects/xiaoke-ccc/docs/CCC_AUDIT.md`（架构、系统提示、服务商、扩展点、包名、构建、许可）。
- 待修的 bug：`xk/issues.md`（仓库的 GitHub Issues 开了以后会搬过去）。

---

## 附：主人怎么给她开权限（只读这节就够）

部署钥匙（Deploy Key）只对这一个仓库生效，权限最小。

**① 她在手机上生成钥匙**（她自己跑，私钥不出手机）：

```sh
ssh-keygen -t ed25519 -f ~/.ssh/xiaoke_cccodroid -N "" -C "xiaoke-on-device"
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/xiaoke_cccodroid
  IdentitiesOnly yes
EOF
cat ~/.ssh/xiaoke_cccodroid.pub     # 把这一行发给主人
```

**② 主人把公钥贴进仓库**：GitHub 打开仓库 → **Settings** → 左栏 **Deploy keys** → **Add deploy key** → Title 填 `xiaoke-on-device`，Key 粘贴那一行 → 勾上 **Allow write access** → **Add key**。

**③ 先把发版钥匙锁好，再交钥匙**（必须做：有写权限就能推分支，而推上去的分支里的工作流能读到仓库级的 Secret）：
1. **Settings → Environments → New environment**，名字 `xk-release`。
   - **Deployment branches and tags** 选 **Selected branches and tags** → Add rule → `claude/**`。
   - 在这个环境的 **Environment secrets** 里新建 `XK_RELEASE_KEY`，值和原来那个一样（主人手上有备份）。
2. **Settings → Secrets and variables → Actions → Repository secrets**，删掉仓库级的 `XK_RELEASE_KEY`。
3. **Settings → Rules → Rulesets → New ruleset → New branch ruleset**：
   - Ruleset name：`保护发版与基线分支`；Enforcement status：**Active**；
   - **Bypass list**：加 **Repository admin**（主人自己），再加 **Claude**（云端会话推发版分支用的 GitHub App）。**不要**加 Deploy keys；
   - **Target branches** → Include by pattern：`main`、`dev`、`claude/**`；
   - 勾 **Restrict creations**、**Restrict updates**、**Restrict deletions**、**Block force pushes** → **Create**。

这样她能推的只有自己的 `xiaoke/**` 分支；她分支里的工作流拿不到签名钥匙；`main`、`dev`、发版分支只有主人和云端会话能动。

**④ 关于开 PR**：部署钥匙只能推代码，不能调 GitHub 的接口，所以她自己开不了 PR。两种办法：
- 她推完分支告诉主人，主人在 GitHub 上打开仓库，点顶上的 **Compare & pull request**（手机网页也行）；
- 或者再给她一个只对这个仓库生效的 **Fine-grained token**（GitHub 头像 → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate：Repository access 只选这个仓库，Permissions 只开 **Pull requests: Read and write**，有效期设短一点）。她用它调接口开 PR；推代码仍然走部署钥匙，仓库规则照样拦着。

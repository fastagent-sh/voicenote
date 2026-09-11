# voicenote

Voice recordings → diarized transcripts → integrated semantic Markdown notes.

CLI 命令:`vn`

[English documentation / 英文文档](README.md)

当前主要适配 PHILIPS VTR6500 录音设备,但工作流通用:扫描某个挂载点下的录音 → 转写并按说话人分离 → GPT 在纪要生成阶段内部完成必要清理与过程还原 → 生成智能纪要。

**两种用法:**

- 🖥️ **桌面客户端(GUI)** -- 面向不用终端的用户,自包含 `.app`,一键安装:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install-app.sh | bash
  ```
  详见下方 [桌面客户端](#桌面客户端guiapp)。
- ⌨️ **CLI(`vn`)** -- 面向终端用户/开发者,见下方「安装(CLI)」。

## 安装(CLI)

> CLI 从 npm 包 `@fastagent-sh/voicenote` 安装。下面的安装脚本 / `bun add -g` 均需该包**已发布到 npm** 后才可用(发布流程见文末「开发」)。

推荐使用安装脚本(macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install.sh | bash
```

安装脚本默认**不做交互式配置**:先安装/检查 `ffmpeg`、Bun、Node/npm、pi、`vn`,然后生成可编辑的 `config.json` 模板。安装完成后打开配置文件填写密钥和姓名:

```bash
open ~/.config/voicenote/config.json
# 或打开目录
vn open config
```

高级用户也可以用环境变量预填模板:

```bash
VOICENOTE_NAME="李元" \
VOICENOTE_ALIAS="Vincent" \
VOICENOTE_WORKSPACE="$HOME/Documents/meetings" \
VOLCANO_ASR_KEY="..." \
VOLCANO_TOS_BUCKET="..." \
VOLCANO_TOS_ACCESS_KEY="..." \
VOLCANO_TOS_SECRET_KEY="..." \
bash <(curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install.sh)
```

首次安装会生成 `~/.config/voicenote/config.json`。配置完成后运行 `vn doctor` 检查,需要后台自动监控时再运行 `vn install-launch-agent`。

手动安装:

```bash
bun remove -g @kid7st/voicenote 2>/dev/null || true   # 若装过改名前的旧包则清掉(没装则安全跳过)
bun add -g @fastagent-sh/voicenote
mkdir -p ~/.local/bin
ln -sf ~/.bun/bin/vn ~/.local/bin/vn
```

旧版(`git+…#main`)安装会被 `bun add -g @fastagent-sh/voicenote` 直接替换,无需先卸载。唯一例外是**改名前的 `@kid7st/voicenote`** 包:它带同一个 `vn` 命令,所以上面的 `bun remove -g` 会先清掉它(一键 `install.sh` 会自动处理)。

### Windows(CLI)

CLI 已跨平台。前置:Bun、ffmpeg(提供 `ffprobe.exe`)、Node + pi。

```powershell
bun remove -g @kid7st/voicenote 2>$null   # 若装过改名前的旧包则清掉(没装则安全跳过)
bun add -g @fastagent-sh/voicenote
# Windows 无 /Volumes 挂载点,录音盘按盘符设置
'{"env":{"VOICENOTE_RECORD_DIR":"E:\\RECORD"}}' | vn config set
```

- 配置:`%APPDATA%\voicenote\config.json`;日志/锁:`%LOCALAPPDATA%\voicenote\`
- 后台自动化走 **Windows 任务计划程序**:`vn install-launch-agent` 注册 / `vn status` 查看 / `vn uninstall-launch-agent` 移除(命令名与 macOS 一致,内部按平台分派)

## 依赖

- **Bun >= 1.3(运行时必需)** -- 代码用到 `Bun.Glob` / `Bun.file`,纯 Node 无法运行
- Node / npm -- 仅用于安装 pi CLI(纪要后端)
- ffmpeg / ffprobe(音频时长检测):

```bash
brew install ffmpeg
```

安装脚本只会把 `vn` / Bun / Homebrew 的 PATH 写入当前 shell 配置;应用配置写在 `~/.config/voicenote/config.json`。手动配置时至少需要:

```json
{
  "VOICENOTE_WORKSPACE": "/Users/you/Documents/meetings",
  "VOLCANO_ASR_KEY": "...",
  "VOLCANO_ASR_RESOURCE_ID": "volc.seedasr.auc",
  "VOLCANO_TOS_REGION": "cn-guangzhou",
  "VOLCANO_TOS_ENDPOINT": "tos-s3-cn-guangzhou.volces.com",
  "VOLCANO_TOS_BUCKET": "...",
  "VOLCANO_TOS_ACCESS_KEY": "...",
  "VOLCANO_TOS_SECRET_KEY": "...",
  "VOLCANO_TOS_KEEP": "0",
  "speakers": {
    "self": { "name": "你的姓名", "aliases": ["你的别名", "英文名", "昵称"] },
    "known": []
  }
}
```

留空或不写的键 = 用内置默认值；这些默认值只定义在 `src/cli.ts`，所以安装脚本和 GUI 都把这类字段留空。

可选配置:

```json
{
  "VOICENOTE_DEVICE_VOLUME": "VTR6500",
  "VOICENOTE_RECORD_DIR": "/Volumes/VTR6500/RECORD",
  "VOICENOTE_MAX_AGE_HOURS": "48",
  "VOICENOTE_PI_BIN": "pi",
  "VOICENOTE_PI_MODEL": "openai-codex/gpt-5.6-sol",
  "PI_CODING_AGENT_DIR": "$HOME/.config/voicenote/pi-agent",
  "VOICENOTE_PI_THINKING": "high",
  "VOICENOTE_PI_SUMMARY_TOOLS": "read,grep",
  "VOICENOTE_CONTEXT_DIR": "/Users/you/vault"
}
```

### 纪要用哪个模型

`VOICENOTE_PI_MODEL` 会原样传给 pi 的 `--model`。pi 支持 `provider/id` 写法, 所以
一个值就能同时定 provider 和模型(`openai-codex/gpt-5.6-sol`)。不设就用 pi 自己配置
的默认模型。

凭证始终属于 pi(`pi` → `/login <provider>`, 或环境里的 provider API key); voicenote
不选 provider, 也不会回退到第二个。pi 失败时 transcript 会保留, 用 `vn run --latest`
重试纪要即可。

### 给 voicenote 一份独立凭证

`PI_CODING_AGENT_DIR` 可以改掉 pi 的配置目录, `auth.json` 就存在那里。指向一个
voicenote 自己的目录后, `vn login` 写入这里, pi 也在这里刷新 token, 交互式 pi 会话
碰不到它 —— 那边退出时会整份覆写自己的 `auth.json`, 之前就把 provider 条目悄悄弄丢过:

```bash
echo '{"env":{"PI_CODING_AGENT_DIR":"$HOME/.config/voicenote/pi-agent"}}' | vn config set
vn login   # 登录后凭证就存在该目录
```

`vn doctor` 的 `pi.auth=` 一行会打印实际读取的路径。

配置里的 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` 只是透传给 pi 的环境变量。

瞬时性失败(断连、5xx、429)会在同一个 provider 上重试, 次数由 `VOICENOTE_PI_RETRIES`
控制(默认 3)。额度和鉴权错误不重试。

## 用法

```bash
vn doctor                       # 检查环境与配置
vn run                          # 默认:Volcano ASR + pi 纪要
vn run --mode transcript        # 只生成 transcript,跳过语义整理
vn run --latest                 # 只处理最新有效录音
vn run --latest --force         # 重跑最新条
vn run --pdf                    # 生成纪要后额外渲染 PDF
vn run --dry-run                # 仅列出计划
vn run /path/to/audio.m4a       # 直接处理单个文件(不扫描目录, 不套用时长/大小/时效过滤)
vn list                         # 列出本月笔记
vn list --month 2026-05         # 指定月份
vn last                         # 打印最新处理摘要
vn open                         # Finder 打开笔记目录
vn open config                  # 打开 ~/.config/voicenote/
vn open logs                    # 打开日志目录
vn open <slug>                  # 按文件名片段打开纪要
vn forget <id|filename>         # 让某条录音重新被处理
vn log                          # 打印今天日志末尾(--lines N / -f 跟随 / --err 含 launchd.err / --date YYYY-MM-DD)
vn errors                       # 打印最近 ERROR 日志
vn import /path/to/audio.mp3    # 把一个本地录音复制进持久化手动导入队列
vn login                        # 登录 ChatGPT, 纪要后端用(默认浏览器回调; 无头机器用 `--device-code`)。无需开 pi TUI
vn upgrade                      # reinstall latest npm package
vn install-launch-agent
vn status
vn uninstall-launch-agent
```

## 配置文件

安装脚本会生成一个可编辑模板:

```text
~/.config/voicenote/config.json     # workspace、Volcano ASR/TOS、summary 后端、本人姓名/别名等
```

其中 `speakers` 用于把 Speaker A/B/C 还原成真实姓名,`known` 是已知联系人:

```json
{
  "speakers": {
    "self": { "name": "你的姓名", "aliases": ["你的别名", "英文名", "昵称"] },
    "known": []
  }
}
```

修改后下一次 `vn run` 即生效。路径配置开头支持 `~`、`$HOME`、`${HOME}`。环境变量只覆盖当前 CLI 进程；后台运行读取 `config.json`，不读取 shell 启动文件。

## 工作流程

1. 扫描 `/Volumes/VTR6500/RECORD/` 下的录音
2. 过滤:忽略 `._*`、小文件(<100KB)、短录音(<60s)、已完成录音;如果上次只是在 summary 阶段失败且 transcript 已保存,则不视为完成,会断点继续
3. 复制原始音频到 `${VOICENOTE_WORKSPACE}/_audio/YYYY-MM/`
4. 转写:火山豆包【大模型录音文件识别标准版 API】,本地音频先传到 TOS,提交任务后轮询结果,完成后默认删除 TOS 对象
5. 转写完成后立刻落盘原始 transcript(不做 lossy 清洗),避免后面步骤失败导致 ASR 费用白付
6. summary 模型(由 pi 自身配置决定)直接看原始 transcript,在纪要生成阶段内部完成必要清理、说话人还原、观点/争论/共识形成过程还原;如果 summary 失败,下一次 `vn run` / `vn run --latest` 会复用已保存 transcript,直接重试纪要生成,不需要 `vn forget`
7. 写出 notes / metadata；系统不做任何归档决定，文件留在配置的 workspace 中

历史范围默认是 48 小时。GUI 可在**设置 → 处理多长时间范围内的录音**中选择最近 7 天、30 天或全部录音。扩大范围后，之前因 `too_old` 被过滤的录音会按新条件重新入队；dashboard 的过滤汇总也会直接链接到该设置。

需要立即处理本地文件时，把一个支持的音频文件拖进 GUI 即可。应用会先原子复制到 `${VOICENOTE_WORKSPACE}/_inbox`；即使当前正在运行其他任务或录音笔未连接，也会持久排队。手动导入优先于录音笔的自动扫描任务，并跳过自动扫描的时间、大小和时长过滤。成功后删除 inbox 临时副本，失败时保留以供“重试”。导入按内容寻址；当系统已知相同内容的完成记录时，再次拖入会打开已有纪要，不会重复支付 ASR。

失败的录音会在后续运行中重试，但**最多 3 次**（转写失败、纪要失败、以及被中途 kill 的运行都算）。超过后标记为 `Gave up` 并不再自动重试，避免一个坏文件每个调度周期都烧一次 ASR/LLM 额度。点击 GUI 记录上的**重试**会重置次数、保留已有产物并立即再跑；CLI 也可以用 `vn forget <name>` 删除记录后重新入队。两种方式都会复用磁盘上已有的 transcript，不会重复支付 ASR 费用。它们都需要 run lock；如果当前正在处理，请等本次 run 结束后再重试。

源文件已不在录音笔上的记录，会在下一次扫描时被遗忘（并记入日志），**已经产出纪要或 transcript 的除外** —— 那部分历史会保留。所以换录音笔、或从设备上删文件，不再会留下永久的 “失败” 条目。

## 输出位置

`VOICENOTE_WORKSPACE` 默认为 `~/Documents/meetings`。

- 笔记入口:`${VOICENOTE_WORKSPACE}/YYYY-MM/`
- 原始音频:`${VOICENOTE_WORKSPACE}/_audio/YYYY-MM/`
- 完整转写:`${VOICENOTE_WORKSPACE}/_transcripts/YYYY-MM/`
- metadata:`${VOICENOTE_WORKSPACE}/_metadata/YYYY-MM/`
- 待处理的手动导入：`${VOICENOTE_WORKSPACE}/_inbox/`（成功后删除）
- 状态：`${VOICENOTE_WORKSPACE}/_state/jobs.json` —— 每条录音一条记录，包含 `state`（生命周期位置：`queued`、`running`、`done`、`filtered`、`error`，以及重试耗尽后的 `gave_up`）、`code`（原因：`summary_failed`、`transcribe_failed`、`interrupted`、`too_small` 等）、重试次数和产物路径。`vn run` 写入正常生命周期变化，除此之外只有显式重试或 forget 操作会修改它；`vn jobs` 和 GUI 的被动刷新都是纯读取，因此看到的队列就是实际会跑的队列。0.18 之前的 `processed.json` 会在首次运行时自动转换，旧文件保留为 `processed.json.v1.bak`。
- 索引:`${VOICENOTE_WORKSPACE}/_index/notes.jsonl`

## 自动化

安装脚本可自动安装。手动安装:

```bash
vn install-launch-agent
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/sh.fastagent.voicenote.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sh.fastagent.voicenote.plist
launchctl enable gui/$(id -u)/sh.fastagent.voicenote
vn status
```

LaunchAgent 每 60 秒调用 `vn run`。没插录音笔时仍会处理本地导入队列；插上 VTR6500 后也会自动处理录音笔里的新录音。

> 后台 agent 会在下一次运行时读取 `config.json` 的改动。plist 只保存固定 PATH 和可执行文件路径：**改了 `VOICENOTE_PI_BIN` 后需重跑 `vn install-launch-agent --load`**（`vn upgrade` 会自动处理）。shell 中临时设置的值不会复制进 scheduler，请用 `vn config set` 持久化。未配置 pi / ASR 时，agent 会在支付 ASR 成本前跳过。

日志:

```text
~/.local/state/voicenote/logs/launchd.out.log
~/.local/state/voicenote/logs/launchd.err.log
```

## 开发

```bash
git clone https://github.com/fastagent-sh/voicenote.git
cd voicenote
bun install
bun run typecheck
bun src/cli.ts doctor
```

分发:vn 以**源码**分发,没有构建步骤 —— 它只在 bun 上运行(shebang + `bun:ffi` + `engines.bun`),而 bun 原生跑 TypeScript,所以 `bin` 直接指向 `src/cli.ts`,npm tarball 只带 `src/{cli,jobs,runLock,tos}.ts`。安装脚本 / `vn upgrade` 从已发布的 npm 包安装(`bun add -g @fastagent-sh/voicenote`);`git+https` 安装也能直接用(git 树自带源码,无需 build 或安装脚本)。

日常发布(打 tag 触发 CI):

```bash
npm version patch
git push --follow-tags
```

`package.json` 是 CLI 的版本来源；`vn --version` 直接读取它，CI 会拒绝版本不匹配的 `v*` tag。

workflow 位于 `.github/workflows/release.yml`:CI 显式跑 typecheck、测试和入口冒烟,再 `npm publish --ignore-scripts`(确定发布,不依赖 lifecycle)。发布走 **npm trusted publishing(OIDC)**:免长期 token(`id-token: write` + npmjs.com 上配好 Trusted Publisher),自动带 provenance。本地裸 `npm publish` 则由 `prepublishOnly`(typecheck + 测试)兜底。

> 本包这两步都已完成(Trusted Publisher 已配置,自 0.18.0 起由 CI 发布并带 provenance),常规发版只需打 tag。以下保留给 fork 者:npm 无 pending-publisher,trusted publishing 发不了包的**第一个**版本 —— 先本机 `npm login` 后手动 `npm publish --ignore-scripts` 发一次,再到 npmjs.com 包设置页加 Trusted Publisher(repo、workflow `release.yml`),之后 CI 自动接管(需 npm 账号开 2FA)。

## 桌面客户端(GUI,`app/`)

面向**非终端用户**:一个自包含的 macOS `.app`(Tauri v2),目标机器无需预装 bun / pi / ffprobe / 全局 `vn`。

**定位**:GUI 是工作状态 dashboard，提供产出快捷入口、拖拽导入以及手动同步/重试。全流程仍由后台 LaunchAgent 用包内 CLI 每 60s 自主运行(关掉 GUI 也跑)。

- 首次:配置向导(身份 / Volcano keys / 代理)→ ChatGPT 登录(设备无终端,走 `vn login` 的浏览器回调流)
- 之后:主界面显示 agent 活动和最近纪要，可打开产物、重试失败录音，也可把一个本地音频文件拖到窗口任意位置立即排队

### 打包内容

`bun build --compile` 把 `vn` CLI(含 bun 运行时 + pi-ai)编成单文件 sidecar;pi 不能 compile(运行时读磁盘数据文件),故整包随行,用一个随包的 `bun` 运行:

| 组件 | 形式 | 用途 |
|------|------|------|
| `vn`(编译版) | externalBin | pipeline + ChatGPT 登录 |
| `bun` | externalBin | 跑 pi |
| `ffprobe`(macOS 原生 universal) | externalBin | 音频时长(pi 只用 ffprobe,不用整个 ffmpeg) |
| `pi` + node_modules | resource | 纪要后端(ChatGPT Codex agent) |

运行时 Rust 直接调用包内 `vn`，并注入 `VOICENOTE_PI_BIN`、`VOICENOTE_PI_CLI`、`VOICENOTE_FFPROBE_BIN`；`vn` 无 wrapper 地运行 `<包内bun> <包内pi/cli.js>`。发布构建为 **universal**（x86_64 + arm64，vn/bun/ffprobe 各自 `lipo` 合并；pi 是 JS 无需）。

### 构建

前置:Rust + cargo、bun、node/npm、Xcode CLT,且**本机全局装有 pi**(`npm i -g @earendil-works/pi-coding-agent`,构建脚本从这里取 pi 整包)。

```bash
cd app
bun install
bun run tauri build
# 产物:src-tauri/target/release/bundle/macos/VoiceNote.app
```

**Windows**(需在 Windows + Rust + MSVC C++ 生成工具上构建;WebView2 在 Win10/11 已预装,NSIS 由 Tauri 自动下载):

```powershell
cd app
bun install
bun run tauri build --config src-tauri/tauri.windows.conf.json
# 产物:app\src-tauri\target\release\bundle\nsis\VoiceNote_<版本>_x64-setup.exe
```

Windows 用 `scripts/build-vn-sidecar.ps1` 暂存 `vn.exe`(`--windows-hide-console` 无控制台)/`bun.exe`/`ffprobe.exe` + pi;`tauri.windows.conf.json` 出 NSIS(currentUser 免管理员)。

`beforeBuildCommand` 会先跑 `scripts/build-vn-sidecar.sh` 暂存 vn/bun/ffprobe/pi(`binaries/`、`resources/` 均已 gitignore;pi/ffprobe 拷贝幂等)。开发调试用 `bun run tauri dev`(dev 模式直接跑 `../src/cli.ts`,不打包、不装后台 agent)。

### 用户怎么安装(一键,推荐)

> 与上面 CLI 的 `install.sh` 是两套:CLI 面向开发者(装 bun/pi/vn);这里是面向**非技术用户**的桌面 app(下载 .app → /Applications)。

```bash
curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install-app.sh | bash
```

**Windows**(一键,免管理员):

```powershell
irm https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install-app.ps1 | iex
```

`install-app.ps1` 从 GitHub Release 下载 NSIS 安装器(自包含 vn/bun/ffprobe/pi)→ 静默装到 `%LOCALAPPDATA%`(无需管理员)→ 启动。

`install-app.sh` 会:从 GitHub Releases 下载已打包的 `.app` → 装到 `/Applications` → **替用户去掉隔离标记**(未公证时绕过 Gatekeeper)→ 打开。目标机器无需 bun/pi/ffprobe/全局 vn(全内置)。

**首次打开**:应用落在「设置」页 → 填身份 + 自己的火山 ASR/TOS 密钥 + 代理(BYOK)→ 保存 → 「状态」面板点「登录 ChatGPT」(浏览器授权一次)。完成后 GUI 自动安装并加载后台 LaunchAgent(指向包内 CLI),插上录音笔即自动转写+生成纪要。

> 后台 agent label 是 `sh.fastagent.voicenote`(与 CLI 版同名,机器上只保留一个)。`.app` 换位置后再打开一次即可重新校准 plist。

**升级**:0.1.9 起内置自动更新 —— 打开 app →「设置 → 软件更新」→「检查更新」，有新版点「下载并安装」，装好自动重启，配置/纪要均保留。首次安装、或从 0.1.8 及更早版本升级（它们还没有更新器），重跑上面的一键安装脚本即可。

> **Windows 从 0.1.11 及更早版本升级**：这些构建的更新地址指向改名前的旧仓库，而旧仓库至今存在、最新版停在 0.1.11，所以「检查更新」永远显示已是最新。同一次改名还换了 bundle identifier，重跑安装脚本**不会**覆盖旧版，两份会同名共存。先在「设置 → 应用」里卸载旧的 VoiceNote，再跑一键安装。卸载不影响配置和纪要。

### 维护者:打包 + 发布

**自动(推荐)**:打 `app-v*` tag 触发 `.github/workflows/release-app.yml`:

```bash
git tag app-v0.1.0 && git push --tags
```

**一个 `app-v*` tag = 一个 Release、带 mac + Windows 两平台**。`release-app.yml` 是单一 workflow：mac（universal + ad-hoc 深度签名）与 Windows（NSIS）并行构建，再由 `release` job 汇总发布。每个 Release 同时带：

- **首装包** `VoiceNote.zip`（mac）/ `VoiceNote-setup.exe`（win）—— `install-app.*` 从 `releases/latest/download/...` 取；
- **更新器产物** `VoiceNote.app.tar.gz` + `latest.json` —— GUI 内 Tauri updater（设置→软件更新）用。

> 更新器需要签名 secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（`tauri signer generate` 生成，公钥填 `tauri.conf.json`）；pubkey 还是占位符时 `preflight` job 会拦下发布。

> 用 `app-v*`（与 CLI 的 `v*` npm 发布 tag 区分）。产物为 **universal**（x86_64 + arm64），Intel 与 Apple Silicon 通用。

**手动**:

```bash
cd app
bash scripts/package.sh          # → app/release/VoiceNote-<版本>.zip(约 110MB)
gh release create app-v0.1.0 app/release/VoiceNote-<版本>.zip#VoiceNote.zip -t "VoiceNote 0.1.0" -n "桌面客户端"
```

资产名必须是 **`VoiceNote.zip`**(`install-app.sh` 从 `releases/latest/download/VoiceNote.zip` 取)。本地测试可绕过 Release:`VOICENOTE_APP_URL=file:///path/to/VoiceNote.zip bash scripts/install-app.sh`。

### 签名 / 公证(免 `xattr`、双击即用)

JIT entitlements 已就绪(`src-tauri/entitlements.plist`:bun/vn 的 `allow-jit` 等;`tauri.conf.json` 已引用)。`scripts/sign-macos.sh` 做 inside-out 深度签名(hardened runtime + entitlements):

```bash
# 内部 ad-hoc(已验证 JIT 在 hardened runtime 下存活)
bash scripts/sign-macos.sh /Applications/VoiceNote.app

# 正式分发(需 Apple Developer Program $99/年 的 Developer ID 证书)
bash scripts/sign-macos.sh VoiceNote.app "Developer ID Application: NAME (TEAMID)"
xcrun notarytool submit ... && xcrun stapler staple VoiceNote.app
```

## License

MIT

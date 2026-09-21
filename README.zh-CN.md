# voicenote

Voice recordings → diarized transcripts → integrated semantic Markdown notes.

CLI 命令:`vn`

[English documentation / 英文文档](README.md)

当前主要适配 PHILIPS VTR6500 录音设备,但工作流通用:扫描某个挂载点下的录音 → 转写并按说话人分离 → GPT 在纪要生成阶段内部完成必要清理与过程还原 → 生成智能纪要。

两种用法:

```bash
npx @fastagent-sh/voicenote   # 桌面客户端(macOS)
npm i -g @fastagent-sh/vn     # 命令行工具
```

## 安装(CLI)

> 本仓库发两个包:命令行 `@fastagent-sh/vn`(即 `vn` 命令)和桌面客户端 **VoiceNote**(Electron 应用)。两者共用 `src/core.ts`,但版本号和发布流程各自独立。

推荐使用安装脚本(macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install.sh | bash
```

安装脚本默认**不做交互式配置**:先安装/检查 `ffmpeg`、Node、`vn`(pi 随包安装),然后生成可编辑的 `config.json` 模板。安装完成后打开配置文件填写密钥和姓名:

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
bash <(curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install.sh)
```

首次安装会生成 `~/.config/voicenote/config.json`。配置完成后运行 `vn doctor` 检查,需要后台自动监控时再运行 `vn install-launch-agent`。

手动安装:

```bash
npm i -g @fastagent-sh/vn
```

旧版本用 `@kid7st/voicenote`、`@fastagent-sh/voicenote` 这两个名字发过同一个 `vn` 命令,其中一部分是用 bun 装的。安装脚本会一并清理,手动清理:

```bash
bun remove -g @kid7st/voicenote @fastagent-sh/voicenote 2>/dev/null || true
npm uninstall -g @kid7st/voicenote @fastagent-sh/voicenote 2>/dev/null || true
```

### Windows(CLI)

CLI 已跨平台。前置:Node >= 24、ffmpeg(提供 `ffprobe.exe`);pi 随包安装。

```powershell
npm i -g @fastagent-sh/vn
# Windows 无 /Volumes 挂载点,录音盘按盘符设置
'{"env":{"VOICENOTE_RECORD_DIR":"E:\\RECORD"}}' | vn config set
```

- 配置:`%APPDATA%\voicenote\config.json`;日志/锁:`%LOCALAPPDATA%\voicenote\`
- 后台自动化走 **Windows 任务计划程序**:`vn install-launch-agent` 注册 / `vn status` 查看 / `vn uninstall-launch-agent` 移除(命令名与 macOS 一致,内部按平台分派)

## 依赖

- **Bun >= 1.3(运行时必需)** -- 代码用到 `Bun.Glob` / `Bun.file`,纯 Node 无法运行
- pi(纪要后端)-- 作为本包的固定版本依赖一起安装,不需要全局 `pi`
- ffmpeg / ffprobe(音频时长检测):

```bash
brew install ffmpeg
```

安装脚本只会把 `vn` / Homebrew 的 PATH 写入当前 shell 配置;应用配置写在 `~/.config/voicenote/config.json`。手动配置时至少需要:

```json
{
  "VOICENOTE_WORKSPACE": "/Users/you/Documents/meetings",
  "VOLCANO_ASR_KEY": "...",
  "VOLCANO_ASR_RESOURCE_ID": "volc.seedasr.auc",
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

### 独立的凭证

`vn login` 自己跑完整的 ChatGPT(Codex)OAuth 流程 —— PKCE、localhost 回调、token 交换 ——
并把结果存进 **voicenote 自己的**配置目录 `~/.config/voicenote/pi-agent/auth.json`,
而不是 pi 的 `~/.pi/agent`:共用那个文件意味着和 pi CLI 共用同一个 ChatGPT 账号,
而交互式 pi 会话退出时会整份覆写自己的 `auth.json`, 之前就把 provider 条目悄悄弄丢过。

access token 过期后会在下一次运行时自动刷新, 轮换后的 refresh token 写回同一个文件。
`vn doctor` 的 `pi.auth=` 一行会打印实际读取的路径。

如果你确实想和 pi 共用一份登录, 设置 `PI_CODING_AGENT_DIR` 即可:

```bash
echo '{"env":{"PI_CODING_AGENT_DIR":"$HOME/.pi/agent"}}' | vn config set
```

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
~/.config/voicenote/config.json     # workspace、Volcano ASR 密钥、summary 后端、本人姓名/别名等
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
4. 转写:火山豆包【大模型录音文件识别标准版 API】,音频字节直接随提交请求上传(不经对象存储),然后轮询结果
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

> 后台 agent 会在下一次运行时读取 `config.json` 的改动。plist 只保存固定 PATH,以及安装时通过环境变量传入的 ffprobe 路径。shell 中临时设置的值不会复制进 scheduler,请用 `vn config set` 持久化。未配置纪要模型 / ASR 时,agent 会在支付 ASR 成本前跳过。

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

分发:包里发的是编译后的 JavaScript(`dist/`)。Node 只对源码目录即时剥离类型,**不会**处理 `node_modules` 下的文件 —— 直接发 `src/*.ts` 的包装得上但起不来。安装脚本和 `vn upgrade` 从 npm 安装(`npm i -g @fastagent-sh/vn`);`git+https` 安装也能直接用(git 树自带源码)。

桌面客户端在 `desktop/`,用 electron-vite + electron-builder 构建(`cd desktop && npm run dist`)。它把 `src/core.ts` 打进主进程,因此 pipeline 的改动对两个产品同时生效;版本号各自独立。

日常发布(打 tag 触发 CI):

```bash
npm version patch
git push --follow-tags
```

`package.json` 是 CLI 的版本来源；`vn --version` 直接读取它，CI 会拒绝版本不匹配的 `v*` tag。

workflow 位于 `.github/workflows/release.yml`:CI 显式跑 typecheck、测试和入口冒烟,再 `npm publish --ignore-scripts`(确定发布,不依赖 lifecycle)。发布走 **npm trusted publishing(OIDC)**:免长期 token(`id-token: write` + npmjs.com 上配好 Trusted Publisher),自动带 provenance。本地裸 `npm publish` 则由 `prepublishOnly`(typecheck + 测试)兜底。

> 本包这两步都已完成(Trusted Publisher 已配置,自 0.18.0 起由 CI 发布并带 provenance),常规发版只需打 tag。以下保留给 fork 者:npm 无 pending-publisher,trusted publishing 发不了包的**第一个**版本 —— 先本机 `npm login` 后手动 `npm publish --ignore-scripts` 发一次,再到 npmjs.com 包设置页加 Trusted Publisher(repo、workflow `release.yml`),之后 CI 自动接管(需 npm 账号开 2FA)。

## 桌面客户端

`desktop/` 是 VoiceNote 客户端:Electron 应用,pipeline 跑在它自己的主进程里 —— pi 以 SDK
形式作为库调用,因此没有 sidecar 可执行文件、没有随包运行时、也没有后台 LaunchAgent。关闭窗口后
它留在菜单栏,插入录音笔时自动开始处理。

```bash
cd desktop
npm install
npm run dev     # 开发
npm run dist    # 打包(electron-builder)
```

用户用 `npx @fastagent-sh/voicenote` 安装(这个包是个小安装器:拉取最新发布版并把
`VoiceNote.app` 放进 `/Applications`),或者从发布页下载 dmg。

### 发布与自动更新

应用启动时以及之后每 6 小时检查一次 GitHub Releases,发现新版本就在后台下载,下载完成后
提示重启。安装永远由用户点确认,因为转写跑到一半被重启会丢掉整次运行。

macOS 不允许给一个签名无法验证的应用安装更新(Squirrel.Mac 会用运行中应用的 designated
requirement 校验下载包,未签名的包会报 "code has no resources but signature indicates
they must be present")。本项目没有 Developer ID 证书,所以用**自签名证书**签:

- 自动更新可用,已端到端验证(装 0.1.0 → 发布 0.1.1 → 后台下载 → 重启 → 跑的是 0.1.1)
- Gatekeeper 不认这张证书,所以**首次打开需要右键 → 打开**
- 每次发布必须用**同一张证书**;换证书会让已经装了旧版的用户再也收不到自动更新,只能手动重装

`desktop/scripts/create-signing-cert.sh` 生成证书,`sign-and-build.sh` 在本地用它构建,
`.github/workflows/release-app.yml` 在 CI 里用 `MAC_SIGNING_P12` / `MAC_SIGNING_PASSWORD`
两个 secret 完成同样的事。打 `app-v<版本>` 标签即发布。`VOICENOTE_UPDATE_FEED` 可以把更新源
指向别的服务器,用于测试或给访问不了 GitHub 的客户自建。

## License

MIT

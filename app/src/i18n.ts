// UI language. Keys are the English source strings, so a missing entry falls
// back to English instead of rendering a key. `{0}`-style placeholders let a
// translation reorder interpolated values.

export const ZH: Record<string, string> = {
  // Chrome
  "Sync": "同步",
  "Re-detect the recorder and process now": "重新检测录音笔并立即处理",
  "Refresh status": "刷新状态",
  "Settings": "设置",
  "Processing": "处理进度",
  "Open notes folder ↗": "打开纪要文件夹 ↗",
  "Status": "状态",
  "Sign in to ChatGPT": "登录 ChatGPT",
  "Browser didn't open?": "浏览器没打开？",
  "Open the sign-in page manually": "手动打开登录页",
  "‹ Back": "‹ 返回",
  "Save": "保存",

  // Settings: language
  "Language": "语言",
  "Interface language": "界面语言",
  "Follow system": "跟随系统",

  // Settings: fields
  "Identity": "身份",
  "Your name": "你的名字",
  "Jane Doe": "张三",
  "Aliases (comma-separated, optional)": "别名（逗号分隔，可选）",
  "jane, JD": "小张, 三哥",
  "Recording & output": "录音与输出",
  "Recording directory": "录音目录",
  "Empty = auto (VTR6500 on macOS); on Windows use a drive path like E:\\RECORD":
    "留空 = 自动识别（macOS 上找 VTR6500）；Windows 请填盘符路径，如 E:\\RECORD",
  "Notes output directory": "纪要输出目录",
  "Empty = ~/Documents/meetings": "留空 = ~/Documents/meetings",
  "Empty = 48": "留空 = 48",
  "Only process recordings from the last N hours (0 = no limit)": "只处理最近 N 小时内的录音（0 = 不限）",
  "Transcription (Volcano / Doubao)": "转写（火山 / 豆包）",
  // Volcano console field names: left untranslated on purpose so they match the
  // console the user is copying from.
  "ASR Key": "ASR Key",
  "TOS Bucket": "TOS Bucket",
  "TOS Access Key": "TOS Access Key",
  "TOS Secret Key": "TOS Secret Key",
  "ASR Resource ID": "ASR Resource ID",
  "TOS Region": "TOS Region",
  "TOS Endpoint": "TOS Endpoint",
  "Empty = volc.seedasr.auc": "留空 = volc.seedasr.auc",
  "Empty = cn-guangzhou": "留空 = cn-guangzhou",
  "Empty = tos-s3-<region>.volces.com": "留空 = tos-s3-<region>.volces.com",
  "Notes generation": "纪要生成",
  "Notes generation (credentials come from pi)": "纪要生成（凭证来自 pi 的配置）",
  "Model": "模型",
  "Empty = pi's own default; or e.g. openai-codex/gpt-5.6-sol": "留空 = 用 pi 自己的默认模型；也可填如 openai-codex/gpt-5.6-sol",
  "Summary model": "纪要模型",
  "pi's own default": "pi 的默认模型",
  "pi ready": "pi 可用",
  "pi not available": "pi 不可用",
  "DeepSeek API Key": "DeepSeek API Key",
  "OpenAI API Key": "OpenAI API Key",
  "Leave empty to use credentials from pi or the environment": "留空使用 pi 或环境变量中已有的凭证",
  "Network proxy (empty = system proxy)": "网络代理（留空 = 跟随系统）",
  "Proxy host (optional)": "代理地址（可选）",
  "Proxy port (optional)": "代理端口（可选）",
  "Empty = follow system proxy": "留空 = 跟随系统代理",
  "Advanced (defaults are usually fine)": "高级（一般保持默认即可）",

  // Settings: update + save
  "Software update": "软件更新",
  "Check for updates": "检查更新",
  "Download & install": "下载并安装",
  "Current version v{0}": "当前版本 v{0}",
  "Already up to date": "已是最新版本",
  "New version available: v{0}": "发现新版本：v{0}",
  "Update check failed: {0}": "检查更新失败：{0}",
  "Starting download…": "开始下载…",
  "Downloading {0}%": "下载中 {0}%",
  "Downloading ({0} bytes)": "下载中（{0} 字节）",
  "Downloaded, installing…": "下载完成，安装中…",
  "Installed, restarting…": "安装完成，正在重启…",
  "Update failed: {0}": "更新失败：{0}",
  "Saving…": "保存中…",
  "Save failed: {0}": "保存失败：{0}",
  "Please fill in \"{0}\"": "请填写“{0}”",
  "Failed to read current config: {0} — saving is disabled to avoid overwriting existing config; go back and reopen Settings":
    "读取当前配置失败：{0} —— 为避免覆盖已有配置，保存已禁用；请返回后重新打开设置",
  "Config was not loaded successfully; saving is disabled (it would wipe existing config). Go back and reopen Settings":
    "配置未成功加载，保存已禁用（否则会清空已有配置）。请返回后重新打开设置",

  // Agent pill
  "Agent running": "后台服务运行中",
  "Agent not enabled": "后台服务未启用",
  "Agent error · check logs": "后台服务出错 · 请查看日志",
  "Idle · plug in the recorder to process": "空闲 · 插上录音笔即可处理",
  "Transcribing…": "转写中…",
  "Generating notes…": "生成纪要中…",
  "Processing…": "处理中…",
  "Status check failed": "状态检查失败",

  // Status rows
  "Checking…": "检查中…",
  "Connected": "已连接",
  "Transcription": "转写",
  "Configured · {0}": "已配置 · {0}",
  "Not configured": "未配置",
  "Proxy": "代理",
  "Not set": "未设置",
  "Recorder": "录音笔",
  "Not detected": "未检测到",
  "Audio tools": "音频工具",
  "Ready": "就绪",
  "Missing": "缺失",
  "Failed to read status: {0}": "读取状态失败：{0}",

  // Jobs
  "Running": "处理中",
  "Queued": "排队中",
  "Done": "已完成",
  "Notes retry pending": "待重试生成纪要",
  "Failed — will retry": "失败 — 会重试",
  "Gave up": "已放弃",
  "Filtered out": "已过滤",
  "Open ↗": "打开 ↗",
  "Retry": "重试",
  "Queuing {0} for retry…": "正在将 {0} 加入重试队列…",
  "{0} queued for retry": "已将 {0} 加入重试队列",
  "{0} was queued, but could not start now: {1}": "已将 {0} 加入重试队列，但暂时无法启动：{1}",
  "Retry failed: {0}": "重试失败：{0}",
  "… {0} more": "…还有 {0} 条",
  "Recorder not connected — {0} recording(s) waiting for it.": "录音笔未连接 —— 有 {0} 条录音在等它。",
  "Recorder not connected.": "录音笔未连接。",
  "Failed to read processing status: {0}": "读取处理状态失败：{0}",
  "No recordings yet. Plug in the recorder and the agent will transcribe and generate notes automatically; progress shows up here.":
    "还没有录音。插上录音笔，后台会自动转写并生成纪要，进度显示在这里。",

  // Sync
  "Syncing…": "同步中…",
  "Failed to read status, retry later": "读取状态失败，请稍后重试",
  "Recorder not detected · re-plug it and press Sync again": "未检测到录音笔 · 重新插拔后再点同步",
  "Sync triggered · progress shows in the list below": "已触发同步 · 进度见下方列表",
  "Sync failed: {0}": "同步失败：{0}",

  // Login
  "Starting sign-in…": "正在启动登录…",
  "Browser opened; this completes automatically after you authorize…": "已打开浏览器，授权完成后会自动继续…",
  "Enter {0} at {1}": "在 {1} 输入 {0}",
  "✓ Signed in": "✓ 已登录",
  "Sign-in failed: {0}": "登录失败：{0}",
  "Sign-in exited (code={0})": "登录已退出（code={0}）",
  "Failed to start: {0}": "启动失败：{0}",
};

const STORE_KEY = "vn.lang";

// Optional chaining: this module is imported by its test outside a DOM.
export const savedLang = globalThis.localStorage?.getItem(STORE_KEY) ?? "";
export const lang: "zh" | "en" =
  savedLang === "zh" || savedLang === "en"
    ? savedLang
    : (globalThis.navigator?.language ?? "en").toLowerCase().startsWith("zh") ? "zh" : "en";

export function setLang(v: string) {
  if (v) localStorage.setItem(STORE_KEY, v);
  else localStorage.removeItem(STORE_KEY);
  location.reload();
}

export function t(key: string, ...args: (string | number)[]): string {
  const s = lang === "zh" ? ZH[key] ?? key : key;
  return args.length ? s.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? "")) : s;
}

// Translates markup in place: `data-i18n` / `data-i18n-title` with no value use
// the element's own English text/title as the key, so the HTML stays readable
// and needs no duplicated key strings.
export function applyStaticI18n(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n || el.textContent?.trim();
    if (key) el.textContent = t(key);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const key = el.dataset.i18nTitle || el.title;
    if (key) el.title = t(key);
  }
}

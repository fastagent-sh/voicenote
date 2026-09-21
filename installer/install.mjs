#!/usr/bin/env node
// Installs the VoiceNote desktop app from its GitHub release.
//
// The app itself is a signed .app bundle, not something npm can hold; this
// package exists so `npx @fastagent-sh/voicenote` is a one-line install (and
// re-install, and repair) without hunting for a download page. Everything the
// app needs is inside the bundle, so there is nothing else to set up.
//
// A file downloaded by this script is not quarantined the way a browser
// download is, so the app opens on the first double-click — no right-click →
// Open dance, even though the signature is self-signed.
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'fastagent-sh/voicenote'
const APPS = '/Applications'

function fail(message) {
  console.error(`\nVoiceNote 安装失败：${message}\n`)
  process.exit(1)
}

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  fail(`目前只有 macOS 和 Windows 版本（检测到 ${process.platform}）。`)
}

const release = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
  headers: { accept: 'application/vnd.github+json' },
}).then(r => r.ok ? r.json() : fail(`读取发布信息失败（HTTP ${r.status}）。`))

// macOS: the zip carries the .app (the dmg is for manual downloads).
// Windows: the NSIS installer, which we hand to the system to run.
const wanted = process.arch === 'arm64' ? 'arm64' : 'x64'
const asset = (release.assets ?? []).find(a => process.platform === 'win32'
  ? a.name.endsWith('.exe')
  : a.name.endsWith('-mac.zip') && a.name.includes(wanted))
if (!asset) fail(`这个版本没有 ${process.platform} 的安装包（${release.tag_name}）。`)

console.log(`下载 VoiceNote ${release.tag_name.replace(/^app-v/, '')}（${(asset.size / 1e6).toFixed(0)} MB）…`)
const work = await mkdtemp(join(tmpdir(), 'voicenote-install-'))
const zipPath = join(work, asset.name)
try {
  const download = await fetch(asset.browser_download_url)
  if (!download.ok) fail(`下载失败（HTTP ${download.status}）。`)
  await writeFile(zipPath, Buffer.from(await download.arrayBuffer()))

  if (process.platform === 'win32') {
    console.log('运行安装程序…')
    // The NSIS installer is one-click: it installs and starts the app.
    execFileSync(zipPath, [], { stdio: 'inherit' })
    console.log('\n✓ 安装完成,VoiceNote 会自动启动。')
    console.log('  首次运行如果 Windows 提示"未知发布者",点「更多信息 → 仍要运行」。\n')
    process.exit(0)
  }

  const target = join(APPS, 'VoiceNote.app')
  if (existsSync(target)) {
    console.log('替换已安装的版本…')
    // Quit it first: replacing a running bundle leaves the old process alive
    // with files that no longer exist.
    try { execFileSync('osascript', ['-e', 'tell application "VoiceNote" to quit'], { stdio: 'ignore' }) } catch { /* not running */ }
    await rm(target, { recursive: true, force: true })
  }
  execFileSync('ditto', ['-x', '-k', zipPath, APPS], { stdio: 'inherit' })
  if (!existsSync(target)) fail('解压后没有找到 VoiceNote.app。')

  console.log(`\n✓ 已安装到 ${target}`)
  console.log('  打开方式：访达 → 应用程序 → VoiceNote，或执行 open -a VoiceNote')
  console.log('  应用会自己检查更新，之后不需要再跑这个命令。\n')
} catch (error) {
  if (error?.code === 'EACCES' || /Permission denied/i.test(String(error?.message))) {
    fail(`没有写入 ${APPS} 的权限。用 sudo 重试：sudo npx @fastagent-sh/voicenote`)
  }
  fail(String(error?.message ?? error))
} finally {
  await rm(work, { recursive: true, force: true })
}

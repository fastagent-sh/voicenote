// The desktop app's main process. It owns the pipeline directly: the same
// functions the `vn` CLI calls, running in this process. No sidecar binary, no
// background daemon, no stdout parsing.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron'
import electronUpdater from 'electron-updater'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  collectDoctor, configGetData, configSetData, getConfig, ignoreJob, importRecording,
  jobsListData, listRecorderFiles, loginChatGPT, NOTE_HTML_CSS, regenerateNotes,
  resetConfigCache, retryRecording, runPipeline, VERSION,
} from '../../../src/core.ts'
import { onPipelineEvent } from '../../../src/progress.ts'

const dirname = fileURLToPath(new URL('.', import.meta.url))
// Tray art: template images (black + alpha) so macOS recolours them for the
// light and dark menu bar.
const resourcesDir = app.isPackaged ? join(process.resourcesPath, 'resources') : join(dirname, '../../resources')
const trayIcon = (busy: boolean) => nativeImage.createFromPath(join(resourcesDir, busy ? 'trayBusyTemplate.png' : 'trayTemplate.png'))

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** One pipeline run at a time in this process; the file lock guards the rest. */
let running: Promise<void> | null = null
/**
 * Retries asked for while a run holds the lock. They are app state, not job
 * state — the record on disk cannot be touched until the lock frees — so the
 * window is told about them separately, or a queued retry looks like a click
 * that did nothing.
 */
const pendingRetries = new Set<string>()
let autoProcess = true
let lastRecorderSeen = false

function broadcast(channel: string, payload?: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

/**
 * Work asked for while a run holds the lock. A request must never be dropped
 * silently: picking a file and seeing nothing happen is worse than waiting.
 * An entry with no `file` means "scan the recorder".
 */
type RunRequest = { reason: 'manual' | 'recorder' | 'retry' | 'file'; file?: string }
const queuedRuns: RunRequest[] = []

/** Starts a run, or queues it behind the one in flight. Never blocks a caller. */
function requestRun(request: RunRequest): { queued: boolean } {
  if (running) {
    queuedRuns.push(request)
    broadcast('run:queued', queuedRuns.length)
    return { queued: true }
  }
  startRun(request)
  return { queued: false }
}

function startRun(request: RunRequest): void {
  broadcast('run:state', { running: true, reason: request.reason })
  running = runPipeline(request.file, {})
    .catch((error: unknown) => { broadcast('run:error', String((error as Error)?.message ?? error)) })
    .finally(() => {
      running = null
      updateTray()
      const next = queuedRuns.shift()
      broadcast('run:queued', queuedRuns.length)
      // Hand straight over to a queued request; the window stays in "running"
      // state instead of flickering back to idle between the two.
      if (next) startRun(next)
      else broadcast('run:state', { running: false })
    })
  updateTray()
}

// The recorder is a mount point that appears when it is plugged in. Polling it
// is how "plug in and it just starts" works without a background daemon; the
// app only has to be open, which is the deal we made when the LaunchAgent went
// away.
function watchRecorder(): void {
  setInterval(async () => {
    if (!autoProcess || running) return
    let present = false
    try { present = (await collectDoctor()).recorder.exists } catch { return }
    const appeared = present && !lastRecorderSeen
    lastRecorderSeen = present
    if (appeared) {
      broadcast('recorder:connected')
      requestRun({ reason: 'recorder' })
    }
  }, 5000)
}

function updateTray(): void {
  if (!tray) return
  tray.setImage(trayIcon(!!running))
  tray.setToolTip(running ? 'VoiceNote — 处理中' : 'VoiceNote — 空闲')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: running ? '处理中…' : '空闲', enabled: false },
    ...(updateReady ? [{ label: `重启以更新到 ${updateReady}`, click: () => autoUpdater.quitAndInstall() } as const] : []),
    { type: 'separator' },
    { label: '显示主窗口', click: () => showWindow() },
    { label: '立即处理', enabled: !running, click: () => { requestRun({ reason: 'manual' }) } },
    { label: '插入录音笔时自动处理', type: 'checkbox', checked: autoProcess, click: (item) => { autoProcess = item.checked; updateTray() } },
    { type: 'separator' },
    { label: '打开笔记文件夹', click: () => { void shell.openPath(getConfig().workspace) } },
    { label: `退出 VoiceNote ${VERSION}`, click: () => app.quit() },
  ]))
}

function showWindow(): void {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return }
  createWindow()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: join(dirname, '../preload/index.mjs'), sandbox: false },
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' } })

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(dirname, '../renderer/index.html'))
}

/**
 * Full-text search over the notes on disk. Titles come back from the job list
 * already; this is for "I remember someone said X". The workspace holds one
 * markdown file per note in month folders, so reading them is fast enough to
 * do per keystroke without an index — revisit if a workspace ever gets big
 * enough to feel it.
 */
async function searchNotes(query: string): Promise<{ path: string; title: string; snippet: string }[]> {
  const needle = query.trim().toLowerCase()
  if (needle.length < 2) return []
  const workspace = getConfig().workspace
  const months = await readdir(workspace, { withFileTypes: true }).catch(() => [])
  const results: { path: string; title: string; snippet: string; mtime: number }[] = []
  for (const month of months) {
    if (!month.isDirectory() || month.name.startsWith('_') || month.name.startsWith('.')) continue
    const dir = join(workspace, month.name)
    for (const entry of await readdir(dir).catch(() => [])) {
      if (!entry.endsWith('.md')) continue
      const path = join(dir, entry)
      const text = await readFile(path, 'utf8').catch(() => '')
      const at = text.toLowerCase().indexOf(needle)
      if (at < 0) continue
      const title = text.match(/^#\s+(.+)$/m)?.[1] ?? entry.replace(/\.md$/, '')
      const snippet = text.slice(Math.max(0, at - 60), at + 120).replace(/\s+/g, ' ').trim()
      const info = await stat(path).catch(() => null)
      results.push({ path, title, snippet, mtime: info?.mtimeMs ?? 0 })
    }
  }
  results.sort((a, b) => b.mtime - a.mtime)
  return results.slice(0, 50).map(({ path, title, snippet }) => ({ path, title, snippet }))
}

/**
 * Updates come from GitHub Releases. The download happens in the background;
 * installing is the user's call, because a pipeline run must not be killed
 * mid-transcription by a restart.
 *
 * macOS will only *install* an update when the app is code-signed (a
 * Squirrel.Mac requirement). An unsigned build still learns that a new
 * version exists, so the window offers the download page instead of a
 * restart — better than silently never updating.
 */
const { autoUpdater } = electronUpdater
let updateReady: string | null = null

function setupUpdates(): void {
  if (!app.isPackaged) return
  // A customer behind a firewall (or this project's own release test) can
  // point the updater somewhere else; unset, it uses the GitHub release the
  // build was published to.
  const feed = process.env.VOICENOTE_UPDATE_FEED
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => broadcast('update:available', info.version))
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version
    broadcast('update:ready', info.version)
    updateTray()
  })
  autoUpdater.on('error', (error) => broadcast('update:error', String(error?.message ?? error)))
  const check = () => { void autoUpdater.checkForUpdates().catch(() => { /* reported through the error event */ }) }
  check()
  setInterval(check, 6 * 60 * 60 * 1000)
}

function registerIpc(): void {
  ipcMain.handle('update:state', () => ({ version: app.getVersion(), ready: updateReady }))
  // Quitting for an update while a recording is being processed would lose
  // the run, so the choice stays with the user and the window says as much.
  ipcMain.handle('update:install', () => { autoUpdater.quitAndInstall() })
  ipcMain.handle('update:open-releases', () => shell.openExternal('https://github.com/fastagent-sh/voicenote/releases/latest'))
  ipcMain.handle('search', (_e, query: string) => searchNotes(query))
  ipcMain.handle('status', () => collectDoctor())
  ipcMain.handle('jobs', (_e, limit: number) => jobsListData(limit ?? 50))
  ipcMain.handle('config:get', () => configGetData())
  ipcMain.handle('config:set', async (_e, payload: unknown) => {
    const result = await configSetData(payload as never)
    resetConfigCache()
    return result
  })
  // These return as soon as the work is accepted. Awaiting the run itself
  // would leave the caller hanging for minutes and make a click look dead.
  ipcMain.handle('run', () => requestRun({ reason: 'manual' }))
  // Retrying takes the run lock, so it cannot happen while a recording is
  // being processed. Rejecting would be honest but useless — the user asked
  // for this recording to be redone, so queue the intent and run it when the
  // current job finishes.
  const requeue = async (id: string, apply: (id: string) => Promise<void>) => {
    const active = running
    if (active) {
      pendingRetries.add(id)
      broadcast('retry:pending', [...pendingRetries])
      void active.then(async () => {
        try {
          await apply(id)
        } catch (error) {
          broadcast('run:error', String((error as Error)?.message ?? error))
        } finally {
          pendingRetries.delete(id)
          broadcast('retry:pending', [...pendingRetries])
        }
        requestRun({ reason: 'retry' })
      })
      return { queued: true }
    }
    await apply(id)
    requestRun({ reason: 'retry' })
    return { queued: false }
  }
  ipcMain.handle('retry', (_e, id: string) => requeue(id, retryRecording))
  ipcMain.handle('regenerate', (_e, id: string) => requeue(id, regenerateNotes))
  ipcMain.handle('recorder-files', () => listRecorderFiles())
  // Ignoring touches the same state file as a run, so it waits for the lock
  // the same way a retry does.
  ipcMain.handle('ignore', (_e, id: string) => requeue(id, async (jobId) => { await ignoreJob(jobId) }))
  // Processing one file by path bypasses the age/size filters, which is the
  // point: the user picked this recording explicitly.
  ipcMain.handle('run-file', (_e, path: string) => requestRun({ reason: 'file', file: path }))
  ipcMain.handle('import', async (_e, path: string) => {
    await importRecording(path, { json: true })
    return requestRun({ reason: 'manual' })
  })
  ipcMain.handle('login', async () => {
    await loginChatGPT({ json: true, emit: (event) => broadcast('login:event', event) })
  })
  ipcMain.handle('pending-retries', () => [...pendingRetries])
  ipcMain.handle('open-path', (_e, path: string) => shell.openPath(path))
  ipcMain.handle('note:read', (_e, path: string) => readFile(path, 'utf8'))
  ipcMain.handle('reveal-path', (_e, path: string) => { shell.showItemInFolder(path) })
  // The renderer already turned the note into HTML for the reading view;
  // writing it out and handing it to the browser is the whole "open as HTML".
  ipcMain.handle('note:open-html', async (_e, payload: { title: string; html: string }) => {
    const file = join(tmpdir(), `voicenote-${Date.now()}.html`)
    await writeFile(file, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${payload.title}</title><style>${NOTE_HTML_CSS}</style></head><body>${payload.html}</body></html>`, 'utf8')
    await shell.openExternal(pathToFileURL(file).href)
    return file
  })
  ipcMain.handle('pick-directory', async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return picked.canceled ? null : picked.filePaths[0]
  })
  ipcMain.handle('pick-audio', async () => {
    const picked = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }],
    })
    return picked.canceled ? null : picked.filePaths[0]
  })
  ipcMain.handle('auto-process', (_e, enabled: boolean) => { autoProcess = enabled; updateTray(); return autoProcess })
}

app.whenReady().then(() => {
  registerIpc()
  onPipelineEvent((event) => {
    broadcast('pipeline:event', event)
    // The app is usually in the background while a recording processes, so the
    // result has to reach the user outside the window.
    if (event.type === 'job_done' && !mainWindow?.isFocused()) {
      new Notification({
        title: event.stub ? '转写完成,纪要失败' : '纪要已生成',
        body: event.title ?? '打开 VoiceNote 查看',
      }).show()
    }
    if (event.type === 'job_failed' && !mainWindow?.isFocused()) {
      new Notification({ title: '处理失败', body: event.message.slice(0, 120) }).show()
    }
  })
  tray = new Tray(trayIcon(false))
  updateTray()
  watchRecorder()
  setupUpdates()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

// Closing the window leaves the app in the tray: that is what makes "plug in
// the recorder and it starts" work without a separate background service.
app.on('window-all-closed', () => { /* stay in the tray */ })

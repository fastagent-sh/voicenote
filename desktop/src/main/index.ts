// The desktop app's main process. It owns the pipeline directly: the same
// functions the `vn` CLI calls, running in this process. No sidecar binary, no
// background daemon, no stdout parsing.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  collectDoctor, configGetData, configSetData, getConfig, importRecording, jobsListData,
  loginChatGPT, NOTE_HTML_CSS, resetConfigCache, retryRecording, runPipeline, VERSION,
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
let autoProcess = true
let lastRecorderSeen = false

function broadcast(channel: string, payload?: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

/** Runs the pipeline unless one is already running; resolves when it finishes. */
function startRun(reason: 'manual' | 'recorder' | 'retry'): Promise<void> {
  if (running) return running
  broadcast('run:state', { running: true, reason })
  running = runPipeline(undefined, {})
    .catch((error: unknown) => { broadcast('run:error', String((error as Error)?.message ?? error)) })
    .finally(() => {
      running = null
      broadcast('run:state', { running: false })
      updateTray()
    })
  updateTray()
  return running
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
      void startRun('recorder')
    }
  }, 5000)
}

function updateTray(): void {
  if (!tray) return
  tray.setImage(trayIcon(!!running))
  tray.setToolTip(running ? 'VoiceNote — 处理中' : 'VoiceNote — 空闲')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: running ? '处理中…' : '空闲', enabled: false },
    { type: 'separator' },
    { label: '显示主窗口', click: () => showWindow() },
    { label: '立即处理', enabled: !running, click: () => { void startRun('manual') } },
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

function registerIpc(): void {
  ipcMain.handle('search', (_e, query: string) => searchNotes(query))
  ipcMain.handle('status', () => collectDoctor())
  ipcMain.handle('jobs', (_e, limit: number) => jobsListData(limit ?? 50))
  ipcMain.handle('config:get', () => configGetData())
  ipcMain.handle('config:set', async (_e, payload: unknown) => {
    const result = await configSetData(payload as never)
    resetConfigCache()
    return result
  })
  ipcMain.handle('run', () => startRun('manual'))
  ipcMain.handle('retry', async (_e, id: string) => {
    await retryRecording(id)
    void startRun('retry')
  })
  ipcMain.handle('import', async (_e, path: string) => {
    await importRecording(path, { json: true })
    void startRun('manual')
  })
  ipcMain.handle('login', async () => {
    await loginChatGPT({ json: true, emit: (event) => broadcast('login:event', event) })
  })
  ipcMain.handle('open-path', (_e, path: string) => shell.openPath(path))
  ipcMain.handle('note:read', (_e, path: string) => readFile(path, 'utf8'))
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
  onPipelineEvent((event) => broadcast('pipeline:event', event))
  tray = new Tray(trayIcon(false))
  updateTray()
  watchRecorder()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

// Closing the window leaves the app in the tray: that is what makes "plug in
// the recorder and it starts" work without a separate background service.
app.on('window-all-closed', () => { /* stay in the tray */ })

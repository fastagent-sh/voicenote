// The desktop app's main process. It owns the pipeline directly: the same
// functions the `vn` CLI calls, running in this process. No sidecar binary, no
// background daemon, no stdout parsing.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectDoctor, configGetData, configSetData, getConfig, importRecording, jobsListData,
  loginChatGPT, resetConfigCache, retryRecording, runPipeline, VERSION,
} from '../../../src/core.ts'
import { onPipelineEvent } from '../../../src/progress.ts'

const dirname = fileURLToPath(new URL('.', import.meta.url))

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
  tray.setToolTip(running ? 'VoiceNote — processing' : 'VoiceNote — idle')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: running ? 'Processing…' : 'Idle', enabled: false },
    { type: 'separator' },
    { label: 'Show VoiceNote', click: () => showWindow() },
    { label: 'Process now', enabled: !running, click: () => { void startRun('manual') } },
    { label: 'Process automatically when the recorder is plugged in', type: 'checkbox', checked: autoProcess, click: (item) => { autoProcess = item.checked; updateTray() } },
    { type: 'separator' },
    { label: 'Open notes folder', click: () => { void shell.openPath(getConfig().workspace) } },
    { label: `Quit VoiceNote ${VERSION}`, click: () => app.quit() },
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

function registerIpc(): void {
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
  // A 1x1 transparent image keeps the tray alive until real art exists; the
  // title text is what the user reads on macOS.
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('◉')
  updateTray()
  watchRecorder()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

// Closing the window leaves the app in the tray: that is what makes "plug in
// the recorder and it starts" work without a separate background service.
app.on('window-all-closed', () => { /* stay in the tray */ })

// The desktop app's main process. It owns the pipeline directly: the same
// functions the `vn` CLI calls, running in this process. No sidecar binary, no
// background daemon, no stdout parsing.
import { app, autoUpdater as squirrel, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron'
import electronUpdater from 'electron-updater'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  AUDIO_EXTENSIONS, collectDoctor, configGetData, configSetData, getConfig, getPiAuthProviders, importRecording,
  jobsListData, listRecorderFiles, loginChatGPT, loginPiProvider, NOTE_HTML_CSS, prioritizeJob, regenerateNotes,
  removePiAuth, removeQueuedJob, resetConfigCache, retryRecording, runPipeline, setPiApiKey, VERSION,
} from '../../../src/core.ts'
import { onPipelineEvent } from '../../../src/progress.ts'
import { LoginPrompts } from '../../../src/loginInteraction.ts'
import { searchText } from './searchText.ts'

const dirname = fileURLToPath(new URL('.', import.meta.url))
// Tray art: template images (black + alpha) so macOS recolours them for the
// light and dark menu bar.
const resourcesDir = app.isPackaged ? join(process.resourcesPath, 'resources') : join(dirname, '../../resources')
const trayIcon = (busy: boolean) => nativeImage.createFromPath(join(resourcesDir, busy ? 'trayBusyTemplate.png' : 'trayTemplate.png'))

/**
 * ffprobe reads a recording's length, which decides what gets skipped and
 * what the UI can say about a file. It ships inside the app: relying on one
 * being on PATH worked on this developer's machine and silently degraded
 * everywhere else. The pipeline reads the path from the environment, the same
 * override a CLI user has.
 */
function useBundledFfprobe(): void {
  const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const bundled = app.isPackaged
    ? join(process.resourcesPath, name)
    : join(dirname, '../../node_modules/@ffprobe-installer', process.platform === 'win32' ? 'win32-x64' : 'darwin-arm64', name)
  if (existsSync(bundled)) process.env.VOICENOTE_FFPROBE_BIN = bundled
}

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
const pendingDeletes = new Set<string>()
const pendingPriorities = new Map<string, number>()
let nextPriority = 0
let drainingBatch = false
let currentRunAbort: AbortController | null = null
const batchAttempted = new Set<string>()
let autoProcess = true
let lastRecorderSeen = false

function broadcast(channel: string, payload?: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

function nextPriorityValue(): number {
  nextPriority = Math.max(Date.now(), nextPriority + 1)
  return nextPriority
}

function pendingQueueState(): { deletes: string[]; priorities: Record<string, number> } {
  return {
    deletes: [...pendingDeletes],
    priorities: Object.fromEntries(pendingPriorities),
  }
}

function broadcastPendingQueue(): void {
  broadcast('queue:pending', pendingQueueState())
}

async function flushPendingQueueOps(): Promise<void> {
  while (pendingDeletes.size > 0 || pendingPriorities.size > 0) {
    const deletes = [...pendingDeletes]
    pendingDeletes.clear()
    const priorities = [...pendingPriorities.entries()]
    pendingPriorities.clear()
    broadcastPendingQueue()
    for (const id of deletes) {
      try { await removeQueuedJob(id) } catch (error) { broadcast('run:error', String((error as Error)?.message ?? error)) }
    }
    for (const [id, priority] of priorities) {
      try { await prioritizeJob(id, priority) } catch (error) { broadcast('run:error', String((error as Error)?.message ?? error)) }
    }
  }
}

/**
 * Work asked for while a run holds the lock. A request must never be dropped
 * silently: picking a file and seeing nothing happen is worse than waiting.
 * An entry with no `file` means "scan the recorder".
 */
type RunRequest = {
  reason: 'manual' | 'recorder' | 'retry' | 'file' | 'prioritize' | 'continue'
  file?: string
  force?: boolean
  jobId?: string
  prepare?: () => Promise<void>
}
const queuedRuns: RunRequest[] = []

/** Starts a run, or queues it behind the one in flight. Never blocks a caller. */
function requestRun(request: RunRequest): { queued: boolean } {
  const isBatchStart = request.reason === 'manual' || request.reason === 'recorder'
  if (running) {
    if (isBatchStart && (drainingBatch || queuedRuns.some(r => r.reason === 'manual' || r.reason === 'recorder'))) {
      batchAttempted.clear()
      return { queued: true }
    }
    if (request.reason === 'prioritize') {
      if (!queuedRuns.some(r => r.jobId === request.jobId)) {
        queuedRuns.unshift(request)
        broadcast('run:queued', queuedRuns.length)
      }
      return { queued: true }
    }
    queuedRuns.push(request)
    broadcast('run:queued', queuedRuns.length)
    return { queued: true }
  }
  if (isBatchStart) batchAttempted.clear()
  startRun(request)
  return { queued: false }
}

function startRun(request: RunRequest): void {
  const isBatch = request.reason === 'manual' || request.reason === 'recorder' || request.reason === 'continue'
  if (request.reason === 'manual' || request.reason === 'recorder') {
    batchAttempted.clear()
    drainingBatch = true
  }
  const controller = new AbortController()
  currentRunAbort = controller
  broadcast('run:state', { running: true, reason: request.reason })
  running = (async () => {
    try {
      await request.prepare?.()
      const res = await runPipeline(request.file, {
        force: request.force,
        jobId: request.jobId,
        signal: controller.signal,
        ...(isBatch ? { maxJobs: 1, skipIds: batchAttempted } : {}),
      })
      if (isBatch) {
        for (const id of res.processedIds) batchAttempted.add(id)
        if (res.remaining === 0) drainingBatch = false
      }
    } catch (error: unknown) {
      if (isBatch) drainingBatch = false
      broadcast('run:error', String((error as Error)?.message ?? error))
    } finally {
      if (currentRunAbort === controller) currentRunAbort = null
      await flushPendingQueueOps()
      const next = queuedRuns.shift()
      broadcast('run:queued', queuedRuns.length)
      // Hand straight over to a queued request; the window stays in "running"
      // state instead of flickering back to idle between the two.
      if (next) startRun(next)
      else if (drainingBatch) startRun({ reason: 'continue' })
      else {
        running = null
        updateTray()
        broadcast('run:state', { running: false })
      }
    }
  })()
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
    ...(updateReady ? [{ label: manualUpdateOnly ? `下载 ${updateReady}（需手动安装）` : `重启以更新到 ${updateReady}`, click: () => { void installUpdate() } } as const] : []),
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
  mainWindow.on('closed', () => {
    activeLogin?.abort(new Error('Login cancelled: window closed'))
    mainWindow = null
  })
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
      const plain = searchText(text)
      const at = plain.toLowerCase().indexOf(needle)
      if (at < 0) continue
      const title = text.match(/^#\s+(.+)$/m)?.[1] ?? entry.replace(/\.md$/, '')
      const snippet = plain.slice(Math.max(0, at - 60), at + 120).trim()
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
const RELEASES_URL = 'https://github.com/fastagent-sh/voicenote/releases/latest'
let updateAvailable: string | null = null
let updateReady: string | null = null
let updateChecking = false
let updateError: string | null = null
/**
 * macOS installs through Squirrel.Mac, which refuses — silently, with no error
 * event — any update whose code signature does not satisfy the running app's
 * designated requirement (a build signed with a different self-signed cert, for
 * instance). electron-updater reports "downloaded" before that check runs, so
 * `quitAndInstall()` would hang forever and the button would look dead. Squirrel
 * staging the update is the only reliable signal that a restart will install it.
 */
let squirrelStaged = false
/** Set once Squirrel has had long enough and still has not taken the update. */
let manualUpdateOnly = false
/**
 * How long Squirrel gets to pull the update from the local proxy and check its
 * signature before the window stops promising a restart. Measured at a couple of
 * seconds for a 250 MB build; a minute is slack, not a deadline.
 * ponytail: fixed timeout, because a refused signature produces no event at all.
 */
const SQUIRREL_STAGE_TIMEOUT_MS = 60_000

function currentUpdateState() {
  return {
    version: app.getVersion(),
    available: updateAvailable,
    ready: updateReady,
    manual: manualUpdateOnly,
    checking: updateChecking,
    error: updateError,
    packaged: app.isPackaged,
  }
}

/** Restarts into the update, or opens the download page when Squirrel refused it. */
async function installUpdate(): Promise<{ installable: boolean }> {
  if (process.platform === 'darwin' && !squirrelStaged) {
    await shell.openExternal(RELEASES_URL)
    return { installable: false }
  }
  autoUpdater.quitAndInstall()
  return { installable: true }
}

function publishUpdateState() {
  broadcast('update:changed', currentUpdateState())
}

function reportUpdateError(error: unknown) {
  updateChecking = false
  updateError = String((error as Error)?.message ?? error)
  publishUpdateState()
}

async function checkForUpdates() {
  if (!app.isPackaged || updateReady || updateChecking || (updateAvailable && !updateError)) return currentUpdateState()
  updateChecking = true
  updateError = null
  publishUpdateState()
  try {
    const result = await autoUpdater.checkForUpdates()
    void result?.downloadPromise?.catch(reportUpdateError)
  } catch (error) {
    updateError = String((error as Error)?.message ?? error)
  } finally {
    updateChecking = false
    publishUpdateState()
  }
  return currentUpdateState()
}

function setupUpdates(): void {
  if (!app.isPackaged) return
  // A customer behind a firewall (or this project's own release test) can
  // point the updater somewhere else; unset, it uses the GitHub release the
  // build was published to.
  const feed = process.env.VOICENOTE_UPDATE_FEED
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => {
    updateChecking = false
    updateAvailable = info.version
    updateError = null
    publishUpdateState()
  })
  autoUpdater.on('update-not-available', () => {
    updateChecking = false
    updateAvailable = null
    updateError = null
    publishUpdateState()
  })
  autoUpdater.on('update-downloaded', (info) => {
    updateChecking = false
    updateAvailable = info.version
    updateReady = info.version
    updateError = null
    publishUpdateState()
    updateTray()
    if (process.platform !== 'darwin') return
    setTimeout(() => {
      if (squirrelStaged || manualUpdateOnly) return
      manualUpdateOnly = true
      publishUpdateState()
      updateTray()
    }, SQUIRREL_STAGE_TIMEOUT_MS)
  })
  autoUpdater.on('error', reportUpdateError)
  squirrel.on('update-downloaded', () => { squirrelStaged = true })
  void checkForUpdates()
  setInterval(checkForUpdates, 6 * 60 * 60 * 1000)
}

let activeLogin: AbortController | null = null
const loginPrompts = new LoginPrompts(event => broadcast('login:event', event))

async function loginProvider(providerId: string): Promise<{ ok: true }> {
  if (activeLogin) throw new Error('A login is already in progress. Cancel it before starting another.')
  const controller = new AbortController()
  activeLogin = controller
  try {
    await loginPiProvider(providerId, {
      json: true,
      signal: controller.signal,
      emit: event => broadcast('login:event', event),
      prompt: prompt => loginPrompts.ask(prompt, controller.signal)
    })
    resetConfigCache()
    return { ok: true }
  } finally {
    controller.abort(new Error('Login finished'))
    activeLogin = null
  }
}

function registerIpc(): void {
  ipcMain.handle('update:state', () => currentUpdateState())
  ipcMain.handle('update:check', () => checkForUpdates())
  // Quitting for an update while a recording is being processed would lose
  // the run, so the choice stays with the user and the window says as much.
  ipcMain.handle('update:install', () => installUpdate())
  ipcMain.handle('update:open-releases', () => shell.openExternal(RELEASES_URL))
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
    if (running) {
      pendingRetries.add(id)
      broadcast('retry:pending', [...pendingRetries])
      return requestRun({
        reason: 'retry',
        jobId: id,
        prepare: async () => {
          try { await apply(id) } finally {
            pendingRetries.delete(id)
            broadcast('retry:pending', [...pendingRetries])
          }
        },
      })
    }
    await apply(id)
    requestRun({ reason: 'retry', jobId: id })
    return { queued: false }
  }
  ipcMain.handle('retry', (_e, id: string) => requeue(id, retryRecording))
  ipcMain.handle('regenerate', (_e, id: string) => requeue(id, regenerateNotes))
  ipcMain.handle('queue:prioritize', async (_e, id: string) => {
    const priority = nextPriorityValue()
    if (running) {
      pendingDeletes.delete(id)
      pendingPriorities.set(id, priority)
      broadcastPendingQueue()
      if (!drainingBatch) return requestRun({ reason: 'prioritize', jobId: id })
      return { queued: true }
    }
    await prioritizeJob(id, priority)
    requestRun({ reason: 'prioritize', jobId: id })
    return { queued: false }
  })
  ipcMain.handle('queue:remove', async (_e, id: string) => {
    let removedRuns = false
    for (let i = queuedRuns.length - 1; i >= 0; i--) {
      if (queuedRuns[i]?.jobId === id) {
        queuedRuns.splice(i, 1)
        removedRuns = true
      }
    }
    if (removedRuns) broadcast('run:queued', queuedRuns.length)
    if (pendingRetries.delete(id)) broadcast('retry:pending', [...pendingRetries])
    pendingPriorities.delete(id)
    if (running) {
      pendingDeletes.add(id)
      broadcastPendingQueue()
      return { queued: true }
    }
    await removeQueuedJob(id)
    broadcastPendingQueue()
    return { queued: false }
  })
  ipcMain.handle('pending-queue', () => pendingQueueState())
  ipcMain.handle('queue:abort-current', () => {
    if (!currentRunAbort || currentRunAbort.signal.aborted) return { aborted: false }
    currentRunAbort.abort()
    return { aborted: true }
  })
  ipcMain.handle('recorder-files', () => listRecorderFiles())
  // Processing one file by path is the recorder list's escape hatch: it
  // bypasses the age/size filters and the conclusions of earlier runs (no
  // speech, unusable audio, already done), because the user pointed at this
  // recording and disagreed. There is no verdict left that outranks it.
  ipcMain.handle('run-file', (_e, path: string) => requestRun({ reason: 'file', file: path, force: true }))
  ipcMain.handle('import', async (_e, paths: string[]) => {
    const results = []
    for (const path of paths) {
      try { results.push(await importRecording(path)) }
      catch (error) { results.push({ status: 'failed', path, error: String((error as Error).message ?? error) }) }
    }
    if (results.some(result => result.status === 'queued')) requestRun({ reason: 'manual' })
    return results
  })
  ipcMain.handle('login', (_e, providerId?: string) => loginProvider(providerId || 'openai-codex'))
  ipcMain.handle('pi:login-answer', (_e, id: number, value: string) => loginPrompts.answer(id, value))
  ipcMain.handle('pi:login-cancel', () => { activeLogin?.abort(new Error('Login cancelled')) })
  ipcMain.handle('pi:providers', () => getPiAuthProviders())
  ipcMain.handle('pi:set-api-key', async (_e, providerId: string, apiKey: string) => {
    await setPiApiKey(providerId, apiKey)
    resetConfigCache()
    return { ok: true }
  })
  ipcMain.handle('pi:remove-auth', async (_e, providerId: string) => {
    await removePiAuth(providerId)
    resetConfigCache()
    return { ok: true }
  })
  ipcMain.handle('pi:login-oauth', (_e, providerId: string) => loginProvider(providerId))
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
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS].map(ext => ext.slice(1)) }],
    })
    return picked.canceled ? [] : picked.filePaths
  })
  ipcMain.handle('auto-process', (_e, enabled: boolean) => { autoProcess = enabled; updateTray(); return autoProcess })
}

app.whenReady().then(() => {
  // Before anything reads the config: the pipeline caches it on first use.
  useBundledFfprobe()
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

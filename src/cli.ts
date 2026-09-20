#!/usr/bin/env bun
import { cac } from 'cac'
import packageJson from '../package.json' with { type: 'json' }
import { parseLockOwner } from './runLock'
import { loginWithBrowser, loginWithDeviceCode, PI_PROVIDER_ID } from './chatgptAuth'
import { tosObject, type TosConfig as VolcanoTosConfig } from './tos'
import { applyOutcome, buildJobsView, classify, emptyState, localIso, MAX_ATTEMPTS, migrateLegacyState, ownsOutput, parseJobsLimit, parseStateFile, parseStrictJson, patchJob, pruneUnseen, reconcileInterrupted, requeueFailed, startAttempt, SUMMARY_FAILED_STATUS, type CurrentJob, type JobRecord, type StateFile } from './jobs'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile, writeFile, copyFile, rename, unlink, stat, readdir, rmdir, utimes } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, appendFileSync, openSync, closeSync, statSync, readSync, unlinkSync, renameSync } from 'node:fs'
import { dlopen, FFIType, suffix } from 'bun:ffi'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'

const VERSION = packageJson.version
const LAUNCH_AGENT_LABEL = 'sh.fastagent.voicenote'
const LAUNCH_AGENT_LABEL_LEGACY = 'com.kid7st.voicenote' // pre-fastagent installs; cleaned up on install
const TASK_NAME = 'VoiceNote'   // Windows Task Scheduler name (mac uses LAUNCH_AGENT_LABEL)

// Single switch every platform branch routes through. Declared before the path
// consts so they can read it.
const IS_WINDOWS = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

// Per-OS base dirs. Windows -> native AppData (Roaming for config, Local for
// logs/lock/state); mac/Linux -> ~/.config and ~/.local/state. appConfigDir /
// appStateDir are hoisted function decls (defined just below).
const CONFIG_DIR = appConfigDir()
const STATE_DIR = appStateDir()
const LOG_DIR = join(STATE_DIR, 'logs')
const LOCK_PATH = join(STATE_DIR, 'run.lock')
const CONFIG_ENV_PATH = join(CONFIG_DIR, 'config.json')

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.wma', '.aac', '.flac'])

// Per-OS base directory resolution (see CONFIG_DIR / STATE_DIR above).
function appConfigDir(): string {
  if (IS_WINDOWS) return join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), 'voicenote')
  return join(os.homedir(), '.config', 'voicenote')
}
function appStateDir(): string {
  if (IS_WINDOWS) return join(process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local'), 'voicenote')
  return join(os.homedir(), '.local', 'state', 'voicenote')
}

type Json = Record<string, any>

type Recording = {
  sourcePath: string
  sizeBytes: number
  modifiedAt: string
  durationSeconds: number | null
  sourceId: string
  contentHash: string
  recordedAt: Date
  imported: boolean
}

type LocalFiles = {
  audio: string
  transcript: string
  notes: string
  metadata: string
}

type SpeakerSelf = { name: string | null; aliases: string[] }
type SpeakerKnown = { name: string; aliases: string[]; relationship?: string | null }
type SpeakersConfig = { self: SpeakerSelf; known: SpeakerKnown[] }


type VolcanoConfig = {
  apiKey: string              // X-Api-Key (new Volcano console)
  resourceId: string
  language?: string
  tos: VolcanoTosConfig
}

/** How this install runs pi: which binary, which model, what it may read. */
type PiConfig = {
  bin: string
  /** Set when pi ships as plain JS next to a bundled bun: `<bin> <cli> <args>`. */
  cli: string | null
  model: string | null
  thinking: string
  /** Comma-separated tool list; empty = run the summary without tools. */
  tools: string
  contextDir: string
  retries: number
  authPath: string
}

type Config = {
  recordDir: string
  workspace: string
  minBytes: number
  minDurationSeconds: number
  maxAgeHours: number
  speakers: SpeakersConfig
  volcano: VolcanoConfig | null
  ffprobeBin: string
  pi: PiConfig
  /** Added to the environment of every process vn spawns. */
  childEnv: Record<string, string>
}

// ────────────────────────────────────────────────────────────────────────────
// Settings → Config
//
// config.json is the only persisted source; the inherited environment overrides
// it for this process only. Everything the program needs is resolved once, in
// getConfig(), and passed down as a frozen Config — no code below reads a
// business setting out of process.env, so behaviour can never depend on whether
// some earlier call happened to hydrate it.
// ────────────────────────────────────────────────────────────────────────────

// Config keys accepted by `vn config set` and loaded from config.json when the
// inherited environment does not already define them.
const ENV_KEYS = [
  'VOICENOTE_DEVICE_VOLUME',
  'VOICENOTE_RECORD_DIR',
  'VOICENOTE_WORKSPACE',
  'VOICENOTE_MIN_BYTES',
  'VOICENOTE_MIN_DURATION_SECONDS',
  'VOICENOTE_MAX_AGE_HOURS',
  'VOLCANO_ASR_KEY',
  'VOLCANO_ASR_RESOURCE_ID',
  'VOLCANO_ASR_LANGUAGE',
  'VOLCANO_TOS_REGION',
  'VOLCANO_TOS_ENDPOINT',
  'VOLCANO_TOS_BUCKET',
  'VOLCANO_TOS_ACCESS_KEY',
  'VOLCANO_TOS_SECRET_KEY',
  'VOLCANO_TOS_KEEP',
  'VOICENOTE_PI_BIN',
  'VOICENOTE_PI_CLI',
  'PI_CODING_AGENT_DIR',
  'VOICENOTE_FFPROBE_BIN',
  'VOICENOTE_PI_MODEL',
  'VOICENOTE_PI_RETRIES',
  'VOICENOTE_PI_THINKING',
  'VOICENOTE_PI_SUMMARY_TOOLS',
  'VOICENOTE_CONTEXT_DIR',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'LOCAL_PROXY_HOST', 'LOCAL_PROXY_PORT', 'LOCAL_NO_PROXY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
]

// Volcano endpoints (TOS object storage + openspeech ASR) should NEVER go through
// the SOCKS/HTTP proxy that pi (ChatGPT Codex OAuth) may need:
//   1) the proxy bandwidth often chokes on multi-megabyte PUTs to TOS
//   2) routing China-mainland Volcano APIs through an overseas proxy is slower / unreliable
const VOLCANO_NO_PROXY_HOSTS = ['.volces.com', '.volcengineapi.com', 'openspeech.bytedance.com']

function systemProxyUrl(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = spawnSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 })
    if (out.status !== 0 || !out.stdout) return null
    const get = (k: string) => out.stdout.match(new RegExp(`\\b${k}\\s*:\\s*(\\S+)`))?.[1]
    if (get('HTTPSEnable') === '1' && get('HTTPSProxy') && get('HTTPSPort')) return `http://${get('HTTPSProxy')}:${get('HTTPSPort')}`
    if (get('HTTPEnable') === '1' && get('HTTPProxy') && get('HTTPPort')) return `http://${get('HTTPProxy')}:${get('HTTPPort')}`
    return null
  } catch { return null }
}

type Settings = Record<string, string>

/** This run's settings: config.json, overridden by the inherited environment. */
function readSettings(file: Record<string, unknown>): Settings {
  const settings: Settings = {}
  for (const key of ENV_KEYS) {
    const inherited = process.env[key]
    if (inherited !== undefined) settings[key] = inherited
    else if (typeof file[key] === 'string') settings[key] = file[key] as string
  }
  return settings
}

/**
 * Proxy variables, resolved from settings or the macOS system proxy. Returned as
 * a map instead of being pushed onto process.env alone because Bun does not hand
 * a child the variables this process added after startup — every spawn site
 * passes them explicitly (covered by summary.test.ts).
 */
function proxyEnv(s: Settings): Record<string, string> {
  const url = s.https_proxy || s.HTTPS_PROXY || s.http_proxy || s.HTTP_PROXY || s.all_proxy || s.ALL_PROXY
    || (s.LOCAL_PROXY_HOST && s.LOCAL_PROXY_PORT ? `http://${s.LOCAL_PROXY_HOST}:${s.LOCAL_PROXY_PORT}` : '')
    || systemProxyUrl()
  if (!url) return {}
  const env: Record<string, string> = {}
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) env[key] = s[key] || url
  const base = s.LOCAL_NO_PROXY || s.no_proxy || s.NO_PROXY || 'localhost,127.0.0.1,::1'
  const bypass = [...new Set([...base.split(',').map(v => v.trim()).filter(Boolean), ...VOLCANO_NO_PROXY_HOSTS])].join(',')
  env.no_proxy = bypass
  env.NO_PROXY = bypass
  return env
}

function volcanoFrom(s: Settings): VolcanoConfig | null {
  const apiKey = s.VOLCANO_ASR_KEY || ''
  const tosAccess = s.VOLCANO_TOS_ACCESS_KEY
  const tosSecret = s.VOLCANO_TOS_SECRET_KEY
  const bucket = s.VOLCANO_TOS_BUCKET
  if (!apiKey || !tosAccess || !tosSecret || !bucket) return null
  const region = s.VOLCANO_TOS_REGION || 'cn-guangzhou'
  const endpoint = s.VOLCANO_TOS_ENDPOINT || `tos-s3-${region}.volces.com`
  const keep = ['1', 'true', 'yes'].includes((s.VOLCANO_TOS_KEEP || '0').toLowerCase())
  return {
    apiKey,
    resourceId: s.VOLCANO_ASR_RESOURCE_ID || 'volc.seedasr.auc',
    language: s.VOLCANO_ASR_LANGUAGE || undefined,
    tos: { endpoint, region, bucket, accessKey: tosAccess, secretKey: tosSecret, keep },
  }
}

function volcanoAuthHeaders(volc: VolcanoConfig, taskId: string, includeSequence: boolean): Record<string, string> {
  const base: Record<string, string> = {
    'X-Api-Resource-Id': volc.resourceId,
    'X-Api-Request-Id': taskId,
    'Content-Type': 'application/json',
  }
  if (includeSequence) base['X-Api-Sequence'] = '-1'
  base['X-Api-Key'] = volc.apiKey
  return base
}

function settingNumber(s: Settings, key: string, fallback: number): number {
  const raw = s[key]
  const value = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${key}: expected a non-negative number, got '${raw}'`)
  return value
}

/**
 * Path to the pi CLI that ships with this package. pi is a pinned dependency
 * so every install runs the same version instead of whatever `pi` happens to
 * be on PATH; resolution walks up from this source file, which covers both a
 * repo checkout and a global `bun add` install. Returns null for the compiled
 * sidecar (no node_modules on disk) — there the GUI passes VOICENOTE_PI_BIN /
 * VOICENOTE_PI_CLI for its staged copy — and for a source tree with no
 * dependencies installed, where `pi` from PATH is the remaining option.
 */
function bundledPiCli(): string | null {
  let dir = import.meta.dir
  for (;;) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

let configCache: Config | null = null

function getConfig(): Config {
  if (configCache) return configCache
  const file = loadConfigJson()
  const s = readSettings(file)
  // An explicit VOICENOTE_PI_BIN means the user picked their own pi; don't
  // second-guess it with the bundled copy.
  const piCli = s.VOICENOTE_PI_CLI ? expandHome(s.VOICENOTE_PI_CLI) : (s.VOICENOTE_PI_BIN ? null : bundledPiCli())
  const proxy = proxyEnv(s)
  // vn's own fetch (the ChatGPT OAuth flow) reads the proxy from the process
  // environment, so the derived values have to land there as well.
  for (const [key, value] of Object.entries(proxy)) process.env[key] = value
  const deviceVolume = s.VOICENOTE_DEVICE_VOLUME || 'VTR6500'
  const workspace = expandHome(s.VOICENOTE_WORKSPACE || '~/Documents/meetings')
  // pi keeps credentials in its config dir, which PI_CODING_AGENT_DIR relocates.
  // Point it at a voicenote-owned directory to get an auth.json that only the
  // pipeline reads and refreshes: an interactive pi session rewrites its own
  // auth.json wholesale on exit and has already dropped entries that way.
  const piAgentDir = expandHome(s.PI_CODING_AGENT_DIR || join(os.homedir(), '.pi', 'agent'))
  // Passed to every child: the proxy, plus the credentials and the config dir
  // pi resolves for itself. pi gets the same EXPANDED path vn reports as
  // `authPath`; forwarding the raw setting handed pi a literal "$HOME/..."
  // directory, so every summary failed with "No API key found" while doctor
  // kept reporting the credentials as present.
  const childEnv: Record<string, string> = { ...proxy, PI_CODING_AGENT_DIR: piAgentDir }
  for (const key of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY']) if (s[key]) childEnv[key] = s[key]!
  configCache = Object.freeze({
    recordDir: expandHome(s.VOICENOTE_RECORD_DIR || `/Volumes/${deviceVolume}/RECORD`),
    workspace,
    minBytes: settingNumber(s, 'VOICENOTE_MIN_BYTES', 100000),
    minDurationSeconds: settingNumber(s, 'VOICENOTE_MIN_DURATION_SECONDS', 60),
    // Only recordings from the last N hours are picked up (0 = no limit), so a
    // fresh install doesn't drain the recorder's entire history.
    maxAgeHours: settingNumber(s, 'VOICENOTE_MAX_AGE_HOURS', 48),
    volcano: volcanoFrom(s),
    speakers: normalizeSpeakers(file.speakers ?? DEFAULT_SPEAKERS),
    // ffprobe is the only ffmpeg-suite binary the pipeline uses (duration
    // detection); a configurable path lets the GUI point at its bundled copy.
    ffprobeBin: expandHome(s.VOICENOTE_FFPROBE_BIN || 'ffprobe'),
    pi: {
      bin: expandHome(s.VOICENOTE_PI_BIN || (piCli ? process.execPath : 'pi')),
      cli: piCli,
      // pi's --model accepts "provider/id" (e.g. openai-codex/gpt-5.6-sol), so
      // this one setting pins both. Null = whatever pi is configured to use.
      model: (s.VOICENOTE_PI_MODEL || '').trim() || null,
      thinking: s.VOICENOTE_PI_THINKING || 'high',
      // Default ON: let the summary model read/grep prior notes for cross-reference
      // consistency. Set VOICENOTE_PI_SUMMARY_TOOLS='' to disable.
      tools: s.VOICENOTE_PI_SUMMARY_TOOLS === undefined ? 'read,grep' : s.VOICENOTE_PI_SUMMARY_TOOLS.trim(),
      // Directory the summary model may read/grep. The published default must not
      // reach outside the configured workspace.
      contextDir: expandHome(s.VOICENOTE_CONTEXT_DIR || workspace),
      retries: Math.max(1, Math.floor(settingNumber(s, 'VOICENOTE_PI_RETRIES', 3))),
      authPath: join(piAgentDir, 'auth.json'),
    },
    childEnv,
  })
  return configCache
}

// ────────────────────────────────────────────────────────────────────────────
// Config files (~/.config/voicenote)
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_SPEAKERS: SpeakersConfig = { self: { name: null, aliases: [] }, known: [] }

function normalizeSpeakers(data: unknown): SpeakersConfig {
  const raw = (data && typeof data === 'object') ? data as Partial<SpeakersConfig> : {}
  return {
    self: {
      name: typeof raw.self?.name === 'string' ? raw.self.name : null,
      aliases: Array.isArray(raw.self?.aliases) ? raw.self!.aliases.filter((a): a is string => typeof a === 'string') : [],
    },
    known: Array.isArray(raw.known)
      ? raw.known
        .filter((k): k is SpeakerKnown => !!k && typeof k === 'object' && typeof (k as SpeakerKnown).name === 'string')
        .map(k => ({ name: k.name, aliases: Array.isArray(k.aliases) ? k.aliases.filter((a): a is string => typeof a === 'string') : [], relationship: k.relationship ?? null }))
      : [],
  }
}

function loadConfigJson(): Record<string, unknown> {
  if (!existsSync(CONFIG_ENV_PATH)) return {}
  let value: unknown
  try { value = JSON.parse(readFileSync(CONFIG_ENV_PATH, 'utf8')) } catch (e: any) {
    throw new Error(`${CONFIG_ENV_PATH} is invalid JSON: ${e?.message || e}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${CONFIG_ENV_PATH} must contain a JSON object`)
  return value as Record<string, unknown>
}

// ────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ────────────────────────────────────────────────────────────────────────────

function expandHome(path: string): string {
  return path.replace(/^(?:~|\$\{?HOME\}?)(?=\/|$)/, os.homedir())
}

function nowIso(): string { return new Date().toISOString() }
function pad(n: number): string { return String(n).padStart(2, '0') }

function dateParts(d: Date): { month: string; prefix: string } {
  const month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
  // Local time in filenames uses HH-MM only (the recorder cannot produce two recordings within the same minute)
  const prefix = `${month}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}`
  return { month, prefix }
}

function safeSlug(text: string, maxLen = 48): string {
  const cleaned = (text || '').trim().replace(/[\\/:*?"<>|\n\r\t]+/g, '-').replace(/\s+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, maxLen).replace(/-+$/g, '') || 'note'
}

function formatSeconds(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round(seconds || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

// ────────────────────────────────────────────────────────────────────────────
// File state IO
// ────────────────────────────────────────────────────────────────────────────

const inboxPathFor = (config: Config) => join(config.workspace, '_inbox')

async function ensureDirs(config: Config): Promise<void> {
  for (const dir of ['_state', '_index', '_audio', '_transcripts', '_metadata', '_inbox']) {
    await mkdir(join(config.workspace, dir), { recursive: true })
  }
}

// Write via tmp+rename so readers only ever see a complete file. Anything whose
// mere existence is later treated as a signal MUST go through this: a half
// written file that still parses is worse than no file at all.
async function writeFileAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, path)
}

const writeJson = (path: string, data: any) => writeFileAtomic(path, JSON.stringify(data, null, 2))

async function appendJsonl(path: string, data: any): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(data) + '\n', 'utf8')
}

const RAW_TRANSCRIPT_MARKER = '## Raw transcript (no lossy cleanup)\n\n'
const RAW_TRANSCRIPT_MARKER_LEGACY = '## 原始 transcript（不做 lossy 清洗）\n\n' // pre-0.18 files on disk



// ────────────────────────────────────────────────────────────────────────────
// Logging (rolling daily log)
// ────────────────────────────────────────────────────────────────────────────

function dailyLogPath(): string {
  const d = new Date()
  return join(LOG_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`)
}

// Best-effort side effects (logging, idle-state) must not crash the pipeline, but
// failures should still be observable. Write directly to stderr (not console.error,
// which wireDailyLog wraps and would recurse into the same failing file) once per tag.
const sideEffectWarned = new Set<string>()
function warnSideEffect(where: string, e: unknown): void {
  if (sideEffectWarned.has(where)) return
  sideEffectWarned.add(where)
  process.stderr.write(`[voicenote] non-fatal: ${where} failed: ${e instanceof Error ? e.message : String(e)}\n`)
}

let logWired = false
function wireDailyLog(): void {
  if (logWired) return
  logWired = true
  try { mkdirSync(LOG_DIR, { recursive: true }) } catch (e) { warnSideEffect('log dir mkdir', e) }
  const path = dailyLogPath()
  const append = (level: 'INFO' | 'ERROR', args: any[]) => {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    const stamped = `${nowIso()} [${level}] ${line}\n`
    try { appendFileSync(path, stamped, 'utf8') } catch (e) { warnSideEffect('daily log append', e) }
  }
  const origLog = console.log.bind(console)
  const origErr = console.error.bind(console)
  console.log = (...a: any[]) => { append('INFO', a); origLog(...a) }
  console.error = (...a: any[]) => { append('ERROR', a); origErr(...a) }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown size'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return `${h}h ${m}m ${s}s`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

function progressStep(step: number, total: number, title: string, detail?: string): void {
  console.log(`▶ Step ${step}/${total}: ${title}${detail ? ` — ${detail}` : ''}`)
  // Single hook for live progress: the dashboard shows the same string the log
  // does, instead of regex-guessing the step from log text.
  reportStep(title)
}

async function withHeartbeat<T>(label: string, work: () => Promise<T>, heartbeatSeconds = 60): Promise<T> {
  const started = Date.now()
  const timer = setInterval(() => {
    console.log(`… Still working: ${label} (${formatElapsed(Date.now() - started)} elapsed)`)
  }, Math.max(10, heartbeatSeconds) * 1000)
  ;(timer as any).unref?.()
  try {
    const result = await work()
    console.log(`✓ Done: ${label} (${formatElapsed(Date.now() - started)})`)
    return result
  } catch (e) {
    console.error(`✗ Failed: ${label} after ${formatElapsed(Date.now() - started)}`)
    throw e
  } finally {
    clearInterval(timer)
  }
}

function shouldLogIdleStatus(key: string, intervalMs = 30 * 60 * 1000): boolean {
  const path = join(LOG_DIR, 'idle-status.json')
  const now = Date.now()
  let prev: any = null
  try { prev = JSON.parse(readFileSync(path, 'utf8')) } catch {}
  const should = prev?.key !== key || now - Number(prev?.at || 0) >= intervalMs
  if (should) {
    try {
      mkdirSync(LOG_DIR, { recursive: true })
      writeFileSync(path, JSON.stringify({ key, at: now, iso: nowIso() }, null, 2) + '\n', 'utf8')
    } catch (e) { warnSideEffect('idle-status write', e) }
  }
  return should
}

type RunMode = 'notes' | 'transcript'
function normalizeRunMode(opts: any): RunMode {
  const raw = String(opts.mode || 'notes').toLowerCase()
  if (raw === 'note') return 'notes'
  if (raw === 'notes' || raw === 'transcript') return raw
  throw new Error(`Invalid --mode "${raw}". Use: notes|transcript`)
}

// ────────────────────────────────────────────────────────────────────────────
// Cross-process lock
// ────────────────────────────────────────────────────────────────────────────

// Single-instance mutual exclusion via an OS advisory lock (flock) held on an open
// fd. The kernel releases it automatically when the process exits — including
// SIGKILL/crash — so there is NO pid / mtime / heartbeat / stale-steal logic to
// race on. flock is loaded from libSystem, so it is macOS-only; every other
// platform uses the pid+timestamp lockfile below.
const flockFn = (() => {
  try {
    const lib = dlopen(`libSystem.${suffix}`, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
    return lib.symbols.flock as (fd: number, op: number) => number
  } catch { return null }
})()
const FLOCK_EX_NB = 2 | 4  // LOCK_EX | LOCK_NB
const FLOCK_UN = 8

// Lockfile used wherever flock is not available (Windows, Linux). A pid+timestamp
// file, created atomically with 'wx'. We only reclaim an existing lock when its
// owner pid is dead OR the lock is stale (older than STALE_MS). The holder refreshes its timestamp every 5 minutes
// (heartbeat below), so a legitimately long RUNNING job — ASR on a multi-hour
// recording — never looks stale. The staleness escape exists for the pid-reuse
// false positive (owner died, an unrelated process now has its pid, the aliveness
// probe lies); its known cost: a machine asleep >30min can lose the lock on wake
// (timers don't fire while asleep), so the heartbeat verifies ownership before
// each refresh and, if the lock was reclaimed, stops touching it and warns — the
// old run finishes unprotected rather than corrupting the new holder's record.
// Task Scheduler's IgnoreNew already blocks the common 60s overlap; this only has
// to cover a manual `vn run` racing the scheduled one. The tiny create/reclaim
// window is acceptable: its failure mode is conservatively skipping one run (same
// as mac when flock is already held).
async function acquireRunLockFile(): Promise<{ release: () => Promise<void> } | null> {
  await mkdir(dirname(LOCK_PATH), { recursive: true })
  const STALE_MS = 30 * 60 * 1000
  const tryCreate = (): number | null => {
    try { return openSync(LOCK_PATH, 'wx') }
    catch (e: any) { if (e?.code === 'EEXIST') return null; throw e }
  }
  let fd = tryCreate()
  if (fd === null) {
    let reclaim = false
    try {
      const data = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
      const pid = Number(data.pid), ts = Number(data.ts)
      const alive = pidAlive(pid)
      const fresh = Number.isFinite(ts) && (Date.now() - ts) < STALE_MS
      reclaim = !alive || !fresh
    } catch { reclaim = true }  // unreadable/corrupt lock -> reclaim
    if (!reclaim) return null   // another live run holds it
    try { unlinkSync(LOCK_PATH) } catch {}
    fd = tryCreate()
    if (fd === null) return null  // someone grabbed it in the gap
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }))
  closeSync(fd)
  // Tri-state ownership (parse logic + its 'unknown'-on-read-failure invariant
  // are pure + tested in runLock.ts). A transient read failure must NOT be
  // treated as loss of ownership: that would kill the heartbeat and hand the
  // lock away over a momentary glitch — the overlap the heartbeat prevents.
  const lockOwnership = () => {
    let raw: string | null
    try { raw = readFileSync(LOCK_PATH, 'utf8') } catch { raw = null }
    return parseLockOwner(raw, process.pid)
  }
  // Heartbeat: keep ts fresh while we hold the lock; verify ownership first
  // (see header comment — the lock can be reclaimed after a long sleep).
  // The refresh writes a temp file and renames it into place: a plain
  // truncate+write would open a window where a concurrent acquire reads
  // empty/partial JSON, treats the lock as corrupt, and reclaims a LIVE lock.
  const heartbeat = setInterval(() => {
    const owner = lockOwnership()
    if (owner === 'reclaimed') {
      clearInterval(heartbeat)
      console.error('Run lock was reclaimed by another process (machine slept >30min?); this run continues but is no longer protected against overlap.')
      return
    }
    if (owner === 'unknown') { warnSideEffect('run lock heartbeat read', new Error('lock unreadable this tick; will retry')); return }
    try {
      const tmp = `${LOCK_PATH}.hb-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ pid: process.pid, ts: Date.now() }))
      renameSync(tmp, LOCK_PATH) // atomic replace, also on Windows
    } catch (e) { warnSideEffect('run lock heartbeat', e) }
  }, 5 * 60 * 1000)
  ;(heartbeat as any).unref?.()
  let released = false
  const release = async () => {
    if (released) return
    released = true
    clearInterval(heartbeat)
    // Only remove the lock when it is provably still OURS. Not 'reclaimed'
    // (that's the new holder's lock) and not 'unknown' either: a transient
    // read failure could be a reclaimer mid-swap, and the heartbeat does NOT
    // rewrite on 'unknown', so unlinking here would leave a real vacuum until
    // STALE_MS. Leaking our own lock on a rare transient failure is the lesser
    // evil — it self-heals after STALE_MS via the staleness check.
    try { if (lockOwnership() === 'mine') unlinkSync(LOCK_PATH) } catch {}
  }
  process.once('exit', () => { void release() })
  process.once('SIGINT', () => { void release(); process.exit(130) })
  process.once('SIGTERM', () => { void release(); process.exit(143) })
  return { release }
}

async function acquireRunLock(): Promise<{ release: () => Promise<void> } | null> {
  if (!flockFn) return acquireRunLockFile()
  await mkdir(dirname(LOCK_PATH), { recursive: true })
  // The lock is a regular file we keep open. Builds ≤ 0.15.2 used a *directory*
  // here, held purely by its existence, with no pid or refreshed mtime inside — so
  // a leftover legacy dir carries NO reliable signal about whether an old `vn run`
  // still holds it. Rather than guess (and risk deleting a live lock → concurrent
  // double-processing), refuse to auto-reclaim it: warn and skip. Normal upgrades
  // don't hit this (≤ 0.15.2 removes its own dir lock on SIGTERM/exit); it only
  // appears after a hard crash of an old build, where a one-time manual cleanup is
  // the safe move.
  let fd: number
  try { fd = openSync(LOCK_PATH, 'w') }
  catch (e: any) {
    if (e?.code !== 'EISDIR') throw e
    console.error(`Found a legacy (≤ 0.15.2) lock directory at ${LOCK_PATH}; it carries no liveness info and can't be auto-reclaimed safely. If no 'vn run' is active, remove it once:  rm -rf "${LOCK_PATH}"  — skipping this run.`)
    return null
  }
  if (flockFn(fd, FLOCK_EX_NB) !== 0) { closeSync(fd); return null }  // another run holds it
  let released = false
  const release = async () => {
    if (released) return
    released = true
    try { flockFn(fd, FLOCK_UN) } catch {}
    try { closeSync(fd) } catch {}
  }
  process.once('exit', () => { void release() })
  process.once('SIGINT', () => { void release(); process.exit(130) })
  process.once('SIGTERM', () => { void release(); process.exit(143) })
  return { release }
}

// ────────────────────────────────────────────────────────────────────────────
// Recording scan
// ────────────────────────────────────────────────────────────────────────────

function parseRecordedAt(path: string): Date {
  const stem = basename(path, extname(path))
  const m = stem.match(/(20\d{12})/)
  if (m?.[1]) {
    const s = m[1]
    return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12)), Number(s.slice(12, 14)))
  }
  return new Date()
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  const reader = Bun.file(path).stream().getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    h.update(value)
  }
  return h.digest('hex')
}

function sourceIdFor(path: string, size: number, mtimeMs: number, digest: string, imported = false): string {
  // Manual imports are content-addressed: dropping the same audio again must
  // find its existing job even after the temporary inbox copy was removed.
  return imported ? `import:${digest}` : createHash('sha256').update(`${path}|${size}|${Math.floor(mtimeMs / 1000)}|${digest}`).digest('hex')
}

function runCommand(command: string, args: string[], timeoutMs = 20000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((res) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', d => stdout += String(d))
    child.stderr.on('data', d => stderr += String(d))
    child.on('close', code => { clearTimeout(timer); res({ stdout, stderr, code: code ?? 1 }) })
    child.on('error', err => { clearTimeout(timer); res({ stdout, stderr: String(err), code: 1 }) })
  })
}

// Cross-platform "reveal in file manager / open URL in default app".
// macOS `open`, Linux `xdg-open`, Windows `start` (a cmd builtin, so via `cmd /c`;
// the empty "" is start's title arg so a quoted path/URL isn't swallowed as title).
function openPath(target: string, timeoutMs = 5000): Promise<{ stdout: string; stderr: string; code: number }> {
  if (IS_WINDOWS) return runCommand('cmd', ['/c', 'start', '', target], timeoutMs)
  if (IS_MAC) return runCommand('open', [target], timeoutMs)
  return runCommand('xdg-open', [target], timeoutMs)
}

// Cross-platform replacement for `tail -n N [-F] files`. Windows ships no `tail`,
// so even a non-follow `vn log` would break; a pure-JS implementation also drops a
// process dependency on mac/Linux. Follow mode polls appended bytes every second.
async function tailFiles(files: string[], lines: number, follow: boolean): Promise<void> {
  const header = files.length > 1
  const lastLines = (text: string, n: number) => {
    const arr = text.split('\n')
    if (arr.length && arr[arr.length - 1] === '') arr.pop()
    return arr.slice(-n).join('\n')
  }
  const sizes = new Map<string, number>()
  for (const f of files) {
    const text = await readFile(f, 'utf8').catch(() => '')
    if (header) process.stdout.write(`==> ${f} <==\n`)
    const tail = lastLines(text, lines)
    if (tail) process.stdout.write(tail + '\n')
    sizes.set(f, Buffer.byteLength(text))
  }
  if (!follow) return
  await new Promise<void>((resolve) => {
    let stop = false
    process.once('SIGINT', () => { stop = true; resolve() })
    const poll = () => {
      if (stop) return
      for (const f of files) {
        try {
          const size = statSync(f).size
          const prev = sizes.get(f) ?? 0
          if (size > prev) {
            const fd = openSync(f, 'r')
            try {
              const buf = Buffer.alloc(size - prev)
              readSync(fd, buf, 0, buf.length, prev)
              if (header) process.stdout.write(`==> ${f} <==\n`)
              process.stdout.write(buf.toString('utf8'))
            } finally { closeSync(fd) }
            sizes.set(f, size)
          } else if (size < prev) {
            sizes.set(f, size) // rotated/truncated
          }
        } catch (e) { warnSideEffect(`follow ${f}`, e) }
      }
      if (!stop) setTimeout(poll, 1000)
    }
    setTimeout(poll, 1000)
  })
}

async function ffprobeDuration(config: Config, path: string): Promise<number | null> {
  const result = await runCommand(config.ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path])
  if (result.code !== 0) return null
  const v = Number(result.stdout.trim())
  return Number.isFinite(v) ? v : null
}

function isCandidateFile(path: string): boolean {
  const name = basename(path)
  if (name.startsWith('._') || name.startsWith('.')) return false
  if (!AUDIO_EXTENSIONS.has(extname(path).toLowerCase())) return false
  const parts = path.split(/[/\\]/)
  if (parts.includes('.Spotlight-V100') || parts.includes('.fseventsd') || parts.includes('System Volume Information')) return false
  return true
}

/**
 * `complete` is false when any part of the listing was lost — the glob threw, or
 * a file we had just seen could not be read. It gates pruning: "not in the scan"
 * only means "gone from the recorder" if the scan actually saw everything, and
 * treating a half-read device as authoritative would delete live queue entries
 * along with their retry counters.
 */
async function toRecording(config: Config, file: string, imported = false): Promise<Recording> {
  const st = await stat(file)
  const contentHash = await sha256File(file)
  return {
    sourcePath: file,
    sizeBytes: st.size,
    modifiedAt: st.mtime.toISOString(),
    durationSeconds: await ffprobeDuration(config, file),
    sourceId: sourceIdFor(file, st.size, st.mtimeMs, contentHash, imported),
    contentHash,
    recordedAt: parseRecordedAt(file),
    imported,
  }
}

async function scanRecordings(config: Config): Promise<{ recordings: Recording[]; complete: boolean }> {
  const recordings: Recording[] = []
  const recorderPresent = existsSync(config.recordDir)
  let complete = recorderPresent
  const roots = [
    ...(recorderPresent ? [{ dir: config.recordDir, imported: false }] : []),
    ...(existsSync(inboxPathFor(config)) ? [{ dir: inboxPathFor(config), imported: true }] : []),
  ]
  for (const root of roots) {
    try {
      for await (const file of new Bun.Glob('**/*').scan({ cwd: root.dir, absolute: true, dot: true })) {
        if (!isCandidateFile(file)) continue
        const st = await stat(file).catch(() => null)
        // Listed a moment ago but unreadable now: the device is going away, or
        // this file is. Either way the listing is no longer trustworthy.
        if (!st) { complete = false; continue }
        if (!st.isFile()) continue
        try {
          recordings.push(await toRecording(config, file, root.imported))
        } catch (e) { complete = false; warnSideEffect(`read ${basename(file)} during scan`, e) }
      }
    } catch (e) {
      complete = false
      warnSideEffect(`scan ${root.imported ? 'import inbox' : 'recorder'}`, e)
    }
  }
  // Explicit imports go first; each group remains oldest-first.
  recordings.sort((a, b) => Number(b.imported) - Number(a.imported) || a.recordedAt.getTime() - b.recordedAt.getTime())
  return { recordings, complete }
}

// ────────────────────────────────────────────────────────────────────────────
// File path planning
// ────────────────────────────────────────────────────────────────────────────

/**
 * The one place the output layout is written down. A job starts out untitled
 * (timestamp only) and moves to its titled names once the summary produces a
 * title; pass `title` — including a null/empty one — for the titled form.
 */
function layout(config: Config, rec: Recording, title?: string | null): LocalFiles {
  const { month, prefix } = dateParts(rec.recordedAt)
  const untitled = title === undefined
  const base = untitled ? prefix : `${prefix}-${safeSlug(title || 'note')}`
  return {
    audio: join(config.workspace, '_audio', month, `${base}-original${extname(rec.sourcePath).toLowerCase()}`),
    transcript: join(config.workspace, '_transcripts', month, `${base}-transcript.md`),
    notes: join(config.workspace, month, untitled ? `${base}-note.md` : `${base}.md`),
    metadata: join(config.workspace, '_metadata', month, `${base}-metadata.json`),
  }
}

// Resume on the evidence, not on a state label: if the transcript is on disk,
// re-running ASR is money spent for nothing. Keying this off `notes_failed`
// instead meant `vn forget` (which drops the record) silently re-paid for ASR,
// even though the transcript was still sitting there.
function resumableTranscriptFiles(config: Config, rec: Recording, store: StateFile, mode: RunMode, force: boolean): LocalFiles | null {
  if (force || mode !== 'notes') return null
  // Paths recorded by an earlier attempt win: that attempt may already have
  // moved its outputs to titled names.
  const fallback = layout(config, rec)
  const recorded = store.jobs[rec.sourceId]?.paths || {}
  const files = Object.fromEntries(
    Object.entries(fallback).map(([key, path]) => [key, typeof recorded[key] === 'string' ? recorded[key] : path]),
  ) as LocalFiles
  return existsSync(files.transcript) ? files : null
}

async function readSavedTranscript(path: string): Promise<string> {
  const markdown = await readFile(path, 'utf8')
  const marker = [RAW_TRANSCRIPT_MARKER, RAW_TRANSCRIPT_MARKER_LEGACY].find(m => markdown.includes(m))
  if (!marker) throw new Error(`Cannot resume summary: saved transcript is missing raw transcript marker: ${path}`)
  const transcript = markdown.slice(markdown.indexOf(marker) + marker.length).trim()
  if (!transcript) throw new Error(`Cannot resume summary: saved transcript is empty: ${path}`)
  return transcript
}

async function removeFailedSummaryStub(path: string): Promise<void> {
  if (!existsSync(path)) return
  try {
    const body = await readFile(path, 'utf8')
    if (body.startsWith('# Pending summary: ') || body.startsWith('# 待补纪要：')) await unlink(path)
  } catch (e) { warnSideEffect(`remove failed-summary stub ${path}`, e) }
}

/**
 * Move a job's existing outputs onto their titled paths. Audio and the
 * transcript written before the summary ran move together — they used to be
 * renamed in two different places, and the one left behind became an orphan.
 * Notes and metadata are rewritten by the caller, so their stale copies from a
 * failed attempt are dropped instead of moved.
 */
async function promoteOutputs(from: LocalFiles, to: LocalFiles): Promise<void> {
  for (const key of ['audio', 'transcript'] as const) {
    if (from[key] === to[key] || !existsSync(from[key])) continue
    await mkdir(dirname(to[key]), { recursive: true })
    if (existsSync(to[key])) await unlink(to[key])
    await rename(from[key], to[key])
  }
  if (from.metadata !== to.metadata && existsSync(from.metadata)) {
    await unlink(from.metadata).catch(e => warnSideEffect(`remove orphaned metadata ${from.metadata}`, e))
  }
}

// ───────────────────────────────────────────────────────────────────────
// Volcano (Doubao ASR + TOS upload)
// ───────────────────────────────────────────────────────────────────────

function volcanoContentTypeFromExt(ext: string): string {
  const e = ext.replace(/^\./, '').toLowerCase()
  switch (e) {
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    case 'm4a': return 'audio/mp4'
    case 'aac': return 'audio/aac'
    case 'ogg': return 'audio/ogg'
    case 'flac': return 'audio/flac'
    default: return 'application/octet-stream'
  }
}

async function volcanoSubmitTask(volc: VolcanoConfig, taskId: string, audioUrl: string, format: string): Promise<void> {
  const body = {
    user: { uid: 'voicenote' },
    audio: { url: audioUrl, format },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      enable_speaker_info: true,
      show_utterances: true,
      ...(volc.language ? { language: volc.language } : {}),
    },
  }
  const res = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit', {
    method: 'POST',
    headers: volcanoAuthHeaders(volc, taskId, true),
    body: JSON.stringify(body),
  })
  const status = res.headers.get('X-Api-Status-Code') || ''
  const message = res.headers.get('X-Api-Message') || ''
  if (status !== '20000000') {
    const text = await res.text().catch(() => '')
    throw new Error(`Volcano submit failed: status=${status} message=${message} body=${text.slice(0, 500)}`)
  }
}

type VolcanoUtterance = {
  text?: string
  start_time?: number
  end_time?: number
  speaker_id?: number | string
  additions?: { speaker_id?: number | string; speaker?: string | number }
}

type VolcanoQueryResult = {
  status: string
  message: string
  result?: { text?: string; utterances?: VolcanoUtterance[] }
  audio_info?: { duration?: number }
}

async function volcanoQueryResult(volc: VolcanoConfig, taskId: string): Promise<VolcanoQueryResult> {
  const res = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/query', {
    method: 'POST',
    headers: volcanoAuthHeaders(volc, taskId, false),
    body: '{}',
  })
  const status = res.headers.get('X-Api-Status-Code') || ''
  const message = res.headers.get('X-Api-Message') || ''
  const text = await res.text().catch(() => '')
  let parsed: any = null
  if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }
  return { status, message, result: parsed?.result, audio_info: parsed?.audio_info }
}

function volcanoSpeakerLabel(u: VolcanoUtterance): string {
  const id = u.speaker_id ?? u.additions?.speaker_id ?? u.additions?.speaker
  if (id == null || id === '') return 'Speaker A'
  const n = Number(id)
  if (Number.isFinite(n) && n >= 0 && n < 26) return `Speaker ${String.fromCharCode(65 + n)}`
  return `Speaker ${String(id)}`
}

function volcanoFormatTranscript(result: { text?: string; utterances?: VolcanoUtterance[] }): string {
  const utterances = result.utterances || []
  if (!utterances.length) return (result.text || '').trim()
  const lines = utterances
    .map(u => {
      const text = String(u.text || '').trim()
      if (!text) return ''
      const start = formatSeconds(Math.round((u.start_time || 0) / 1000))
      const end = formatSeconds(Math.round((u.end_time || 0) / 1000))
      return `[${start}-${end}] ${volcanoSpeakerLabel(u)}: ${text}`
    })
    .filter(Boolean)
  return lines.join('\n')
}

async function volcanoTranscribeAudio(volc: VolcanoConfig, audioPath: string, rec: Recording): Promise<string> {
  const ext = extname(audioPath).toLowerCase() || '.mp3'
  const format = ext.replace(/^\./, '')
  const contentType = volcanoContentTypeFromExt(ext)
  const { month } = dateParts(rec.recordedAt)
  const key = `voicenote/${month}/${rec.sourceId}-${Date.now()}${ext}`
  const object = tosObject(volc.tos, key)
  console.log(`Volcano: upload audio to TOS as ${key}`)
  await withHeartbeat('upload audio to TOS', () => object.write(Bun.file(audioPath), { type: contentType }), 30)
  let cleanedUp = false
  const cleanup = async () => {
    if (cleanedUp || volc.tos.keep) return
    cleanedUp = true
    await object.delete().catch(e => warnSideEffect(`delete TOS object ${key}`, e))
  }
  try {
    const audioUrl = object.presign({ method: 'GET', expiresIn: 6 * 3600 })
    const taskId = randomUUID()
    console.log(`Volcano: submit ASR task ${taskId} (resource=${volc.resourceId}, format=${format})`)
    await volcanoSubmitTask(volc, taskId, audioUrl, format)
    const started = Date.now()
    const expectedSeconds = rec.durationSeconds || 0
    const maxWaitMs = Math.max(20 * 60 * 1000, Math.ceil(expectedSeconds * 1000 * 1.5))
    let lastStatusLog = 0
    let lastStatus = ''
    // Tolerate transient failures while polling: by this point the audio is
    // uploaded and the ASR task is submitted (money spent) — one dropped
    // socket or an HTTP-level error (gateway 5xx returns no X-Api-Status-Code
    // header, so q.status comes back empty) must not fail the whole job and
    // trigger a full re-upload + re-submit on the next tick. Only give up
    // after many failures in a row; throws when the budget or deadline is hit.
    let queryFailures = 0
    const transientQueryFailure = (desc: string): void => {
      queryFailures++
      if (queryFailures >= 10) throw new Error(`Volcano query failed ${queryFailures}x in a row: ${desc}`)
      if (Date.now() - started > maxWaitMs) throw new Error(`Volcano: timeout after ${formatElapsed(Date.now() - started)} (last error: ${desc})`)
      // console.error (not log) so wireDailyLog tags it [ERROR] and `vn errors`
      // surfaces it — matching chatCompleteViaPi's transient-retry logging.
      // A repeatedly-near-threshold ASR wobble is exactly what ops wants to see.
      console.error(`… Volcano: transient query failure (attempt ${queryFailures}/10, will retry): ${desc}`)
    }
    for (;;) {
      await new Promise(res => setTimeout(res, 8000))
      let q: VolcanoQueryResult
      try {
        q = await volcanoQueryResult(volc, taskId)
      } catch (e: any) {
        transientQueryFailure(String(e?.message || e))
        continue
      }
      if (!q.status) {
        transientQueryFailure(`empty status header (HTTP-level error, body: ${q.message || 'none'})`)
        continue
      }
      queryFailures = 0
      if (q.status === '20000000' && q.result) {
        console.log(`✓ Volcano: ASR done in ${formatElapsed(Date.now() - started)}; audio_duration=${q.audio_info?.duration ?? 'unknown'}ms`)
        return volcanoFormatTranscript(q.result)
      }
      if (q.status === '20000001' || q.status === '20000002') {
        if (q.status !== lastStatus || Date.now() - lastStatusLog > 60_000) {
          const label = q.status === '20000002' ? 'queued' : 'processing'
          console.log(`… Volcano: ${label} (status=${q.status}, ${formatElapsed(Date.now() - started)} elapsed)`)
          lastStatusLog = Date.now()
          lastStatus = q.status
        }
        if (Date.now() - started > maxWaitMs) throw new Error(`Volcano: timeout after ${formatElapsed(Date.now() - started)} (last status=${q.status})`)
        continue
      }
      if (q.status === '20000003') throw new Error('Volcano: 20000003 silent audio (no speech detected)')
      throw new Error(`Volcano query failed: status=${q.status} message=${q.message}`)
    }
  } finally {
    await cleanup()
  }
}

async function transcribeAudio(config: Config, audioPath: string, rec: Recording): Promise<string> {
  if (!config.volcano) throw new Error('Volcano ASR not configured. Set VOLCANO_ASR_KEY / VOLCANO_TOS_* in config.json.')
  return volcanoTranscribeAudio(config.volcano, audioPath, rec)
}


function speakerContextBlock(speakers: SpeakersConfig): string {
  const selfPart = speakers.self.name
    ? `The user: ${speakers.self.name}${speakers.self.aliases.length ? ` (aliases: ${speakers.self.aliases.join(', ')})` : ''}`
    : "The user's name is not configured."
  const knownPart = speakers.known.length
    ? speakers.known.map(k => `- ${k.name}${k.aliases?.length ? ` (aliases: ${k.aliases.join(', ')})` : ''}${k.relationship ? `, ${k.relationship}` : ''}`).join('\n')
    : '(no other known speakers)'
  return `Speaker context (use it to map Speaker A/B/C back to real names, but only when the evidence is solid):\n- ${selfPart}\n- Other known speakers:\n${knownPart}\n\nRules:\n- If the recording has a single speaker and the user's name is configured, treat Speaker A as the user.\n- In multi-speaker conversations, if a speaker is addressed by the user's name/alias, that speaker is the user.\n- In multi-speaker conversations, if a speaker is addressed by a known speaker's name/alias, that speaker is that known person.\n- Otherwise keep Speaker A/B/C as-is; never guess.`
}


function summaryMessages(config: Config, transcript: string, rec: Recording, localAudioPath: string): { role: 'system' | 'user'; content: string }[] {
  const readerName = config.speakers.self.name?.trim() || 'the user'
  const system = `You are ${readerName}'s personal semantic note-taking assistant, not a generic meeting-minutes template generator.

Your goal is not to reproduce a "meeting minutes" format, but to turn a recording into the most efficient understanding material: let ${readerName} quickly grasp what the discussion was really about, why it matters, what ideas/judgments/items it contains, what deserves attention, and what to do next.

Important: do not output only compressed "conclusions". Much of a recording's value lies in how views were raised, challenged, argued, and revised, and how consensus or disagreement formed. Without mechanically copying the transcript, reconstruct the key speakers' views, reasoning, debates, decision evolution, and how consensus emerged.

Core principles:
1. Structure is entirely determined by content. Do not apply any fixed template or emit fixed sections for form's sake.
2. Prioritize semantic value over paragraph-by-paragraph retelling; but do not flatten the process into conclusions. Important thinking, debate, validation, concession, rebuttal, and consensus-building are themselves semantic value.
3. Multi-person conversations must be reconstructed as much as possible: each side's initial concerns/positions, their reasons and examples, who raised challenges or rebuttals, how the discussion pivoted, which views were revised, what consensus formed, and which disagreements remain open.
4. Solo thinking must also have its reasoning path reconstructed: how the question was raised, how hypotheses were tested, why some options were ruled out, which experience/analogies supported the judgment, and why the current conclusion formed.
5. Freely choose the form: short memo, strategy memo, question tree, decision record, action list, mind-map-style hierarchy, phase review, debate review, study notes, product/technical analysis, etc.; pick whichever fits the content best.
6. If the discussion is conceptual/exploratory, focus on helping the reader understand the train of thought, key concepts, reasoning chains, shifts in views, and passages worth revisiting; do not force-extract to-dos.
7. If the discussion is execution/project-oriented, then besides conclusions, items, owners, risks, and next steps, also explain how those conclusions were reached: what constraints applied, which options were compared, and why the current path was chosen.
8. If the discussion is short, output only the minimal useful content; if long, you may start with a reading guide and then expand. For long content, err on the side of length rather than dropping key reasoning and debates.
9. Avoid filler, boilerplate, and formalistic headings. Every heading should carry information.
10. If real names appear in the transcript (see Speaker context below), use them directly; keep Speaker A/B/C only when unsure.
11. Explicitly flag uncertain or likely mis-transcribed words; do not treat them as facts.
12. Default is Integrated notes mode: the input transcript may not have been separately cleaned. Before generating content, internally perform necessary cleanup: fix obvious typos, unify terminology, restore speakers, merge verbal repetition, fix punctuation and sentence breaks; but never invent information not in the source, and never scrub away the genuine thinking process.

Write all output content (title, markdown, structured fields) in the dominant language of the transcript.

Output must be valid JSON, no markdown fences.

${speakerContextBlock(config.speakers)}`

  const user = `Generate a "semantic notes" document from the transcript below.

Processing mode: Integrated notes mode (no separate transcript cleanup pass; perform necessary cleanup, error correction, organization, and speaker restoration while generating the notes)

The reading scenario you serve:
- When ${readerName} opens these notes later, they should immediately know: what is worth reading in this recording, what the core ideas/items are, how those views were discussed/argued, what needs understanding, which questions remain open, and what to do next.
- Do not assume this is a "meeting"; it may be thinking aloud, product ideation, a technical discussion, a business judgment, study notes, an idea capture, a phone call, or task execution.
- Do not follow Feishu/generic meeting-minutes structures. The markdown structure is determined by the content's semantics.
- For multi-person discussions, the notes should help ${readerName} review the process: who raised what question, who held what view, who challenged what, how it was answered, where the turning points were, and how consensus formed or disagreements remained.
- If the transcript clearly contains discussion, debate, joint reasoning, option comparison, or evolving views, the markdown body must include a section that carries this "process reconstruction" (title up to you, e.g. "How the discussion unfolded", "How the views evolved", "Debate and consensus"); a bare conclusion list is not acceptable.

Recording info:
- Source file: ${rec.sourcePath}
- Local audio: ${localAudioPath}
- Time inferred from filename: ${rec.recordedAt.toISOString()}
- File size: ${rec.sizeBytes} bytes
- Duration: ${rec.durationSeconds} seconds

Output JSON with these fields:
{
  "title": "A title in the transcript's language that captures the real topic and value; avoid generic 'meeting minutes' phrasing",
  "date": "YYYY-MM-DD",
  "start_time": "HH:mm|null",
  "end_time": "HH:mm|null",
  "participants": ["Only actually identified real names (including the user's); never Speaker A/B"],
  "organizations": ["string"],
  "projects": ["string"],
  "markdown": "Full markdown body. Must start with an # H1 title. Structure is entirely yours based on the semantics; do not include the trailing source details block, the system appends it.",
  "discussion_flow": [{"stage": "discussion stage/topic", "what_happened": "what happened in this stage", "speaker_positions": [{"speaker": "real name or Speaker label", "position": "view/concern/reasoning"}], "turning_point": "key pivot or change of view|null", "outcome": "stage consensus/disagreement/open|null"}],
  "consensus_points": [{"point": "consensus reached", "how_reached": "how this consensus formed through discussion/argument|null"}],
  "disagreements": [{"issue": "point of disagreement", "positions": [{"speaker": "real name or Speaker label", "position": "stance and reasoning"}], "status": "resolved|unresolved|partially_resolved|null"}],
  "action_items": [{"task": "string", "owner": "string|null", "due_date": "YYYY-MM-DD|null", "priority": "high|medium|low|null", "note": "string|null"}],
  "decisions": [{"decision": "string", "reason": "string|null", "owner": "string|null", "date": "YYYY-MM-DD|null", "how_reached": "how this decision was reached|null"}],
  "open_questions": [{"question": "string", "next_step": "string|null"}],
  "key_quotes_or_details": ["string"],
  "transcription_uncertainties": ["string"]
}

Markdown quality requirements:
- The first screen must have a high signal-to-noise ratio: the reader should know why this content is worth keeping without reading the full transcript.
- No empty sections; no placeholder content like "no clear record / unknown / unidentified".
- Do not force headings like "Summary, To-dos, Smart sections, Key decisions, Quotes"; use them only when semantically warranted.
- If there are action items, use concrete actionable language; if there are none, do not fabricate any.
- If there are ideas/judgments, write out the reasoning chain, not just conclusions.
- If there was discussion, debate, or joint reasoning, preserve the key process: view raised → challenge/addition → response/rebuttal → revision/pivot → consensus/disagreement. Do not compress it into a single "in the end they concluded…".
- The markdown body should primarily reconstruct the process in natural language; do not just fill discussion_flow/consensus_points/disagreements as metadata and stop — those structured fields only aid your thinking and indexing.
- For important consensus, explain how it was reached; for important disagreements, state who held what view, why, and whether it was resolved.
- If a conclusion went through option comparison or trade-offs, write out the compared options, the criteria, and why one was dropped or chosen.
- For long meetings, review by topic/stage rather than as a running log, but keep each stage's key turning points and representative speakers' views.
- Clearly flag controversies, risks, and unverified assumptions.
- Timestamps may be used sparingly when they help revisit key passages; do not build a full timeline for form's sake.
- If the transcript has uncertain words, surface them in context as reminders; do not treat them as facts.
- In Integrated notes mode, especially avoid carrying stutters, repetitions, and typos from the raw transcript into the notes; the body should present cleaned, organized content while preserving the genuine reasoning, debates, and evolution of views.

Transcript:
${transcript}`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

// ───────────────────────────────────────────────────────────────────────
// Summary via pi. Provider and credentials are pi's own configuration. The
// optional VOICENOTE_PI_MODEL pins a model; otherwise pi's selected model writes
// the notes. VoiceNote does not implement a provider fallback chain.
// ───────────────────────────────────────────────────────────────────────

// pi can't be `bun build --compile`'d (it reads data files from disk), so the
// bundled GUI ships pi as plain JS and runs it under a bundled bun. When
// `pi.cli` is set, `pi.bin` is the runtime (bun) and the cli.js is prepended to
// pi's args — `<bun> <cli.js> <args>`, no wrapper script and no shell (critical
// on Windows, where pi args include a huge --system-prompt that a .cmd/%*
// wrapper would mangle). CLI users with a real `pi` on PATH leave it unset.
function piInvocation(pi: PiConfig, args: string[]): { bin: string; args: string[] } {
  return pi.cli ? { bin: pi.bin, args: [pi.cli, ...args] } : { bin: pi.bin, args }
}

// ───────────────────────────────────────────────────────────────────────
// ChatGPT (OpenAI Codex) OAuth login. The browser callback is the default;
// --device-code is available for accounts that opted into that flow. This
// exposes the login as a plain command for non-TUI and GUI users.
// The flow lives in chatgptAuth.ts; here we only persist the result to pi's
// auth.json in the exact shape it reads: { type: 'oauth', ...creds }.
// ───────────────────────────────────────────────────────────────────────

async function persistPiOAuth(authPath: string, providerId: string, creds: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(authPath), { recursive: true })
  let existing: Json = {}
  if (existsSync(authPath)) {
    try { existing = JSON.parse(await readFile(authPath, 'utf8')) as Json } catch (e) { warnSideEffect(`parse ${authPath}`, e) }
  }
  existing[providerId] = { type: 'oauth', ...creds }
  const tmp = `${authPath}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, authPath)
}

async function loginChatGPT(opts: { json?: boolean; deviceCode?: boolean; emit?: (o: Record<string, unknown>) => void }): Promise<void> {
  // OpenAI's OAuth endpoint is geo-blocked in some regions; getConfig() resolves
  // the proxy into this process's env before any request goes out.
  const authPath = getConfig().pi.authPath
  const json = !!opts.json
  const emit = opts.emit ?? ((o: Record<string, unknown>) => { if (json) console.log(JSON.stringify(o)) })
  try {
    const creds = opts.deviceCode
      // Device-code flow: no localhost server, but the account must first enable
      // "device code authorization for Codex" in ChatGPT > Settings > Security.
      ? await loginWithDeviceCode((info) => {
        if (json) emit({ event: 'device_code', userCode: info.userCode, verificationUri: info.verificationUri, intervalSeconds: info.intervalSeconds, expiresInSeconds: info.expiresInSeconds })
        else {
          console.log('\nTo sign in to ChatGPT (device code):')
          console.log(`  1. Open ${info.verificationUri}`)
          console.log(`  2. Enter code: ${info.userCode}`)
          console.log('\nIf you see "Enable device code authorization", turn it on in')
          console.log('ChatGPT > Settings > Security — or just rerun `vn login` (browser flow).')
          console.log('\nWaiting for authorization…')
        }
      })
      // Default: browser-callback flow (same as the official Codex CLI).
      : await loginWithBrowser((url) => {
        if (json) emit({ event: 'auth_url', url })
        else {
          console.log('\nOpening your browser to sign in to ChatGPT…')
          console.log(`If it doesn't open, paste this into a browser on THIS machine:\n  ${url}`)
        }
        // Best-effort auto-open; the URL is printed/emitted above as fallback.
        void openPath(url)
      })
    await persistPiOAuth(authPath, PI_PROVIDER_ID, creds as unknown as Record<string, unknown>)
    if (json) emit({ event: 'success', provider: PI_PROVIDER_ID })
    else console.log(`\n✓ Signed in. Credentials saved to ${authPath}. Verify with: vn doctor`)
  } catch (e: any) {
    let message = String(e?.message || e)
    if (/unsupported_country_region_territory|\b403\b/.test(message)) {
      message += ' — OpenAI blocks this region without a proxy. Set LOCAL_PROXY_HOST/LOCAL_PROXY_PORT (or http_proxy) and retry; Volcano stays direct.'
    }
    if (json) emit({ event: 'error', message })
    else console.error(`\nLogin failed: ${message}`)
    process.exitCode = 1
  }
}

// ───────────────────────────────────────────────────────────────────────
// File-based config (~/.config/voicenote/config.json) — written by the GUI
// via `vn config set`, read by loadEnvConfig(). ENV config uses ENV_KEYS;
// identity lives under the same file's `speakers` object.
// ───────────────────────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', d => { data += d })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
}

function configFileEnv(raw = loadConfigJson()): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of ENV_KEYS) if (typeof raw[k] === 'string') env[k] = raw[k] as string
  return env
}

function configGetData(): { path: string; env: Record<string, string>; self: { name: string | null; aliases: string[] } } {
  const current = loadConfigJson()
  const speakers = normalizeSpeakers(current.speakers ?? DEFAULT_SPEAKERS)
  return {
    path: CONFIG_ENV_PATH,
    env: configFileEnv(current),
    self: { name: speakers.self.name, aliases: speakers.self.aliases },
  }
}

function configGet(): void { console.log(JSON.stringify(configGetData(), null, 2)) }

type ConfigSetPayload = { env?: Record<string, unknown>; self?: { name?: string | null; aliases?: string[] } }

async function writeConfigJson(value: Record<string, unknown>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  const tmp = `${CONFIG_ENV_PATH}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, CONFIG_ENV_PATH)
}

async function configSetData(payload: ConfigSetPayload): Promise<{ ok: true; path: string; ignoredKeys?: string[] }> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Config payload must be a JSON object')
  const current = loadConfigJson()
  const known = ENV_KEYS as readonly string[]
  const ignored: string[] = []
  if (payload.env) {
    for (const [key, value] of Object.entries(payload.env)) {
      if (!known.includes(key)) { ignored.push(key); continue }
      if (value === null) delete current[key]
      else if (typeof value === 'string') current[key] = value
      else throw new Error(`Config value ${key} must be a string or null`)
    }
  }
  if (payload.self) {
    const speakers = normalizeSpeakers(current.speakers ?? DEFAULT_SPEAKERS)
    if (payload.self.name !== undefined) {
      if (payload.self.name !== null && typeof payload.self.name !== 'string') throw new Error('self.name must be a string or null')
      speakers.self.name = payload.self.name
    }
    if (payload.self.aliases !== undefined) {
      if (!Array.isArray(payload.self.aliases) || payload.self.aliases.some(alias => typeof alias !== 'string')) throw new Error('self.aliases must contain only strings')
      speakers.self.aliases = payload.self.aliases
    }
    current.speakers = speakers
  }
  await writeConfigJson(current)
  return { ok: true, path: CONFIG_ENV_PATH, ...(ignored.length ? { ignoredKeys: ignored } : {}) }
}

async function configSet(): Promise<void> {
  let payload: ConfigSetPayload
  try { payload = JSON.parse(await readStdin()) }
  catch (e: any) { console.error(`Invalid JSON on stdin: ${e?.message || e}`); process.exitCode = 1; return }
  // Every other key is re-read by the agent on each run, but VOICENOTE_PI_BIN
  // is snapshotted into the scheduler as a resolved absolute path at install
  // time (launchd's fixed PATH can't find it otherwise). The GUI reinstalls on
  // save; the CLI path must be told — but only when the value actually CHANGES.
  // A GUI-style client resubmits every field on every save, so `in payload`
  // alone would nag on every unrelated edit.
  const PI_BIN = 'VOICENOTE_PI_BIN'
  const before = String(loadConfigJson()[PI_BIN] ?? '')
  console.log(JSON.stringify(await configSetData(payload)))
  const piBinChanged = payload.env && PI_BIN in payload.env && String(payload.env[PI_BIN] ?? '') !== before
  if (piBinChanged) {
    console.error(`Note: ${PI_BIN} changed — re-run \`vn install-launch-agent\` to apply it to the background scheduler.`)
  }
}

function extractFirstJsonObject(text: string): string {
  const raw = text.trim()
  // Models often wrap JSON in a ```json fence; strip it before looking inside.
  const trimmed = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i)?.[1]?.trim() ?? raw
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  // Find the first balanced {...}
  let depth = 0, start = -1, inString = false, escape = false
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (escape) { escape = false; continue }
    if (inString) {
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') { if (depth === 0) start = i; depth++ }
    else if (ch === '}') { depth--; if (depth === 0 && start !== -1) return trimmed.slice(start, i + 1) }
  }
  return trimmed
}

type PiRunOptions = {
  systemPrompt: string
  userPrompt: string
  timeoutMs?: number
  thinking?: string
  tools?: string  // e.g. 'read,grep'; empty/undefined = --no-tools
  appendSystemPrompt?: string
  cwd?: string  // agent working dir: the knowledge base, so read/grep/find default there
}

async function runPi(config: Config, opts: PiRunOptions): Promise<string> {
  const args = [
    '-p',
    '--mode', 'text',
    '--no-extensions', '--no-skills', '--no-context-files', '--no-session', '--no-prompt-templates', '--no-themes',
    '--system-prompt', opts.systemPrompt,
  ]
  // Unset means pi's own default model and provider. There is no second
  // provider to fall back to either way.
  if (config.pi.model) args.push('--model', config.pi.model)
  if (opts.thinking) args.push('--thinking', opts.thinking)
  if (opts.tools && opts.tools.trim()) args.push('--tools', opts.tools.trim())
  else args.push('--no-tools')
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt)
  return new Promise<string>((resolve, reject) => {
    const inv = piInvocation(config.pi, args)
    const child = spawn(inv.bin, inv.args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd, windowsHide: true, env: { ...process.env, ...config.childEnv } })
    let stdout = '', stderr = ''
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null
    child.stdout.on('data', d => stdout += String(d))
    child.stderr.on('data', d => stderr += String(d))
    child.on('error', err => { if (timer) clearTimeout(timer); reject(err) })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      if (code !== 0) return reject(new Error(`pi exited ${code}: ${(stderr || stdout).slice(0, 800)}`))
      const text = stdout.trim()
      if (!text) return reject(new Error('pi returned empty output'))
      resolve(text)
    })
    // A pi that dies before draining stdin (bad flags, crash on startup) closes the
    // pipe mid-write. Without this handler the EPIPE is an unhandled 'error' event
    // that kills the whole run, hiding pi's actual error; 'close' below reports it.
    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE') warnSideEffect('write prompt to pi stdin', e)
    })
    child.stdin.end(opts.userPrompt)
  })
}

// A transient pi failure (proxy reset, dropped socket, upstream 5xx/429) is
// retried: a momentary blip must not cost a run its notes. Quota/auth/4xx are NOT
// transient — retrying them only wastes time, so they fail the summary at once.
function isTransientPiError(e: any): boolean {
  const msg = String(e?.message || e).toLowerCase()
  if (/quota|unauthorized|invalid.*(key|token|credential)|forbidden|\b40[0-4]\b/.test(msg)) return false
  return /socket connection was closed|socket hang up|econnreset|etimedout|esockettimedout|enetunreach|econnrefused|eai_again|fetch failed|network error|timed ?out|temporarily|overloaded|\b(429|500|502|503|504)\b/.test(msg)
}

async function chatCompleteViaPi(config: Config, opts: PiRunOptions): Promise<string> {
  const maxAttempts = config.pi.retries
  for (let attempt = 1; ; attempt++) {
    try {
      return await runPi(config, opts)
    } catch (e: any) {
      if (attempt >= maxAttempts || !isTransientPiError(e)) throw e
      const backoffMs = Math.min(30000, 2000 * 2 ** (attempt - 1))
      console.error(`pi transient error (attempt ${attempt}/${maxAttempts}); retrying in ${backoffMs}ms: ${e?.message || e}`)
      await new Promise(res => setTimeout(res, backoffMs))
    }
  }
}

function piSummaryToolsHint(contextDir: string): string {
  return `Before writing the notes you have two read-only tools: read and grep. Your current working directory (cwd) is \`${contextDir}\` (the configured notes/reference directory); use relative paths for grep/read.\n\nGoal: use existing context to align names, speakers, client/project names, product names, and domain terms in this note; do not maintain or assume a separate glossary.\n\nSuggested flow:\n- First extract the most likely client/project/product keywords from the title, filename, and transcript.\n- If a clear topic matches, prefer grep/read on related index pages, project docs, status records, or the 3-5 most recent related notes in the same directory; use them to identify Speaker B/C/F etc., common aliases, product names, and term spellings.\n- If no clear topic matches, grep the current directory with keywords and read only the few most relevant files.\n- Before output, do one names/terms lint pass: eliminate leftover Speaker A/B/C, obviously misheard names, product-name variants, and outdated names; when context is insufficient, keep the uncertainty — never guess.\n\nConstraints:\n- At most 10 tool calls total; if the transcript alone is sufficient, make none.\n- Read only within \`${contextDir}\`; skip directories that clearly involve personal privacy/credentials/finance (e.g. identity / credentials / finance).\n- Found information is only for consistency and background calibration; never write content absent from this transcript into the notes as new meeting facts.\n- Do not attempt to write files or call bash (those tools are not enabled).`
}

// Summary runs through pi. The agent's working dir IS the knowledge
// base, so read/grep/find operate there directly. If a configured context dir is
// missing, say so loudly and run without tools rather than searching the wrong
// tree (tools, the cwd hint, and the spawn cwd move together).
async function chatComplete(opts: { systemPrompt: string; userPrompt: string; config: Config }): Promise<string> {
  const { pi } = opts.config
  const ctx = pi.tools ? pi.contextDir : undefined
  const ctxExists = ctx ? existsSync(ctx) : false
  if (ctx && !ctxExists) console.error(`Warning: context dir ${ctx} does not exist; summary agent runs WITHOUT read/grep cross-reference.`)
  const toolsActive = !!ctx && ctxExists
  return chatCompleteViaPi(opts.config, {
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    timeoutMs: 60 * 60 * 1000,
    thinking: pi.thinking,
    tools: toolsActive ? pi.tools : undefined,
    appendSystemPrompt: toolsActive ? piSummaryToolsHint(ctx!) : undefined,
    cwd: toolsActive ? ctx : undefined,
  })
}

async function summarizeTranscript(config: Config, transcript: string, rec: Recording, localAudioPath: string): Promise<Json> {
  const messages = summaryMessages(config, transcript, rec, localAudioPath)
  const systemPrompt = String(messages[0]!.content)
  const userPrompt = String(messages[1]!.content)
  const text = await chatComplete({ systemPrompt, userPrompt, config })
  const jsonText = extractFirstJsonObject(text)
  try {
    return JSON.parse(jsonText || '{}') as Json
  } catch (e: any) {
    throw new Error(`summary returned non-JSON output (${e?.message || e}). First 400 chars: ${text.slice(0, 400)}`)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Metadata + markdown
// ────────────────────────────────────────────────────────────────────────────

function isSpeakerLabel(text: string): boolean {
  return /^\s*speaker\s+[a-z]\s*$/i.test(text) || /^\s*说话人\s*[A-ZＡ-Ｚa-zａ-ｚ一二三四五六七八九十0-9]+\s*$/.test(text)
}

function normalizeMetadata(meta: Json, rec: Recording): Json {
  const d = rec.recordedAt
  meta.date ||= `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  meta.start_time ||= `${pad(d.getHours())}:${pad(d.getMinutes())}`
  meta.end_time ??= null
  for (const key of ['participants', 'organizations', 'projects', 'discussion_flow', 'consensus_points', 'disagreements', 'action_items', 'decisions', 'open_questions', 'key_quotes_or_details', 'transcription_uncertainties']) {
    if (!Array.isArray(meta[key])) meta[key] = []
  }
  meta.participants = meta.participants.filter((p: any) => typeof p === 'string' && p.trim() && !isSpeakerLabel(p))
  return meta
}

const SOURCE_MARKER = '<!-- voicenote:source -->'
function sourceDetails(audioPath: string, transcriptPath: string): string {
  return `${SOURCE_MARKER}\n<details>\n<summary>Source</summary>\n\n- Generated by: voicenote automatic transcription\n- Original audio: \`${audioPath}\`\n- Full transcript: \`${transcriptPath}\`\n\n</details>`
}

function markdownNotes(meta: Json, audioPath: string, transcriptPath: string): string {
  let body = typeof meta.markdown === 'string' && meta.markdown.trim() ? meta.markdown.trim() : `# ${meta.title || 'Untitled recording notes'}\n`
  if (!body.startsWith('#')) body = `# ${meta.title || 'Untitled recording notes'}\n\n${body}`
  if (!body.includes(SOURCE_MARKER)) body = `${body.trim()}\n\n${sourceDetails(audioPath, transcriptPath)}`
  return `${body.trim()}\n`
}

async function markdownToPdf(markdownPath: string): Promise<string> {
  const pdfPath = markdownPath.replace(/\.md$/i, '.pdf')
  const tempBase = join(os.tmpdir(), `voicenote-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const htmlPath = `${tempBase}.html`
  const cssPath = `${tempBase}.css`
  const css = `
:root { color-scheme: light; }
body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; line-height: 1.68; color: #1f2328; max-width: 860px; margin: 40px auto; padding: 0 32px; font-size: 15px; }
h1, h2, h3 { line-height: 1.32; margin-top: 1.8em; color: #111827; }
h1 { font-size: 28px; border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; }
h2 { font-size: 22px; border-bottom: 1px solid #eef2f7; padding-bottom: 6px; }
h3 { font-size: 18px; }
p, ul, ol, blockquote, table { margin: 0.9em 0; }
blockquote { border-left: 4px solid #d0d7de; padding-left: 16px; color: #57606a; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; background: #f6f8fa; padding: 0.15em 0.35em; border-radius: 4px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #d0d7de; padding: 8px 10px; vertical-align: top; }
th { background: #f6f8fa; }
details { margin-top: 2em; color: #57606a; font-size: 13px; }
@page { size: A4; margin: 18mm 16mm; }
@media print { body { margin: 0; padding: 0; max-width: none; } h1, h2, h3 { break-after: avoid; } table, blockquote { break-inside: avoid; } }
`
  await writeFile(cssPath, css, 'utf8')
  try {
    const title = basename(markdownPath, extname(markdownPath))
    const pandoc = await runCommand('pandoc', [markdownPath, '--from', 'markdown+smart', '--to', 'html5', '--standalone', '--metadata', `title=${title}`, '--css', cssPath, '-o', htmlPath], 120000)
    if (pandoc.code !== 0) throw new Error(`pandoc failed: ${pandoc.stderr || pandoc.stdout}`)
    const chromePath = existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome'
    const chrome = await runCommand(chromePath, ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href], 120000)
    if (chrome.code !== 0 || !existsSync(pdfPath)) throw new Error(`chrome pdf failed: ${chrome.stderr || chrome.stdout}`)
    return pdfPath
  } finally {
    await unlink(htmlPath).catch(() => {})
    await unlink(cssPath).catch(() => {})
  }
}

function transcriptMarkdown(config: Config, rec: Recording, transcript: string, opts: { mode?: RunMode } = {}): string {
  const transcribeBackend = `Volcano Doubao (resource ${config.volcano?.resourceId || 'volc.seedasr.auc'})`
  return `# Transcript: ${basename(rec.sourcePath)}\n\n- Source file: \`${rec.sourcePath}\`\n- Transcription backend: ${transcribeBackend}\n- Mode: ${opts.mode || 'notes'}\n- Recorded at: ${rec.recordedAt.toISOString()}\n- File size: ${rec.sizeBytes} bytes\n- Duration: ${rec.durationSeconds ?? 'unknown'} seconds\n- Transcribed at: ${nowIso()}\n\n---\n\n${RAW_TRANSCRIPT_MARKER}${transcript.trim()}`
}

// ────────────────────────────────────────────────────────────────────────────
// Pipeline
// ────────────────────────────────────────────────────────────────────────────

async function processRecording(config: Config, rec: Recording, opts: any): Promise<Json> {
  const jobStarted = Date.now()
  let files = (opts.resumeFromTranscriptFiles as LocalFiles | null) || layout(config, rec)
  const mode = normalizeRunMode(opts)
  const needsNotes = mode === 'notes'
  const resumeSummary = needsNotes && Boolean(opts.resumeFromTranscriptFiles)
  const transcribeBackendLabel = `volcano:${config.volcano?.resourceId || 'volc.seedasr.auc'}`
  const llmBackendLabel = needsNotes && !opts.dryRun ? 'pi' : null
  const plan = resumeSummary
    ? 'reuse saved transcript → integrated semantic notes → write metadata/index (no auto move)'
    : `copy audio → transcribe → write transcript${needsNotes ? ' → integrated semantic notes' : ''} → write metadata/index (no auto move)`

  console.log(`\n=== voicenote job: ${basename(rec.sourcePath)} ===`)
  console.log(`Source: ${rec.sourcePath}`)
  console.log(`Audio: duration=${rec.durationSeconds == null ? 'unknown' : formatSeconds(rec.durationSeconds)}, size=${formatBytes(rec.sizeBytes)}, mode=${mode}, asr=${transcribeBackendLabel}${llmBackendLabel ? `, llm=${llmBackendLabel}` : ''}`)
  console.log(`Plan: ${plan}`)
  if (opts.dryRun) return { source_path: rec.sourcePath, source_id: rec.sourceId, would_copy_to: files.audio, resume_from_transcript: resumeSummary ? files.transcript : null, size_bytes: rec.sizeBytes, duration_seconds: rec.durationSeconds, mode }

  const totalSteps = resumeSummary ? 3 : needsNotes ? 4 : 3
  let stepNo = 0
  const nextStep = () => ++stepNo

  let transcript = ''
  let meta: Json = {
    title: basename(rec.sourcePath, extname(rec.sourcePath)),
    markdown: '',
  }

  if (resumeSummary) {
    progressStep(nextStep(), totalSteps, 'Reuse saved transcript', files.transcript)
    transcript = await readSavedTranscript(files.transcript)
    console.log(`✓ Reusing transcript: ${files.transcript}`)
    if (!existsSync(files.audio)) {
      await mkdir(dirname(files.audio), { recursive: true })
      await copyFile(rec.sourcePath, files.audio)
      console.log(`✓ Local audio restored: ${files.audio}`)
    }
  } else {
    progressStep(nextStep(), totalSteps, 'Copy audio to workspace', files.audio)
    await mkdir(dirname(files.audio), { recursive: true })
    await copyFile(rec.sourcePath, files.audio)
    console.log(`✓ Local audio ready: ${files.audio}`)

    progressStep(nextStep(), totalSteps, 'Transcribe audio', transcribeBackendLabel)
    transcript = await withHeartbeat('transcribe audio', () => transcribeAudio(config, files.audio, rec), 90)

    // Persist transcript IMMEDIATELY so an expensive ASR result is never lost
    // if a later step (summary) blows up. We use the initial (untitled) path;
    // if summary succeeds we'll move it to the titled path below.
    await mkdir(dirname(files.transcript), { recursive: true })
    // Atomic: "transcript exists on disk" is what makes a later run skip ASR, so
    // a run killed mid-write must not leave a truncated file behind. The raw
    // marker sits near the top, so a partial write would still pass
    // readSavedTranscript()'s checks and get summarised as if complete.
    await writeFileAtomic(files.transcript, transcriptMarkdown(config, rec, transcript, { mode }))
    console.log(`✓ Transcript saved: ${files.transcript}`)
  }

  let summaryError: any = null
  if (needsNotes) {
    progressStep(nextStep(), totalSteps, 'Generate integrated semantic notes', `via pi, model=${config.pi.model || "pi's own default"}`)
    try {
      meta = await withHeartbeat('generate integrated semantic notes', () => summarizeTranscript(config, transcript, rec, files.audio), 60)
    } catch (e: any) {
      summaryError = e
      console.error(`Summary step failed; transcript is preserved. Error: ${e?.message || e}`)
      console.error(`Hint: fix LLM auth/credits, then re-run with: vn run --latest`)
    }
  }

  meta = normalizeMetadata(meta, rec)
  meta.processing_mode = mode
  meta.source_audio_path = rec.sourcePath
  meta.source_id = rec.sourceId
  meta.source_size_bytes = rec.sizeBytes
  meta.source_modified_at = rec.modifiedAt
  meta.duration_seconds = rec.durationSeconds
  meta.asr_provider = 'volcano'
  meta.transcribe_model = config.volcano?.resourceId || 'volc.seedasr.auc'
  // pi picks the model, so we cannot name it here. Null when no summary ran —
  // summary_error says why.
  meta.llm_backend = needsNotes && !summaryError ? 'pi' : null
  meta.processed_at = nowIso()
  if (summaryError) meta.summary_error = String(summaryError?.message || summaryError)

  progressStep(nextStep(), totalSteps, 'Write outputs and index')
  let failedStubPathToRemove: string | null = null
  if (needsNotes && !summaryError) {
    const titled = layout(config, rec, meta.title)
    await promoteOutputs(files, titled)
    // The stub note of a failed attempt is removed only after the real note is
    // written, so a failure in between still leaves the user a pointer to the
    // saved transcript.
    if (files.notes !== titled.notes) failedStubPathToRemove = files.notes
    files = titled
  }
  await mkdir(dirname(files.notes), { recursive: true })
  await mkdir(dirname(files.metadata), { recursive: true })

  if (needsNotes && !summaryError) {
    await writeFile(files.notes, markdownNotes(meta, files.audio, files.transcript), 'utf8')
    console.log(`✓ Notes: ${files.notes}`)
    if (failedStubPathToRemove) await removeFailedSummaryStub(failedStubPathToRemove)
    if (opts.pdf) {
      const pdf = await withHeartbeat('render notes PDF', () => markdownToPdf(files.notes), 30)
      meta.local_paths = { ...files, pdf }
      console.log(`✓ PDF: ${pdf}`)
    }
  } else if (needsNotes && summaryError) {
    // No unconditional "just re-run" promise: after MAX_ATTEMPTS the job is
    // `gave_up` and further runs skip it, so the note has to name both ways out.
    const stubBody = `# Pending summary: ${basename(rec.sourcePath)}\n\n> ⚠ Transcription completed and saved, but the summary stage failed; retry needed.\n\n- Transcript file: \`${files.transcript}\`\n- Original audio: \`${rec.sourcePath}\`\n- Failure reason: ${meta.summary_error}\n- Retry: the next \`vn run\` reuses the saved transcript automatically (no new transcription cost). After ${MAX_ATTEMPTS} failed attempts it stops retrying — run \`vn forget ${basename(rec.sourcePath)}\` to queue it again.\n`
    await writeFile(files.notes, stubBody, 'utf8')
    console.log(`⚠ Stub notes (summary failed): ${files.notes}`)
  } else if (opts.pdf) {
    console.log('PDF skipped: --pdf only applies to --mode notes.')
  }

  meta.local_paths = { ...files, ...(meta.local_paths?.pdf ? { pdf: meta.local_paths.pdf } : {}) }
  meta.final_paths = {
    audio: files.audio,
    transcript: files.transcript,
    notes: needsNotes ? files.notes : null,
    metadata: files.metadata,
    ...(meta.local_paths?.pdf ? { pdf: meta.local_paths.pdf } : {}),
  }

  if (summaryError) {
    meta.status = SUMMARY_FAILED_STATUS
  } else if (needsNotes) {
    meta.status = 'completed'
  } else {
    meta.status = 'transcript_only'
  }

  await writeJson(files.metadata, meta)
  await appendJsonl(await notesIndexPath(config), meta)
  console.log(`✓ Completed: ${meta.title || basename(rec.sourcePath)} (${formatElapsed(Date.now() - jobStarted)} total)`)
  if (needsNotes) console.log(`Final notes: ${files.notes}`)
  else console.log(`Final transcript: ${files.transcript}`)
  return meta
}

// ────────────────────────────────────────────────────────────────────────────
// Job state — `vn run` is the only writer; every view is a pure read of this.
// ────────────────────────────────────────────────────────────────────────────

// Named for what it holds: every recording's job state, not just the processed
// ones. (Pre-0.18 this was `processed.json` with two reason-keyed buckets.)
const statePathFor = (config: Config) => join(config.workspace, '_state', 'jobs.json')

const legacyStatePathFor = (config: Config) => join(config.workspace, '_state', 'processed.json')

/**
 * Read-only load. On an un-migrated workspace this converts in memory and does
 * NOT write: `vn jobs` and the GUI's poll both come through here without the run
 * lock, and a write from a view could race a live `vn run`. Persisting the
 * conversion is migrateStateOnDisk()'s job, under the lock.
 */
// The legacy read is the one irreversible read in the codebase, so it gets the
// same strictness as the new format — `readJson` swallows a parse failure and
// returns `{}`, which here would mean "nothing was ever processed" and re-pay
// for every recording's ASR.
async function readLegacyState(config: Config): Promise<Json> {
  const path = legacyStatePathFor(config)
  return parseStrictJson(await readFile(path, 'utf8'), path) as Json
}

async function loadState(config: Config): Promise<StateFile> {
  const path = statePathFor(config)
  if (!existsSync(path) && existsSync(legacyStatePathFor(config))) {
    return migrateLegacyState(await readLegacyState(config), nowIso())
  }
  const store = existsSync(path) ? parseStateFile(await readFile(path, 'utf8'), path) : emptyState()
  lastSavedState = JSON.stringify(store)
  return store
}

// Inline rather than a repo script: most installs are the GUI's compiled
// sidecar, which has no checkout to run a script from — and starting from empty
// is not an option, it would re-transcribe everything and pay for ASR twice.
// Call only with the run lock held.
async function migrateStateOnDisk(config: Config): Promise<void> {
  const path = statePathFor(config)
  const legacy = legacyStatePathFor(config)
  if (existsSync(path) || !existsSync(legacy)) return
  const store = migrateLegacyState(await readLegacyState(config), nowIso())
  await writeJson(path, store)
  lastSavedState = JSON.stringify(store)
  await rename(legacy, `${legacy}.v1.bak`).catch(e => warnSideEffect('archive pre-0.18 state', e))
  console.log(`Converted ${basename(legacy)} → ${basename(path)} (${Object.keys(store.jobs).length} records; old file kept as .v1.bak)`)
}

// Workspaces are often synced folders; skip writes when a run did not change
// the state.
let lastSavedState = ''
async function saveState(config: Config, store: StateFile): Promise<void> {
  const serialized = JSON.stringify(store)
  if (serialized === lastSavedState) return
  await writeJson(statePathFor(config), store)
  lastSavedState = serialized
}

/** Upsert the scan-time facts; never touches lifecycle fields. */
function recordFor(store: StateFile, rec: Recording): JobRecord {
  const existing = store.jobs[rec.sourceId]
  const next: JobRecord = existing ?? {
    name: basename(rec.sourcePath), source_path: rec.sourcePath, content_hash: rec.contentHash, recorded_at: localIso(rec.recordedAt),
    size_bytes: rec.sizeBytes, duration_seconds: rec.durationSeconds,
    state: 'queued', code: null, detail: null, attempts: 0, updated_at: nowIso(), title: null, paths: null,
    ...(rec.imported ? { origin: 'import' as const } : {}),
  }
  next.source_path = rec.sourcePath
  next.content_hash = rec.contentHash
  next.size_bytes = rec.sizeBytes
  next.duration_seconds = rec.durationSeconds
  next.origin = rec.imported ? 'import' : undefined
  store.jobs[rec.sourceId] = next
  return next
}

// The live job, declared by the run itself. Lives next to run.lock (machine
// state, not workspace data) and carries the pid so a reader can tell a live
// job from one whose process was killed.
const CURRENT_PATH = join(STATE_DIR, 'current.json')

function writeCurrent(sourceId: string, step: string, startedAt: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    // tmp+rename, same rule as writeFileAtomic: this file's existence and
    // contents are the live-job signal, and progressStep rewrites it at every
    // step. A truncated write would read back as null and show a running job
    // as queued.
    const tmp = `${CURRENT_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, source_id: sourceId, step, started_at: startedAt } satisfies CurrentJob))
    renameSync(tmp, CURRENT_PATH)
  } catch (e) { warnSideEffect('write current job', e) }
}

function clearCurrent(): void {
  try { unlinkSync(CURRENT_PATH) } catch (e: any) { if (e?.code !== 'ENOENT') warnSideEffect('clear current job', e) }
}

// Step reporting from inside the pipeline: a job is only "the current job" for
// as long as this run says so, so the step is written, never guessed from logs.
let currentJobId: string | null = null
let currentJobStartedAt = ''
function reportStep(step: string): void {
  if (currentJobId) writeCurrent(currentJobId, step, currentJobStartedAt)
}

function readCurrent(): CurrentJob | null {
  let raw: string
  try { raw = readFileSync(CURRENT_PATH, 'utf8') } catch (e: any) {
    if (e?.code !== 'ENOENT') warnSideEffect('read current job', e)
    return null
  }
  // A damaged file means a live job shows up as queued; treating it as "no job"
  // is the safe read, but it must not be silent.
  try {
    const c = JSON.parse(raw)
    if (Number.isFinite(c?.pid) && typeof c?.source_id === 'string') return c
    warnSideEffect('read current job', new Error(`${CURRENT_PATH} has no pid/source_id`))
  } catch (e) { warnSideEffect('read current job', e) }
  return null
}

function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

async function runPipeline(file: string | undefined, opts: any): Promise<void> {
  wireDailyLog()
  const config = getConfig()
  opts = { ...opts, file }
  const lock = await acquireRunLock()
  if (!lock) {
    console.log('voicenote pipeline already running; skip')
    return
  }
  try {
    await runPipelineLocked(config, opts)
  } finally {
    await lock.release()
  }
}

async function runPipelineLocked(config: Config, opts: any): Promise<void> {
  await ensureDirs(config)
  // --dry-run is a zero-side-effect diagnostic; the migration renames the legacy
  // file and permanently drops its `error:*` entries. loadState converts in
  // memory, so a dry run still sees the right picture.
  if (!opts.dryRun) await migrateStateOnDisk(config)
  const store = await loadState(config)
  // We hold the run lock, so nothing else can own a `running` record: any that
  // survive are debris from a killed run. Their attempt was already counted, so
  // this is what makes the retry cap cover crashes as well as thrown errors.
  const interrupted = reconcileInterrupted(store.jobs, nowIso())
  if (interrupted.length) console.log(`Reclaimed ${interrupted.length} job(s) left running by an interrupted run: ${interrupted.slice(0, 3).map(j => j.name).join(', ')}`)

  // Explicit file: process exactly that path, wherever it lives. Nothing is
  // scanned, so the listing is never "complete" (no pruning), and the recorder
  // filters (age/size/duration) don't apply — the user named the file.
  const single = opts.file ? resolve(String(opts.file)) : null
  if (single && !statSync(single, { throwIfNoEntry: false })?.isFile()) throw new Error(`Not a file: ${single}`)
  if (single && !isCandidateFile(single)) throw new Error(`Unsupported audio file. Use: ${[...AUDIO_EXTENSIONS].join(', ')}`)
  const recorderPresent = existsSync(config.recordDir)
  const { recordings, complete: scanComplete } = single
    ? { recordings: [await toRecording(config, single)], complete: false }
    : await scanRecordings(config)
  if (!single && !recorderPresent && !recordings.length) {
    if (shouldLogIdleStatus(`missing:${config.recordDir}`)) {
      console.log(`Idle: recorder not mounted and no manual imports are queued: ${config.recordDir} (repeated idle logs suppressed for 30m)`)
    }
    return
  }
  const mode = normalizeRunMode(opts)
  const force = Boolean(opts.force)
  const eligible: Recording[] = []
  const skipCounts: Record<string, number> = {}
  const skipSamples: Record<string, string[]> = {}
  // An explicitly named file that gets skipped must say why, not fall into the
  // idle-suppressed silence meant for the 60s scheduler tick.
  const verboseSkips = Boolean(opts.verbose || opts.dryRun || single)
  const seen = new Set<string>()
  const automaticLimits = { maxAgeHours: config.maxAgeHours, minBytes: config.minBytes, minDurationSeconds: config.minDurationSeconds }
  const manualLimits = { maxAgeHours: 0, minBytes: 0, minDurationSeconds: 0 }
  for (const rec of recordings) {
    seen.add(rec.sourceId)
    const completedDuplicate = rec.imported && !store.jobs[rec.sourceId]
      ? completedJobByHash(store, rec.contentHash)
      : undefined
    if (completedDuplicate) {
      const name = basename(rec.sourcePath)
      skipCounts.already_done = (skipCounts.already_done || 0) + 1
      ;(skipSamples.already_done ||= []).push(name)
      if (!opts.dryRun) await removeImportedSource(rec.sourcePath)
      if (verboseSkips) console.log(`  Skip: ${name} (already_done)`)
      continue
    }
    const entry = recordFor(store, rec)
    const verdict = classify(rec, store.jobs[rec.sourceId], single || rec.imported ? manualLimits : automaticLimits, { force, notesMode: mode === 'notes', now: Date.now() })
    if (verdict.run) { eligible.push(rec); continue }
    skipCounts[verdict.code] = (skipCounts[verdict.code] || 0) + 1
    ;(skipSamples[verdict.code] ||= []).push(entry.name)
    if (verdict.persist) patchJob(entry, { state: 'filtered', code: verdict.code, detail: verdict.detail }, nowIso())
    if (rec.imported && verdict.code === 'already_done' && !opts.dryRun) await removeImportedSource(rec.sourcePath)
    if (verboseSkips) console.log(`  Skip: ${entry.name} (${verdict.code}${verdict.detail ? `: ${verdict.detail}` : ''})`)
  }
  // Only prune against a listing we believe to be complete: if the recorder went
  // away mid-glob the scan is partial, and pruning would wipe live queue entries
  // (they'd return on the next scan, but their retry counters would not).
  const dropped = pruneUnseen(store.jobs, seen, !single && scanComplete && existsSync(config.recordDir))
  // The only routine path that deletes state — never do it silently.
  if (dropped.length) console.log(`Forgot ${dropped.length} record(s) whose source is no longer on the recorder: ${dropped.slice(0, 3).map(j => j.name).join(', ')}${dropped.length > 3 ? `…(+${dropped.length - 3})` : ''}`)
  const skipSummary = Object.entries(skipCounts).map(([reason, count]) => `${reason}=${count}`).join(', ') || 'none'
  const scanLine = `Scan summary: found=${recordings.length}; eligible=${eligible.length}; skipped=${recordings.length - eligible.length} (${skipSummary})`
  const samplesLine = !verboseSkips && Object.keys(skipSamples).length
    ? `Skipped samples: ${Object.entries(skipSamples).map(([reason, names]) => `${reason}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? `…(+${names.length - 3})` : ''}`).join(' | ')}`
    : ''
  const latestOnly = Boolean(opts.latest)
  const targets = latestOnly ? eligible.slice(-1) : eligible
  // Preflight: if there is work but the run cannot complete, skip BEFORE spending
  // ASR money, rather than failing per-recording on every 60s StartInterval tick.
  // Idle-suppressed so a misconfigured daemon doesn't spam logs. Skipped for
  // --dry-run, which is a zero-side-effect diagnostic and should still print the
  // plan even on an unconfigured machine.
  if (targets.length && !opts.dryRun) {
    const needsAsr = targets.some(rec => !resumableTranscriptFiles(config, rec, store, mode, force))
    if (needsAsr && !config.volcano) {
      if (shouldLogIdleStatus(`asr-misconfig:${config.recordDir}`)) console.error('ASR not configured: Volcano needs VOLCANO_ASR_KEY / VOLCANO_TOS_*. Skipping; run `vn doctor`, fix config, then re-run.')
      return
    }
  }
  if (!targets.length) {
    if (verboseSkips || shouldLogIdleStatus(`idle:${config.recordDir}:${recordings.length}:${skipSummary}:${samplesLine}`)) {
      console.log(scanLine)
      if (samplesLine) console.log(samplesLine)
      console.log('Idle: no new recordings to process. (repeated idle logs suppressed for 30m)')
    }
  } else {
    console.log(scanLine)
    if (samplesLine) console.log(samplesLine)
    console.log(`Queue: processing ${targets.length} recording(s)${latestOnly ? ' (--latest)' : ''}. Remaining after this run: ${Math.max(0, eligible.length - targets.length)}`)
  }
  if (opts.dryRun) {
    // Print the plan and touch nothing: no attempt counted, no state written.
    for (const rec of targets) {
      const plan = await processRecording(config, rec, { ...opts, resumeFromTranscriptFiles: resumableTranscriptFiles(config, rec, store, mode, force) })
      console.log(JSON.stringify(plan, null, 2))
    }
    return
  }
  await saveState(config, store)

  for (const [targetIndex, rec] of targets.entries()) {
    const entry = store.jobs[rec.sourceId]!
    let importedDone = false
    // --force means "start over", so it refunds the retry budget too. Without
    // this it only skips one refusal: a spent record would be back at `gave_up`
    // the moment this attempt failed.
    if (force) patchJob(entry, { attempts: 0 }, nowIso())
    currentJobId = rec.sourceId
    currentJobStartedAt = nowIso()
    startAttempt(entry, nowIso())
    await saveState(config, store)
    writeCurrent(rec.sourceId, 'starting', currentJobStartedAt)
    try {
      const resumeFromTranscriptFiles = resumableTranscriptFiles(config, rec, store, mode, force)
      const result = await processRecording(config, rec, { ...opts, resumeFromTranscriptFiles })
      applyOutcome(entry, result.status === SUMMARY_FAILED_STATUS
        ? { kind: 'summary_failed', title: result.title ?? null, paths: result.final_paths ?? null, message: String(result.summary_error ?? 'summary failed; transcript saved') }
        : { kind: 'done', title: result.title ?? null, paths: result.final_paths ?? null }, nowIso())
      importedDone = rec.imported && result.status !== SUMMARY_FAILED_STATUS
    } catch (e: any) {
      const message = String(e?.message || e)
      console.error(`ERROR processing ${rec.sourcePath}: ${message}`)
      // Source vanished mid-run (recorder unplugged, file deleted) AND nothing
      // was produced: that's not a failed job, it's a job that no longer exists.
      // Drop it so it can't linger as a permanent "failed" row. A record that
      // already owns output is history — same rule pruneUnseen follows — and
      // deleting it would re-pay for ASR when the recorder comes back.
      if (!existsSync(rec.sourcePath) && !ownsOutput(entry)) {
        console.log(`Forgot ${entry.name}: source left the recorder before it produced anything`)
        delete store.jobs[rec.sourceId]
      } else {
        applyOutcome(entry, { kind: 'failed', message }, nowIso())
      }
    } finally {
      currentJobId = null
      clearCurrent()
      await saveState(config, store)   // per job, not per batch: a kill -9 costs one job, not the batch
    }
    if (importedDone) await removeImportedSource(rec.sourcePath)
    // Whole recorder went away — every remaining recorder target would fail the
    // same way. Local imports do not depend on the recorder and keep running.
    if (!single && !existsSync(config.recordDir) && targets.slice(targetIndex + 1).some(target => !target.imported)) {
      console.error(`Recorder disappeared mid-run (${config.recordDir}); stopping. Remaining recordings stay queued.`)
      break
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// LaunchAgent
// ────────────────────────────────────────────────────────────────────────────

// Bun standalone executables embed source in a virtual FS, so import.meta.url is
// NOT a real on-disk path: "/$bunfs/..." on mac/Linux, "B:\~BUN\root\..." on
// Windows. Either marker means we're the compiled exe (run it directly via
// process.execPath); otherwise we're bun + cli.ts on disk. NOTE: matching only
// $bunfs (the old check) misfired on Windows and leaked the virtual path into the
// scheduled task's arguments.
function resolveCli(): { cliPath: string; compiled: boolean } {
  const cliPath = fileURLToPath(import.meta.url)
  return { cliPath, compiled: /\$bunfs|~BUN/i.test(cliPath) }
}

function plistPath(): string {
  return join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// Scheduled runs read all business settings from config.json. The plist only
// carries a fixed PATH and desktop-bundled runtime paths that do not exist in
// that file.
async function launchAgentEnv(config: Config): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    PATH: `${os.homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  }
  // Provenance matters here, so this reads the raw sources rather than Config:
  // only paths the GUI injected into our environment (and that config.json does
  // not already carry) have to be written into the plist. VOICENOTE_PI_BIN and
  // VOICENOTE_PI_CLI travel as a pair — `<bun> <cli.js>` with the script half
  // missing would start bun with no program. A pi that vn resolves from its own
  // node_modules needs no entry at all: the scheduled run resolves it the same
  // way, and it stays correct when bun or pi is upgraded underneath.
  const fileEnv = configFileEnv()
  for (const key of ['VOICENOTE_PI_BIN', 'VOICENOTE_PI_CLI', 'VOICENOTE_FFPROBE_BIN'] as const) {
    if (process.env[key] && process.env[key] !== fileEnv[key]) env[key] = process.env[key]!
  }
  // A bare `pi` resolves only through PATH, and launchd's PATH is not the login
  // shell's — pin it now, while the user's environment is still available.
  if (!config.pi.cli && !config.pi.bin.startsWith('/') && !env.VOICENOTE_PI_BIN) {
    const found = await runCommand(IS_WINDOWS ? 'where' : 'which', [config.pi.bin], 5000)
    const path = found.code === 0 ? (found.stdout.trim().split(/\r?\n/)[0] || '') : ''
    if (path && existsSync(path)) env.VOICENOTE_PI_BIN = path
  }
  return env
}

async function installLaunchAgent(opts: { load?: boolean } = {}): Promise<void> {
  const { cliPath, compiled } = resolveCli()
  const programArgs = compiled
    ? [process.execPath, 'run']
    : [existsSync('/opt/homebrew/bin/bun') ? '/opt/homebrew/bin/bun' : process.execPath, cliPath, 'run']
  const programArgsXml = programArgs.map(a => `    <string>${xmlEscape(a)}</string>`).join('\n')
  const plist = plistPath()
  await mkdir(dirname(plist), { recursive: true })
  await mkdir(LOG_DIR, { recursive: true })
  const env = await launchAgentEnv(getConfig())
  const envEntries = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`).join('\n')
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/launchd.err.log</string>
  <key>WorkingDirectory</key>
  <string>${os.homedir()}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
</dict>
</plist>
`
  await writeFile(plist, content, 'utf8')
  // Keep scheduler details private and tighten permissions on older plists.
  await chmod(plist, 0o600)
  const summary = Object.keys(env).join(', ')
  console.log(`LaunchAgent written: ${plist}`)
  console.log(`Embedded env keys: ${summary}`)
  if (opts.load) {
    const uid = process.getuid?.()
    // Remove the legacy-label agent so old installs don't double-run vn.
    const legacyPlist = join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL_LEGACY}.plist`)
    if (existsSync(legacyPlist)) {
      await runCommand('launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL_LEGACY}`], 10000)
      await unlink(legacyPlist).catch(e => warnSideEffect(`remove legacy LaunchAgent ${legacyPlist}`, e))
    }
    await runCommand('launchctl', ['bootout', `gui/${uid}`, plist], 10000) // ignore if not loaded
    const r = await runCommand('launchctl', ['bootstrap', `gui/${uid}`, plist], 10000)
    await runCommand('launchctl', ['enable', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], 10000)
    if (r.code === 0) console.log('LaunchAgent loaded (launchctl bootstrap).')
    else console.error(`bootstrap exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`)
  } else {
    console.log(`Enable with: launchctl bootstrap gui/$(id -u) ${plist}`)
  }
}

async function uninstallLaunchAgent(): Promise<void> {
  await runCommand('launchctl', ['bootout', `gui/${process.getuid?.()}`, plistPath()], 10000)
  console.log(`Bootout attempted: ${plistPath()}`)
}

// ────────────────────────────────────────────────────────────────────────────
// Windows Task Scheduler (parallel to the mac LaunchAgent above)
// ────────────────────────────────────────────────────────────────────────────

function taskXmlPath(): string { return join(STATE_DIR, 'task.xml') }
function taskVbsPath(): string { return join(STATE_DIR, 'run-hidden.vbs') }

// Run via the interpreter currently executing us: process.execPath is the
// absolute bun.exe (or the compiled vn.exe). Mirrors installLaunchAgent's
// compiled-vs-script detection.
function schedulerProgramArgs(): { command: string; argLine: string } {
  const { cliPath, compiled } = resolveCli()
  const args = compiled ? ['run'] : [cliPath, 'run']
  const argLine = args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
  return { command: process.execPath, argLine }
}

async function installScheduledTask(opts: { load?: boolean } = {}): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  await mkdir(LOG_DIR, { recursive: true })
  // The task carries no env (Task Scheduler has no per-task env block), so the
  // bundled CLI paths the GUI injected via process env (pi runtime + cli.js +
  // ffprobe) must be persisted to config.json, which `vn run` reads on startup.
  // (On mac these ride in the LaunchAgent plist instead.)
  const persist: Record<string, string> = {}
  for (const k of ['VOICENOTE_PI_BIN', 'VOICENOTE_PI_CLI', 'VOICENOTE_FFPROBE_BIN'] as const) {
    if (process.env[k]) persist[k] = process.env[k]!
  }
  if (Object.keys(persist).length) {
    await mkdir(CONFIG_DIR, { recursive: true })
    const current = loadConfigJson()
    Object.assign(current, persist)
    await writeConfigJson(current)
  }
  const { command, argLine } = schedulerProgramArgs()
  // bun.exe / vn.exe are console-subsystem: an InteractiveToken task flashes a
  // console window on every tick. Launch through wscript with window style 0
  // (hidden). wait=True keeps wscript alive for the duration of `vn run` so
  // IgnoreNew still prevents overlap, and WScript.Quit propagates vn's exit
  // code so the task's Last Run Result stays meaningful. UTF-16 BOM so
  // non-ASCII paths survive (wscript reads BOM-less files as ANSI).
  const fullCmd = `"${command}" ${argLine}`
  const vbs = `WScript.Quit CreateObject("WScript.Shell").Run("${fullCmd.replace(/"/g, '""')}", 0, True)\r\n`
  await writeFile(taskVbsPath(), '\ufeff' + vbs, 'utf16le')
  const wscript = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
  // Register the task as the current user (DOMAIN\user; DOMAIN == machine name for
  // local accounts). Without an explicit <UserId>, `schtasks /create /xml` can't tell
  // who to register as and a standard (non-admin) user gets "Access is denied".
  const taskUser = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : (process.env.USERNAME || os.userInfo().username)
  // Local-time StartBoundary for the TimeTrigger (Task Scheduler wants no zone).
  const n = new Date()
  const startBoundary = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`
  // The task just runs `vn run`; config comes from config.json (vn config set /
  // the GUI), so unlike the mac plist there's no env to embed. A TimeTrigger that
  // repeats every PT1M (mirrors the working `schtasks /sc minute /mo 1` form; a
  // LogonTrigger gave "Access is denied" for standard users) + IgnoreNew is the
  // StartInterval(60)+flock equivalent.
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>VoiceNote: watch the recorder and process new recordings.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(taskUser)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <AllowHardTerminate>true</AllowHardTerminate>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(wscript)}</Command>
      <Arguments>${xmlEscape(`//B //Nologo "${taskVbsPath()}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`
  const xmlPath = taskXmlPath()
  // schtasks /xml wants UTF-16; prepend a BOM so non-ASCII paths survive.
  await writeFile(xmlPath, '\ufeff' + xml, 'utf16le')
  const r = await runCommand('schtasks', ['/create', '/tn', TASK_NAME, '/xml', xmlPath, '/f'], 15000)
  if (r.code !== 0) {
    console.error(`schtasks /create failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`)
    process.exitCode = 1
    return
  }
  console.log(`Scheduled task '${TASK_NAME}' installed — runs \`vn run\` every 60s at/after logon.`)
  console.log(`Command: ${command} ${argLine} (launched hidden via wscript)`)
  console.log('Note: the task reads config from config.json — set it with `vn config set` (or the GUI) so the background run is configured.')
  if (opts.load) await runCommand('schtasks', ['/run', '/tn', TASK_NAME], 10000)
}

async function uninstallScheduledTask(): Promise<void> {
  const r = await runCommand('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], 10000)
  // Remove our artifacts too: the VBS is the task's actual entry point, and a
  // leftover copy could make schedulerIsCurrent misjudge a future install.
  // Only when the task is actually gone — deleting the VBS while the task is
  // still registered would turn every tick into a silent wscript failure.
  if (r.code === 0) {
    for (const p of [taskVbsPath(), taskXmlPath()]) {
      try { unlinkSync(p) } catch (e: any) { if (e?.code !== 'ENOENT') warnSideEffect(`remove scheduler artifact ${p}`, e) }
    }
  }
  console.log(r.code === 0 ? `Scheduled task '${TASK_NAME}' removed.` : `schtasks /delete: ${(r.stderr || r.stdout).trim()}`)
}

// ── Cross-platform scheduler dispatch ──
function installScheduler(opts: { load?: boolean } = {}): Promise<void> {
  return IS_WINDOWS ? installScheduledTask(opts) : installLaunchAgent(opts)
}
function uninstallScheduler(): Promise<void> {
  return IS_WINDOWS ? uninstallScheduledTask() : uninstallLaunchAgent()
}
async function printSchedulerStatus(): Promise<void> {
  if (IS_WINDOWS) {
    const r = await runCommand('schtasks', ['/query', '/tn', TASK_NAME, '/v', '/fo', 'LIST'], 10000)
    process.stdout.write(r.stdout || r.stderr || `Task '${TASK_NAME}' not found.\n`)
    return
  }
  const r = await runCommand('launchctl', ['print', `gui/${process.getuid?.()}/${LAUNCH_AGENT_LABEL}`], 10000)
  process.stdout.write(r.stdout || r.stderr)
}

// ────────────────────────────────────────────────────────────────────────────
// Browse / debug commands
// ────────────────────────────────────────────────────────────────────────────

async function listMeetings(opts: { month?: string }): Promise<void> {
  const config = getConfig()
  const month = opts.month || `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`
  const dir = join(config.workspace, month)
  if (!existsSync(dir)) {
    console.log(`No notes in ${dir}`)
    return
  }
  const entries = (await readdir(dir)).filter(f => f.endsWith('.md')).sort()
  if (!entries.length) {
    console.log(`No notes in ${dir}`)
    return
  }
  for (const name of entries) {
    console.log(join(dir, name))
  }
}

// One-time migration: pre-0.15.4 wrote _index/meetings.jsonl. Rename it to the new
// canonical notes.jsonl on first access so all history stays in a single file.
async function notesIndexPath(config: Config): Promise<string> {
  const p = join(config.workspace, '_index', 'notes.jsonl')
  const legacy = join(config.workspace, '_index', 'meetings.jsonl')
  if (!existsSync(p) && existsSync(legacy)) await rename(legacy, p).catch(e => warnSideEffect(`rename ${legacy}`, e))
  return p
}

async function lastMeeting(): Promise<void> {
  const config = getConfig()
  const indexPath = await notesIndexPath(config)
  if (!existsSync(indexPath)) {
    console.log('No notes indexed yet.')
    return
  }
  const lines = (await readFile(indexPath, 'utf8')).trim().split('\n').filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) {
    console.log('No notes indexed yet.')
    return
  }
  let obj: Json
  try { obj = JSON.parse(last) } catch { console.log(last); return }
  console.log(`Title:        ${obj.title}`)
  console.log(`Date:         ${obj.date} ${obj.start_time || ''}-${obj.end_time || ''}`)
  console.log(`Status:       ${obj.status || 'unknown'}`)
  console.log(`Notes:        ${obj.final_paths?.notes || obj.local_paths?.notes}`)
  console.log(`Transcript:   ${obj.final_paths?.transcript || obj.local_paths?.transcript}`)
  console.log(`Audio:        ${obj.final_paths?.audio || obj.local_paths?.audio}`)
}


async function openTarget(arg?: string): Promise<void> {
  const config = getConfig()
  let target = config.workspace
  if (arg === 'config') {
    target = CONFIG_DIR
  } else if (arg === 'logs') {
    target = LOG_DIR
  } else if (arg) {
    // Try matching most recent file in current month containing arg.
    const month = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`
    const dir = join(config.workspace, month)
    if (existsSync(dir)) {
      const matches = (await readdir(dir)).filter(f => f.includes(arg) && f.endsWith('.md'))
      if (matches.length) target = join(dir, matches[matches.length - 1]!)
    }
  }
  await openPath(target)
  console.log(`open ${target}`)
}

function completedJobByHash(store: StateFile, digest: string): [string, JobRecord] | undefined {
  return Object.entries(store.jobs).find(([, job]) => job.state === 'done' && job.content_hash === digest)
}

type ImportResult = {
  status: 'queued' | 'running' | 'gave_up' | 'already_done'
  id: string
  name: string
  title: string | null
  notes: string | null
}

async function importRecording(file: string, opts: { json?: boolean }): Promise<void> {
  const source = resolve(file)
  const sourceStat = await stat(source).catch(() => null)
  if (!sourceStat?.isFile()) throw new Error(`Not a file: ${source}`)
  if (!isCandidateFile(source)) throw new Error(`Unsupported audio file. Use: ${[...AUDIO_EXTENSIONS].join(', ')}`)

  const config = getConfig()
  await ensureDirs(config)
  const digest = await sha256File(source)
  const id = `import:${digest}`
  const store = await loadState(config)
  const entry = store.jobs[id]
  const doneMatch = entry?.state === 'done'
    ? [id, entry] as const
    : entry ? undefined : completedJobByHash(store, digest)
  let result: ImportResult

  if (doneMatch) {
    const [doneId, done] = doneMatch
    result = { status: 'already_done', id: doneId, name: done.name, title: done.title, notes: done.paths?.notes ?? null }
  } else {
    const digestDir = join(inboxPathFor(config), digest)
    const queuedName = (await readdir(digestDir).catch(() => []))
      .find(name => isCandidateFile(name) && statSync(join(digestDir, name), { throwIfNoEntry: false })?.isFile())
    const existingSource = entry?.source_path && existsSync(entry.source_path) ? entry.source_path : null
    const inboxFile = existingSource ?? (queuedName ? join(digestDir, queuedName) : join(digestDir, basename(source)))
    if (!existsSync(inboxFile)) {
      await mkdir(dirname(inboxFile), { recursive: true })
      const tmp = join(dirname(inboxFile), `.${basename(inboxFile)}.tmp-${process.pid}`)
      try {
        await copyFile(source, tmp)
        await utimes(tmp, sourceStat.atime, sourceStat.mtime)
        await rename(tmp, inboxFile)
      } finally {
        await unlink(tmp).catch(() => {})
      }
    }
    result = {
      status: entry?.state === 'running' ? 'running' : entry?.state === 'gave_up' ? 'gave_up' : 'queued',
      id, name: entry?.name ?? basename(source), title: entry?.title ?? null, notes: entry?.paths?.notes ?? null,
    }
  }

  if (opts.json) console.log(JSON.stringify(result))
  else if (result.status === 'already_done') console.log(`already processed: ${result.title || result.name}`)
  else console.log(`${result.status}: ${result.name}`)
}

async function removeImportedSource(path: string): Promise<void> {
  try { await unlink(path) }
  catch (e: any) { if (e?.code !== 'ENOENT') { warnSideEffect(`remove imported source ${path}`, e); return } }
  await rmdir(dirname(path)).catch((e: any) => {
    if (e?.code !== 'ENOENT' && e?.code !== 'ENOTEMPTY') warnSideEffect(`remove empty import dir ${dirname(path)}`, e)
  })
}

async function forgetRecording(needle: string): Promise<void> {
  const config = getConfig()
  // Under the run lock: `vn run` holds the state file in memory for the length
  // of a batch and re-saves after every job, so an unlocked delete here would be
  // silently resurrected by the next save.
  const lock = await acquireRunLock()
  if (!lock) { console.error('A voicenote run is in progress, so the state file is busy. Re-run this once it finishes (`vn jobs` shows what it is working on).'); process.exitCode = 1; return }
  try {
    await migrateStateOnDisk(config)
    const store = await loadState(config)
    let removed = 0
    for (const [id, entry] of Object.entries(store.jobs)) {
      if (id === needle || entry.source_path.includes(needle) || entry.name.includes(needle)) {
        delete store.jobs[id]
        removed++
      }
    }
    await saveState(config, store)
    console.log(`forgot ${removed} record(s)`)
  } finally { await lock.release() }
}

async function retryRecording(id: string): Promise<void> {
  const config = getConfig()
  const lock = await acquireRunLock()
  if (!lock) throw new Error('A voicenote run is in progress. Retry once it finishes.')
  try {
    await migrateStateOnDisk(config)
    const store = await loadState(config)
    const entry = store.jobs[id]
    if (!entry) throw new Error('Recording no longer exists in the processing list.')
    if (!requeueFailed(entry, nowIso())) throw new Error(`Cannot retry a recording in state '${entry.state}'.`)
    await saveState(config, store)
    console.log(`queued ${entry.name} for retry`)
  } finally { await lock.release() }
}

async function showLog(opts: { lines?: number; follow?: boolean; err?: boolean; date?: string }): Promise<void> {
  const lines = Number(opts.lines || 30)
  const wanted = [opts.date ? join(LOG_DIR, `${opts.date}.log`) : dailyLogPath()]
  if (opts.err) wanted.push(join(LOG_DIR, 'launchd.err.log'))
  const files = wanted.filter(f => existsSync(f))
  if (!files.length) {
    console.log(`No log file: ${wanted.join(', ')}`)
    return
  }
  await tailFiles(files, lines, !!opts.follow)
}

async function showErrors(opts: { lines?: number }): Promise<void> {
  if (!existsSync(LOG_DIR)) {
    console.log('No logs.')
    return
  }
  // Only the daily rolling logs (YYYY-MM-DD.log) carry timestamped [ERROR] lines;
  // launchd.out.log/launchd.err.log are raw, never-truncated stdout/stderr mirrors
  // that sort after dated files alphabetically ('l' > digit) and would otherwise
  // crowd out the real recent logs in the slice(-3) below.
  const files = (await readdir(LOG_DIR)).filter(f => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().slice(-3)
  if (!files.length) {
    // Distinguish "no dated logs yet" (fresh install) from "scanned, no errors".
    console.log('No logs.')
    return
  }
  const lineCount = Number(opts.lines || 20)
  const errors: string[] = []
  for (const f of files) {
    const content = await readFile(join(LOG_DIR, f), 'utf8').catch(() => '')
    for (const line of content.split('\n')) {
      if (line.includes('[ERROR]') || line.includes('ERROR processing')) errors.push(line)
    }
  }
  for (const line of errors.slice(-lineCount)) console.log(line)
}

async function upgradeSelf(): Promise<void> {
  // The registry fetch needs the configured proxy: `bun add -g` only sees it if
  // we pass it, because the proxy lives in config.json, not in the shell.
  const env = { ...process.env, ...getConfig().childEnv }
  // Plain `bun` from PATH: vn is started by bun (`#!/usr/bin/env bun`), so an
  // interactive upgrade always has it. If it is somehow missing, the spawn error
  // below says so instead of the command silently "failing".
  // `bun add -g` upgrades in place: verified no dependency loop on npm→npm re-add
  // (the steady-state upgrade path) nor on replacing an old git-ref install. No
  // remove-first, so a failed add leaves the running vn intact.
  console.log('$ bun add -g @fastagent-sh/voicenote')
  const addCode = await new Promise<number>(res =>
    spawn('bun', ['add', '-g', '@fastagent-sh/voicenote'], { stdio: 'inherit', shell: IS_WINDOWS, env })
      .on('close', c => res(c ?? 1))
      .on('error', (e: Error) => { console.error(`Cannot run bun: ${e.message}`); res(1) }))
  if (addCode !== 0) {
    console.error(`Upgrade failed: \`bun add -g @fastagent-sh/voicenote\` exited ${addCode}. Your current install is unchanged; retry later.`)
    process.exitCode = 1
    return
  }
  // Refresh the background scheduler so it points at the upgraded version. This
  // process is still the OLD code in memory, so invoke the freshly installed binary
  // to regenerate.
  if (IS_WINDOWS) {
    const installed = (await runCommand('schtasks', ['/query', '/tn', TASK_NAME], 10000)).code === 0
    if (installed) {
      const code = await new Promise<number>(res =>
        spawn('vn', ['install-launch-agent'], { stdio: 'inherit', shell: true })
          .on('close', c => res(c ?? 1)).on('error', () => res(1)))
      console.log(code === 0 ? 'Scheduled task refreshed.' : 'Warning: `vn install-launch-agent` failed; re-register manually.')
    }
    return
  }
  if (existsSync(plistPath())) {
    console.log('Refreshing LaunchAgent plist for the upgraded version…')
    const code = await new Promise<number>(res =>
      spawn('vn', ['install-launch-agent'], { stdio: 'inherit' })
        .on('close', c => res(c ?? 1)).on('error', () => res(1)))
    if (code !== 0) {
      console.error(`Warning: \`vn install-launch-agent\` failed (exit ${code}); the LaunchAgent still points at the previous version. Ensure vn is on PATH and re-run \`vn install-launch-agent\`.`)
      return
    }
    const uid = process.getuid?.()
    await runCommand('launchctl', ['bootout', `gui/${uid}`, plistPath()], 10000)   // ok if not currently loaded
    const bs = await runCommand('launchctl', ['bootstrap', `gui/${uid}`, plistPath()], 10000)
    if (bs.code !== 0) {
      console.error(`Warning: launchctl bootstrap failed: ${(bs.stderr || bs.stdout).trim()}. Reload manually: launchctl bootstrap gui/$(id -u) ${plistPath()}`)
      return
    }
    console.log('LaunchAgent reloaded.')
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Doctor
// ────────────────────────────────────────────────────────────────────────────

// Read up to the last `maxBytes` of a (possibly large, ever-appending) log file
// without slurping the whole thing — used to surface the agent's latest activity.
function readLogTail(path: string, maxBytes: number): string {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, start)
      return buf.toString('utf8')
    } finally { closeSync(fd) }
  } catch { return '' }
}

// Where the background agent's latest activity lands. mac: launchd redirects
// the agent's stdout to launchd.out.log. Windows: Task Scheduler redirects
// nothing — the agent's own daily rolling log is the only mirror of its
// output. wireDailyLog captures the log path once at process start, so a run
// spanning midnight keeps writing to its START day's file; pick the
// most-recently-modified dated log rather than today's by name, or a
// still-running cross-midnight job would look idle on the dashboard.
function agentLogPath(): string {
  if (!IS_WINDOWS) return join(LOG_DIR, 'launchd.out.log')
  try {
    const dated = readdirSync(LOG_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .map(f => join(LOG_DIR, f))
    let newest: string | null = null
    let newestMs = -Infinity
    for (const p of dated) {
      const ms = statSync(p).mtimeMs
      if (ms > newestMs) { newestMs = ms; newest = p }
    }
    return newest ?? dailyLogPath()
  } catch { return dailyLogPath() }
}

// Is the background scheduler installed at all (any version)? Cheaper cousin
// of schedulerIsCurrent(), used for the dashboard's installed/not-installed
// pill — mac checks the plist file, Windows must ask schtasks (there is no
// file whose existence tracks task registration).
async function schedulerInstalledAtAll(): Promise<boolean> {
  if (IS_WINDOWS) return (await runCommand('schtasks', ['/query', '/tn', TASK_NAME], 10000)).code === 0
  return existsSync(plistPath())
}

// Background agent snapshot for the dashboard (LaunchAgent / Scheduled Task).
async function agentStatus() {
  const logFile = agentLogPath()
  let logTail: string[] = []
  let logAt: string | null = null
  if (existsSync(logFile)) {
    try { logAt = statSync(logFile).mtime.toISOString() } catch {}
    logTail = readLogTail(logFile, 16384).split('\n').map(s => s.trim()).filter(Boolean).slice(-8)
  }
  // `scheduler` points at the on-disk scheduler entry for `vn doctor` to show.
  // mac: the plist IS the registration (its existence == installed). Windows:
  // the task XML is only the staging file we wrote; registration lives in Task
  // Scheduler (queried by `installed`), so the XML may lag reality — it's an
  // inspection aid, not proof of registration.
  return { installed: await schedulerInstalledAtAll(), scheduler: IS_WINDOWS ? taskXmlPath() : plistPath(), logAt, logTail }
}

// Structured health/config snapshot. Single source for both `vn doctor` (text)
// and `vn doctor --json` (consumed by the GUI status dashboard).
async function collectDoctor() {
  const config = getConfig()
  // pi is a bun-based CLI; cold start (esp. behind a proxy) can take >5s, so
  // give --version a generous timeout to avoid a false 'missing' on a healthy pi.
  const piInv = piInvocation(config.pi, ['--version'])
  const piCheck = await runCommand(piInv.bin, piInv.args, 15000)
  const ff = await runCommand(config.ffprobeBin, ['-version'], 5000)
  const v = config.volcano
  const { pi } = config
  return {
    version: VERSION,
    bun: process.versions.bun || null,
    node: process.version,
    recorder: { dir: config.recordDir, exists: existsSync(config.recordDir) },
    workspace: config.workspace,
    volcano: v
      ? {
          configured: true as const,
          auth: 'new-console',
          resourceId: v.resourceId,
          tos: { bucket: v.tos.bucket, region: v.tos.region, endpoint: v.tos.endpoint, keep: v.tos.keep, accessKey: !!v.tos.accessKey, secretKey: !!v.tos.secretKey },
          language: v.language ?? null,
        }
      : { configured: false as const },
    // Provider/model/credentials are pi's own configuration; `pi.available` is
    // all we can honestly report about whether a summary can run.
    summary: { backend: 'pi', model: pi.model, thinking: pi.thinking, tools: pi.tools || null, contextDir: pi.tools ? pi.contextDir : null },
    pi: { bin: pi.bin, cli: pi.cli, version: piCheck.code === 0 ? (piCheck.stdout.trim() || piCheck.stderr.trim() || null) : null, available: piCheck.code === 0, auth: existsSync(pi.authPath), authPath: pi.authPath },
    // Outbound proxy for HTTPS endpoints (updater/GitHub). The GUI reads this to
    // route its own update check, so it reports the resolved value.
    proxy: { url: config.childEnv.https_proxy ?? null },
    identity: { self: config.speakers.self.name || null, aliases: config.speakers.self.aliases, knownCount: config.speakers.known.length },
    // The thresholds that silently decide what never gets processed. Without
    // them here, confirming a change to VOICENOTE_MAX_AGE_HOURS meant planting
    // a test recording and watching the scan — not a reasonable way to check
    // a setting.
    filters: { maxAgeHours: config.maxAgeHours, minBytes: config.minBytes, minDurationSeconds: config.minDurationSeconds },
    deps: { ffprobe: ff.code === 0 },
    agent: await agentStatus(),
  }
}

// The dashboard/CLI view of every recording's processing status. A pure read of
// the state file `vn run` writes, grouped by jobs.ts. Nothing here rescans
// the recorder or parses logs: the queue shown IS the queue that runs, and it
// stays visible when the recorder is unplugged.
async function jobsListData(limit: number): Promise<{ items: Json[]; total: number; queued_total: number; recorder_present: boolean }> {
  const config = getConfig()
  const store = await loadState(config)
  // One existsSync on the mount point — not the recursive glob the old pending
  // section ran on every poll, and always current.
  return buildJobsView(store, readCurrent(), { limit, alive: pidAlive, recorderPresent: existsSync(config.recordDir) })
}

async function jobsList(opts: { limit?: number; json?: boolean }): Promise<void> {
  let limit: number
  try { limit = parseJobsLimit(opts.limit, 30) } catch (e: any) { console.error(e.message); process.exitCode = 1; return }
  const data = await jobsListData(limit)
  if (opts.json) { console.log(JSON.stringify(data, null, 2)); return }
  if (!data.items.length) {
    console.log(data.recorder_present ? 'No jobs yet.' : 'No jobs yet. (recorder not connected)')
    return
  }
  for (const j of data.items) {
    const suffix = [j.step, j.detail].filter(Boolean).join(' \u00b7 ')
    console.log(`[${j.status}] ${j.title || j.name}${suffix ? ' \u00b7 ' + suffix.slice(0, 140) : ''}`)
  }
  // Truncation used to be silent, which is how a 126-entry backlog read as 27.
  if (data.total > data.items.length) console.log(`\u2026 ${data.total - data.items.length} more (vn jobs --limit 0 to show all)`)
  if (!data.recorder_present) {
    console.log(data.queued_total ? `Recorder not connected \u2014 ${data.queued_total} recording(s) waiting for it.` : 'Recorder not connected.')
  }
}

async function doctor(opts: { json?: boolean } = {}): Promise<void> {
  const s = await collectDoctor()
  if (opts.json) { console.log(JSON.stringify(s, null, 2)); return }
  console.log(`version=${s.version}`)
  console.log(`bun=${s.bun || 'not-bun'}`)
  console.log(`node=${s.node}`)
  console.log(`recordDir=${s.recorder.dir} exists=${s.recorder.exists}`)
  console.log(`workspace=${s.workspace}`)
  console.log(`filters=maxAge:${s.filters.maxAgeHours > 0 ? `${s.filters.maxAgeHours}h` : 'none'} minSize:${(s.filters.minBytes / 1000).toFixed(0)}KB minDuration:${s.filters.minDurationSeconds}s`)
  if (s.volcano.configured) {
    console.log(`volcano.auth=${s.volcano.auth}`)
    console.log(`volcano.resourceId=${s.volcano.resourceId}`)
    console.log(`volcano.tos=bucket:${s.volcano.tos.bucket} region:${s.volcano.tos.region} endpoint:${s.volcano.tos.endpoint} keep:${s.volcano.tos.keep}`)
    console.log(`volcano.tos.accessKey=${s.volcano.tos.accessKey ? 'loaded' : 'missing'} secretKey=${s.volcano.tos.secretKey ? 'loaded' : 'missing'}`)
    if (s.volcano.language) console.log(`volcano.language=${s.volcano.language}`)
  } else {
    console.log(`volcano=not configured`)
  }
  console.log(`summaryBackend=${s.summary.backend}`)
  console.log(`pi.bin=${s.pi.bin} model=${s.summary.model || "<pi's own default>"}`)
  if (s.pi.cli) console.log(`pi.cli=${s.pi.cli}`)
  console.log(`pi.thinking=${s.summary.thinking}`)
  console.log(`pi.summaryTools=${s.summary.tools || '<disabled>'}`)
  if (s.summary.contextDir) console.log(`pi.contextDir=${s.summary.contextDir} (summary agent cwd + read/grep cross-reference root)`)
  console.log(`pi.version=${s.pi.version || 'missing'}`)
  // Neutral fact, not an instruction: an API-key user has no auth.json and needs
  // nothing fixed.
  console.log(`pi.auth=${s.pi.authPath} ${s.pi.auth ? '(present)' : '(missing — fine if a provider API key is set)'}`)
  console.log(`defaultMode=notes`)
  console.log(`proxy=${s.proxy.url || '<unset>'}`)
  console.log(`speakers.self=${s.identity.self || '<unset>'}`)
  console.log(`speakers.known=${s.identity.knownCount}`)
  console.log(`scheduler=${s.agent.scheduler}`)
  console.log(`ffprobe=${s.deps.ffprobe ? 'ok' : 'missing'}`)
}

// Is the background scheduler installed and pointing at this binary?
async function schedulerIsCurrent(): Promise<boolean> {
  const exe = process.execPath
  if (IS_WINDOWS) {
    if ((await runCommand('schtasks', ['/query', '/tn', TASK_NAME], 10000)).code !== 0) return false
    // The task XML points at wscript; the actual CLI path lives in the VBS.
    try { return readFileSync(taskVbsPath(), 'utf16le').includes(exe) } catch { return false }
  }
  try { return readFileSync(plistPath(), 'utf8').includes(exe) } catch { return false }
}

async function ensureScheduler(force: boolean): Promise<{ ok: true; skipped?: boolean }> {
  if (!force && await schedulerIsCurrent()) return { ok: true, skipped: true }
  await installScheduler({ load: true })
  return { ok: true }
}

// ────────────────────────────────────────────────────────────────────────────
// CLI commands
// ────────────────────────────────────────────────────────────────────────────

const cli = cac('vn')

cli.command('run [file]', 'Scan recorder and process recordings, or process one audio file by path (Volcano ASR + pi notes)')
  .option('--mode <mode>', 'Output mode: notes (default) | transcript', { default: 'notes' })
  .option('--latest', 'Only process newest eligible recording')
  .option('--force', 'Reprocess already processed recordings')
  .option('--dry-run', 'Do not copy / transcribe / write files')
  .option('--pdf', 'Also render notes to PDF (only meaningful for --mode notes)')
  .option('--verbose', 'Print per-file skip details during scan')
  .action(runPipeline)

cli.command('list', 'List notes in a month')
  .option('--month <YYYY-MM>', 'Month to list (default: current month)')
  .action(listMeetings)

cli.command('last', 'Print summary of most recent processed recording').action(lastMeeting)
cli.command('jobs', 'Show every recording\'s processing status (running, queued, done, failed, gave up, filtered)')
  .option('--limit <n>', 'How many to list', { default: 30 })
  .option('--json', 'Output as JSON (for the GUI)')
  .action((opts: { limit?: number; json?: boolean }) => jobsList(opts))


cli.command('open [target]', 'Open notes dir, config dir (`config`), logs dir (`logs`), or a note matching the slug').action((target?: string) => openTarget(target))

cli.command('import <file>', 'Copy one audio file into the durable manual-import queue')
  .option('--json', 'Output structured status (for the GUI)')
  .action((file: string, opts: { json?: boolean }) => importRecording(file, opts))
cli.command('forget <key>', 'Drop a recording\'s job record so it is queued again (a saved transcript on disk is still reused)').action((key: string) => forgetRecording(key))
cli.command('retry <id>', 'Requeue one failed recording while retaining saved outputs').action((id: string) => retryRecording(id))

cli.command('log', 'Print the daily log (today by default)')
  .option('--lines <n>', 'How many trailing lines to print', { default: 30 })
  .option('-f, --follow', 'Follow the log live (tail -F)')
  .option('--err', 'Also include launchd.err.log')
  .option('--date <YYYY-MM-DD>', 'Show a specific day instead of today')
  .action(showLog)

cli.command('errors', 'Show recent ERROR lines from daily logs').option('--lines <n>', 'How many lines to print', { default: 20 }).action(showErrors)

cli.command('upgrade', 'Upgrade to the latest published version via bun add -g').action(upgradeSelf)

cli.command('doctor', 'Check environment')
  .option('--json', 'Output structured status as JSON (for the GUI)')
  .action((opts: { json?: boolean }) => doctor(opts))
cli.command('login', 'Sign in to ChatGPT (Codex OAuth) for the pi summary backend')
  .option('--json', 'Emit machine-readable JSON events (for the GUI client)')
  .option('--device-code', 'Use the device-code flow instead of the browser callback (needs the ChatGPT security-settings opt-in)')
  .action((opts: { json?: boolean; deviceCode?: boolean }) => loginChatGPT(opts))
cli.command('config <action>', 'Read/write file-based config. action: get (print JSON) | set (write from stdin JSON)')
  .action((action: string) => {
    if (action === 'set') return configSet()
    if (action === 'get') return configGet()
    console.error(`Unknown config action '${action}'. Use: vn config get | vn config set`)
    process.exitCode = 1
  })
cli.command('install-launch-agent', 'Install background scheduler (mac LaunchAgent / Windows Task Scheduler)')
  .option('--load', 'Also (re)load/start it immediately')
  .action((opts: { load?: boolean }) => installScheduler(opts))
cli.command('ensure-launch-agent', 'Install the background scheduler when missing or stale')
  .option('--force', 'Reinstall even when the scheduler is current')
  .action((opts: { force?: boolean }) => ensureScheduler(!!opts.force))
cli.command('uninstall-launch-agent', 'Remove the background scheduler').action(uninstallScheduler)
cli.command('status', 'Print background scheduler status').action(printSchedulerStatus)

cli.help()
cli.version(VERSION)
// Run the command ourselves so a thrown error (bad config, unreadable state
// file) reaches the user as the one line it is, not as a bun stack trace.
const parsed = cli.parse(process.argv, { run: false })
// cac prints --help/--version itself and then reports no matched command; any
// OTHER unmatched invocation is a typo, which it would ignore in silence.
if (!cli.matchedCommand && !parsed.options.help && !parsed.options.version) {
  if (parsed.args.length) console.error(`vn: unknown command '${parsed.args[0]}'`)
  cli.outputHelp()
  process.exit(parsed.args.length ? 1 : 0)
}
try {
  await cli.runMatchedCommand()
} catch (e: any) {
  console.error(`vn: ${e?.message || e}`)
  process.exit(1)
}

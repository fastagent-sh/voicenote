import { mkdir, rename, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import os from 'node:os'

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

export function appConfigDir(): string {
  if (IS_WINDOWS) return join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), 'voicenote')
  return join(os.homedir(), '.config', 'voicenote')
}

export function appStateDir(): string {
  if (IS_WINDOWS) return join(process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local'), 'voicenote')
  return join(os.homedir(), '.local', 'state', 'voicenote')
}

export const CONFIG_DIR = appConfigDir()
export const STATE_DIR = appStateDir()
export const CONFIG_ENV_PATH = join(CONFIG_DIR, 'config.json')

export type SpeakerSelf = { name: string | null; aliases: string[] }
export type SpeakerKnown = { name: string; aliases: string[]; relationship?: string | null }
export type SpeakersConfig = { self: SpeakerSelf; known: SpeakerKnown[] }

export type VolcanoConfig = {
  apiKey: string
  resourceId: string
  language?: string
}

export type PiConfig = {
  model: string | null
  thinking: string
  tools: string
  contextDir: string
  retries: number
  agentDir: string
  authPath: string
}

export type Config = {
  recordDir: string
  workspace: string
  minBytes: number
  minDurationSeconds: number
  maxAgeHours: number
  speakers: SpeakersConfig
  volcano: VolcanoConfig | null
  ffprobeBin: string
  pi: PiConfig
  childEnv: Record<string, string>
}

export const ENV_KEYS = [
  'VOICENOTE_DEVICE_VOLUME',
  'VOICENOTE_RECORD_DIR',
  'VOICENOTE_WORKSPACE',
  'VOICENOTE_MIN_BYTES',
  'VOICENOTE_MIN_DURATION_SECONDS',
  'VOICENOTE_MAX_AGE_HOURS',
  'VOLCANO_ASR_KEY',
  'VOLCANO_ASR_RESOURCE_ID',
  'VOLCANO_ASR_LANGUAGE',
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
  'ANTHROPIC_API_KEY',
  'MINIMAX_API_KEY',
  'KIMI_API_KEY',
  'OPENROUTER_API_KEY',
  'QWEN_API_KEY',
]

export const VOLCANO_NO_PROXY_HOSTS = ['openspeech.bytedance.com']

export function systemProxyUrl(): string | null {
  try {
    if (process.platform === 'darwin') {
      const out = spawnSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 })
      return out.status === 0 && out.stdout ? macProxyFromScutil(out.stdout) : null
    }
    if (IS_WINDOWS) {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
      const out = spawnSync('reg', ['query', key], { encoding: 'utf8', timeout: 3000 })
      return out.status === 0 && out.stdout ? windowsProxyFromRegistry(out.stdout) : null
    }
    return null
  } catch { return null }
}

export function macProxyFromScutil(stdout: string): string | null {
  const get = (k: string) => stdout.match(new RegExp(`\\b${k}\\s*:\\s*(\\S+)`))?.[1]
  if (get('HTTPSEnable') === '1' && get('HTTPSProxy') && get('HTTPSPort')) return `http://${get('HTTPSProxy')}:${get('HTTPSPort')}`
  if (get('HTTPEnable') === '1' && get('HTTPProxy') && get('HTTPPort')) return `http://${get('HTTPProxy')}:${get('HTTPPort')}`
  if (get('SOCKSEnable') === '1' && get('SOCKSProxy') && get('SOCKSPort')) return `socks5://${get('SOCKSProxy')}:${get('SOCKSPort')}`
  return null
}

export function windowsProxyFromRegistry(stdout: string): string | null {
  const enabled = stdout.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i)?.[1]
  if (!enabled || parseInt(enabled, 16) === 0) return null
  const server = stdout.match(/ProxyServer\s+REG_SZ\s+(\S+)/i)?.[1]
  if (!server) return null
  const withScheme = (host: string, scheme: string) => host.includes('://') ? host : `${scheme}://${host}`
  if (!server.includes('=')) return withScheme(server, 'http')
  const byProtocol = new Map<string, string>()
  for (const part of server.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) byProtocol.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim())
  }
  const overHttp = byProtocol.get('https') || byProtocol.get('http')
  if (overHttp) return withScheme(overHttp, 'http')
  const socks = byProtocol.get('socks')
  return socks ? withScheme(socks, 'socks5') : null
}

export type Settings = Record<string, string>

export function readSettings(file: Record<string, unknown>): Settings {
  const settings: Settings = {}
  for (const key of ENV_KEYS) {
    const inherited = process.env[key]
    if (inherited !== undefined) settings[key] = inherited
    else if (typeof file[key] === 'string') settings[key] = file[key] as string
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (key.endsWith('_API_KEY') || key.endsWith('_KEY')) && !settings[key]) {
      settings[key] = value
    }
  }
  for (const [key, value] of Object.entries(file)) {
    if (typeof value === 'string' && (key.endsWith('_API_KEY') || key.endsWith('_KEY')) && !settings[key]) {
      settings[key] = value
    }
  }
  return settings
}

export function proxyEnv(s: Settings): Record<string, string> {
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

export function volcanoFrom(s: Settings): VolcanoConfig | null {
  const apiKey = s.VOLCANO_ASR_KEY || ''
  if (!apiKey) return null
  return {
    apiKey,
    resourceId: s.VOLCANO_ASR_RESOURCE_ID || 'volc.seedasr.auc',
    language: s.VOLCANO_ASR_LANGUAGE || undefined,
  }
}

export function volcanoAuthHeaders(volc: VolcanoConfig, taskId: string, includeSequence: boolean): Record<string, string> {
  const base: Record<string, string> = {
    'X-Api-Resource-Id': volc.resourceId,
    'X-Api-Request-Id': taskId,
    'Content-Type': 'application/json',
  }
  if (includeSequence) base['X-Api-Sequence'] = '-1'
  base['X-Api-Key'] = volc.apiKey
  return base
}

export function settingNumber(s: Settings, key: string, fallback: number): number {
  const raw = s[key]
  const value = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${key}: expected a non-negative number, got '${raw}'`)
  return value
}

let configCache: Config | null = null

export function resetConfigCache(): void {
  configCache = null
}

export function expandHome(path: string): string {
  return path.replace(/^(?:~|\$\{?HOME\}?)(?=\/|$)/, os.homedir())
}

export const DEFAULT_SPEAKERS: SpeakersConfig = { self: { name: null, aliases: [] }, known: [] }

export function normalizeSpeakers(data: unknown): SpeakersConfig {
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

export function loadConfigJson(): Record<string, unknown> {
  if (!existsSync(CONFIG_ENV_PATH)) return {}
  let value: unknown
  try { value = JSON.parse(readFileSync(CONFIG_ENV_PATH, 'utf8')) } catch (e: any) {
    throw new Error(`${CONFIG_ENV_PATH} is invalid JSON: ${e?.message || e}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${CONFIG_ENV_PATH} must contain a JSON object`)
  return value as Record<string, unknown>
}

export async function writeConfigJson(value: Record<string, unknown>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  const tmp = `${CONFIG_ENV_PATH}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, CONFIG_ENV_PATH)
}

export function configFileEnv(raw = loadConfigJson()): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ENV_KEYS) {
    if (typeof raw[key] === 'string') env[key] = raw[key] as string
  }
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && (key.endsWith('_API_KEY') || key.endsWith('_KEY'))) {
      env[key] = value
    }
  }
  return env
}

export function getConfig(): Config {
  if (configCache) return configCache
  const file = loadConfigJson()
  const s = readSettings(file)
  const proxy = proxyEnv(s)
  for (const [key, value] of Object.entries(proxy)) process.env[key] = value
  const deviceVolume = s.VOICENOTE_DEVICE_VOLUME || 'VTR6500'
  const workspace = expandHome(s.VOICENOTE_WORKSPACE || '~/Documents/meetings')
  const piAgentDir = expandHome(s.PI_CODING_AGENT_DIR || join(CONFIG_DIR, 'pi-agent'))
  const childEnv: Record<string, string> = { ...proxy, PI_CODING_AGENT_DIR: piAgentDir }
  for (const [key, value] of Object.entries(s)) {
    if ((key.endsWith('_API_KEY') || key.endsWith('_KEY')) && typeof value === 'string' && value) {
      childEnv[key] = value
    }
  }
  configCache = Object.freeze({
    recordDir: expandHome(s.VOICENOTE_RECORD_DIR || `/Volumes/${deviceVolume}/RECORD`),
    workspace,
    minBytes: settingNumber(s, 'VOICENOTE_MIN_BYTES', 100000),
    minDurationSeconds: settingNumber(s, 'VOICENOTE_MIN_DURATION_SECONDS', 60),
    maxAgeHours: settingNumber(s, 'VOICENOTE_MAX_AGE_HOURS', 48),
    volcano: volcanoFrom(s),
    speakers: normalizeSpeakers(file.speakers ?? DEFAULT_SPEAKERS),
    ffprobeBin: expandHome(s.VOICENOTE_FFPROBE_BIN || 'ffprobe'),
    pi: {
      model: (s.VOICENOTE_PI_MODEL || '').trim() || null,
      thinking: s.VOICENOTE_PI_THINKING || 'high',
      tools: s.VOICENOTE_PI_SUMMARY_TOOLS === undefined ? 'read,grep' : s.VOICENOTE_PI_SUMMARY_TOOLS.trim(),
      contextDir: expandHome(s.VOICENOTE_CONTEXT_DIR || workspace),
      retries: Math.max(1, Math.floor(settingNumber(s, 'VOICENOTE_PI_RETRIES', 3))),
      agentDir: piAgentDir,
      authPath: join(piAgentDir, 'auth.json'),
    },
    childEnv,
  })
  return configCache
}

export type ConfigSetPayload = { env?: Record<string, unknown>; self?: { name?: string | null; aliases?: string[] } }

export function configGetData(): { path: string; env: Record<string, string>; self: { name: string | null; aliases: string[] } } {
  const current = loadConfigJson()
  const speakers = normalizeSpeakers(current.speakers ?? DEFAULT_SPEAKERS)
  return {
    path: CONFIG_ENV_PATH,
    env: configFileEnv(current),
    self: { name: speakers.self.name, aliases: speakers.self.aliases },
  }
}

export function configGet(): void { console.log(JSON.stringify(configGetData(), null, 2)) }

export async function configSetData(payload: ConfigSetPayload): Promise<{ ok: true; path: string; ignoredKeys?: string[] }> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Config payload must be a JSON object')
  const current = loadConfigJson()
  const isKnown = (key: string) => ENV_KEYS.includes(key) || key.endsWith('_API_KEY') || key.endsWith('_KEY')
  const ignored: string[] = []
  if (payload.env) {
    for (const [key, value] of Object.entries(payload.env)) {
      if (!isKnown(key)) { ignored.push(key); continue }
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
  resetConfigCache()
  return { ok: true, path: CONFIG_ENV_PATH, ...(ignored.length ? { ignoredKeys: ignored } : {}) }
}

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { buf += chunk })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', reject)
  })
}

export async function configSet(): Promise<void> {
  let payload: ConfigSetPayload
  try { payload = JSON.parse(await readStdin()) }
  catch (e: any) { console.error(`Invalid JSON on stdin: ${e?.message || e}`); process.exitCode = 1; return }
  console.log(JSON.stringify(await configSetData(payload)))
}

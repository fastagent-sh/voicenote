import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import os from 'node:os'
import {
  CONFIG_DIR,
  CONFIG_ENV_PATH,
  configFileEnv,
  getConfig,
  IS_WINDOWS,
  loadConfigJson,
  LOG_DIR,
  dailyLogPath,
  resetConfigCache,
  STATE_DIR,
  writeConfigJson,
  type Config,
} from './config.ts'
import { pad } from './time.ts'
import { runCommand } from './process.ts'

export const LAUNCH_AGENT_LABEL = 'sh.fastagent.voicenote'
export const TASK_NAME = 'VoiceNote'

export { runCommand }

export function readLogTail(path: string, maxBytes: number): string {
  try {
    const size = statSync(path).size
    if (size <= 0) return ''
    const start = Math.max(0, size - maxBytes)
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      return buf.toString('utf8')
    } finally { closeSync(fd) }
  } catch { return '' }
}

export function resolveCli(): { cliPath: string; compiled: boolean } {
  const currentPath = fileURLToPath(import.meta.url)
  const compiled = /\$bunfs|~BUN/i.test(currentPath)
  const dir = dirname(currentPath)
  const cliPath = existsSync(join(dir, 'cli.ts')) ? join(dir, 'cli.ts') : join(dir, 'cli.js')
  return { cliPath, compiled }
}

export function plistPath(): string {
  return join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export async function launchAgentEnv(_config: Config): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    PATH: `${os.homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  }
  const fileEnv = configFileEnv()
  const ffprobe = process.env.VOICENOTE_FFPROBE_BIN
  if (ffprobe && ffprobe !== fileEnv.VOICENOTE_FFPROBE_BIN) env.VOICENOTE_FFPROBE_BIN = ffprobe
  return env
}

export async function installLaunchAgent(opts: { load?: boolean } = {}): Promise<void> {
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
  await chmod(plist, 0o600)
  const summary = Object.keys(env).join(', ')
  console.log(`LaunchAgent written: ${plist}`)
  console.log(`Embedded env keys: ${summary}`)
  if (opts.load) {
    const uid = process.getuid?.()
    await runCommand('launchctl', ['bootout', `gui/${uid}`, plist], 10000)
    const r = await runCommand('launchctl', ['bootstrap', `gui/${uid}`, plist], 10000)
    await runCommand('launchctl', ['enable', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], 10000)
    if (r.code === 0) console.log('LaunchAgent loaded (launchctl bootstrap).')
    else console.error(`bootstrap exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`)
  } else {
    console.log(`Enable with: launchctl bootstrap gui/$(id -u) ${plist}`)
  }
}

export async function uninstallLaunchAgent(): Promise<void> {
  await runCommand('launchctl', ['bootout', `gui/${process.getuid?.()}`, plistPath()], 10000)
  console.log(`Bootout attempted: ${plistPath()}`)
}

export function taskXmlPath(): string {
  return join(STATE_DIR, 'task.xml')
}

export function taskVbsPath(): string {
  return join(STATE_DIR, 'run-hidden.vbs')
}

export function schedulerProgramArgs(): { command: string; argLine: string } {
  const { cliPath, compiled } = resolveCli()
  const args = compiled ? ['run'] : [cliPath, 'run']
  const argLine = args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
  return { command: process.execPath, argLine }
}

export async function installScheduledTask(opts: { load?: boolean } = {}): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  await mkdir(LOG_DIR, { recursive: true })
  const ffprobe = process.env.VOICENOTE_FFPROBE_BIN
  if (ffprobe) {
    await mkdir(CONFIG_DIR, { recursive: true })
    const current = loadConfigJson()
    current.VOICENOTE_FFPROBE_BIN = ffprobe
    await writeConfigJson(current)
    resetConfigCache()
  }
  const { command, argLine } = schedulerProgramArgs()
  const fullCmd = `"${command}" ${argLine}`
  const vbs = `WScript.Quit CreateObject("WScript.Shell").Run("${fullCmd.replace(/"/g, '""')}", 0, True)\r\n`
  await writeFile(taskVbsPath(), '\ufeff' + vbs, 'utf16le')
  const wscript = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
  const taskUser = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : (process.env.USERNAME || os.userInfo().username)
  const n = new Date()
  const startBoundary = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`
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

export async function uninstallScheduledTask(): Promise<void> {
  const r = await runCommand('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], 10000)
  if (r.code === 0) {
    for (const p of [taskVbsPath(), taskXmlPath()]) {
      try { unlinkSync(p) } catch {}
    }
  }
  console.log(r.code === 0 ? `Scheduled task '${TASK_NAME}' removed.` : `schtasks /delete: ${(r.stderr || r.stdout).trim()}`)
}

export function installScheduler(opts: { load?: boolean } = {}): Promise<void> {
  return IS_WINDOWS ? installScheduledTask(opts) : installLaunchAgent(opts)
}

export function uninstallScheduler(): Promise<void> {
  return IS_WINDOWS ? uninstallScheduledTask() : uninstallLaunchAgent()
}

export async function printSchedulerStatus(): Promise<void> {
  if (IS_WINDOWS) {
    const r = await runCommand('schtasks', ['/query', '/tn', TASK_NAME, '/v', '/fo', 'LIST'], 10000)
    process.stdout.write(r.stdout || r.stderr || `Task '${TASK_NAME}' not found.\n`)
    return
  }
  const r = await runCommand('launchctl', ['print', `gui/${process.getuid?.()}/${LAUNCH_AGENT_LABEL}`], 10000)
  process.stdout.write(r.stdout || r.stderr)
}

export async function schedulerInstalledAtAll(): Promise<boolean> {
  if (IS_WINDOWS) return (await runCommand('schtasks', ['/query', '/tn', TASK_NAME], 10000)).code === 0
  return existsSync(plistPath())
}

export function agentLogPath(): string {
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

export async function agentStatus() {
  const logFile = agentLogPath()
  let logTail: string[] = []
  let logAt: string | null = null
  if (existsSync(logFile)) {
    try { logAt = statSync(logFile).mtime.toISOString() } catch {}
    logTail = readLogTail(logFile, 16384).split('\n').map(s => s.trim()).filter(Boolean).slice(-8)
  }
  return { installed: await schedulerInstalledAtAll(), scheduler: IS_WINDOWS ? taskXmlPath() : plistPath(), logAt, logTail }
}

export async function schedulerIsCurrent(): Promise<boolean> {
  const exe = process.execPath
  if (IS_WINDOWS) {
    if ((await runCommand('schtasks', ['/query', '/tn', TASK_NAME], 10000)).code !== 0) return false
    try { return readFileSync(taskVbsPath(), 'utf16le').includes(exe) } catch { return false }
  }
  try { return readFileSync(plistPath(), 'utf8').includes(exe) } catch { return false }
}

export async function ensureScheduler(force: boolean): Promise<{ ok: true; skipped?: boolean }> {
  if (!force && await schedulerIsCurrent()) return { ok: true, skipped: true }
  await installScheduler({ load: true })
  return { ok: true }
}

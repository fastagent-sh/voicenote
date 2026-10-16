import { spawn } from 'node:child_process'
import { IS_MAC, IS_WINDOWS } from './config.ts'

export function runCommand(
  command: string,
  args: string[],
  timeoutMs = 20000,
  options: { windowsVerbatimArguments?: boolean } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((res) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', d => stdout += String(d))
    child.stderr.on('data', d => stderr += String(d))
    child.on('close', code => { clearTimeout(timer); res({ stdout, stderr, code: code ?? 1 }) })
    child.on('error', err => { clearTimeout(timer); res({ stdout, stderr: String(err), code: 1 }) })
  })
}

export function openPath(target: string, timeoutMs = 5000): Promise<{ stdout: string; stderr: string; code: number }> {
  if (IS_WINDOWS) return runCommand('cmd', ['/c', 'start', '""', `"${target.replace(/"/g, '""')}"`], timeoutMs, { windowsVerbatimArguments: true })
  if (IS_MAC) return runCommand('open', [target], timeoutMs)
  return runCommand('xdg-open', [target], timeoutMs)
}

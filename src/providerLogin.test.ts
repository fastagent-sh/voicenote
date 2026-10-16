import { expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function runLogin(input: 'answer' | 'eof' | 'abort' | 'failure' | 'device') {
  const home = await mkdtemp(join(tmpdir(), 'vn-provider-login-'))
  const bin = join(home, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'open'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$HOME/opened-urls"\n', { mode: 0o700 })
  const script = `
const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
const runtime = await ModelRuntime.create({ authPath: process.env.PI_CODING_AGENT_DIR + '/auth.json', modelsPath: null })
const provider = runtime.getProvider('openai')
provider.auth.oauth.login = async interaction => {
  interaction.notify({ type: 'auth_url', url: 'https://example.com/authorize' })
  if (${JSON.stringify(input)} === 'device') interaction.notify({ type: 'device_code', userCode: 'unused', verificationUri: 'https://example.com/device' })
  const method = await interaction.prompt({ type: 'select', message: 'Login method', options: [{id:'device_code', label:'Device'}, {id:'browser', label:'Browser'}] })
  if (method !== 'browser') throw new Error('Browser OAuth must be selected')
  if (${JSON.stringify(input)} === 'failure') throw new Error('Test provider rejected login')
  const answer = await interaction.prompt({ type: 'text', message: 'Enter enterprise domain:' })
  if (answer !== 'example.com') throw new Error('Wrong prompt answer')
  return { type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600000 }
}
ModelRuntime.create = async () => runtime
const { loginPiProvider } = await import('./src/core.ts')
const controller = new AbortController()
if (${JSON.stringify(input)} === 'abort') setTimeout(() => controller.abort(new Error('Login timed out')), 100)
try { await loginPiProvider('openai', { signal: controller.signal }) }
catch (error) { console.error('vn: ' + error.message); process.exitCode = 1 }
`
  try {
    const child = spawn('node', ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PI_CODING_AGENT_DIR: join(home, 'pi'), PATH: `${bin}:${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = '', replied = false
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (!replied && stdout.includes('Enter enterprise domain:')) {
        replied = true
        if (input === 'answer') child.stdin.write('example.com\n')
        if (input === 'eof') child.stdin.end()
      }
    })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    const status = await new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
    clearTimeout(timer)
    const opened = await readFile(join(home, 'opened-urls'), 'utf8')
    return { status, stdout, stderr, opened }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test.skipIf(process.platform === 'win32')('provider CLI selects browser OAuth, shows its URL and reads terminal input', async () => {
  const run = await runLogin('answer')
  expect(run.status).toBe(0)
  expect(run.stdout).toContain('https://example.com/authorize')
  expect(run.stdout).toContain('Signed in')
  expect(run.opened).not.toContain('https://example.com/device')
  expect(run.opened).toContain('https://example.com/authorize')
}, 15_000)

for (const mode of ['eof', 'abort', 'failure', 'device'] as const) {
  test.skipIf(process.platform === 'win32')(`provider CLI exits cleanly on ${mode}`, async () => {
    const run = await runLogin(mode)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('vn: Login to OpenAI failed:')
    expect(run.stderr).not.toContain('UnhandledPromiseRejection')
    expect(run.stderr).not.toContain('    at ')
    if (mode === 'device') {
      expect(run.stderr).toContain('Device-code sign-in is not supported')
      expect(run.opened).not.toContain('https://example.com/device')
    }
  }, 15_000)
}

test.skipIf(process.platform === 'win32')('cli login command catches errors and exits with code 1', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
    const orig = ModelRuntime.create
    ModelRuntime.create = async (opts) => {
      const rt = await orig(opts)
      const p = rt.getProvider('openai')
      p.auth.oauth.login = async () => { throw new Error('Simulated OAuth failure') }
      return rt
    }
    process.argv = [process.execPath, 'src/cli.ts', 'login', 'openai']
    await import('./src/cli.ts')
  `], { encoding: 'utf8', timeout: 5000 })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Login to OpenAI failed: Simulated OAuth failure')
  expect(result.stderr).not.toContain('UnhandledPromiseRejection')
})

test('cli login in json mode requires api key without hanging', () => {
  const result = spawnSync(process.execPath, [
    'src/cli.ts', 'login', 'deepseek', '--json',
  ], { encoding: 'utf8', timeout: 5000 })
  expect(result.status).toBe(1)
  expect(result.stdout).toContain('API key is required in --json mode')
})

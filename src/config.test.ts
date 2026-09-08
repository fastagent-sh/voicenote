import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

test('GUI config persists DeepSeek credentials and refreshes the running engine', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-config-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const fakePi = join(home, 'pi.ts')
  await mkdir(configDir, { recursive: true })
  await writeFile(fakePi, `
    if (process.argv.includes('--version')) console.log('test-pi')
    else console.log(JSON.stringify(process.env.DEEPSEEK_API_KEY === 'test-key'
      ? { status: 'ready', provider: 'deepseek' }
      : { status: 'not_ready', reason: 'credentials_not_configured' }))
  `)
  await writeFile(join(configDir, 'config.json'), JSON.stringify({
    VOICENOTE_PI_PROVIDER: 'deepseek',
    VOICENOTE_PI_BIN: process.execPath,
    VOICENOTE_PI_CLI: fakePi,
    VOICENOTE_FFPROBE_BIN: process.execPath,
    VOICENOTE_WORKSPACE: join(home, 'notes'),
  }))
  const child = spawn(process.execPath, [join(import.meta.dir, 'cli.ts'), 'serve'], {
    env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  const exited = new Promise(resolve => child.on('close', resolve))
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let id = 0
  async function request(method: string, params = {}) {
    child.stdin.write(JSON.stringify({ id: ++id, method, params }) + '\n')
    const line = await lines.next()
    if (line.done) throw new Error(`Engine exited: ${stderr}`)
    const response = JSON.parse(line.value)
    expect(response.id).toBe(id)
    expect(response.error).toBeUndefined()
    return response.result
  }
  try {
    expect((await request('doctor')).summary).toMatchObject({ ready: false, model: 'deepseek-v4-flash' })
    expect(await request('config.set', { env: { DEEPSEEK_API_KEY: 'test-key', VOICENOTE_PI_MODEL_SUMMARY: 'deepseek-v4-pro' } })).toEqual({ ok: true, path: join(configDir, 'config.json') })
    expect((await request('config.get')).env.DEEPSEEK_API_KEY).toBe('test-key')
    const doctor = await request('doctor')
    expect(doctor.summary).toMatchObject({ ready: true, model: 'deepseek-v4-pro', effectiveProviders: ['deepseek'], providerStatus: { deepseek: 'ready' } })
    expect(JSON.stringify(doctor)).not.toContain('test-key')
    expect(JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8')).DEEPSEEK_API_KEY).toBe('test-key')
    await request('config.set', { env: { DEEPSEEK_API_KEY: null, VOICENOTE_PI_MODEL_SUMMARY: null } })
    expect((await request('config.get')).env.DEEPSEEK_API_KEY).toBeUndefined()
    expect((await request('doctor')).summary).toMatchObject({ ready: false, model: 'deepseek-v4-flash', effectiveProviders: [] })
    await request('config.set', { env: { VOICENOTE_PI_PROVIDER: 'openai-codex' } })
    expect((await request('doctor')).summary.model).toBe('gpt-5.5')
  } finally {
    child.kill()
    await exited
    await rm(home, { recursive: true, force: true })
  }
}, 15_000)

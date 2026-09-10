import { expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

test('GUI config persists DeepSeek credentials and refreshes the running engine', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-config-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const fakePi = join(home, 'pi.ts')
  await mkdir(configDir, { recursive: true })
  await writeFile(fakePi, `console.log('test-pi')`)
  await writeFile(join(configDir, 'config.json'), JSON.stringify({
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
    expect(await request('config.set', { env: { DEEPSEEK_API_KEY: 'test-key' } })).toEqual({ ok: true, path: join(configDir, 'config.json') })
    expect((await request('config.get')).env.DEEPSEEK_API_KEY).toBe('test-key')
    const doctor = await request('doctor')
    expect(doctor.summary).toMatchObject({ backend: 'pi' })
    expect(doctor.pi).toMatchObject({ available: true })
    expect(JSON.stringify(doctor)).not.toContain('test-key')
    expect(JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8')).DEEPSEEK_API_KEY).toBe('test-key')
    await request('config.set', { env: { DEEPSEEK_API_KEY: null } })
    expect((await request('config.get')).env.DEEPSEEK_API_KEY).toBeUndefined()
  } finally {
    child.kill()
    await exited
    await rm(home, { recursive: true, force: true })
  }
}, 15_000)

test.skipIf(process.platform === 'win32')('scheduler omits equivalent proxy aliases and warns about actual overrides', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-proxy-'))
  const configDir = join(home, '.config/voicenote')
  try {
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      LOCAL_PROXY_HOST: '127.0.0.1', LOCAL_PROXY_PORT: '7890', VOICENOTE_PI_BIN: process.execPath,
    }))
    await writeFile(join(home, '.zshrc'), [
      'export http_proxy="http://${LOCAL_PROXY_HOST}:${LOCAL_PROXY_PORT}"',
      'export https_proxy="$http_proxy"',
      'export HTTP_PROXY="$http_proxy"',
    ].join('\n'))
    const env = { HOME: home, PATH: dirname(process.execPath), http_proxy: 'http://127.0.0.1:7890', https_proxy: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7890' }
    const install = () => spawnSync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'install-launch-agent'], { env, encoding: 'utf8', timeout: 10_000 })
    let result = install()
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('Warning:')
    const plist = join(home, 'Library/LaunchAgents/sh.fastagent.voicenote.plist')
    let contents = await readFile(plist, 'utf8')
    for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY']) expect(contents).not.toContain(`<key>${key}</key>`)

    env.http_proxy = 'http://127.0.0.1:9999'
    result = install()
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Warning: environment http_proxy overrides the config file.')
    contents = await readFile(plist, 'utf8')
    expect(contents).toContain('<key>http_proxy</key>')
    expect(contents).toContain('http://127.0.0.1:9999')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

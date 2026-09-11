import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
test('GUI config persists DeepSeek credentials for subsequent CLI calls', async () => {
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
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot }
  const run = (args: string[], input?: string) => {
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'cli.ts'), ...args], { env, input, encoding: 'utf8', timeout: 20_000 })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    return JSON.parse(result.stdout)
  }
  try {
    expect(run(['config', 'set'], JSON.stringify({ env: { DEEPSEEK_API_KEY: 'test-key' } }))).toEqual({ ok: true, path: join(configDir, 'config.json') })
    expect(run(['config', 'get']).env.DEEPSEEK_API_KEY).toBe('test-key')
    const doctor = run(['doctor', '--json'])
    expect(doctor.summary).toMatchObject({ backend: 'pi' })
    expect(doctor.pi).toMatchObject({ available: true })
    expect(JSON.stringify(doctor)).not.toContain('test-key')
    expect(JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8')).DEEPSEEK_API_KEY).toBe('test-key')
    run(['config', 'set'], JSON.stringify({ env: { DEEPSEEK_API_KEY: null } }))
    expect(run(['config', 'get']).env.DEEPSEEK_API_KEY).toBeUndefined()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform === 'win32')('scheduler embeds executable paths, not business config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-scheduler-'))
  const configDir = join(home, '.config/voicenote')
  try {
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      LOCAL_PROXY_HOST: '127.0.0.1', LOCAL_PROXY_PORT: '7890', VOICENOTE_PI_BIN: process.execPath,
    }))
    const env = { HOME: home, PATH: dirname(process.execPath), http_proxy: 'http://127.0.0.1:9999' }
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'install-launch-agent'], { env, encoding: 'utf8', timeout: 10_000 })
    expect(result.status).toBe(0)
    const contents = await readFile(join(home, 'Library/LaunchAgents/sh.fastagent.voicenote.plist'), 'utf8')
    expect(contents).toContain('<key>VOICENOTE_PI_BIN</key>')
    for (const key of ['http_proxy', 'LOCAL_PROXY_HOST', 'VOLCANO_ASR_KEY']) expect(contents).not.toContain(`<key>${key}</key>`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('invalid config fails without overwriting the file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-invalid-config-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const path = join(configDir, 'config.json')
  try {
    await mkdir(configDir, { recursive: true })
    await writeFile(path, '{broken')
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'config', 'set'], {
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home },
      input: JSON.stringify({ env: { VOICENOTE_WORKSPACE: '/tmp/notes' } }),
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('is invalid JSON')
    expect(await readFile(path, 'utf8')).toBe('{broken')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('invalid numeric config fails at the boundary', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-invalid-number-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  try {
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ VOICENOTE_MAX_AGE_HOURS: 'never' }))
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'doctor', '--json'], {
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home }, encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Invalid VOICENOTE_MAX_AGE_HOURS')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

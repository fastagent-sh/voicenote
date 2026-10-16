import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { runAsync, startFakeModel } from './testing/fakeModel.ts'

const envFor = (home: string) => ({ HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot })

test('concurrent API-key, OAuth and delete operations preserve every other credential', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-locked-auth-'))
  const env = envFor(home)
  const prefix = `
const { getConfig, setPiApiKey, removePiAuth } = await import('./src/core.ts')
const { openPiCredentials } = await import('./src/piRuntime.ts')
`
  try {
    const seed = await runAsync(process.execPath, ['--input-type=module', '-e', prefix + `
await setPiApiKey('keep', 'keep-key')
await setPiApiKey('remove', 'remove-key')
console.log(getConfig().pi.authPath)`], { env })
    expect(seed.status, seed.stderr).toBe(0)
    const authPath = seed.stdout.trim()
    const scripts = Array.from({ length: 4 }, (_, i) => prefix + `
await Promise.all(Array.from({length: 4}, (_, n) => setPiApiKey('provider-${i}-' + n, 'test-${i}-' + n)))`)
    scripts.push(prefix + `await removePiAuth('remove')`)
    scripts.push(prefix + `
const store = await openPiCredentials(getConfig().pi.authPath)
await store.modify('oauth-provider', async () => ({ type: 'oauth', access: 'test', refresh: 'refresh', expires: Date.now() + 3600000 }), { signal: AbortSignal.timeout(10000) })`)
    const results = await Promise.all(scripts.map(script => runAsync(process.execPath, ['--input-type=module', '-e', script], { env })))
    for (const result of results) expect(result.status, result.stderr).toBe(0)
    const data = JSON.parse(await readFile(authPath, 'utf8'))
    expect(data.keep.key).toBe('keep-key')
    expect(data.remove).toBeUndefined()
    expect(data['oauth-provider'].type).toBe('oauth')
    for (let i = 0; i < 4; i++) for (let n = 0; n < 4; n++) expect(data[`provider-${i}-${n}`].key).toBe(`test-${i}-${n}`)
    expect(Object.keys(data)).toHaveLength(18)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

test('config-file keys drive doctor, settings and the actual in-process request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-runtime-config-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const agentDir = join(configDir, 'pi-agent')
  const fake = await startFakeModel(agentDir)
  try {
    const modelsPath = join(agentDir, 'models.json')
    const models = JSON.parse(await readFile(modelsPath, 'utf8'))
    const provider = models.providers['fake-local']
    delete provider.apiKey
    await writeFile(modelsPath, JSON.stringify({ providers: { minimax: { ...provider, models: [{ id: 'MiniMax-M2.7', api: 'openai-completions' }] } } }))
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ MINIMAX_API_KEY: 'config-only-test-key', VOICENOTE_PI_MODEL: 'minimax/MiniMax-M2.7', VOICENOTE_FFPROBE_BIN: process.execPath }))
    const run = await runAsync(process.execPath, ['--input-type=module', '-e', `
const assert = (await import('node:assert/strict')).default
const { getConfig, collectDoctor, getPiAuthProviders, removePiAuth } = await import('./src/core.ts')
const { createPiRuntime } = await import('./src/piRuntime.ts')
const { runAgentPrompt } = await import('./src/piAgent.ts')
const config = getConfig()
assert.equal(process.env.MINIMAX_API_KEY, undefined)
assert.equal((await collectDoctor()).pi.auth, true)
assert.equal((await getPiAuthProviders()).find(p => p.id === 'minimax').configured, true)
const { runtime } = await createPiRuntime(config.pi.agentDir, config.childEnv)
assert.equal((await runtime.getAuth('minimax')).auth.apiKey, 'config-only-test-key')
const result = await runAgentPrompt({ agentDir: config.pi.agentDir, env: config.childEnv, cwd: process.env.HOME, model: config.pi.model, tools: [], systemPrompt: 'test', userPrompt: 'hello', timeoutMs: 5000 })
assert.ok(result.includes('Fake note'))
await removePiAuth('minimax')
assert.equal((await collectDoctor()).pi.auth, false)
assert.equal((await getPiAuthProviders()).find(p => p.id === 'minimax').configured, false)
assert.equal(process.env.MINIMAX_API_KEY, undefined)
`], { env: envFor(home) })
    expect(run.status, run.stderr).toBe(0)
    expect(fake.requests).toHaveLength(1)
  } finally {
    await fake.stop()
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

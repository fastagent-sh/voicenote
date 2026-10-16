import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runAsync, startFakeModel } from './testing/fakeModel.ts'

const envFor = (home: string) => ({ HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot })

test('settings catalog contains only runtime models and valid default selections', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-catalog-'))
  try {
    const run = await runAsync(process.execPath, ['--input-type=module', '-e', `
const assert = (await import('node:assert/strict')).default
const { getConfig, getPiAuthProviders, loginPiProvider } = await import('./src/core.ts')
const { createPiRuntime } = await import('./src/piRuntime.ts')
const { runtime } = await createPiRuntime(getConfig().pi.agentDir)
for (const provider of await getPiAuthProviders()) {
  assert.deepEqual(provider.models, runtime.getModels(provider.id).map(m => ({id:m.id,name:m.name})))
  if (provider.defaultModelId) assert.ok(runtime.getModel(provider.id, provider.defaultModelId))
}
const providers = await getPiAuthProviders()
assert.equal(providers.find(p => p.id === 'deepseek').defaultModelId, 'deepseek-flash')
assert.notEqual(providers.find(p => p.id === 'minimax').defaultModelId, 'MiniMax-Text-01')
assert.equal(providers.find(p => p.id === 'kimi-coding').hasOAuth, false)
assert.equal(providers.find(p => p.id === 'kimi-coding').hasApiKey, true)
await assert.rejects(loginPiProvider('kimi-coding'), /does not support browser OAuth/)
`], { env: envFor(home) })
    expect(run.status, run.stderr).toBe(0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('unknown model IDs fail before sending requests; explicit models.json models still work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-unknown-model-'))
  const fake = await startFakeModel(join(home, 'agent'))
  try {
    const run = await runAsync(process.execPath, ['--input-type=module', '-e', `
const assert = (await import('node:assert/strict')).default
const { runAgentPrompt } = await import('./src/piAgent.ts')
const opts = {agentDir:process.env.HOME+'/agent',cwd:process.env.HOME,tools:[],systemPrompt:'test',userPrompt:'test',timeoutMs:3000}
await assert.rejects(runAgentPrompt({...opts,model:'fake-local/not-configured'}), /define it explicitly in models.json/)
const answer = await runAgentPrompt({...opts,model:${JSON.stringify(fake.modelRef)}})
assert.ok(answer.includes('Fake note'))
`], { env: envFor(home) })
    expect(run.status, run.stderr).toBe(0)
    expect(fake.requests).toHaveLength(1)
  } finally {
    await fake.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('Kimi CLI login defaults to an API key prompt without OAuth network requests', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-kimi-login-'))
  const agentDir = join(home, 'agent')
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      globalThis.fetch = async () => { throw new Error('Unexpected OAuth network request') }
      process.argv = [process.execPath, 'src/cli.ts', 'login', 'kimi-coding']
      await import('./src/cli.ts')
    `], {
      env: { ...envFor(home), PI_CODING_AGENT_DIR: agentDir }, input: 'kimi-test-key\n', encoding: 'utf8', timeout: 10_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Enter API key')
    expect(result.stdout).not.toContain('authorization')
    expect(JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf8'))['kimi-coding']).toEqual({type:'api_key',key:'kimi-test-key'})
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

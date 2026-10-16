import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runAsync } from './testing/fakeModel.ts'

async function withConfig(script: string, inherited: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'vn-provider-keys-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'config.json'), JSON.stringify({
    MINIMAX_API_KEY: 'config-minimax',
    KIMI_API_KEY: 'config-kimi',
    QWEN_TOKEN_PLAN_CN_API_KEY: 'config-qwen',
    OPENROUTER_API_KEY: 'config-openrouter',
    AI_GATEWAY_API_KEY: 'config-gateway',
  }))
  try {
    return await runAsync(process.execPath, ['--input-type=module', '-e', script], {
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot, ...inherited },
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('provider key display and removal use the same config keys, even without auth.json', async () => {
  const run = await withConfig(`
const assert = (await import('node:assert/strict')).default
const { getPiAuthProviders, removePiAuth, configGetData } = await import('./src/core.ts')
const providers = await getPiAuthProviders()
for (const [id, key] of [['minimax', 'config-minimax'], ['kimi-coding', 'config-kimi'], ['qwen-token-plan-cn', 'config-qwen'], ['openrouter', 'config-openrouter']]) {
  assert.equal(providers.find(p => p.id === id).apiKey, key)
  assert.equal(providers.find(p => p.id === id).configured, true)
}
await removePiAuth('minimax')
assert.equal(configGetData().env.MINIMAX_API_KEY, undefined)
assert.equal((await getPiAuthProviders()).find(p => p.id === 'minimax').configured, false)
assert.equal(configGetData().env.KIMI_API_KEY, 'config-kimi')
console.log('verified')`)
  expect(run.status).toBe(0)
  expect(run.stdout).toContain('verified')
})

test('inherited keys remain visible and removal reports the external action required', async () => {
  const run = await withConfig(`
const assert = (await import('node:assert/strict')).default
const { getPiAuthProviders, removePiAuth, configGetData } = await import('./src/core.ts')
assert.equal((await getPiAuthProviders()).find(p => p.id === 'minimax').apiKey, 'inherited-minimax')
await assert.rejects(removePiAuth('minimax'), /MINIMAX_API_KEY is still inherited/)
assert.equal(configGetData().env.MINIMAX_API_KEY, undefined)
assert.equal(process.env.MINIMAX_API_KEY, 'inherited-minimax')
console.log('verified')`, { MINIMAX_API_KEY: 'inherited-minimax' })
  expect(run.status).toBe(0)
  expect(run.stdout).toContain('verified')
})

test('SDK-defined gateway key is used consistently for config, requests, display and deletion', async () => {
  const run = await withConfig(`
const assert = (await import('node:assert/strict')).default
const { getConfig, getPiAuthProviders, removePiAuth, configGetData } = await import('./src/core.ts')
const { createPiRuntime } = await import('./src/piRuntime.ts')
const config = getConfig()
const { runtime } = await createPiRuntime(config.pi.agentDir, config.childEnv)
assert.equal((await runtime.getAuth('vercel-ai-gateway')).auth.apiKey, 'config-gateway')
const provider = (await getPiAuthProviders()).find(p => p.id === 'vercel-ai-gateway')
assert.equal(provider.configured, true)
assert.equal(provider.apiKey, 'config-gateway')
assert.deepEqual(provider.envKeys, ['AI_GATEWAY_API_KEY'])
await removePiAuth('vercel-ai-gateway')
assert.equal(configGetData().env.AI_GATEWAY_API_KEY, undefined)
assert.equal((await getPiAuthProviders()).find(p => p.id === 'vercel-ai-gateway').configured, false)
assert.equal(configGetData().env.KIMI_API_KEY, 'config-kimi')
console.log('verified')`)
  expect(run.status, run.stderr).toBe(0)
  expect(run.stdout).toContain('verified')
})

test('removing an inherited gateway key explicitly reports the actual environment variable', async () => {
  const run = await withConfig(`
const assert = (await import('node:assert/strict')).default
const { getPiAuthProviders, removePiAuth, configGetData } = await import('./src/core.ts')
assert.equal((await getPiAuthProviders()).find(p => p.id === 'vercel-ai-gateway').apiKey, 'inherited-gateway')
await assert.rejects(removePiAuth('vercel-ai-gateway'), /AI_GATEWAY_API_KEY is still inherited/)
assert.equal(configGetData().env.AI_GATEWAY_API_KEY, undefined)
assert.equal(process.env.AI_GATEWAY_API_KEY, 'inherited-gateway')
console.log('verified')`, { AI_GATEWAY_API_KEY: 'inherited-gateway' })
  expect(run.status, run.stderr).toBe(0)
  expect(run.stdout).toContain('verified')
})

test('corrupt auth.json fails without erasing file-backed keys', async () => {
  const run = await withConfig(`
const assert = (await import('node:assert/strict')).default
const { mkdir, writeFile, readFile } = await import('node:fs/promises')
const { join, dirname } = await import('node:path')
const { getConfig, removePiAuth, configGetData } = await import('./src/core.ts')
const path = getConfig().pi.authPath
await mkdir(dirname(path), { recursive: true })
await writeFile(path, '{bad-json')
await assert.rejects(removePiAuth('minimax'), SyntaxError)
assert.equal(await readFile(path, 'utf8'), '{bad-json')
assert.equal(configGetData().env.MINIMAX_API_KEY, 'config-minimax')
console.log('verified')`)
  expect(run.status).toBe(0)
  expect(run.stdout).toContain('verified')
})

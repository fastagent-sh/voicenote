import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runAsync } from './testing/fakeModel.ts'

async function checkAuth(script: string, env: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'vn-pi-auth-'))
  try {
    const run = await runAsync(process.execPath, ['--input-type=module', '-e', `
const assert = (await import('node:assert/strict')).default
const { readFile, mkdir, writeFile } = await import('node:fs/promises')
const { getConfig, getPiAuthProviders, isPiAuthConfigured, removePiAuth, setPiApiKey } = await import('./src/core.ts')
const authPath = getConfig().pi.authPath
${script}
console.log('verified')`], {
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot, ...env },
    })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('verified')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('pi auth saves, displays and removes API keys', () => checkAuth(`
assert.equal(await isPiAuthConfigured(authPath, 'deepseek/deepseek-flash'), false)
await setPiApiKey('deepseek', 'test-key')
assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')).deepseek, { type: 'api_key', key: 'test-key' })
const ds = (await getPiAuthProviders()).find(p => p.id === 'deepseek')
assert.equal(ds.configured, true)
assert.equal(ds.apiKey, 'test-key')
assert.equal(ds.models[0].id, 'deepseek-flash')
await removePiAuth('deepseek')
assert.equal(await isPiAuthConfigured(authPath, 'deepseek/deepseek-flash'), false)
`))

test('pi auth detects environment API keys with and without a selected model', () => checkAuth(`
assert.equal(await isPiAuthConfigured(authPath, 'minimax/MiniMax-M2.7'), true)
assert.equal(await isPiAuthConfigured(authPath, 'kimi-coding/kimi-for-coding'), true)
assert.equal(await isPiAuthConfigured(authPath, null), true)
assert.equal(await isPiAuthConfigured(authPath, 'openrouter/auto'), false)
`, { MINIMAX_API_KEY: 'test-minimax', KIMI_API_KEY: 'test-kimi' }))

test('pi auth keeps OpenAI and Codex credentials independent during removal', () => checkAuth(`
await setPiApiKey('openai', 'test-openai')
const data = JSON.parse(await readFile(authPath, 'utf8'))
data['openai-codex'] = { type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600000 }
await writeFile(authPath, JSON.stringify(data))
assert.equal(await isPiAuthConfigured(authPath, 'openai/gpt-4o'), true)
await removePiAuth('openai')
const saved = JSON.parse(await readFile(authPath, 'utf8'))
assert.equal(saved.openai, undefined)
assert.equal(saved['openai-codex'].access, 'test-access')
assert.equal(await isPiAuthConfigured(authPath, 'openai/gpt-4o'), false)
`))

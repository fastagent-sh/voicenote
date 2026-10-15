import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPiAuthProviders, isPiAuthConfigured, removePiAuth, resetConfigCache, setPiApiKey } from './core.ts'

test('pi auth: sets and removes API keys and reflects auth status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vn-pi-auth-test-'))
  const authPath = join(dir, 'auth.json')
  process.env.PI_CODING_AGENT_DIR = dir
  resetConfigCache()

  try {
    // Initially not configured for deepseek
    expect(isPiAuthConfigured(authPath, 'deepseek/deepseek-flash')).toBe(false)

    // Set deepseek api key
    await setPiApiKey('deepseek', 'sk-test-deepseek-key-123')

    const fileContent = JSON.parse(await readFile(authPath, 'utf8'))
    expect(fileContent.deepseek).toEqual({
      type: 'api_key',
      key: 'sk-test-deepseek-key-123',
    })

    // Now configured for deepseek model
    expect(isPiAuthConfigured(authPath, 'deepseek/deepseek-flash')).toBe(true)

    // Check providers list from ModelRuntime
    const providers = await getPiAuthProviders()
    const ds = providers.find(p => p.id === 'deepseek')
    expect(ds).toBeDefined()
    expect(ds?.configured).toBe(true)
    expect(ds?.hasApiKey).toBe(true)
    expect(ds?.models[0]?.id).toBe('deepseek-flash')
    expect(ds?.apiKey).toBe('sk-test-deepseek-key-123')

    // Remove auth
    await removePiAuth('deepseek')
    expect(isPiAuthConfigured(authPath, 'deepseek/deepseek-flash')).toBe(false)

    const updatedFile = JSON.parse(await readFile(authPath, 'utf8'))
    expect(updatedFile.deepseek).toBeUndefined()
  } finally {
    delete process.env.PI_CODING_AGENT_DIR
    resetConfigCache()
    await rm(dir, { recursive: true, force: true })
  }
})

test('pi auth: dynamically detects environment API keys without hardcoded provider whitelist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vn-pi-env-test-'))
  const authPath = join(dir, 'auth.json')
  process.env.PI_CODING_AGENT_DIR = dir
  process.env.MINIMAX_API_KEY = 'test-minimax-key'
  process.env.KIMI_API_KEY = 'test-kimi-key'
  resetConfigCache()

  try {
    expect(isPiAuthConfigured(authPath, 'minimax/MiniMax-Text-01')).toBe(true)
    expect(isPiAuthConfigured(authPath, 'kimi-coding/kimi-for-coding')).toBe(true)
    expect(isPiAuthConfigured(authPath, 'openrouter/auto')).toBe(false)
  } finally {
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.MINIMAX_API_KEY
    delete process.env.KIMI_API_KEY
    resetConfigCache()
    await rm(dir, { recursive: true, force: true })
  }
})

test('pi auth: keeps openai and openai-codex independent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vn-pi-codex-test-'))
  const authPath = join(dir, 'auth.json')
  process.env.PI_CODING_AGENT_DIR = dir
  resetConfigCache()

  try {
    await setPiApiKey('openai', 'sk-openai-test-key')
    expect(isPiAuthConfigured(authPath, 'openai/gpt-4o')).toBe(true)
    expect(isPiAuthConfigured(authPath, 'openai-codex/gpt-6.1-sol')).toBe(false)

    const providers = await getPiAuthProviders()
    const codex = providers.find(p => p.id === 'openai-codex')
    const openai = providers.find(p => p.id === 'openai')
    expect(codex).toBeDefined()
    expect(openai).toBeDefined()
    expect(openai?.configured).toBe(true)
    expect(codex?.configured).toBe(false)
  } finally {
    delete process.env.PI_CODING_AGENT_DIR
    resetConfigCache()
    await rm(dir, { recursive: true, force: true })
  }
})

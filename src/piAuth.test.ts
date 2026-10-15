import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPiAuthProviders, isPiAuthConfigured, removePiAuth, setPiApiKey } from './core.ts'

test('pi auth: sets and removes API keys and reflects auth status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vn-pi-auth-test-'))
  const authPath = join(dir, 'auth.json')
  process.env.PI_CODING_AGENT_DIR = dir

  try {
    // Initially not configured for deepseek
    expect(isPiAuthConfigured(authPath, 'deepseek/deepseek-chat')).toBe(false)

    // Set deepseek api key
    await setPiApiKey('deepseek', 'sk-test-deepseek-key-123')

    const fileContent = JSON.parse(await readFile(authPath, 'utf8'))
    expect(fileContent.deepseek).toEqual({
      type: 'api_key',
      key: 'sk-test-deepseek-key-123',
    })

    // Now configured for deepseek model
    expect(isPiAuthConfigured(authPath, 'deepseek/deepseek-chat')).toBe(true)

    // Check providers list from ModelRuntime
    const providers = await getPiAuthProviders()
    const ds = providers.find(p => p.id === 'deepseek')
    expect(ds).toBeDefined()
    expect(ds?.configured).toBe(true)
    expect(ds?.hasApiKey).toBe(true)
    expect(ds?.models.some(m => m.id === 'deepseek-chat')).toBe(true)
    expect(ds?.models.some(m => m.id === 'deepseek-reasoner')).toBe(true)

    // Remove auth
    await removePiAuth('deepseek')
    expect(isPiAuthConfigured(authPath, 'deepseek/deepseek-chat')).toBe(false)

    const updatedFile = JSON.parse(await readFile(authPath, 'utf8'))
    expect(updatedFile.deepseek).toBeUndefined()
  } finally {
    delete process.env.PI_CODING_AGENT_DIR
    await rm(dir, { recursive: true, force: true })
  }
})

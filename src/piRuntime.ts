import { join } from 'node:path'
import type { CredentialStore, Provider } from '@earendil-works/pi-ai'

// These SDK OAuth implementations only offer device-code sign-in.
const DEVICE_CODE_PROVIDERS = new Set(['kimi-coding', 'github-copilot', 'meta', 'xai'])

export function providerLoginMethods(provider: Provider) {
  return {
    hasApiKey: Boolean(provider.auth.apiKey?.login),
    hasOAuth: Boolean(provider.auth.oauth) && !DEVICE_CODE_PROVIDERS.has(provider.id),
  }
}

export function preferredModelId(providerId: string, models: readonly { id: string }[]): string | undefined {
  const preferences: Record<string, string> = {
    deepseek: 'deepseek-flash',
    'openai-codex': 'gpt-6.1-sol',
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-5-5',
    minimax: 'MiniMax-M2.7',
  }
  const preferred = preferences[providerId]
  return models.find(model => model.id === preferred)?.id ?? models[0]?.id
}

function effectiveEnvironment(env: Record<string, string>): Record<string, string> {
  const inherited = Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  return { ...Object.fromEntries(inherited), ...env }
}

export async function providerEnvKeys(providerId: string, env: Record<string, string> = {}): Promise<string[]> {
  const { findEnvKeys } = await import('@earendil-works/pi-ai/compat')
  return findEnvKeys(providerId, effectiveEnvironment(env)) ?? []
}

export async function openPiCredentials(authPath: string): Promise<CredentialStore> {
  // pi 1.2 exposes ModelRuntime but not its locked AuthStorage through the package entrypoint.
  const url = new URL('./core/auth-storage.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href
  const { AuthStorage } = await import(url) as { AuthStorage: { create(path: string): CredentialStore } }
  const storage = AuthStorage.create(authPath)
  await storage.list({ signal: AbortSignal.timeout(10_000) })
  return storage
}

export async function createPiRuntime(agentDir: string, env: Record<string, string> = {}) {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const credentials = await openPiCredentials(join(agentDir, 'auth.json'))
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: join(agentDir, 'models.json'),
  })
  const stored = new Set((await credentials.list({ signal: AbortSignal.timeout(10_000) })).map(c => c.providerId))
  const { findEnvKeys, getEnvApiKey } = await import('@earendil-works/pi-ai/compat')
  const effectiveEnv = effectiveEnvironment(env)
  for (const provider of runtime.getProviders()) {
    if (stored.has(provider.id) || !provider.auth.apiKey) continue
    if (!findEnvKeys(provider.id, effectiveEnv)?.length) continue
    const key = getEnvApiKey(provider.id, effectiveEnv)
    if (key) await runtime.setRuntimeApiKey(provider.id, key)
  }
  if (runtime.getError()) throw new Error(runtime.getError())
  return { runtime, credentials }
}

import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  configFileEnv,
  getConfig,
  loadConfigJson,
  resetConfigCache,
  writeConfigJson,
} from './config.ts'
import {
  createPiRuntime,
  openPiCredentials,
  preferredModelId,
  providerEnvKeys,
  providerLoginMethods,
} from './piRuntime.ts'
import { promptInTerminal, type LoginInteraction } from './loginInteraction.ts'
import { loginWithBrowser, PI_PROVIDER_ID } from './chatgptAuth.ts'
import { installProxyFromEnv } from './piAgent.ts'

export type PiModelItem = { id: string; name: string }

export type PiProviderItem = {
  id: string
  name: string
  configured: boolean
  source?: string
  authType?: 'api_key' | 'oauth'
  hasApiKey: boolean
  hasOAuth: boolean
  models: PiModelItem[]
  defaultModelId?: string
  envKeys: string[]
  apiKey?: string
}

async function openPath(target: string, timeoutMs = 5000): Promise<{ stdout: string; stderr: string; code: number }> {
  const { spawn } = await import('node:child_process')
  const IS_WINDOWS = process.platform === 'win32'
  const IS_MAC = process.platform === 'darwin'
  const command = IS_MAC ? 'open' : IS_WINDOWS ? 'cmd.exe' : 'xdg-open'
  const args = IS_WINDOWS ? ['/c', 'start', '""', target] : [target]
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { proc.kill(); resolve({ stdout: '', stderr: 'timeout', code: 1 }) }, timeoutMs)
    proc.on('error', (err) => { clearTimeout(timer); resolve({ stdout: '', stderr: String(err), code: 1 }) })
    proc.on('close', (code) => { clearTimeout(timer); resolve({ stdout: '', stderr: '', code: code ?? 0 }) })
  })
}

async function persistPiOAuth(authPath: string, providerId: string, creds: Record<string, unknown>): Promise<void> {
  const storage = await openPiCredentials(authPath)
  await storage.modify(providerId, async () => ({
    type: 'oauth',
    access: String(creds.access),
    refresh: String(creds.refresh),
    expires: Number(creds.expires),
    ...(creds.accountId ? { accountId: String(creds.accountId) } : {}),
  }), { signal: AbortSignal.timeout(10_000) })
}

export async function loginChatGPT(opts: {
  json?: boolean
  signal?: AbortSignal
  emit?: (o: Record<string, unknown>) => void
}): Promise<void> {
  const authPath = getConfig().pi.authPath
  await installProxyFromEnv()
  const json = !!opts.json
  const emit = opts.emit ?? ((o: Record<string, unknown>) => { if (json) console.log(JSON.stringify(o)) })
  try {
    const creds = await loginWithBrowser((url) => {
      if (json) emit({ event: 'auth_url', url })
      else {
        console.log('\nOpening your browser to sign in to ChatGPT…')
        console.log(`If it doesn't open, paste this into a browser on THIS machine:\n  ${url}`)
      }
      void openPath(url)
    }, opts.signal)
    await persistPiOAuth(authPath, PI_PROVIDER_ID, creds as unknown as Record<string, unknown>)
    if (json) emit({ event: 'success', provider: PI_PROVIDER_ID })
    else console.log(`\n✓ Signed in. Credentials saved to ${authPath}. Verify with: vn doctor`)
  } catch (e: any) {
    let message = String(e?.message || e)
    if (/unsupported_country_region_territory|\b403\b/.test(message)) {
      message += ' — OpenAI blocks this region without a proxy. Set LOCAL_PROXY_HOST/LOCAL_PROXY_PORT (or http_proxy) and retry; Volcano stays direct.'
    }
    if (json) emit({ event: 'error', message })
    throw new Error(message, { cause: e })
  }
}

export const loginOpenAICodexOAuth = loginChatGPT

export async function getPiAuthProviders(): Promise<PiProviderItem[]> {
  const config = getConfig()
  const { runtime, credentials } = await createPiRuntime(config.pi.agentDir, config.childEnv)
  const providers = runtime.getProviders()
  const list: PiProviderItem[] = []
  for (const p of providers) {
    if (p.id === 'google') continue
    const { hasApiKey, hasOAuth } = providerLoginMethods(p)
    if (!hasApiKey && !hasOAuth) continue

    const status = runtime.getProviderAuthStatus(p.id)
    const models = runtime.getModels(p.id).map(m => ({ id: m.id, name: m.name }))
    const auth = await runtime.checkAuth(p.id)
    const stored = await credentials.read(p.id, { signal: AbortSignal.timeout(10_000) })
    const apiKey = auth?.type === 'api_key' ? (await runtime.getAuth(p.id))?.auth.apiKey : undefined
    list.push({
      id: p.id,
      name: p.name,
      configured: Boolean(auth),
      source: stored ? 'stored' : status.source,
      authType: auth?.type,
      hasApiKey,
      hasOAuth,
      models,
      defaultModelId: preferredModelId(p.id, models),
      envKeys: await providerEnvKeys(p.id, config.childEnv),
      apiKey,
    })
  }

  const priority = [
    'deepseek',
    'openai-codex',
    'openai',
    'anthropic',
    'kimi-coding',
    'minimax',
    'qwen-token-plan-cn',
    'openrouter',
    'github-copilot',
    'xai',
  ]
  list.sort((a, b) => {
    const ai = priority.indexOf(a.id)
    const bi = priority.indexOf(b.id)
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return a.name.localeCompare(b.name)
  })
  return list
}

export async function setPiApiKey(providerId: string, apiKey: string): Promise<void> {
  const trimmed = apiKey.trim()
  if (!trimmed) throw new Error('API key cannot be empty')
  const storage = await openPiCredentials(getConfig().pi.authPath)
  await storage.modify(providerId, async () => ({ type: 'api_key', key: trimmed }), { signal: AbortSignal.timeout(10_000) })
}

export async function removePiAuth(providerId: string): Promise<void> {
  const authPath = getConfig().pi.authPath
  const storage = await openPiCredentials(authPath)
  const current = loadConfigJson()
  const keys = await providerEnvKeys(providerId, configFileEnv(current))
  for (const key of keys) delete current[key]
  await storage.delete(providerId, { signal: AbortSignal.timeout(10_000) })
  await writeConfigJson(current)
  resetConfigCache()
  const inherited = keys.filter(key => process.env[key])
  if (inherited.length) {
    throw new Error(`Stored credentials removed; ${inherited.join(', ')} is still inherited from the environment. Unset it and restart VoiceNote.`)
  }
}

export function getOrCreateDeviceId(): string {
  try {
    const current = loadConfigJson()
    if (typeof current.deviceId === 'string' && current.deviceId) {
      return current.deviceId
    }
    const id = randomUUID()
    current.deviceId = id
    void writeConfigJson(current).catch((err) => {
      console.error('Failed to persist deviceId in config:', err)
    })
    return id
  } catch (err) {
    console.error('Failed to read config for deviceId:', err)
    return randomUUID()
  }
}

export async function loginPiProvider(providerId: string, opts: {
  json?: boolean
  emit?: (o: Record<string, unknown>) => void
  prompt?: LoginInteraction['prompt']
  signal?: AbortSignal
} = {}): Promise<void> {
  const signal = AbortSignal.any([AbortSignal.timeout(15 * 60_000), ...(opts.signal ? [opts.signal] : [])])
  if (providerId === 'openai-codex') {
    return loginChatGPT({ ...opts, signal })
  }
  const config = getConfig()
  const authPath = config.pi.authPath
  await installProxyFromEnv()
  const json = !!opts.json
  const emit = opts.emit ?? ((o: Record<string, unknown>) => { if (json) console.log(JSON.stringify(o)) })
  const { runtime } = await createPiRuntime(config.pi.agentDir, config.childEnv)
  const provider = runtime.getProvider(providerId)
  if (!provider) throw new Error(`Unknown provider '${providerId}'`)
  if (!providerLoginMethods(provider).hasOAuth) throw new Error(`Provider '${providerId}' does not support browser OAuth. Use an API key.`)

  try {
    await runtime.login(providerId, 'oauth', {
      signal,
      prompt: prompt => {
        if (prompt.type === 'select' && prompt.options.some(option => option.id === 'browser')) {
          return Promise.resolve('browser')
        }
        const promptSignal = AbortSignal.any([signal, ...(prompt.signal ? [prompt.signal] : [])])
        if (opts.prompt) return opts.prompt({ ...prompt, signal: promptSignal })
        if (json) throw new Error('Interactive login requires a prompt handler')
        return promptInTerminal(prompt, promptSignal)
      },
      notify: (event) => {
        if (event.type === 'auth_url') {
          if (json) emit({ event: 'auth_url', url: event.url })
          else console.log(`\nSign in to ${provider.name} in your browser:\n  ${event.url}\n${event.instructions ?? ''}`)
          void openPath(event.url)
        } else if (event.type === 'device_code') {
          throw new Error('Device-code sign-in is not supported. Use browser OAuth or an API key.')
        } else if (event.type === 'progress' || event.type === 'info') {
          if (json) emit({ event: 'progress', message: event.message })
          else console.log(event.message)
        }
      },
    }, {
      getDeviceId: () => getOrCreateDeviceId(),
      agentName: 'VoiceNote',
    })
    if (json) emit({ event: 'success', provider: providerId })
    else console.log(`\n✓ Signed in to ${provider.name}. Credentials saved to ${authPath}.`)
  } catch (e: any) {
    const message = String(e?.message || e)
    if (json) emit({ event: 'error', message })
    throw new Error(`Login to ${provider.name} failed: ${message}`, { cause: e })
  }
}

export async function isPiAuthConfigured(authPath: string, model: string | null): Promise<boolean> {
  const { runtime } = await createPiRuntime(dirname(authPath), getConfig().childEnv)
  if (!model) return runtime.getAvailableSnapshot().length > 0
  const provider = model.split('/')[0]
  return provider ? Boolean(await runtime.checkAuth(provider)) : false
}

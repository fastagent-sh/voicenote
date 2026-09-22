// The notes model runs through pi's SDK, in this process. pi is a Node package
// and a pinned dependency, so there is no binary to locate, no runtime to ship
// next to it, and no stdout/stderr contract to parse — and the desktop app can
// call this exact function from its own main process.
//
// The import is dynamic because loading the SDK costs ~1s and pulls in every
// provider client; commands that never summarize (scan, jobs, doctor) must not
// pay for it.
import { join } from 'node:path'

/** Live signal from a running agent turn, for a progress UI. */
export type AgentProgress =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }

export type AgentRunOptions = {
  /** pi's config dir: auth.json and models.json live here. */
  agentDir: string
  /** Working directory for read/grep. Also where relative tool paths resolve. */
  cwd: string
  /** "provider/id", e.g. "openai-codex/gpt-5.6-sol". Null = pi's own default. */
  model: string | null
  thinking?: string
  /** Built-in tool names, e.g. ['read', 'grep']. Empty = no tools at all. */
  tools: string[]
  systemPrompt: string
  appendSystemPrompt?: string
  userPrompt: string
  timeoutMs: number
  onProgress?: (p: AgentProgress) => void
}

/**
 * Node's global fetch ignores http_proxy/https_proxy (Bun's did not), so the
 * model call silently hangs or fails wherever a proxy is required. Installing
 * undici's env-driven agent once fixes every fetch in the process, and it
 * honours no_proxy — which is how the Volcano ASR host stays direct.
 */
let proxyInstalled = false
export async function installProxyFromEnv(): Promise<void> {
  if (proxyInstalled) return
  proxyInstalled = true
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY
  if (!proxy) return
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici')
  setGlobalDispatcher(new EnvHttpProxyAgent())
}

/** Runs one prompt to completion and returns the assistant's text. */
export async function runAgentPrompt(opts: AgentRunOptions): Promise<string> {
  await installProxyFromEnv()
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } =
    await import('@earendil-works/pi-coding-agent')

  const modelRuntime = await ModelRuntime.create({
    authPath: join(opts.agentDir, 'auth.json'),
    modelsPath: join(opts.agentDir, 'models.json'),
  })
  let model
  if (opts.model) {
    const slash = opts.model.indexOf('/')
    if (slash <= 0) throw new Error(`Invalid model '${opts.model}'; expected "provider/id", e.g. openai-codex/gpt-5.6-sol`)
    const providerId = opts.model.slice(0, slash)
    const modelId = opts.model.slice(slash + 1)
    model = modelRuntime.getModel(providerId, modelId)
    if (!model) throw new Error(`Unknown model '${opts.model}'. Check the provider/id spelling, or clear VOICENOTE_PI_MODEL to use pi's default.`)
  }

  // Everything discoverable is switched off: this is a fixed pipeline step, so
  // a stray extension, skill or AGENTS.md in the notes directory must not
  // change how notes are written.
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: opts.systemPrompt,
    ...(opts.appendSystemPrompt ? { appendSystemPrompt: [opts.appendSystemPrompt] } : {}),
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    ...(model ? { model } : {}),
    ...(opts.thinking ? { thinkingLevel: opts.thinking as never } : {}),
    ...(opts.tools.length ? { tools: opts.tools } : { noTools: 'all' as const }),
  })

  let text = ''
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      text += event.assistantMessageEvent.delta
      opts.onProgress?.({ type: 'text', delta: event.assistantMessageEvent.delta })
    } else if (event.type === 'tool_execution_start') {
      opts.onProgress?.({ type: 'tool', name: event.toolName })
    }
  })

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; void session.abort() }, opts.timeoutMs)
  try {
    await session.prompt(opts.userPrompt)
  } finally {
    clearTimeout(timer)
    unsubscribe()
    session.dispose()
  }

  if (timedOut) throw new Error(`Notes model timed out after ${Math.round(opts.timeoutMs / 1000)}s`)
  const trimmed = text.trim()
  // prompt() resolves even when the model call failed; the error lands in agent
  // state. Reporting it verbatim is what makes "no API key" or "rate limited"
  // visible instead of a bare "empty output".
  if (!trimmed) throw new Error(session.agent.state.errorMessage || 'Notes model returned no text')
  return trimmed
}

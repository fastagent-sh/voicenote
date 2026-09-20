// A stand-in for the notes model, used by the end-to-end run tests.
//
// The pipeline calls pi's SDK in-process, so there is no binary to replace.
// Instead we register a custom OpenAI-compatible provider in pi's models.json
// and serve it from localhost: the run then exercises the real agent code path
// (prompt assembly, tool config, retries, output writing) without a network
// call or an API key.
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type FakeModel = {
  /** Value for VOICENOTE_PI_MODEL. */
  modelRef: string
  /** Prompts the fake model has been asked to complete, in order. */
  requests: { system: string; user: string }[]
  /** Replies with this text; set to null to fail the request with a 500. */
  reply: string | null
  stop: () => Promise<void>
}

const PROVIDER = 'fake-local'
const MODEL = 'fake-model'

/**
 * Starts the fake model and points pi at it. `agentDir` is the same directory
 * vn passes as PI_CODING_AGENT_DIR (models.json and auth.json live there).
 */
export async function startFakeModel(agentDir: string): Promise<FakeModel> {
  const state: Pick<FakeModel, 'requests' | 'reply'> = { requests: [], reply: '{"title":"Fake note","markdown":"# Fake note"}' }

  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      const messages: { role: string; content: unknown }[] = parsed.messages ?? []
      const textOf = (role: string) => messages
        .filter(m => m.role === role || (role === 'system' && m.role === 'developer'))
        .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
        .join('\n')
      state.requests.push({ system: textOf('system'), user: textOf('user') })

      if (state.reply === null) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'summary backend is down' } }))
        return
      }
      // Streaming is what pi asks for; a single content chunk is a valid stream.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: state.reply } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('fake model server has no port')

  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      [PROVIDER]: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: 'openai-completions',
        apiKey: 'fake-key',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: MODEL }],
      },
    },
  }, null, 2))

  return {
    modelRef: `${PROVIDER}/${MODEL}`,
    get requests() { return state.requests },
    get reply() { return state.reply },
    set reply(value: string | null) { state.reply = value },
    stop: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())),
  }
}

/**
 * Runs a command to completion without blocking this process's event loop.
 * spawnSync would: the fake model server lives here, so a synchronous wait
 * never accepts the connection and the child hangs until its timeout.
 */
export function runAsync(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000)
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
  })
}

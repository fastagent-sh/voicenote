import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The desktop app's main process is Node, and Node's fetch behaves differently
// from Bun's here (proxy env vars, dispatchers), so these run the real login
// under node instead of in-process.
const CORE_URL = pathToFileURL(join(import.meta.dir, 'core.ts')).href
const PI_AGENT_URL = pathToFileURL(join(import.meta.dir, 'piAgent.ts')).href

async function runNode(script: string, env: Record<string, string>): Promise<string> {
  const child = spawn('node', ['--input-type=module', '-e', script], {
    env: { ...process.env, VN_CORE_URL: CORE_URL, VN_PI_AGENT_URL: PI_AGENT_URL, ...env },
    timeout: 20_000,
  })
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk })
  child.stderr.on('data', (chunk: Buffer) => { stdout += chunk })
  await new Promise(done => child.on('close', done))
  return stdout
}

const agentDir = () => mkdtemp(join(tmpdir(), 'voicenote-login-'))

// Node's fetch ignores http_proxy/https_proxy unless a dispatcher is installed;
// login used to skip that step, so on a proxy-only network the token request
// went direct and failed while the browser had already shown the callback page.
// A fake proxy proves the request goes through it: without the dispatcher,
// nothing reaches this server.
test.skipIf(process.platform === 'win32')('login sends its OpenAI requests through the configured proxy', async () => {
  const seen: string[] = []
  const proxy = createServer()
  proxy.on('connect', (req, socket) => { seen.push(req.url ?? ''); socket.destroy() })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const port = (proxy.address() as { port: number }).port

  // Device-code flow: the first thing it does is POST to auth.openai.com, with
  // no browser or local callback server in the way.
  // The second fetch guards the other half of the deal: installing a global
  // dispatcher must not drag Volcano ASR through the proxy (no_proxy covers it).
  // Async spawn (inside runNode), not spawnSync: the fake proxy lives in this
  // process and can only answer the child's CONNECT if the event loop turns.
  const stdout = await runNode(
    `const { loginChatGPT } = await import(process.env.VN_CORE_URL)
await loginChatGPT({ json: true, deviceCode: true })
await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit', { signal: AbortSignal.timeout(3000) }).catch(() => {})`,
    { https_proxy: `http://127.0.0.1:${port}`, PI_CODING_AGENT_DIR: await agentDir() },
  )
  proxy.close()

  expect(seen).toEqual(['auth.openai.com:443'])
  expect(seen).not.toContain('openspeech.bytedance.com:443')
  // The fake proxy kills the tunnel, so the flow must report a failure, not a login.
  expect(stdout).toContain('"event":"error"')
}, 40_000)

// What pi reads back out of auth.json is the whole point of logging in: a
// wrong shape means the GUI reports "signed in" and every summary then fails
// with "No API key found". undici's MockAgent stands in for OpenAI so the full
// device-code flow runs — including the pending poll and the code exchange.
test.skipIf(process.platform === 'win32')('a completed device-code login lands in auth.json in the shape pi reads', async () => {
  const dir = await agentDir()
  // A second provider already in the file must survive: pi's own interactive
  // session has dropped entries by rewriting this file wholesale.
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ anthropic: { type: 'api', key: 'keep-me' } }))

  const stdout = await runNode(
    `const { installProxyFromEnv } = await import(process.env.VN_PI_AGENT_URL)
// Claim the one-shot proxy install before mocking: otherwise a machine with a
// system proxy would have login replace the mock with a real proxy agent.
await installProxyFromEnv()
const { MockAgent, setGlobalDispatcher } = await import('undici')
const agent = new MockAgent()
agent.disableNetConnect()
setGlobalDispatcher(agent)
const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-9' } }
const jwt = 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.y'
const openai = agent.get('https://auth.openai.com')
openai.intercept({ path: '/api/accounts/deviceauth/usercode', method: 'POST' })
  .reply(200, { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: 1 })
openai.intercept({ path: '/api/accounts/deviceauth/token', method: 'POST' })
  .reply(403, { error: { code: 'deviceauth_authorization_pending' } })
openai.intercept({ path: '/api/accounts/deviceauth/token', method: 'POST' })
  .reply(200, { authorization_code: 'auth-code', code_verifier: 'verifier' })
openai.intercept({ path: '/oauth/token', method: 'POST' })
  .reply(200, { access_token: jwt, refresh_token: 'refresh-1', expires_in: 3600 })
const { loginChatGPT } = await import(process.env.VN_CORE_URL)
await loginChatGPT({ json: true, deviceCode: true })`,
    { PI_CODING_AGENT_DIR: dir },
  )

  expect(stdout).toContain('"event":"success"')
  expect(stdout).toContain('"userCode":"ABCD-1234"')
  const saved = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
  expect(saved.anthropic).toEqual({ type: 'api', key: 'keep-me' })
  expect(saved['openai-codex']).toEqual({
    type: 'oauth',
    access: expect.stringContaining('x.'),
    refresh: 'refresh-1',
    expires: expect.any(Number),
    accountId: 'acc-9',
  })
  // expires is an absolute timestamp, not the API's relative expires_in.
  expect(saved['openai-codex'].expires - Date.now()).toBeGreaterThan(3_000_000)
}, 40_000)

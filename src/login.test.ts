import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CORE_URL = pathToFileURL(join(import.meta.dir, 'core.ts')).href
const PI_AGENT_URL = pathToFileURL(join(import.meta.dir, 'piAgent.ts')).href
const browserLogin = `
const { get } = await import('node:http')
const { loginChatGPT } = await import(process.env.VN_CORE_URL)
try {
  await loginChatGPT({ json: true, emit: event => {
    console.log(JSON.stringify(event))
    if (event.event === 'auth_url') {
      const auth = new URL(event.url)
      const callback = new URL(auth.searchParams.get('redirect_uri'))
      callback.searchParams.set('code', 'auth-code')
      callback.searchParams.set('state', auth.searchParams.get('state'))
      get(callback, res => res.resume()).on('error', error => { console.error(error); process.exitCode = 1 })
    }
  } })
} catch (error) { console.error(error.message); process.exitCode = 1 }
`

async function runNode(script: string, dir: string, env: Record<string, string> = {}): Promise<string> {
  const bin = join(dir, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'open'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const child = spawn('node', ['--input-type=module', '-e', script], {
    env: { ...process.env, VN_CORE_URL: CORE_URL, VN_PI_AGENT_URL: PI_AGENT_URL, PI_CODING_AGENT_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...env },
    timeout: 20_000,
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  await new Promise(done => child.on('close', done))
  return output
}

test.skipIf(process.platform === 'win32')('browser OAuth exchanges tokens through the configured proxy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vn-login-proxy-'))
  const seen: string[] = []
  const proxy = createServer()
  proxy.on('connect', (req, socket) => { seen.push(req.url ?? ''); socket.destroy() })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const port = (proxy.address() as { port: number }).port
  try {
    const output = await runNode(`${browserLogin}
await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit', { signal: AbortSignal.timeout(3000) }).catch(() => {})`, dir,
      { https_proxy: `http://127.0.0.1:${port}` })
    expect(seen).toEqual(['auth.openai.com:443'])
    expect(output).toContain('"event":"auth_url"')
    expect(output).toContain('"event":"error"')
  } finally {
    proxy.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 40_000)

test.skipIf(process.platform === 'win32')('browser OAuth stores Codex credentials without overwriting other providers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vn-login-browser-'))
  try {
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ deepseek: { type: 'api_key', key: 'keep-me' } }))
    const output = await runNode(`
const { installProxyFromEnv } = await import(process.env.VN_PI_AGENT_URL)
await installProxyFromEnv()
const { MockAgent, setGlobalDispatcher } = await import('undici')
const agent = new MockAgent()
agent.disableNetConnect()
setGlobalDispatcher(agent)
const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-9' } }
const jwt = 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.y'
agent.get('https://auth.openai.com').intercept({ path: '/oauth/token', method: 'POST' })
  .reply(200, { access_token: jwt, refresh_token: 'refresh-1', expires_in: 3600 })
${browserLogin}
agent.assertNoPendingInterceptors()
`, dir)
    expect(output).toContain('"event":"success"')
    expect(output).not.toContain('"event":"device_code"')
    const saved = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
    expect(saved.deepseek).toEqual({ type: 'api_key', key: 'keep-me' })
    expect(saved.openai).toBeUndefined()
    expect(saved['openai-codex']).toMatchObject({ type: 'oauth', access: expect.stringContaining('x.'), refresh: 'refresh-1', accountId: 'acc-9' })
    expect(saved['openai-codex'].expires - Date.now()).toBeGreaterThan(3_000_000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 40_000)

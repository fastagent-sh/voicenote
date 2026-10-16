// ChatGPT (OpenAI Codex) OAuth, PKCE + localhost callback.
//
// This is vn's own implementation on purpose. OpenAI validates the authorize
// request against a server-side allowlist tied to the shared Codex client_id:
// scope, redirect_uri, port and originator must match what the official
// `codex` CLI sends, or the browser lands on a generic "Authentication error /
// missing required parameter" page. pi-ai hardcodes an older scope
// ("openid profile email offline_access") and originator "pi", and exposes no
// way to override either, so we build the URL here.
//
// Keep the constants below in sync with openai/codex `build_authorize_url`
// (codex-rs/login/src/server.rs); chatgptAuth.test.ts pins them.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE = 'https://auth.openai.com'
const TOKEN_URL = `${AUTH_BASE}/oauth/token`
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'
const ORIGINATOR = 'codex_cli_rs'
// Only these two callback ports are registered for this client_id.
const CALLBACK_PORTS = [1455, 1457]
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

/** Provider key under which pi reads these credentials in auth.json. */
export const PI_PROVIDER_ID = 'openai-codex'

export interface ChatGPTCredential {
  access: string
  refresh: string
  expires: number
  accountId: string
}

const b64url = (b: Buffer) => b.toString('base64url')

export function buildAuthorizeUrl(redirectUri: string, challenge: string, state: string): string {
  const url = new URL(`${AUTH_BASE}/oauth/authorize`)
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: ORIGINATOR,
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

async function postForm(url: string, body: Record<string, string>, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal,
  })
  if (!res.ok) throw new Error(`${url} failed (${res.status}): ${(await res.text().catch(() => '')) || res.statusText}`)
  return res.json()
}

function credentialFromTokens(json: any): ChatGPTCredential {
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error(`Token response missing fields: ${JSON.stringify(json)}`)
  }
  const accountId = accountIdFromAccessToken(json.access_token)
  if (!accountId) throw new Error('Token has no chatgpt_account_id claim')
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId,
  }
}

export function accountIdFromAccessToken(token: string): string | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const id = claims?.[JWT_CLAIM_PATH]?.chatgpt_account_id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

async function exchangeCode(code: string, verifier: string, redirectUri: string, signal: AbortSignal): Promise<ChatGPTCredential> {
  return credentialFromTokens(await postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }, signal))
}

export async function loginWithBrowser(onAuthUrl: (url: string) => void, signal = AbortSignal.timeout(LOGIN_TIMEOUT_MS)): Promise<ChatGPTCredential> {
  signal.throwIfAborted()
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(32))

  let resolveCode: (code: string) => void
  let rejectCode: (err: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })

  const server = createServer((req, res) => {
    const url = new URL(req.url || '', 'http://localhost')
    if (url.pathname !== '/auth/callback') { res.statusCode = 404; res.end('Not found'); return }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const ok = !error && !!code && url.searchParams.get('state') === state
    res.statusCode = ok ? 200 : 400
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    // Not "signed in": the token exchange still has to run, and it is the step
    // that fails on a proxy-only network. Say so, or the app showing "not
    // signed in" after this page looks like the app is wrong.
    res.end(ok ? 'Authorization received. Return to VoiceNote — it finishes sign-in there.' : 'Sign-in failed. Return to VoiceNote for details.')
    if (error) rejectCode(new Error(`Authorization denied: ${error}`))
    else if (!code) rejectCode(new Error('Callback carried no authorization code'))
    else if (!ok) rejectCode(new Error('Callback state mismatch (stale sign-in tab?)'))
    else resolveCode(code)
  })

  const port = await listenOnAllowlistedPort(server)
  const abort = () => rejectCode(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const redirectUri = `http://localhost:${port}/auth/callback`
    onAuthUrl(buildAuthorizeUrl(redirectUri, challenge, state))
    return await exchangeCode(await codePromise, verifier, redirectUri, signal)
  } finally {
    signal.removeEventListener('abort', abort)
    server.close()
    server.closeAllConnections()
  }
}

function listenOnAllowlistedPort(server: ReturnType<typeof createServer>): Promise<number> {
  const tryPort = (port: number) => new Promise<number | null>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? resolve(null) : reject(err))
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', onError); resolve(port) })
  })
  return (async () => {
    for (const port of CALLBACK_PORTS) {
      const bound = await tryPort(port)
      if (bound) return bound
    }
    throw new Error(`Ports ${CALLBACK_PORTS.join(' and ')} are both busy; OpenAI accepts no other callback port. Close whatever holds them (another sign-in?) and retry.`)
  })()
}

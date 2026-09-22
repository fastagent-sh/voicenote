import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { accountIdFromAccessToken, buildAuthorizeUrl, loginWithBrowser } from './chatgptAuth.ts'

// Every param below is validated server-side against OpenAI's allowlist for
// the shared Codex client_id. Drift breaks sign-in with a generic
// "Authentication error / missing required parameter" page in the browser, so
// pin the exact values instead of substring-matching.
describe('buildAuthorizeUrl', () => {
  const verifier = 'test-verifier'
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const url = new URL(buildAuthorizeUrl('http://localhost:1455/auth/callback', challenge, 'test-state'))

  it('targets the Codex authorize endpoint', () => {
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.openai.com/oauth/authorize')
  })

  it('sends exactly the allowlisted parameter set', () => {
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      redirect_uri: 'http://localhost:1455/auth/callback',
      scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state: 'test-state',
      originator: 'codex_cli_rs',
    })
  })
})

// OpenAI only allows 1455 and 1457 as callback ports, so a second sign-in
// attempt (or another Codex client) holding one must not sink the flow. Both
// halves are local: no code reaches the token endpoint.
describe('browser flow callback', () => {
  it('falls back to 1457 and rejects a state that does not match', async () => {
    const squatter = createServer()
    await new Promise<void>(resolve => squatter.listen(1455, '127.0.0.1', resolve))
    try {
      let redirectUri = ''
      const login = loginWithBrowser(url => {
        redirectUri = new URL(url).searchParams.get('redirect_uri') ?? ''
        // Stand in for the browser landing on the callback, with a stale state.
        void fetch(`${redirectUri}?code=abc&state=stale`).catch(() => {})
      })
      await expect(login).rejects.toThrow(/state mismatch/)
      expect(redirectUri).toBe('http://localhost:1457/auth/callback')
    } finally {
      squatter.close()
    }
  })
})

describe('accountIdFromAccessToken', () => {
  const jwt = (payload: unknown) => [
    'x',
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'y',
  ].join('.')

  it('reads the chatgpt_account_id claim', () => {
    expect(accountIdFromAccessToken(jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } }))).toBe('acc-1')
  })

  it('returns null for tokens without the claim', () => {
    expect(accountIdFromAccessToken(jwt({ sub: 'nobody' }))).toBeNull()
    expect(accountIdFromAccessToken('not-a-jwt')).toBeNull()
  })
})

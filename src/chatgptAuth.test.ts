import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { accountIdFromAccessToken, buildAuthorizeUrl } from './chatgptAuth.ts'

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

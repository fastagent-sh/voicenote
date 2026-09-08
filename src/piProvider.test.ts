import { expect, test } from 'bun:test'
import { DEFAULT_PI_PROVIDERS, defaultPiModel, parsePiAuthStatus, parseProviderChain, usableChain, type PiAuthStatus } from './piProvider'

test('defaultPiModel: DeepSeek and OpenAI use their own models', () => {
  expect(defaultPiModel('deepseek')).toBe('deepseek-v4-flash')
  for (const provider of DEFAULT_PI_PROVIDERS) expect(defaultPiModel(provider)).toBe('gpt-5.5')
})

test('parseProviderChain: unset, empty and garbage all fall back to the one default', () => {
  for (const raw of [undefined, '', '   ', ',', ' , , ']) {
    expect(parseProviderChain(raw)).toEqual(DEFAULT_PI_PROVIDERS)
  }
})

test('parseProviderChain: trims, drops blanks, dedupes, keeps order', () => {
  expect(parseProviderChain(' openai , openai-codex ,, openai ')).toEqual(['openai', 'openai-codex'])
})

// The cross-process contract with `pi auth check --json`. A silent shape change
// upstream would make pruning misfire, so pin every branch — especially the ones
// that must NOT read as a deterministic failure.
test('parsePiAuthStatus: deterministic failures vs a probe that could not answer', () => {
  expect(parsePiAuthStatus('{"status":"ready","provider":"openai-codex","authType":"oauth"}')).toBe('ready')
  expect(parsePiAuthStatus('{"status":"not_ready","reason":"credentials_not_configured"}')).toBe('unusable')
  expect(parsePiAuthStatus('{"status":"not_ready","reason":"provider_not_found"}')).toBe('unusable')
  // Credentials exist but pi cannot use them — not deterministic from here, so
  // 'unknown' is the deliberate landing spot, not a fallthrough.
  expect(parsePiAuthStatus('{"status":"invalid","provider":"openai","reason":"invalid_state"}')).toBe('unknown')
  // Probe never ran (pi missing, timeout) or upstream changed the payload.
  expect(parsePiAuthStatus('')).toBe('unknown')
  expect(parsePiAuthStatus('command not found: pi')).toBe('unknown')
  expect(parsePiAuthStatus('{"status":"not_ready"}')).toBe('unknown')
})

const chain = (...statuses: PiAuthStatus[]) => {
  const providers = statuses.map((_, i) => `p${i}`)
  return usableChain(providers, p => statuses[providers.indexOf(p)]!)
}

test('usableChain: drops only deterministic failures, preserving order', () => {
  expect(chain('unusable', 'ready', 'unusable', 'ready')).toEqual(['p1', 'p3'])
})

// An empty chain is the ASR-spend gate's stop signal, so it must mean "nothing
// can work" — never "the probe was having a bad day".
test('usableChain: empties only when every provider is deterministically unusable', () => {
  expect(chain('unusable', 'unusable')).toEqual([])
  expect(chain('unusable', 'unknown')).toEqual(['p1'])
  expect(chain('unknown', 'unknown')).toEqual(['p0', 'p1'])
})

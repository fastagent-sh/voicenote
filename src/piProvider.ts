// Which pi providers the summary chain tries. Credential *detection* lives in
// cli.ts (it shells out to `pi auth check`); only the pure logic is here.

// Only the free ChatGPT OAuth path by default. The paid OpenAI API fallback is
// opt-in (VOICENOTE_PI_PROVIDER='openai-codex,openai', or the GUI dropdown):
// shipping it in the default chain meant every codex failure was retried against
// a provider almost nobody has a key for, and that second failure was the one the
// user saw.
export const DEFAULT_PI_PROVIDERS = ['openai-codex']

export function defaultPiModel(provider: string): string {
  return provider === 'deepseek' ? 'deepseek-v4-flash' : 'gpt-5.5'
}

export function parseProviderChain(raw: string | undefined): string[] {
  const parsed = Array.from(new Set((raw ?? '').split(',').map(s => s.trim()).filter(Boolean)))
  return parsed.length ? parsed : [...DEFAULT_PI_PROVIDERS]
}

export type PiAuthStatus = 'ready' | 'unusable' | 'unknown'

// `pi auth check --json` is the one source of truth for credentials — OAuth, keys
// stored by `/login`, and each provider's own env var (OPENAI_API_KEY,
// GEMINI_API_KEY, …), names we must not reimplement guessing.
//
// 'unusable' is a DETERMINISTIC failure: no credentials, or no such provider —
// next run gets the same answer. Note an OAuth token that has expired beyond
// refresh lands here too: with refresh on, pi reports `credentials_not_configured`.
//
// 'unknown' is pi running but giving no usable answer: a timeout, non-JSON
// output, or pi's own `status:"invalid"` — which per pi's auth-check means its
// model runtime is in an error state or checkAuth threw, i.e. a pi-side fault,
// not a verdict about this provider's credentials. (A missing pi binary is not
// in here: the caller maps ENOENT to 'unusable', since it is deterministic.)
export function parsePiAuthStatus(stdout: string): PiAuthStatus {
  try {
    const r = JSON.parse(stdout) as { status?: unknown; reason?: unknown }
    if (r.status === 'ready') return 'ready'
    if (r.reason === 'credentials_not_configured' || r.reason === 'provider_not_found') return 'unusable'
  } catch { /* not JSON → unknown */ }
  return 'unknown'
}

// One rule: only a deterministic failure justifies a decision.
//
// An 'unusable' provider can only fail — and because the chain throws its LAST
// error, that failure ("No API key found for openai") would overwrite the real
// error from the provider that actually broke, which is the bug this exists to
// kill. So it is pruned, and a chain left with nothing blocks the run before ASR
// is spent.
//
// 'unknown' is deliberately neutral: it neither prunes nor blocks. A probe that
// could not answer is not evidence, and guessing on its behalf is the same
// mistake in the other direction — let the run proceed and pi report the truth.
//
// Hence "may work": surviving this filter only means "not known to be broken",
// and nothing downstream may read it as authenticated.
const mayWork = (status: PiAuthStatus) => status !== 'unusable'

export function usableChain(configured: string[], statusOf: (provider: string) => PiAuthStatus): string[] {
  return configured.filter(p => mayWork(statusOf(p)))
}

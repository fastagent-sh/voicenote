// Pure logic behind cli.ts's env-config provenance. Extracted (no fs, no
// process.env) so its invariants are testable — see envConfig.test.ts:
//
// 1. File precedence: config.json (GUI) wins over ~/.zshrc (legacy CLI).
//    Simple $VAR/${VAR} references resolve from these values without running
//    shell code; runtime hydration may also use inherited environment values.
// 2. Hydration: only keys the real environment does NOT set are filled from
//    files — an explicit empty string in the environment (e.g.
//    VOICENOTE_PI_SUMMARY_TOOLS="") counts as set and is never overridden.
// 3. Scheduler embedding: a value is embedded only when it is NOT recoverable
//    from the files at run time — i.e. it is a real-environment value that the
//    files either don't provide or provide differently. Hydrated values and
//    real-env values equal to the file value are skipped (vn run re-reads the
//    files each start, and scheduler env outranks config.json, so embedding a
//    recoverable value would freeze it against future config edits).
// 4. A real-env value that DIFFERS from the file value is embedded as a
//    deliberate override, but reported (frozenOverrides) so the caller can
//    warn: it may equally be a stale shell session shadowing a fresh config
//    edit, and it will keep overriding until the scheduler is reinstalled.

/** Omit `environment` when checking which values files can reproduce on their own. */
export function parseFileEnv(
  keys: readonly string[],
  configData: Record<string, unknown>,
  zshrcContent: string | null,
  home: string,
  environment: Record<string, string | undefined> = {},
): Record<string, string> {
  const raw = new Map<string, string>()
  const literal = new Set<string>()
  for (const key of keys) {
    const v = configData[key]
    if (typeof v === 'string') { raw.set(key, v); continue }
    const pattern = new RegExp(`(?:^|\\n)\\s*export\\s+${key}=(?:"([^"]*)"|'([^']*)'|([^\\s"'#]+))`)
    const match = zshrcContent?.match(pattern)
    const value = match?.slice(1).find(v => v !== undefined)
    if (value !== undefined) raw.set(key, value)
    if (match?.[2] !== undefined) literal.add(key)
  }
  const resolved = new Map<string, string>()
  const visiting = new Set<string>()
  const resolve = (key: string): string => {
    const cached = resolved.get(key)
    if (cached !== undefined) return cached
    if (visiting.has(key)) throw new Error(`Circular config variable reference: ${key}`)
    visiting.add(key)
    const value = raw.get(key)!
    const expanded = literal.has(key) ? value : value.replace(/\\(\$)|\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (token, escaped, braced, bare) => {
      if (escaped) return escaped
      const ref = braced || bare
      if (ref === 'HOME') return home
      // Unknown references stay literal, so they cannot look recoverable from files.
      if (Object.hasOwn(environment, ref) && environment[ref] !== undefined) return environment[ref]!
      return raw.has(ref) ? resolve(ref) : token
    })
    visiting.delete(key)
    resolved.set(key, expanded)
    return expanded
  }
  return Object.fromEntries(Array.from(raw.keys(), key => [key, resolve(key)]))
}

/** Which keys to copy from fileEnv into an environment (invariant 2). */
export function hydrateFromFileEnv(
  keys: readonly string[],
  processEnv: Record<string, string | undefined>,
  fileEnv: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    if (processEnv[key] !== undefined) continue // real env wins, incl. ""
    const v = fileEnv[key]
    if (v !== undefined) out[key] = v
  }
  return out
}

/**
 * Per-key no_proxy/NO_PROXY derivation, made pure so its provenance invariant
 * is testable (it is the whole reason envKeysToEmbed exists). Given the
 * current env value, any previously-captured pre-merge original, whether the
 * key is already marked hydrated, and whether a proxy is active, returns:
 *   - runtime: the value to put in the environment (always volcano-merged)
 *   - capture: the pre-merge real-env original to remember (or undefined:
 *       either we synthesized the value, or it was already captured) — this is
 *       what the scheduler embeds, never the merged value
 *   - hydrate: true when we synthesized the value from nothing (fully
 *       rebuildable at run time, so it must NOT be embedded)
 * Merge is idempotent, so re-running on an already-merged value (reload) is
 * safe; capture-once is preserved by honoring capturedOriginal.
 */
export function deriveNoProxy(
  current: string | undefined,
  capturedOriginal: string | undefined,
  alreadyHydrated: boolean,
  proxyActive: boolean,
  base: string,
  volcanoHosts: readonly string[],
): { runtime: string; capture: string | undefined; hydrate: boolean } {
  const merge = (v: string): string => {
    const items = v.split(',').map(s => s.trim()).filter(Boolean)
    for (const h of volcanoHosts) if (!items.includes(h)) items.push(h)
    return items.join(',')
  }
  if (current === undefined) {
    return { runtime: merge(proxyActive ? base : ''), capture: undefined, hydrate: true }
  }
  const capture = (!alreadyHydrated && capturedOriginal === undefined) ? current : undefined
  return { runtime: merge(current), capture, hydrate: false }
}

/** Which env values the scheduler must snapshot (invariants 3 + 4). */
export function envKeysToEmbed(
  keys: readonly string[],
  processEnv: Record<string, string | undefined>,
  hydratedKeys: ReadonlySet<string>,
  fileEnv: Record<string, string>,
): { embed: Record<string, string>; frozenOverrides: string[] } {
  const embed: Record<string, string> = {}
  const frozenOverrides: string[] = []
  for (const k of keys) {
    const v = processEnv[k]
    if (v === undefined) continue
    if (hydratedKeys.has(k) || fileEnv[k] === v) continue // recoverable at run time
    embed[k] = v
    if (fileEnv[k] !== undefined) frozenOverrides.push(k)
  }
  return { embed, frozenOverrides }
}

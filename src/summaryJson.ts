// The summary model answers with a JSON object. Getting that object out of a
// model's reply is its own small problem: fences, prose around it, and — the
// expensive one — a markdown body with real newlines inside the JSON string,
// which is a 4-minute run thrown away for a formatting slip.

export function extractFirstJsonObject(text: string): string {
  const raw = text.trim()
  // Models often wrap JSON in a ```json fence; strip it before looking inside.
  const trimmed = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i)?.[1]?.trim() ?? raw
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  // Find the first balanced {...}
  let depth = 0, start = -1, inString = false, escape = false
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (escape) { escape = false; continue }
    if (inString) {
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') { if (depth === 0) start = i; depth++ }
    else if (ch === '}') { depth--; if (depth === 0 && start !== -1) return trimmed.slice(start, i + 1) }
  }
  return trimmed
}

/**
 * Escapes the control characters that sit INSIDE string literals. Only the
 * characters JSON forbids raw are touched, and only inside strings, so valid
 * JSON passes through unchanged.
 */
function escapeControlCharsInStrings(text: string): string {
  const ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (escaped) { out += ch; escaped = false; continue }
    if (ch === '\\') { out += ch; escaped = true; continue }
    if (ch === '"') { inString = !inString; out += ch; continue }
    if (inString && ESCAPES[ch]) { out += ESCAPES[ch]; continue }
    // Any other raw control char inside a string would also be rejected.
    if (inString && ch < ' ') { out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'); continue }
    out += ch
  }
  return out
}

/** Parses the model's reply, repairing raw control characters if needed. */
export function parseSummaryJson(text: string): unknown {
  const jsonText = extractFirstJsonObject(text) || '{}'
  try {
    return JSON.parse(jsonText)
  } catch (first) {
    try {
      return JSON.parse(escapeControlCharsInStrings(jsonText))
    } catch {
      throw first
    }
  }
}

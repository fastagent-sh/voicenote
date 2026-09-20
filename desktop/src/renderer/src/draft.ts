/**
 * The notes model answers with one JSON object: `{"title": …, "markdown": …}`.
 * Streamed, that arrives as raw JSON text, so showing the deltas verbatim puts
 * `\n\n` and quote escapes on screen. This pulls the two fields out of a
 * half-written object and unescapes them, so the draft can be rendered as the
 * markdown it will become.
 */
export type Draft = { title: string | null; body: string }

/** JSON string escapes, applied to a value that may be cut off mid-escape. */
function unescape(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!
    if (ch !== '\\') { out += ch; continue }
    const next = value[i + 1]
    if (next === undefined) break   // trailing backslash: the escape is still arriving
    i++
    if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else if (next === 'r') out += '\r'
    else if (next === 'u') {
      const hex = value.slice(i + 1, i + 5)
      if (hex.length < 4) break     // incomplete \uXXXX
      out += String.fromCharCode(parseInt(hex, 16))
      i += 4
    } else out += next              // \" \\ \/ and anything else stands for itself
  }
  return out
}

/** Reads one JSON string value starting at `from` (the opening quote). */
function readString(text: string, from: number): string | null {
  if (text[from] !== '"') return null
  let escaped = false
  for (let i = from + 1; i < text.length; i++) {
    const ch = text[i]!
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') return unescape(text.slice(from + 1, i))
  }
  return unescape(text.slice(from + 1))   // still streaming: take what is there
}

function field(text: string, key: string): string | null {
  const at = text.indexOf(`"${key}"`)
  if (at < 0) return null
  const colon = text.indexOf(':', at + key.length + 2)
  if (colon < 0) return null
  const quote = text.indexOf('"', colon + 1)
  if (quote < 0) return null
  return readString(text, quote)
}

/**
 * Best-effort view of a partially streamed answer. Before the JSON object
 * starts (models often think out loud first) the raw text is shown as-is —
 * that is still more informative than a spinner.
 */
export function parseDraft(raw: string): Draft {
  const trimmed = raw.trimStart()
  const start = trimmed.indexOf('{')
  if (start < 0) return { title: null, body: trimmed }
  const json = trimmed.slice(start)
  const body = field(json, 'markdown')
  const title = field(json, 'title')
  if (body === null && title === null) return { title: null, body: '' }
  return { title, body: body ?? '' }
}

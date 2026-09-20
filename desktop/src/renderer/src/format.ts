/** Shared formatting. Every duration and date the UI prints goes through here. */

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(rest)}` : `${pad(m)}:${pad(rest)}`
}

/** "2 小时 57 分" — for the length of a recording, where seconds are noise. */
export function spokenDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h && m) return `${h} 小时 ${m} 分`
  if (h) return `${h} 小时`
  return `${Math.max(1, m)} 分钟`
}

/**
 * Transcription takes roughly a twentieth of the audio's length, and the notes
 * pass is a couple of minutes on top. Stated as a range and labelled as an
 * estimate: the ASR API reports no progress, so a percentage bar would be a
 * lie, and silence for twenty minutes is worse.
 */
export function estimateRemaining(durationSeconds: number | null): string | null {
  if (!durationSeconds || durationSeconds <= 0) return null
  const low = Math.max(1, Math.round(durationSeconds / 60 / 20))
  const high = Math.max(low + 1, Math.round(durationSeconds / 60 / 8) + 2)
  return `通常需要 ${low}–${high} 分钟`
}

/** "今天 14:32" / "昨天 09:04" / "9月16日 18:39" / "2025年12月1日". */
export function friendlyTime(raw: string | null): string {
  if (!raw) return ''
  const parsed = new Date(raw.replace(' ', 'T'))
  if (Number.isNaN(parsed.getTime())) return raw
  const now = new Date()
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const hhmm = `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`
  if (sameDay(parsed, now)) return `今天 ${hhmm}`
  if (sameDay(parsed, yesterday)) return `昨天 ${hhmm}`
  if (parsed.getFullYear() === now.getFullYear()) return `${parsed.getMonth() + 1}月${parsed.getDate()}日 ${hhmm}`
  return `${parsed.getFullYear()}年${parsed.getMonth() + 1}月${parsed.getDate()}日`
}

/** Bucket for the sidebar's date grouping. */
export function timeGroup(raw: string | null): string {
  if (!raw) return '更早'
  const parsed = new Date(raw.replace(' ', 'T'))
  if (Number.isNaN(parsed.getTime())) return '更早'
  const days = (Date.now() - parsed.getTime()) / 86_400_000
  if (days < 1) return '今天'
  if (days < 2) return '昨天'
  if (days < 7) return '本周'
  if (days < 30) return '本月'
  return '更早'
}

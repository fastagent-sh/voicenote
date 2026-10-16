export function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatSeconds(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round(seconds || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return `${h}h ${m}m ${s}s`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

export async function withHeartbeat<T>(label: string, work: () => Promise<T>, heartbeatSeconds = 60): Promise<T> {
  const started = Date.now()
  const timer = setInterval(() => {
    console.log(`… Still working: ${label} (${formatElapsed(Date.now() - started)} elapsed)`)
  }, Math.max(10, heartbeatSeconds) * 1000)
  ;(timer as any).unref?.()
  try {
    const result = await work()
    console.log(`✓ Done: ${label} (${formatElapsed(Date.now() - started)})`)
    return result
  } catch (e) {
    console.error(`✗ Failed: ${label} after ${formatElapsed(Date.now() - started)}`)
    throw e
  } finally {
    clearInterval(timer)
  }
}

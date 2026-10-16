import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { volcanoAuthHeaders, type VolcanoConfig } from '../config.ts'
import { formatElapsed, formatSeconds, withHeartbeat } from '../time.ts'

export type VolcanoUtterance = {
  text?: string
  start_time?: number
  end_time?: number
  speaker_id?: number | string
  additions?: { speaker_id?: number | string; speaker?: string | number }
}

export type VolcanoQueryResult = {
  status: string
  message: string
  result?: { text?: string; utterances?: VolcanoUtterance[] }
  audio_info?: { duration?: number }
}

export async function volcanoSubmitTask(volc: VolcanoConfig, taskId: string, audioBase64: string, format: string): Promise<void> {
  const body = {
    user: { uid: 'voicenote' },
    audio: { data: audioBase64, format },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      enable_speaker_info: true,
      show_utterances: true,
      ...(volc.language ? { language: volc.language } : {}),
    },
  }
  const res = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit', {
    method: 'POST',
    headers: volcanoAuthHeaders(volc, taskId, true),
    body: JSON.stringify(body),
  })
  const status = res.headers.get('X-Api-Status-Code') || ''
  const message = res.headers.get('X-Api-Message') || ''
  if (status !== '20000000') {
    const text = await res.text().catch(() => '')
    throw new Error(`Volcano submit failed: status=${status} message=${message} body=${text.slice(0, 500)}`)
  }
}

export async function volcanoQueryResult(volc: VolcanoConfig, taskId: string): Promise<VolcanoQueryResult> {
  const res = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/query', {
    method: 'POST',
    headers: volcanoAuthHeaders(volc, taskId, false),
    body: '{}',
  })
  const status = res.headers.get('X-Api-Status-Code') || ''
  const message = res.headers.get('X-Api-Message') || ''
  const text = await res.text().catch(() => '')
  let parsed: any = null
  if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }
  return { status, message, result: parsed?.result, audio_info: parsed?.audio_info }
}

export function volcanoSpeakerLabel(u: VolcanoUtterance): string {
  const id = u.speaker_id ?? u.additions?.speaker_id ?? u.additions?.speaker
  if (id == null || id === '') return 'Speaker A'
  const n = Number(id)
  if (Number.isFinite(n) && n >= 0 && n < 26) return `Speaker ${String.fromCharCode(65 + n)}`
  return `Speaker ${String(id)}`
}

export function volcanoFormatTranscript(result: { text?: string; utterances?: VolcanoUtterance[] }): string {
  const utterances = result.utterances || []
  if (!utterances.length) return (result.text || '').trim()
  const lines = utterances
    .map(u => {
      const text = String(u.text || '').trim()
      if (!text) return ''
      const start = formatSeconds(Math.round((u.start_time || 0) / 1000))
      const end = formatSeconds(Math.round((u.end_time || 0) / 1000))
      return `[${start}-${end}] ${volcanoSpeakerLabel(u)}: ${text}`
    })
    .filter(Boolean)
  return lines.join('\n')
}

export async function volcanoTranscribeAudio(
  volc: VolcanoConfig,
  audioPath: string,
  options?: { durationSeconds?: number | null }
): Promise<string> {
  const format = (extname(audioPath).toLowerCase() || '.mp3').replace(/^\./, '')
  const taskId = randomUUID()
  const audioBase64 = (await readFile(audioPath)).toString('base64')
  console.log(`Volcano: submit ASR task ${taskId} (resource=${volc.resourceId}, format=${format}, ${(audioBase64.length / 1e6).toFixed(1)} MB upload)`)

  await withHeartbeat('upload audio and submit ASR task', () => volcanoSubmitTask(volc, taskId, audioBase64, format), 30)
  const started = Date.now()
  const expectedSeconds = options?.durationSeconds || 0
  const maxWaitMs = Math.max(20 * 60 * 1000, Math.ceil(expectedSeconds * 1000 * 1.5))
  let lastStatusLog = 0
  let lastStatus = ''
  let queryFailures = 0

  const transientQueryFailure = (desc: string): void => {
    queryFailures++
    if (queryFailures >= 10) throw new Error(`Volcano query failed ${queryFailures}x in a row: ${desc}`)
    if (Date.now() - started > maxWaitMs) throw new Error(`Volcano: timeout after ${formatElapsed(Date.now() - started)} (last error: ${desc})`)
    console.error(`… Volcano: transient query failure (attempt ${queryFailures}/10, will retry): ${desc}`)
  }

  for (;;) {
    await new Promise(res => setTimeout(res, 8000))
    let q: VolcanoQueryResult
    try {
      q = await volcanoQueryResult(volc, taskId)
    } catch (e: any) {
      transientQueryFailure(String(e?.message || e))
      continue
    }
    if (!q.status) {
      transientQueryFailure(`empty status header (HTTP-level error, body: ${q.message || 'none'})`)
      continue
    }
    queryFailures = 0
    if (q.status === '20000000' && q.result) {
      console.log(`✓ Volcano: ASR done in ${formatElapsed(Date.now() - started)}; audio_duration=${q.audio_info?.duration ?? 'unknown'}ms`)
      return volcanoFormatTranscript(q.result)
    }
    if (q.status === '20000001' || q.status === '20000002') {
      if (q.status !== lastStatus || Date.now() - lastStatusLog > 60_000) {
        const label = q.status === '20000002' ? 'queued' : 'processing'
        console.log(`… Volcano: ${label} (status=${q.status}, ${formatElapsed(Date.now() - started)} elapsed)`)
        lastStatusLog = Date.now()
        lastStatus = q.status
      }
      if (Date.now() - started > maxWaitMs) throw new Error(`Volcano: timeout after ${formatElapsed(Date.now() - started)} (last status=${q.status})`)
      continue
    }
    if (q.status === '20000003') throw new Error('Volcano: 20000003 silent audio (no speech detected)')
    throw new Error(`Volcano query failed: status=${q.status} message=${q.message}`)
  }
}

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runAsync, startFakeModel } from './testing/fakeModel.ts'

/**
 * End to end on a recorder image that reproduces the reported state: one
 * recording set aside as "unusable audio" on a 45000001 (invalid request —
 * our bug), one genuinely unreadable (45000151), one an older build had set
 * aside as ignored, and two accidental presses. Both of the first and third
 * must be transcribed and come out as notes; nothing else may cost an ASR call.
 */
test.skipIf(process.platform === 'win32')('a recording misjudged as unusable audio is transcribed again', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-misjudged-'))
  const workspace = join(home, 'notes')
  const recorder = join(home, 'recorder')
  const configDir = join(home, '.config/voicenote')
  const fake = await startFakeModel(join(configDir, 'pi-agent'))
  try {
    await mkdir(recorder, { recursive: true })
    await mkdir(join(workspace, '_state'), { recursive: true })
    const ffprobe = join(home, 'ffprobe.sh')
    await writeFile(ffprobe, `#!/bin/sh
for a in "$@"; do f="$a"; done
case "$f" in
  *164558*) echo 840 ;;
  *123420*) echo 1740 ;;
  *120457*) echo 1740 ;;
  *153708*) echo 25 ;;
  *) echo 20 ;;
esac
`, { mode: 0o755 })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      VOICENOTE_WORKSPACE: workspace,
      VOICENOTE_RECORD_DIR: recorder,
      VOICENOTE_FFPROBE_BIN: ffprobe,
      VOICENOTE_PI_MODEL: fake.modelRef,
      VOICENOTE_MAX_AGE_HOURS: '99999',
      VOLCANO_ASR_KEY: 'test-asr-key',
    }))

    // Filename, size in bytes, and the job record it arrives with.
    const files = [
      ['20261019164558.mp3', 3_000_000, { state: 'filtered', code: 'bad_audio', detail: 'Volcano query failed: status=45000001 message=invalid request' }],
      ['20260922123420.mp3', 7_000_000, { state: 'filtered', code: 'bad_audio', detail: 'Volcano submit failed: status=45000151 message=audio format not supported' }],
      ['20260922120457.mp3', 7_000_000, { state: 'filtered', code: 'ignored', detail: null }],
      ['20261019170635.mp3', 81_000, undefined],
      ['20260922153708.mp3', 101_000, undefined],
    ] as const
    const jobs: Record<string, unknown> = {}
    const recorded = new Date('2026-10-19T08:00:00Z')
    for (const [name, size, record] of files) {
      const path = join(recorder, name)
      await writeFile(path, Buffer.alloc(size))
      await utimes(path, recorded, recorded)
      const st = await stat(path)
      const digest = createHash('sha256').update(await readFile(path)).digest('hex')
      const id = createHash('sha256').update(`${path}|${st.size}|${Math.floor(st.mtimeMs / 1000)}|${digest}`).digest('hex')
      if (record) {
        jobs[id] = {
          name, source_path: path, content_hash: digest, recorded_at: `2026-10-19T16:45:58`,
          size_bytes: st.size, duration_seconds: null, attempts: 0, updated_at: '2026-10-19T16:45:58',
          title: null, paths: null, ...record,
        }
      }
    }
    const statePath = join(workspace, '_state/jobs.json')
    await writeFile(statePath, JSON.stringify({ version: 2, jobs }))

    // ASR is the only external service left: answer submit/query the way Volcano
    // does, count the submissions, and let every other request (the notes model
    // on localhost) through untouched.
    const asrLog = join(home, 'asr.log')
    const run = await runAsync(process.execPath, ['--input-type=module', '-e', `
import { appendFileSync } from 'node:fs'
const realFetch = globalThis.fetch
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === 8000 ? 0 : ms, ...rest)   // skip the 8s poll interval, not the model's own timeouts
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input)
  if (!url.includes('openspeech.bytedance.com')) return realFetch(input, init)
  appendFileSync(${JSON.stringify(asrLog)}, url.split('/').pop() + '\\n')
  const headers = { 'X-Api-Status-Code': '20000000', 'X-Api-Message': 'OK' }
  if (url.endsWith('/submit')) return new Response('', { headers })
  return new Response(JSON.stringify({ result: { text: 'hello', utterances: [{ text: 'hello', start_time: 0, end_time: 1500, speaker_id: 0 }] } }), { headers })
}
const { runPipeline } = await import(${JSON.stringify(join(import.meta.dir, 'core.ts'))})
await runPipeline(undefined, {})
`], {
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot },
      timeoutMs: 120_000,
    })
    expect(run.status, run.stderr).toBe(0)
    console.log(run.stdout)

    const state = JSON.parse(await readFile(statePath, 'utf8')).jobs as Record<string, any>
    const byName = (name: string) => Object.values(state).find(j => j.name === name)!
    const misjudged = byName('20261019164558.mp3')
    expect(misjudged).toMatchObject({ state: 'done', code: null })
    expect(existsSync(misjudged.paths.notes)).toBe(true)

    // "Ignoring" is gone as a feature, so the recording an older build had set
    // aside is processed like any other.
    const previouslyIgnored = byName('20260922120457.mp3')
    expect(previouslyIgnored).toMatchObject({ state: 'done', code: null })
    expect(existsSync(previouslyIgnored.paths.notes)).toBe(true)

    // Untouched: a file the service really cannot read, and two accidental presses.
    expect(byName('20260922123420.mp3')).toMatchObject({ state: 'filtered', code: 'bad_audio' })
    expect(byName('20261019170635.mp3')).toMatchObject({ state: 'filtered', code: 'too_small' })
    expect(byName('20260922153708.mp3')).toMatchObject({ state: 'filtered', code: 'too_short' })

    // Exactly two recordings reached the service, and two notes were written.
    expect((await readFile(asrLog, 'utf8')).trim().split('\n')).toEqual(['submit', 'query', 'submit', 'query'])
    expect(fake.requests).toHaveLength(2)
    expect(fake.requests[0]!.user).toContain('hello')
  } finally {
    await fake.stop()
    await rm(home, { recursive: true, force: true })
  }
}, 180_000)

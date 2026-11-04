import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runAsync, startFakeModel } from './testing/fakeModel.ts'

test('targeted retries and mixed batches preserve unrelated jobs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-retry-recovery-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const workspace = join(home, 'notes')
  const fake = await startFakeModel(join(configDir, 'pi-agent'))
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot }
  try {
    await mkdir(join(workspace, '_state'), { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ VOICENOTE_WORKSPACE: workspace, VOICENOTE_RECORD_DIR: join(home, 'recorder'), VOICENOTE_PI_MODEL: fake.modelRef, VOICENOTE_PI_SUMMARY_TOOLS: '', VOICENOTE_FFPROBE_BIN: process.execPath }))
    const jobs: Record<string, any> = {}
    for (const id of ['first', 'second', 'needs-asr', 'missing']) {
      const transcript = join(workspace, `${id}-transcript.md`)
      const audio = join(workspace, `${id}.mp3`)
      if (id === 'first' || id === 'second') await writeFile(transcript, `# Transcript\n\n## Raw transcript (no lossy cleanup)\n\n${id} meeting\n`)
      if (id === 'needs-asr') await writeFile(audio, 'audio')
      jobs[id] = { name: `${id}.mp3`, source_path: join(home, 'recorder', `${id}.mp3`), recorded_at: '2020-01-01T10:00:00', size_bytes: 1000, duration_seconds: 120, state: id === 'missing' ? 'error' : 'queued', code: id === 'missing' ? 'transcribe_failed' : null, detail: id === 'missing' ? 'old error' : null, attempts: 1, updated_at: '2020-01-01T10:00:00Z', title: null, paths: { audio, transcript } }
    }
    const statePath = join(workspace, '_state/jobs.json')
    await writeFile(statePath, JSON.stringify({ version: 2, jobs }))
    const run = (script: string) => runAsync(process.execPath, ['--input-type=module', '-e', script], { env })
    const target = await run("const {runPipeline}=await import('./src/core.ts'); await runPipeline(undefined,{jobId:'first'})")
    expect(target.status, target.stderr).toBe(0)
    let state = JSON.parse(await readFile(statePath, 'utf8')).jobs
    expect(state.first.state).toBe('done')
    expect(state.second.state).toBe('queued')
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]!.user).toContain('first meeting')

    const batch = await run("const {runPipeline}=await import('./src/core.ts'); await runPipeline(undefined,{})")
    expect(batch.status, batch.stderr).toBe(0)
    expect(batch.stderr).toContain('ASR not configured')
    state = JSON.parse(await readFile(statePath, 'utf8')).jobs
    expect(state.second.state).toBe('done')
    expect(state['needs-asr'].state).toBe('queued')
    expect(fake.requests).toHaveLength(2)

    const missing = await run("const {retryRecording}=await import('./src/core.ts'); await retryRecording('missing')")
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('Reconnect the recorder')
    state = JSON.parse(await readFile(statePath, 'utf8')).jobs
    expect(state.missing.state).toBe('error')
    expect(state.missing.detail).toBe('old error')
  } finally {
    await fake.stop()
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

test('a live lock reports that the run did not start', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-retry-lock-'))
  const stateDir = join(home, process.platform === 'win32' ? 'voicenote' : '.local/state/voicenote')
  try {
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'run.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() }))
    const run = await runAsync(process.execPath, ['--input-type=module', '-e', "const {runPipeline}=await import('./src/core.ts'); await runPipeline(undefined,{})"], { env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot } })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('Another VoiceNote process is running')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

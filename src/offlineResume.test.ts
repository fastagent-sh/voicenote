import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startFakeModel, runAsync } from './testing/fakeModel.ts'

test('offline resume preserves recorder provenance through output renames and a second run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-offline-resume-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const workspace = join(home, 'notes')
  const agentDir = join(configDir, 'pi-agent')
  const fake = await startFakeModel(agentDir)
  try {
    await mkdir(join(workspace, '_state'), { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      VOICENOTE_WORKSPACE: workspace,
      VOICENOTE_RECORD_DIR: join(home, 'unmounted-recorder'),
      VOICENOTE_PI_MODEL: fake.modelRef,
      VOICENOTE_FFPROBE_BIN: process.execPath,
      VOICENOTE_MAX_AGE_HOURS: '1',
    }))
    const jobs: Record<string, any> = {}
    for (const [id, withAudio] of [['audio-job', true], ['transcript-only-job', false]] as const) {
      const source = join(home, 'unmounted-recorder', `${id}.mp3`)
      const base = join(workspace, id)
      const paths = { audio: `${base}.mp3`, transcript: `${base}.md`, notes: `${base}-notes.md`, metadata: `${base}.json` }
      if (withAudio) await writeFile(paths.audio, 'original audio bytes')
      await writeFile(paths.transcript, '# Transcript\n\n## Raw transcript (no lossy cleanup)\n\nhello world\n')
      jobs[id] = { name: `${id}.mp3`, source_path: source, content_hash: id, recorded_at: withAudio ? '2020-01-01T10:00:00' : '2020-01-02T10:00:00',
        size_bytes: 0, duration_seconds: 0, state: 'queued', attempts: 0, code: null, detail: null,
        title: 'Old title', paths, updated_at: '2020-01-01T10:00:00Z' }
    }
    const statePath = join(workspace, '_state/jobs.json')
    await writeFile(statePath, JSON.stringify({ version: 2, jobs }))
    const run = () => runAsync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'run'], {
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot },
    })
    expect((await run()).status).toBe(0)
    let state = JSON.parse(await readFile(statePath, 'utf8'))
    for (const id of Object.keys(jobs)) {
      const job = state.jobs[id]
      expect(job.state).toBe('done')
      expect(job.source_path).toBe(jobs[id].source_path)
      const meta = JSON.parse(await readFile(job.paths.metadata, 'utf8'))
      expect(meta.source_audio_path).toBe(jobs[id].source_path)
    }
    expect(await readFile(state.jobs['audio-job'].paths.audio, 'utf8')).toBe('original audio bytes')
    expect(existsSync(state.jobs['transcript-only-job'].paths.audio)).toBe(false)
    expect(fake.requests).toHaveLength(2)
    state.jobs['audio-job'].state = 'queued'
    await writeFile(statePath, JSON.stringify(state))
    expect((await run()).status).toBe(0)
    state = JSON.parse(await readFile(statePath, 'utf8'))
    expect(state.jobs['audio-job'].source_path).toBe(jobs['audio-job'].source_path)
    expect(state.jobs['audio-job'].state).toBe('done')
    expect(await readFile(state.jobs['audio-job'].paths.audio, 'utf8')).toBe('original audio bytes')
    expect(fake.requests).toHaveLength(3)
  } finally {
    await fake.stop()
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

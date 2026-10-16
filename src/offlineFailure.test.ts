import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { removeImportedSource } from './core.ts'
import { runAsync, startFakeModel } from './testing/fakeModel.ts'

for (const artifact of ['transcript', 'audio'] as const) {
  test(`offline ${artifact} recovery keeps the failed job and allows a later retry`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'vn-offline-failure-'))
    const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
    const workspace = join(home, 'notes')
    const fake = await startFakeModel(join(configDir, 'pi-agent'))
    try {
      for (const dir of ['_state', '_audio/2020-01', '_transcripts/2020-01']) await mkdir(join(workspace, dir), { recursive: true })
      await writeFile(join(configDir, 'config.json'), JSON.stringify({
        VOICENOTE_WORKSPACE: workspace, VOICENOTE_RECORD_DIR: join(home, 'missing-recorder'),
        VOICENOTE_PI_MODEL: fake.modelRef, VOLCANO_ASR_KEY: 'test-asr-key', VOICENOTE_FFPROBE_BIN: process.execPath,
      }))
      const source = join(home, 'missing-recorder', '20200101100000.mp3')
      const audio = join(workspace, '_audio/2020-01/2020-01-01-10-00-original.mp3')
      const transcript = join(workspace, '_transcripts/2020-01/2020-01-01-10-00-transcript.md')
      const original = artifact === 'audio' ? 'saved-audio-bytes' : '# Incomplete transcript'
      await writeFile(artifact === 'audio' ? audio : transcript, original)
      const statePath = join(workspace, '_state/jobs.json')
      await writeFile(statePath, JSON.stringify({ version: 2, jobs: { recovered: {
        name: '20200101100000.mp3', source_path: source, recorded_at: '2020-01-01T10:00:00',
        state: 'running', paths: null, title: null, attempts: 1, size_bytes: 1000000,
        duration_seconds: 120, updated_at: '2020-01-01T10:00:00Z',
      } } }))
      const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot }
      const failed = await runAsync(process.execPath, ['--input-type=module', '-e', `
globalThis.fetch = async () => { throw new Error('Simulated transcription network failure') }
const { runPipeline } = await import('./src/core.ts')
await runPipeline(undefined, {})
`], { env })
      expect(failed.status, failed.stderr).toBe(0)
      const job = JSON.parse(await readFile(statePath, 'utf8')).jobs.recovered
      expect(job).toBeDefined()
      expect(job.state).toBe('error')
      expect(job.attempts).toBe(1)
      expect(job.source_path).toBe(source)
      expect(job.paths[artifact]).toBe(artifact === 'audio' ? audio : transcript)
      expect(job.detail).toContain(artifact === 'audio' ? 'Simulated transcription network failure' : 'missing raw transcript marker')
      expect(await readFile(artifact === 'audio' ? audio : transcript, 'utf8')).toBe(original)
      expect(fake.requests).toHaveLength(0)

      await writeFile(transcript, '# Transcript\n\n## Raw transcript (no lossy cleanup)\n\nRecovered meeting\n')
      const retry = await runAsync(process.execPath, ['--input-type=module', '-e', `
const { retryRecording, runPipeline } = await import('./src/core.ts')
await retryRecording('recovered')
await runPipeline(undefined, {})
`], { env })
      expect(retry.status, retry.stderr).toBe(0)
      const completed = JSON.parse(await readFile(statePath, 'utf8')).jobs.recovered
      expect(completed.state).toBe('done')
      expect(completed.source_path).toBe(source)
      expect(fake.requests).toHaveLength(1)
      expect(await readFile(completed.paths.transcript, 'utf8')).toContain('Recovered meeting')
      if (artifact === 'audio') expect(await readFile(completed.paths.audio, 'utf8')).toBe(original)
    } finally {
      await fake.stop()
      await rm(home, { recursive: true, force: true })
    }
  }, 30_000)
}

test('removeImportedSource refuses to remove files in same-prefix peer directories', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-prefix-safety-'))
  const workspace = join(home, 'workspace')
  const backupDir = join(workspace, '_inbox_backup')
  await mkdir(backupDir, { recursive: true })
  const backupFile = join(backupDir, 'important.mp3')
  await writeFile(backupFile, 'keep me')
  try {
    const config = { workspace } as any
    await removeImportedSource(config, backupFile)
    expect(existsSync(backupFile)).toBe(true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

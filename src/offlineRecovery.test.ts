import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startFakeModel, runAsync } from './testing/fakeModel.ts'

for (const latest of [false, true]) {
  test(`offline recovery discovers default outputs and orders jobs (latest=${latest})`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'vn-recovery-'))
    const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
    const workspace = join(home, 'notes')
    const fake = await startFakeModel(join(configDir, 'pi-agent'))
    try {
      await mkdir(join(workspace, '_state'), { recursive: true })
      await writeFile(join(configDir, 'config.json'), JSON.stringify({
        VOICENOTE_WORKSPACE: workspace,
        VOICENOTE_RECORD_DIR: join(home, 'missing-recorder'),
        VOICENOTE_PI_MODEL: fake.modelRef,
        VOICENOTE_FFPROBE_BIN: process.execPath,
        VOICENOTE_MAX_AGE_HOURS: '1',
      }))
      const jobs: Record<string, any> = {}
      for (const year of ['2024', '2020']) {
        const transcriptDir = join(workspace, '_transcripts', `${year}-01`)
        await mkdir(transcriptDir, { recursive: true })
        await writeFile(join(transcriptDir, `${year}-01-01-10-00-transcript.md`), `# Transcript\n\n## Raw transcript (no lossy cleanup)\n\nmeeting-${year}\n`)
        jobs[`job-${year}`] = {
          name: `${year}0101100000.mp3`, source_path: join(home, 'missing-recorder', `${year}0101100000.mp3`),
          recorded_at: `${year}-01-01T10:00:00`, state: 'running', paths: null, title: null,
          attempts: 1, size_bytes: 1000000, duration_seconds: 120, updated_at: `${year}-01-01T10:00:00Z`,
        }
      }
      const statePath = join(workspace, '_state', 'jobs.json')
      await writeFile(statePath, JSON.stringify({version:2,jobs}))
      const run = await runAsync(process.execPath, ['src/cli.ts', 'run', ...(latest ? ['--latest'] : [])], {
        env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot },
      })
      expect(run.status, run.stderr).toBe(0)
      const saved = JSON.parse(await readFile(statePath, 'utf8')).jobs
      expect(saved['job-2024'].state).toBe('done')
      expect(saved['job-2020'].state).toBe(latest ? 'queued' : 'done')
      expect(fake.requests).toHaveLength(latest ? 1 : 2)
      expect(fake.requests[0]!.user).toContain(latest ? 'meeting-2024' : 'meeting-2020')
      for (const year of latest ? ['2024'] : ['2024', '2020']) {
        const id = `job-${year}`
        expect(saved[id].source_path).toBe(jobs[id].source_path)
        const metadata = JSON.parse(await readFile(saved[id].paths.metadata, 'utf8'))
        expect(metadata.source_audio_path).toBe(jobs[id].source_path)
      }
    } finally {
      await fake.stop()
      await rm(home, { recursive: true, force: true })
    }
  }, 30_000)
}

import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runAsync, startFakeModel } from './testing/fakeModel.ts'

// A failed summary leaves outputs under the untitled (timestamp) names; the
// retry that succeeds has to move ALL of them to the titled names and drop what
// the failed attempt left behind. The transcript and the audio used to be moved
// in two different places, so one of them kept getting orphaned.
test('a successful retry moves every output to its titled name', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-outputs-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const workspace = join(home, 'ws')
  const month = join(workspace, '2026-09')
  const audio = join(home, '20260908103805.mp3')
  const untitled = '2026-09-08-10-38'
  const titled = '2026-09-08-10-38-Fake-note'
  const fake = await startFakeModel(join(configDir, 'pi-agent'))
  try {
    await mkdir(configDir, { recursive: true })
    await mkdir(join(workspace, '_transcripts', '2026-09'), { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      VOICENOTE_FFPROBE_BIN: process.execPath,
      VOICENOTE_WORKSPACE: workspace,
      VOICENOTE_PI_MODEL: fake.modelRef,
      // The failing attempt below is deliberate; without this the run spends
      // its retry budget on a model that is never coming back.
      VOICENOTE_PI_RETRIES: '1',
    }))
    await writeFile(audio, 'audio')
    // Already-transcribed: the run resumes at the summary, no ASR is spent.
    await writeFile(join(workspace, '_transcripts', '2026-09', `${untitled}-transcript.md`),
      '# Transcript\n\n---\n\n## Raw transcript (no lossy cleanup)\n\nhello world\n')

    const run = () => runAsync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'run', audio], {
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot },
      timeoutMs: 60_000,
    })

    fake.reply = null
    expect((await run()).stdout).toContain('Stub notes')
    expect(existsSync(join(month, `${untitled}-note.md`))).toBe(true)

    fake.reply = JSON.stringify({ title: 'Fake note', markdown: '# Fake note' })
    expect((await run()).stdout).toContain('✓ Completed')

    for (const [dir, name] of [
      [month, `${titled}.md`],
      [join(workspace, '_transcripts', '2026-09'), `${titled}-transcript.md`],
      [join(workspace, '_metadata', '2026-09'), `${titled}-metadata.json`],
      [join(workspace, '_audio', '2026-09'), `${titled}-original.mp3`],
    ] as const) {
      expect(await readdir(dir)).toEqual([name])
    }
  } finally {
    await fake.stop()
    await rm(home, { recursive: true, force: true })
  }
}, 120_000)

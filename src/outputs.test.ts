import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

    fake.reply = '# Fake note\n\nNotes'
    expect((await run()).stdout).toContain('✓ Completed')

    for (const [dir, name] of [
      [month, `${titled}.md`],
      [join(workspace, '_transcripts', '2026-09'), `${titled}-transcript.md`],
      [join(workspace, '_metadata', '2026-09'), `${titled}-metadata.json`],
      [join(workspace, '_audio', '2026-09'), `${titled}-original.mp3`],
    ] as const) {
      expect(await readdir(dir)).toEqual([name])
    }

    const note = join(month, `${titled}.md`)
    const original = await readFile(note, 'utf8')
    const state = JSON.parse(await readFile(join(workspace, '_state/jobs.json'), 'utf8'))
    const id = Object.keys(state.jobs)[0]!
    const regen = await runAsync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'regenerate', id], {
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot },
    })
    expect(regen.status).toBe(0)
    fake.reply = 'invalid response without a title'
    const failed = await run()
    expect(failed.stdout).toContain('Existing notes preserved')
    expect(await readFile(note, 'utf8')).toBe(original)
    const paths = [...original.matchAll(/- (?:Original audio|Full transcript): `([^`]+)`/g)].map(m => m[1]!)
    expect(paths).toHaveLength(2)
    expect(paths.every(existsSync)).toBe(true)

    const nextNote = join(month, '2026-09-08-10-38-New-note.md')
    await writeFile(nextNote, 'unrelated note')
    fake.reply = '# New note\n\nNew content'
    const collision = await run()
    expect(collision.stderr).toContain('destination already exists')
    expect(await readFile(nextNote, 'utf8')).toBe('unrelated note')
    expect(await readFile(note, 'utf8')).toBe(original)
    expect(paths.every(existsSync)).toBe(true)

    await rm(nextNote)
    expect((await run()).stdout).toContain('✓ Completed')
    expect(existsSync(note)).toBe(false)
    const updated = await readFile(nextNote, 'utf8')
    expect(updated).toContain('New content')
    expect(paths.every(existsSync)).toBe(true)
    for (const path of paths) expect(updated).toContain(path)
    expect((await readdir(month)).filter(name => name.endsWith('.md'))).toEqual(['2026-09-08-10-38-New-note.md'])

    const sameTitle = await runAsync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'regenerate', id], {
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot },
    })
    expect(sameTitle.status).toBe(0)
    fake.reply = '# New note\n\nReplacement content'
    expect((await run()).stdout).toContain('✓ Completed')
    expect(await readFile(nextNote, 'utf8')).toContain('Replacement content')
    expect(paths.every(existsSync)).toBe(true)
    expect((await readdir(month)).filter(name => name.endsWith('.md'))).toEqual(['2026-09-08-10-38-New-note.md'])
  } finally {
    await fake.stop()
    await rm(home, { recursive: true, force: true })
  }
}, 120_000)

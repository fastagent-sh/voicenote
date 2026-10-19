import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The recorder list's reprocess button runs a file with --force, which is what
 * makes an earlier verdict reversible: a recording set aside as unusable audio
 * (or already processed) runs again. Without it the cheap path stays cheap — a
 * plain `vn run <file>` still reuses a saved transcript.
 */
test('--force overrides an earlier verdict for a named file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-reprocess-'))
  const workspace = join(home, 'workspace')
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const source = join(home, 'recorder', '20260101100000.mp3')
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    VOICENOTE_WORKSPACE: workspace,
    VOICENOTE_RECORD_DIR: dirname(source),
    VOLCANO_ASR_KEY: 'test-asr-key',
    VOICENOTE_FFPROBE_BIN: join(home, 'missing-ffprobe'),
  }
  const run = (args: string[]) =>
    spawnSync(process.execPath, [join(import.meta.dir, 'cli.ts'), ...args], { env, encoding: 'utf8', timeout: 20_000 })

  try {
    await mkdir(join(workspace, '_state'), { recursive: true })
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      VOICENOTE_WORKSPACE: workspace,
      VOICENOTE_RECORD_DIR: dirname(source),
      VOLCANO_ASR_KEY: 'test-asr-key',
      VOICENOTE_FFPROBE_BIN: join(home, 'missing-ffprobe'),
    }))
    const bytes = 'not really an mp3'
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, bytes)
    const recorded = new Date('2026-01-01T10:00:00Z')
    await utimes(source, recorded, recorded)
    const st = await stat(source)
    const digest = createHash('sha256').update(bytes).digest('hex')
    // Same derivation as sourceIdFor(): path, size, mtime, content.
    const id = createHash('sha256').update(`${source}|${st.size}|${Math.floor(st.mtimeMs / 1000)}|${digest}`).digest('hex')
    const record = (patch: Record<string, unknown>) => ({
      name: '20260101100000.mp3', source_path: source, content_hash: digest,
      recorded_at: '2026-01-01T10:00:00', size_bytes: st.size, duration_seconds: null,
      state: 'filtered', code: null, detail: null, attempts: 0,
      updated_at: '2026-01-01T10:00:00', title: null, paths: null, ...patch,
    })
    const stateWith = async (patch: Record<string, unknown>) =>
      writeFile(join(workspace, '_state/jobs.json'), JSON.stringify({ version: 2, jobs: { [id]: record(patch) } }))

    // ASR refused this file and it was set aside; the user disagrees.
    await stateWith({ code: 'bad_audio', detail: 'Volcano: 45000151 audio format not supported' })
    const plain = run(['run', source, '--dry-run', '--verbose'])
    expect(plain.status, plain.stderr).toBe(0)
    expect(plain.stdout).not.toContain(`"source_id": "${id}"`)
    const badAudio = run(['run', source, '--dry-run', '--verbose', '--force'])
    expect(badAudio.status, badAudio.stderr).toBe(0)
    expect(badAudio.stdout).toContain(`"source_id": "${id}"`)

    // Already processed, and the user asked for it again.
    await stateWith({ state: 'done', paths: { notes: join(workspace, 'note.md') } })
    const done = run(['run', source, '--dry-run', '--verbose', '--force'])
    expect(done.status, done.stderr).toBe(0)
    expect(done.stdout).toContain(`"source_id": "${id}"`)

    // An older build could set a recording aside for good; that verdict no
    // longer exists, so nothing needs forcing to run it again.
    await stateWith({ code: 'ignored' })
    const stale = run(['run', source, '--dry-run', '--verbose'])
    expect(stale.status, stale.stderr).toBe(0)
    expect(stale.stdout).toContain(`"source_id": "${id}"`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)

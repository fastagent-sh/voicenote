import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

test('manual imports are durable, ignore scan age limits, and deduplicate by content', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-import-'))
  const workspace = join(home, 'workspace')
  const source = join(home, '20200101010101.mp3')
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    VOICENOTE_WORKSPACE: workspace,
    VOICENOTE_RECORD_DIR: join(home, 'missing-recorder'),
    VOICENOTE_FFPROBE_BIN: join(home, 'missing-ffprobe'),
  }
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'cli.ts'), ...args], { env, encoding: 'utf8', timeout: 20_000 })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    return result.stdout
  }

  try {
    await writeFile(source, 'fake mp3')
    const imported = JSON.parse(run(['import', source, '--json']))
    expect(imported).toMatchObject({ status: 'queued', name: '20200101010101.mp3' })
    const inboxFile = join(workspace, '_inbox', imported.id.slice('import:'.length), '20200101010101.mp3')
    expect(await readFile(inboxFile, 'utf8')).toBe('fake mp3')
    const renamedSource = join(home, 'same-audio-new-name.mp3')
    await writeFile(renamedSource, 'fake mp3')
    const pendingDuplicate = JSON.parse(run(['import', renamedSource, '--json']))
    expect(pendingDuplicate).toMatchObject({ status: 'queued', id: imported.id })
    expect(await readdir(dirname(inboxFile))).toEqual(['20200101010101.mp3'])

    // 2020 is far outside the automatic 48-hour window, and the recorder is
    // absent. A manual inbox item must still appear in the runnable plan.
    const plan = run(['run', '--dry-run'])
    expect(plan).toContain(`"source_id": "${imported.id}"`)
    expect(plan).not.toContain('too_old')

    await mkdir(join(workspace, '_state'), { recursive: true })
    await writeFile(join(workspace, '_state', 'jobs.json'), JSON.stringify({
      version: 2,
      jobs: {
        'recorder-job': {
          name: '20200101010101.mp3', source_path: '/recorder/20200101010101.mp3',
          content_hash: imported.id.slice('import:'.length), recorded_at: '2020-01-01T01:01:01',
          size_bytes: 8, duration_seconds: null, state: 'done', code: null, detail: null,
          attempts: 0, updated_at: '2020-01-01T01:01:01', title: 'Existing note',
          paths: { notes: join(workspace, 'existing.md') },
        },
      },
    }))

    // A completed recorder job may appear after the file entered the inbox.
    // The run-time check closes that race before any ASR call.
    expect(run(['run', '--verbose'])).toContain('already_done')
    expect(await readFile(inboxFile, 'utf8').catch(() => null)).toBeNull()

    const duplicate = JSON.parse(run(['import', source, '--json']))
    expect(duplicate).toMatchObject({ status: 'already_done', id: 'recorder-job', title: 'Existing note' })
    expect(await readFile(inboxFile, 'utf8').catch(() => null)).toBeNull()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAsync } from './testing/fakeModel.ts'

// Identifying a recording means hashing the whole file; a recorder holding a
// gigabyte of audio made every scan (the 60s tick, the file browser, each
// run) pay minutes for answers that had not changed. The cache must not
// change the ids those answers produce, or every recording looks new.
test.skipIf(process.platform === 'win32')('the scan cache keeps ids stable and is reused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-scan-'))
  const configDir = join(home, '.config/voicenote')
  const workspace = join(home, 'ws')
  const recordDir = join(home, 'RECORD')
  try {
    await mkdir(configDir, { recursive: true })
    await mkdir(recordDir, { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      VOICENOTE_WORKSPACE: workspace,
      VOICENOTE_RECORD_DIR: recordDir,
      VOICENOTE_FFPROBE_BIN: process.execPath,
    }))
    await writeFile(join(recordDir, '20260101120000.mp3'), 'x'.repeat(200_000))

    const scan = () => runAsync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'run', '--dry-run'], {
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: process.env.PATH ?? '' },
      timeoutMs: 30_000,
    })

    const first = await scan()
    expect(first.stdout).toContain('found=1')
    const cache = JSON.parse(await Bun.file(join(workspace, '_state', 'scan-cache.json')).text())
    const entry = Object.values(cache.entries)[0] as { hash: string; size: number }
    expect(entry.size).toBe(200_000)
    expect(entry.hash).toHaveLength(64)

    // Second scan: same verdicts, so the cached hash produced the same id.
    const second = await scan()
    expect(second.stdout).toContain('found=1')

    // A changed file must be re-read, not served from the cache.
    await writeFile(join(recordDir, '20260101120000.mp3'), 'y'.repeat(300_000))
    await utimes(join(recordDir, '20260101120000.mp3'), new Date(), new Date())
    await scan()
    const updated = JSON.parse(await Bun.file(join(workspace, '_state', 'scan-cache.json')).text())
    const updatedEntry = Object.values(updated.entries)[0] as { hash: string; size: number }
    expect(updatedEntry.size).toBe(300_000)
    expect(updatedEntry.hash).not.toBe(entry.hash)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)

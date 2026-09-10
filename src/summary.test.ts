import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { Glob } from 'bun'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Notes are written by pi under pi's own provider/model configuration: voicenote
// must never pass --provider/--model, and must never retry on another provider.
test('the summary invokes pi with no provider/model override', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-summary-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const workspace = join(home, 'ws')
  const fakePi = join(home, 'pi.ts')
  try {
    await mkdir(configDir, { recursive: true })
    await mkdir(join(workspace, '_transcripts', '2026-09'), { recursive: true })
    await writeFile(fakePi, `
      const a = process.argv
      if (a.includes('--version')) console.log('fake-pi')
      else if (a.includes('--provider') || a.includes('--model')) { console.error('voicenote must not override pi model config'); process.exit(1) }
      else console.log(JSON.stringify({ title: 'Fake note', summary: 'ok' }))
    `)
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      VOICENOTE_PI_BIN: process.execPath,
      VOICENOTE_PI_CLI: fakePi,
      VOICENOTE_FFPROBE_BIN: process.execPath,
      VOICENOTE_WORKSPACE: workspace,
    }))
    // A transcript already on disk is what lets `run` reach the summary stage
    // without spending ASR — same path a retry after a failed summary takes.
    const audio = join(home, '20260908103805.mp3')
    await writeFile(audio, 'audio')
    await writeFile(join(workspace, '_transcripts', '2026-09', '2026-09-08-10-38-transcript.md'),
      '# Transcript\n\n---\n\n## Raw transcript (no lossy cleanup)\n\nhello world\n')

    const run = spawnSync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'run', audio], {
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot },
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(run.status).toBe(0)
    expect(run.stdout).not.toContain('Stub notes')
    const metaFile = (await Array.fromAsync(new Glob('_metadata/**/*.json').scan({ cwd: workspace })))[0]
    const meta = JSON.parse(await readFile(join(workspace, metaFile!), 'utf8'))
    expect(meta.title).toBe('Fake note')
    expect(meta.llm_backend).toBe('pi')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

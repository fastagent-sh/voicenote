import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// The chain used to throw only its LAST error, so a fallback nobody signed into
// ("No API key found for openai") buried why the first provider really failed.
test('a failed summary reports every provider error, not just the chain\'s last', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-summary-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const workspace = join(home, 'ws')
  const fakePi = join(home, 'pi.ts')
  try {
    await mkdir(configDir, { recursive: true })
    await mkdir(join(workspace, '_transcripts', '2026-09'), { recursive: true })
    await writeFile(fakePi, `
      const a = process.argv
      const p = a[a.indexOf('--provider') + 1]
      if (a.includes('--version')) console.log('fake-pi')
      else if (a.includes('auth')) console.log(JSON.stringify({ status: 'ready', provider: p }))
      else { console.error(p === 'openai' ? 'No API key found for openai.' : 'Codex usage limit reached'); process.exit(1) }
    `)
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      VOICENOTE_PI_PROVIDER: 'openai-codex,openai',
      VOICENOTE_PI_BIN: process.execPath,
      VOICENOTE_PI_CLI: fakePi,
      VOICENOTE_FFPROBE_BIN: process.execPath,
      VOICENOTE_WORKSPACE: workspace,
      VOICENOTE_PI_RETRIES: '1',
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
    const stub = await readFile(join(workspace, '2026-09', '2026-09-08-10-38-note.md'), 'utf8')
    expect(stub).toContain('Codex usage limit reached')
    expect(stub).toContain('No API key found for openai.')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

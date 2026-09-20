import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { Glob } from 'bun'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Runs `vn run <audio>` against a fake pi, with a transcript already on disk so
// the run reaches the summary stage without spending ASR — the same path a retry
// after a failed summary takes. `expectModel` is what the fake pi demands to see
// as --model; it exits 1 (→ stub note) when the arguments disagree.
//
// The transcript is padded past the 64KB pipe buffer so the prompt write is
// still in flight when the fake pi exits: without runPi's stdin error handler
// the run dies on EPIPE instead of reading pi's output.
async function runWithFakePi(config: Record<string, string>, expectModel: string | null, expectProxy: string | null = null) {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-summary-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const workspace = join(home, 'ws')
  const fakePi = join(home, 'pi.ts')
  try {
    await mkdir(configDir, { recursive: true })
    await mkdir(join(workspace, '_transcripts', '2026-09'), { recursive: true })
    // A config path written as "$HOME/..." must reach pi expanded, or pi looks
    // for credentials in a literal "$HOME" directory and every summary fails.
    const expectAgentDir = config.PI_CODING_AGENT_DIR?.replace('$HOME', home) ?? null
    await writeFile(fakePi, `
      const a = process.argv
      const model = a.includes('--model') ? a[a.indexOf('--model') + 1] : null
      if (a.includes('--version')) console.log('fake-pi')
      else if (a.includes('--provider')) { console.error('voicenote must never pick a provider'); process.exit(1) }
      else if (model !== ${JSON.stringify(expectModel)}) { console.error('unexpected --model: ' + model); process.exit(1) }
      else if (${JSON.stringify(expectProxy)} && process.env.http_proxy !== ${JSON.stringify(expectProxy)}) { console.error('pi did not inherit http_proxy: ' + process.env.http_proxy); process.exit(1) }
      else if (${JSON.stringify(expectAgentDir)} && process.env.PI_CODING_AGENT_DIR !== ${JSON.stringify(expectAgentDir)}) { console.error('pi got an unexpanded config dir: ' + process.env.PI_CODING_AGENT_DIR); process.exit(1) }
      else console.log(JSON.stringify({ title: 'Fake note', summary: 'ok' }))
    `)
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      VOICENOTE_PI_BIN: process.execPath,
      VOICENOTE_PI_CLI: fakePi,
      VOICENOTE_FFPROBE_BIN: process.execPath,
      VOICENOTE_WORKSPACE: workspace,
      ...config,
    }))
    const audio = join(home, '20260908103805.mp3')
    await writeFile(audio, 'audio')
    await writeFile(join(workspace, '_transcripts', '2026-09', '2026-09-08-10-38-transcript.md'),
      `# Transcript\n\n---\n\n## Raw transcript (no lossy cleanup)\n\n${'hello world '.repeat(20_000)}\n`)

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
}

test('without VOICENOTE_PI_MODEL the summary leaves the model to pi', async () => {
  await runWithFakePi({}, null)
}, 30_000)

test('VOICENOTE_PI_MODEL is passed straight to pi as --model', async () => {
  await runWithFakePi({ VOICENOTE_PI_MODEL: 'openai-codex/gpt-5.6-sol' }, 'openai-codex/gpt-5.6-sol')
}, 30_000)

// Bun does not hand a child the http_proxy/no_proxy variables this process set on
// process.env, so pi must be spawned with them passed explicitly. Otherwise a run
// whose proxy comes from config.json (every scheduler run) reaches pi with no
// proxy and dies on `fetch failed`.
test('pi inherits the proxy derived from config, not just the real environment', async () => {
  await runWithFakePi({ LOCAL_PROXY_HOST: '127.0.0.1', LOCAL_PROXY_PORT: '7897' }, null, 'http://127.0.0.1:7897')
}, 30_000)

// vn expands `~`/`$HOME` in PI_CODING_AGENT_DIR for its own auth-path reporting;
// pi must get the same expanded value. It used to get the raw setting, so
// `vn doctor` reported credentials as present while every summary failed with
// "No API key found".
test('pi gets an expanded PI_CODING_AGENT_DIR, not the raw setting', async () => {
  await runWithFakePi({ PI_CODING_AGENT_DIR: '$HOME/.config/voicenote/pi-agent' }, null)
}, 30_000)

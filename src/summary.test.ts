import { expect, test } from 'bun:test'
import { Glob } from 'bun'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runAsync, startFakeModel } from './testing/fakeModel.ts'

// Runs `vn run <audio>` against a fake OpenAI-compatible model, with a
// transcript already on disk so the run reaches the summary stage without
// spending ASR — the same path a retry after a failed summary takes. The
// transcript is padded past 64KB because the prompt used to be piped to a child
// process; keeping it large also exercises a realistic request size.
async function runWithFakeModel(
  config: (agentDir: string) => Record<string, string>,
  opts: { agentDirIn?: (home: string) => string; pinModel?: boolean } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-summary-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const workspace = join(home, 'ws')
  const agentDir = (opts.agentDirIn ?? ((h: string) => join(h, '.pi', 'agent')))(home)
  const fake = await startFakeModel(agentDir)
  try {
    await mkdir(configDir, { recursive: true })
    await mkdir(join(workspace, '_transcripts', '2026-09'), { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      VOICENOTE_FFPROBE_BIN: process.execPath,
      VOICENOTE_WORKSPACE: workspace,
      ...(opts.pinModel === false ? {} : { VOICENOTE_PI_MODEL: fake.modelRef }),
      ...config(agentDir),
    }))
    const audio = join(home, '20260908103805.mp3')
    await writeFile(audio, 'audio')
    await writeFile(join(workspace, '_transcripts', '2026-09', '2026-09-08-10-38-transcript.md'),
      `# Transcript\n\n---\n\n## Raw transcript (no lossy cleanup)\n\n${'hello world '.repeat(20_000)}\n`)

    const run = await runAsync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'run', audio], {
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot },
      timeoutMs: 60_000,
    })
    expect(run.status).toBe(0)
    expect(run.stdout).not.toContain('Stub notes')
    const metaFile = (await Array.fromAsync(new Glob('_metadata/**/*.json').scan({ cwd: workspace })))[0]
    const meta = JSON.parse(await readFile(join(workspace, metaFile!), 'utf8'))
    expect(meta.title).toBe('Fake note')
    expect(meta.llm_backend).toBe('pi')
    return { fake, run }
  } finally {
    await fake.stop()
    await rm(home, { recursive: true, force: true })
  }
}

test('the configured model writes the notes, and gets the transcript as the prompt', async () => {
  const { fake } = await runWithFakeModel(() => ({}))
  expect(fake.requests).toHaveLength(1)
  expect(fake.requests[0]!.user).toContain('hello world')
}, 90_000)

// vn must never pick a provider: with no VOICENOTE_PI_MODEL, whatever pi has
// configured writes the notes (here the only configured model is the fake one).
test('without VOICENOTE_PI_MODEL the summary leaves the model to pi', async () => {
  await runWithFakeModel(() => ({}), { pinModel: false })
}, 90_000)

// vn expands `~`/`$HOME` in PI_CODING_AGENT_DIR for its own auth-path
// reporting; pi must be pointed at the same expanded directory. It used to get
// the raw setting, so `vn doctor` reported credentials as present while every
// summary failed with "No API key found" — here a literal "$HOME" directory
// would leave pi with no models.json and no way to reach the fake model.
test('pi is pointed at an expanded PI_CODING_AGENT_DIR, not the raw setting', async () => {
  await runWithFakeModel(() => ({ PI_CODING_AGENT_DIR: '$HOME/pi-agent' }), {
    agentDirIn: (home) => join(home, 'pi-agent'),
  })
}, 90_000)

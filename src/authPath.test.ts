import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Credentials must not default into pi's own ~/.pi/agent: that shares one
// ChatGPT account with the pi CLI, whose interactive session rewrites
// auth.json wholesale on exit and has dropped entries that way.
test.skipIf(process.platform === 'win32')('credentials default to a voicenote-owned directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-auth-'))
  try {
    await mkdir(join(home, '.config/voicenote'), { recursive: true })
    await writeFile(join(home, '.config/voicenote/config.json'), '{}')
    const run = (env: Record<string, string>) => {
      const result = spawnSync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'doctor', '--json'], {
        env: { HOME: home, PATH: dirname(process.execPath), ...env }, encoding: 'utf8', timeout: 30_000,
      })
      return JSON.parse(result.stdout)
    }

    expect(run({}).pi.authPath).toBe(join(home, '.config/voicenote/pi-agent/auth.json'))

    // Anyone who does want one shared login can still say so.
    expect(run({ PI_CODING_AGENT_DIR: '$HOME/.pi/agent' }).pi.authPath).toBe(join(home, '.pi/agent/auth.json'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)

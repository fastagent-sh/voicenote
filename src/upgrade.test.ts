import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// `npm i -g` reaches the registry through the proxy only if vn passes it: the
// proxy lives in config.json, not in the shell, so an upgrade used to hang or
// fail on networks that need one. The fake npm records what it was handed and
// fails, so nothing is actually installed.
test.skipIf(process.platform === 'win32')('vn upgrade runs npm with the configured proxy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voicenote-upgrade-'))
  const configDir = join(home, '.config/voicenote')
  const binDir = join(home, 'bin')
  const seen = join(home, 'seen-proxy.txt')
  try {
    await mkdir(configDir, { recursive: true })
    await mkdir(binDir, { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ LOCAL_PROXY_HOST: '127.0.0.1', LOCAL_PROXY_PORT: '7890' }))
    await writeFile(join(binDir, 'npm'), `#!/bin/sh\nprintf '%s' "$http_proxy" > "$VN_TEST_SEEN"\nexit 1\n`)
    await chmod(join(binDir, 'npm'), 0o755)

    const result = spawnSync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'upgrade'], {
      env: { HOME: home, PATH: `${binDir}:${dirname(process.execPath)}`, VN_TEST_SEEN: seen },
      encoding: 'utf8',
      timeout: 20_000,
    })

    expect(await readFile(seen, 'utf8')).toBe('http://127.0.0.1:7890')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Upgrade failed')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

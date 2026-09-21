import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// The version used to be read from a fixed `../package.json`. That path holds
// for a checkout and for the published CLI, and not for the desktop app,
// whose bundled main sits two levels down inside the asar — where it threw
// ENOENT before anything else ran and took the whole app down on launch.
test.skipIf(process.platform === 'win32')('the version is found from any bundle layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voicenote-version-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '9.9.9' }))
    // Mirror the desktop app: the code runs from out/main/, two levels below
    // the package.json.
    const nested = join(root, 'out', 'main')
    await mkdir(nested, { recursive: true })
    await cp(join(import.meta.dir, 'core.ts'), join(nested, 'core.ts'))
    for (const file of ['jobs.ts', 'runLock.ts', 'chatgptAuth.ts', 'piAgent.ts', 'progress.ts', 'summaryJson.ts']) {
      await cp(join(import.meta.dir, file), join(nested, file))
    }
    await writeFile(join(nested, 'probe.ts'), "import { VERSION } from './core.ts'\nconsole.log(VERSION)\n")

    const result = spawnSync(process.execPath, [join(nested, 'probe.ts')], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: root },
    })
    expect(result.stdout.trim()).toBe('9.9.9')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

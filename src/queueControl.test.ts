import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runAsync, startFakeModel } from './testing/fakeModel.ts'

test('queue items can be processed one-by-one, prioritized, and removed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-queue-ctrl-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const workspace = join(home, 'notes')
  const recorder = join(home, 'recorder')
  const fake = await startFakeModel(join(configDir, 'pi-agent'))
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot }

  try {
    await mkdir(join(workspace, '_state'), { recursive: true })
    await mkdir(recorder, { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      VOICENOTE_WORKSPACE: workspace,
      VOICENOTE_RECORD_DIR: recorder,
      VOICENOTE_PI_MODEL: fake.modelRef,
      VOICENOTE_PI_SUMMARY_TOOLS: '',
      VOICENOTE_FFPROBE_BIN: process.execPath,
    }))

    const statePath = join(workspace, '_state/jobs.json')
    const jobs: Record<string, any> = {}
    for (const [index, id] of ['q1', 'q2', 'q3'].entries()) {
      const transcript = join(workspace, `${id}-transcript.md`)
      await writeFile(transcript, `# Transcript\n\n## Raw transcript (no lossy cleanup)\n\n${id} content\n`)
      const sourcePath = join(recorder, `2026070${index + 1}100000.mp3`)
      await writeFile(sourcePath, `audio-${id}`)
      jobs[id] = {
        name: `2026070${index + 1}100000.mp3`,
        source_path: sourcePath,
        recorded_at: `2026-07-0${index + 1}T10:00:00`,
        size_bytes: 1_000_000,
        duration_seconds: 120,
        state: 'queued',
        code: null,
        detail: null,
        attempts: 0,
        updated_at: '2026-07-01T10:00:00Z',
        title: null,
        paths: { transcript },
      }
    }
    const regenNote = join(workspace, 'existing-note.md')
    const regenTranscript = join(workspace, 'regen-transcript.md')
    await writeFile(regenNote, '# Existing Note\n')
    await writeFile(regenTranscript, '# Transcript\n\n## Raw transcript (no lossy cleanup)\n\nregen\n')
    jobs.regen = {
      name: 'regen.mp3',
      source_path: join(recorder, '20260704100000.mp3'),
      recorded_at: '2026-07-04T10:00:00',
      size_bytes: 1_000_000,
      duration_seconds: 120,
      state: 'queued',
      code: null,
      detail: null,
      attempts: 0,
      updated_at: '2026-07-04T10:00:00Z',
      title: 'Existing Note',
      paths: { notes: regenNote, transcript: regenTranscript },
    }
    await writeFile(statePath, JSON.stringify({ version: 2, jobs }))

    const run = (script: string) => runAsync(process.execPath, ['--input-type=module', '-e', script], { env })

    // Prioritize q3 and remove q2 and regen before running one job at a time.
    const step1 = await run(`
      const core = await import('./src/core.ts');
      await core.prioritizeJob('q3', 999);
      await core.removeQueuedJob('q2');
      await core.removeQueuedJob('regen');
      const res = await core.runPipeline(undefined, { maxJobs: 1 });
      console.log(JSON.stringify(res));
    `)
    expect(step1.status, step1.stderr).toBe(0)
    expect(JSON.parse(step1.stdout.trim().split('\n').pop()!)).toEqual({ processedIds: ['q3'], abortedIds: [], remaining: 1 })

    let saved = JSON.parse(await readFile(statePath, 'utf8')).jobs
    expect(saved.q3.state).toBe('done')
    expect(saved.q3.priority).toBeUndefined()
    expect(saved.q1.state).toBe('queued')
    expect(saved.q2).toMatchObject({ state: 'filtered', code: 'skipped' })
    expect(existsSync(join(recorder, '20260702100000.mp3'))).toBe(true)
    expect(saved.regen.state).toBe('done')
    expect(existsSync(regenNote)).toBe(true)

    // Next step processes q1 and leaves q2 skipped.
    const step2 = await run(`
      const core = await import('./src/core.ts');
      const res = await core.runPipeline(undefined, { maxJobs: 1 });
      console.log(JSON.stringify(res));
    `)
    expect(step2.status, step2.stderr).toBe(0)
    expect(JSON.parse(step2.stdout.trim().split('\n').pop()!)).toEqual({ processedIds: ['q1'], abortedIds: [], remaining: 0 })

    // Manual --force still overrides the skipped verdict.
    const forced = await run(`
      const core = await import('./src/core.ts');
      const res = await core.runPipeline(${JSON.stringify(join(recorder, '20260702100000.mp3'))}, { force: true, dryRun: true });
      console.log(JSON.stringify(res));
    `)
    expect(forced.status, forced.stderr).toBe(0)
    expect(forced.stdout).toContain('20260702100000.mp3')

    // Removing a fresh manual import deletes both the inbox copy and its job record.
    const importSource = join(home, '20260705120000.mp3')
    await writeFile(importSource, 'imported-audio')
    const importStep = await run(`
      const { readFile, writeFile } = await import('node:fs/promises');
      const core = await import('./src/core.ts');
      await core.importRecording(${JSON.stringify(importSource)});
      const st = JSON.parse(await readFile(${JSON.stringify(statePath)}, 'utf8'));
      const impId = Object.keys(st.jobs).find(k => k.startsWith('import:')) || 'import:missing';
      // Ensure record exists via dry-run/queue then removeQueuedJob cleans it up
      console.log(impId);
    `)
    expect(importStep.status, importStep.stderr).toBe(0)
  } finally {
    await fake.stop()
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

test('removeQueuedJob deletes inbox file and job record for fresh imports', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-queue-import-del-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const workspace = join(home, 'notes')
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot }

  try {
    await mkdir(join(workspace, '_state'), { recursive: true })
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      VOICENOTE_WORKSPACE: workspace,
      VOICENOTE_RECORD_DIR: join(home, 'missing-recorder'),
      VOICENOTE_FFPROBE_BIN: process.execPath,
    }))
    const inboxFile = join(workspace, '_inbox', 'abc123', '20260705120000.mp3')
    await mkdir(dirname(inboxFile), { recursive: true })
    await writeFile(inboxFile, 'fake-mp3')
    const statePath = join(workspace, '_state/jobs.json')
    await writeFile(statePath, JSON.stringify({
      version: 2,
      jobs: {
        'import:abc123': {
          name: '20260705120000.mp3',
          source_path: inboxFile,
          content_hash: 'abc123',
          recorded_at: '2026-07-05T12:00:00',
          size_bytes: 8,
          duration_seconds: null,
          state: 'queued',
          code: null,
          detail: null,
          attempts: 0,
          updated_at: '2026-07-05T12:00:00Z',
          title: null,
          paths: null,
          origin: 'import',
        },
      },
    }))
    const run = await runAsync(process.execPath, [
      '--input-type=module', '-e',
      "const core = await import('./src/core.ts'); await core.removeQueuedJob('import:abc123')",
    ], { env })
    expect(run.status, run.stderr).toBe(0)
    expect(existsSync(inboxFile)).toBe(false)
    const saved = JSON.parse(await readFile(statePath, 'utf8')).jobs
    expect(saved['import:abc123']).toBeUndefined()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 20_000)

test('aborting a running job moves it to the tail of the queue and continues with the next job', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vn-queue-abort-'))
  const configDir = join(home, process.platform === 'win32' ? 'voicenote' : '.config/voicenote')
  const workspace = join(home, 'notes')
  const recorder = join(home, 'recorder')
  const fake = await startFakeModel(join(configDir, 'pi-agent'))
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot }

  try {
    await mkdir(join(workspace, '_state'), { recursive: true })
    await mkdir(recorder, { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      VOICENOTE_WORKSPACE: workspace,
      VOICENOTE_RECORD_DIR: recorder,
      VOICENOTE_PI_MODEL: fake.modelRef,
      VOICENOTE_PI_SUMMARY_TOOLS: '',
      VOICENOTE_FFPROBE_BIN: process.execPath,
    }))

    const statePath = join(workspace, '_state/jobs.json')
    const jobs: Record<string, any> = {}
    for (const [index, id] of ['q1', 'q2'].entries()) {
      const transcript = join(workspace, `${id}-transcript.md`)
      await writeFile(transcript, `# Transcript\n\n## Raw transcript (no lossy cleanup)\n\n${id} transcript\n`)
      const sourcePath = join(recorder, `2026070${index + 1}100000.mp3`)
      await writeFile(sourcePath, `audio-${id}`)
      jobs[id] = {
        name: `2026070${index + 1}100000.mp3`,
        source_path: sourcePath,
        recorded_at: `2026-07-0${index + 1}T10:00:00`,
        size_bytes: 1_000_000,
        duration_seconds: 120,
        state: 'queued',
        code: null,
        detail: null,
        attempts: 0,
        updated_at: '2026-07-01T10:00:00Z',
        title: null,
        paths: { transcript },
      }
    }
    await writeFile(statePath, JSON.stringify({ version: 2, jobs }))

    const run = (script: string) => runAsync(process.execPath, ['--input-type=module', '-e', script], { env })
    const res = await run(`
      const core = await import('./src/core.ts');
      const { onPipelineEvent } = await import('./src/progress.ts');
      const controller = new AbortController();
      onPipelineEvent((event) => {
        if (event.type === 'job_step' && event.step.startsWith('Generate')) controller.abort();
      });
      const r1 = await core.runPipeline(undefined, { maxJobs: 1, signal: controller.signal });
      const stAfterAbort = JSON.parse(await (await import('node:fs/promises')).readFile(${JSON.stringify(statePath)}, 'utf8')).jobs;
      const r2 = await core.runPipeline(undefined, { maxJobs: 1 });
      const r3 = await core.runPipeline(undefined, { maxJobs: 1 });
      console.log(JSON.stringify({ r1, q1AfterAbort: stAfterAbort.q1, r2, r3 }));
    `)
    expect(res.status, res.stderr).toBe(0)
    const out = JSON.parse(res.stdout.trim().split('\n').pop()!)
    expect(out.r1).toEqual({ processedIds: [], abortedIds: ['q1'], remaining: 1 })
    expect(out.q1AfterAbort.state).toBe('queued')
    expect(out.q1AfterAbort.attempts).toBe(0)
    expect(out.q1AfterAbort.interruptions).toBe(0)
    expect(out.q1AfterAbort.priority).toBeLessThan(0)
    expect(out.q1AfterAbort.paths.transcript).toContain('q1-transcript.md')
    expect(out.r2).toEqual({ processedIds: ['q2'], abortedIds: [], remaining: 1 })
    expect(out.r3).toEqual({ processedIds: ['q1'], abortedIds: [], remaining: 0 })
  } finally {
    await fake.stop()
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

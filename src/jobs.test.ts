import { expect, test } from 'bun:test'
import { applyOutcome, buildJobsView, classify, emptyState, MAX_ATTEMPTS, MAX_INTERRUPTIONS, migrateLegacyState, parseJobsLimit, parseStateFile, patchJob, pruneUnseen, reconcileInterrupted, requeueFailed, startAttempt, type JobRecord, type StateFile } from './jobs.ts'

const rec = (over: Partial<JobRecord> & { name: string; recorded_at: string; state: JobRecord['state'] }): JobRecord => ({
  source_path: `/Volumes/VTR6500/RECORD/A/${over.name}`,
  size_bytes: 1_000_000, duration_seconds: 600, code: null, detail: null,
  attempts: 0, updated_at: '', title: null, paths: null, ...over,
})

const state = (jobs: Record<string, JobRecord>): StateFile => ({ ...emptyState(), jobs })
const view = (s: StateFile, current: any = null, limit = 10, alive: () => boolean = () => true) =>
  buildJobsView(s, current, { limit, alive, recorderPresent: true })

// ── view ────────────────────────────────────────────────────────────────────

test('a running row needs BOTH a live pid and a `running` record', () => {
  const running = state({ a: rec({ name: 'a.mp3', recorded_at: '2026-07-29T12:00:00', state: 'running' }) })
  const current = { pid: 999, source_id: 'a', step: 'transcribing', started_at: '' }

  expect(view(running, current).items[0]).toMatchObject({ id: 'a', status: 'running', step: 'transcribing' })

  // Dead pid — the case that used to wedge at "Processing" forever because
  // liveness was inferred from log text.
  expect(view(running, current, 10, () => false).items[0]).toMatchObject({ status: 'queued', step: null })
  expect(view(running, null).items[0]!.status).toBe('queued')

  // Live pid but the record already finished: current.json outlives a kill -9,
  // so a recycled pid must not resurrect a done job.
  const done = state({ a: rec({ name: 'a.mp3', recorded_at: '2026-07-29T12:00:00', state: 'done' }) })
  expect(view(done, current).items[0]!.status).toBe('done')
})

test('filtered records fold into a single counted row, ranked above finished notes', () => {
  const s = state({
    a: rec({ name: 'a.mp3', recorded_at: '2026-07-01T10:00:00', state: 'filtered', code: 'too_small' }),
    b: rec({ name: 'b.mp3', recorded_at: '2026-07-02T10:00:00', state: 'filtered', code: 'too_small' }),
    c: rec({ name: 'c.mp3', recorded_at: '2026-07-03T10:00:00', state: 'filtered', code: 'too_short' }),
    old: rec({ name: 'old.mp3', recorded_at: '2026-06-03T10:00:00', state: 'filtered', code: 'too_old' }),
    d: rec({ name: 'd.mp3', recorded_at: '2026-07-04T10:00:00', state: 'done' }),
  })
  const { items, total } = view(s)
  expect(items).toHaveLength(2)
  expect(total).toBe(2)
  expect(items[0]).toMatchObject({ status: 'filtered', name: '4 recordings filtered out', detail: 'too small ×2, too short ×1, too old ×1', history_filtered: true })
  expect(items[1]).toMatchObject({ status: 'done', name: 'd.mp3' })
})

test('queue is oldest-first (pipeline order), history newest-first', () => {
  const s = state({
    q1: rec({ name: 'q1.mp3', recorded_at: '2026-07-02T10:00:00', state: 'queued' }),
    q2: rec({ name: 'q2.mp3', recorded_at: '2026-07-01T10:00:00', state: 'queued' }),
    d1: rec({ name: 'd1.mp3', recorded_at: '2026-06-01T10:00:00', state: 'done' }),
    d2: rec({ name: 'd2.mp3', recorded_at: '2026-06-02T10:00:00', state: 'done' }),
  })
  const { items } = view(s)
  expect(items.map(i => i.name)).toEqual(['q2.mp3', 'q1.mp3', 'd2.mp3', 'd1.mp3'])
  expect(items[0]!.time).toBe('2026-07-01 10:00')  // display key == sort key
})

test('truncation follows priority order and reports the true total', () => {
  const jobs: Record<string, JobRecord> = {
    q: rec({ name: 'q.mp3', recorded_at: '2026-07-09T10:00:00', state: 'queued' }),
    e: rec({ name: 'e.mp3', recorded_at: '2026-07-08T10:00:00', state: 'error', detail: 'boom' }),
  }
  for (let i = 0; i < 20; i++) jobs[`d${i}`] = rec({ name: `d${i}.mp3`, recorded_at: `2026-06-${String(i + 1).padStart(2, '0')}T10:00:00`, state: 'done' })

  const { items, total } = view(state(jobs), null, 5)
  expect(total).toBe(22)
  expect(items.map(i => i.status)).toEqual(['queued', 'error', 'done', 'done', 'done'])
  expect(items[1]!.detail).toBe('boom')
})

test('limit bounds every section, including failures', () => {
  // One bad credential fails every recording MAX_ATTEMPTS times. `attention` was
  // exempt from the cap, so this rendered an unbounded list while `total`
  // claimed it was complete.
  const jobs: Record<string, JobRecord> = {}
  for (let i = 0; i < 50; i++) jobs[`e${i}`] = rec({ name: `e${i}.mp3`, recorded_at: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T10:00:00`, state: 'gave_up' })

  const { items, total } = view(state(jobs), null, 10)
  expect(items).toHaveLength(10)
  expect(total).toBe(50)
})

test('queued_total counts the whole backlog, not the visible page', () => {
  const jobs: Record<string, JobRecord> = {}
  for (let i = 0; i < 12; i++) jobs[`q${i}`] = rec({ name: `q${i}.mp3`, recorded_at: `2026-07-${String(i + 1).padStart(2, '0')}T10:00:00`, state: 'queued' })

  const { items, queued_total, total } = view(state(jobs), null, 5)
  expect(items).toHaveLength(5)
  // "N recordings waiting for it" must not be counted off the truncated page —
  // it would contradict the "… X more" line printed directly above it.
  expect(queued_total).toBe(12)
  expect(total).toBe(12)
})

test('local imports do not claim to be waiting for a disconnected recorder', () => {
  const jobs = state({
    recorder: rec({ name: 'recorder.mp3', recorded_at: '2026-07-01T10:00:00', state: 'queued' }),
    imported: rec({ name: 'imported.mp3', recorded_at: '2026-07-02T10:00:00', state: 'queued', origin: 'import' }),
  })
  const result = buildJobsView(jobs, null, { limit: 10, alive: () => true, recorderPresent: false })
  expect(result.queued_total).toBe(2)
  expect(result.recorder_queued_total).toBe(1)
  expect(result.items.find(item => item.name === 'imported.mp3')?.imported).toBe(true)
})

// ── pruning (deletes state — the zombie fix) ────────────────────────────────

test('pruneUnseen drops scan artifacts but never records that own output', () => {
  const withOutput = { transcript: '/w/t.md' }
  const jobs = {
    gone_q: rec({ name: 'gq.mp3', recorded_at: '2026-05-01T10:00:00', state: 'queued' }),
    gone_e: rec({ name: 'ge.mp3', recorded_at: '2026-05-02T10:00:00', state: 'error' }),
    gone_f: rec({ name: 'gf.mp3', recorded_at: '2026-05-03T10:00:00', state: 'filtered' }),
    gone_r: rec({ name: 'gr.mp3', recorded_at: '2026-05-04T10:00:00', state: 'running' }),
    // Produced files; the source leaving the device is normal and must not erase
    // real work — deleting these would also re-pay for ASR when it comes back.
    gone_done: rec({ name: 'gd.mp3', recorded_at: '2026-05-05T10:00:00', state: 'done', paths: { notes: '/w/n.md' } }),
    gone_spent: rec({ name: 'gs.mp3', recorded_at: '2026-05-06T10:00:00', state: 'gave_up', paths: withOutput }),
    // The case a state-enum rule got wrong: still `error`, but its transcript
    // and stub note are on disk.
    gone_summary: rec({ name: 'gsum.mp3', recorded_at: '2026-05-07T10:00:00', state: 'error', code: 'summary_failed', paths: withOutput }),
    still_here: rec({ name: 'sh.mp3', recorded_at: '2026-05-08T10:00:00', state: 'queued' }),
  }
  const dropped = pruneUnseen(jobs, new Set(['still_here']), true)
  // Returns the records, not ids: the caller has to be able to name what it forgot.
  expect(dropped.map(j => j.name).sort()).toEqual(['ge.mp3', 'gf.mp3', 'gq.mp3', 'gr.mp3'])
  expect(Object.keys(jobs).sort()).toEqual(['gone_done', 'gone_spent', 'gone_summary', 'still_here'])
})

test('a transcript-only run does not re-transcribe a job whose summary failed', () => {
  // Transcription is genuinely finished; only the summary is outstanding.
  // Running ASR again would cost money and then mark the job `done` with no
  // notes, permanently.
  const summaryFailed = rec({ name: 'a.mp3', recorded_at: '', state: 'error', code: 'summary_failed', attempts: 1, paths: { transcript: '/w/t.md' } })
  expect(classify(FACTS, summaryFailed, LIMITS, opts({ notesMode: false }))).toMatchObject({ run: false, code: 'already_done' })
  expect(classify(FACTS, summaryFailed, LIMITS, opts({ notesMode: true }))).toMatchObject({ run: true })
})

test('an incomplete scan prunes nothing', () => {
  const jobs = { q: rec({ name: 'q.mp3', recorded_at: '2026-07-01T10:00:00', state: 'queued' }) }
  // Recorder yanked mid-glob: the listing is partial, so "not seen" means
  // nothing. Pruning here would wipe a live queue and reset its retry counters.
  expect(pruneUnseen(jobs, new Set(), false)).toEqual([])
  expect(Object.keys(jobs)).toEqual(['q'])
})

test('patchJob does not touch updated_at when nothing changed', () => {
  const j = rec({ name: 'a.mp3', recorded_at: '2026-07-01T10:00:00', state: 'filtered', code: 'too_small', detail: 'x', updated_at: 'ORIGINAL' })

  // Every 60s scan re-derives the same verdict for filtered files; if this
  // bumped updated_at the state file would differ each tick and defeat the
  // content-gated write that keeps synced workspaces quiet.
  expect(patchJob(j, { state: 'filtered', code: 'too_small', detail: 'x' }, 'NOW')).toBe(false)
  expect(j.updated_at).toBe('ORIGINAL')

  expect(patchJob(j, { state: 'filtered', code: 'too_short', detail: 'x' }, 'NOW')).toBe(true)
  expect(j.updated_at).toBe('NOW')
})

// ── migration (irreversible) ───────────────────────────────────────

test('migrateLegacyState: buckets become states, error artifacts are dropped', () => {
  const v1 = {
    processed_source_ids: {
      p1: { source_path: '/V/RECORD/A/20260729120629.mp3', processed_at: '2026-07-29T05:00:00Z', status: 'completed', title: 'A note', final_paths: { notes: '/w/a.md' } },
      p2: { source_path: '/V/RECORD/A/20260728100157.mp3', processed_at: '2026-07-28T05:00:00Z', status: 'summary_failed_transcript_saved', title: null },
    },
    skipped_source_ids: {
      s1: { source_path: '/V/RECORD/A/20260708153622.mp3', reason: 'too_small:10116<100000', seen_at: '2026-07-27T07:00:00Z', size_bytes: 10116 },
      // The zombie class: a recorder unplugged mid-run left 127 of these.
      e1: { source_path: '/V/RECORD/A/20260525175151.mp3', reason: 'error:ENOENT: no such file or directory', seen_at: '2026-07-27T07:02:17Z' },
    },
  }
  const { version, jobs } = migrateLegacyState(v1, 'NOW')
  expect(version).toBe(2)
  expect(Object.keys(jobs).sort()).toEqual(['p1', 'p2', 's1'])
  expect(jobs.p1).toMatchObject({ state: 'done', title: 'A note', paths: { notes: '/w/a.md' }, name: '20260729120629.mp3' })
  expect(jobs.p2).toMatchObject({ state: 'error', code: 'summary_failed' })
  expect(jobs.s1).toMatchObject({ state: 'filtered', code: 'too_small', detail: '10116<100000' })
  // recorded_at comes from the recorder's local-time filename, not the stored UTC stamp.
  expect(jobs.p1!.recorded_at).toBe('2026-07-29T12:06:29')
})

test('migrateLegacyState maps an empty file to an empty state', () => {
  // Only reachable when the file genuinely parsed as `{}` — telling that apart
  // from a parse failure is the caller's job (readLegacyState), because getting
  // it wrong here silently re-transcribes the entire history.
  expect(migrateLegacyState({}, 'NOW').jobs).toEqual({})
})

// ── classify (decides what runs, and what stops running) ────────────────────

const NOW = new Date('2026-07-29T12:00:00').getTime()
const LIMITS = { maxAgeHours: 0, minBytes: 100_000, minDurationSeconds: 60 }
const FACTS = { recordedAt: new Date('2026-07-29T10:00:00'), sizeBytes: 1_000_000, durationSeconds: 600 }
const opts = (over: Partial<{ force: boolean; notesMode: boolean }> = {}) => ({ force: false, notesMode: true, now: NOW, ...over })

test('classify: unseen recordings run, done ones do not', () => {
  expect(classify(FACTS, undefined, LIMITS, opts())).toMatchObject({ run: true })
  const done = rec({ name: 'a.mp3', recorded_at: '', state: 'done' })
  expect(classify(FACTS, done, LIMITS, opts())).toMatchObject({ run: false, code: 'already_done' })
  expect(classify(FACTS, done, LIMITS, opts({ force: true }))).toMatchObject({ run: true })
})

test('classify: current filters win, and widening them re-queues old filtered records', () => {
  expect(classify({ ...FACTS, sizeBytes: 5_000 }, undefined, LIMITS, opts())).toMatchObject({ run: false, code: 'too_small', persist: true })
  expect(classify({ ...FACTS, durationSeconds: 30 }, undefined, LIMITS, opts())).toMatchObject({ run: false, code: 'too_short', persist: true })
  expect(classify(FACTS, undefined, { ...LIMITS, maxAgeHours: 1 }, opts())).toMatchObject({ run: false, code: 'too_old', persist: true })

  // A too-short file that once errored stays filtered — it must not ping-pong
  // between error and queued.
  const errored = rec({ name: 'a.mp3', recorded_at: '', state: 'error', attempts: 1 })
  expect(classify({ ...FACTS, durationSeconds: 30 }, errored, LIMITS, opts())).toMatchObject({ run: false, code: 'too_short' })

  const tooOld = rec({ name: 'old.mp3', recorded_at: '', state: 'filtered', code: 'too_old' })
  expect(classify(FACTS, tooOld, { ...LIMITS, maxAgeHours: 1 }, opts())).toMatchObject({ run: false, code: 'too_old' })
  expect(classify(FACTS, tooOld, { ...LIMITS, maxAgeHours: 0 }, opts())).toEqual({ run: true })
})


test('classify: spent records are refused; everything else retries', () => {
  const retryable = rec({ name: 'a.mp3', recorded_at: '', state: 'error', attempts: 2, detail: 'boom' })
  expect(classify(FACTS, retryable, LIMITS, opts())).toMatchObject({ run: true })

  const spent = rec({ name: 'a.mp3', recorded_at: '', state: 'gave_up', attempts: 3, detail: 'no more' })
  expect(classify(FACTS, spent, LIMITS, opts())).toMatchObject({ run: false, code: 'gave_up', detail: 'no more' })
  // `--force` is the documented escape hatch and must override the cap.
  expect(classify(FACTS, spent, LIMITS, opts({ force: true }))).toMatchObject({ run: true })
})

// ── the write side: transitions that cost real money ────────────────────────

test('startAttempt counts the attempt up front, so a failure is never free', () => {
  const j = rec({ name: 'a.mp3', recorded_at: '', state: 'queued', attempts: 0 })
  startAttempt(j, 'T1')
  expect(j).toMatchObject({ state: 'running', attempts: 1, code: null, detail: null })

  applyOutcome(j, { kind: 'failed', message: 'boom' }, 'T2')
  expect(j).toMatchObject({ state: 'error', code: 'transcribe_failed', attempts: 1 })
  expect(j.detail).toContain('attempt 1/3')
})

// Quitting the app mid-run says nothing about the recording. Charging it to
// the retry budget meant three restarts turned a healthy recording into
// "gave up" — which is exactly what happened in the desktop app.
test('an interrupted run is requeued and refunded, up to a cap', () => {
  const j = rec({ name: 'a.mp3', recorded_at: '', state: 'queued', attempts: 0 })
  for (let i = 1; i < MAX_INTERRUPTIONS; i++) {
    startAttempt(j, 'T1')
    reconcileInterrupted({ j }, 'T2')
    expect(j).toMatchObject({ state: 'queued', code: null, detail: null, attempts: 0, interruptions: i })
  }

  // A recording that reliably kills the process must not loop forever.
  startAttempt(j, 'T3')
  reconcileInterrupted({ j }, 'T4')
  expect(j).toMatchObject({ state: 'gave_up', code: 'interrupted', interruptions: MAX_INTERRUPTIONS })

  // A clean finish clears the count, so occasional restarts never accumulate.
  requeueFailed(j, 'T5')
  startAttempt(j, 'T6')
  applyOutcome(j, { kind: 'done', title: 't', paths: null }, 'T7')
  expect(j).toMatchObject({ state: 'done', attempts: 0, interruptions: 0 })
})

test('manual retry resets the budget but keeps saved outputs', () => {
  const j = rec({
    name: 'a.mp3', recorded_at: '', state: 'gave_up', code: 'summary_failed',
    attempts: 3, detail: 'no more', paths: { transcript: '/w/a-transcript.md' },
  })
  expect(requeueFailed(j, 'T')).toBe(true)
  expect(j).toMatchObject({ state: 'queued', code: 'summary_failed', detail: null, attempts: 0, paths: { transcript: '/w/a-transcript.md' }, updated_at: 'T' })

  const done = rec({ name: 'done.mp3', recorded_at: '', state: 'done' })
  expect(requeueFailed(done, 'T')).toBe(false)
  expect(done.state).toBe('done')
})

test('applyOutcome: only a clean finish refunds the attempt budget', () => {
  const j = rec({ name: 'a.mp3', recorded_at: '', state: 'queued', attempts: 2 })
  startAttempt(j, 'T')
  applyOutcome(j, { kind: 'done', title: 'Note', paths: { notes: '/w/a.md' } }, 'T')
  expect(j).toMatchObject({ state: 'done', attempts: 0, title: 'Note', code: null, detail: null })
})

test('applyOutcome: a spent attempt lands in gave_up, not a retry promise', () => {
  const fail = (attemptsBefore: number) => {
    const j = rec({ name: 'a.mp3', recorded_at: '', state: 'queued', attempts: attemptsBefore })
    startAttempt(j, 'T')
    applyOutcome(j, { kind: 'failed', message: 'boom' }, 'T')
    return j
  }
  expect(fail(0)).toMatchObject({ state: 'error', code: 'transcribe_failed', attempts: 1 })
  expect(fail(1).detail).toContain('attempt 2/3')

  const spent = fail(MAX_ATTEMPTS - 1)
  expect(spent).toMatchObject({ state: 'gave_up', attempts: MAX_ATTEMPTS })
  expect(spent.detail).toContain('vn forget a.mp3')
})

test('applyOutcome: a failed summary keeps its transcript paths and spends budget', () => {
  const j = rec({ name: 'a.mp3', recorded_at: '', state: 'queued', attempts: 0 })
  startAttempt(j, 'T')
  applyOutcome(j, { kind: 'summary_failed', title: 'T', paths: { transcript: '/w/a-transcript.md' }, message: 'llm died' }, 'T')

  // Paths survive so the retry resumes at the summary step instead of re-paying
  // for ASR; the attempt still counts, because retrying re-runs the LLM.
  expect(j).toMatchObject({ state: 'error', code: 'summary_failed', attempts: 1, paths: { transcript: '/w/a-transcript.md' } })

  // …and the view renders that as its own row, not a generic failure.
  const { items } = view(state({ j }))
  expect(items[0]).toMatchObject({ status: 'notes_failed', notes: null })
})

test('view: gave_up and unknown states both surface, never as done', () => {
  const s = state({
    g: rec({ name: 'g.mp3', recorded_at: '2026-07-08T10:00:00', state: 'gave_up', detail: 'no more' }),
    // Hand-edited, or written by a newer build. Rendering it as "done" would
    // hide unprocessed work.
    x: rec({ name: 'x.mp3', recorded_at: '2026-07-07T10:00:00', state: 'wat' as any }),
  })
  const { items } = view(s)
  expect(items[0]).toMatchObject({ status: 'gave_up', detail: 'no more' })
  expect(items[1]!.status).toBe('error')
  expect(items[1]!.detail).toContain('wat')
})

test('parseStateFile refuses damage instead of reading it as "nothing done yet"', () => {
  // The expensive failure mode: a truncated / sync-mangled file that parses as
  // empty re-transcribes the whole history and pays for ASR twice.
  expect(() => parseStateFile('{"version":2,"jobs":', '/w/jobs.json')).toThrow(/unreadable/)
  expect(() => parseStateFile('{"version":2}', '/w/jobs.json')).toThrow(/no `jobs` map/)
  expect(() => parseStateFile('[]', '/w/jobs.json')).toThrow(/no `jobs` map/)
  expect(() => parseStateFile('{"jobs":[]}', '/w/jobs.json')).toThrow(/no `jobs` map/)

  expect(parseStateFile('{"version":2,"jobs":{}}', '/w/jobs.json')).toEqual({ version: 2, jobs: {} })
})

test('parseStateFile normalises records so the retry cap cannot silently lapse', () => {
  // `attempts: undefined` makes `attempts >= MAX_ATTEMPTS` compare as NaN, which
  // is false — the cap would never fire and a broken file would burn ASR on
  // every 60s tick.
  const { jobs } = parseStateFile('{"jobs":{"a":{"state":"error"},"b":{"state":"error","attempts":-4},"c":null}}', '/w/jobs.json')
  expect(jobs.a!.attempts).toBe(0)
  expect(jobs.b!.attempts).toBe(0)
  expect(jobs.a!.name).toBe('a')      // falls back to the id rather than undefined
  expect(jobs.c).toBeUndefined()      // a non-object record is dropped, not trusted
})

test('a refusal that is not a filter can never reach disk', () => {
  // `code` is written straight into JobRecord.code, so the type must keep
  // display-only reasons (already_done / gave_up) out of the record.
  const done = classify(FACTS, rec({ name: 'a.mp3', recorded_at: '', state: 'done' }), LIMITS, opts())
  const filtered = classify({ ...FACTS, sizeBytes: 1 }, undefined, LIMITS, opts())
  expect(done).toMatchObject({ run: false, persist: false })
  expect(filtered).toMatchObject({ run: false, persist: true, code: 'too_small' })
})

test('parseJobsLimit: 0 means all, absent means default, garbage is an error', () => {
  expect(parseJobsLimit(undefined, 30)).toBe(30)
  expect(parseJobsLimit('', 30)).toBe(30)
  expect(parseJobsLimit(0, 30)).toBe(Infinity)
  expect(parseJobsLimit('5', 30)).toBe(5)
  // Must throw, not fall back: a silently-defaulted limit makes a truncated
  // list look complete, which is the bug this whole module exists to remove.
  expect(() => parseJobsLimit('abc', 30)).toThrow(/expected a non-negative integer/)
  expect(() => parseJobsLimit(-1, 30)).toThrow()
  expect(() => parseJobsLimit(1.5, 30)).toThrow()
})

test('a record from a newer build is refused, not re-run', () => {
  expect(() => parseStateFile('{"version":3,"jobs":{}}', '/w/jobs.json')).toThrow(/newer voicenote/)

  // And if one slips through some other way, the classifier and the view agree
  // it is unusable rather than one running it and the other flagging it.
  const alien = rec({ name: 'a.mp3', recorded_at: '', state: 'teleported' as any })
  expect(classify(FACTS, alien, LIMITS, opts())).toMatchObject({ run: false })
  expect(view(state({ a: alien })).items[0]!.status).toBe('error')
})

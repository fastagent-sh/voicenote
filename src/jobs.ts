// The job-state model: what should run (classify), what should be forgotten
// (pruneUnseen), and how it all reads back (buildJobsView).
//
// `vn jobs` used to assemble one view from three unrelated sources — a regex
// over the launchd log (live), a second glob of the recorder (pending), and the
// state file (everything else) — so the three could never agree. Now `vn run` is
// the only writer and every view is a pure read. Keeping the *decisions* here
// too (not just the grouping) is deliberate: the queue you see and the queue
// that runs must come from one function, or they drift apart again.
//
// No fs, no process, no clock — all injected — so every rule is testable
// (see jobs.test.ts).
//
// The invariant worth naming: a record left in `running` by a process that is
// no longer alive is NOT running. Liveness is a pid check injected by the
// caller, never inferred from log text — that inference is what used to wedge
// a failed job at "Processing" forever.

import { NO_SPEECH, UNUSABLE_AUDIO } from './failureCodes.ts'

// Lifecycle position only. WHY a job is where it is lives in `code`, so no two
// fields have to agree about the same fact — an earlier cut expressed "gave up"
// as `code` while leaving `state` alone, and the view and the classifier
// promptly disagreed about what such a record was.
type JobState = 'queued' | 'running' | 'done' | 'filtered' | 'error' | 'gave_up'

/** Which stage produced a failure; also carries the filter reason. */
type JobCode =
  | 'transcribe_failed' | 'summary_failed' | 'interrupted'
  // Reasons a recording is set aside rather than failed: the file is fine, it
  // just holds nothing worth transcribing, or the user removed it from the queue.
  | 'too_small' | 'too_short' | 'too_old' | 'no_speech' | 'bad_audio' | 'skipped'
  | null

export type JobRecord = {
  name: string
  source_path: string
  content_hash?: string
  /** Local wall-clock `YYYY-MM-DDTHH:mm:ss` — sorts lexicographically, no TZ drift. */
  recorded_at: string
  size_bytes: number
  duration_seconds: number | null
  state: JobState
  code: JobCode
  detail: string | null
  attempts: number
  /** Runs that died before reporting back (app quit, sleep, power loss). */
  interruptions?: number
  /** Higher value moves a queued recording ahead of the default chronological order. */
  priority?: number
  updated_at: string
  title: string | null
  paths: Record<string, string | null> | null
  origin?: 'import'
}

export type StateFile = {
  version: 2
  jobs: Record<string, JobRecord>
}

/**
 * Does this record own files on disk? Evidence, not a state enum: a
 * `summary_failed` record has a transcript and a stub note, and enumerating
 * states would have to remember that. Deleting such a record loses real work
 * and re-pays for ASR when the recorder comes back.
 */
export const ownsOutput = (j: JobRecord): boolean => j.paths != null

// Give up auto-retrying a recording that keeps blowing up, so a permanently
// broken file can't burn an ASR (or LLM) call every scheduler tick. `vn forget`
// drops the record and puts it back in the queue.
export const MAX_ATTEMPTS = 3

/** The subset of JobCode a refusal may write to disk. */
type FilterCode = Extract<JobCode, 'too_small' | 'too_short' | 'too_old'>

// Split by whether the refusal is persisted, so the code that reaches disk is
// typed as such. A single `code: string` needed a cast at the write site, and
// the cast was the only thing keeping a display-only reason out of the record.
type Verdict =
  | { run: true }
  | { run: false; persist: true; code: FilterCode; detail: string | null }
  | { run: false; persist: false; code: 'already_done' | 'gave_up' | 'no_speech' | 'bad_audio' | 'skipped'; detail: string | null }

type ScanFacts = { recordedAt: Date; sizeBytes: number; durationSeconds: number | null }
type Limits = { maxAgeHours: number; minBytes: number; minDurationSeconds: number }

/**
 * The single answer to "should this recording run now, and in what form".
 * `vn jobs` reads back what this decided instead of re-deriving it with looser
 * rules, which is why the shown queue and the real queue can no longer disagree.
 */
export function classify(
  rec: ScanFacts,
  entry: JobRecord | undefined,
  limits: Limits,
  opts: { force: boolean; notesMode: boolean; now: number },
): Verdict {
  if (opts.force) return { run: true }
  // Answers that will not change on a retry, so they are never re-paid for.
  if (entry?.code === 'no_speech' || entry?.code === 'bad_audio') {
    return { run: false, persist: false, code: entry.code, detail: entry.detail }
  }
  if (entry?.state === 'filtered' && entry?.code === 'skipped') {
    return { run: false, persist: false, code: 'skipped', detail: entry.detail }
  }
  if (entry?.state === 'done') return { run: false, persist: false, code: 'already_done', detail: null }
  // Only the summary is outstanding, and this run doesn't make summaries. The
  // transcription stage is genuinely finished — re-running it would pay for ASR
  // again and then mark the job `done` with no notes, permanently.
  if (entry?.code === 'summary_failed' && !opts.notesMode) return { run: false, persist: false, code: 'already_done', detail: null }
  // Retries are spent. reconcileInterrupted() is what puts a record here, so
  // this branch needs no knowledge of *how* the attempts were used up.
  if (entry?.state === 'gave_up') return { run: false, persist: false, code: 'gave_up', detail: entry.detail }

  // Filters are deterministic properties of the file, checked before anything
  // stateful so a too-short file can't ping-pong between error and queued.
  //
  // Size and duration come first, and the order is the point: they say the
  // recording holds nothing worth transcribing, which no amount of "process
  // it anyway" changes. Age only says it is old — a real meeting from last
  // month is still worth processing on request. Reporting a 14-second button
  // press as "too old" invited exactly that pointless request.
  if (rec.sizeBytes < limits.minBytes) return { run: false, persist: true, code: 'too_small', detail: `${rec.sizeBytes} < ${limits.minBytes} bytes` }
  if (rec.durationSeconds !== null && rec.durationSeconds < limits.minDurationSeconds) return { run: false, persist: true, code: 'too_short', detail: `${rec.durationSeconds.toFixed(0)}s < ${limits.minDurationSeconds}s` }
  const ageHours = (opts.now - rec.recordedAt.getTime()) / 3600_000
  if (limits.maxAgeHours > 0 && ageHours > limits.maxAgeHours) return { run: false, persist: true, code: 'too_old', detail: `${ageHours.toFixed(0)}h > ${limits.maxAgeHours}h` }

  // `error`, `queued` and `running` are retryable. A previously `filtered`
  // record is runnable too once it passes the CURRENT filters, so widening the
  // history range in Settings actually re-queues recordings marked `too_old`.
  // Anything else came off disk hand-edited or from a newer build: refuse it.
  if (entry && !RUNNABLE_STATES.has(entry.state)) {
    return { run: false, persist: false, code: 'gave_up', detail: `Unrecognised state '${entry.state}'; \`vn forget ${entry.name}\` to start over` }
  }
  return { run: true }
}

const RUNNABLE_STATES = new Set<JobState>(['queued', 'running', 'error', 'filtered'])

/** Every way a started attempt can end. */
type Outcome =
  | { kind: 'done'; title: string | null; paths: Record<string, string | null> | null }
  | { kind: 'summary_failed'; title: string | null; paths: Record<string, string | null> | null; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'interrupted' }

/**
 * The single place a started attempt is turned back into a record. It lives
 * next to classify() and buildJobsView() on purpose: `running` used to be
 * interpreted independently by all three, so they disagreed about what an
 * interrupted-and-spent job was — the view called it "Queued" while the
 * classifier refused to ever run it again.
 */
export function applyOutcome(entry: JobRecord, outcome: Outcome, now: string): void {
  const spent = entry.attempts >= MAX_ATTEMPTS
  const giveUp = (code: JobCode, why: string) => patchJob(entry, {
    state: spent ? 'gave_up' : 'error',
    code,
    detail: spent
      ? `${why} — gave up after ${entry.attempts} attempts; \`vn forget ${entry.name}\` to retry`
      : `${why} (attempt ${entry.attempts}/${MAX_ATTEMPTS})`,
  }, now)

  switch (outcome.kind) {
    case 'done':
      // Only a clean finish refunds the budget.
      patchJob(entry, { state: 'done', code: null, detail: null, title: outcome.title, paths: outcome.paths, attempts: 0, interruptions: 0, priority: undefined }, now)
      return
    case 'summary_failed':
      // The expensive transcript is on disk; keep its paths so a retry resumes
      // there. Retrying notes re-runs the LLM, so it spends from the same budget.
      patchJob(entry, { title: outcome.title, paths: outcome.paths }, now)
      giveUp('summary_failed', outcome.message)
      return
    case 'failed': {
      const setAside = setAsideCode(outcome.message)
      if (setAside) {
        patchJob(entry, { state: 'filtered', code: setAside, detail: outcome.message, attempts: 0 }, now)
        return
      }
      giveUp('transcribe_failed', outcome.message)
      return
    }
    case 'interrupted': {
      // An interrupted run says nothing about the recording: the process was
      // killed (app quit, sleep, power loss) before it could report. Charging
      // it to the retry budget meant three app restarts turned a healthy
      // recording into "gave up". Refund the attempt and requeue instead, but
      // count interruptions separately so a recording that reliably kills the
      // process cannot loop forever.
      const interruptions = (entry.interruptions ?? 0) + 1
      if (interruptions >= MAX_INTERRUPTIONS) {
        patchJob(entry, {
          state: 'gave_up',
          code: 'interrupted',
          interruptions,
          detail: `Interrupted ${interruptions} times before reporting back; \`vn forget ${entry.name}\` to retry`,
        }, now)
        return
      }
      patchJob(entry, {
        state: 'queued',
        code: null,
        detail: null,
        interruptions,
        attempts: Math.max(0, entry.attempts - 1),
      }, now)
      return
    }
  }
}

/** Open an attempt. Counted here, not at the end: a run killed mid-job (kill -9,
 *  OOM, SIGTERM) never reaches an end, and an uncounted attempt retries forever. */
/** How many interruptions before a recording is treated as poison. */
export const MAX_INTERRUPTIONS = 5

export function startAttempt(entry: JobRecord, now: string): void {
  patchJob(entry, { state: 'running', code: null, detail: null, attempts: entry.attempts + 1 }, now)
}

/** Manually requeue a failed job while retaining any saved transcript/audio. */
export function requeueFailed(entry: JobRecord, now: string): boolean {
  if (entry.state !== 'error' && entry.state !== 'gave_up') return false
  patchJob(entry, { state: 'queued', detail: null, attempts: 0 }, now)
  return true
}

/**
 * Queue a finished recording for a fresh set of notes. Its paths are kept, so
 * the run resumes from the saved transcript instead of paying for ASR again —
 * this is for "the model or my speaker list changed, write it again", not for
 * re-transcribing.
 */
export function requeueForRegenerate(entry: JobRecord, now: string): boolean {
  if (entry.state !== 'done') return false
  patchJob(entry, { state: 'queued', code: null, detail: null, attempts: 0 }, now)
  return true
}

/** Move a queued recording ahead of normal FIFO order. */
export function prioritizeQueued(entry: JobRecord, priority: number, now: string): boolean {
  if (entry.state !== 'queued') return false
  patchJob(entry, { priority }, now)
  return true
}

/**
 * Remove a queued recording from the active queue without deleting recorder
 * files or finished notes.
 */
export function removeFromQueue(entry: JobRecord, now: string): 'delete' | 'restore_done' | 'filter_skipped' | 'invalid' {
  if (entry.state !== 'queued') return 'invalid'
  if (entry.origin === 'import' && !ownsOutput(entry)) return 'delete'
  if (ownsOutput(entry) && entry.paths?.notes && entry.code === null) {
    patchJob(entry, { state: 'done', code: null, detail: null, attempts: 0, priority: undefined }, now)
    return 'restore_done'
  }
  patchJob(entry, { state: 'filtered', code: 'skipped', detail: null, attempts: 0, priority: undefined }, now)
  return 'filter_skipped'
}

/**
 * Single queue order shared between `buildJobsView` and `runPipelineLocked`:
 * higher priority first, then manual imports, then oldest recording first.
 */
export function compareQueuedJobs(
  a: { priority?: number | null; imported?: boolean; recordedAt: string | number },
  b: { priority?: number | null; imported?: boolean; recordedAt: string | number },
): number {
  const pa = a.priority ?? 0
  const pb = b.priority ?? 0
  if (pa !== pb) return pb - pa
  const ia = Number(Boolean(a.imported))
  const ib = Number(Boolean(b.imported))
  if (ia !== ib) return ib - ia
  return typeof a.recordedAt === 'number' && typeof b.recordedAt === 'number'
    ? a.recordedAt - b.recordedAt
    : String(a.recordedAt).localeCompare(String(b.recordedAt))
}

/**
 * Reclaim records left `running` by a dead run. Safe to do wholesale because the
 * caller holds the run lock: no other run can own a `running` record right now.
 */
export function reconcileInterrupted(jobs: Record<string, JobRecord>, now: string): JobRecord[] {
  const stale = Object.values(jobs).filter(j => j.state === 'running')
  for (const j of stale) applyOutcome(j, { kind: 'interrupted' }, now)
  return stale
}

/**
 * Drop records the scan no longer sees. A queued/filtered/error record whose
 * file is gone was a scan artifact, not a job — keeping them is how 127 dead
 * entries accumulated. Records that produced output are history and stay.
 *
 * `scanComplete` is the guard, not an optimisation: a partial listing (recorder
 * yanked mid-glob) would otherwise wipe live queue entries. They'd come back on
 * the next scan, but their retry counters wouldn't. It lives here rather than at
 * the call site so the rule whose failure wipes a queue is covered by tests.
 */
export function pruneUnseen(jobs: Record<string, JobRecord>, seen: Set<string>, scanComplete: boolean): JobRecord[] {
  if (!scanComplete) return []
  const dropped: JobRecord[] = []
  for (const [id, j] of Object.entries(jobs)) {
    if (seen.has(id) || ownsOutput(j)) continue
    delete jobs[id]
    dropped.push(j)   // the record, not the id: the caller must be able to name what it forgot
  }
  return dropped
}

export type CurrentJob = { pid: number; source_id: string; step: string; started_at: string }

type JobView = {
  id: string | null
  status: 'running' | 'queued' | 'done' | 'notes_failed' | 'error' | 'gave_up' | 'filtered'
  name: string
  title: string | null
  time: string | null
  step: string | null
  detail: string | null
  /** Machine-readable failure reason, for a UI that wants its own wording. */
  code: string | null
  notes: string | null
  /** ISO timestamp of the last state change; null on the folded rows. */
  finishedAt: string | null
  /** Saved alongside the note: the copied audio and the transcript. */
  audio: string | null
  transcript: string | null
  durationSeconds: number | null
  history_filtered: boolean
  /** Only on the folded "filtered out" row: how many, and why. */
  filtered?: { total: number; byCode: Record<string, number> }
  imported: boolean
  priority: number
}

export const SUMMARY_FAILED_STATUS = 'summary_failed_transcript_saved'

/** Local wall clock, not UTC: recorder filenames are local time and the view sorts on this string. */
export function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Apply a patch, reporting whether anything actually changed.
 *
 * The no-op guard is load-bearing, not tidiness: `classify` re-derives the same
 * verdict for every filtered recording on every 60s scan, so an unconditional
 * `updated_at` bump would make the state file differ on each tick and defeat the
 * content-gated write that keeps synced workspaces quiet.
 */
export function patchJob(entry: JobRecord, patch: Partial<JobRecord>, now: string): boolean {
  if (Object.entries(patch).every(([k, v]) => (entry as any)[k] === v)) return false
  Object.assign(entry, patch, { updated_at: now })
  return true
}

export const emptyState = (): StateFile => ({ version: 2, jobs: {} })

/**
 * One meaning of `limit` for both front doors (the CLI flag and the GUI's call):
 * 0 = no limit, absent = `fallback`, anything else must be a non-negative
 * integer. Coercing garbage to a default is how a truncated list gets mistaken
 * for a complete one — the exact bug this module exists to remove.
 */
export function parseJobsLimit(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid limit '${raw}': expected a non-negative integer (0 = no limit).`)
  return n === 0 ? Infinity : n
}

/**
 * Parse a state file, throwing on anything that isn't one.
 *
 * Deliberately strict: a truncated or sync-mangled file that silently read as
 * "nothing was ever processed" would re-transcribe the entire history, pay for
 * ASR a second time, and then overwrite the evidence on the next save.
 */
export function parseStateFile(text: string, path: string): StateFile {
  const parsed = parseStrictJson(text, path)
  const version = (parsed as any)?.version
  // A newer build's file must not be reinterpreted as v2: unknown states would
  // be re-run by the classifier while the view calls them unrecognised.
  if (Number.isFinite(version) && version > 2) {
    throw new Error(`${path} was written by a newer voicenote (state version ${version}). Upgrade rather than risk re-processing everything.`)
  }
  const raw = (parsed as any)?.jobs
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path} is not a job-state file (no \`jobs\` map). Refusing to continue rather than re-processing everything.`)
  }
  // Normalise at the boundary rather than trusting field by field downstream.
  // `attempts` especially: a missing value makes `attempts >= MAX_ATTEMPTS`
  // compare as NaN, which is false — the retry cap would silently never apply
  // and a broken recording would burn ASR every scheduler tick.
  const jobs: Record<string, JobRecord> = {}
  for (const [id, j] of Object.entries<any>(raw)) {
    if (!j || typeof j !== 'object') continue
    const entry: JobRecord = {
      ...j,
      name: typeof j.name === 'string' ? j.name : id,
      source_path: typeof j.source_path === 'string' ? j.source_path : '',
      recorded_at: typeof j.recorded_at === 'string' ? j.recorded_at : '',
      attempts: Number.isInteger(j.attempts) && j.attempts >= 0 ? j.attempts : 0,
      interruptions: Number.isInteger(j.interruptions) && j.interruptions >= 0 ? j.interruptions : 0,
      ...(typeof j.priority === 'number' && Number.isFinite(j.priority) && j.priority > 0 ? { priority: j.priority } : {}),
      paths: j.paths && typeof j.paths === 'object' ? j.paths : null,
    }
    // Records written before "no speech" and "unusable audio" were recognised
    // sit in the failure list forever, offering a retry that fails the same
    // way. Reclassify them on read rather than leaving dead ends on screen.
    const setAside = entry.state !== 'done' && entry.code === 'transcribe_failed'
      ? setAsideCode(entry.detail ?? '')
      : null
    if (setAside) {
      entry.state = 'filtered'
      entry.code = setAside
      entry.attempts = 0
    }
    // The same rule in reverse. An older build read every `45…` status as
    // unusable audio — including 45000001, which says the request was invalid,
    // not the file — so it set aside recordings that were never judged at all.
    // Their verdict no longer matches the reason recorded with it: queue them
    // again instead of leaving a healthy recording hidden behind a wrong label.
    if (entry.state === 'filtered' && entry.code === 'bad_audio' && !UNUSABLE_AUDIO.test(entry.detail ?? '')) {
      entry.state = 'queued'
      entry.code = null
      entry.detail = null
      entry.attempts = 0
    }
    // "Ignore" is gone from the product: a record an older build set aside that
    // way is a recording nobody has processed yet.
    if (j.code === 'ignored') {
      entry.state = 'queued'
      entry.code = null
      entry.detail = null
      entry.attempts = 0
    }
    jobs[id] = entry
  }
  return { version: 2, jobs }
}

/** JSON.parse with the message a user can act on. */
export function parseStrictJson(text: string, path: string): unknown {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch (e: any) {
    throw new Error(`${path} is unreadable (${e?.message || e}). Move it aside to start over — but note that re-processing every recording costs ASR again.`)
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`${path} is not a JSON object. Refusing to continue rather than re-processing everything.`)
  return parsed
}

const FILTER_LABELS: Record<string, string> = {
  too_small: 'too small',
  too_short: 'too short',
  too_old: 'too old',
  no_speech: 'no speech',
  bad_audio: 'unusable audio',
  skipped: 'removed from queue',
}

/**
 * A transcription that came back "there is no speech in here" or "this is not
 * usable audio" is not a failure to retry: the answer will not change. Such a
 * recording belongs with the ones that were filtered out, not in the list of
 * things the user still has to deal with.
 */
function setAsideCode(message: string): JobCode | null {
  if (NO_SPEECH.test(message)) return 'no_speech'
  if (UNUSABLE_AUDIO.test(message)) return 'bad_audio'
  return null
}

/** `2026-07-29T12:06:29` → `2026-07-29 12:06`. */
function displayTime(recordedAt: string | null): string | null {
  if (!recordedAt) return null
  return recordedAt.slice(0, 16).replace('T', ' ')
}

function foldFiltered(records: JobRecord[]): JobView | null {
  if (!records.length) return null
  // Counts by raw code as well as the English summary: the CLI prints the
  // summary, a UI renders the codes in its own language.
  const byCode: Record<string, number> = {}
  const counts = new Map<string, number>()
  for (const r of records) {
    const code = r.code ?? 'filtered'
    byCode[code] = (byCode[code] ?? 0) + 1
    const key = FILTER_LABELS[code] ?? code
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const detail = [...counts].map(([label, n]) => `${label} ×${n}`).join(', ')
  return {
    id: null,
    status: 'filtered',
    name: `${records.length} recording${records.length > 1 ? 's' : ''} filtered out`,
    title: null, time: null, finishedAt: null, step: null, detail, code: null, notes: null, audio: null, transcript: null, durationSeconds: null,
    history_filtered: records.some(r => r.code === 'too_old'), imported: false, priority: 0,
    filtered: { total: records.length, byCode },
  }
}

export function buildJobsView(
  state: StateFile,
  current: CurrentJob | null,
  opts: { limit: number; alive: (pid: number) => boolean; recorderPresent: boolean },
): { items: JobView[]; total: number; queued_total: number; recorder_queued_total: number; recorder_present: boolean } {
  // Two independent conditions must agree before a row is shown as running:
  // the declaring process is alive, AND the record itself says `running`.
  // current.json survives a kill -9, so the pid alone could be recycled by an
  // unrelated long-lived process and wedge a finished job at "Processing" —
  // the very failure this rewrite exists to remove.
  const claimed = current && opts.alive(current.pid) ? current : null
  const live = claimed && state.jobs?.[claimed.source_id]?.state === 'running' ? claimed : null

  const running: JobView[] = []
  const queued: JobView[] = []
  const attention: JobView[] = []
  const done: JobView[] = []
  const filtered: JobRecord[] = []

  for (const [id, j] of Object.entries(state.jobs ?? {})) {
    const base = {
      id,
      name: j.name,
      title: j.title ?? null,
      time: displayTime(j.recorded_at),
      /** When this record last changed — i.e. when the notes were written. */
      finishedAt: j.updated_at ?? null,
      step: null,
      detail: null as string | null,
      code: null as string | null,
      notes: j.paths?.notes ?? null,
      audio: j.paths?.audio ?? null,
      transcript: j.paths?.transcript ?? null,
      durationSeconds: j.duration_seconds ?? null,
      history_filtered: false,
      imported: j.origin === 'import',
      priority: j.priority ?? 0,
      _t: j.recorded_at ?? '',
    }
    if (live && live.source_id === id) { running.push({ ...base, status: 'running', step: live.step }); continue }
    switch (j.state) {
      case 'done': done.push({ ...base, status: 'done' }); break
      // A `running` record with no live process is a crashed run; the next run
      // reconciles it. Until then it belongs with the work still to do.
      case 'running':
      case 'queued': queued.push({ ...base, status: 'queued' }); break
      // A saved transcript with a failed summary reads better as its own row:
      // the stub note is openable and the retry is cheap (no ASR).
      case 'error': attention.push({ ...base, status: j.code === 'summary_failed' ? 'notes_failed' : 'error', detail: j.detail, code: j.code ?? null }); break
      case 'gave_up': attention.push({ ...base, status: 'gave_up', detail: j.detail, code: j.code ?? null }); break
      case 'filtered': filtered.push(j); break
      // `state` comes off disk and could be hand-edited or written by a newer
      // build. Showing an unknown value as "done" would hide unprocessed work,
      // so surface it instead.
      default: attention.push({ ...base, status: 'error', detail: `Unrecognised state '${j.state}'` })
    }
  }

  // Sort and display share one key (recorded_at). They used to differ — list
  // sorted by processing time, rows labelled with recording time — which is why
  // the list looked shuffled.
  const asc = (a: any, b: any) => String(a._t).localeCompare(String(b._t))
  queued.sort((a: any, b: any) => compareQueuedJobs(
    { priority: a.priority, imported: a.imported, recordedAt: a._t },
    { priority: b.priority, imported: b.imported, recordedAt: b._t },
  ))
  attention.sort((a, b) => -asc(a, b))
  done.sort((a, b) => -asc(a, b))

  const filteredRow = foldFiltered(filtered)
  // Priority is the array order: live work, the queue, anything needing
  // attention, then the skipped recordings — those are unprocessed work the user
  // can still act on (widen the history range), so they must not sit below a
  // long list of finished notes where nobody scrolls. `done` is history and
  // comes last. Everything is subject to `limit` — exempting the
  // head would make one broken credential (every recording failing MAX_ATTEMPTS
  // times into `attention`) an unbounded list, with `total` claiming it was whole.
  const ordered = [...running, ...queued, ...attention, ...(filteredRow ? [filteredRow] : []), ...done]
  const items: JobView[] = ordered.slice(0, Math.max(0, opts.limit))
  const total = ordered.length

  for (const it of items) delete (it as any)._t
  // `queued_total` is pre-truncation on purpose: "N recordings waiting" counted
  // from the visible page would contradict the "… X more" line right above it.
  // Read `recorder_present` live from the caller, never stored — a persisted
  // flag would keep claiming the recorder is connected after the agent stops.
  return {
    items,
    total,
    queued_total: running.length + queued.length,
    recorder_queued_total: [...running, ...queued].filter(job => !job.imported).length,
    recorder_present: opts.recorderPresent,
  }
}

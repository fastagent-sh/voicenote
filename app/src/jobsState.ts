// Pure state machine behind the dashboard's jobs list refresh. Extracted from
// main.ts (no DOM, no tauri invoke) so its invariants are testable — see
// jobsState.test.ts. The invariants, in one place:
//
// 1. Latest-wins gates RENDERING only, and only while real data is on screen:
//    a superseded response must not overwrite a newer render — but when the
//    screen shows an error / nothing (empty snapshot), any real data beats it,
//    so even a stale success renders.
// 2. Failure accounting is NOT gated on latest-wins: an old request's failure
//    is still evidence of a broken engine. Polls themselves are chained (see
//    main.ts: next tick only after the previous settles), but cross-source
//    overlap is real — boot / refresh-button / post-save flows run while a
//    poll is in flight — and with 60s timeouts a superseded request's slow
//    failure may be the only failure signal a tick ever produces.
// 3. Any success (even superseded) resets the failure counter — the engine
//    answered, so it is alive.
// 4. "The user is waiting for feedback" (explicit refresh) is cross-request
//    state: an explicit request can be superseded by a poll tick, and then
//    whichever response is actually processed must deliver the feedback.
// 5. A visible error clears the snapshot so the next success re-renders, and
//    escalation fires after `maxFailures` consecutive failures — a
//    persistently dead engine must not hide behind a stale list.

export type JobsDecision = "render" | "skip" | "error";

export class JobsRefreshState {
  private lastSnapshot = ""; // "" = nothing rendered yet / error shown
  private failures = 0;
  private seq = 0;
  private explicitPending = false;

  constructor(private maxFailures = 3) {}

  /** Register a new request. Returns its sequence token. */
  begin(explicit: boolean): number {
    this.explicitPending ||= explicit;
    return ++this.seq;
  }

  /** A request settled successfully with the given list snapshot. */
  success(seq: number, snapshot: string): JobsDecision {
    this.failures = 0; // invariant 3: any response proves the engine is alive
    // invariant 4: ANY success settles the feedback debt, stale or not — the
    // engine answered. Leaving the debt open would let a later single
    // background failure masquerade as "the user's refresh failed".
    this.explicitPending = false;
    // invariant 1: latest-wins, except when an error/nothing is on screen —
    // then stale real data still beats the error.
    if (seq !== this.seq && this.lastSnapshot !== "") return "skip";
    if (snapshot === this.lastSnapshot) return "skip"; // no destructive re-render
    this.lastSnapshot = snapshot;
    return "render";
  }

  /** A request settled with an error (reject or timeout). */
  failure(): JobsDecision {
    const userWaiting = this.explicitPending; // invariant 4
    this.explicitPending = false;
    this.failures++; // invariant 2: counted even if superseded
    if (userWaiting || !this.lastSnapshot || this.failures >= this.maxFailures) {
      this.lastSnapshot = ""; // invariant 5: next success must re-render
      return "error";
    }
    return "skip"; // brief background failure: keep the last-good list
  }
}

// Live signals from a running pipeline, for a UI that wants to show more than
// a spinner. Job state (queued/running/step/done) already lives in the state
// file and is read back with `jobsListData`; this carries only what disk state
// cannot: the note text as the model writes it, and which file the agent is
// reading. One run at a time holds the lock, so events need no job id.
export type PipelineEvent =
  | { type: 'note_delta'; delta: string }
  | { type: 'note_tool'; name: string }

type Listener = (event: PipelineEvent) => void

const listeners = new Set<Listener>()

/** Subscribe; returns the unsubscribe function. */
export function onPipelineEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function emitPipelineEvent(event: PipelineEvent): void {
  for (const listener of listeners) {
    // A broken listener must not take down a running pipeline.
    try { listener(event) } catch { /* ignore */ }
  }
}

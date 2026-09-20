/** The preload bridge, typed for the renderer. */
export type Status = {
  version: string
  recorder: { dir: string; exists: boolean }
  workspace: string
  volcano: { configured: boolean }
  summary: { model: string | null }
  pi: { version: string | null; available: boolean; auth: boolean }
  proxy: { url: string | null }
  identity: { self: string | null }
}

export type Job = {
  id: string | null
  status: 'running' | 'queued' | 'done' | 'notes_failed' | 'error' | 'gave_up' | 'filtered'
  name: string
  title: string | null
  time: string | null
  step: string | null
  detail: string | null
  code: string | null
  notes: string | null
  audio: string | null
  transcript: string | null
  durationSeconds: number | null
  history_filtered: boolean
  filtered?: { total: number; byCode: Record<string, number> }
  imported: boolean
}

export type JobsResponse = {
  items: Job[]
  total: number
  queued_total: number
  recorder_present: boolean
}

export type PipelineEvent =
  | { type: 'job_start'; id: string; name: string; durationSeconds: number | null }
  | { type: 'job_step'; step: string }
  | { type: 'job_done'; id: string; title: string | null; notes: string | null; stub: boolean }
  | { type: 'job_failed'; id: string; message: string }
  | { type: 'note_delta'; delta: string }
  | { type: 'note_tool'; name: string }
export type LoginEvent =
  | { event: 'auth_url'; url: string }
  | { event: 'device_code'; userCode: string; verificationUri: string }
  | { event: 'success'; provider: string }
  | { event: 'error'; message: string }

type Api = {
  status: () => Promise<Status>
  jobs: (limit?: number) => Promise<JobsResponse>
  configGet: () => Promise<{ path: string; env: Record<string, string>; self: { name: string | null; aliases: string[] } }>
  configSet: (payload: unknown) => Promise<{ ok: true }>
  run: () => Promise<void>
  retry: (id: string) => Promise<{ queued: boolean }>
  pendingRetries: () => Promise<string[]>
  importRecording: (path: string) => Promise<void>
  pathForFile: (file: File) => string
  pickAudio: () => Promise<string | null>
  pickDirectory: () => Promise<string | null>
  login: () => Promise<void>
  openPath: (path: string) => Promise<string>
  revealPath: (path: string) => Promise<void>
  readNote: (path: string) => Promise<string>
  search: (query: string) => Promise<{ path: string; title: string; snippet: string }[]>
  openNoteAsHtml: (title: string, html: string) => Promise<string>
  setAutoProcess: (enabled: boolean) => Promise<boolean>
  on: (channel: 'pipeline:event' | 'login:event' | 'run:state' | 'run:error' | 'recorder:connected' | 'retry:pending', listener: (payload: any) => void) => () => void
}

export const vn = (window as unknown as { vn: Api }).vn

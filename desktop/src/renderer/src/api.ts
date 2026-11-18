import type { LoginPromptView } from '../../../../src/loginInteraction.ts'

import type { ImportResult } from '../../../../src/core.ts'

export type DesktopImportResult = ImportResult | { status: 'failed'; path: string; error: string }

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
  finishedAt: string | null
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
  priority?: number
}

export type PendingQueue = {
  deletes: string[]
  priorities: Record<string, number>
}

export type JobsResponse = {
  items: Job[]
  total: number
  queued_total: number
  recorder_present: boolean
}

export type RecorderFile = {
  sourceId: string
  name: string
  path: string
  recordedAt: string
  sizeBytes: number
  durationSeconds: number | null
  /** 'ready' | 'already_done' | 'too_old' | 'too_small' | 'too_short' | 'gave_up' | … */
  verdict: string
  detail: string | null
  state: string | null
  title: string | null
}

export type RecorderFiles = { dir: string; present: boolean; items: RecorderFile[] }

export type ModelInfo = { id: string; name: string }
export type ProviderInfo = {
  id: string
  name: string
  configured: boolean
  source?: string
  authType?: 'api_key' | 'oauth'
  hasApiKey: boolean
  hasOAuth: boolean
  models: ModelInfo[]
  defaultModelId?: string
  envKeys: string[]
  apiKey?: string
}

export type PipelineEvent =
  | { type: 'job_start'; id: string; name: string; durationSeconds: number | null }
  | { type: 'job_step'; step: string }
  | { type: 'job_done'; id: string; title: string | null; notes: string | null; stub: boolean }
  | { type: 'job_failed'; id: string; message: string }
  | { type: 'job_aborted'; id: string }
  | { type: 'note_delta'; delta: string }
  | { type: 'note_tool'; name: string }
export type LoginEvent =
  | { event: 'prompt'; id: number; prompt: LoginPromptView }
  | { event: 'prompt_closed'; id: number }
  | { event: 'auth_url'; url: string }
  | { event: 'progress'; message: string }
  | { event: 'success'; provider: string }
  | { event: 'error'; message: string }

export type UpdateState = {
  version: string
  available?: string | null
  ready: string | null
  manual: boolean
  checking?: boolean
  error?: string | null
  packaged?: boolean
}

type Api = {
  status: () => Promise<Status>
  jobs: (limit?: number) => Promise<JobsResponse>
  configGet: () => Promise<{ path: string; env: Record<string, string>; self: { name: string | null; aliases: string[] } }>
  configSet: (payload: unknown) => Promise<{ ok: true }>
  run: () => Promise<{ queued: boolean }>
  retry: (id: string) => Promise<{ queued: boolean }>
  regenerate: (id: string) => Promise<{ queued: boolean }>
  prioritizeJob: (id: string) => Promise<{ queued: boolean }>
  removeQueuedJob: (id: string) => Promise<{ queued: boolean }>
  abortCurrentJob: () => Promise<{ aborted: boolean }>
  recorderFiles: () => Promise<RecorderFiles>
  runFile: (path: string) => Promise<{ queued: boolean }>
  pendingRetries: () => Promise<string[]>
  pendingQueue: () => Promise<PendingQueue>
  updateState: () => Promise<UpdateState>
  checkForUpdates: () => Promise<UpdateState>
  installUpdate: () => Promise<{ installable: boolean }>
  openReleases: () => Promise<void>
  importRecordings: (paths: string[]) => Promise<DesktopImportResult[]>
  pathForFile: (file: File) => string
  pickAudio: () => Promise<string[]>
  pickDirectory: () => Promise<string | null>
  login: (providerId?: string) => Promise<void>
  piProviders: () => Promise<ProviderInfo[]>
  piSetApiKey: (providerId: string, apiKey: string) => Promise<{ ok: true }>
  piRemoveAuth: (providerId: string) => Promise<{ ok: true }>
  piLoginOAuth: (providerId: string) => Promise<{ ok: true }>
  piLoginAnswer: (id: number, value: string) => Promise<void>
  piLoginCancel: () => Promise<void>
  openPath: (path: string) => Promise<string>
  revealPath: (path: string) => Promise<void>
  readNote: (path: string) => Promise<string>
  search: (query: string) => Promise<{ path: string; title: string; snippet: string }[]>
  openNoteAsHtml: (title: string, html: string) => Promise<string>
  setAutoProcess: (enabled: boolean) => Promise<boolean>
  on: (channel: 'pipeline:event' | 'login:event' | 'run:state' | 'run:error' | 'run:queued' | 'recorder:connected' | 'retry:pending' | 'queue:pending' | 'update:changed', listener: (payload: any) => void) => () => void
}

export const vn = (window as unknown as { vn: Api }).vn

import { contextBridge, ipcRenderer, webUtils } from 'electron'

/** The renderer's whole surface onto the pipeline. */
const api = {
  status: () => ipcRenderer.invoke('status'),
  jobs: (limit = 50) => ipcRenderer.invoke('jobs', limit),
  configGet: () => ipcRenderer.invoke('config:get'),
  configSet: (payload: unknown) => ipcRenderer.invoke('config:set', payload),
  run: () => ipcRenderer.invoke('run'),
  retry: (id: string) => ipcRenderer.invoke('retry', id) as Promise<{ queued: boolean }>,
  pendingRetries: () => ipcRenderer.invoke('pending-retries') as Promise<string[]>,
  importRecording: (path: string) => ipcRenderer.invoke('import', path),
  // Electron removed File.path; this is the supported way to get the real path
  // of a dropped file.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  pickAudio: () => ipcRenderer.invoke('pick-audio'),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  login: () => ipcRenderer.invoke('login'),
  openPath: (path: string) => ipcRenderer.invoke('open-path', path),
  revealPath: (path: string) => ipcRenderer.invoke('reveal-path', path),
  readNote: (path: string) => ipcRenderer.invoke('note:read', path),
  search: (query: string) => ipcRenderer.invoke('search', query),
  openNoteAsHtml: (title: string, html: string) => ipcRenderer.invoke('note:open-html', { title, html }),
  setAutoProcess: (enabled: boolean) => ipcRenderer.invoke('auto-process', enabled),
  on: (channel: 'pipeline:event' | 'login:event' | 'run:state' | 'run:error' | 'recorder:connected' | 'retry:pending', listener: (payload: any) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => { ipcRenderer.removeListener(channel, wrapped) }
  },
}

contextBridge.exposeInMainWorld('vn', api)

export type VnApi = typeof api

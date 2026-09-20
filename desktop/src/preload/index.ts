import { contextBridge, ipcRenderer } from 'electron'

/** The renderer's whole surface onto the pipeline. */
const api = {
  status: () => ipcRenderer.invoke('status'),
  jobs: (limit = 50) => ipcRenderer.invoke('jobs', limit),
  configGet: () => ipcRenderer.invoke('config:get'),
  configSet: (payload: unknown) => ipcRenderer.invoke('config:set', payload),
  run: () => ipcRenderer.invoke('run'),
  retry: (id: string) => ipcRenderer.invoke('retry', id),
  importRecording: (path: string) => ipcRenderer.invoke('import', path),
  pickAudio: () => ipcRenderer.invoke('pick-audio'),
  login: () => ipcRenderer.invoke('login'),
  openPath: (path: string) => ipcRenderer.invoke('open-path', path),
  setAutoProcess: (enabled: boolean) => ipcRenderer.invoke('auto-process', enabled),
  on: (channel: 'pipeline:event' | 'login:event' | 'run:state' | 'run:error' | 'recorder:connected', listener: (payload: any) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => { ipcRenderer.removeListener(channel, wrapped) }
  },
}

contextBridge.exposeInMainWorld('vn', api)

export type VnApi = typeof api

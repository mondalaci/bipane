import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BipaneApi } from '@shared/api'
import type {
  DirListing,
  PtyDataEvent,
  PtyExitEvent,
  PtySpawnOptions,
  Result
} from '@shared/types'

const api: BipaneApi = {
  fs: {
    home: () => ipcRenderer.invoke('fs:home'),
    list: (dir: string): Promise<Result<DirListing>> => ipcRenderer.invoke('fs:list', dir),
    open: (target: string) => ipcRenderer.invoke('fs:open', target),
    reveal: (target: string) => ipcRenderer.invoke('fs:reveal', target)
  },
  pty: {
    create: (id: string, options: PtySpawnOptions) =>
      ipcRenderer.invoke('pty:create', id, options),
    write: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.send('pty:kill', id),
    state: (id: string) => ipcRenderer.invoke('pty:state', id),
    onData: (handler: (event: PtyDataEvent) => void) => {
      const listener = (_event: IpcRendererEvent, payload: PtyDataEvent) => handler(payload)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.off('pty:data', listener)
    },
    onExit: (handler: (event: PtyExitEvent) => void) => {
      const listener = (_event: IpcRendererEvent, payload: PtyExitEvent) => handler(payload)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.off('pty:exit', listener)
    }
  },
  win: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (handler: (maximized: boolean) => void) => {
      const listener = (_event: IpcRendererEvent, maximized: boolean) => handler(maximized)
      ipcRenderer.on('window:maximized-change', listener)
      return () => ipcRenderer.off('window:maximized-change', listener)
    }
  }
}

contextBridge.exposeInMainWorld('bipane', api)

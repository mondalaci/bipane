import { BrowserWindow, ipcMain } from 'electron'

function windowFrom(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function registerWindowHandlers(): void {
  ipcMain.handle('window:minimize', (event) => {
    windowFrom(event)?.minimize()
  })

  ipcMain.handle('window:toggle-maximize', (event) => {
    const window = windowFrom(event)
    if (!window) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })

  ipcMain.handle('window:close', (event) => {
    windowFrom(event)?.close()
  })

  ipcMain.handle('window:is-maximized', (event) => {
    return windowFrom(event)?.isMaximized() ?? false
  })
}

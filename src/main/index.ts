import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { registerFsHandlers } from './ipc/fs'
import { killAllSessions, registerPtyHandlers } from './ipc/pty'
import { closeAllWatchers, registerWatchHandlers } from './ipc/watch'
import { registerWindowHandlers } from './ipc/window'

const APP_BACKGROUND = '#1e1e1e'
const APP_ICON = join(import.meta.dirname, '..', '..', 'resources', 'icon.png')

function resolvePreload(): string {
  const candidates = ['index.mjs', 'index.js'].map((file) =>
    join(import.meta.dirname, '..', 'preload', file)
  )
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[1]!
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 420,
    show: false,
    title: 'Bipane',
    backgroundColor: APP_BACKGROUND,
    icon: APP_ICON,
    frame: false,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => window.show())

  const notifyMaximized = (maximized: boolean) => {
    if (window.webContents.isDestroyed()) return
    window.webContents.send('window:maximized-change', maximized)
  }
  window.on('maximize', () => notifyMaximized(true))
  window.on('unmaximize', () => notifyMaximized(false))

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '..', 'renderer', 'index.html'))
  }

  return window
}

registerFsHandlers()
registerPtyHandlers()
registerWatchHandlers()
registerWindowHandlers()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  void app.whenReady().then(() => {
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    killAllSessions()
    closeAllWatchers()
  })
}

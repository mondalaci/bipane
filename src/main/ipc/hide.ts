import { ipcMain } from 'electron'
import { readHideMode, writeHideMode } from '../hideMode'

export function registerHideHandlers(): void {
  ipcMain.handle('hide:get', () => readHideMode())

  ipcMain.handle('hide:set', (_event, enabled: boolean) => {
    writeHideMode(enabled === true)
  })
}

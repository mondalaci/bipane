import { existsSync } from 'node:fs'
import * as os from 'node:os'
import { ipcMain, type WebContents } from 'electron'
import * as pty from 'node-pty'
import type { PtyDataEvent, PtyExitEvent, PtySpawnOptions } from '@shared/types'

interface PtySession {
  id: string
  proc: pty.IPty
  owner: WebContents
}

const sessions = new Map<string, PtySession>()

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE') continue
    if (typeof value === 'string') env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}

function killSession(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  try {
    session.proc.kill()
  } catch {
    // Process already gone.
  }
}

function killSessionsFor(owner: WebContents): void {
  for (const [id, session] of sessions) {
    if (session.owner.id === owner.id) killSession(id)
  }
}

export function registerPtyHandlers(): void {
  ipcMain.handle('pty:create', (event, id: string, options: PtySpawnOptions) => {
    if (sessions.has(id)) return

    const cwd = options.cwd && existsSync(options.cwd) ? options.cwd : os.homedir()
    const proc = pty.spawn(defaultShell(), [], {
      name: 'xterm-256color',
      cols: Math.max(options.cols, 2),
      rows: Math.max(options.rows, 1),
      cwd,
      env: shellEnv()
    })

    const owner = event.sender
    sessions.set(id, { id, proc, owner })

    proc.onData((data) => {
      if (owner.isDestroyed()) return
      owner.send('pty:data', { id, data } satisfies PtyDataEvent)
    })

    proc.onExit(({ exitCode, signal }) => {
      sessions.delete(id)
      if (owner.isDestroyed()) return
      owner.send('pty:exit', { id, exitCode, signal } satisfies PtyExitEvent)
    })

    owner.once('destroyed', () => killSessionsFor(owner))
  })

  ipcMain.on('pty:write', (_event, id: string, data: string) => {
    const session = sessions.get(id)
    if (!session) return
    try {
      session.proc.write(data)
    } catch {
      // Session ended between the write and delivery.
    }
  })

  ipcMain.on('pty:resize', (_event, id: string, cols: number, rows: number) => {
    const session = sessions.get(id)
    if (!session) return
    try {
      session.proc.resize(Math.max(cols, 2), Math.max(rows, 1))
    } catch {
      // Session ended between the resize and delivery.
    }
  })

  ipcMain.on('pty:kill', (_event, id: string) => killSession(id))
}

export function killAllSessions(): void {
  for (const id of [...sessions.keys()]) killSession(id)
}

import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import * as os from 'node:os'
import { ipcMain, type WebContents } from 'electron'
import * as pty from 'node-pty'
import type {
  PtyDataEvent,
  PtyExitEvent,
  PtySpawnOptions,
  PtyStateSnapshot
} from '@shared/types'

interface PtySession {
  id: string
  proc: pty.IPty
  owner: WebContents
  pid: number
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

function readProcessCwd(pid: number): string | null {
  if (process.platform !== 'linux') return null
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

/**
 * True when the shell itself owns the terminal's foreground process group,
 * i.e. it is sitting at a prompt rather than running a child command. That is
 * the only state in which injecting a command is safe.
 */
function isShellAtPrompt(pid: number): boolean {
  if (process.platform !== 'linux') return false
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closing = stat.lastIndexOf(')')
    if (closing < 0) return false

    // Everything after "comm) " starts at field 3 (state); tpgid is field 8.
    const fields = stat.slice(closing + 2).split(' ')
    const tpgid = Number(fields[5])
    return Number.isFinite(tpgid) && tpgid === pid
  } catch {
    return false
  }
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
    sessions.set(id, { id, proc, owner, pid: proc.pid })

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

  ipcMain.handle('pty:state', (_event, id: string): PtyStateSnapshot => {
    const session = sessions.get(id)
    if (!session) return { cwd: null, idle: false }
    return {
      cwd: readProcessCwd(session.pid),
      idle: isShellAtPrompt(session.pid)
    }
  })
}

export function killAllSessions(): void {
  for (const id of [...sessions.keys()]) killSession(id)
}

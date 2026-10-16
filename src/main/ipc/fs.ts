import { promises as fs, type Stats } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ipcMain, shell } from 'electron'
import type { DirEntry, DirListing, EntryKind, Result } from '@shared/types'

function kindFromStats(stats: Stats): EntryKind {
  if (stats.isDirectory()) return 'directory'
  if (stats.isFile()) return 'file'
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isSocket()) return 'socket'
  if (stats.isFIFO()) return 'fifo'
  if (stats.isCharacterDevice() || stats.isBlockDevice()) return 'device'
  return 'unknown'
}

function toFsError(error: unknown): { code: string; message: string } {
  const err = error as NodeJS.ErrnoException
  return {
    code: err.code ?? 'EUNKNOWN',
    message: err.message || 'Unknown filesystem error'
  }
}

async function readEntry(dir: string, name: string): Promise<DirEntry> {
  const full = path.join(dir, name)

  let stats: Stats
  let isSymlink = false
  try {
    stats = await fs.lstat(full)
    isSymlink = stats.isSymbolicLink()
    if (isSymlink) stats = await fs.stat(full)
  } catch {
    stats = await fs.lstat(full)
  }

  let symlinkTarget: string | null = null
  if (isSymlink) {
    try {
      symlinkTarget = await fs.readlink(full)
    } catch {
      symlinkTarget = null
    }
  }

  return {
    name,
    path: full,
    kind: kindFromStats(stats),
    isSymlink,
    symlinkTarget,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode
  }
}

export async function listDirectory(input: string): Promise<DirListing> {
  const dir = path.resolve(input)
  const dirents = await fs.readdir(dir, { withFileTypes: true })

  const settled = await Promise.allSettled(dirents.map((d) => readEntry(dir, d.name)))

  const entries: DirEntry[] = []
  for (const item of settled) {
    if (item.status === 'fulfilled') entries.push(item.value)
  }

  const parent = path.dirname(dir)
  return { path: dir, parent: parent === dir ? null : parent, entries }
}

export function registerFsHandlers(): void {
  ipcMain.handle('fs:home', () => os.homedir())

  ipcMain.handle('fs:list', async (_event, dir: string): Promise<Result<DirListing>> => {
    try {
      return { ok: true, data: await listDirectory(dir) }
    } catch (error) {
      return { ok: false, error: toFsError(error) }
    }
  })

  ipcMain.handle('fs:open', async (_event, target: string) => {
    return shell.openPath(target)
  })

  ipcMain.handle('fs:reveal', (_event, target: string) => {
    shell.showItemInFolder(target)
  })
}

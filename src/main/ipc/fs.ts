import { promises as fs, type Stats } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ipcMain, shell } from 'electron'
import type {
  CopyFailure,
  CopyOutcome,
  DeleteFailure,
  DeleteOutcome,
  DirEntry,
  DirListing,
  EntryKind,
  Result
} from '@shared/types'

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

  ipcMain.handle(
    'fs:rename',
    async (_event, source: string, target: string): Promise<Result<string>> => {
      try {
        if (typeof source !== 'string' || typeof target !== 'string') {
          return { ok: false, error: { code: 'EINVAL', message: 'Invalid rename arguments' } }
        }

        const from = path.resolve(source)
        const to = path.resolve(target)

        if (from === to) return { ok: true, data: to }

        if (from === path.parse(from).root) {
          return {
            ok: false,
            error: { code: 'EPERM', message: 'Refusing to rename a filesystem root' }
          }
        }

        // `rename` would silently clobber an existing target on POSIX, so make
        // the collision an error the pane can surface instead of data loss.
        try {
          await fs.lstat(to)
          return {
            ok: false,
            error: { code: 'EEXIST', message: `"${path.basename(to)}" already exists` }
          }
        } catch {
          // Target is free — proceed.
        }

        await fs.rename(from, to)
        return { ok: true, data: to }
      } catch (error) {
        return { ok: false, error: toFsError(error) }
      }
    }
  )

  ipcMain.handle(
    'fs:copy',
    async (
      _event,
      sources: string[],
      destination: string,
      baseDir: string
    ): Promise<Result<CopyOutcome>> => {
      if (typeof destination !== 'string' || destination.length === 0) {
        return { ok: false, error: { code: 'EINVAL', message: 'No destination directory' } }
      }
      if (!Array.isArray(sources)) {
        return { ok: false, error: { code: 'EINVAL', message: 'Invalid copy arguments' } }
      }

      // A relative destination belongs to the pane being copied from, not to
      // the process working directory — typing `sub` must mean `<pane>/sub`.
      const base =
        typeof baseDir === 'string' && baseDir.length > 0 ? path.resolve(baseDir) : process.cwd()
      const destDir = path.isAbsolute(destination)
        ? path.resolve(destination)
        : path.resolve(base, destination)

      // The field may name a folder that does not exist yet (typically a
      // relative name under the source pane). Create it, so typing `sub` copies
      // into a `sub` folder rather than failing on a missing parent.
      try {
        await fs.mkdir(destDir, { recursive: true })
      } catch (error) {
        return { ok: false, error: toFsError(error) }
      }

      const copied: string[] = []
      const failed: CopyFailure[] = []

      for (const source of sources) {
        if (typeof source !== 'string' || source.length === 0) continue

        const from = path.resolve(source)
        const to = path.join(destDir, path.basename(from))

        try {
          // Never silently clobber: a name that already exists in the
          // destination is reported as a per-entry failure, exactly like
          // rename, so a copy can never overwrite data.
          try {
            await fs.lstat(to)
            failed.push({
              path: from,
              error: {
                code: 'EEXIST',
                message: `"${path.basename(to)}" already exists in "${destDir}"`
              }
            })
            continue
          } catch {
            // Destination is free — proceed.
          }

          // A directory cannot be copied into itself or into one of its own
          // descendants: that would recurse without end.
          if (to.startsWith(from + path.sep)) {
            failed.push({
              path: from,
              error: { code: 'EINVAL', message: 'Cannot copy a directory into itself' }
            })
            continue
          }

          // `recursive` covers directories; symlinks are preserved rather than
          // followed, so a link is copied as a link.
          await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false })
          copied.push(to)
        } catch (error) {
          failed.push({ path: from, error: toFsError(error) })
        }
      }

      return { ok: true, data: { copied, failed, destination: destDir } }
    }
  )

  ipcMain.handle(
    'fs:delete',
    async (_event, targets: string[]): Promise<Result<DeleteOutcome>> => {
      const deleted: string[] = []
      const failed: DeleteFailure[] = []

      for (const target of targets) {
        if (typeof target !== 'string' || target.length === 0) continue
        const resolved = path.resolve(target)
        if (resolved === path.parse(resolved).root) {
          failed.push({
            path: resolved,
            error: { code: 'EPERM', message: 'Refusing to delete a filesystem root' }
          })
          continue
        }
        try {
          // `recursive` handles directories; `force: false` keeps a missing or
          // protected path an error instead of a silent success.
          await fs.rm(resolved, { recursive: true, force: false })
          deleted.push(resolved)
        } catch (error) {
          failed.push({ path: resolved, error: toFsError(error) })
        }
      }

      return { ok: true, data: { deleted, failed } }
    }
  )
}

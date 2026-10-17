export type PanelSide = 'left' | 'right'

export type EntryKind =
  | 'directory'
  | 'file'
  | 'symlink'
  | 'socket'
  | 'fifo'
  | 'device'
  | 'unknown'

export interface DirEntry {
  name: string
  path: string
  kind: EntryKind
  isSymlink: boolean
  symlinkTarget: string | null
  size: number
  mtimeMs: number
  mode: number
}

export interface DirListing {
  path: string
  parent: string | null
  entries: DirEntry[]
}

export interface FsError {
  code: string
  message: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: FsError }

export interface DeleteFailure {
  path: string
  error: FsError
}

/**
 * Deleting a set of paths is best-effort: one unwritable entry must not abort
 * the rest, so the call reports what went through and what did not.
 */
export interface DeleteOutcome {
  deleted: string[]
  failed: DeleteFailure[]
}

export interface PtySpawnOptions {
  cwd: string
  cols: number
  rows: number
}

export interface PtyDataEvent {
  id: string
  data: string
}

export interface PtyExitEvent {
  id: string
  exitCode: number
  signal: number | undefined
}

export interface PtyStateSnapshot {
  cwd: string | null
  idle: boolean
}

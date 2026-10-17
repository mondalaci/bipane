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

/**
 * Pushed to the renderer when a watched directory's contents change on disk, so
 * a pane showing that directory can re-list itself instead of polling. `path` is
 * the resolved directory that was watched, matching `DirListing.path`.
 */
export interface FsChangeEvent {
  path: string
}

/**
 * A regular file read for the viewer. `text` is the file decoded as UTF-8, and
 * `truncated` marks one larger than the viewer's read limit whose tail was
 * dropped rather than loaded. Main refuses non-regular files (directories,
 * sockets, FIFOs, devices) and files that look binary, so a successful read is
 * always something the editor can display.
 */
export interface FileContent {
  path: string
  text: string
  truncated: boolean
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

export interface CopyFailure {
  path: string
  error: FsError
}

/**
 * Copying a set of paths is best-effort for the same reason: a collision or an
 * unreadable entry must not abort the rest, so the call reports `copied`
 * destinations and the `failed` sources with why they did not go through.
 * `destination` is the resolved destination directory, so callers can compare
 * it against a pane's path (a relative destination resolves against the pane
 * that was copied from, not the process working directory).
 */
export interface CopyOutcome {
  copied: string[]
  failed: CopyFailure[]
  destination: string
}

export interface MoveFailure {
  path: string
  error: FsError
}

/**
 * Moving a set of paths is best-effort like copy: a collision or an unreadable
 * entry is reported without aborting the rest. `moved` lists the destination
 * paths that now hold the entries, `failed` the source paths with why they did
 * not go through, and `destination` is the resolved destination directory (a
 * relative destination resolves against the pane moved from).
 */
export interface MoveOutcome {
  moved: string[]
  failed: MoveFailure[]
  destination: string
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

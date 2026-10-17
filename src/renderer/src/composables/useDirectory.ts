import { reactive } from 'vue'
import type { DirEntry, DirListing, PanelSide } from '@shared/types'

export type PaneEntry = DirEntry & { isParent?: boolean }

export type ScrollAlign = 'nearest' | 'start' | 'end'

export interface PaneState {
  side: PanelSide
  path: string
  parent: string | null
  allRows: PaneEntry[]
  entries: PaneEntry[]
  itemCount: number
  cursor: number
  pageRows: number
  scrollAlign: ScrollAlign
  searchActive: boolean
  searchQuery: string
  selected: Set<string>
  loading: boolean
  error: string | null
  /**
   * Path of the entry currently being renamed in place, or null. The row list
   * keys off this to swap the name cell for an input; it is null whenever the
   * pane is not editing.
   */
  renaming: string | null
}

export interface PaneController {
  readonly state: PaneState
  init(): Promise<void>
  navigateTo(dir: string, focusPath?: string): Promise<void>
  refresh(): Promise<void>
  goUp(): Promise<void>
  moveCursor(delta: number): void
  movePage(direction: 1 | -1): void
  moveTo(index: number): void
  activate(): Promise<void>
  current(): PaneEntry | undefined
  isSelected(entry: PaneEntry): boolean
  selectedCount(): number
  setSelected(path: string, value: boolean): void
  toggleSelection(): void
  clearSelection(): void
  selectionTargets(): PaneEntry[]
  deletionTargets(): PaneEntry[]
  copyEntries(destination: string): Promise<string | null>
  deleteEntries(): Promise<void>
  openSearch(): void
  updateSearch(query: string): void
  closeSearch(): void
  beginRename(): void
  cancelRename(): void
  commitRename(name: string): Promise<void>
}

const PARENT_LABEL = '..'

/**
 * The renderer has no `node:path` (contextIsolation is on), but rename only
 * needs the containing directory of an absolute path so it can rebuild the
 * target from the new basename. Both separators are handled so a Windows path
 * still lands in the same folder.
 */
function parentOf(target: string): string {
  const slash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return slash > 0 ? target.slice(0, slash) : target
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === 'directory'
    const bDir = b.kind === 'directory'
    if (aDir !== bDir) return aDir ? -1 : 1
    return collator.compare(a.name, b.name)
  })
}

function toRows(listing: DirListing): PaneEntry[] {
  const sorted = sortEntries(listing.entries)
  if (!listing.parent) return sorted

  const parentRow: PaneEntry = {
    name: PARENT_LABEL,
    path: listing.parent,
    kind: 'directory',
    isSymlink: false,
    symlinkTarget: null,
    size: 0,
    mtimeMs: 0,
    mode: 0,
    isParent: true
  }

  return [parentRow, ...sorted]
}

function countRealRows(rows: PaneEntry[]): number {
  return rows.reduce((count, row) => (row.isParent ? count : count + 1), 0)
}

function firstMatchIndex(rows: PaneEntry[]): number {
  const index = rows.findIndex((row) => !row.isParent)
  return index >= 0 ? index : 0
}

export function useDirectory(side: PanelSide): PaneController {
  const state = reactive<PaneState>({
    side,
    path: '',
    parent: null,
    allRows: [],
    entries: [],
    itemCount: 0,
    cursor: 0,
    pageRows: 10,
    scrollAlign: 'nearest',
    searchActive: false,
    searchQuery: '',
    selected: new Set<string>(),
    loading: false,
    error: null,
    renaming: null
  })

  function current(): PaneEntry | undefined {
    return state.entries[state.cursor]
  }

  function clampCursorTo(value: number): number {
    const last = state.entries.length - 1
    if (last < 0) return 0
    return Math.min(Math.max(value, 0), last)
  }

  function applyFilter(previous: PaneEntry | undefined = current()): void {
    const needle = state.searchQuery.trim().toLowerCase()

    state.entries = needle
      ? state.allRows.filter(
          (row) => row.isParent || row.name.toLowerCase().includes(needle)
        )
      : state.allRows

    state.itemCount = countRealRows(state.entries)

    // With an active query, only a real entry is worth keeping the cursor on:
    // the ".." row survives every filter, so holding it would strand the
    // cursor there instead of landing on the match.
    let preserved = -1
    if (previous && (needle === '' || !previous.isParent)) {
      preserved = state.entries.findIndex((row) => row.path === previous.path)
    }

    state.cursor = preserved >= 0 ? preserved : firstMatchIndex(state.entries)
    state.scrollAlign = 'nearest'
  }

  function openSearch(): void {
    if (state.searchActive) return
    state.searchActive = true
    state.searchQuery = ''
    applyFilter()
  }

  function updateSearch(query: string): void {
    if (!state.searchActive) return
    state.searchQuery = query
    applyFilter()
  }

  function closeSearch(): void {
    if (!state.searchActive) return
    state.searchActive = false
    state.searchQuery = ''
    applyFilter()
  }

  /**
   * Start an in-place rename on the entry under the cursor. A filter is closed
   * first so the row stays in the list, and the ".." row is never renamed.
   */
  function beginRename(): void {
    const entry = current()
    if (!entry || entry.isParent) return
    if (state.searchActive) closeSearch()
    state.renaming = entry.path
  }

  function cancelRename(): void {
    state.renaming = null
  }

  /**
   * Commit the edited name. The argument is the raw input value — the basename
   * the user typed, not a path. An unchanged or empty name is a no-op, and a
   * failure (collision, permissions) surfaces through the pane's error line
   * while leaving the directory untouched.
   */
  async function commitRename(name: string): Promise<void> {
    const source = state.renaming
    state.renaming = null
    if (!source) return

    const next = name.trim()
    if (!next) return
    if (next.includes('/') || next.includes('\\')) {
      state.error = 'EINVAL: A name cannot contain a path separator'
      return
    }
    if (next === '.' || next === '..') {
      state.error = 'EINVAL: Reserved name'
      return
    }

    const target = `${parentOf(source)}/${next}`
    if (target === source) {
      state.error = null
      return
    }

    const result = await window.bipane.fs.rename(source, target)
    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return
    }

    state.error = null
    // Land the cursor on the renamed entry rather than the path it used to
    // have, which no longer exists.
    await navigateTo(state.path, result.data)
  }

  async function navigateTo(dir: string, focusPath?: string): Promise<void> {
    state.loading = true
    state.error = null

    const result = await window.bipane.fs.list(dir)
    state.loading = false

    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return
    }

    const rows = toRows(result.data)
    state.path = result.data.path
    state.parent = result.data.parent
    state.allRows = rows
    state.entries = rows
    state.itemCount = result.data.entries.length
    state.cursor = focusPath ? indexOfPath(rows, focusPath) : 0
    state.scrollAlign = 'nearest'

    // A filter and the marks belong to the directory they were set in.
    state.searchActive = false
    state.searchQuery = ''
    state.selected.clear()
    state.renaming = null
  }

  function indexOfPath(rows: PaneEntry[], target: string): number {
    const index = rows.findIndex((row) => row.path === target)
    return index >= 0 ? index : 0
  }

  /**
   * Re-list the current directory in place. Unlike navigateTo this keeps the
   * cursor on the same entry (matching by path, so it follows a rename-free
   * re-sort) and leaves any active filter alone: a command that adds or removes
   * a file should not also throw away where the user was looking.
   */
  async function refresh(): Promise<void> {
    if (!state.path || state.loading) return

    const result = await window.bipane.fs.list(state.path)
    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return
    }

    const previous = current()
    const rows = toRows(result.data)
    state.error = null
    state.path = result.data.path
    state.parent = result.data.parent
    state.allRows = rows
    applyFilter(previous)
  }

  async function goUp(): Promise<void> {
    if (!state.parent) return
    // Park the cursor on the directory we came from.
    await navigateTo(state.parent, state.path)
  }

  function moveCursor(delta: number): void {
    state.scrollAlign = 'nearest'
    state.cursor = clampCursorTo(state.cursor + delta)
  }

  function movePage(direction: 1 | -1): void {
    const last = state.entries.length - 1
    if (last < 0) return

    const target = state.cursor + direction * Math.max(state.pageRows, 1)
    const clamped = clampCursorTo(target)

    state.cursor = clamped

    if (clamped !== target) {
      // Ran past an end: show the final page rather than leaving it off-screen.
      state.scrollAlign = direction > 0 ? 'end' : 'start'
    } else {
      state.scrollAlign = direction > 0 ? 'start' : 'end'
    }
  }

  function moveTo(index: number): void {
    state.scrollAlign = 'nearest'
    state.cursor = clampCursorTo(index)
  }

  /**
   * Marks are keyed by absolute path, so they survive a re-sort and a refresh
   * of the same directory — navigating to another directory clears them. The
   * ".." row is never selectable.
   */
  function isSelected(entry: PaneEntry): boolean {
    return !entry.isParent && state.selected.has(entry.path)
  }

  function selectedCount(): number {
    return state.selected.size
  }

  function setSelected(path: string, value: boolean): void {
    if (value) state.selected.add(path)
    else state.selected.delete(path)
  }

  function toggleSelection(): void {
    const entry = current()
    if (!entry || entry.isParent) return

    if (state.selected.has(entry.path)) state.selected.delete(entry.path)
    else state.selected.add(entry.path)

    // Marking advances the cursor so a column of files can be picked in one
    // pass, exactly like the classic dual-pane Insert key.
    moveCursor(1)
  }

  function clearSelection(): void {
    if (state.selected.size === 0) return
    state.selected.clear()
  }

  /**
   * What a transfer acts on: the marks if any are set, otherwise the entry
   * under the cursor. The ".." row is never a target, and a filter does not
   * hide a mark — every mark in the pane is used, matched in listing order.
   */
  function selectionTargets(): PaneEntry[] {
    if (state.selected.size > 0) {
      return state.allRows.filter((row) => !row.isParent && state.selected.has(row.path))
    }
    const entry = current()
    return entry && !entry.isParent ? [entry] : []
  }

  function deletionTargets(): PaneEntry[] {
    return selectionTargets()
  }

  /**
   * Copy the pane's targets into `destination`. A relative destination is
   * resolved against this pane's directory, so `sub` means `<pane>/sub` rather
   * than a path next to the app. Best-effort like delete: entries that collide
   * or cannot be read are reported without aborting the rest, and the source
   * listing is re-read in place. Returns the resolved destination directory so
   * the caller can refresh a pane showing it, or null on failure.
   */
  async function copyEntries(destination: string): Promise<string | null> {
    const targets = selectionTargets()
    if (targets.length === 0 || !destination) return null

    const result = await window.bipane.fs.copy(
      targets.map((target) => target.path),
      destination,
      state.path
    )
    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return null
    }

    await refresh()

    if (result.data.failed.length > 0) {
      const [first] = result.data.failed
      if (first) state.error = `${first.error.code}: ${first.error.message}`
    }

    return result.data.destination
  }

  async function deleteEntries(): Promise<void> {
    const targets = deletionTargets()
    if (targets.length === 0) return

    const result = await window.bipane.fs.remove(targets.map((target) => target.path))
    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return
    }

    // Drop the marks that are gone, keep any that failed so a retry still
    // knows what the user meant, then re-list in place.
    for (const removed of result.data.deleted) state.selected.delete(removed)
    await refresh()

    if (result.data.failed.length > 0) {
      const [first] = result.data.failed
      if (first) state.error = `${first.error.code}: ${first.error.message}`
    }
  }

  async function activate(): Promise<void> {
    const entry = current()
    if (!entry) return

    // Resolve the target before dropping the filter: closeSearch keeps the
    // cursor on this entry, but activation must act on what was highlighted.
    if (state.searchActive) closeSearch()

    if (entry.isParent) {
      await goUp()
      return
    }

    if (entry.kind === 'directory') {
      await navigateTo(entry.path)
      return
    }

    const message = await window.bipane.fs.open(entry.path)
    if (message) state.error = message
  }

  async function init(): Promise<void> {
    const home = await window.bipane.fs.home()
    await navigateTo(home)
  }

  return {
    state,
    init,
    navigateTo,
    refresh,
    goUp,
    moveCursor,
    movePage,
    moveTo,
    activate,
    current,
    isSelected,
    selectedCount,
    setSelected,
    toggleSelection,
    clearSelection,
    selectionTargets,
    deletionTargets,
    copyEntries,
    deleteEntries,
    openSearch,
    updateSearch,
    closeSearch,
    beginRename,
    cancelRename,
    commitRename
  }
}

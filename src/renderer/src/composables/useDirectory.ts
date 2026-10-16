import { reactive } from 'vue'
import type { DirEntry, DirListing, PanelSide } from '@shared/types'

export type PaneEntry = DirEntry & { isParent?: boolean }

export type ScrollAlign = 'nearest' | 'start' | 'end'

export interface PaneState {
  side: PanelSide
  path: string
  parent: string | null
  entries: PaneEntry[]
  itemCount: number
  cursor: number
  pageRows: number
  scrollAlign: ScrollAlign
  loading: boolean
  error: string | null
}

export interface PaneController {
  readonly state: PaneState
  init(): Promise<void>
  navigateTo(dir: string, focusPath?: string): Promise<void>
  goUp(): Promise<void>
  moveCursor(delta: number): void
  movePage(direction: 1 | -1): void
  moveTo(index: number): void
  activate(): Promise<void>
  current(): PaneEntry | undefined
}

const PARENT_LABEL = '..'

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

export function useDirectory(side: PanelSide): PaneController {
  const state = reactive<PaneState>({
    side,
    path: '',
    parent: null,
    entries: [],
    itemCount: 0,
    cursor: 0,
    pageRows: 10,
    scrollAlign: 'nearest',
    loading: false,
    error: null
  })

  function current(): PaneEntry | undefined {
    return state.entries[state.cursor]
  }

  function clampCursorTo(value: number): number {
    const last = state.entries.length - 1
    if (last < 0) return 0
    return Math.min(Math.max(value, 0), last)
  }

  function indexOfPath(rows: PaneEntry[], target: string): number {
    const index = rows.findIndex((row) => row.path === target)
    return index >= 0 ? index : 0
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
    state.entries = rows
    state.itemCount = result.data.entries.length
    state.cursor = focusPath ? indexOfPath(rows, focusPath) : 0
    state.scrollAlign = 'nearest'
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

  async function activate(): Promise<void> {
    const entry = current()
    if (!entry) return

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
    goUp,
    moveCursor,
    movePage,
    moveTo,
    activate,
    current
  }
}

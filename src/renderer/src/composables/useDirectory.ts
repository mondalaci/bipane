import { reactive } from 'vue'
import type { DirEntry, PanelSide } from '@shared/types'

export interface PaneState {
  side: PanelSide
  path: string
  parent: string | null
  entries: DirEntry[]
  cursor: number
  loading: boolean
  error: string | null
}

export interface PaneController {
  readonly state: PaneState
  init(): Promise<void>
  navigateTo(dir: string): Promise<void>
  goUp(): Promise<void>
  moveCursor(delta: number): void
  moveTo(index: number): void
  activate(): Promise<void>
  current(): DirEntry | undefined
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

export function useDirectory(side: PanelSide): PaneController {
  const state = reactive<PaneState>({
    side,
    path: '',
    parent: null,
    entries: [],
    cursor: 0,
    loading: false,
    error: null
  })

  function current(): DirEntry | undefined {
    return state.entries[state.cursor]
  }

  function clampCursor(): void {
    const last = state.entries.length - 1
    if (last < 0) {
      state.cursor = 0
      return
    }
    state.cursor = Math.min(Math.max(state.cursor, 0), last)
  }

  async function navigateTo(dir: string): Promise<void> {
    state.loading = true
    state.error = null

    const result = await window.bipane.fs.list(dir)
    state.loading = false

    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return
    }

    state.path = result.data.path
    state.parent = result.data.parent
    state.entries = sortEntries(result.data.entries)
    state.cursor = 0
  }

  async function goUp(): Promise<void> {
    if (!state.parent) return
    await navigateTo(state.parent)
  }

  function moveCursor(delta: number): void {
    state.cursor += delta
    clampCursor()
  }

  function moveTo(index: number): void {
    state.cursor = index
    clampCursor()
  }

  async function activate(): Promise<void> {
    const entry = current()
    if (!entry) return

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

  return { state, init, navigateTo, goUp, moveCursor, moveTo, activate, current }
}

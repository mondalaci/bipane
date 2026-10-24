import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, screen, type BrowserWindow, type Rectangle } from 'electron'

// Where a window opens the first time, and the floor it may be restored to.
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 820

/**
 * How long the window must sit still before its geometry is written out. A
 * resize or a move is a stream of events — dragging a corner emits one per
 * frame — and each one would otherwise cost a whole file, so only the settled
 * position is worth keeping. Deferring the *capture* along with the write is
 * also what makes maximizing safe: the WM resizes the window to the screen
 * before it reports the maximize, so a snapshot taken when the resize arrives
 * would record the screen as the window's normal size. By the time the timer
 * fires the state has settled, and the maximize has been noticed.
 */
const SAVE_DEBOUNCE_MS = 400

interface PersistedWindowState {
  /** The size and place to come back to, i.e. never the maximized rectangle. */
  bounds: Rectangle
  maximized: boolean
}

export interface RestoredWindowState {
  width: number
  height: number
  /** null to let Electron place the window (centred) instead. */
  x: number | null
  y: number | null
  maximized: boolean
}

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function intersects(a: Rectangle, b: Rectangle): boolean {
  return (
    b.x < a.x + a.width &&
    b.x + b.width > a.x &&
    b.y < a.y + a.height &&
    b.y + b.height > a.y
  )
}

function readState(): PersistedWindowState | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<PersistedWindowState>
    const bounds = parsed.bounds
    const numbers = bounds ? [bounds.x, bounds.y, bounds.width, bounds.height] : []
    if (bounds === undefined || !numbers.every((n) => Number.isFinite(n))) return null
    if (bounds.width < 1 || bounds.height < 1) return null
    return { bounds, maximized: parsed.maximized === true }
  } catch {
    // No state yet, or one that cannot be read back: the defaults answer for it.
    return null
  }
}

function writeState(state: PersistedWindowState): void {
  try {
    const file = statePath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state))
  } catch {
    // A state file that cannot be written is not worth failing a resize over;
    // the next save tries again.
  }
}

/**
 * The geometry to open with: what was last saved, unless the display it was on
 * is no longer there. A window restored onto a coordinate no display covers is
 * one the user cannot reach, so its position is dropped — the size is kept,
 * clamped so it still fits wholly on the display that receives it.
 */
export function restoreWindowState(): RestoredWindowState {
  const saved = readState()
  if (!saved) {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, x: null, y: null, maximized: false }
  }

  const { bounds, maximized } = saved
  const host = screen
    .getAllDisplays()
    .find((display) => intersects(display.workArea, bounds))

  if (!host) {
    const { workArea } = screen.getPrimaryDisplay()
    return {
      width: Math.min(bounds.width, workArea.width),
      height: Math.min(bounds.height, workArea.height),
      x: null,
      y: null,
      maximized
    }
  }

  return {
    width: Math.min(bounds.width, host.workArea.width),
    height: Math.min(bounds.height, host.workArea.height),
    x: bounds.x,
    y: bounds.y,
    maximized
  }
}

/**
 * Keep the window's normal geometry and its maximized state on disk, so the
 * next launch opens where the last one was left. Only the *normal* bounds are
 * stored: the maximized state is a flag beside them, so restoring unmaximized
 * still returns the window to the size it had — asking the window for its bounds
 * while it is maximized would answer with the screen.
 */
export function trackWindowState(window: BrowserWindow): void {
  let bounds = window.getNormalBounds()
  let maximized = window.isMaximized()
  let timer: ReturnType<typeof setTimeout> | null = null

  const capture = (): void => {
    if (window.isDestroyed()) return
    const isMaximized = window.isMaximized()
    maximized = isMaximized
    if (!isMaximized && !window.isMinimized() && !window.isFullScreen()) {
      bounds = window.getBounds()
    }
  }

  const write = (): void => {
    timer = null
    capture()
    writeState({ bounds, maximized })
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(write, SAVE_DEBOUNCE_MS)
  }

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    capture()
    writeState({ bounds, maximized })
  }

  window.on('resize', schedule)
  window.on('move', schedule)
  window.on('maximize', flush)
  window.on('unmaximize', flush)
  // The last geometry before the window goes away, so a move made within the
  // debounce window of closing is not the one change that gets lost.
  window.on('close', flush)
}

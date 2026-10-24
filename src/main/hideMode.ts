import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * Whether the hide mode is applied, kept on disk so the choice outlives the
 * window: turning the mode off is a deliberate answer, and having it back on the
 * next launch would make the key press look like it did not stick. It is the
 * *mode* that is remembered, not the folders — a `.mchide` file says what is
 * hidden, this says whether it is left out of the listing at all, and one answer
 * covers every pane.
 */
interface PersistedHideMode {
  enabled: boolean
}

function statePath(): string {
  return join(app.getPath('userData'), 'hide-mode.json')
}

/**
 * Whether the mode was left on. Absent or unreadable state answers `true`, which
 * is what a folder carrying a `.mchide` file is for, so a first launch — and a
 * state file that got mangled — hides rather than reveals.
 */
export function readHideMode(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<PersistedHideMode>
    return parsed.enabled !== false
  } catch {
    return true
  }
}

export function writeHideMode(enabled: boolean): void {
  try {
    const file = statePath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ enabled }))
  } catch {
    // A preference that cannot be written is not worth failing the key press
    // over; the next toggle tries again.
  }
}

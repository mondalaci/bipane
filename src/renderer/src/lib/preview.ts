import { ref } from 'vue'
import { imageMimeFor } from '@shared/image'
import { needsTranscode, videoMimeFor } from '@shared/video'
import type { PaneEntry } from '@renderer/composables/useDirectory'

/**
 * Whether main can transcode what Chromium cannot play itself. Until the answer
 * is in, those files are not treated as previewable at all — which is also the
 * answer when ffmpeg is missing, and what keeps Enter opening such a file in the
 * system's own player rather than displaying nothing.
 */
const transcode = ref(false)

export function canTranscodePreview(): boolean {
  return transcode.value
}

/** Ask main once, early, so the answer is there before a cursor lands on a file. */
export async function loadTranscodeSupport(): Promise<void> {
  transcode.value = await window.bipane.fs.canTranscode()
}

/** What a pane can show of the cursor's row: an image, or a video. */
export type PreviewKind = 'image' | 'video'

/**
 * What a name is previewable as, or null when it is neither. The shared
 * extension maps are the same ones main reads, streams and transcodes by, so a
 * pane only ever asks for something it can be given.
 */
export function previewKindFor(name: string): PreviewKind | null {
  if (imageMimeFor(name)) return 'image'
  if (videoMimeFor(name) !== null) return 'video'
  if (canTranscodePreview() && needsTranscode(name)) return 'video'
  return null
}

/**
 * The row being previewed. It carries the file's size and mtime as well as its
 * path so a preview can be keyed by content: an external rewrite of the same
 * path is a different thing to show, and a slow answer for the old one must not
 * land on the new one.
 */
export interface PreviewTarget {
  kind: PreviewKind
  path: string
  name: string
  size: number
  mtimeMs: number
}

/** The media an entry is, or null when it is a directory, a parent row or not media at all. */
export function previewTargetFor(entry: PaneEntry | null | undefined): PreviewTarget | null {
  if (!entry || entry.isParent || entry.kind !== 'file') return null

  const kind = previewKindFor(entry.name)
  if (kind === null) return null

  return { kind, path: entry.path, name: entry.name, size: entry.size, mtimeMs: entry.mtimeMs }
}

/** The key that identifies a preview by what it shows, not merely by which file it came from. */
export function previewKeyFor(target: PreviewTarget | null): string | null {
  return target ? `${target.path}\u0000${target.size}:${target.mtimeMs}` : null
}

/**
 * Where a playing clip has got to: its position, and its length once that is
 * knowable. A clip that has been transferred to a display is played only there,
 * so its own pane reads this from the display rather than from an element of its
 * own.
 */
export interface PlaybackClock {
  time: number
  length: number | null
}

/**
 * One flash of the on-screen display over a clip — YouTube's feedback for an
 * action on it: a glyph on a pause or a resume, and how far it was stepped on a
 * seek. Its `id` identifies the flash, so repeating an action is a new element
 * that restarts the animation rather than an unchanged one that shows nothing.
 */
export interface OsdFlash {
  kind: 'play' | 'pause' | 'seek'
  /** Seconds stepped: negative back, positive forward. A seek only. */
  delta: number
  id: number
}

/**
 * What one pane asks another to display: the media under *its* cursor, plus how
 * to find the thumbnail that media is already shown as — the box the display
 * grows out of. `animation` changes only when a display should be revealed with
 * that motion, rather than swapped in while the display is already up.
 */
export interface StageRequest {
  target: PreviewTarget
  /**
   * Where the clip had got to in the pane that asked for the display, or null
   * when it was not playing there — a display carries on from there rather than
   * starting the clip over, so that enlarging it is the same clip changing place.
   */
  resumeAt: number | null
  from: () => DOMRect | null
  /**
   * The footer's small preview box at the moment the display is revealed, its
   * bottom edge carried down so a clip's transport grows out from directly below
   * the thumbnail rather than appearing in its final place — the same gesture
   * the picture makes, and one that keeps the bar under it throughout. Null when
   * the pane has no thumbnail to grow from.
   */
  barFrom: () => DOMRect | null
  animation: number
}

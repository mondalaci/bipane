import { imageMimeFor } from '@shared/image'
import { videoMimeFor } from '@shared/video'
import type { PaneEntry } from '@renderer/composables/useDirectory'

/** What a pane can show of the cursor's row: an image, or a video. */
export type PreviewKind = 'image' | 'video'

/**
 * What a name is previewable as, or null when it is neither. The two shared
 * extension maps are the same ones main reads and streams by, so a pane only
 * ever asks for something it can be given.
 */
export function previewKindFor(name: string): PreviewKind | null {
  if (imageMimeFor(name)) return 'image'
  if (videoMimeFor(name)) return 'video'
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
 * What one pane asks another to display: the media under *its* cursor, plus how
 * to find the thumbnail that media is already shown as — the box the display
 * grows out of. `animation` changes only when a display should be revealed with
 * that motion, rather than swapped in while the display is already up.
 */
export interface StageRequest {
  target: PreviewTarget
  from: () => DOMRect | null
  animation: number
}

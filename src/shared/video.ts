/**
 * Extensions a pane will preview in its status bar, mapped to the MIME type its
 * stream must carry. Only containers Chromium demuxes are listed, and the type
 * is the one Chromium will accept for that container rather than the file's
 * literal type: a QuickTime `.mov` here is H.264 or HEVC in an ISOBMFF
 * container, which Chromium plays but only advertises under `video/mp4`, so
 * serving it as `video/quicktime` would have the media pipeline refuse it.
 */
const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg'
}

/**
 * The URL scheme a pane's video preview streams through. The file is never
 * handed over whole — a preview needs one frame, and the file can be a hundred
 * megabytes — so main serves it as a ranged stream and the media element fetches
 * only the metadata and the bytes of the frame it lands on.
 */
export const MEDIA_SCHEME = 'bipane-media'

/**
 * The MIME type for a name that is a previewable video, or null. Shared so the
 * renderer decides what to preview with the same map main serves by — a mismatch
 * would mean a status bar asking for a stream main then refuses.
 */
export function videoMimeFor(name: string): string | null {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0 || dot === lower.length - 1) return null
  return VIDEO_MIME[lower.slice(dot + 1)] ?? null
}

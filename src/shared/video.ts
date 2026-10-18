/**
 * Extensions a pane will preview in its status bar, mapped to the MIME type its
 * stream must carry. Only containers Chromium demuxes and decodes are listed,
 * and the type is the one Chromium will accept for that container rather than
 * the file's literal type: a QuickTime `.mov` here is H.264 or HEVC in an
 * ISOBMFF container, which Chromium plays but only advertises under
 * `video/mp4`, so serving it as `video/quicktime` would have the media pipeline
 * refuse it.
 */
const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg'
}

/**
 * Extensions whose container or codec Chromium's media stack has nothing for:
 * it demuxes neither AVI nor ASF, and decodes neither the motion JPEG of an old
 * camcorder AVI nor the WMV3/VC-1 of an ASF one. Listing them here does not
 * make Chromium play them — nothing can — but it does let main transcode them
 * through ffmpeg, and only where ffmpeg is available to do it.
 */
const TRANSCODE_EXTENSIONS = new Set([
  'avi',
  'divx',
  'wmv',
  'asf',
  'flv',
  'mpg',
  'mpeg',
  'm2ts',
  'mts',
  'vob',
  'rm',
  'rmvb'
])

/**
 * The URL scheme a pane's video preview streams through. The file is never
 * handed over whole — a preview plays a clip, and the file can be a hundred
 * megabytes — so main serves it as a ranged stream and the media element fetches
 * only what it plays.
 */
export const MEDIA_SCHEME = 'bipane-media'

function extensionOf(name: string): string | null {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0 || dot === lower.length - 1) return null
  return lower.slice(dot + 1)
}

/**
 * The MIME type for a name Chromium can play on its own, or null. Shared so the
 * renderer decides what to preview with the same map main serves by — a mismatch
 * would mean a status bar asking for a stream main then refuses.
 */
export function videoMimeFor(name: string): string | null {
  const extension = extensionOf(name)
  return extension === null ? null : (VIDEO_MIME[extension] ?? null)
}

/** Whether a name is a video only ffmpeg can make playable. */
export function needsTranscode(name: string): boolean {
  const extension = extensionOf(name)
  return extension !== null && TRANSCODE_EXTENSIONS.has(extension)
}

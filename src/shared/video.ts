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
 * Extensions whose video codec only the file's own header can tell: the ISOBMFF
 * containers, which is where a stream Chromium cannot decode turns up inside a
 * container Chromium demuxes — a phone's HEVC `.mp4`, a camera's `.mov`. The
 * other containers Chromium demuxes hold the codecs its own parsers were written
 * for, so there is nothing about one of them to ask the file.
 */
const SNIFFABLE_EXTENSIONS = new Set(['mp4', 'm4v', 'mov'])

/**
 * Whether a name is one whose stream has to be read out of its header before it
 * is known to be playable. Shared so the renderer asks about, and main reads,
 * exactly the same files — the containers that carry a codec no name can tell.
 */
export function videoCodecSniffable(name: string): boolean {
  const extension = extensionOf(name)
  return extension !== null && SNIFFABLE_EXTENSIONS.has(extension)
}

/**
 * The video codecs Chromium's own media stack decodes: H.264 under both of its
 * sample-entry spellings, VP8, VP9 and AV1. Everything else a container can
 * hold — the HEVC of a phone recording, ProRes, Dolby Vision, MPEG-4 part 2 —
 * is a stream Chromium demuxes but cannot decode, and one it decodes only
 * through a platform decoder is no use either: on Linux that decoder *is* the
 * hardware one this app turns off (see `src/main/index.ts`), which is where an
 * HEVC `.mp4` ends up playing its sound over a black picture.
 */
const DECODABLE_VIDEO_CODECS = new Set(['avc1', 'avc3', 'vp08', 'vp09', 'av01'])

/**
 * Whether a stream inside a container Chromium demuxes has to be encoded for
 * it to play. Null is not an accusation: a codec this cannot name — a header
 * it could not read, a file whose video track is not where it looked — leaves
 * the file served as it stands, exactly as it was before anything was sniffed.
 */
export function codecNeedsTranscode(codec: string | null): boolean {
  return codec !== null && !DECODABLE_VIDEO_CODECS.has(codec)
}

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

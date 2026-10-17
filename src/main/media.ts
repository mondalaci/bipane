import { createReadStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { MEDIA_SCHEME, videoMimeFor } from '@shared/video'

/**
 * A range of bytes a media element asked for.
 */
interface ByteRange {
  start: number
  end: number
}

/**
 * The scheme a video preview streams through, registered before the app is
 * ready (Electron requires it then). `stream` is what makes a response a stream
 * the media stack reads incrementally rather than one buffered body, and
 * `standard` gives the scheme the URL parsing a media element expects.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
    }
  ])
}

/**
 * The requested file, or null if the URL does not name one. The path travels in
 * a query parameter rather than as the pathname: a `standard` scheme's pathname
 * is normalised and percent-decoded by the URL parser, which mangles an
 * absolute path (`//`, `%2F`, and friends) often enough to not risk it.
 */
function mediaPathFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const target = parsed.searchParams.get('path')
  return target !== null && target.startsWith('/') ? target : null
}

/**
 * A single `bytes=` range, or null when the header is absent or does not
 * describe a satisfiable range (the caller answers 416 for a present header).
 */
function parseRange(header: string | null, size: number): ByteRange | null {
  if (header === null) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart = '', rawEnd = ''] = match
  if (rawStart === '' && rawEnd === '') return null

  let start: number
  let end: number
  if (rawStart === '') {
    // A suffix range: the last N bytes, which is how a player finds a `moov`
    // atom queued at the end of the file.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start > end || start >= size) return null
  return { start, end }
}

/**
 * Serve a previewable video as a byte stream, honouring Range requests. This is
 * what lets a status bar show a frame of a hundred-megabyte file: the media
 * element asks for the metadata and then for the bytes around the frame it
 * lands on, and nothing else is read. Only regular files with a previewable
 * extension are served, so this cannot be turned into a reader for anything the
 * bar would not have offered anyway.
 */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const target = mediaPathFromUrl(request.url)
    if (target === null) return new Response('Bad request', { status: 400 })

    const mime = videoMimeFor(target)
    if (mime === null) return new Response('Not previewable', { status: 403 })

    let size: number
    try {
      const stats = await fs.stat(target)
      if (!stats.isFile()) return new Response('Not a file', { status: 403 })
      size = stats.size
    } catch {
      return new Response('Not found', { status: 404 })
    }

    const rangeHeader = request.headers.get('range')
    const range = parseRange(rangeHeader, size)
    if (rangeHeader !== null && range === null) {
      return new Response('Range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` }
      })
    }

    const head = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      // A preview is of a file the user is looking at right now, and it can
      // change under us; nothing here is worth a cache.
      'Cache-Control': 'no-store'
    }

    const body = (start: number, end: number): ReadableStream =>
      Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream

    if (range === null) {
      const headers = { ...head, 'Content-Length': String(size) }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(body(0, size - 1), { status: 200, headers })
    }

    const headers = {
      ...head,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': String(range.end - range.start + 1)
    }
    if (request.method === 'HEAD') return new Response(null, { status: 206, headers })
    return new Response(body(range.start, range.end), { status: 206, headers })
  })
}

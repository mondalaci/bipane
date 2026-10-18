import { createHash } from 'node:crypto'
import { createReadStream, promises as fs, rmSync, type Stats } from 'node:fs'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { spawn, type ChildProcess } from 'node:child_process'
import { app, ipcMain, protocol } from 'electron'
import { MEDIA_SCHEME, needsTranscode, videoMimeFor } from '@shared/video'

/**
 * A range of bytes a media element asked for.
 */
interface ByteRange {
  start: number
  end: number
}

/**
 * Where ffmpeg is looked for. Beside `PATH`, an explicit path can be given, for
 * a machine that keeps it somewhere the app's environment does not.
 */
const FFMPEG = process.env['BIPANE_FFMPEG'] ?? 'ffmpeg'

/** Where ffprobe is looked for, which is what can say how long a clip is. */
const FFPROBE = process.env['BIPANE_FFPROBE'] ?? 'ffprobe'

/**
 * How much of a clip a transcode covers, and how wide its output may be. Both
 * are what keep the work proportionate to a *preview*: the clip is stepping
 * distance for the arrow keys, so it has to cover what a person would scrub
 * through — a camcorder AVI is minutes long, and a twenty-second clip made every
 * step land on its end — but not the whole of a feature-length file, which is
 * neither worth encoding to fill a 64px box nor worth keeping in the temp
 * directory. The width cap keeps the encode small: a 4K source is encoded at
 * 720px at most, which the panes scale down anyway.
 */
const TRANSCODE_SECONDS = 300
const TRANSCODE_MAX_WIDTH = 720

/**
 * A transcode that has not finished by now is a transcode to give up on — a
 * stuck ffmpeg would otherwise hold a preview's request open forever. It is a
 * guard against a hang, not a performance budget: a long clip in a heavy codec
 * is allowed to take a while.
 */
const TRANSCODE_TIMEOUT_MS = 600_000

/**
 * How many transcoded clips are kept, and how much of the temp directory they
 * may take between them. A few small encodes are what makes stepping back and
 * forth over a folder of old AVIs free rather than a transcode a row; the byte
 * budget is for the long clips, whose encodes are not small.
 */
const TRANSCODE_CACHE_ENTRIES = 12
const TRANSCODE_CACHE_BYTES = 200 * 1024 * 1024

/**
 * How often a response waiting on an encode in progress looks for the next of
 * it. Small enough to keep a stream fed, large enough not to spin on a stat.
 */
const TRANSCODE_POLL_MS = 40

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
 * Serve a file on disk as a byte stream, honouring Range requests — which is
 * what lets a status bar play a hundred-megabyte file: the media element asks
 * for the metadata and then for the bytes it plays, and nothing else is read.
 */
function serveFile(
  target: string,
  mime: string,
  size: number,
  rangeHeader: string | null,
  method: string
): Response {
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
    // A preview is of a file the user is looking at right now, and it can change
    // under us; nothing here is worth a cache.
    'Cache-Control': 'no-store'
  }

  if (size === 0) return new Response(null, { status: 200, headers: head })

  const body = (start: number, end: number): ReadableStream =>
    Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream

  if (range === null) {
    const headers = { ...head, 'Content-Length': String(size) }
    if (method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(body(0, size - 1), { status: 200, headers })
  }

  const headers = {
    ...head,
    'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    'Content-Length': String(range.end - range.start + 1)
  }
  if (method === 'HEAD') return new Response(null, { status: 206, headers })
  return new Response(body(range.start, range.end), { status: 206, headers })
}

/**
 * Whether ffmpeg is there to transcode with. Asked once and remembered: the
 * answer decides whether the containers Chromium cannot demux are previewable
 * at all, and a missing binary is not going to appear mid-session.
 */
let available: Promise<boolean> | null = null

export function ffmpegAvailable(): Promise<boolean> {
  if (available !== null) return available
  available = new Promise<boolean>((resolve) => {
    const child = spawn(FFMPEG, ['-version'], { stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
  return available
}

/** Where this run's transcodes go, thrown away when the app is. */
let transcodeDir: string | null = null

/** Completed transcodes, by the identity of what they were made from. */
const transcodes = new Map<string, { path: string; bytes: number }>()

/** Transcodes still being written, so every request about a clip joins one run. */
const running = new Map<string, Transcode>()

const children = new Set<ChildProcess>()

/**
 * This run's transcode directory, made on first use. Any directory a previous
 * run left behind is removed first: the app holds a single-instance lock, so
 * none of them can belong to another instance still running.
 */
async function transcodeDirectory(): Promise<string> {
  if (transcodeDir !== null) return transcodeDir

  const root = app.getPath('temp')
  const mine = `bipane-media-${process.pid}`
  try {
    for (const entry of await fs.readdir(root)) {
      if (!entry.startsWith('bipane-media-')) continue
      await fs.rm(path.join(root, entry), { recursive: true, force: true })
    }
  } catch {
    // Sweeping is housekeeping; failing it must not stop a preview.
  }

  const dir = path.join(root, mine)
  await fs.mkdir(dir, { recursive: true })
  transcodeDir = dir
  return dir
}

/** An encode in progress: where it is being written, and when it is finished. */
interface Transcode {
  path: string
  done: Promise<void>
}

/**
 * Transcode a clip to something Chromium plays, streaming it out as it is
 * produced rather than waiting for the whole of it. A preview must not sit on a
 * black box while a three-minute clip is decoded to its end — the first
 * fragments are playable, so they are what the element is handed, and the encode
 * carries on behind it.
 *
 * The encode is deliberately modest: H.264 at most 720px wide, at most five
 * minutes of it, and no audio at all (a preview never makes a sound).
 */
function startTranscode(target: string, key: string, path: string): Transcode {
  const child = spawn(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      target,
      '-t',
      String(TRANSCODE_SECONDS),
      '-an',
      '-vf',
      `scale='min(${TRANSCODE_MAX_WIDTH},iw)':-2`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '26',
      '-pix_fmt',
      'yuv420p',
      // A keyframe often enough that the first playable fragment arrives within
      // a fraction of a second, and a fragmented file so later fragments can
      // follow it down the same response — a plain mp4 has no header until the
      // encode ends, so nothing of it could be played early at all.
      '-g',
      '30',
      '-movflags',
      '+empty_moov+default_base_moof+frag_keyframe',
      '-flush_packets',
      '1',
      '-f',
      'mp4',
      path
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  children.add(child)

  const timer = setTimeout(() => child.kill('SIGKILL'), TRANSCODE_TIMEOUT_MS)
  let complaint = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    complaint = (complaint + chunk.toString()).slice(-500)
  })

  const done = (async () => {
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', () => resolve(null))
      child.once('close', (status) => resolve(status))
    })
    clearTimeout(timer)
    children.delete(child)

    if (code !== 0) {
      if (complaint.trim() !== '') console.error(`[media] ffmpeg: ${complaint.trim()}`)
      // A half-written file is not a preview of anything.
      await fs.rm(path, { force: true }).catch(() => {})
      return
    }

    try {
      const { size } = await fs.stat(path)
      transcodes.delete(key)
      transcodes.set(key, { path, bytes: size })
      let kept = 0
      for (const entry of transcodes.values()) kept += entry.bytes
      while (transcodes.size > TRANSCODE_CACHE_ENTRIES || kept > TRANSCODE_CACHE_BYTES) {
        const oldest = transcodes.keys().next()
        if (oldest.done) break
        const stale = transcodes.get(oldest.value)
        transcodes.delete(oldest.value)
        kept -= stale?.bytes ?? 0
        // Unlinking a file another response is still reading is safe: the
        // descriptor it holds outlives the name.
        if (stale !== undefined) await fs.rm(stale.path, { force: true }).catch(() => {})
      }
    } catch {
      // Nothing to remember if the file cannot even be measured.
    }
  })()

  return { path, done }
}

/**
 * The encode for a clip: the one already running, or a new one. One encode per
 * clip however many elements ask for it — a display and a footer showing the
 * same file are one job, not two.
 */
async function transcodeFor(target: string, key: string): Promise<Transcode> {
  const started = running.get(key)
  if (started !== undefined) return started

  const dir = await transcodeDirectory()
  const name = createHash('sha1').update(key).digest('hex').slice(0, 16)
  const job = startTranscode(target, key, path.join(dir, `${name}.mp4`))
  running.set(key, job)
  void job.done.finally(() => running.delete(key))
  return job
}

/**
 * Yield what has been written so far, and go on doing it until the encode is
 * finished and there is nothing more to come — which is what makes a response
 * carry the first playable fragments while the rest of the clip is still being
 * encoded.
 */
async function* followTranscode(path: string, isDone: () => boolean): AsyncGenerator<Buffer> {
  let offset = 0
  for (;;) {
    let size = 0
    try {
      size = (await fs.stat(path)).size
    } catch {
      // Not written yet, or taken away again by a failed encode.
    }

    if (size > offset) {
      for await (const chunk of createReadStream(path, { start: offset, end: size - 1 })) {
        yield chunk as Buffer
      }
      offset = size
      continue
    }

    if (isDone()) return
    await new Promise((resolve) => setTimeout(resolve, TRANSCODE_POLL_MS))
  }
}

/** What identifies a clip's encode: what it was made from, down to its contents. */
function transcodeKey(target: string, stats: Stats): string {
  return `${target}\u0000${stats.mtimeMs}:${stats.size}`
}

/**
 * Serve a clip Chromium cannot play itself. Once its encode is complete the
 * whole file is there and goes out as an ordinary seekable stream; until then
 * the encode is streamed as it is written, so playing starts with the first
 * fragments rather than after the last.
 */
async function serveTranscode(
  target: string,
  key: string,
  rangeHeader: string | null,
  method: string
): Promise<Response> {
  const complete = transcodes.get(key)
  if (complete !== undefined) {
    try {
      await fs.access(complete.path)
      return serveFile(complete.path, 'video/mp4', complete.bytes, rangeHeader, method)
    } catch {
      transcodes.delete(key)
    }
  }

  const job = await transcodeFor(target, key)

  let done = false
  void job.done.then(() => {
    done = true
  })

  const head = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' }
  if (method === 'HEAD') return new Response(null, { status: 200, headers: head })

  // No length and no ranges: what is on its way is not a file yet, and a player
  // that is handed a growing stream plays it as one.
  const body = Readable.from(followTranscode(job.path, () => done))
  return new Response(Readable.toWeb(body) as ReadableStream, { status: 200, headers: head })
}

/**
 * Stop every transcode still running and throw this run's clips away. Called as
 * the app quits, so a preview in flight cannot outlive the window that asked
 * for it. The removal is synchronous on purpose: this runs on the way out, and
 * a directory left to delete itself in the background outlives the process that
 * was going to wait for it.
 */
export function killAllTranscodes(): void {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  transcodes.clear()
  running.clear()
  durations.clear()
  if (transcodeDir !== null) {
    try {
      rmSync(transcodeDir, { recursive: true, force: true })
    } catch {
      // A directory that will not go is swept by the next run anyway.
    }
    transcodeDir = null
  }
}

/** How long a preview of each file is, by the identity of the file. */
const durations = new Map<string, number | null>()

/**
 * How long the clip a preview will play is: the file's own length, or as much of
 * it as the encode covers (the bar steps through what is played, not what is on
 * disk), read by ffprobe rather than off the element — a clip that is still being
 * encoded arrives as a live stream, and a stream has no length to report until
 * it is over. Null when nothing can say.
 */
async function videoDuration(target: string): Promise<number | null> {
  let stats: Stats
  try {
    stats = await fs.stat(target)
    if (!stats.isFile()) return null
  } catch {
    return null
  }

  const key = transcodeKey(target, stats)
  const known = durations.get(key)
  if (known !== undefined) return known

  const child = spawn(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', target],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  children.add(child)

  let printed = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    printed = (printed + chunk.toString()).slice(-64)
  })

  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.once('close', (status) => {
      clearTimeout(timer)
      resolve(status)
    })
  })
  children.delete(child)

  const seconds = Number.parseFloat(printed.trim())
  const length =
    code === 0 && Number.isFinite(seconds) && seconds > 0
      ? Math.min(seconds, TRANSCODE_SECONDS)
      : null

  durations.set(key, length)
  return length
}

/**
 * Answer whether this build can transcode, which is what decides whether a
 * container Chromium has nothing for is previewable at all — and, since only
 * such a clip needs its length read for it, what it can say about durations.
 */
export function registerMediaHandlers(): void {
  ipcMain.handle('fs:can-transcode', () => ffmpegAvailable())
  ipcMain.handle('fs:video-duration', async (_event, target: string): Promise<number | null> => {
    if (typeof target !== 'string' || target.length === 0) return null
    if (!(await ffmpegAvailable())) return null
    try {
      return await videoDuration(target)
    } catch {
      return null
    }
  })
}

/**
 * Serve a previewable video. A clip Chromium demuxes and decodes goes over as
 * its own bytes, ranged; anything else only ffmpeg can make playable is
 * transcoded first, and refused outright when there is no ffmpeg to do it with.
 * Either way only regular files with a previewable extension are served, so this
 * cannot be turned into a reader for anything the bar would not have offered.
 */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const target = mediaPathFromUrl(request.url)
    if (target === null) return new Response('Bad request', { status: 400 })

    const mime = videoMimeFor(target)
    const transcode = mime === null && needsTranscode(target)
    if (mime === null && !transcode) return new Response('Not previewable', { status: 403 })

    let stats: Stats
    try {
      stats = await fs.stat(target)
      if (!stats.isFile()) return new Response('Not a file', { status: 403 })
    } catch {
      return new Response('Not found', { status: 404 })
    }

    const rangeHeader = request.headers.get('range')
    if (mime !== null) return serveFile(target, mime, stats.size, rangeHeader, request.method)

    if (!(await ffmpegAvailable())) {
      return new Response('No transcoder available', { status: 501 })
    }
    return serveTranscode(target, transcodeKey(target, stats), rangeHeader, request.method)
  })
}

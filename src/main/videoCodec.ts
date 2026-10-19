import { constants as fsConstants, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

/**
 * The video codec inside a container Chromium demuxes, read out of the file's
 * own header.
 *
 * An extension says a file is a video; it does not say the stream inside it is
 * one Chromium can decode. An `.mp4` from a phone is HEVC, and HEVC reaches
 * Chromium only through a platform decoder — the hardware video decoder this
 * app turns off, for reasons of its own (see `src/main/index.ts`) — so such a
 * file plays its sound and draws nothing. The container is fine and the
 * demuxer is Chromium's; only the stream needs ffmpeg, exactly like an AVI.
 * This is what tells the two apart, so the encode path can be reached for a
 * container that needs no demuxing.
 *
 * Only ISOBMFF (`mp4`, `m4v`, `mov`) is read. Those are the containers that
 * carry HEVC, ProRes and Dolby Vision in the wild — a phone recording, a
 * camera's `.mov` — while a WebM holds the codecs Chromium's own Matroska
 * parser was written for. A container this cannot read answers null, which the
 * caller takes as "nothing known against it": the file is served as it stands,
 * which is what it would have been anyway.
 */

/** A box's payload, its header excluded: where its own boxes or fields start. */
interface Box {
  start: number
  /** One past the box's last byte. */
  end: number
}

function u32be(b: Buffer, o: number): number {
  return (
    (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0
  )
}

/**
 * A 64-bit box length as a JavaScript number. A box big enough to need more
 * than 53 bits of it is a file no one is previewing, and the walk stops on it
 * rather than pretending to follow it.
 */
function u64be(b: Buffer, o: number): number {
  const high = u32be(b, o)
  if (high > 0x1fffff) return Number.NaN
  return high * 2 ** 32 + u32be(b, o + 4)
}

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  const { bytesRead } = await handle.read(buffer, 0, length, offset)
  return buffer.subarray(0, bytesRead)
}

/** The four-character type at `o`, or null if the bytes run out before it ends. */
function fourcc(b: Buffer, o: number): string | null {
  if (o < 0 || o + 4 > b.length) return null
  return b.toString('latin1', o, o + 4)
}

/**
 * Walk the boxes between `from` and `to` looking for `wanted`, and answer its
 * payload — the bytes inside it. Only each box's own header is read, so the
 * cost is a handful of reads however large the file is: `moov` sits at the end
 * of anything written without fast-start, after a `mdat` of any size, which is
 * what rules out reading a prefix of the file instead.
 */
async function findBox(
  handle: FileHandle,
  from: number,
  to: number,
  wanted: string
): Promise<Box | null> {
  let offset = from
  while (offset + 8 <= to) {
    const head = await readAt(handle, offset, 16)
    if (head.length < 8) return null

    const size = u32be(head, 0)
    const type = fourcc(head, 4)
    if (type === null) return null

    let length: number
    let header: number
    if (size === 1) {
      length = u64be(head, 8)
      header = 16
    } else if (size === 0) {
      // The box runs to the end of its parent, which is how a `mdat` of
      // unknown length is written.
      length = to - offset
      header = 8
    } else {
      length = size
      header = 8
    }

    if (!Number.isFinite(length) || length < header || offset + length > to) return null
    if (type === wanted) return { start: offset + header, end: offset + length }
    offset += length
  }
  return null
}

/**
 * The codec of the first video track — `trak` whose handler is `vide` — the
 * `stsd` sample description of which names it. Null when the file is not
 * ISOBMFF, holds no video track this can follow, or is malformed anywhere on
 * the way: a header read that fails is not an error to report, only nothing
 * known about the file.
 */
export async function readVideoCodec(handle: FileHandle, size: number): Promise<string | null> {
  try {
    const moov = await findBox(handle, 0, size, 'moov')
    if (moov === null) return null

    let track = moov.start
    for (;;) {
      const trak = await findBox(handle, track, moov.end, 'trak')
      if (trak === null) return null
      track = trak.end

      const mdia = await findBox(handle, trak.start, trak.end, 'mdia')
      if (mdia === null) continue

      const hdlr = await findBox(handle, mdia.start, mdia.end, 'hdlr')
      // `hdlr` is version and flags, then the handler type — `soun`, `vide`,
      // `meta` and friends.
      const handler = hdlr === null ? null : fourcc(await readAt(handle, hdlr.start + 8, 4), 0)
      if (handler !== 'vide') continue

      const minf = await findBox(handle, mdia.start, mdia.end, 'minf')
      const stbl = minf === null ? null : await findBox(handle, minf.start, minf.end, 'stbl')
      const stsd = stbl === null ? null : await findBox(handle, stbl.start, stbl.end, 'stsd')
      if (stsd === null) return null

      // `stsd` is version and flags, an entry count, then the entries — each a
      // box of its own whose type is the codec.
      const entry = await readAt(handle, stsd.start + 8, 16)
      if (entry.length < 8) return null
      return fourcc(entry, 4)
    }
  } catch {
    return null
  }
}

/**
 * The codec of the video track in a file on disk, or null for anything this
 * cannot answer — a file that is not there, not regular, gone between being
 * looked at and being opened, or whose header does not say. Remembered by the
 * identity of the file (path, size and mtime), because the answer is asked for
 * twice: once by the pane deciding how to show the row, and again by the
 * request that serves it.
 */
const codecs = new Map<string, string | null>()

export async function videoCodecOf(target: string): Promise<string | null> {
  try {
    const stats = await fs.stat(target)
    if (!stats.isFile()) return null

    const key = `${target}\u0000${stats.mtimeMs}:${stats.size}`
    const known = codecs.get(key)
    if (known !== undefined) return known

    // Opened non-blocking so a FIFO that has replaced the file cannot hold the
    // handler open; the `stat` above already refused anything not a file.
    const handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
    try {
      const codec = await readVideoCodec(handle, stats.size)
      codecs.set(key, codec)
      return codec
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

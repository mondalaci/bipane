import type { PixelSize } from '@shared/types'

/**
 * Pixel dimensions read out of an image file's header, without decoding it.
 *
 * The status bar wants the shape of an image before it has the image, so it can
 * reserve exactly the right box (and show a placeholder) instead of resizing
 * when the picture lands. Decoding would be the obvious way to learn this, but
 * it is the expensive part — and for a large file it is exactly what the
 * preview is already busy with. Every format here stores its dimensions in the
 * first few hundred bytes, so a prefix of the file is enough.
 *
 * Only formats the renderer previews are handled. A format whose header this
 * cannot read (AVIF, say) answers null, which the caller treats as "no shape
 * known" rather than an error: the preview still loads, it just cannot be
 * reserved ahead of it.
 */

function size(width: number, height: number): PixelSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

function u16be(b: Buffer, o: number): number {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)
}

function u16le(b: Buffer, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
}

function u24le(b: Buffer, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16)
}

function u32be(b: Buffer, o: number): number {
  return (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0
}

function u32le(b: Buffer, o: number): number {
  return (((b[o + 3] ?? 0) << 24) | ((b[o + 2] ?? 0) << 16) | ((b[o + 1] ?? 0) << 8) | (b[o] ?? 0)) >>> 0
}

function matches(b: Buffer, o: number, text: string): boolean {
  if (o < 0 || o + text.length > b.length) return false
  for (let i = 0; i < text.length; i += 1) {
    if (b[o + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/** PNG and APNG: the IHDR chunk always sits first, at a fixed offset. */
function pngSize(b: Buffer): PixelSize | null {
  if (!matches(b, 0, '\x89PNG\r\n\x1a\n') || !matches(b, 12, 'IHDR')) return null
  return size(u32be(b, 16), u32be(b, 20))
}

/** GIF: the logical screen descriptor, right after the six-byte signature. */
function gifSize(b: Buffer): PixelSize | null {
  if (!matches(b, 0, 'GIF87a') && !matches(b, 0, 'GIF89a')) return null
  return size(u16le(b, 6), u16le(b, 8))
}

/** BMP: BITMAPCOREHEADER carries 16-bit fields, BITMAPINFOHEADER 32-bit ones. */
function bmpSize(b: Buffer): PixelSize | null {
  if (!matches(b, 0, 'BM')) return null
  const header = u32le(b, 14)
  if (header === 12) return size(u16le(b, 18), u16le(b, 20))
  // A negative height means a top-down bitmap.
  return size(u32le(b, 18), Math.abs(u32le(b, 22) | 0))
}

/** ICO: the first directory entry, where 0 stands for the 256px cap. */
function icoSize(b: Buffer): PixelSize | null {
  if (b.length < 22) return null
  if (u16le(b, 0) !== 0 || u16le(b, 2) !== 1 || u16le(b, 4) < 1) return null
  return size(b[6] === 0 ? 256 : (b[6] ?? 0), b[7] === 0 ? 256 : (b[7] ?? 0))
}

function webpSize(b: Buffer): PixelSize | null {
  if (!matches(b, 0, 'RIFF') || !matches(b, 8, 'WEBP')) return null

  // Lossy: a 3-byte frame tag, the start code, then two 14-bit dimensions.
  if (matches(b, 12, 'VP8 ')) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return size(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff)
  }

  // Lossless: one signature byte then 14 bits of width-1 and height-1.
  if (matches(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return null
    const bits = u32le(b, 21)
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }

  // Extended: the canvas size, 24 bits each, minus one.
  if (matches(b, 12, 'VP8X')) {
    return size(u24le(b, 24) + 1, u24le(b, 27) + 1)
  }

  return null
}

/**
 * EXIF orientation, so a rotation tag is not mistaken for the image being
 * sideways: the browser applies the tag when it paints, and a preview reserved
 * from the unrotated dimensions would be the wrong shape. The tag lives in
 * IFD0 of the TIFF header that follows the `Exif\0\0` marker.
 */
function exifOrientation(b: Buffer, tiff: number): number | null {
  let little: boolean
  if (matches(b, tiff, 'II')) little = true
  else if (matches(b, tiff, 'MM')) little = false
  else return null

  const u16 = (o: number): number => (little ? u16le(b, o) : u16be(b, o))
  const u32 = (o: number): number => (little ? u32le(b, o) : u32be(b, o))

  if (u16(tiff + 2) !== 42) return null

  const ifd = tiff + u32(tiff + 4)
  const count = u16(ifd)
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > b.length) return null
    // The tag is stored in the header's own byte order, so compare the value.
    if (u16(entry) === 0x0112) return u16(entry + 8)
  }
  return null
}

/** JPEG: walk the segments to the first SOF, which carries the frame size. */
function jpegSize(b: Buffer): PixelSize | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null

  let orientation = 1
  let o = 2
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) {
      o += 1
      continue
    }
    const marker = b[o + 1] ?? 0
    if (marker === 0xff) {
      o += 1
      continue
    }
    o += 2

    // Standalone markers carry no payload; SOS and EOI end the metadata.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (marker === 0xd9 || marker === 0xda) return null

    const length = u16be(b, o)
    if (length < 2) return null
    const payload = o + 2

    // SOF0..SOF15 except DHT, JPG and DAC, which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16be(b, payload + 1)
      const width = u16be(b, payload + 3)
      const rotated = orientation >= 5 && orientation <= 8
      return size(rotated ? height : width, rotated ? width : height)
    }

    if (marker === 0xe1 && matches(b, payload, 'Exif\0\0')) {
      orientation = exifOrientation(b, payload + 6) ?? 1
    }

    o += length
  }

  return null
}

/**
 * SVG: width/height attributes when they are absolute, otherwise the viewBox.
 * A percentage width says nothing on its own, so the viewBox is preferred there.
 */
function svgSize(b: Buffer): PixelSize | null {
  const text = b.toString('utf8', 0, Math.min(b.length, 8192))
  if (!/<svg[\s>]/i.test(text)) return null

  const attribute = (name: string): number | null => {
    const match = new RegExp(
      `\\b${name}\\s*=\\s*["']\\s*([\\d.]+)(?:px|pt)?\\s*["']`,
      'i'
    ).exec(text)
    return match ? Number.parseFloat(match[1]!) : null
  }

  const width = attribute('width')
  const height = attribute('height')
  if (width !== null && height !== null) return size(width, height)

  const viewBox = /viewBox\s*=\s*["']\s*[-\d.eE]+[\s,]+[-\d.eE]+[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)/i.exec(
    text
  )
  if (!viewBox) return null
  return size(Number.parseFloat(viewBox[1]!), Number.parseFloat(viewBox[2]!))
}

/**
 * The dimensions a preview can be reserved from, or null if the header does not
 * say (an unreadable or unsupported format, or a truncated probe).
 */
export function readImageSize(bytes: Buffer): PixelSize | null {
  return (
    pngSize(bytes) ??
    gifSize(bytes) ??
    bmpSize(bytes) ??
    icoSize(bytes) ??
    webpSize(bytes) ??
    jpegSize(bytes) ??
    svgSize(bytes)
  )
}

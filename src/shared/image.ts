/**
 * Extensions a pane will preview in its status bar, mapped to the MIME type the
 * data URL must carry. Only formats Chromium can decode are listed: `heic` and
 * `tiff` keep their image icon (see `fileIcon.ts`) but are deliberately absent,
 * because a preview that can never render is worse than none.
 */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

/**
 * The MIME type for a name that is a decodable image, or null. Shared so the
 * renderer decides what to preview with the same map main uses to read it — a
 * mismatch would mean a status bar asking for a file main then refuses.
 */
export function imageMimeFor(name: string): string | null {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0 || dot === lower.length - 1) return null
  return IMAGE_MIME[lower.slice(dot + 1)] ?? null
}

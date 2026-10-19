import type { PaneEntry } from '@renderer/composables/useDirectory'
import { isKnownName } from '@renderer/lib/fileIcon'

/**
 * Extensions that name something the user runs: a shell or another interpreter,
 * or a native binary or loadable object. `.appimage` is here rather than with
 * the archives it is shaped like, because it is a program in a self-mounting
 * package.
 */
const PROGRAM_EXTENSIONS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'ksh',
  'csh',
  'tcsh',
  'dash',
  'bat',
  'cmd',
  'ps1',
  'psm1',
  'exe',
  'dll',
  'so',
  'dylib',
  'o',
  'a',
  'bin',
  'elf',
  'com',
  'scr',
  'class',
  'pyc',
  'pyo',
  'wasm',
  'appimage'
])

/** The text after a name's last dot, or '' when it has no extension. */
function extensionOf(name: string): string {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot > 0 && dot < lower.length - 1 ? lower.slice(dot + 1) : ''
}

/**
 * Whether the row is something the user can run, which is what the green name
 * of a row says (`--color-runnable`). Two facts have to meet, and they are not
 * the same one: the file carries an exec bit, *and* what it is has not already
 * been recognized as data. A screenshot that happens to be `+x` is not a
 * program, and neither is a `.deb` or a `.zip` — while a compiled binary with
 * no extension at all is, and so is a library whose last dotted part names
 * nothing (`libfoo.so.2`, which is why the test is on the extension the icon
 * table would use and not on a "does it end in .so" one).
 *
 * Directories are executable by definition, so they are excluded outright: a
 * green name on every folder, socket and device node would say nothing at all.
 */
export function isRunnable(entry: PaneEntry): boolean {
  if (entry.kind !== 'file') return false
  if ((entry.mode & 0o111) === 0) return false
  if (PROGRAM_EXTENSIONS.has(extensionOf(entry.name))) return true
  return !isKnownName(entry.name)
}

/**
 * Whether activating the row should run it, rather than hand it to the system
 * the way an ordinary file is opened. That is the green rule (`isRunnable`) less
 * a desktop entry: a `.desktop` file describes a program rather than being one,
 * and the system is exactly what knows how to launch those.
 */
export function shouldExecute(entry: PaneEntry): boolean {
  return isRunnable(entry) && !entry.name.toLowerCase().endsWith('.desktop')
}

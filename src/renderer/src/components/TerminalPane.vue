<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { Shell } from '@renderer/composables/useShell'

// Read the mono stack from the theme rather than repeating it, so the terminal
// and the rest of the UI cannot drift apart (or fall out of sync when the theme
// token changes).
function monoFontStack(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-mono')
    .trim()
  return value || 'monospace'
}

// `shell` is the workspace's session. The view does not own it — it detaches on
// unmount and lets the workspace decide when the process dies — so switching
// workspaces simply renders a different session.
const props = defineProps<{ expanded: boolean; cwd: string; shell: Shell }>()

const emit = defineEmits<{
  (event: 'focused-change', value: boolean): void
  (event: 'collapse'): void
}>()

const root = ref<HTMLElement | null>(null)
const host = ref<HTMLElement | null>(null)

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let observer: ResizeObserver | null = null
let detach: (() => void) | null = null
let termReady = false
let pendingFrame = 0

// One xterm row, in CSS pixels. It is a fraction (12px * 1.25 line height is
// not a whole pixel), so it has to be measured rather than assumed.
let stripRowHeight = 0
// The host's vertical padding: box-sizing is border-box, so the content box is
// only exactly one row tall once this is added back to the height.
let stripPadding = 0

function measureStripRow(): void {
  const row = term?.element?.querySelector<HTMLElement>('.xterm-rows > div')
  const measured = row?.getBoundingClientRect().height ?? 0
  if (measured > 0) stripRowHeight = measured
  if (host.value) {
    const style = getComputedStyle(host.value)
    stripPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
  }
}

// The last styles written by applyStripViewport. It runs on every cursor move
// (onCursorMove), so unchanged values must not be rewritten.
let stripHeight = ''
let stripTransform = ''

/**
 * The collapsed strip is one visible row, but the terminal keeps two rows so the
 * panel -> shell `cd` sync's own erase has a row to work with (see refit). The
 * row that must be visible is the one the cursor is on: the strip is the command
 * line, so it shows the line being typed, not whichever row happens to sit at
 * the top of the two-row buffer. The host is therefore sized to exactly one row
 * and the terminal is shifted up so the cursor's row lands inside it — with the
 * terminal left alone the strip showed the row above the cursor (the last output
 * line after `ls`) instead of the prompt.
 */
function applyStripViewport(): void {
  const hostEl = host.value
  const xtermEl = term?.element
  if (!hostEl || !xtermEl) return

  if (props.expanded) {
    if (stripHeight !== '') hostEl.style.height = stripHeight = ''
    if (stripTransform !== '') xtermEl.style.transform = stripTransform = ''
    return
  }

  if (stripRowHeight === 0) measureStripRow()
  if (stripRowHeight === 0) return

  const cursorRow = term?.buffer.active.cursorY ?? 0
  const nextHeight = `${stripRowHeight + stripPadding}px`
  const nextTransform = cursorRow > 0 ? `translateY(${-cursorRow * stripRowHeight}px)` : ''
  if (nextHeight !== stripHeight) hostEl.style.height = stripHeight = nextHeight
  if (nextTransform !== stripTransform) xtermEl.style.transform = stripTransform = nextTransform
}

function refit(): void {
  if (!term || !fitAddon) return
  const element = host.value
  if (!element || element.clientWidth === 0 || element.clientHeight === 0) return
  // fit reads the host's height, so the collapsed strip's one-row sizing has to
  // be released before an expanded terminal can fill the window.
  if (props.expanded) element.style.height = ''
  fitAddon.fit()
  // The panel -> shell `cd` sync erases its own echo with `printf
  // '\033[1A\033[2K'`, which walks back one row and clears it. That needs a
  // spare row below the cursor: a one-row terminal scrolls on every newline, so
  // the echoed `cd` leaves the viewport for the scrollback before the `printf`
  // runs, and Ctrl+O then shows a transcript of syncs the user never typed.
  // Two rows keep the sync on screen for its own erase to clear, so the terminal
  // is clamped to two rows here; the collapsed strip clips the spare row away
  // (applyStripViewport) rather than showing it.
  const rows = Math.max(term.rows, 2)
  if (rows !== term.rows) term.resize(term.cols, rows)
  props.shell.resize(term.cols, rows)
  measureStripRow()
  applyStripViewport()
}

function scheduleRefit(): void {
  cancelAnimationFrame(pendingFrame)
  pendingFrame = requestAnimationFrame(refit)
}

function focusTerminal(): void {
  void nextTick(() => term?.focus())
}

function startTerminal(): void {
  if (termReady || !host.value) return
  termReady = true

  term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: monoFontStack(),
    fontSize: 12,
    lineHeight: 1.25,
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#cccccc',
      cursorAccent: '#1e1e1e',
      selectionBackground: '#264f78',
      black: '#000000',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c8',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#e5e5e5'
    }
  })

  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(host.value)
  refit()

  term.onData((data) => {
    props.shell.noteInput(data)
    props.shell.write(data)
  })

  // Output scrolls the two-row buffer, and the sync's erase moves the cursor
  // back up a row; either way the strip has to follow the cursor's row.
  term.onCursorMove(() => applyStripViewport())

  term.attachCustomKeyEventHandler((event) => {
    const isTerminalToggle =
      event.type === 'keydown' &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'o'
    return !isTerminalToggle
  })

  const attached = props.shell.attachTerminal(
    (data) => term?.write(data),
    (code) => term?.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`)
  )
  detach = attached.detach
  if (attached.initial) term.write(attached.initial)

  void props.shell.ensureStarted(props.cwd, term.cols, term.rows).then(() => {
    refit()
    scheduleRefit()
  })
}

watch(
  () => props.expanded,
  (expanded) => {
    void nextTick(() => {
      refit()
      if (expanded) focusTerminal()
    })
  },
  { flush: 'post' }
)

onMounted(() => {
  observer = new ResizeObserver(scheduleRefit)
  if (root.value) observer.observe(root.value)

  startTerminal()
  void nextTick(() => {
    refit()
    focusTerminal()
  })
})

onBeforeUnmount(() => {
  cancelAnimationFrame(pendingFrame)
  observer?.disconnect()
  observer = null
  detach?.()
  detach = null
  // The shell is app-level, not owned by this view: main kills sessions when
  // the window goes away. Killing it here would let any remount race a fresh
  // spawn and take the new shell down with it.
  term?.dispose()
  term = null
  fitAddon = null
})

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (next && root.value?.contains(next)) return
  emit('focused-change', false)
}

defineExpose({ focusTerminal })
</script>

<template>
  <section
    ref="root"
    class="flex min-h-0 flex-col overflow-hidden border-t border-border bg-bg transition-[flex-grow,flex-basis] duration-150 ease-out"
    :class="expanded ? 'grow basis-0' : 'grow-0 shrink-0 basis-7'"
    @focusin="emit('focused-change', true)"
    @focusout="onFocusOut"
  >
    <div
      v-if="expanded"
      class="flex h-8 shrink-0 items-center justify-between border-b border-border-subtle bg-surface px-3"
    >
      <span class="text-ui-sm font-medium tracking-wider text-fg-dim uppercase">
        Terminal
      </span>
      <button
        type="button"
        class="rounded p-0.5 text-fg-dim transition-colors hover:bg-hover hover:text-fg"
        title="Collapse to the command line (Ctrl+O)"
        @click="emit('collapse')"
      >
        <svg
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>

    <div
      ref="host"
      class="min-h-0 overflow-hidden px-3 py-1"
      :class="expanded ? 'flex-1' : 'flex-none'"
    ></div>
  </section>
</template>

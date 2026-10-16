<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useShell } from '@renderer/composables/useShell'

const MONO_FONT = "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Consolas, monospace"

const props = defineProps<{ expanded: boolean; cwd: string }>()

const emit = defineEmits<{
  (event: 'focused-change', value: boolean): void
  (event: 'collapse'): void
}>()

const shell = useShell()

const root = ref<HTMLElement | null>(null)
const host = ref<HTMLElement | null>(null)

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let observer: ResizeObserver | null = null
let detach: (() => void) | null = null
let termReady = false
let pendingFrame = 0

function refit(): void {
  if (!term || !fitAddon) return
  const element = host.value
  if (!element || element.clientWidth === 0 || element.clientHeight === 0) return
  fitAddon.fit()
  shell.resize(term.cols, term.rows)
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
    fontFamily: MONO_FONT,
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
    shell.noteInput(data)
    shell.write(data)
  })

  term.attachCustomKeyEventHandler((event) => {
    const isTerminalToggle =
      event.type === 'keydown' &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'o'
    return !isTerminalToggle
  })

  const attached = shell.attachTerminal(
    (data) => term?.write(data),
    (code) => term?.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`)
  )
  detach = attached.detach
  if (attached.initial) term.write(attached.initial)

  void shell.ensureStarted(props.cwd, term.cols, term.rows).then(() => {
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
  shell.kill()
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
    class="flex shrink-0 flex-col overflow-hidden border-t border-border bg-bg"
    :class="expanded ? 'h-72' : 'h-16'"
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

    <div ref="host" class="min-h-0 flex-1 overflow-hidden px-3 py-2"></div>
  </section>
</template>

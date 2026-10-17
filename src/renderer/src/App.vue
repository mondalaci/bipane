<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import FilePanel from '@renderer/components/FilePanel.vue'
import StatusBar from '@renderer/components/StatusBar.vue'
import TerminalPane from '@renderer/components/TerminalPane.vue'
import TitleBar from '@renderer/components/TitleBar.vue'
import { useDirectory } from '@renderer/composables/useDirectory'
import { useShell } from '@renderer/composables/useShell'
import type { PanelSide } from '@shared/types'

const left = useDirectory('left')
const right = useDirectory('right')

const shell = useShell()
const shellCwd = shell.cwd
const shellIdle = shell.idle
const shellStarted = shell.started
const shellInput = shell.inputLine

const activeSide = ref<PanelSide>('left')
const terminalExpanded = ref(false)
const terminalFocused = ref(false)
const panelHost = ref<HTMLElement | null>(null)
const terminalRef = ref<InstanceType<typeof TerminalPane> | null>(null)

const activePane = computed(() => (activeSide.value === 'left' ? left : right))
const activePanePath = computed(() => activePane.value.state.path)

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

/**
 * Panel -> shell cwd sync has to type a real `cd` into a real prompt, so the
 * shell echoes it and the strip fills up with commands the user never issued.
 * Appending a printf that walks back over the echoed line and clears it hides
 * the sync, and `&&` means a failed `cd` still shows its error.
 */
const ERASE_ECHO = "printf '\\033[1A\\033[2K'"

function setActive(side: PanelSide): void {
  activeSide.value = side
}

/**
 * Collapsed, the strip is the command line and holds focus so typing reaches
 * the shell. Expanded, it is a real terminal and owns the keyboard outright.
 */
function focusPanes(): void {
  if (terminalExpanded.value) {
    panelHost.value?.focus()
    return
  }
  terminalRef.value?.focusTerminal()
}

function toggleTerminal(): void {
  if (terminalExpanded.value) {
    collapseTerminal()
    return
  }
  terminalExpanded.value = true
}

function collapseTerminal(): void {
  terminalExpanded.value = false
  void nextTick(() => terminalRef.value?.focusTerminal())
}

function toggleSearch(): void {
  const pane = activePane.value
  if (pane.state.searchActive) pane.closeSearch()
  else pane.openSearch()
}

// A filter belongs to the pane it was typed in.
watch(activeSide, (side) => {
  const inactive = side === 'left' ? right : left
  inactive.closeSearch()
})

watch(
  () => left.state.searchActive || right.state.searchActive,
  (anyActive, wasActive) => {
    if (!wasActive || anyActive) return
    if (!terminalExpanded.value) terminalRef.value?.focusTerminal()
  }
)

/**
 * cwd sync runs both ways, which needs care: the shell's cwd is polled, so a
 * read can be stale for a moment after we push a `cd`. `pendingPush` marks the
 * path we asked for so those stale reads are ignored instead of bouncing the
 * panel back to where it came from.
 */
let pendingPush: string | null = null
let pendingTimer: number | null = null

function clearPendingPush(): void {
  pendingPush = null
  if (pendingTimer === null) return
  window.clearTimeout(pendingTimer)
  pendingTimer = null
}

function pushCwdToShell(): void {
  // Never write into a shell that is busy, or into a half-typed command line:
  // the text would be fed to whatever is running, or appended to the command.
  if (!shellStarted.value || !shellIdle.value) return
  if (shellInput.value.length > 0) return

  const target = activePanePath.value
  if (!target || target === shellCwd.value || target === pendingPush) return

  pendingPush = target
  if (pendingTimer !== null) window.clearTimeout(pendingTimer)
  pendingTimer = window.setTimeout(clearPendingPush, 3000)

  shell.write(`cd ${shellQuote(target)} && ${ERASE_ECHO}\r`)
}

watch([activePanePath, shellIdle, shellStarted, shellInput], pushCwdToShell)

watch(shellCwd, (next) => {
  if (!next) return

  if (pendingPush !== null) {
    if (next === pendingPush) clearPendingPush()
    return
  }

  if (next === activePanePath.value) return
  void activePane.value.navigateTo(next)
})

/**
 * Claim a key for the app. `preventDefault` is not enough on its own: xterm
 * handles keys from a capture listener on its own textarea and does not consult
 * `defaultPrevented`, so without stopping propagation it would also forward the
 * key to the shell (Up recalling history, Home moving the line cursor).
 */
function consume(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

function handlePaneKey(event: KeyboardEvent): void {
  const pane = activePane.value
  const searching = pane.state.searchActive
  const hasInput = shellInput.value.length > 0

  if (event.key === 'Tab') {
    consume(event)
    setActive(activeSide.value === 'left' ? 'right' : 'left')
    return
  }

  if (event.ctrlKey || event.altKey || event.metaKey) return

  if (event.key === 'Escape') {
    consume(event)
    if (searching) {
      pane.closeSearch()
      return
    }
    if (hasInput) {
      shell.clearInputLine()
      return
    }
    if (terminalExpanded.value) collapseTerminal()
    return
  }

  // Backspace belongs to whichever input owns the text — the shell's line
  // editor or the search box. It deliberately does not navigate the panel.
  if (event.key === 'Backspace' || event.key === 'Delete') return

  if (event.repeat && event.key === 'Enter') {
    consume(event)
    return
  }

  switch (event.key) {
    case 'ArrowDown':
      consume(event)
      pane.moveCursor(1)
      break
    case 'ArrowUp':
      consume(event)
      pane.moveCursor(-1)
      break
    case 'PageDown':
      consume(event)
      pane.movePage(1)
      break
    case 'PageUp':
      consume(event)
      pane.movePage(-1)
      break
    case 'Home':
      consume(event)
      pane.moveTo(0)
      break
    case 'End':
      consume(event)
      pane.moveTo(pane.state.entries.length - 1)
      break
    case 'Enter':
      // With a line typed, fall through to the shell and leave the terminal
      // exactly as the user left it.
      if (hasInput) return
      consume(event)
      void pane.activate()
      break
    default:
      break
  }
}

function onKeydown(event: KeyboardEvent): void {
  const isSearchToggle =
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.code === 'KeyS'

  if (isSearchToggle) {
    event.preventDefault()
    event.stopPropagation()
    toggleSearch()
    return
  }

  const isTerminalToggle =
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === 'o'

  if (isTerminalToggle) {
    event.preventDefault()
    event.stopPropagation()
    toggleTerminal()
    return
  }

  // Expanded and focused means it is a real terminal: it owns the keyboard.
  if (terminalExpanded.value && terminalFocused.value) return

  handlePaneKey(event)
}

/**
 * Registered in setup, before any child mounts, so it runs ahead of xterm's own
 * capture listener. `stopPropagation` in `consume` is what actually keeps
 * navigation keys away from the shell.
 */
window.addEventListener('keydown', onKeydown, { capture: true })

onMounted(() => {
  void left.init()
  void right.init()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, { capture: true })
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-bg text-fg select-none">
    <TitleBar :terminal-open="terminalExpanded" @toggle-terminal="toggleTerminal" />

    <main
      ref="panelHost"
      tabindex="-1"
      class="flex min-h-0 shrink basis-0 overflow-hidden outline-none transition-[flex-grow] duration-150 ease-out"
      :class="terminalExpanded ? 'grow-0' : 'grow'"
    >
      <FilePanel
        :controller="left"
        :active="activeSide === 'left'"
        @select="setActive('left')"
        @pointer-down="focusPanes"
      />
      <div class="w-px shrink-0 bg-border"></div>
      <FilePanel
        :controller="right"
        :active="activeSide === 'right'"
        @select="setActive('right')"
        @pointer-down="focusPanes"
      />
    </main>

    <TerminalPane
      ref="terminalRef"
      :expanded="terminalExpanded"
      :cwd="activePanePath"
      @focused-change="terminalFocused = $event"
      @collapse="collapseTerminal"
    />

    <StatusBar :pane="activePane" :active-side="activeSide" :terminal-open="terminalExpanded" />
  </div>
</template>

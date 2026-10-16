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

  shell.write(`cd ${shellQuote(target)}\r`)
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

function handlePaneKey(event: KeyboardEvent): void {
  const pane = activePane.value
  const searching = pane.state.searchActive
  const hasInput = shellInput.value.length > 0

  if (event.key === 'Tab') {
    event.preventDefault()
    setActive(activeSide.value === 'left' ? 'right' : 'left')
    return
  }

  if (event.ctrlKey || event.altKey || event.metaKey) return

  if (event.key === 'Escape') {
    event.preventDefault()
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

  // While there is a line to edit, the shell's own line editing keeps it.
  if (searching && (event.key === 'Backspace' || event.key === 'Delete')) return
  if (event.key === 'Backspace' && hasInput) return

  if (event.repeat && (event.key === 'Enter' || event.key === 'Backspace')) {
    event.preventDefault()
    return
  }

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      pane.moveCursor(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      pane.moveCursor(-1)
      break
    case 'PageDown':
      event.preventDefault()
      pane.movePage(1)
      break
    case 'PageUp':
      event.preventDefault()
      pane.movePage(-1)
      break
    case 'Home':
      event.preventDefault()
      pane.moveTo(0)
      break
    case 'End':
      event.preventDefault()
      pane.moveTo(pane.state.entries.length - 1)
      break
    case 'Enter':
      if (hasInput) {
        // Fall through to the shell, but give the output room to be seen.
        if (!terminalExpanded.value) terminalExpanded.value = true
        return
      }
      event.preventDefault()
      void pane.activate()
      break
    case 'Backspace':
      event.preventDefault()
      void pane.goUp()
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

onMounted(() => {
  window.addEventListener('keydown', onKeydown, { capture: true })
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

    <main ref="panelHost" tabindex="-1" class="flex min-h-0 flex-1 outline-none">
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

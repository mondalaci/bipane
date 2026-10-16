<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CommandLine from '@renderer/components/CommandLine.vue'
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

const activeSide = ref<PanelSide>('left')
const terminalOpen = ref(false)
const terminalFocused = ref(false)
const commandText = ref('')
const commandLine = ref<InstanceType<typeof CommandLine> | null>(null)

const activePane = computed(() => (activeSide.value === 'left' ? left : right))
const activePanePath = computed(() => activePane.value.state.path)

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function setActive(side: PanelSide): void {
  activeSide.value = side
}

function focusCommandLine(): void {
  commandLine.value?.focus()
}

/**
 * The command line holds focus whenever the terminal does not, so printable
 * characters land there while navigation keys are intercepted globally.
 */
function syncFocus(): void {
  if (terminalOpen.value && terminalFocused.value) return
  focusCommandLine()
}

function focusPanes(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
  syncFocus()
}

function toggleTerminal(): void {
  terminalOpen.value = !terminalOpen.value
  if (!terminalOpen.value) {
    terminalFocused.value = false
    syncFocus()
  }
}

function closeTerminal(): void {
  terminalOpen.value = false
  terminalFocused.value = false
  syncFocus()
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

// Leaving search mode hands focus back to the command line.
watch(
  () => left.state.searchActive || right.state.searchActive,
  (anyActive, wasActive) => {
    if (wasActive && !anyActive) syncFocus()
  }
)

async function runCommand(): Promise<void> {
  const line = commandText.value
  if (!line.trim()) return
  commandText.value = ''

  if (!terminalOpen.value) terminalOpen.value = true
  await nextTick()

  await shell.ensureStarted(activePanePath.value)
  shell.write(`${line}\r`)
  focusCommandLine()
}

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
  // Never inject into a shell that is busy: it would corrupt whatever is
  // running (a REPL, an editor, a password prompt).
  if (!shellStarted.value || !shellIdle.value) return

  const target = activePanePath.value
  if (!target || target === shellCwd.value || target === pendingPush) return

  pendingPush = target
  if (pendingTimer !== null) window.clearTimeout(pendingTimer)
  pendingTimer = window.setTimeout(clearPendingPush, 3000)

  shell.write(`cd ${shellQuote(target)}\r`)
}

watch([activePanePath, shellIdle, shellStarted], pushCwdToShell)

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
  const hasCommand = commandText.value.length > 0

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
    if (hasCommand) {
      commandText.value = ''
      return
    }
    if (terminalOpen.value) closeTerminal()
    return
  }

  // The search box and the command line own their own editing while they have
  // text to edit; otherwise Backspace keeps its "go up" meaning.
  if (searching && (event.key === 'Backspace' || event.key === 'Delete')) return
  if (event.key === 'Backspace' && hasCommand) return

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
      event.preventDefault()
      if (hasCommand) void runCommand()
      else void pane.activate()
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

  if (terminalOpen.value && terminalFocused.value) return

  handlePaneKey(event)
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, { capture: true })
  void left.init()
  void right.init()
  focusCommandLine()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, { capture: true })
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-bg text-fg select-none">
    <TitleBar :terminal-open="terminalOpen" @toggle-terminal="toggleTerminal" />

    <main class="flex min-h-0 flex-1">
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
      :open="terminalOpen"
      :cwd="activePanePath"
      @focused-change="terminalFocused = $event"
      @close="closeTerminal"
    />

    <CommandLine ref="commandLine" v-model="commandText" :cwd="shellCwd" />

    <StatusBar :pane="activePane" :active-side="activeSide" :terminal-open="terminalOpen" />
  </div>
</template>

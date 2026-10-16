<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import FilePanel from '@renderer/components/FilePanel.vue'
import StatusBar from '@renderer/components/StatusBar.vue'
import TerminalPane from '@renderer/components/TerminalPane.vue'
import TitleBar from '@renderer/components/TitleBar.vue'
import { useDirectory } from '@renderer/composables/useDirectory'
import type { PanelSide } from '@shared/types'

const left = useDirectory('left')
const right = useDirectory('right')

const activeSide = ref<PanelSide>('left')
const terminalOpen = ref(false)
const terminalFocused = ref(false)

const activePane = computed(() => (activeSide.value === 'left' ? left : right))

function setActive(side: PanelSide): void {
  activeSide.value = side
}

function blurToPanes(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
}

function toggleTerminal(): void {
  terminalOpen.value = !terminalOpen.value
  if (!terminalOpen.value) blurToPanes()
}

function closeTerminal(): void {
  terminalOpen.value = false
  blurToPanes()
}

function handlePaneKey(event: KeyboardEvent): void {
  if (event.key === 'Tab') {
    event.preventDefault()
    setActive(activeSide.value === 'left' ? 'right' : 'left')
    return
  }

  if (event.ctrlKey || event.altKey || event.metaKey) return

  if (event.repeat && (event.key === 'Enter' || event.key === 'Backspace')) {
    event.preventDefault()
    return
  }

  const pane = activePane.value

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
      void pane.activate()
      break
    case 'Backspace':
      event.preventDefault()
      void pane.goUp()
      break
    case 'Escape':
      if (terminalOpen.value) closeTerminal()
      break
    default:
      break
  }
}

function onKeydown(event: KeyboardEvent): void {
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
        @pointer-down="blurToPanes"
      />
      <div class="w-px shrink-0 bg-border"></div>
      <FilePanel
        :controller="right"
        :active="activeSide === 'right'"
        @select="setActive('right')"
        @pointer-down="blurToPanes"
      />
    </main>

    <TerminalPane
      :open="terminalOpen"
      :cwd="activePane.state.path"
      @focused-change="terminalFocused = $event"
      @close="closeTerminal"
    />

    <StatusBar :pane="activePane" :active-side="activeSide" :terminal-open="terminalOpen" />
  </div>
</template>

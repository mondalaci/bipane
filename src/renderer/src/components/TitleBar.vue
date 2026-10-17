<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ terminalOpen: boolean }>()

const emit = defineEmits<{ (event: 'toggle-terminal'): void }>()

const maximized = ref(false)
let unsubscribe: (() => void) | null = null

onMounted(async () => {
  maximized.value = await window.bipane.win.isMaximized()
  unsubscribe = window.bipane.win.onMaximizedChange((value) => {
    maximized.value = value
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})

function minimize(): void {
  void window.bipane.win.minimize()
}

function toggleMaximize(): void {
  void window.bipane.win.toggleMaximize()
}

function close(): void {
  void window.bipane.win.close()
}

function onDoubleClick(event: MouseEvent): void {
  const target = event.target
  if (target instanceof HTMLElement && target.closest('.no-drag')) return
  toggleMaximize()
}
</script>

<template>
  <header
    class="drag-region flex h-8 shrink-0 items-center border-b border-border bg-surface pr-1.5"
    @dblclick="onDoubleClick"
  >
    <div class="flex shrink-0 items-center gap-2 pl-3">
      <svg
        viewBox="0 0 24 24"
        class="h-3.5 w-3.5 text-accent-strong"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
        <path d="M12 4.5v15" />
      </svg>
      <span class="text-ui font-medium tracking-tight text-fg-bright">Bipane</span>
    </div>

    <div class="no-drag ml-3 shrink-0">
      <button
        type="button"
        class="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-ui-sm transition-colors"
        :class="
          terminalOpen ? 'bg-selection text-fg-bright' : 'text-fg-dim hover:bg-hover hover:text-fg'
        "
        title="Toggle terminal (Ctrl+O)"
        @click="emit('toggle-terminal')"
      >
        <svg
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m3 7 5 5-5 5" />
          <path d="M12 17h9" />
        </svg>
        <span>Terminal</span>
      </button>
    </div>

    <div class="min-w-0 flex-1"></div>

    <div class="no-drag flex h-full shrink-0 items-stretch gap-1.5">
      <button
        type="button"
        class="flex w-11 items-center justify-center text-fg-dim transition-colors hover:bg-hover hover:text-fg"
        title="Minimize"
        @click="minimize"
      >
        <svg
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M5 12h14" />
        </svg>
      </button>

      <button
        type="button"
        class="flex w-11 items-center justify-center text-fg-dim transition-colors hover:bg-hover hover:text-fg"
        :title="maximized ? 'Restore' : 'Maximize'"
        @click="toggleMaximize"
      >
        <svg
          v-if="maximized"
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="4.5" y="8.5" width="11" height="11" rx="1" />
          <path d="M8.5 8.5v-3a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="5" y="5" width="14" height="14" rx="1" />
        </svg>
      </button>

      <button
        type="button"
        class="flex w-11 items-center justify-center text-fg-dim transition-colors hover:bg-danger hover:text-white"
        title="Close"
        @click="close"
      >
        <svg
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  </header>
</template>

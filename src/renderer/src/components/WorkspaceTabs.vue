<script setup lang="ts">
/**
 * The workspace tab strip, rendered inside the title bar so it costs no extra
 * vertical space. Each tab is a whole workspace — its own pair of file panes
 * and its own shell — so switching tabs is switching sessions. Clicking the
 * active tab toggles its terminal. Ctrl+T / Ctrl+W / Ctrl+PageUp /
 * Ctrl+PageDown mirror the buttons here.
 */
defineProps<{ tabs: { id: string; label: string }[]; activeIndex: number }>()

const emit = defineEmits<{
  (event: 'select', index: number): void
  (event: 'close', index: number): void
  (event: 'create'): void
}>()
</script>

<template>
  <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
    <div
      v-for="(tab, index) in tabs"
      :key="tab.id"
      class="flex h-5 shrink-0 items-center rounded transition-colors"
      :class="
        index === activeIndex
          ? 'bg-selection text-fg-bright'
          : 'text-fg-dim hover:bg-hover hover:text-fg'
      "
    >
      <button
        type="button"
        class="max-w-44 truncate pl-2 pr-1 text-ui-sm"
        :title="tab.label"
        @click="emit('select', index)"
      >
        {{ tab.label }}
      </button>

      <button
        v-if="tabs.length > 1"
        type="button"
        class="mr-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded hover:bg-hover hover:text-fg-bright"
        title="Close terminal (Ctrl+W)"
        @click.stop="emit('close', index)"
      >
        <svg
          viewBox="0 0 24 24"
          class="h-2.5 w-2.5"
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

    <button
      type="button"
      class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-dim transition-colors hover:bg-hover hover:text-fg"
      title="New terminal (Ctrl+T)"
      @click="emit('create')"
    >
      <svg
        viewBox="0 0 24 24"
        class="h-3 w-3"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  </div>
</template>

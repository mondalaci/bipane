<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { PaneEntry } from '@renderer/composables/useDirectory'

const props = defineProps<{ entries: PaneEntry[] }>()

defineEmits<{
  (event: 'confirm'): void
  (event: 'cancel'): void
}>()

const cancelButton = ref<HTMLButtonElement | null>(null)
const deleteButton = ref<HTMLButtonElement | null>(null)

const title = computed(() =>
  props.entries.length === 1 ? 'Delete this item?' : `Delete ${props.entries.length} items?`
)

const single = computed(() => (props.entries.length === 1 ? props.entries[0] : null))
const hasDirectory = computed(() => props.entries.some((entry) => entry.kind === 'directory'))

// Delete is the default action, and the focus the arrow keys move from.
onMounted(() => deleteButton.value?.focus())

// Left/Up select Cancel, Right/Down select Delete. Enter and Space stay native
// so the focused button activates itself.
function onKey(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      event.preventDefault()
      cancelButton.value?.focus()
      break
    case 'ArrowRight':
    case 'ArrowDown':
      event.preventDefault()
      deleteButton.value?.focus()
      break
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
    @mousedown.self="$emit('cancel')"
  >
    <div
      class="flex w-full max-w-md flex-col overflow-hidden rounded-md border border-border bg-surface shadow-xl"
      role="alertdialog"
      aria-modal="true"
      @keydown="onKey"
    >
      <div class="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <svg
          viewBox="0 0 24 24"
          class="h-4 w-4 shrink-0 text-danger"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5" />
        </svg>
        <span class="text-ui-lg text-fg-bright">{{ title }}</span>
      </div>

      <div class="flex flex-col gap-2 px-4 py-3">
        <p v-if="single" class="truncate font-mono text-ui text-fg-dim" :title="single.path">
          {{ single.name }}
        </p>
        <p class="text-ui-sm text-fg-dim">
          This cannot be undone.
          <template v-if="hasDirectory"> Directories are removed with everything in them.</template>
        </p>
      </div>

      <div class="flex justify-end gap-2 border-t border-border-subtle bg-bg-alt px-4 py-3">
        <button
          ref="cancelButton"
          type="button"
          class="rounded border border-border bg-surface px-3 py-1 text-ui text-fg hover:bg-hover focus:border-accent-strong focus:bg-accent-strong focus:text-white"
          @click="$emit('cancel')"
        >
          Cancel
        </button>
        <button
          ref="deleteButton"
          type="button"
          class="rounded border border-danger bg-danger/15 px-3 py-1 text-ui text-danger hover:bg-danger/25 focus:border-danger focus:bg-danger focus:text-white focus:outline-2 focus:outline-danger"
          @click="$emit('confirm')"
        >
          Delete
        </button>
      </div>
    </div>
  </div>
</template>

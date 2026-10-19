<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

const props = defineProps<{ name: string }>()

defineEmits<{
  (event: 'confirm'): void
  (event: 'cancel'): void
}>()

const cancelButton = ref<HTMLButtonElement | null>(null)
const discardButton = ref<HTMLButtonElement | null>(null)

const title = computed(() => `Discard unsaved changes to "${props.name}"?`)

// Closing without saving loses work, so the safe choice — Cancel — starts
// focused; discarding takes a deliberate move (Right/Down, or a click).
onMounted(() => cancelButton.value?.focus())

// Left/Up select Cancel, Right/Down select Discard. Enter and Space stay native
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
      discardButton.value?.focus()
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
          <path d="M12 3 2 20h20L12 3z" />
          <path d="M12 9v5M12 17h.01" />
        </svg>
        <span class="min-w-0 flex-1 truncate text-ui-lg text-fg-bright" :title="title">
          {{ title }}
        </span>
      </div>

      <div class="flex flex-col gap-2 px-4 py-3">
        <p class="text-ui-sm text-fg-dim">
          Your edits will be lost. This cannot be undone.
        </p>
      </div>

      <div class="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
        <button
          ref="cancelButton"
          type="button"
          class="rounded border border-border bg-surface px-3 py-1 text-ui text-fg hover:bg-hover focus:border-accent-strong focus:bg-accent-strong focus:text-white"
          @click="$emit('cancel')"
        >
          Cancel
        </button>
        <button
          ref="discardButton"
          type="button"
          class="rounded border border-danger bg-danger/15 px-3 py-1 text-ui text-danger hover:bg-danger/25 focus:border-danger focus:bg-danger focus:text-white focus:outline-2 focus:outline-danger"
          @click="$emit('confirm')"
        >
          Discard
        </button>
      </div>
    </div>
  </div>
</template>

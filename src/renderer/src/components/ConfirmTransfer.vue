<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { PaneEntry } from '@renderer/composables/useDirectory'

const props = defineProps<{
  entries: PaneEntry[]
  destination: string
  mode: 'copy' | 'move'
}>()

const emit = defineEmits<{
  (event: 'confirm', destination: string): void
  (event: 'cancel'): void
}>()

const destInput = ref<HTMLInputElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const actionButton = ref<HTMLButtonElement | null>(null)

const dest = ref(props.destination)

const isMove = computed(() => props.mode === 'move')
const label = computed(() => (isMove.value ? 'Move' : 'Copy'))

const title = computed(() => {
  const [first] = props.entries
  if (props.entries.length === 1 && first) return `${label.value} ${first.name}?`
  return `${label.value} ${props.entries.length} items?`
})

const hasDirectory = computed(() => props.entries.some((entry) => entry.kind === 'directory'))

// The destination is the field to edit, so it starts focused with its text
// selected: typing replaces the path the way the classic transfer dialog does.
onMounted(() => {
  destInput.value?.focus()
  destInput.value?.select()
})

function commit(): void {
  emit('confirm', dest.value.trim() || props.destination)
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    // Enter in the field confirms; a focused button keeps its native
    // Enter/Space activation.
    if (document.activeElement === destInput.value) {
      event.preventDefault()
      commit()
    }
    return
  }

  // Arrow keys move between the buttons only while a button has focus; in the
  // destination input they belong to the text cursor.
  if (document.activeElement === destInput.value) return

  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      event.preventDefault()
      cancelButton.value?.focus()
      break
    case 'ArrowRight':
    case 'ArrowDown':
      event.preventDefault()
      actionButton.value?.focus()
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
          class="h-4 w-4 shrink-0 text-accent-strong"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <template v-if="isMove">
            <path d="M13 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8" />
            <path d="M15 7l5 5-5 5M20 12H9" />
          </template>
          <template v-else>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </template>
        </svg>
        <span class="min-w-0 flex-1 truncate text-ui-lg text-fg-bright" :title="title">
          {{ title }}
        </span>
      </div>

      <div class="flex flex-col gap-2 px-4 py-3">
        <p class="text-ui-sm text-fg-dim">Destination</p>
        <input
          ref="destInput"
          v-model="dest"
          type="text"
          class="w-full rounded border border-border bg-bg-alt px-2 py-1 font-mono text-ui text-fg outline-none focus:border-accent-strong"
          spellcheck="false"
          autocomplete="off"
        />
        <p class="text-ui-sm text-fg-dim">
          Existing entries in the destination are left untouched.
          <template v-if="hasDirectory">
            Directories are {{ isMove ? 'moved' : 'copied' }} with everything in them.
          </template>
          <template v-if="isMove"> Moved entries leave the source pane.</template>
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
          ref="actionButton"
          type="button"
          class="rounded border border-accent-strong bg-accent-strong/15 px-3 py-1 text-ui text-accent-strong hover:bg-accent-strong/25 focus:border-accent-strong focus:bg-accent-strong focus:text-white focus:outline-2 focus:outline-accent-strong"
          @click="commit"
        >
          {{ label }}
        </button>
      </div>
    </div>
  </div>
</template>

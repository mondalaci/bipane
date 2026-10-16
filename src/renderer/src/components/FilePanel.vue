<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { PaneController, PaneEntry } from '@renderer/composables/useDirectory'
import { formatDate, formatSize } from '@renderer/lib/format'

const props = defineProps<{ controller: PaneController; active: boolean }>()

const emit = defineEmits<{
  (event: 'select'): void
  (event: 'pointer-down'): void
}>()

const listEl = ref<HTMLUListElement | null>(null)

watch(
  () => props.controller.state.cursor,
  async (index) => {
    await nextTick()
    const row = listEl.value?.children[index]
    if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' })
  }
)

watch(
  () => props.controller.state.path,
  async () => {
    await nextTick()
    listEl.value?.scrollTo({ top: 0 })
  }
)

function onPointerDown(): void {
  emit('pointer-down')
  emit('select')
}

function onRowClick(index: number): void {
  props.controller.moveTo(index)
}

function rowClass(index: number): string {
  if (index !== props.controller.state.cursor) return 'text-fg hover:bg-hover'
  return props.active ? 'bg-selection text-fg-bright' : 'bg-selection-inactive text-fg'
}

function iconClass(entry: PaneEntry): string {
  if (entry.isParent) return 'text-fg-dim'
  if (entry.isSymlink) return 'text-accent-strong'
  if (entry.kind === 'directory') return 'text-folder'
  return 'text-fg-dim'
}

function metaClass(index: number): string {
  return index === props.controller.state.cursor ? 'text-fg' : 'text-fg-dim'
}
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col" @mousedown="onPointerDown">
    <div
      class="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-3"
      :class="active ? 'text-fg' : 'text-fg-dim'"
    >
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        :class="active ? 'bg-accent-strong' : 'bg-border'"
      ></span>
      <span class="truncate font-mono text-ui-sm" :title="controller.state.path">
        {{ controller.state.path || '—' }}
      </span>
      <span
        v-if="controller.state.loading"
        class="ml-auto shrink-0 text-ui-sm text-fg-dim"
      >
        loading…
      </span>
    </div>

    <div
      class="flex h-6 shrink-0 items-center border-b border-border-subtle bg-bg px-3 text-ui-sm text-fg-dim"
    >
      <span class="min-w-0 flex-1">Name</span>
      <span class="w-16 shrink-0 text-right">Size</span>
      <span class="w-28 shrink-0 text-right">Modified</span>
    </div>

    <ul ref="listEl" class="min-h-0 flex-1 overflow-y-auto py-1">
      <li v-if="controller.state.error" class="px-3 py-2 text-ui text-danger">
        {{ controller.state.error }}
      </li>
      <li
        v-else-if="controller.state.itemCount === 0"
        class="px-3 py-2 text-ui text-fg-dim"
      >
        Empty folder
      </li>

      <li
        v-for="(entry, index) in controller.state.entries"
        :key="entry.path"
        class="flex h-[22px] cursor-default items-center gap-2 px-3 text-ui"
        :class="rowClass(index)"
        @click="onRowClick(index)"
        @dblclick="controller.activate()"
      >
        <span class="flex w-4 shrink-0 items-center justify-center" :class="iconClass(entry)">
          <svg
            v-if="entry.isParent"
            viewBox="0 0 24 24"
            class="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
          <svg
            v-else-if="entry.kind === 'directory'"
            viewBox="0 0 24 24"
            class="h-3.5 w-3.5"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"
            />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            class="h-3.5 w-3.5"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-4-4V2H6zm7 1.5L18.5 9H13V3.5z" />
          </svg>
        </span>

        <span class="min-w-0 flex-1 truncate" :title="entry.path">{{ entry.name }}</span>

        <span
          v-if="entry.isSymlink && entry.symlinkTarget"
          class="max-w-40 shrink-0 truncate font-mono text-ui-sm text-fg-dim"
          :title="entry.symlinkTarget"
        >
          → {{ entry.symlinkTarget }}
        </span>

        <span
          class="w-16 shrink-0 text-right tabular-nums"
          :class="metaClass(index)"
        >
          {{ entry.kind === 'directory' ? '' : formatSize(entry.size) }}
        </span>
        <span class="w-28 shrink-0 text-right tabular-nums" :class="metaClass(index)">
          {{ entry.isParent ? '' : formatDate(entry.mtimeMs) }}
        </span>
      </li>
    </ul>

    <div
      class="flex h-6 shrink-0 items-center justify-between border-t border-border-subtle bg-surface px-3 text-ui-sm text-fg-dim"
    >
      <span class="tabular-nums">{{ controller.state.itemCount }} items</span>
      <span v-if="controller.state.parent" class="truncate font-mono" :title="controller.state.parent">
        {{ controller.state.parent }}
      </span>
    </div>
  </section>
</template>

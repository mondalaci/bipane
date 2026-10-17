<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import type { PaneController, ScrollAlign } from '@renderer/composables/useDirectory'
import { formatDate, formatSize } from '@renderer/lib/format'
import FileIcon from '@renderer/components/FileIcon.vue'

const ROW_HEIGHT = 22

const props = defineProps<{ controller: PaneController; active: boolean }>()

const emit = defineEmits<{
  (event: 'select'): void
  (event: 'pointer-down'): void
}>()

const listEl = ref<HTMLUListElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)

// Kept out of the <ul> on purpose: the row list must contain exactly the
// entries, or index-based scrolling and the cursor watch would be off by one.
const notice = computed(() => {
  const state = props.controller.state
  if (state.error) return { text: state.error, error: true }
  if (state.itemCount > 0) return null
  return {
    text: state.searchQuery ? `No matches for "${state.searchQuery}"` : 'Empty folder',
    error: false
  }
})

let listObserver: ResizeObserver | null = null

function measurePageRows(): void {
  const element = listEl.value
  if (!element) return
  const styles = getComputedStyle(element)
  const padding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom)
  const usable = element.clientHeight - padding
  props.controller.state.pageRows = Math.max(1, Math.floor(usable / ROW_HEIGHT))
}

function scrollRowIntoView(index: number, align: ScrollAlign): void {
  const element = listEl.value
  if (!element) return

  const rowTop = index * ROW_HEIGHT
  const rowBottom = rowTop + ROW_HEIGHT
  const viewTop = element.scrollTop
  const viewBottom = viewTop + element.clientHeight

  if (align === 'start') {
    element.scrollTop = rowTop
    return
  }

  if (align === 'end') {
    element.scrollTop = Math.max(rowBottom - element.clientHeight, 0)
    return
  }

  if (rowTop < viewTop) {
    element.scrollTop = rowTop
  } else if (rowBottom > viewBottom) {
    element.scrollTop = rowBottom - element.clientHeight
  }
}

watch(
  [() => props.controller.state.path, () => props.controller.state.cursor],
  async () => {
    const { cursor, scrollAlign } = props.controller.state
    props.controller.state.scrollAlign = 'nearest'
    await nextTick()
    scrollRowIntoView(cursor, scrollAlign)
  }
)

watch(
  () => props.controller.state.searchActive,
  async (active) => {
    await nextTick()
    if (!active) return
    searchInput.value?.focus()
    searchInput.value?.select()
  }
)

onMounted(() => {
  listObserver = new ResizeObserver(measurePageRows)
  if (listEl.value) listObserver.observe(listEl.value)
  measurePageRows()
  window.addEventListener('mouseup', endPainting)
})

onBeforeUnmount(() => {
  listObserver?.disconnect()
  listObserver = null
  window.removeEventListener('mouseup', endPainting)
})

function onSearchInput(event: Event): void {
  const target = event.target
  if (target instanceof HTMLInputElement) props.controller.updateSearch(target.value)
}

function onPointerDown(event: MouseEvent): void {
  emit('select')

  const target = event.target
  if (target instanceof HTMLElement && target.closest('[data-search]')) return

  emit('pointer-down')
}

function onRowClick(index: number): void {
  props.controller.moveTo(index)
}

/**
 * Right-click marks a row, and holding the button paints that mark across
 * every row the pointer enters — the swipe-to-select gesture. The paint mode
 * is decided once, from the row the gesture started on: starting on an
 * unmarked row selects, starting on a marked row clears.
 */
let painting: { select: boolean } | null = null

function onRowRightDown(index: number, event: MouseEvent): void {
  const entry = props.controller.state.entries[index]
  if (!entry || entry.isParent) return
  event.preventDefault()

  const select = !props.controller.isSelected(entry)
  props.controller.setSelected(entry.path, select)
  painting = { select }
}

function onRowEnter(index: number): void {
  if (!painting) return
  const entry = props.controller.state.entries[index]
  if (!entry || entry.isParent) return
  props.controller.setSelected(entry.path, painting.select)
}

function endPainting(): void {
  painting = null
}

function rowClass(index: number): string {
  if (index !== props.controller.state.cursor) return 'text-fg hover:bg-hover'
  return props.active ? 'bg-selection text-fg-bright' : 'bg-selection-inactive text-fg'
}

function metaClass(index: number): string {
  return index === props.controller.state.cursor ? 'text-fg' : 'text-fg-dim'
}

/**
 * In-place rename. The input is rendered only for the entry the controller is
 * editing, but it lives inside the v-for, so a string ref would collect an
 * array — a function ref keeps a single element handle. Focus and select the
 * basename once the row has swapped to an input.
 */
let renameInput: HTMLInputElement | null = null

function setRenameInput(el: Element | ComponentPublicInstance | null): void {
  renameInput = el instanceof HTMLInputElement ? el : null
}

watch(
  () => props.controller.state.renaming,
  async (renaming) => {
    if (!renaming) return
    await nextTick()
    const input = renameInput
    if (!input) return
    input.focus()
    // Preselect the stem so typing replaces the name but keeps the extension —
    // the classic rename gesture. A dotfile or extension-less name selects whole.
    const dot = input.value.lastIndexOf('.')
    if (dot > 0) input.setSelectionRange(0, dot)
    else input.select()
  }
)

function onRenameKey(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    const input = event.target as HTMLInputElement
    void props.controller.commitRename(input.value)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    props.controller.cancelRename()
  }
}

function onRenameBlur(): void {
  // Commit already cleared `renaming` before the input can lose focus, so a
  // blur that still sees an edit in progress is a real cancellation.
  if (props.controller.state.renaming !== null) props.controller.cancelRename()
}
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col" @mousedown="onPointerDown" @contextmenu.prevent>
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

    <div
      v-if="controller.state.searchActive"
      data-search
      class="flex h-7 shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-alt px-3"
    >
      <svg
        viewBox="0 0 24 24"
        class="h-3.5 w-3.5 shrink-0 text-fg-dim"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.6-3.6" />
      </svg>
      <input
        ref="searchInput"
        type="text"
        class="min-w-0 flex-1 bg-transparent font-mono text-ui text-fg outline-none placeholder:text-fg-dim"
        placeholder="incremental search"
        spellcheck="false"
        autocomplete="off"
        :value="controller.state.searchQuery"
        @input="onSearchInput"
      />
      <span
        v-if="controller.state.searchQuery"
        class="shrink-0 tabular-nums text-ui-sm text-fg-dim"
      >
        {{ controller.state.itemCount }} matches
      </span>
    </div>

    <p
      v-if="notice"
      class="shrink-0 px-3 py-2 text-ui"
      :class="notice.error ? 'text-danger' : 'text-fg-dim'"
    >
      {{ notice.text }}
    </p>

    <ul ref="listEl" class="min-h-0 flex-1 overflow-y-auto">
      <li
        v-for="(entry, index) in controller.state.entries"
        :key="entry.path"
        class="flex cursor-default items-center gap-2 px-3 text-ui"
        :style="{ height: `${ROW_HEIGHT}px` }"
        :class="rowClass(index)"
        @mousedown.right="onRowRightDown(index, $event)"
        @mouseenter="onRowEnter(index)"
        @contextmenu.prevent
        @click="onRowClick(index)"
        @dblclick="controller.activate()"
      >
        <span class="flex w-4 shrink-0 items-center justify-center">
          <FileIcon :entry="entry" />
        </span>

        <input
          v-if="controller.state.renaming === entry.path"
          :ref="setRenameInput"
          type="text"
          class="min-w-0 flex-1 rounded border border-accent-strong bg-bg px-1 font-mono text-ui text-fg outline-none"
          :value="entry.name"
          spellcheck="false"
          autocomplete="off"
          @keydown="onRenameKey"
          @blur="onRenameBlur"
          @mousedown.stop
          @click.stop
          @dblclick.stop
        />
        <span
          v-else
          class="min-w-0 flex-1 truncate"
          :class="controller.isSelected(entry) ? 'text-selected' : ''"
          >{{ entry.name }}</span
        >

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

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import type { PaneController, ScrollAlign } from '@renderer/composables/useDirectory'
import { formatDate, formatMode, formatSize } from '@renderer/lib/format'
import FileIcon from '@renderer/components/FileIcon.vue'
import { imageMimeFor } from '@shared/image'
import type { ImageSize } from '@shared/types'

const ROW_HEIGHT = 22

const props = defineProps<{ controller: PaneController; active: boolean }>()

const emit = defineEmits<{
  (event: 'select'): void
  (event: 'pointer-down'): void
}>()

const listEl = ref<HTMLUListElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)

// The footer mirrors the status of this pane's own cursor and marks.
const entry = computed(() => props.controller.current())
const selectedCount = computed(() => props.controller.selectedCount())

/**
 * The entry the status bar previews: the cursor row when it is a regular image
 * file. The shared extension->MIME map is the same one main reads by, so the
 * bar only asks for something it can actually be given.
 */
const imageEntry = computed(() => {
  const current = entry.value
  if (!current || current.isParent || current.kind !== 'file') return null
  return imageMimeFor(current.name) ? current : null
})

/**
 * The current image as a `data:` URL, or null while it loads, for a non-image
 * row, or when main could not produce one (too large, unreadable). `pending`
 * covers the read in flight, so the bar reserves the preview space the moment
 * the cursor lands on an image — without it the footer would collapse and
 * re-expand on every step between images — and gives it back if the read fails.
 */
const preview = ref<string | null>(null)
const previewPending = ref(false)

/**
 * The image's shape, read from its header long before the image itself, and
 * `sizeHintKnown` is whether that probe has answered for the row in hand. The
 * box is not shown until it has: it would otherwise appear at the ratio-less
 * default width and only snap to the picture's real shape once the probe
 * landed, which is a wide frame flashing on the way to every preview.
 */
const sizeHint = ref<ImageSize | null>(null)
const sizeHintKnown = ref(false)

const previewVisible = computed(() => {
  if (imageEntry.value === null) return false
  if (preview.value !== null) return true
  return previewPending.value && sizeHintKnown.value
})

const PREVIEW_HEIGHT = 64
const PREVIEW_MAX_WIDTH = 160

/**
 * The reserved box: the hinted ratio at the preview's height, capped at the
 * preview's width (a very wide image letterboxes rather than pushing the rest
 * of the bar off the strip). Without a hint the box is the full cap and the
 * image settles into it once it loads.
 */
const previewBoxStyle = computed(() => {
  const hint = sizeHint.value
  const ratio = hint && hint.height > 0 ? hint.width / hint.height : null
  const limit = PREVIEW_MAX_WIDTH / PREVIEW_HEIGHT
  const capped = ratio === null ? limit : Math.min(ratio, limit)
  const width = Math.max(1, Math.round(PREVIEW_HEIGHT * capped))
  return { width: `${width}px`, height: `${PREVIEW_HEIGHT}px` }
})

/**
 * How long the cursor must hold still before its image is read. A held arrow
 * key moves through rows far faster than an image can be read, and a large one
 * is decoded synchronously in main: reading every row a key repeat passes over
 * keeps main busy, which delays the very input events that drive the cursor and
 * reads as choppy movement. Re-armed on every cursor change, so a scrolling
 * burst asks for nothing until it stops.
 */
const PREVIEW_SETTLE_MS = 150

/**
 * The shape probe and the image read for the row the cursor sits on. Both are
 * keyed by path *and* size/mtime so an external rewrite of the same path
 * reloads, and both are token-guarded so a slow answer for a row the user has
 * already left cannot replace the newer one.
 */
let previewToken = 0
let previewTimer: number | null = null

function cancelPreviewRead(): void {
  if (previewTimer === null) return
  window.clearTimeout(previewTimer)
  previewTimer = null
}

async function loadSizeHint(token: number, path: string): Promise<void> {
  const hint = await window.bipane.fs.imageSize(path)
  if (token !== previewToken) return
  sizeHint.value = hint
  sizeHintKnown.value = true
}

async function loadPreview(token: number, path: string): Promise<void> {
  const result = await window.bipane.fs.readImage(path)
  if (token !== previewToken) return
  previewPending.value = false
  preview.value = result.ok ? result.data.dataUrl : null
}

watch(
  () => {
    const current = imageEntry.value
    return current ? `${current.path}\u0000${current.size}:${current.mtimeMs}` : null
  },
  (key) => {
    cancelPreviewRead()
    const token = (previewToken += 1)
    preview.value = null

    if (key === null) {
      sizeHint.value = null
      sizeHintKnown.value = false
      previewPending.value = false
      return
    }

    // The shape is probed now, not with the read: it is a header read in main,
    // so waiting out the settle delay first would leave the default frame up
    // for that whole window before the box took the picture's real shape. The
    // row just left keeps its shape until this probe answers (~1ms), so the box
    // neither blinks nor flashes a width it is about to leave.
    previewPending.value = true
    const current = imageEntry.value
    if (!current) return

    void loadSizeHint(token, current.path)
    previewTimer = window.setTimeout(() => {
      previewTimer = null
      void loadPreview(token, current.path)
    }, PREVIEW_SETTLE_MS)
  }
)

/**
 * A format whose header the probe cannot measure still reveals its shape when it
 * renders, so adopt it then rather than leaving the default box for good.
 */
function onPreviewLoad(event: Event): void {
  if (sizeHint.value) return
  const image = event.target
  if (!(image instanceof HTMLImageElement)) return
  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
    sizeHint.value = { width: image.naturalWidth, height: image.naturalHeight }
  }
}

function onPreviewError(): void {
  // A mapped extension can still fail to decode (a truncated or malformed
  // file), which surfaces here rather than as a rejected read.
  preview.value = null
}

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
  cancelPreviewRead()
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
  const base =
    index !== props.controller.state.cursor
      ? 'text-fg'
      : props.active
        ? 'bg-selection text-fg-bright'
        : 'bg-selection-inactive text-fg'

  // `fresh` holds the paths a refresh just found new or changed; membership is
  // all the row needs to run its highlight (see styles/flash.css).
  const entry = props.controller.state.entries[index]
  return entry && props.controller.state.fresh.has(entry.path) ? `${base} flash-row` : base
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
  <section
    class="flex min-w-0 flex-1 flex-col border"
    :class="active ? 'border-accent' : 'border-transparent'"
    @mousedown="onPointerDown"
    @contextmenu.prevent
  >
    <div
      class="flex h-7 shrink-0 items-center gap-2 border-b border-border-subtle px-3"
      :class="active ? 'bg-accent text-fg-bright' : 'bg-surface text-fg-dim'"
    >
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
      class="flex shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-surface px-3 text-ui-sm text-fg-dim"
      :class="previewVisible ? 'py-1' : 'h-6'"
    >
      <div class="flex min-w-0 items-center gap-3">
        <div
          v-if="previewVisible"
          :style="previewBoxStyle"
          class="flex shrink-0 items-center justify-center overflow-hidden rounded border border-border-subtle bg-bg"
        >
          <img
            v-if="preview"
            :src="preview"
            alt=""
            draggable="false"
            class="h-full w-full object-contain"
            @load="onPreviewLoad"
            @error="onPreviewError"
          />
          <span
            v-else
            class="h-3.5 w-3.5 animate-spin rounded-full border border-fg border-t-transparent"
          />
        </div>

        <span class="shrink-0 tabular-nums">{{ controller.state.itemCount }} items</span>
      </div>

      <div class="flex shrink-0 items-center gap-3">
        <template v-if="entry && !entry.isParent">
          <span class="hidden tabular-nums lg:inline">{{ formatMode(entry.mode) }}</span>
          <span class="tabular-nums">
            {{ entry.kind === 'directory' ? 'dir' : formatSize(entry.size) }}
          </span>
          <span class="hidden tabular-nums lg:inline">{{ formatDate(entry.mtimeMs) }}</span>
        </template>

        <span v-if="selectedCount > 0" class="tabular-nums text-selected">
          {{ selectedCount }} selected
        </span>
      </div>
    </div>
  </section>
</template>

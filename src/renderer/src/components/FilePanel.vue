<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import type { PaneController, ScrollAlign } from '@renderer/composables/useDirectory'
import { formatDate, formatMode, formatSize } from '@renderer/lib/format'
import { previewKeyFor, previewTargetFor, type StageRequest } from '@renderer/lib/preview'
import FileIcon from '@renderer/components/FileIcon.vue'
import { MEDIA_SCHEME } from '@shared/video'
import type { PixelSize } from '@shared/types'

const ROW_HEIGHT = 22

/**
 * `idle` is no previewable file under the cursor, `probing` is a shape that is
 * not known yet, `loading` is a reserved box with the picture on its way, and
 * the last two are terminal.
 */
type PreviewState = 'idle' | 'probing' | 'loading' | 'ready' | 'failed'

const props = defineProps<{
  controller: PaneController
  active: boolean
  stage?: StageRequest | null
}>()

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
 * The row this pane's footer previews: the cursor row when it is a regular file
 * the renderer can show — an image, or a video.
 */
const previewTarget = computed(() => previewTargetFor(entry.value))

/**
 * Where the preview for the row in hand has got to. `probing` is "the shape is
 * not known yet", `loading` is "the box is reserved and the picture is on its
 * way", and `failed` releases the space again. The box is shown for `loading`
 * and `ready` only: the default ratio-less frame is then never on screen on the
 * way to a preview.
 */
const previewState = ref<PreviewState>('idle')

/** The shape being reserved, from the image header or the video's metadata. */
const sizeHint = ref<PixelSize | null>(null)

/** An image's bytes, as a `data:` URL, once read. */
const frame = ref<string | null>(null)

/**
 * Whether the cursor has held still on this row long enough to start loading
 * it. A video begins fetching the moment its element is mounted, so mounting it
 * is what this gates — the same discipline the read gets for an image.
 */
const settled = ref(false)

/**
 * Whether the footer is at its tall size. It is, from the moment the cursor is
 * on media — the extension says so, before anything has been read — so stepping
 * between clips never collapses the strip and pushes the list back up.
 */
const footerTall = computed(() => previewTarget.value !== null)

/**
 * Whether the preview box itself is on screen. It is up while a preview loads or
 * is ready, and while a *new* row's shape is still unknown it stays up at the
 * shape of the row just left, so the box is a steady thing to look at. Only the
 * first media row of a run — whose shape has never been known — has no box yet.
 */
const previewVisible = computed(() => {
  if (previewTarget.value === null) return false
  if (previewState.value === 'loading' || previewState.value === 'ready') return true
  return previewState.value === 'probing' && sizeHint.value !== null
})

/**
 * Whether the tall footer is reserved with nothing drawn in it yet: the first
 * row of a run, until its shape is known. The space is held at the box's own
 * height, so nothing about the footer moves when the box arrives — a bare
 * spinner is what shows in the meantime.
 */
const previewWaiting = computed(() => footerTall.value && !previewVisible.value)

/**
 * The stream URL for a video. The file is served by main, ranged, so an element
 * fetches only the metadata and the frames it needs rather than a preview's
 * worth of a file that can be a hundred megabytes long.
 */
function mediaUrlFor(path: string): string {
  return `${MEDIA_SCHEME}://file/?path=${encodeURIComponent(path)}`
}

const videoUrl = computed(() => {
  const target = previewTarget.value
  return target && target.kind === 'video' ? mediaUrlFor(target.path) : null
})

const showImage = computed(() => previewTarget.value?.kind === 'image' && frame.value !== null)
const showVideo = computed(
  () =>
    previewTarget.value?.kind === 'video' &&
    settled.value &&
    previewState.value !== 'failed'
)
/**
 * Whether the box is still waiting for its picture. It is, for as long as the box
 * is on screen with no frame in it — and for a clip main has to transcode first
 * that is the whole encode, seconds of a strip that otherwise shows an empty box
 * and looks broken while nothing appears to happen.
 */
const showSpinner = computed(
  () => previewVisible.value && previewState.value !== 'ready'
)

const PREVIEW_HEIGHT = 64
const PREVIEW_MAX_WIDTH = 160

/**
 * The reserved box: the hinted ratio at the preview's height, capped at the
 * preview's width (a very wide picture letterboxes rather than pushing the rest
 * of the bar off the strip). Without a hint the box is the full cap and the
 * picture settles into it once it arrives.
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
 * How long the cursor must hold still before its picture is read. A held arrow
 * key moves through rows far faster than a picture can be read, and a large
 * image is decoded synchronously in main: reading every row a key repeat passes
 * over keeps main busy, which delays the very input events that drive the cursor
 * and reads as choppy movement. Re-armed on every cursor change, so a scrolling
 * burst asks for nothing until it stops. A video is held back the same way — its
 * element is mounted only once the cursor settles, so a burst does not start a
 * metadata fetch per row — and everything past the settle is token-guarded.
 */
const PREVIEW_SETTLE_MS = 150

/**
 * The preview for the row the cursor sits on, keyed by path *and* size/mtime so
 * an external rewrite of the same path reloads, and guarded by a token so a slow
 * answer for a row the user has already left cannot replace the newer one.
 */
let previewToken = 0
let previewTimer: number | null = null

function cancelPreviewRead(): void {
  if (previewTimer === null) return
  window.clearTimeout(previewTimer)
  previewTimer = null
}

/**
 * The shape of an image, read from its header. It is cheap enough to be issued
 * on the cursor move rather than with the read, which is what lets the box take
 * the picture's real shape as soon as the row is reached.
 */
async function loadImageSizeHint(token: number, path: string): Promise<void> {
  const hint = await window.bipane.fs.imageSize(path)
  if (token !== previewToken) return
  sizeHint.value = hint
  previewState.value = 'loading'
}

async function loadImage(token: number, path: string): Promise<void> {
  const result = await window.bipane.fs.readImage(path)
  if (token !== previewToken) return
  frame.value = result.ok ? result.data.dataUrl : null
  if (result.ok) previewState.value = 'ready'
  else previewState.value = 'failed'
}

watch(
  () => previewKeyFor(previewTarget.value),
  (key) => {
    cancelPreviewRead()
    const token = (previewToken += 1)
    frame.value = null

    const target = previewTarget.value
    if (key === null || !target) {
      sizeHint.value = null
      settled.value = false
      previewState.value = 'idle'
      return
    }

    // The row just left keeps its shape for the moment this takes — a header
    // read for an image, the element's metadata for a video — so the box neither
    // blinks between rows nor flashes a width it is about to leave.
    settled.value = false
    previewState.value = 'probing'
    if (target.kind === 'image') void loadImageSizeHint(token, target.path)

    previewTimer = window.setTimeout(() => {
      previewTimer = null
      if (token !== previewToken) return
      // A video starts fetching by being mounted, which `settled` lets it do
      // from here; an image is read outright.
      settled.value = true
      if (target.kind === 'image') void loadImage(token, target.path)
    }, PREVIEW_SETTLE_MS)
  }
)

/**
 * A video reveals its shape in its metadata, which the element fetches as soon
 * as it is mounted (after the settle). That is also the moment the box can be
 * reserved: the clip is already starting to play behind the spinner.
 */
function onVideoMetadata(event: Event): void {
  const video = event.target
  if (!(video instanceof HTMLVideoElement)) return

  if (video.videoWidth > 0 && video.videoHeight > 0) {
    sizeHint.value = { width: video.videoWidth, height: video.videoHeight }
  }
  if (previewState.value === 'probing') previewState.value = 'loading'
}

/** Frames are flowing: the spinner has done its job. */
function onVideoStarted(): void {
  if (previewState.value !== 'failed') previewState.value = 'ready'
}

function onVideoError(): void {
  previewState.value = 'failed'
}

/**
 * A format whose header the probe cannot measure still reveals its shape when it
 * renders, so adopt it then rather than leaving the default box for good.
 */
function onImageLoad(event: Event): void {
  if (sizeHint.value) return
  const image = event.target
  if (!(image instanceof HTMLImageElement)) return
  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
    sizeHint.value = { width: image.naturalWidth, height: image.naturalHeight }
  }
}

function onImageError(): void {
  // A mapped extension can still fail to decode (a truncated or malformed file),
  // which surfaces here rather than as a rejected read.
  previewState.value = 'failed'
}

/**
 * How long a display takes to grow out of the thumbnail it was asked for. It is
 * a translate *and* a scale of the same element — the media, laid out at its
 * final size, is animated back onto the footer's thumbnail and forward again —
 * so the two motions are one gesture rather than a move then a resize.
 */
const STAGE_REVEAL_MS = 220

/** The stream URL of the media another pane is displaying. */
const stageVideoUrl = computed(() =>
  props.stage && props.stage.target.kind === 'video' ? mediaUrlFor(props.stage.target.path) : null
)

/** An image being displayed on behalf of another pane, as a `data:` URL. */
const stageFrame = ref<string | null>(null)

/**
 * Where the display has got to. It is kept out of sight until the frame itself
 * is there — an element has no size until its media does, and the reveal is
 * measured off that size — and a failure leaves the pane empty rather than
 * showing a broken frame.
 */
type StageState = 'idle' | 'loading' | 'ready' | 'failed'
const stageState = ref<StageState>('idle')

const showStageImage = computed(() => stageFrame.value !== null && stageState.value !== 'failed')
const showStageVideo = computed(
  () => stageVideoUrl.value !== null && stageState.value !== 'idle' && stageState.value !== 'failed'
)

/** The reveal already played for this entry into the mode, so a swap in place is not re-animated. */
let stageAnimation = -1

/** The element being displayed, for measuring the reveal. */
const stageMedia = ref<HTMLImageElement | HTMLVideoElement | null>(null)

let stageToken = 0

/**
 * Display the media another pane asked for. There is no settle here: the user
 * asked for this file by pressing Enter on it, so it loads at once — an image
 * through main's cache, which the footer's own read usually filled in already.
 */
watch(
  () => {
    const stage = props.stage
    return stage ? previewKeyFor(stage.target) : null
  },
  (key) => {
    const token = (stageToken += 1)
    stageFrame.value = null
    stageState.value = key === null ? 'idle' : 'loading'
    if (key === null) return

    const stage = props.stage
    if (!stage || stage.target.kind !== 'image') return

    void window.bipane.fs.readImage(stage.target.path).then((result) => {
      if (token !== stageToken) return
      if (result.ok) stageFrame.value = result.data.dataUrl
      else stageState.value = 'failed'
    })
  },
  { immediate: true }
)

/**
 * Reveal the display: measure where it has laid itself out, put it back onto the
 * thumbnail it grew out of, and let it travel forward into place. One element
 * carries both motions, so the translate and the scale are a single gesture
 * rather than a move followed by a resize.
 */
function onStageShown(): void {
  stageState.value = 'ready'

  const stage = props.stage
  const element = stageMedia.value
  if (!stage || !element) return

  // One reveal per entry into the mode: a swap in place while the mode is
  // already up is not something to re-animate for every row the cursor crosses.
  if (stage.animation === stageAnimation) return
  stageAnimation = stage.animation

  const from = stage.from()
  if (!from) return

  const to = element.getBoundingClientRect()
  if (to.width <= 0 || to.height <= 0) return

  element.animate(
    [
      {
        transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${
          from.width / to.width
        }, ${from.height / to.height})`
      },
      { transform: 'none' }
    ],
    { duration: STAGE_REVEAL_MS, easing: 'ease-out' }
  )
}

function onStageError(): void {
  stageState.value = 'failed'
}

/**
 * The footer thumbnail's box, so a pane showing this pane's media can grow it
 * out of the row it was asked for. Null while there is nothing to grow from.
 */
const previewEl = ref<HTMLElement | null>(null)

/** The footer's own clip, while one is playing there. */
const previewVideo = ref<HTMLVideoElement | null>(null)

function previewRect(): DOMRect | null {
  const element = previewEl.value
  if (!element || element.offsetParent === null) return null
  return element.getBoundingClientRect()
}

/**
 * Step through a clip by `delta` seconds, which is what the arrow keys do while
 * the command line has nothing typed in it.
 *
 * Stepping back into a clip that had played itself out plays on from there,
 * rather than leaving a frozen last frame behind a key that clearly asked to see
 * more; stepping past its end does not, so the end of a clip is the end of it
 * and not quietly the beginning again.
 */
function seek(element: HTMLVideoElement | HTMLImageElement | null, delta: number): void {
  if (!(element instanceof HTMLVideoElement)) return

  const duration = element.duration
  if (!Number.isFinite(duration) || duration <= 0) return

  // Reading `ended` has to happen before the seek: moving the playhead anywhere
  // but the end is what clears it.
  const wasEnded = element.ended
  const at = Math.min(Math.max(element.currentTime + delta, 0), duration)

  // The clip has to have somewhere to move *to*. A clip main is still
  // transcoding arrives as a growing stream, and a stream reports no usable
  // range — Chromium gives a live source a single empty one — so the keys do
  // nothing there rather than throwing the playhead back to the start. Once the
  // encode is done the same clip is served as a whole file, ranges and all, and
  // the keys work on it.
  const ranges = element.seekable
  let reachable = false
  for (let i = 0; i < ranges.length; i += 1) {
    if (ranges.end(i) > 0 && at >= ranges.start(i) && at <= ranges.end(i)) reachable = true
  }
  if (!reachable) return

  element.currentTime = at
  if (wasEnded && at < duration) void element.play().catch(() => {})
}

function seekPreview(delta: number): void {
  seek(previewVideo.value, delta)
}

function seekStage(delta: number): void {
  seek(stageMedia.value, delta)
}

defineExpose({ previewRect, seekPreview, seekStage })

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
    class="relative flex min-w-0 flex-1 flex-col border"
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
      :class="footerTall ? 'py-1' : 'h-6'"
    >
      <div class="flex min-w-0 items-center gap-3">
        <!-- Shown/hidden with `v-show`, not `v-if`: a video hidden this way is
             still mounted, which is what lets it fetch its metadata, and so its
             shape, before the box is allowed on screen. -->
        <div
          v-show="previewVisible"
          ref="previewEl"
          :style="previewBoxStyle"
          class="relative flex shrink-0 items-center justify-center overflow-hidden rounded border border-border-subtle bg-bg"
        >
          <img
            v-if="showImage"
            :src="frame ?? undefined"
            alt=""
            draggable="false"
            class="h-full w-full object-contain"
            @load="onImageLoad"
            @error="onImageError"
          />
          <!-- Muted and played once, never looped: a preview is a look at the
               clip, not a viewing session, and a looping 4K file would decode
               for as long as the cursor happens to rest on the row. -->
          <video
            v-else-if="showVideo"
            ref="previewVideo"
            :src="videoUrl ?? undefined"
            muted
            autoplay
            preload="metadata"
            class="h-full w-full object-contain"
            @loadedmetadata="onVideoMetadata"
            @loadeddata="onVideoStarted"
            @playing="onVideoStarted"
            @error="onVideoError"
          ></video>
          <span
            v-if="showSpinner"
            class="absolute h-3.5 w-3.5 animate-spin rounded-full border border-fg border-t-transparent"
          />
        </div>

        <!-- The space the box will take, before its shape is known. Held at the
             box's own height so the footer is already the size it will be. -->
        <span v-if="previewWaiting" class="flex h-16 shrink-0 items-center">
          <span
            class="h-3.5 w-3.5 animate-spin rounded-full border border-fg border-t-transparent"
          />
        </span>

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

    <!-- What the pane being navigated has asked this one to display. It covers
         the listing outright rather than sitting beside it, so this pane has one
         thing on screen: the media. Pointer events stop here so a click cannot
         move the cursor's pane away from the one being navigated. -->
    <div
      v-if="stage"
      class="absolute inset-0 z-20 flex flex-col bg-bg"
      @mousedown.stop
      @click.stop
      @dblclick.stop
    >
      <div
        class="flex h-7 shrink-0 items-center border-b border-border-subtle bg-surface px-3 text-ui-sm text-fg-dim"
      >
        <span class="min-w-0 truncate">{{ stage.target.name }}</span>
      </div>

      <div class="relative flex min-h-0 grow items-center justify-center p-3">
        <img
          v-if="showStageImage"
          ref="stageMedia"
          :src="stageFrame ?? undefined"
          alt=""
          draggable="false"
          class="max-h-full max-w-full origin-top-left object-contain"
          :class="stageState === 'ready' ? '' : 'invisible'"
          @load="onStageShown"
          @error="onStageError"
        />
        <!-- A display is for looking at, so the clip plays on and on here, still
             muted; it is the footer's thumbnail that plays once and holds. -->
        <video
          v-else-if="showStageVideo"
          ref="stageMedia"
          :src="stageVideoUrl ?? undefined"
          muted
          autoplay
          loop
          class="max-h-full max-w-full origin-top-left object-contain"
          :class="stageState === 'ready' ? '' : 'invisible'"
          @loadeddata="onStageShown"
          @error="onStageError"
        ></video>
        <span
          v-if="stageState === 'loading'"
          class="absolute h-5 w-5 animate-spin rounded-full border-2 border-fg border-t-transparent"
        />
      </div>
    </div>
  </section>
</template>

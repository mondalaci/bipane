<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import type { PaneController, ScrollAlign } from '@renderer/composables/useDirectory'
import { formatDate, formatDuration, formatMode, formatSize } from '@renderer/lib/format'
import {
  previewKeyFor,
  previewTargetFor,
  type PlaybackClock,
  type PreviewTarget,
  type StageRequest
} from '@renderer/lib/preview'
import FileIcon from '@renderer/components/FileIcon.vue'
import { MEDIA_SCHEME, needsTranscode } from '@shared/video'
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
  /**
   * Whether the media under this pane's cursor is being shown at full size in
   * the other pane. It is played there and only there — a second element would
   * decode it twice to draw the same thing — so this pane keeps the space its
   * preview had and reads the position from the display instead.
   */
  transferred?: boolean
  displayedClock?: PlaybackClock | null
  /**
   * Whether this pane is the display for the other pane's cursor — the mode,
   * rather than a particular file: its own content stays blurred and its listing
   * stays covered for as long as the mode is on, even while the cursor is on a
   * row there is nothing to show for.
   */
  displaying?: boolean
}>()

const emit = defineEmits<{
  (event: 'select'): void
  (event: 'pointer-down'): void
  (event: 'stage-clock', clock: PlaybackClock | null): void
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
  // A clip a display has taken over keeps the space its box had — the footer
  // must not move under the cursor — even though there is nothing to draw in it.
  if (props.transferred === true) return true
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
function mediaUrlFor(path: string, from = 0): string {
  const base = `${MEDIA_SCHEME}://file/?path=${encodeURIComponent(path)}`
  return from > 0 ? `${base}&from=${from}` : base
}

/**
 * Where each element is streaming its clip from. A clip main has to encode is a
 * live stream, which reports no range to move within, so moving about it means
 * asking for the stream again at the position wanted: this is what that position
 * is, and changing it is what a seek does. It stays put once set — the element
 * would reload all over again otherwise — and means nothing for a clip Chromium
 * plays itself, which is seeked where it stands.
 */
const footerFrom = ref(0)
const stageFrom = ref(0)

const videoUrl = computed(() => {
  const target = previewTarget.value
  if (!target || target.kind !== 'video') return null
  return mediaUrlFor(target.path, needsTranscode(target.name) ? footerFrom.value : 0)
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
// While a display has the clip, whatever is still loading is its business rather
// than this box's: a spinner here would sit there for as long as the clip stays
// enlarged, promising something that is not coming.
const showSpinner = computed(
  () =>
    previewVisible.value && previewState.value !== 'ready' && props.transferred !== true
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
    videoTime.value = 0
    videoLength.value = null
    clipLength.value = null
    clipLengthKey = null
    footerFrom.value = 0

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

  pickUpAt(video, previewKeyFor(previewTarget.value), null)
}

/**
 * The rectangle a display's media is actually drawn in. The element fills the
 * pane and letterboxes the media inside it (`object-contain`), so a gesture has
 * to be measured from the media's own rectangle rather than from the element's —
 * otherwise it starts and lands a letterbox away from the thumbnail it belongs
 * to. Null while the media's own size is not known.
 */
function drawnRect(element: HTMLImageElement | HTMLVideoElement): DOMRect | null {
  const box = element.getBoundingClientRect()
  const width = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth
  const height = element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight
  if (width <= 0 || height <= 0 || box.width <= 0 || box.height <= 0) return null

  const scale = Math.min(box.width / width, box.height / height)
  const drawnWidth = width * scale
  const drawnHeight = height * scale
  return new DOMRect(
    box.left + (box.width - drawnWidth) / 2,
    box.top + (box.height - drawnHeight) / 2,
    drawnWidth,
    drawnHeight
  )
}

/**
 * The transform that lays a media's own rectangle onto `target`, for an element
 * transformed about its own top-left corner — which is what a reveal and a
 * shrink are: the media, where it is drawn, moving onto (or off) the thumbnail.
 */
function handoffTransform(target: DOMRect, drawn: DOMRect, box: DOMRect): string {
  const scale = target.width / drawn.width
  const x = target.left - box.left - scale * (drawn.left - box.left)
  const y = target.top - box.top - scale * (drawn.top - box.top)
  return `translate(${x}px, ${y}px) scale(${scale})`
}

/**
 * Carry on where the display left off, now that this element knows enough to be
 * moved — the clip was already part way through there, so playing it from the
 * beginning again reads as a restart rather than as a hand-back.
 */
function pickUpAt(element: HTMLVideoElement, key: string | null, fallback: number | null): void {
  const pending = pickUpFrom.value
  const held = pending !== null && pending.key === key ? pending : null
  if (held !== null) pickUpFrom.value = null

  // A stream has already been asked for from that position: there is nothing to
  // move, and a seek within the rest of the clip would be the wrong place.
  if (isStream(element)) return

  const at = held !== null ? held.time : fallback
  if (at === null) return

  const clamped = Math.min(at, element.duration)
  if (!Number.isFinite(clamped) || !canMoveWithin(element, clamped)) return
  element.currentTime = clamped
}

/**
 * Frames are flowing: the spinner has done its job, and the clock is read from
 * here rather than from `durationchange` — that fires before `loadedmetadata`,
 * where a clip handed back is moved to where the display had it, so reading it
 * there would show the 0:00 a fresh element starts at.
 */
function onVideoStarted(): void {
  if (previewState.value !== 'failed') previewState.value = 'ready'
  readVideoClock()
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
 * How far the pane's own content is blurred while a display covers it. Enough
 * that the listing behind reads as a backdrop rather than as something to read,
 * with the media on top of it standing out.
 *
 * It is a filter on the content itself rather than a `backdrop-filter` on the
 * display: the content is the thing being blurred, and blurring it directly
 * leaves the display with nothing of its own to paint underneath.
 */
const STAGE_BLUR_PX = 8

/**
 * How long a display takes to grow out of the thumbnail it was asked for, and to
 * shrink back into it. It is a translate *and* a scale of the same element — the
 * media, laid out at its final size, is animated back onto the footer's
 * thumbnail and forward again — so the two motions are one gesture rather than a
 * move then a resize. An enlarged clip's sound is ramped over the same length, so
 * that it arrives and leaves with the picture it belongs to.
 */
const STAGE_REVEAL_MS = 220

/**
 * The display on screen, which outlives the request for it while it is being
 * dismissed: the media has to still be there to shrink back onto its thumbnail.
 */
const shownStage = ref<StageRequest | null>(null)

/** The pane's own content — bar, listing, footer — which a display blurs. */
const paneContent = ref<HTMLElement | null>(null)

/** The blur in flight on the pane's own content, so a change of mode can replace it. */
let contentBlur: Animation | null = null

/** The stream URL of the media another pane is displaying. */
const stageVideoUrl = computed(() => {
  const stage = shownStage.value
  if (!stage || stage.target.kind !== 'video') return null
  return mediaUrlFor(stage.target.path, needsTranscode(stage.target.name) ? stageFrom.value : 0)
})

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

/** The element being displayed, for measuring the reveal and its reverse. */
const stageMedia = ref<HTMLImageElement | HTMLVideoElement | null>(null)

/** The dismissal in flight, so that a display asked for again can call it off. */
let stageDismissal: Animation | null = null

/** Whether a dismissal is running, so that its gesture is neither doubled nor cut short. */
let stageDismissing = false

/** Which sound ramp is the current one, so a leaving one stops when another starts. */
let stageSound = 0

let stageToken = 0

/**
 * Blur the pane's own content while this pane is the display, and bring it back
 * into focus when the mode is left. It is the *mode* that blurs rather than the
 * media: navigating from a media file to an ordinary one empties the display for
 * a moment, and the pane should go on looking like the preview it still is.
 */
watch(
  () => props.displaying === true,
  (displaying) => {
    const content = paneContent.value
    if (content === null) return

    const from = getComputedStyle(content).filter
    contentBlur?.cancel()
    contentBlur = content.animate(
      [
        { filter: from === 'none' ? 'blur(0px)' : from },
        { filter: displaying ? `blur(${STAGE_BLUR_PX}px)` : 'blur(0px)' }
      ],
      { duration: STAGE_REVEAL_MS, easing: displaying ? 'ease-out' : 'ease-in', fill: 'forwards' }
    )

    // Leaving the mode is what takes a displayed clip away: whatever is up
    // shrinks back onto its thumbnail, which by then is the pane's own again.
    if (displaying !== true && shownStage.value !== null) void dismissStage()
  }
)

/**
 * Display the media another pane asked for. There is no settle here: the user
 * asked for this file by pressing Enter on it, so it loads at once — an image
 * through main's cache, which the footer's own read usually filled in already.
 * A request that arrives while the last display is still shrinking away calls
 * that off and keeps what is on screen.
 */
watch(
  () => props.stage,
  (stage) => {
    if (stage) {
      stageDismissal?.cancel()
      stageDismissal = null
      shownStage.value = stage
      // A clip main has to encode is asked for from where the mode began; a clip
      // Chromium plays is loaded as it is and moved to that position.
      stageFrom.value = stage.resumeAt ?? 0
      raiseStageSound()
      void loadStage(stage)
      return
    }
    if (shownStage.value === null) return

    // The mode is being left, and whatever is up shrinks back onto its
    // thumbnail. It is asked for from here as well as from the mode's own watch,
    // because the two arrive in one flush and either may be first; the dismissal
    // runs once either way.
    if (props.displaying !== true) {
      void dismissStage()
      return
    }

    // Nothing under the cursor to show, with the mode still on: the display
    // empties without a gesture. That gesture belongs to arriving in the mode and
    // leaving it, not to the cursor crossing a file there is nothing to show for
    // — nothing grew out of that thumbnail, so shrinking back onto it would make
    // no sense.
    if (stageDismissing) return

    stageDismissal?.cancel()
    stageDismissal = null
    shownStage.value = null
    stageState.value = 'idle'
    emit('stage-clock', null)
  },
  { immediate: true }
)

async function loadStage(stage: StageRequest): Promise<void> {
  const key = previewKeyFor(stage.target)
  const token = (stageToken += 1)
  stageFrame.value = null
  stageState.value = key === null ? 'idle' : 'loading'
  if (stage.target.kind !== 'image') return

  const result = await window.bipane.fs.readImage(stage.target.path)
  if (token !== stageToken) return
  if (result.ok) stageFrame.value = result.data.dataUrl
  else stageState.value = 'failed'
}

/**
 * Ramp a clip's volume towards `to`, so its sound arrives with the picture it
 * belongs to rather than a beat before it — and leaves with it. A clip faded out
 * ends up muted, so nothing escapes after it. A ramp superseded by another stops
 * where it is, which is what lets a display that is coming back carry on from
 * the volume it had reached.
 *
 * The ramp follows frame callbacks, which is the smooth path — but those stop
 * while the window is hidden, and a dismissal waits on this, so it is bounded in
 * time as well and always finishes.
 */
function fadeVolume(element: HTMLMediaElement, to: number, duration: number): Promise<void> {
  const ramp = (stageSound += 1)

  return new Promise((resolve) => {
    const started = performance.now()
    const from = element.volume
    let backstop = 0
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(backstop)
      if (ramp === stageSound) {
        element.volume = to
        if (to === 0) element.muted = true
      }
      resolve()
    }

    backstop = window.setTimeout(finish, duration + 120)

    const step = (): void => {
      if (ramp !== stageSound) {
        finish()
        return
      }

      const elapsed = performance.now() - started
      const ratio = duration <= 0 ? 1 : Math.min(elapsed / duration, 1)
      element.volume = from + (to - from) * ratio
      if (ratio < 1) {
        requestAnimationFrame(step)
        return
      }
      finish()
    }

    requestAnimationFrame(step)
  })
}

/**
 * Bring an enlarged clip's sound up, from wherever it has got to. Called when a
 * display arrives, and when one that was leaving is asked for again.
 */
function raiseStageSound(): void {
  const element = stageMedia.value
  if (!(element instanceof HTMLVideoElement)) return

  element.muted = false
  void fadeVolume(element, 1, STAGE_REVEAL_MS)
}

/**
 * Reveal the display: measure where it has laid itself out, put it back onto the
 * thumbnail it grew out of, and let it travel forward into place. One element
 * carries both motions, so the translate and the scale are a single gesture
 * rather than a move followed by a resize.
 *
 * An enlarged clip is being watched rather than glanced at, so this is also
 * where its sound comes up — the footer's own thumbnail stays silent — from
 * silence, so that it arrives over the length the picture takes to arrive in.
 */
function onStageShown(): void {
  stageState.value = 'ready'

  const stage = shownStage.value
  const element = stageMedia.value
  if (!stage || !element) return

  readStageClock()

  if (element instanceof HTMLVideoElement) {
    element.muted = false
    element.volume = 0
    void fadeVolume(element, 1, STAGE_REVEAL_MS)
  }

  // One reveal per entry into the mode: a swap in place while the display is
  // already up is not something to re-animate for every row the cursor crosses.
  if (stage.animation === stageAnimation) return
  stageAnimation = stage.animation

  const from = stage.from()
  const drawn = drawnRect(element)
  if (!from || !drawn) return

  element.animate(
    [{ transform: handoffTransform(from, drawn, element.getBoundingClientRect()) }, { transform: 'none' }],
    { duration: STAGE_REVEAL_MS, easing: 'ease-out' }
  )
}

/**
 * Put the display away: shrink it back onto the thumbnail it came from, fade its
 * sound out with it, and only then take it off screen. The request is held onto
 * until this is done, because the element has to still be there to move.
 */
async function dismissStage(): Promise<void> {
  if (stageDismissing) return
  stageDismissing = true

  try {
    await runDismissal()
  } finally {
    stageDismissing = false
  }
}

async function runDismissal(): Promise<void> {
  const stage = shownStage.value
  const element = stageMedia.value

  if (stage === null || element === null) {
    shownStage.value = null
    stageState.value = 'idle'
    emit('stage-clock', null)
    return
  }

  const to = stage.from()
  const drawn = drawnRect(element)

  let moving: Promise<void> = Promise.resolve()
  let shrink: Animation | null = null
  if (to !== null && drawn !== null) {
    shrink = element.animate(
      [
        { transform: 'none' },
        { transform: handoffTransform(to, drawn, element.getBoundingClientRect()) }
      ],
      { duration: STAGE_REVEAL_MS, easing: 'ease-in', fill: 'forwards' }
    )
    stageDismissal = shrink
    // A cancelled animation rejects here, which is not a failure: the request
    // that replaced this one owns the display now.
    moving = shrink.finished.then(
      () => {},
      () => {}
    )
  }

  const silenced =
    element instanceof HTMLVideoElement ? fadeVolume(element, 0, STAGE_REVEAL_MS) : Promise.resolve()

  await Promise.all([moving, silenced])

  if (stageDismissal === shrink) stageDismissal = null
  if (shownStage.value !== stage) return

  shownStage.value = null
  stageState.value = 'idle'
  emit('stage-clock', null)
}

/**
 * Carry on where the pane that asked had got to. The clip was already part way
 * through there, so a display that began it again would read as a restart rather
 * than as the same clip changing place.
 */
function resumeStage(event: Event): void {
  const element = event.target
  const stage = shownStage.value
  if (!(element instanceof HTMLVideoElement) || !stage) return

  pickUpAt(element, previewKeyFor(stage.target), stage.resumeAt)
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

/**
 * Whether an element is reading a clip main has to encode, which is a stream
 * rather than a file: it is moved about by asking for it from another position,
 * and its own clock counts from the start of whatever it was given rather than
 * from the start of the clip.
 */
function isStream(element: HTMLVideoElement): boolean {
  const target = element === stageMedia.value ? shownStage.value?.target : previewTarget.value
  return target !== null && target !== undefined && needsTranscode(target.name)
}

/** Where the footer's clip has got to, and how long it is once that is knowable. */
const videoTime = ref(0)
const videoLength = ref<number | null>(null)

/**
 * The length of a clip main has to encode, asked of the file: while it is being
 * encoded the element has only a live stream, which cannot report one.
 */
const clipLength = ref<number | null>(null)
let clipLengthKey: string | null = null

/**
 * Where a clip has got to, as its own element reports it: its position always,
 * and its length only once it is a whole file with a range that is really there.
 * A clip main is still encoding arrives as a live stream, whose "length" is a
 * growing estimate of what has been encoded so far — a bar drawn from that would
 * misstate a three-minute file as a four-second one.
 */
function clockOf(element: HTMLVideoElement): PlaybackClock {
  const ranges = element.seekable
  const measured =
    Number.isFinite(element.duration) && ranges.length > 0 && ranges.end(ranges.length - 1) > 0
  return { time: element.currentTime, length: measured ? element.duration : null }
}

/**
 * Ask the file itself how long a clip is, for one whose stream cannot say. Asked
 * once per file, and only for a clip main has to encode.
 */
function ensureClipLength(target: PreviewTarget): void {
  if (!needsTranscode(target.name)) return

  const key = previewKeyFor(target)
  if (key === null || key === clipLengthKey) return
  clipLengthKey = key
  void window.bipane.fs.videoDuration(target.path).then((seconds) => {
    if (clipLengthKey !== key) return
    clipLength.value = seconds
  })
}

/**
 * Follow the footer's clip for the play bar beside its thumbnail.
 */
function readVideoClock(): void {
  const element = previewVideo.value
  if (!(element instanceof HTMLVideoElement)) return

  const clock = clockOf(element)
  const stream = isStream(element)
  // A stream counts from the start of whatever it was given, so the clip's
  // position is the offset it was started at plus this element's own clock — and
  // its length is what is left of the clip rather than the clip, which is what
  // the file itself is asked for instead.
  videoTime.value = (stream ? footerFrom.value : 0) + clock.time
  videoLength.value = stream ? null : clock.length

  // A held position has done its job now that this element has been read — and
  // not before: until it can be read the element is a fresh one at 0:00, so
  // dropping the position a moment earlier would flash the bar back to a stale
  // value on the way.
  pickUpFrom.value = null

  // A clip still being encoded is a live stream, which has no length of its own
  // to report: ask the file, once, for the row the cursor has settled on.
  const target = previewTarget.value
  if (clock.length === null && target) ensureClipLength(target)
}

/**
 * Where the enlarged clip has got to, published for the pane that asked for it:
 * that pane no longer holds an element of its own to read it from.
 */
function readStageClock(): void {
  const element = stageMedia.value
  if (!(element instanceof HTMLVideoElement)) {
    emit('stage-clock', null)
    return
  }
  const clock = clockOf(element)
  const stream = isStream(element)
  emit('stage-clock', {
    time: (stream ? stageFrom.value : 0) + clock.time,
    length: stream ? null : clock.length
  })
}

/**
 * The clock the bar is drawn from, which has to be continuous across the hand-off
 * in both directions: the display's while it has the clip, the last position the
 * display was at while the clip is on its way back (the element is fresh and has
 * not been moved yet), and this pane's own element otherwise.
 */
const playTime = computed(() => {
  if (props.transferred) return props.displayedClock?.time ?? videoTime.value

  const held = pickUpFrom.value
  if (held !== null && held.key === previewKeyFor(previewTarget.value)) return held.time
  return videoTime.value
})

const playLength = computed(() => {
  // The file's own length, where it has been asked for, over the element's: a
  // stream's length is only what is left of the clip, not the clip.
  const own = clipLength.value ?? videoLength.value
  if (!props.transferred) return own
  return props.displayedClock?.length ?? own
})

/** How much of the clip the bar has filled. */
const playProgress = computed(() => {
  const length = playLength.value
  if (length === null || length <= 0) return '0%'
  const ratio = Math.min(Math.max(playTime.value / length, 0), 1)
  return `${(ratio * 100).toFixed(2)}%`
})

/**
 * Whether the play bar belongs in the footer at all. Not while a clip is still
 * being encoded and nothing has played yet: there is no length to show and no
 * position to show, and a dead `0:00` beside a spinner says less than the
 * spinner alone.
 */
const showPlayBar = computed(
  () =>
    previewTarget.value?.kind === 'video' &&
    (props.transferred === true || showVideo.value) &&
    (playLength.value !== null || playTime.value > 0)
)

/**
 * A position an element has to pick up at, held with the clip it belongs to so
 * that it can never be applied to a different one. Two things put one there: a
 * display handing the clip back, and a seek that had to replace the element —
 * because the file behind it was still being encoded, and only became something
 * the keys can move about once the encode was done. Until the fresh element has
 * been moved, this is also what the bar shows, so the strip does not flicker
 * down to 0:00 on the way.
 */
const pickUpFrom = ref<{ key: string; time: number } | null>(null)

watch(
  () => props.displayedClock,
  (clock) => {
    const key = previewKeyFor(previewTarget.value)
    if (props.transferred !== true || !clock || key === null) return
    pickUpFrom.value = { key, time: clock.time }
  }
)

// A clip coming back to this pane's own element, which has to be read from where
// the display left it: by then the element is a fresh one, and asking the stream
// for that position is the only way a clip main has to encode can start there.
watch(
  () => props.transferred === true,
  (transferred) => {
    if (transferred) return
    const held = pickUpFrom.value
    const target = previewTarget.value
    if (held === null || target === null || held.key !== previewKeyFor(target)) return
    footerFrom.value = held.time
  }
)

/**
 * The clip a display has taken over is played *there*, so this pane asks the file
 * for its length itself: nothing of this pane's own will report one.
 */
watch(
  () => (props.transferred === true ? previewKeyFor(previewTarget.value) : null),
  (key) => {
    if (key === null) return
    const target = previewTarget.value
    if (target) ensureClipLength(target)
  },
  { immediate: true }
)

function previewRect(): DOMRect | null {
  const element = previewEl.value
  if (!element || element.offsetParent === null) return null
  return element.getBoundingClientRect()
}

/**
 * Where this pane's own preview of the clip has got to, for a display about to
 * take the clip over — with the clip it belongs to, so that it can never be
 * carried onto a different one. Null when there is no element (which is what a
 * pane whose clip is already displayed has) and at the very start, where there
 * is nothing to carry over.
 */
function previewPosition(): { key: string; time: number } | null {
  const element = previewVideo.value
  const key = previewKeyFor(previewTarget.value)
  if (!(element instanceof HTMLVideoElement) || key === null) return null

  // Where the clip is, not where this element is: a stream counts from the start
  // of whatever it was given, so a clip that has been moved about is further
  // along than the element's own clock says.
  const at = (isStream(element) ? footerFrom.value : 0) + element.currentTime

  // A preview that has played itself out has nothing to hand over: the display
  // is where the clip is watched, so it starts it again rather than sitting on
  // the last frame the thumbnail stopped at.
  if (element.ended || at <= 0) return null
  return { key, time: at }
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

  // A clip main has to encode is a live stream, which reports no range to move
  // within — so there is nothing for this element to seek to. Moving about such
  // a clip means asking for its stream again from the position wanted, which is
  // what the offset in that element's URL is for: it reloads there and plays on.
  // It is never moved by seeking the element itself, even where the stream has
  // grown a range: that range is the rest of the clip, and its clock is rebased.
  if (!canMoveWithin(element, at) || isStream(element)) {
    const onStage = element === stageMedia.value
    const wanted = Math.max(0, (onStage ? stageFrom.value : footerFrom.value) + element.currentTime + delta)
    if (onStage) {
      stageFrom.value = wanted
    } else {
      footerFrom.value = wanted
      // The bar keeps showing where the clip is being taken while it reloads.
      const key = previewKeyFor(previewTarget.value)
      if (key !== null) pickUpFrom.value = { key, time: wanted }
    }
    return
  }

  element.currentTime = at
  if (wasEnded && at < duration) void element.play().catch(() => {})
}

/**
 * Whether a clip has a real range covering `at`: a clip main is still
 * transcoding arrives as a growing stream, and a stream has nothing to move
 * within — Chromium gives a live source a single empty range. Once the encode is
 * done the same clip is served as a whole file, ranges and all.
 */
function canMoveWithin(element: HTMLVideoElement, at: number): boolean {
  const ranges = element.seekable
  for (let i = 0; i < ranges.length; i += 1) {
    if (ranges.end(i) > 0 && at >= ranges.start(i) && at <= ranges.end(i)) return true
  }
  return false
}

function seekPreview(delta: number): void {
  seek(previewVideo.value, delta)
}

function seekStage(delta: number): void {
  seek(stageMedia.value, delta)
}

/**
 * The wheel's steps. A plain wheel matches the ten-second arrows and the two
 * modifiers match the Ctrl keys: the left button a minute, the right button ten.
 */
const WHEEL_STEP_SECONDS = 10
const WHEEL_STEP_MINUTE = 60
const WHEEL_STEP_TEN_MINUTES = 600

/**
 * Scrub the clip under the wheel. A wheel-up goes forward and a wheel-down
 * back, by the step the held button picks out.
 *
 * Scoped to the media itself: the wheel over a clip scrubs it, while the wheel
 * over the listing still scrolls the listing, and a box with no clip leaves the
 * event alone so nothing is swallowed on its account.
 */
function wheelScrub(
  event: WheelEvent,
  element: HTMLVideoElement | HTMLImageElement | null
): void {
  if (!(element instanceof HTMLVideoElement) || event.deltaY === 0) return

  const step =
    event.buttons & 2
      ? WHEEL_STEP_TEN_MINUTES
      : event.buttons & 1
        ? WHEEL_STEP_MINUTE
        : WHEEL_STEP_SECONDS

  event.preventDefault()
  event.stopPropagation()
  seek(element, event.deltaY < 0 ? step : -step)
}

function onFooterWheel(event: WheelEvent): void {
  wheelScrub(event, previewVideo.value)
}

function onStageWheel(event: WheelEvent): void {
  wheelScrub(event, stageMedia.value)
}

defineExpose({ previewRect, previewPosition, seekPreview, seekStage })

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
    <!-- The pane's own content, which a display blurs as a whole. Clipped to
         its own box: a filter's output is not held inside the element it is on,
         so the blur would spill over the border into the pane next door. -->
    <div ref="paneContent" class="flex min-h-0 grow flex-col [clip-path:inset(0)]">
      <div
        class="flex h-7 shrink-0 items-center gap-2 border-b border-border-subtle px-3"
        :class="active ? 'bg-accent text-fg-bright' : 'bg-surface text-fg-dim'"
      >
        <span class="truncate font-mono text-ui-sm">
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
            @wheel="onFooterWheel"
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
              v-else-if="showVideo && !transferred"
              ref="previewVideo"
              :src="videoUrl ?? undefined"
              muted
              autoplay
              preload="metadata"
              class="h-full w-full object-contain"
              @loadedmetadata="onVideoMetadata"
              @loadeddata="onVideoStarted"
              @playing="onVideoStarted"
              @timeupdate="readVideoClock"
              @seeked="readVideoClock"
              @ended="readVideoClock"
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

          <!-- Where the clip has got to: its position, a bar for how far that is
               through it, and its length — the last two only when the clip is a
               whole file whose length is really known. -->
          <span
            v-if="showPlayBar"
            class="flex shrink-0 items-center gap-2 tabular-nums text-ui-sm text-fg-dim"
          >
            <span>{{ formatDuration(playTime) }}</span>
            <span
              v-if="playLength !== null"
              class="h-1 w-20 overflow-hidden rounded-full bg-border"
            >
              <span
                class="block h-full rounded-full bg-accent-strong"
                :style="{ width: playProgress }"
              />
            </span>
            <span v-if="playLength !== null">{{ formatDuration(playLength) }}</span>
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
    </div>

    <!-- What the pane being navigated has asked this one to display. The listing
         stays where it was and is blurred behind it — `paneContent` above takes
         the blur — so this pane has one thing to look at while the folder it was
         showing is still there. No chrome of its own: the media is the display.
         Pointer events stop here so a click cannot move the cursor's pane away
         from the one being navigated. -->
    <div
      v-if="displaying || shownStage"
      class="absolute inset-0 z-20 flex flex-col"
      @mousedown.stop
      @click.stop
      @dblclick.stop
      @wheel="onStageWheel"
    >
      <div v-if="shownStage" class="relative flex min-h-0 grow items-center justify-center p-3">
        <img
          v-if="showStageImage"
          ref="stageMedia"
          :src="stageFrame ?? undefined"
          alt=""
          draggable="false"
          class="h-full w-full origin-top-left object-contain"
          :class="stageState === 'ready' ? '' : 'invisible'"
          @load="onStageShown"
          @error="onStageError"
        />
        <!-- A display is for watching rather than glancing at, so the clip plays
             on and on here with its sound — the element stays muted until the
             reveal has it fade up, and a failure to load leaves it silent. The
             footer's own thumbnail is the one that plays once, and silently. -->
        <video
          v-else-if="showStageVideo"
          ref="stageMedia"
          :src="stageVideoUrl ?? undefined"
          muted
          autoplay
          loop
          class="h-full w-full origin-top-left object-contain"
          :class="stageState === 'ready' ? '' : 'invisible'"
          @loadedmetadata="resumeStage"
          @loadeddata="onStageShown"
          @timeupdate="readStageClock"
          @seeked="readStageClock"
          @ended="readStageClock"
          @error="onStageError"
        ></video>
        <span
          v-if="stageState === 'loading'"
          class="absolute h-5 w-5 animate-spin rounded-full border-2 border-fg border-t-transparent"
        />
      </div>

      <!-- The row the cursor is on has nothing to show: what this pane is, and
           how to leave it — an empty blurred pane should not read as a fault. -->
      <div
        v-else
        class="flex min-h-0 grow flex-col items-center justify-center gap-1 p-3 text-center"
      >
        <span class="text-ui text-fg">Preview mode</span>
        <span class="text-ui-sm text-fg-dim">Esc to exit</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import FilePanel from '@renderer/components/FilePanel.vue'
import ConfirmTransfer from '@renderer/components/ConfirmTransfer.vue'
import ConfirmDelete from '@renderer/components/ConfirmDelete.vue'
import TerminalPane from '@renderer/components/TerminalPane.vue'
import WorkspaceTabs from '@renderer/components/WorkspaceTabs.vue'
import TitleBar from '@renderer/components/TitleBar.vue'
import FileViewer from '@renderer/components/FileViewer.vue'
import { createWorkspace, type Workspace } from '@renderer/composables/useWorkspace'
import type { PaneController, PaneEntry } from '@renderer/composables/useDirectory'
import {
  loadTranscodeSupport,
  previewKeyFor,
  previewTargetFor,
  type PlaybackClock,
  type StageRequest
} from '@renderer/lib/preview'
import { playSwapAnimation } from '@renderer/lib/swapAnimation'
import type { PanelSide } from '@shared/types'

/**
 * The app is a stack of workspaces — one tab each. A workspace owns its own
 * pair of file panes and its own shell, so switching tabs switches sessions
 * rather than just moving the cursor. Only the active workspace is rendered;
 * the others keep their state in their controllers and shells, and their
 * terminal view is recreated (replaying the session buffer) when they come
 * back, exactly as a reload does.
 */
let workspaceSeq = 0

function makeWorkspace(): Workspace {
  workspaceSeq += 1
  return createWorkspace(`ws-${workspaceSeq}`, `Terminal ${workspaceSeq}`)
}

const workspaces = shallowRef<Workspace[]>([makeWorkspace()])
const activeIndex = ref(0)

const activeWorkspace = computed(() => workspaces.value[activeIndex.value] ?? workspaces.value[0]!)

/**
 * The active workspace's bindings, surfaced as plain computeds so the rest of
 * the component (and the template) reads them the way the old single-workspace
 * code did. They re-evaluate when the active workspace, or one of its refs,
 * changes — a Ctrl+U swap inside a workspace included.
 */
const left = computed(() => activeWorkspace.value.left.value)
const right = computed(() => activeWorkspace.value.right.value)
const activeSide = computed(() => activeWorkspace.value.activeSide.value)
const activePane = computed(() => activeWorkspace.value.activePane.value)
const inactivePane = computed(() => activeWorkspace.value.inactivePane.value)
const activePanePath = computed(() => activeWorkspace.value.activePanePath.value)
const terminalExpanded = computed(() => activeWorkspace.value.terminalExpanded.value)
const terminalFocused = computed(() => activeWorkspace.value.terminalFocused.value)
const shell = computed(() => activeWorkspace.value.shell)
const shellInput = computed(() => shell.value.inputLine.value)

/**
 * The file shown in the Monaco viewer, or null when it is closed. The viewer is
 * an overlay over the panes and terminal, so a non-null value is what "the
 * viewer is open" means — exactly like the staged dialogs below. `viewerMode`
 * is whether it was opened read-only (F3) or for editing (F4).
 */
const viewerPath = ref<string | null>(null)
const viewerMode = ref<'view' | 'edit'>('view')
const viewerRef = ref<InstanceType<typeof FileViewer> | null>(null)

/**
 * F8 never deletes on its own: it stages the pane's targets here and the
 * dialog confirms them. A non-empty list is what "the dialog is open" means.
 */
const deleteTargets = ref<PaneEntry[]>([])

/**
 * F5 stages the active pane's targets and the other pane's directory here. Like
 * the delete dialog, a non-null value is what "the copy dialog is open" means.
 * The destination is only the field's initial value: the dialog can edit it,
 * and whatever it emits on confirm is what is copied.
 */
const copyJob = ref<{ entries: PaneEntry[]; destination: string } | null>(null)

/**
 * F6 stages the same thing for a move: the active pane's targets and the other
 * pane's directory, which the dialog can edit before confirming.
 */
const moveJob = ref<{ entries: PaneEntry[]; destination: string } | null>(null)

/**
 * The pane that is displaying another pane's media, or null when none is. Enter
 * on an image or a video puts the app in this mode: the cursor stays where it
 * is — in the pane that asked — and the *other* pane becomes a display for
 * whatever that cursor is on, following it from row to row until Escape.
 */
const stageSide = ref<PanelSide | null>(null)

/** The pane being navigated while a display is up: always the one that asked for it. */
const stageSource = computed<PanelSide | null>(() =>
  stageSide.value === null ? null : stageSide.value === 'left' ? 'right' : 'left'
)

/**
 * The media the display is showing, derived from the source pane's cursor — so
 * navigating updates it without anything having to be told, and leaving media
 * for an ordinary file empties the display rather than freezing the last one.
 */
const stageTarget = computed(() => {
  const side = stageSource.value
  if (side === null) return null
  return previewTargetFor((side === 'left' ? left.value : right.value).current())
})

/**
 * The reveal is for arriving in the mode, not for every row the cursor crosses
 * while one is up: this counts the times a display is asked for, so that the
 * media growing out of its thumbnail is the gesture of entering the mode — and
 * of the cursor coming back onto a file that has something to show, where
 * nothing grew out of a thumbnail in the first place.
 */
const stageAnimation = ref(0)

watch(stageSide, (side) => {
  if (side !== null) stageAnimation.value += 1
})

const leftPanel = ref<InstanceType<typeof FilePanel> | null>(null)
const rightPanel = ref<InstanceType<typeof FilePanel> | null>(null)

/**
 * What the displaying pane is asked to show. It reaches back through the source
 * pane's own footer box at the moment it is about to be revealed, rather than
 * holding a rectangle that would be stale as soon as the cursor moved.
 */
const stageRequest = computed<StageRequest | null>(() => {
  const target = stageTarget.value
  const side = stageSource.value
  if (target === null || side === null) return null

  const asking = side === 'left' ? leftPanel : rightPanel
  const held = stageResume.value

  return {
    target,
    animation: stageAnimation.value,
    resumeAt: held !== null && held.key === previewKeyFor(target) ? held.time : null,
    from: () => asking.value?.previewRect() ?? null
  }
})

/**
 * Where the enlarged clip has got to, as the display reports it. The pane that
 * asked for the display no longer plays that clip itself, so this is what its
 * play bar is drawn from.
 */
const displayedClock = ref<PlaybackClock | null>(null)

/**
 * The pane whose cursor media a display has taken over: it is the one being
 * navigated, and the one that gives up its own copy of the clip.
 */
const transferredSide = computed<PanelSide | null>(() =>
  stageSide.value === null ? null : stageSource.value
)

/**
 * Where the clip was playing in the pane that asked for the display, taken when
 * it asked. It has to be taken *then* rather than read later: the ask is what
 * takes the element that was playing it away.
 */
const stageResume = ref<{ key: string; time: number } | null>(null)

/**
 * A position belongs to the clip it was taken from and to the request that took
 * it: once the display has moved on to another clip, it is not carried back.
 */
watch(stageTarget, (target) => {
  const held = stageResume.value
  if (held !== null && previewKeyFor(target) !== held.key) stageResume.value = null
})

/**
 * Display the media under the active pane's cursor in the other pane. Pressing
 * Enter again on what is already displayed takes the display away.
 */
function toggleStage(): void {
  if (stageSide.value !== null) {
    exitStage()
    return
  }

  showStage(activeSide.value)
}

/**
 * Put `side`'s preview up in the other pane — clicking its thumbnail, the
 * mouse's way of the gesture Enter makes. Only ever turns the display on: one
 * already up is left alone, since leaving the mode has its own gestures
 * (Escape, or a right-click on the pane showing it).
 */
function showStage(side: PanelSide): void {
  if (stageSide.value !== null) return

  const asking = side === 'left' ? leftPanel : rightPanel
  // Taken before the display exists, because the display is what takes the
  // element that was playing the clip away.
  stageResume.value = asking.value?.previewPosition() ?? null
  stageSide.value = side === 'left' ? 'right' : 'left'
}

function exitStage(): void {
  stageSide.value = null
  displayedClock.value = null
  stageResume.value = null
}

/**
 * How far the arrow keys step through a clip while the command line is empty.
 */
const SEEK_SECONDS = 10

/**
 * How far the coarser playback keys step: Ctrl+J/Ctrl+L a minute back and
 * forward, Ctrl+H/Ctrl+; ten. Keyed by the lower-cased `event.key` that fires
 * each, so `;` needs no special case.
 */
const SEEK_STEPS: Readonly<Record<string, number>> = {
  j: -60,
  l: 60,
  h: -600,
  ';': 600
}

/**
 * Step through the clip being previewed: the one under the cursor of the pane
 * being navigated, and — when a display is up — the same clip as the other pane
 * is showing, so the two never drift apart.
 */
function seekPreview(delta: number): void {
  const active = activeSide.value === 'left' ? leftPanel : rightPanel
  active.value?.seekPreview(delta)

  if (stageSide.value === null) return
  const showing = stageSide.value === 'left' ? leftPanel : rightPanel
  showing.value?.seekStage(delta)
}

/**
 * Pause or resume the clip being watched: the display's when one is up, since
 * its pane no longer plays a copy of its own, and the footer's otherwise.
 * Answers whether there was a clip to toggle, so Space can stay the shell's
 * space when there is nothing to pause.
 */
function togglePlayback(): boolean {
  if (stageSide.value !== null) {
    const showing = stageSide.value === 'left' ? leftPanel : rightPanel
    return showing.value?.toggleStagePlayback() ?? false
  }

  const active = activeSide.value === 'left' ? leftPanel : rightPanel
  return active.value?.togglePreviewPlayback() ?? false
}

const panelHost = ref<HTMLElement | null>(null)
const terminalRef = ref<InstanceType<typeof TerminalPane> | null>(null)

/**
 * Where the two panes meet, as the left pane's share of the row. The line
 * between them is a handle rather than a fixed border, so dragging it moves the
 * boundary; it belongs to the window's layout and not to a workspace, so it
 * survives a tab switch like the title bar does. Both panes are `flex-1` (an
 * equal basis of zero), so weighting their grow is the whole of the sizing.
 */
const DEFAULT_SPLIT = 0.5

/** Keep a sliver of either pane, so the handle can always be found again. */
const MIN_SPLIT = 0.15
const MAX_SPLIT = 0.85

/** A drag that ends this near the middle reads as centred, so the handle snaps. */
const SPLIT_SNAP = 0.02

const splitRatio = ref(DEFAULT_SPLIT)

/** Off-centre is what puts the re-centre button on the handle. */
const splitCentered = computed(() => splitRatio.value === DEFAULT_SPLIT)

function clampSplit(ratio: number): number {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio))
}

function centerSplit(): void {
  splitRatio.value = DEFAULT_SPLIT
}

/**
 * Drag the boundary. The move is measured against the row's width rather than
 * the pane's, so the handle keeps up with the pointer wherever the split
 * currently is. The listeners are on the window, not the handle: the pointer
 * leaves a one-pixel line immediately, and it is the drag — not the element —
 * that owns the gesture until the button is released.
 */
function startSplitDrag(event: PointerEvent): void {
  if (event.button !== 0) return
  const host = panelHost.value
  if (!host) return
  const span = host.getBoundingClientRect().width
  if (span <= 0) return

  event.preventDefault()
  const startX = event.clientX
  const startRatio = splitRatio.value

  const move = (moveEvent: PointerEvent): void => {
    const ratio = clampSplit(startRatio + (moveEvent.clientX - startX) / span)
    splitRatio.value = Math.abs(ratio - DEFAULT_SPLIT) <= SPLIT_SNAP ? DEFAULT_SPLIT : ratio
  }

  const finish = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    document.body.style.cursor = ''
  }

  document.body.style.cursor = 'col-resize'
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
}

function setActive(side: PanelSide): void {
  activeWorkspace.value.activeSide.value = side
}

function swapPanels(): void {
  // A display goes whatever swapped the panes, but its own gesture is the media
  // shrinking back onto the thumbnail it came from, so the exchange goes through
  // unanimated rather than as a second motion under that one.
  const wasDisplaying = stageSide.value !== null
  exitStage()

  const host = panelHost.value
  const leftPane = leftPanel.value?.$el as HTMLElement | undefined
  const rightPane = rightPanel.value?.$el as HTMLElement | undefined

  if (wasDisplaying || !host || !leftPane || !rightPane) {
    activeWorkspace.value.swapPanels()
    return
  }

  playSwapAnimation({
    host,
    left: leftPane,
    right: rightPane,
    apply: () => activeWorkspace.value.swapPanels()
  })
}

function setTerminalFocused(value: boolean): void {
  activeWorkspace.value.terminalFocused.value = value
}

/**
 * Collapsed, the strip is the command line and holds focus so typing reaches
 * the shell. Expanded, it is a real terminal and owns the keyboard outright.
 */
function focusPanes(): void {
  if (terminalExpanded.value) {
    panelHost.value?.focus()
    return
  }
  terminalRef.value?.focusTerminal()
}

/**
 * Whether the element holding focus belongs to nothing the app cares about: the
 * document body, which is where a click on non-focusable chrome (the title bar,
 * a pane border, a footer strip) leaves it, or the panel host once the terminal
 * is collapsed and the command line is the default target again.
 */
function focusIsUnclaimed(): boolean {
  const active = document.activeElement
  if (!active || active === document.body) return true
  return active === panelHost.value && !terminalExpanded.value
}

/**
 * The command line is the app's default focus target, but DOM focus can fall to
 * an unclaimed element and stay there: clicking non-interactive chrome moves it
 * to `<body>`, and when the window manager reactivates the window with a click
 * it consumed for activation, nothing inside the app ever learns it happened.
 * The command line then renders its hollow, unfocused cursor and typing has
 * nowhere to go — the state a user can only escape by toggling the terminal,
 * which re-runs the focus path.
 *
 * Re-assert the focus model whenever focus lands on an unclaimed element.
 * Anything that legitimately owns the keyboard — the terminal, the search box,
 * a rename, the viewer, a dialog — is the active element, so it is never
 * disturbed, and the viewer and dialogs are excluded outright.
 */
function restoreFocus(): void {
  if (viewerPath.value !== null) return
  if (deleteTargets.value.length > 0 || copyJob.value !== null || moveJob.value !== null) return
  if (!focusIsUnclaimed()) return
  focusPanes()
}

// A focus change is one synchronous burst, so the check is deferred a macrotask:
// by then a real new target has taken focus and only a genuine drop is restored.
function onFocusDrop(): void {
  window.setTimeout(restoreFocus, 0)
}

function toggleTerminal(): void {
  if (terminalExpanded.value) {
    collapseTerminal()
    return
  }
  activeWorkspace.value.terminalExpanded.value = true
}

function collapseTerminal(): void {
  activeWorkspace.value.terminalExpanded.value = false
  void nextTick(() => terminalRef.value?.focusTerminal())
}

function toggleSearch(): void {
  const pane = activePane.value
  if (pane.state.searchActive) pane.closeSearch()
  else pane.openSearch()
}

/**
 * Workspace tabs. Ctrl+T opens a new terminal — a fresh pair of panes at home
 * plus a new shell — at the right of the strip and focuses it; Ctrl+W closes
 * the active one; Ctrl+PageDown / Ctrl+PageUp step to the next and previous
 * tab. The last workspace is never closed, so the app always has somewhere to
 * be.
 */
function addWorkspace(): void {
  exitStage()
  const workspace = makeWorkspace()
  workspaces.value = [...workspaces.value, workspace]
  activeIndex.value = workspaces.value.length - 1
  void workspace.init()
  void nextTick(() => focusPanes())
}

function selectWorkspace(index: number): void {
  if (index === activeIndex.value) {
    toggleTerminal()
    return
  }
  exitStage()
  activeIndex.value = index
  void nextTick(() => focusPanes())
}

function closeWorkspace(index: number): void {
  if (workspaces.value.length <= 1) return
  exitStage()
  const workspace = workspaces.value[index]
  if (!workspace) return

  const next = workspaces.value.filter((_, i) => i !== index)
  workspaces.value = next

  if (index < activeIndex.value) activeIndex.value -= 1
  else if (index === activeIndex.value) activeIndex.value = Math.min(index, next.length - 1)

  workspace.dispose()
  void nextTick(() => focusPanes())
}

function switchWorkspace(delta: number): void {
  const count = workspaces.value.length
  if (count <= 1) return
  exitStage()
  activeIndex.value = (activeIndex.value + delta + count) % count
  void nextTick(() => focusPanes())
}

/**
 * Move a tab to another position in the strip, keeping it active. The list is a
 * shallowRef, so a splice has to go through a fresh array for the change to be
 * seen. Used by both Shift+Ctrl+PageUp/PageDown and drag-and-drop.
 */
function moveWorkspace(from: number, to: number): void {
  const count = workspaces.value.length
  if (from === to || from < 0 || from >= count || to < 0 || to >= count) return
  const next = [...workspaces.value]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  workspaces.value = next
  activeIndex.value = to
  void nextTick(() => focusPanes())
}

/**
 * F3 opens a regular file read-only in the Monaco viewer, F4 opens it for
 * editing. Directories keep their previous F3 meaning (descend), and anything
 * that is not a regular file — a socket, FIFO or device — is left alone rather
 * than fed to a text editor.
 */
function openViewer(target: string, mode: 'view' | 'edit'): void {
  viewerMode.value = mode
  viewerPath.value = target
}

/**
 * Closing is deferred to the viewer so an edit with unsaved changes can ask
 * first; the viewer is the only thing that knows whether the buffer is dirty.
 */
function closeViewer(): void {
  if (viewerRef.value && !viewerRef.value.confirmClose()) return
  viewerPath.value = null
  focusPanes()
}

function requestDelete(): void {
  // Capture the targets now: the pane can refresh under the dialog, but what is
  // shown (and what is deleted on confirm) must be what was highlighted.
  const targets = activePane.value.deletionTargets()
  if (targets.length === 0) return
  deleteTargets.value = targets
}

function cancelDelete(): void {
  deleteTargets.value = []
  focusPanes()
}

async function confirmDelete(): Promise<void> {
  const pane = activePane.value
  deleteTargets.value = []
  await pane.deleteEntries()
  focusPanes()
}

/**
 * F5 copies into the other pane, so the source is the active pane and the
 * destination is the inactive one. Capture both now: the dialog is modal, but
 * the panes can still refresh under it.
 */
function requestCopy(): void {
  const targets = activePane.value.selectionTargets()
  const destination = inactivePane.value.state.path
  if (targets.length === 0 || !destination) return
  copyJob.value = { entries: targets, destination }
}

function cancelCopy(): void {
  copyJob.value = null
  focusPanes()
}

/**
 * The panes a transfer's new entries can appear in. The target always gains
 * them; the source does too when the destination field names something main
 * will resolve inside it — a relative path like `sub` becomes `<source>/sub`,
 * so a folder appears in the source pane. Both are marked as making the change
 * themselves, so neither sweeps what the user just copied or moved in.
 */
function transferPanes(
  source: PaneController,
  target: PaneController,
  destination: string
): PaneController[] {
  return destination.startsWith('/') ? [target] : [source, target]
}

async function confirmCopy(destination: string): Promise<void> {
  const source = activePane.value
  const target = inactivePane.value
  copyJob.value = null

  const panes = transferPanes(source, target, destination)
  for (const pane of panes) pane.beginSelfChange()
  try {
    // The handler resolves a relative destination against the source pane, so
    // the resolved directory is what a pane showing it must be compared against.
    const resolved = await source.copyEntries(destination)
    if (resolved && target.state.path === resolved) await target.refresh()
  } finally {
    for (const pane of panes) pane.endSelfChange()
  }
  focusPanes()
}

/**
 * F6 moves into the other pane, mirroring F5: the source is the active pane and
 * the destination is the inactive one. Capture both now, since the dialog is
 * modal but the panes can still refresh under it.
 */
function requestMove(): void {
  const targets = activePane.value.selectionTargets()
  const destination = inactivePane.value.state.path
  if (targets.length === 0 || !destination) return
  moveJob.value = { entries: targets, destination }
}

function cancelMove(): void {
  moveJob.value = null
  focusPanes()
}

async function confirmMove(destination: string): Promise<void> {
  const source = activePane.value
  const target = inactivePane.value
  moveJob.value = null

  const panes = transferPanes(source, target, destination)
  for (const pane of panes) pane.beginSelfChange()
  try {
    const resolved = await source.moveEntries(destination)
    if (resolved && target.state.path === resolved) await target.refresh()
  } finally {
    for (const pane of panes) pane.endSelfChange()
  }
  focusPanes()
}

watch(
  () => left.value.state.searchActive || right.value.state.searchActive,
  (anyActive, wasActive) => {
    if (!wasActive || anyActive) return
    if (!terminalExpanded.value) terminalRef.value?.focusTerminal()
  }
)

/**
 * Claim a key for the app. `preventDefault` is not enough on its own: xterm
 * handles keys from a capture listener on its own textarea and does not consult
 * `defaultPrevented`, so without stopping propagation it would also forward the
 * key to the shell (Up recalling history, Home moving the line cursor).
 */
function consume(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

function isPlainCtrl(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
}

function isCtrlShift(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
}

function handlePaneKey(event: KeyboardEvent): void {
  const pane = activePane.value
  const searching = pane.state.searchActive
  const hasInput = shellInput.value.length > 0

  // An in-place rename hands the keyboard to its input, exactly like search:
  // printable characters, Backspace and the arrow keys edit the text, and
  // Enter/Escape are the input's to commit or cancel.
  if (pane.state.renaming !== null) return

  if (event.key === 'Tab') {
    consume(event)
    setActive(activeSide.value === 'left' ? 'right' : 'left')
    return
  }

  // Ctrl+U swaps the panels. It is claimed here rather than beside Ctrl+O and
  // Ctrl+R so that an expanded, focused terminal keeps its own Ctrl+U
  // (kill-line): this function only runs once the terminal has been ruled out
  // as the owner of the keyboard.
  if (
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === 'u'
  ) {
    consume(event)
    swapPanels()
    return
  }

  // The coarser companions to the ten-second arrows: Ctrl+J/Ctrl+L step the
  // clip being previewed by a minute, Ctrl+H/Ctrl+; by ten. Like the arrows
  // they are the clip's only while the command line has nothing typed in it —
  // Ctrl+H is the line editor's backspace, Ctrl+L clears the terminal screen
  // and Ctrl+J accepts the line — and an expanded, focused terminal never
  // reaches here at all.
  if (isPlainCtrl(event) && !searching && !hasInput) {
    const step = SEEK_STEPS[event.key.toLowerCase()]
    if (step !== undefined) {
      consume(event)
      seekPreview(step)
      return
    }
  }

  if (event.ctrlKey || event.altKey || event.metaKey) return

  // Space is the clip's play/pause while the command line is empty — the
  // display's clip, or the footer preview under the cursor. With nothing to
  // play it stays a space for the shell, so a command can still start with one.
  if (event.key === ' ' && !event.repeat && !searching && !hasInput) {
    if (togglePlayback()) {
      consume(event)
      return
    }
  }

  if (event.key === 'Escape') {
    consume(event)
    if (searching) {
      pane.closeSearch()
      return
    }
    if (hasInput) {
      shell.value.clearInputLine()
      return
    }
    if (terminalExpanded.value) collapseTerminal()
    return
  }

  // Backspace belongs to whichever input owns the text — the shell's line
  // editor or the search box. It deliberately does not navigate the panel.
  if (event.key === 'Backspace' || event.key === 'Delete') return

  if (event.repeat && event.key === 'Enter') {
    consume(event)
    return
  }

  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      // With nothing typed on the command line the arrows have no line to edit,
      // so they step through the clip being previewed instead — back or forward
      // by ten seconds. A typed line, or an open search box, takes them back:
      // there they belong to the text, not to the clip.
      if (searching || hasInput) return
      consume(event)
      seekPreview(event.key === 'ArrowLeft' ? -SEEK_SECONDS : SEEK_SECONDS)
      break
    }
    case 'ArrowDown':
      consume(event)
      pane.moveCursor(1)
      break
    case 'ArrowUp':
      consume(event)
      pane.moveCursor(-1)
      break
    case 'PageDown':
      consume(event)
      pane.movePage(1)
      break
    case 'PageUp':
      consume(event)
      pane.movePage(-1)
      break
    case 'Home':
      consume(event)
      pane.moveTo(0)
      break
    case 'End':
      consume(event)
      pane.moveTo(pane.state.entries.length - 1)
      break
    case 'Insert':
      consume(event)
      pane.toggleSelection()
      break
    case 'F3': {
      consume(event)
      const entry = pane.current()
      if (!entry) break
      if (entry.isParent || entry.kind === 'directory') void pane.activate()
      else if (entry.kind === 'file') openViewer(entry.path, 'view')
      break
    }
    case 'F4': {
      consume(event)
      const entry = pane.current()
      if (entry && !entry.isParent && entry.kind === 'file') openViewer(entry.path, 'edit')
      break
    }
    case 'F5':
      consume(event)
      requestCopy()
      break
    case 'F8':
      consume(event)
      requestDelete()
      break
    case 'F6':
      consume(event)
      if (event.shiftKey) pane.beginRename()
      else requestMove()
      break
    case 'Enter':
      // With a line typed, fall through to the shell and leave the terminal
      // exactly as the user left it.
      if (hasInput) return
      consume(event)
      // An image or a video is displayed in the other pane rather than handed
      // to whatever the system opens it with; anything else — a directory, an
      // ordinary file — opens exactly as it did.
      if (previewTargetFor(pane.current()) === null) void pane.activate()
      else toggleStage()
      break
    default:
      break
  }
}

function onKeydown(event: KeyboardEvent): void {
  // The viewer owns the keyboard while it is open — Monaco handles Ctrl+F and
  // the rest itself — so nothing here consumes keys except Escape, which closes
  // it. This also covers the error state, where no editor was created to close.
  if (viewerPath.value !== null) {
    if (event.key === 'Escape') {
      consume(event)
      closeViewer()
    }
    return
  }

  // The dialogs are modal. Escape cancels; every other key is left to the
  // dialog (its default button is focused, arrows move between the buttons,
  // Enter activates the focused one) instead of reaching the panes or shell.
  if (
    deleteTargets.value.length > 0 ||
    copyJob.value !== null ||
    moveJob.value !== null
  ) {
    if (event.key === 'Escape') {
      consume(event)
      if (deleteTargets.value.length > 0) cancelDelete()
      else if (moveJob.value !== null) cancelMove()
      else cancelCopy()
    }
    return
  }

  // A display is a mode of the panes rather than an overlay of their own: the
  // cursor stays in the pane that asked for it, so Tab must not move the
  // keyboard — and with it which cursor is being displayed — to the other pane,
  // and Escape is what leaves.
  if (stageSide.value !== null) {
    if (event.key === 'Escape') {
      consume(event)
      exitStage()
      return
    }
    if (event.key === 'Tab') {
      consume(event)
      return
    }
  }

  const isSearchToggle =
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.code === 'KeyS'

  if (isSearchToggle) {
    event.preventDefault()
    event.stopPropagation()
    toggleSearch()
    return
  }

  const isTerminalToggle =
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === 'o'

  if (isTerminalToggle) {
    event.preventDefault()
    event.stopPropagation()
    toggleTerminal()
    return
  }

  const isRefresh =
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === 'r'

  if (isRefresh) {
    event.preventDefault()
    event.stopPropagation()
    void activePane.value.refresh()
    return
  }

  // Shift+Ctrl+PageUp/PageDown reorder the active tab rather than stepping to
  // another one. Claimed globally, like the plain-Ctrl tab keys below.
  if (isCtrlShift(event) && (event.key === 'PageUp' || event.key === 'PageDown')) {
    consume(event)
    moveWorkspace(activeIndex.value, activeIndex.value + (event.key === 'PageUp' ? -1 : 1))
    return
  }

  // Workspace tabs are claimed globally, like Ctrl+O and Ctrl+R, so they manage
  // tabs even while the expanded terminal owns the keyboard.
  if (isPlainCtrl(event)) {
    const key = event.key.toLowerCase()
    if (key === 't') {
      consume(event)
      addWorkspace()
      return
    }
    if (key === 'w') {
      consume(event)
      closeWorkspace(activeIndex.value)
      return
    }
    if (event.key === 'PageDown') {
      consume(event)
      switchWorkspace(1)
      return
    }
    if (event.key === 'PageUp') {
      consume(event)
      switchWorkspace(-1)
      return
    }
  }

  // Expanded and focused means it is a real terminal: it owns the keyboard.
  if (terminalExpanded.value && terminalFocused.value) return

  handlePaneKey(event)
}

/**
 * Registered in setup, before any child mounts, so it runs ahead of xterm's own
 * capture listener. `stopPropagation` in `consume` is what actually keeps
 * navigation keys away from the shell.
 */
window.addEventListener('keydown', onKeydown, { capture: true })

// Focus can be lost to an element that owns nothing — a click on chrome, or the
// window manager's activation click — so the command line is re-asserted on both
// a window focus and any focus change that lands on an unclaimed element.
window.addEventListener('focus', restoreFocus)
document.addEventListener('focusout', onFocusDrop)

onMounted(() => {
  for (const workspace of workspaces.value) void workspace.init()
  // What a file is previewable as depends on whether main can transcode what
  // Chromium cannot play, so the answer is asked for before any cursor lands.
  void loadTranscodeSupport()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, { capture: true })
  window.removeEventListener('focus', restoreFocus)
  document.removeEventListener('focusout', onFocusDrop)
  for (const workspace of workspaces.value) workspace.dispose()
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-bg text-fg select-none">
    <TitleBar>
      <WorkspaceTabs
        :tabs="workspaces"
        :active-index="activeIndex"
        @select="selectWorkspace"
        @close="closeWorkspace"
        @create="addWorkspace"
        @reorder="moveWorkspace"
      />
    </TitleBar>

    <!-- The wrapper is the positioning context for the viewer overlay, which
         covers the panes and the terminal but leaves the title bar visible.
         `grow` keeps the panes' terminal-driven flex behaviour. -->
    <div class="relative flex min-h-0 grow flex-col">
      <main
        ref="panelHost"
        tabindex="-1"
        class="flex min-h-0 shrink basis-0 overflow-hidden outline-none transition-[flex-grow] duration-150 ease-out"
        :class="terminalExpanded ? 'grow-0' : 'grow'"
      >
        <FilePanel
          :key="`${activeWorkspace.id}:left`"
          ref="leftPanel"
          :controller="left"
          :active="activeSide === 'left'"
          :stage="stageSide === 'left' ? stageRequest : null"
          :displaying="stageSide === 'left'"
          :transferred="transferredSide === 'left'"
          :displayed-clock="transferredSide === 'left' ? displayedClock : null"
          :style="{ flexGrow: splitRatio }"
          @select="setActive('left')"
          @pointer-down="focusPanes"
          @stage-clock="displayedClock = $event"
          @stage-on="showStage('left')"
          @stage-off="exitStage()"
        />
        <!-- The boundary between the panes, and the handle that moves it: the
             line stays a pixel, while an invisible band around it is what the
             pointer actually grabs. The re-centre button hangs off its bottom
             once the split has been dragged off-centre. -->
        <div class="relative w-px shrink-0 bg-border">
          <div
            class="absolute inset-y-0 -left-1 -right-1 z-10 cursor-col-resize"
            @pointerdown="startSplitDrag"
          ></div>
          <button
            v-if="!splitCentered"
            type="button"
            class="absolute bottom-1 left-1/2 z-20 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface text-fg-dim shadow transition-colors hover:bg-hover hover:text-fg"
            title="Center the panes"
            aria-label="Center the panes"
            @click="centerSplit"
          >
            <svg
              viewBox="0 0 24 24"
              class="h-3 w-3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3v18" />
              <path d="M5 9.5 8.5 12 5 14.5" />
              <path d="M19 9.5 15.5 12 19 14.5" />
            </svg>
          </button>
        </div>
        <FilePanel
          :key="`${activeWorkspace.id}:right`"
          ref="rightPanel"
          :controller="right"
          :active="activeSide === 'right'"
          :stage="stageSide === 'right' ? stageRequest : null"
          :displaying="stageSide === 'right'"
          :transferred="transferredSide === 'right'"
          :displayed-clock="transferredSide === 'right' ? displayedClock : null"
          :style="{ flexGrow: 1 - splitRatio }"
          @select="setActive('right')"
          @pointer-down="focusPanes"
          @stage-clock="displayedClock = $event"
          @stage-on="showStage('right')"
          @stage-off="exitStage()"
        />
      </main>

      <TerminalPane
        ref="terminalRef"
        :key="activeWorkspace.id"
        :shell="activeWorkspace.shell"
        :expanded="terminalExpanded"
        :cwd="activePanePath"
        @focused-change="setTerminalFocused"
        @collapse="collapseTerminal"
      />

      <FileViewer
        v-if="viewerPath !== null"
        ref="viewerRef"
        :key="`${viewerMode}:${viewerPath}`"
        :path="viewerPath"
        :mode="viewerMode"
        @close="closeViewer"
      />
    </div>

    <ConfirmTransfer
      v-if="copyJob"
      :entries="copyJob.entries"
      :destination="copyJob.destination"
      mode="copy"
      @confirm="confirmCopy"
      @cancel="cancelCopy"
    />

    <ConfirmTransfer
      v-if="moveJob"
      :entries="moveJob.entries"
      :destination="moveJob.destination"
      mode="move"
      @confirm="confirmMove"
      @cancel="cancelMove"
    />

    <ConfirmDelete
      v-if="deleteTargets.length > 0"
      :entries="deleteTargets"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </div>
</template>

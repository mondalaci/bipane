<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import FilePanel from '@renderer/components/FilePanel.vue'
import ConfirmTransfer from '@renderer/components/ConfirmTransfer.vue'
import ConfirmDelete from '@renderer/components/ConfirmDelete.vue'
import TerminalPane from '@renderer/components/TerminalPane.vue'
import TitleBar from '@renderer/components/TitleBar.vue'
import FileViewer from '@renderer/components/FileViewer.vue'
import { useDirectory, type PaneController, type PaneEntry } from '@renderer/composables/useDirectory'
import { useShell } from '@renderer/composables/useShell'
import type { PanelSide } from '@shared/types'

/**
 * The controller each column renders. They are refs rather than constants
 * because Ctrl+U exchanges them: swapping the controllers moves each directory
 * together with its cursor, marks and filter and needs no re-listing, and it
 * leaves `activeSide` meaningful as a physical column, so the pane that was
 * active stays under the user's cursor.
 */
const left = shallowRef<PaneController>(useDirectory('left'))
const right = shallowRef<PaneController>(useDirectory('right'))

const shell = useShell()
const shellCwd = shell.cwd
const shellIdle = shell.idle
const shellStarted = shell.started
const shellInput = shell.inputLine
const shellCommand = shell.commandSeq

const activeSide = ref<PanelSide>('left')
const terminalExpanded = ref(false)
const terminalFocused = ref(false)
const panelHost = ref<HTMLElement | null>(null)
const terminalRef = ref<InstanceType<typeof TerminalPane> | null>(null)

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

const activePane = computed(() => (activeSide.value === 'left' ? left.value : right.value))
const inactivePane = computed(() => (activeSide.value === 'left' ? right.value : left.value))
const activePanePath = computed(() => activePane.value.state.path)

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

/**
 * Panel -> shell cwd sync has to type a real `cd` into a real prompt, so the
 * shell echoes it and the strip fills up with commands the user never issued.
 * Appending a printf that walks back over the echoed line and clears it hides
 * the sync, and `&&` means a failed `cd` still shows its error.
 */
const ERASE_ECHO = "printf '\\033[1A\\033[2K'"

function setActive(side: PanelSide): void {
  activeSide.value = side
}

/**
 * Ctrl+U exchanges the two panels. The swap is a rebinding, not a re-listing:
 * each controller keeps its directory, cursor, marks and filter, and they simply
 * trade columns. `activeSide` is flipped with them so the active pane follows its
 * directory to the other column rather than the highlight staying put.
 */
function swapPanels(): void {
  const previous = left.value
  left.value = right.value
  right.value = previous
  setActive(activeSide.value === 'left' ? 'right' : 'left')
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

function toggleTerminal(): void {
  if (terminalExpanded.value) {
    collapseTerminal()
    return
  }
  terminalExpanded.value = true
}

function collapseTerminal(): void {
  terminalExpanded.value = false
  void nextTick(() => terminalRef.value?.focusTerminal())
}

function toggleSearch(): void {
  const pane = activePane.value
  if (pane.state.searchActive) pane.closeSearch()
  else pane.openSearch()
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

// A filter belongs to the pane it was typed in.
watch(activeSide, (side) => {
  const inactive = side === 'left' ? right.value : left.value
  inactive.closeSearch()
})

watch(
  () => left.value.state.searchActive || right.value.state.searchActive,
  (anyActive, wasActive) => {
    if (!wasActive || anyActive) return
    if (!terminalExpanded.value) terminalRef.value?.focusTerminal()
  }
)

/**
 * cwd sync runs both ways, which needs care: the shell's cwd is polled, so a
 * read can be stale for a moment after we push a `cd`. `pendingPush` marks the
 * path we asked for so those stale reads are ignored instead of bouncing the
 * panel back to where it came from.
 */
let pendingPush: string | null = null
let pendingTimer: number | null = null

function clearPendingPush(): void {
  pendingPush = null
  if (pendingTimer === null) return
  window.clearTimeout(pendingTimer)
  pendingTimer = null
}

function pushCwdToShell(): void {
  // Never write into a shell that is busy, or into a half-typed command line:
  // the text would be fed to whatever is running, or appended to the command.
  if (!shellStarted.value || !shellIdle.value) return
  if (shellInput.value.length > 0) return

  const target = activePanePath.value
  if (!target || target === shellCwd.value || target === pendingPush) return

  pendingPush = target
  if (pendingTimer !== null) window.clearTimeout(pendingTimer)
  pendingTimer = window.setTimeout(clearPendingPush, 3000)

  shell.write(`cd ${shellQuote(target)} && ${ERASE_ECHO}\r`)
}

watch([activePanePath, shellIdle, shellStarted, shellInput], pushCwdToShell)

watch(shellCwd, (next) => {
  if (!next) return

  if (pendingPush !== null) {
    if (next === pendingPush) clearPendingPush()
    return
  }

  if (next === activePanePath.value) return
  void activePane.value.navigateTo(next)
})

/**
 * A command can add or remove entries without changing the cwd, which is the
 * only thing the panel otherwise reacts to — so `touch newfile` leaves the list
 * stale until the directory is re-entered. Re-list the pane the shell ran in
 * once the command finishes.
 *
 * The tricky part is noticing "finished": a fast command is over before the
 * next 300ms state poll, so it never shows up as busy and there is no idle
 * transition to wait for. After a short settle we therefore force a fresh read
 * and treat "already idle" as a completed command; a command still running
 * shows up busy here and the idle watch finishes the job when it exits.
 */
const COMMAND_SETTLE_MS = 150

let commandPending = false
let commandSettleTimer: number | null = null

function refreshPanelsAtShellCwd(): void {
  const target = shellCwd.value
  if (!target) return
  for (const pane of [left.value, right.value]) {
    if (pane.state.path === target) void pane.refresh()
  }
}

/**
 * A command typed at the prompt is a change the user asked for, so the panes
 * showing the shell's directory are marked as making it themselves: `mkdir foo`
 * would otherwise sweep `foo` exactly like a file another program wrote. They
 * stay quiet while the command runs and for a short tail after it, which also
 * covers the watcher's delayed notification for the same change. This is only
 * ever the directories the shell is actually in — a download finishing
 * elsewhere still sweeps.
 */
const shellPanes = new Set<PaneController>()

function muteShellPanes(): void {
  const dir = shellCwd.value
  if (!dir) return
  for (const pane of [left.value, right.value]) {
    if (pane.state.path !== dir || shellPanes.has(pane)) continue
    shellPanes.add(pane)
    pane.beginSelfChange()
  }
}

function unmuteShellPanes(): void {
  for (const pane of shellPanes) pane.endSelfChange()
  shellPanes.clear()
}

function noteCommandSubmitted(): void {
  commandPending = true
  muteShellPanes()
  if (commandSettleTimer !== null) window.clearTimeout(commandSettleTimer)
  commandSettleTimer = window.setTimeout(() => {
    commandSettleTimer = null
    void settleCommand()
  }, COMMAND_SETTLE_MS)
}

async function settleCommand(): Promise<void> {
  if (!commandPending) return
  await shell.refreshState()
  if (!commandPending || !shellIdle.value) return
  commandPending = false
  unmuteShellPanes()
  refreshPanelsAtShellCwd()
}

watch(shellCommand, noteCommandSubmitted)

watch(shellIdle, (idleNow) => {
  if (!idleNow || !commandPending) return
  commandPending = false
  unmuteShellPanes()
  refreshPanelsAtShellCwd()
})

// A shell that dies mid-command never reaches idle, so nothing else would
// release the muting. Resuming on exit keeps the sweep working afterwards.
watch(shellStarted, (started) => {
  if (started) return
  commandPending = false
  unmuteShellPanes()
})

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

  if (event.ctrlKey || event.altKey || event.metaKey) return

  if (event.key === 'Escape') {
    consume(event)
    if (searching) {
      pane.closeSearch()
      return
    }
    if (hasInput) {
      shell.clearInputLine()
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
      void pane.activate()
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

onMounted(() => {
  void left.value.init()
  void right.value.init()
})

onBeforeUnmount(() => {
  if (commandSettleTimer !== null) window.clearTimeout(commandSettleTimer)
  window.removeEventListener('keydown', onKeydown, { capture: true })
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-bg text-fg select-none">
    <TitleBar :terminal-open="terminalExpanded" @toggle-terminal="toggleTerminal" />

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
          :controller="left"
          :active="activeSide === 'left'"
          @select="setActive('left')"
          @pointer-down="focusPanes"
        />
        <div class="w-px shrink-0 bg-border"></div>
        <FilePanel
          :controller="right"
          :active="activeSide === 'right'"
          @select="setActive('right')"
          @pointer-down="focusPanes"
        />
      </main>

      <TerminalPane
        ref="terminalRef"
        :expanded="terminalExpanded"
        :cwd="activePanePath"
        @focused-change="terminalFocused = $event"
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

import {
  computed,
  effectScope,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref
} from 'vue'
import { useDirectory, type PaneController } from '@renderer/composables/useDirectory'
import { createShell, type Shell } from '@renderer/composables/useShell'
import type { PanelSide } from '@shared/types'

/**
 * A workspace is one tab: its own pair of file panes and its own shell. The app
 * keeps several alive at once (see App.vue); each owns the per-tab state and
 * watchers that used to be global — the active side, the terminal's expanded
 * and focused flags, and the panel <-> shell cwd sync — so switching tabs is
 * just switching which one is rendered.
 */
export interface Workspace {
  readonly id: string
  readonly label: string
  readonly left: Ref<PaneController>
  readonly right: Ref<PaneController>
  readonly shell: Shell
  readonly activeSide: Ref<PanelSide>
  readonly terminalExpanded: Ref<boolean>
  readonly terminalFocused: Ref<boolean>
  readonly activePane: ComputedRef<PaneController>
  readonly inactivePane: ComputedRef<PaneController>
  readonly activePanePath: ComputedRef<string>
  swapPanels(): void
  init(): Promise<void>
  dispose(): void
}

/**
 * Panel -> shell cwd sync has to type a real `cd` into a real prompt, so the
 * shell echoes it and the strip fills up with commands the user never issued.
 * Appending a printf that walks back over the echoed line and clears it hides
 * the sync, and `&&` means a failed `cd` still shows its error.
 */
const ERASE_ECHO = "printf '\\033[1A\\033[2K'"

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

export function createWorkspace(id: string, label: string): Workspace {
  const scope = effectScope()
  let api!: Workspace

  scope.run(() => {
    const left = shallowRef<PaneController>(useDirectory('left'))
    const right = shallowRef<PaneController>(useDirectory('right'))
    const shell = createShell(id)

    const activeSide = ref<PanelSide>('left')
    const terminalExpanded = ref(false)
    const terminalFocused = ref(false)

    const activePane = computed(() => (activeSide.value === 'left' ? left.value : right.value))
    const inactivePane = computed(() => (activeSide.value === 'left' ? right.value : left.value))
    const activePanePath = computed(() => activePane.value.state.path)

    /**
     * Ctrl+U exchanges the two panels. The swap is a rebinding, not a
     * re-listing: each controller keeps its directory, cursor, marks and filter,
     * and they simply trade columns. `activeSide` is flipped with them so the
     * active pane follows its directory to the other column rather than the
     * highlight staying put.
     */
    function swapPanels(): void {
      const previous = left.value
      left.value = right.value
      right.value = previous
      activeSide.value = activeSide.value === 'left' ? 'right' : 'left'
    }

    // A filter belongs to the pane it was typed in.
    watch(activeSide, () => inactivePane.value.closeSearch())

    /**
     * cwd sync runs both ways, which needs care: the shell's cwd is polled, so
     * a read can be stale for a moment after we push a `cd`. `pendingPush` marks
     * the path we asked for so those stale reads are ignored instead of bouncing
     * the panel back to where it came from.
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
      // Never write into a shell that is busy, or into a half-typed command
      // line: the text would be fed to whatever is running, or appended to the
      // command.
      if (!shell.started.value || !shell.idle.value) return
      if (shell.inputLine.value.length > 0) return

      const target = activePanePath.value
      if (!target || target === shell.cwd.value || target === pendingPush) return

      pendingPush = target
      if (pendingTimer !== null) window.clearTimeout(pendingTimer)
      pendingTimer = window.setTimeout(clearPendingPush, 3000)

      shell.write(`cd ${shellQuote(target)} && ${ERASE_ECHO}\r`)
    }

    watch([activePanePath, shell.idle, shell.started, shell.inputLine], pushCwdToShell)

    watch(shell.cwd, (next) => {
      if (!next) return

      if (pendingPush !== null) {
        if (next === pendingPush) clearPendingPush()
        return
      }

      if (next === activePanePath.value) return
      void activePane.value.navigateTo(next)
    })

    /**
     * A command can add or remove entries without changing the cwd, which is
     * the only thing the panel otherwise reacts to — so `touch newfile` leaves
     * the list stale until the directory is re-entered. Re-list the pane the
     * shell ran in once the command finishes.
     *
     * The tricky part is noticing "finished": a fast command is over before the
     * next 300ms state poll, so it never shows up as busy and there is no idle
     * transition to wait for. After a short settle we therefore force a fresh
     * read and treat "already idle" as a completed command; a command still
     * running shows up busy here and the idle watch finishes the job when it
     * exits.
     */
    const COMMAND_SETTLE_MS = 150

    let commandPending = false
    let commandSettleTimer: number | null = null

    function refreshPanelsAtShellCwd(): void {
      const target = shell.cwd.value
      if (!target) return
      for (const pane of [left.value, right.value]) {
        if (pane.state.path === target) void pane.refresh()
      }
    }

    /**
     * A command typed at the prompt is a change the user asked for, so the
     * panes showing the shell's directory are marked as making it themselves:
     * `mkdir foo` would otherwise sweep `foo` exactly like a file another
     * program wrote. They stay quiet while the command runs and for a short
     * tail after it, which also covers the watcher's delayed notification for
     * the same change. This is only ever the directories the shell is actually
     * in — a download finishing elsewhere still sweeps.
     */
    const shellPanes = new Set<PaneController>()

    function muteShellPanes(): void {
      const dir = shell.cwd.value
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
      if (!commandPending || !shell.idle.value) return
      commandPending = false
      unmuteShellPanes()
      refreshPanelsAtShellCwd()
    }

    watch(shell.commandSeq, noteCommandSubmitted)

    watch(shell.idle, (idleNow) => {
      if (!idleNow || !commandPending) return
      commandPending = false
      unmuteShellPanes()
      refreshPanelsAtShellCwd()
    })

    // A shell that dies mid-command never reaches idle, so nothing else would
    // release the muting. Resuming on exit keeps the sweep working afterwards.
    watch(shell.started, (started) => {
      if (started) return
      commandPending = false
      unmuteShellPanes()
    })

    async function init(): Promise<void> {
      await Promise.all([left.value.init(), right.value.init()])
    }

    api = {
      id,
      label,
      left,
      right,
      shell,
      activeSide,
      terminalExpanded,
      terminalFocused,
      activePane,
      inactivePane,
      activePanePath,
      swapPanels,
      init,
      dispose: () => scope.stop()
    }

    onScopeDispose(() => {
      if (pendingTimer !== null) window.clearTimeout(pendingTimer)
      if (commandSettleTimer !== null) window.clearTimeout(commandSettleTimer)
      shell.dispose()
    })
  })

  return api
}

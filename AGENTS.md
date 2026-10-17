# Bipane

A modern orthodox (dual-pane) file manager with a VSCode-inspired UI.
Electron + electron-vite + Vue 3 + TypeScript + Tailwind v4.
Integrated terminal via xterm.js + node-pty. Linux is the primary target.

## Commands

```bash
npm run dev          # dev server + Electron with HMR
npm run dev:sandboxed # same, but keeps the renderer sandbox (needs setuid chrome-sandbox)
npm run build        # typecheck, then build main/preload/renderer into out/
npm start            # preview the production build
npm run typecheck    # tsc (main/preload) + vue-tsc (renderer)
npm run dist:linux   # electron-builder AppImage + deb  (not yet verified end-to-end)
```

There is no linter or test runner configured yet.

## Architecture

```
src/main/index.ts        window lifecycle, single-instance lock
src/main/ipc/fs.ts       IPC: fs:home, fs:list, fs:read, fs:write, fs:open,
                         fs:reveal
                         (fs:read/fs:write serve the viewer: regular text files
                         only, binary and oversized reads refused/truncated)
src/main/ipc/watch.ts    IPC: fs:watch, fs:unwatch; pushes fs:changed when a
                         watched directory's contents change (fs.watch = inotify)
src/main/ipc/pty.ts      IPC: pty:create/write/resize/kill/state, pushes pty:data, pty:exit
src/main/ipc/window.ts   IPC: window:minimize/toggle-maximize/close/is-maximized
src/preload/index.ts     contextBridge -> window.bipane (implements BipaneApi)
src/shared/types.ts      DirEntry/DirListing/Result/Pty* types (main + renderer)
src/shared/api.ts        BipaneApi interface (the preload contract)
src/renderer/src/App.vue global keyboard model, workspace stack, layout, focus
src/renderer/src/components/TitleBar.vue     frameless title bar + window controls;
                                             hosts the workspace tab strip
src/renderer/src/components/WorkspaceTabs.vue the tab strip, rendered inside the
                                             title bar (select/close/new)
src/renderer/src/components/FilePanel.vue    one pane: path bar, list, footer
src/renderer/src/components/TerminalPane.vue xterm over the active workspace's
                                             shell: the collapsed command line
                                             and, when expanded, the full terminal
src/renderer/src/components/FileViewer.vue   Monaco overlay: read-only (F3) or
                                             editable with Ctrl+S (F4)
src/renderer/src/composables/useWorkspace.ts one tab: its two panes, its shell,
                                             and the per-workspace cwd sync
src/renderer/src/composables/useShell.ts     createShell(id): one shell session
                                             (own process, buffer, cwd, line model)
src/renderer/src/composables/useDirectory.ts per-pane navigation state + actions
src/renderer/src/lib/format.ts               size/date/permission formatting
src/renderer/src/lib/monaco.ts               lazy monaco import + worker wiring
src/renderer/src/lib/fileIcon.ts             per-entry icon: name/extension -> 24x24 svg
                                             (FILENAME_ICONS, EXTENSION_ICONS, fallback text)
```

Keys: `Tab` switches panes, arrows/`Home`/`End`/`PgUp`/`PgDn` move the cursor,
`Enter` descends or opens with the system default app, `F3` opens a regular file
read-only in the Monaco viewer, `F4` opens it for editing with Ctrl+S to save (a
directory still descends on `F3`), `Insert` marks the current entry and moves down,
right-click marks a row and dragging the held button paints that mark across
rows, `Ctrl+O` toggles the terminal, `Ctrl+R` re-lists the active pane,
`Ctrl+T` opens a new terminal — a fresh workspace (two panes at home plus a new
shell) at the top of the tab strip, focused — `Ctrl+W` closes the active one
(the last workspace is never closed), `Ctrl+PageDown`/`Ctrl+PageUp` step to the
next/previous workspace, `Ctrl+U` swaps the two panels (each keeps its cursor,
marks and filter),
`Alt+S` starts an incremental search, `F5` copies the marked entries (or the
cursor row) into the other pane, `F6` moves them there (its destination field
names a directory to move into, but for a single entry a path that is not a
directory is the entry's new name — so `blah` -> `blah2` renames, and a
trailing separator, `blah2/`, asks for a folder instead), `Shift+F6` renames the
cursor row in place, and `F8` deletes them after confirmation.
`Backspace` never navigates: it belongs to the shell's line
editor (or the search box), so the `..` row is the way up.

The app is a stack of workspaces — one tab each, shown in the title bar. A
workspace owns its own pair of file panes and its own shell, so switching tabs
switches sessions; only the active workspace is rendered, and a tab that comes
back replays its session buffer (see `useWorkspace.ts`).

The bottom strip is the active workspace's shell itself: the same xterm,
collapsed to two rows, so the prompt, font and echo are the shell's own rather
than a look-alike widget. `Ctrl+O` expands it into the full terminal, which then
owns the keyboard outright. While it is collapsed, printable characters go to
the shell and navigation keys still drive the panels; `Enter` runs the typed
line, or activates the panel entry when the line is empty. `Backspace` is left
alone so it edits the line, and reaching the parent is the `..` row's job.

## Gotchas

- **TypeScript must stay on 5.x.** `vue-tsc` cannot run against TypeScript 7
  (the native compiler no longer exposes `./lib/tsc`). Do not upgrade without
  replacing the renderer typechecker.
- **Preload builds to `out/preload/index.mjs`** (ESM), which requires
  `sandbox: false` in `webPreferences`. `src/main/index.ts` probes for `.mjs`
  then `.js` so a CJS build still works.
- **`--noSandbox` in the dev script** is a dev-only workaround: the bundled
  `chrome-sandbox` is not setuid on this machine. Use `npm run dev:sandboxed`
  once the helper is configured correctly.
- **node-pty needs no `electron-rebuild`** — it is N-API based, so the prebuilt
  binary loads in Electron unchanged. `postinstall` runs `install-app-deps`
  regardless, and `asarUnpack` keeps the native module extractable.
- **`ELECTRON_RUN_AS_NODE` is set in this shell environment.** Unset it when
  launching Electron directly, otherwise it runs as plain Node and reports the
  bundled Node version instead of the Electron version:
  `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .`
- **The window is frameless** (`frame: false`), so the OS decoration is replaced
  by `TitleBar.vue` (a single 32px row that holds the terminal toggle, the
  workspace tabs and the window controls).
  Moving the window depends on `-webkit-app-region`: the header is
  `drag-region` and interactive children must be `no-drag`, otherwise a new
  control silently swallows clicks. Both are `@utility` rules in `main.css`.
  Window controls go through `window.bipane.win`; main broadcasts
  `window:maximized-change` so the maximize/restore icon stays in sync.
- **Incremental search holds DOM focus in its input**, so `handlePaneKey` in
  `App.vue` intentionally lets editing keys through (printable characters,
  Backspace/Delete) and intercepts only navigation keys. Anything added to that
  switch also changes search-mode behaviour — decide deliberately whether the
  search box or the pane should consume it.
- **The pane's row list must contain only entries.** A status message rendered
  as a sibling `<li>` shifts every index, which silently breaks cursor scrolling
  and page jumps; `FilePanel` renders that notice as a sibling of the `<ul>`.
- **The panel and the shell keep their cwd in sync in both directions**, which
  is why it needs a guard: the shell's cwd is *polled* (300ms), so a read can be
  stale for a moment after we inject a `cd`. `pendingPush` in `useWorkspace.ts`
  marks the path we asked for so those stale reads are ignored rather than
  bouncing the panel back. The injection is also gated on `pty:state` reporting
  the shell is
  at a prompt — writing mid-command feeds the text to whatever is running.
- **`pty:state` is Linux-only** (`/proc/<pid>/cwd` for the cwd, `tpgid` in
  `/proc/<pid>/stat` to tell whether the shell is at a prompt). Elsewhere it
  reports `idle: false`, which disables injection rather than guessing.
- **A pane's directory is watched, not polled.** `useDirectory` subscribes to
  `fs:changed` for its current `state.path` and re-lists on a match, so files
  made by another program appear on their own. Main refcounts watchers per
  webContents id, *not* per directory: both panes can show one directory, and a
  plain Set would close the shared watcher when the first of them navigated
  away. Notifications are debounced (200ms trailing edge, but never later than
  750ms after a burst's first event) because one action (a recursive copy, an
  editor's write/rename) emits a burst of inotify events — and a pure trailing
  debounce never fires while events keep arriving, which is exactly a download
  streaming a `.crdownload` file, so the pane stayed frozen until it finished.
- **A refresh highlights what changed.** `useDirectory` diffs each re-list and
  marks entries that are new or whose size/mtime/kind changed into `fresh`;
  `FilePanel` puts `flash-row` on those rows, which runs the looping
  `flash-sweep` animation in `styles/flash.css`. The clear timer is re-armed by
  every refresh, so a one-off change sweeps exactly once while a file still
  being written (a download) keeps sweeping until a full cycle passes with no
  change. The gradient holds two peaks and never reaches zero alpha and scrolls
  one period per cycle — a single band with a blank tail leaves a dead beat
  between passes, which reads as the animation stalling. A batch over 150
  entries is skipped so a big copy or checkout cannot animate hundreds of rows.
- **Only changes made behind the app's back sweep.** A copy, move or `mkdir`
  the user asked for must not animate its own result, and the watcher reports
  those changes exactly like an external writer would, so the app marks the
  panes involved as making the change themselves: `beginSelfChange` /
  `endSelfChange` in `useDirectory` silence `markFresh` while the operation runs
  and for a 1000ms tail afterwards (enough to cover the watcher's debounce), so
  neither the operation's own re-list nor the watcher's delayed notification
  flashes. `App.vue` wraps the F5/F6 transfer on both panes (the target always
  gains entries, the source too when the destination is a relative path), and
  mutes the panes at the shell's directory from a submitted command until it
  finishes and settles. A download in another directory, or one that starts
  after the tail, still sweeps; so does `Ctrl+R`.
- **Intercepted keys must `stopPropagation`, not just `preventDefault`.** xterm
  handles keys from a capture listener on its own textarea and does *not* consult
  `defaultPrevented`, so a merely-prevented navigation key is still forwarded to
  the shell — Up recalls history and Home moves the line cursor, silently
  corrupting a half-typed command. `consume()` in `App.vue` does both, and that
  listener is registered in setup so it runs ahead of xterm's.
- **The collapsed strip is the shell, so its input line is state we model.**
  `shell.inputLine` (one per workspace) is fed from xterm's `onData`. It decides
  whether `Enter` runs the line or activates the panel entry, and it stops the
  cwd sync from injecting a `cd` into a half-typed command.
- **Panel -> shell cwd sync types a real `cd` into a real prompt**, so the shell
  echoes it and the strip fills with commands the user never issued. The
  injected line carries a trailing `printf '\033[1A\033[2K'` that walks back
  over the echo and clears it, so only the new prompt shows. `&&` keeps a failed
  `cd` visible as an error. Gating on an empty input line is what stops the
  injection from being appended to a half-typed command. This erase only works
  while the terminal has a row to spare: a **one-row** terminal scrolls on every
  newline, so the echoed `cd` leaves the viewport for the scrollback before the
  `printf` runs, and `Ctrl+O` then shows a transcript of them. `refit()` in
  `TerminalPane` therefore clamps the terminal to at least two rows and the
  collapsed strip is sized (`basis-11`) to show both.
- **The shell outlives its view; the terminal view does not own it.**
  `TerminalPane` must not kill it on unmount — main reaps sessions when the
  window goes away, and a workspace kills its own session only through
  `shell.dispose()` when its tab is closed. Killing it on unmount let any
  remount (a Vue HMR update, a workspace switch, a reload) race a fresh spawn
  and take the *new* shell down with it. For the same reason `attachTerminal`
  does not drain the output buffer: a view that attaches later replays the
  session so far. A workspace object (`createWorkspace`) survives tab switches,
  so its shell's `startPromise`, buffer and cwd are preserved and remounting
  the view re-attaches rather than respawns.
- **The viewer is a modal overlay over the panes and terminal.** `App.vue`
  renders `FileViewer` absolutely inside a `relative` wrapper that holds `main`
  and `TerminalPane`, so the title and status bars stay visible. While a file is
  open the window capture handler consumes only `Escape` and returns for
  everything else, so Monaco — not the panes or the shell — owns the keyboard.
  Escape closing is *delegated* to the viewer (`confirmClose()` via a template
  ref), because only it knows whether an edit (F4) is dirty; a dirty buffer
  prompts before anything is discarded. `Escape` is claimed at the window level
  rather than as a Monaco command so the error path (a binary or unreadable
  file) has no editor yet still closes. Ctrl+S is a Monaco command, which the
  capture handler deliberately lets through untouched. A *save* failure sets
  `saveError` (a header strip) rather than `error`, because `error` swaps the
  editor's container out of the DOM — using it would unmount the very buffer the
  user is still editing. A file the read had to truncate is refused for editing
  outright: saving it back would write only the first 8 MiB and silently destroy
  the tail.
- **Monaco is imported only when the viewer first opens**, and its workers are
  answered by `MonacoEnvironment.getWorker` with Vite `?worker` imports in
  `lib/monaco.ts`. Monaco 0.57 otherwise builds its workers from
  `new URL('...worker.js', import.meta.url)` paths inside `node_modules`, which
  do not survive the build; installing `getWorker` before the first
  `editor.create` is what makes the base and language workers load (verified
  under both dev `http://` and the `file://` production build). F3 stays closed
  to anything that is not a regular file — opening a FIFO would block — and
  main's `fs:read` re-checks that with `O_RDONLY | O_NONBLOCK` plus a NUL-byte
  binary test and an 8 MiB ceiling, so the renderer only ever receives text an
  editor can show (or a `truncated` flag), and `fs:write` (the save) refuses a
  target that exists but is not a regular file or symlink.
- **Focus model:** the command line holds focus whenever the terminal does not,
  so `focusPanes()` *focuses the command line* rather than blurring. The search
  box and the terminal are the other two focus targets. Navigation keys are
  intercepted in the window capture handler; editing keys are left to whichever
  input owns them.
- **Tailwind v4 is configured CSS-first** (`@theme` in
  `src/renderer/src/styles/main.css`). There is no `tailwind.config.js`.
  Theme tokens are the design system — prefer `bg-surface`, `text-fg-dim`,
  `border-border` over raw hex values. The terminal resolves its font from the
  `--font-mono` token at runtime, so the mono font is defined in one place.
- The renderer has a CSP in `src/renderer/index.html`. Dev-only allowances
  (`ws://localhost:*`, `'unsafe-inline'` styles) are required for Vite HMR.

## Verifying changes in dev

Nothing here is exotic, but each item below produced a confidently wrong
conclusion at least once, so treat them as required steps.

- **Restarting `npm run dev` leaves instances behind.** Stopping the npm/npx
  wrapper can leave `electron-vite` and Electron running, which keeps port 5173
  held; the next start then silently falls back to **5174** and you now have two
  windows titled `Bipane`. Window tools address them by title, so `xdotool` and
  `import` can type into one window and screenshot another. Check by **port**,
  not process count — a single `npx electron-vite` chain already matches ~4
  processes:
  ```bash
  ss -ltn | grep -E '5173|5174'      # expect exactly one listener
  ```
  Clean up scoped by project path, and use a bracketed pattern so `pkill`
  does not match its own command line (it will otherwise kill your shell):
  ```bash
  for pid in $(pgrep -f "electron-[v]ite dev"; pgrep -f "bipane/node_modules/[e]lectron"); do
    case "$(readlink /proc/$pid/cwd 2>/dev/null)" in *bipane*) kill "$pid";; esac
  done
  ```
- **The display is 2x scaled.** `xdotool getwindowgeometry` and `import` report
  *physical* pixels — a 1280x820 window measures 2624x1724. Divide by 2 for CSS
  pixels, and never judge a layout from a scaled-down preview: crop the real
  screenshot and compare pixel positions.
- **Drive the UI over CDP**, not by guessing coordinates: start dev with
  `--remoteDebuggingPort 9222` and use `Runtime.evaluate` against the page
  target. Two traps:
  - `Input.insertText` does nothing for xterm — it only drives real inputs. Type
    into the terminal with `Input.dispatchKeyEvent` per character, setting
    `text`.
  - `xdotool` clicks land on whatever window is stacked under the pointer, so
    raise and activate first. `Input.dispatchMouseEvent` respects hit-testing
    (drag regions included) and is the reliable option.
- **`window.bipane.pty.state('ws-1')` is the fastest health check.** A live
  shell reports a `cwd`; `cwd: null` means the session has exited, so any typing
  afterwards proves nothing. Workspace sessions are `ws-1`, `ws-2`, ... in
  creation order.
- **A dev-mode HMR update of `App.vue` or `TerminalPane.vue`, and switching
  workspaces, remount the terminal view.** That is harmless (the shell survives
  and the buffer replays), but it does mean a running shell can look "reset"
  mid-test.

## Conventions

- Keep filesystem and pty access in the main process; the renderer only talks
  to `window.bipane`. Never enable `nodeIntegration`.
- IPC handlers return `Result<T>` instead of throwing across the bridge.
- The security model is contextIsolation on, nodeIntegration off, and the
  preload exposes a narrow, explicitly typed surface.

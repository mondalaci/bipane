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
src/main/ipc/fs.ts       IPC: fs:home, fs:list, fs:read, fs:write, fs:read-image,
                         fs:image-size, fs:open, fs:reveal
                         (fs:read/fs:write serve the viewer: regular text files
                         only, binary and oversized reads refused/truncated)
                         (fs:read-image serves a pane footer's preview: a
                         decodable image as a data: URL, downscaled in main
                         when the file is too large to hand over whole)
                         (fs:image-size reads just the header, so a footer can
                         reserve the picture's shape before reading it)
src/main/imageSize.ts    header-only image dimensions (PNG/JPEG+EXIF/GIF/BMP/
                         ICO/WebP/SVG); no decode, so it answers in well under
                         a millisecond even for a file the preview has to
                         downscale
src/main/media.ts        the bipane-media scheme a pane plays a video through: a
                         ranged byte stream, so the element fetches the metadata
                         and the frames it needs rather than a hundred-megabyte
                         file; and, for what Chromium cannot play at all, a live
                         encode of the clip from a wanted position, which is also
                         what a seek on one is (fs:can-transcode says whether
                         that is possible here)
src/main/ipc/watch.ts    IPC: fs:watch, fs:unwatch; pushes fs:changed when a
                         watched directory's contents change (fs.watch = inotify)
src/main/ipc/pty.ts      IPC: pty:create/write/resize/kill/state, pushes pty:data, pty:exit
src/main/ipc/window.ts   IPC: window:minimize/toggle-maximize/close/is-maximized
src/preload/index.ts     contextBridge -> window.bipane (implements BipaneApi)
src/shared/types.ts      DirEntry/DirListing/Result/ImagePreview/PixelSize/
                         Pty* types (main + renderer)
src/shared/api.ts        BipaneApi interface (the preload contract)
src/shared/image.ts      extension -> previewable image MIME map, shared so the
                         renderer and main agree on what a footer may preview
src/shared/video.ts      the same for video, plus the extensions only ffmpeg
                         can make playable, and the media scheme's name
src/renderer/src/App.vue global keyboard model, workspace stack, layout, focus
src/renderer/src/components/TitleBar.vue     frameless title bar + window controls;
                                             hosts the workspace tab strip
src/renderer/src/components/WorkspaceTabs.vue the tab strip, rendered inside the
                                             title bar (select/close/new)
src/renderer/src/components/FilePanel.vue    one pane: path bar, list, footer
                                             (the footer previews the cursor's
                                             image, and plays its video; the whole
                                             pane becomes a display when the other
                                             pane asks it to)
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
src/renderer/src/lib/preview.ts              what a row is previewable as (image or
                                             video), keyed by content, where a
                                             playing clip has got to (PlaybackClock),
                                             and what one pane asks another to
                                             display
src/renderer/src/lib/monaco.ts               lazy monaco import + worker wiring
src/renderer/src/lib/fileIcon.ts             per-entry icon: name/extension -> 24x24 svg
                                             (FILENAME_ICONS, EXTENSION_ICONS, fallback text)
src/renderer/src/lib/swapAnimation.ts        how a Ctrl+U exchange is shown: copies of
                                             both panes travelling to the other column,
                                             carrying the blur a display puts on the
                                             pane's own content, and the layer they
                                             travel in (styles/swap.css)
```

Keys: `Tab` switches panes, arrows/`Home`/`End`/`PgUp`/`PgDn` move the cursor
(`←`/`→` step the clip being previewed by ten seconds, and `Ctrl+J`/`Ctrl+L` by
a minute back/forward while `Ctrl+H`/`Ctrl+;` step it by ten minutes — all only
while the command line is empty; with anything typed there — or in an open search
box — the arrows are the line's own keys again and the Ctrl steps belong to the
shell, whose `Ctrl+H` is backspace, `Ctrl+L` clear-screen and `Ctrl+J`
accept-line; `Space` pauses or resumes the clip being watched there — the
display's, or the footer preview if none is up — and stays the shell's own space
when there is no clip to toggle), `Enter` descends or opens with the system default app — except on an image or a
video, which it displays in the other pane instead (see below) — and a
double-click on a row is the same thing with the mouse (`activate` →
`activateRow`), `Ctrl+Enter` opens that same media as a full-screen display over
the whole window (a triple-click on the file's name is the mouse's half of the
gesture; pressed again it gives the window back, and `Escape` leaves the mode),
`F3` opens a regular file
read-only in the Monaco viewer, `F4` opens it for editing with Ctrl+S to save (a
directory still descends on `F3`), `Insert` marks the current entry and moves down,
right-click marks a row and dragging the held button paints that mark across
rows, `Ctrl+O` toggles the terminal, `Ctrl+R` re-lists the active pane,
`Ctrl+T` opens a new terminal — a fresh workspace (two panes at home plus a new
shell) at the right of the tab strip, focused — `Ctrl+W` closes the active one
(the last workspace is never closed), `Ctrl+PageDown`/`Ctrl+PageUp` step to the
next/previous workspace, `Shift+Ctrl+PageDown`/`Shift+Ctrl+PageUp` (or dragging a
tab) move the active workspace right/left in the strip, `Ctrl+U` swaps the two
panels (each keeps its cursor,
marks and filter) — the panes change columns in one frame, since the two are
reordered in the row rather than rebuilt, so the exchange is shown as copies of
both of them travelling to the other column, and nothing in a pane stops for it:
a display among them goes on playing as it changes column, and the columns keep
the sizes they had, so the divider does not move,
`Alt+S` starts an incremental search, `Alt+Enter` pastes the cursor entry's
name onto the command line and `Alt+A` its full path (both shell-quoted when
they contain anything the shell would act on, so a space or a `$` arrives as
part of the one argument, and both typed into the shell's own line so its echo
and history see a real command line), `F5` copies the marked entries (or the
cursor row) into the other pane, `F6` moves them there (both take a destination
field naming a directory to act into, but for a single entry a path that is not
a directory is the entry's new name — so `blah` -> `blah2` renames or copies to
`blah2`, rather than making a `blah2` folder and putting `blah` inside it, and a
trailing separator, `blah2/`, asks for a folder instead), `Shift+F6` renames the
cursor row in place, and `F8` deletes them after confirmation.
`Backspace` never navigates: it belongs to the shell's line
editor (or the search box), so the `..` row is the way up.

The app is a stack of workspaces — one tab each, shown in the title bar. A
workspace owns its own pair of file panes and its own shell, so switching tabs
switches sessions; only the active workspace is rendered, and a tab that comes
back replays its session buffer (see `useWorkspace.ts`).

The bottom strip is the active workspace's shell itself: the same xterm,
collapsed to a single visible line, so the prompt, font and echo are the shell's
own rather than a look-alike widget. `Ctrl+O` expands it into the full terminal,
which then owns the keyboard outright. While it is collapsed, printable
characters go to the shell and navigation keys still drive the panels; `Enter`
runs the typed line, or activates the panel entry when the line is empty. `Backspace` is left
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
  by `TitleBar.vue` (a single 32px row that holds the logo, the workspace tabs
  and the window controls; clicking the active tab toggles its terminal).
  Moving the window depends on `-webkit-app-region`: the header is
  `drag-region` and interactive children must be `no-drag`, otherwise a new
  control silently swallows clicks. Both are `@utility` rules in `main.css`.
  Window controls go through `window.bipane.win`; main broadcasts
  `window:maximized-change` so the maximize/restore icon stays in sync.
  Double-clicking the bar toggles maximize, and it must key off `button`
  targets, not `no-drag` ones: the tab strip is a `no-drag` `flex-1` child, so
  a `.no-drag` test would swallow every double-click on the bar's empty middle
  (only the small logo/drag area would respond).
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
- **A pane footer previews the image under its cursor.** The footer grows to
  fit a thumbnail read through `fs:read-image`, which is the only way to show a
  file the renderer has no URL for: the extension->MIME map lives in
  `src/shared/image.ts` so both sides agree on what is previewable, main returns
  a `data:` URL (the renderer CSP allows `img-src data:` but not `file:`), and
  `FilePanel` reserves the space from the moment the cursor lands on media — the
  extension says it is, before anything has been read — so stepping between clips
  never collapses the footer and pushes the list back up. The strip itself moves
  between its two sizes — the 24px status bar and the 72px one carrying a
  preview box — and only its *growth* is animated, because only that can be:
  a strip shrinking sweeps down over the very rows it is uncovering, so a cursor
  landing there would sit behind it for the length of the animation, and keeping
  the row clear of it instead would leave the listing scrolled up past where the
  cursor's own move put it — a scroll nothing would ever take back. So the strip
  snaps smaller, and the move that measures the listing's room
  (`scrollRowIntoView`) is the one the instant resize decided. Growing sweeps the
  same way, but the room it takes is room the cursor row needs anyway, so there
  the reveal is the answer: the listing's own change of size is what keeps the
  row clear of the strip as it arrives (`onListResize`), which is what makes a
  move onto media near the bottom land with the row visible however much the
  strip takes — and it is deliberately one-way, since a listing that has just
  *gained* room must not be scrolled up for room it is regaining. What the strip
  may not do either way is move the rows: its height is the listing's height, so
  as it gives its room back the view's bottom edge moves, and the browser keeps
  the view where it is rather than show blank below the content, which would drag
  the rows down with it. The listing therefore carries a band at its end
  (`listSlack`), measured by the move that is about to change the strip from the
  room the listing has or is about to have — whichever is more, since a strip on
  its way out has not given anything back yet — and only ever as wide as the
  scroll past the listing's end is, so a listing that is not sitting at its end
  has none and the band is never more than the strip's own growth (`FOOTER_GROWTH`).
  Inside that space the box is held at the shape of the row just left until the
  new one is known, so it
  neither blinks between rows nor is ever drawn at a shape it is about to leave;
  only the first media row of a run, whose shape has never been known, shows a
  bare spinner in the reserved space instead. The box is then drawn at the
  picture's own shape: `fs:image-size` reads
  only the header (`src/main/imageSize.ts`, no decode), so the box is the right
  ratio with a spinner in it before the image arrives, and nothing jumps when it
  does. That probe is issued on the cursor move itself, while the read waits out
  the settle delay, and the box is held back until it answers: deferring the
  probe with the read left the ratio-less default frame on screen for the whole
  settle delay, flashing a wide box on the way to every preview, and a header
  read is cheap enough to run for each row a key repeat passes over. The probe
  is also the reason a rotated photo is framed correctly: it folds in the JPEG's
  EXIF orientation, which is what the browser will apply when it paints. A
  format the header cannot be measured from (AVIF) leaves the box at its cap and
  the image's own ratio is adopted once it renders. The read itself waits for
  the cursor to settle (`PREVIEW_SETTLE_MS`, re-armed by every cursor change):
  reading each row a held arrow key passes over stalls the renderer on a large
  data URL — and main on a large decode — and the input being handled is what
  pays for it, which is exactly the choppy cursor movement that produces. The read is keyed by path *and* size/mtime and
  token-guarded, so an external rewrite reloads while a slow read for a row the
  user has left cannot land on the newer one, and main keeps the last few
  previews (bounded by bytes and by count) so scrolling back over a folder does
  not pay for the same image twice. A mapped extension that still fails to decode
  (a truncated PNG) clears the preview through the `<img>` error handler and
  releases the space — the bar shows nothing rather than a broken frame. Size is
  handled in main rather than refused: a file up to 16 MiB travels as its own
  bytes — so an animated GIF stays animated, an SVG stays vector and a JPEG
  keeps its EXIF orientation — and anything larger is decoded with `nativeImage`
  and downscaled to 512px, so the payload stays small however large the source
  is. That decode is synchronous and blocks main for the length of one image,
  which is exactly why the small-file path skips it. Only a file that is both
  past 64 MiB and undecodable by the platform is refused, and its reserved space
  is given back.
- **A pane footer plays the video under its cursor, silently.** A video cannot
  be read whole the way an image can — one frame's worth is a hundred megabytes
  here — so main serves it as a ranged byte stream on its own `bipane-media`
  scheme (`src/main/media.ts`) and the footer mounts a `<video>` on it. The
  element is muted — it is the *display*, not the thumbnail, that makes a sound
  when a clip is enlarged — and it plays once rather than looping: a looping 4K clip decodes for as long as the cursor happens to rest
  on the row, measured at over half a core. Its box shows a spinner for as long
  as the box is up without a frame in it — which for a clip main has to encode
  before any of it can play is the whole of that wait. Beside the thumbnail the
  footer shows where the clip is: its position, a bar for how far through it that
  is, and its length: what the element reports for a clip Chromium plays itself,
  and `fs:video-duration` for one main has to encode — that clip is a live
  stream, which reports only what is left of the clip rather than the clip, so
  ffprobe is asked for the file's own. The bar is absent while there is neither a length to
  show nor a position yet. The scheme is declared before the
  app is ready, `media-src` carries it in the CSP, and only previewable
  extensions are served, so it cannot become a reader for anything the bar would
  not have offered anyway. A `.mov` is served as `video/mp4`: Chromium plays the
  H.264 or HEVC inside an ISOBMFF container but will not accept the QuickTime
  type, and `videoMimeFor` is the only place that mapping lives. Its shape comes
  from the element's own metadata — there is no header parser for video, as there
  is for images — so the element is mounted, and therefore starts fetching, only
  once the cursor settles: like the image read, a burst over a folder of clips
  must not start a fetch per row. Finally the window disables the hardware video
  decoder (in `src/main/index.ts`): its frames reach the compositor as DMA-BUFs
  that a Linux session without a working GBM path cannot import, which takes the
  GPU process down with the decode and disturbs the window's rendering over a
  preview nobody asked to watch.
- **A display is a mode of the panes, not a third overlay.** `Enter` on an image
  or a video hands it to the *other* pane to show at full size (`Enter` again
  takes it away, and `Escape` leaves the mode): the cursor stays where it was,
  the pane that asked keeps the keyboard, and the display follows that cursor
  from row to row — so the two panes are a browser and a screen rather than two
  browsers. The listing the pane was showing stays in place and is blurred
  behind the display — a `filter` on that content (`paneContent`), animated in
  over the reveal and back out as it is dismissed, so the pane needs no
  background of its own and the media sits on the folder it came from. That
  content is also clipped to its own box (`clip-path: inset(0)`): a filter's
  output is not held inside the element it is applied to, so the blur would
  otherwise spill over the border into the pane next door. That blur
  belongs to the *mode*, not to whatever is being shown: on a row there is
  nothing to display for, the display empties but the pane stays blurred and
  covered — saying so, and how to leave (`Preview mode` / `Esc or right-click to
  exit`, the two ways out) — and
  coming back to a media file fills it again. The display itself carries no
  chrome, not even the file's name, so the media is all there is to look at —
  except a video's play bar directly beneath it, exactly as wide as the picture,
  with a play/pause button, its position and its length. The whole row is the
  seek target, so it is grabbable with the mouse: clicking or dragging scrubs
  the clip (a clip main must encode is re-asked from the dropped position,
  rather than re-encoding per pixel). A left click on the picture itself pauses
  or resumes it, as does `Space` while the command line is empty, while a double
  left-click on the enlarged media — a clip or a still, the same gesture on either
  — trades the pane and the whole window: the mouse's half of the `Ctrl+Enter`
  full-screen toggle, where a clip's own pair of play/pause clicks cancel out.
  What the
  screen shows is *derived* from the browser's cursor
  (`stageTarget` in `App.vue`), not pushed to it, which is what makes navigating
  update it for free; leaving media for an ordinary row empties the screen
  instead of freezing the last picture. `Tab` is claimed while a display is up —
  it would move the keyboard, and with it which cursor is being displayed, to the
  other pane — while `Ctrl+U` swaps the panes and takes the display with them: a
  display belongs to a *pane*, not to a column, so the exchange is not a reason to
  leave the mode — the pane that was showing shows on from the other column, and
  the pane that asked stays the active one, now in the other column itself.
  Nothing of the display is taken down for it: the panes are reordered rather than
  rebuilt (see `swapPanels` in `useWorkspace.ts`), so what is on screen is the same
  element, still wherever the clip had got to, and a clip main has to encode goes
  on streaming instead of being asked for again at that offset. Switching tabs or
  closing one leaves the mode too, since the panes it belonged to are gone. The
  mouse makes the same two gestures: a left-click on the footer
  thumbnail asks for the display when one is not already up (`stage-on` →
  `showStage`) — as does a double-click on the row of an image or a video, which
  is `Enter` on it without its toggling back off (`activate` → `activateRow`) —
  and a quick right-click on the pane showing it leaves the mode
  (`stage-off` → `exitStage`) — the mouse's `Enter` and `Escape`; a held right
  press, or one that wheel-scrubs the clip, is not that click. A display's
  media fills the pane however small the file is
  (`h-full w-full object-contain`), upscaled as far as its own aspect allows, so
  a 320x240 camcorder clip is not a postage stamp in the middle of it. The reveal
  is one animation of one element: the media is laid out where it will sit, then
  transformed back onto the footer thumbnail it grew out of (`translate` and
  `scale` together), and released. It is the media's *own* rectangle that is
  moved, not the element's — the element is the whole pane with the media
  letterboxed inside it, so `drawnRect` works out where the picture actually is
  from the element's box and the media's intrinsic size, and `handoffTransform`
  lays that onto the thumbnail (`previewRect()` on the source pane). It plays once per *entry* into the mode,
  guarded by `stage.animation`, so arrowing through a folder swaps the display in
  place rather than re-animating on every row — and a row whose thumbnail is not
  up yet has nothing to grow from, so it simply appears. The gesture is for
  entering the mode and leaving it, not for the cursor crossing a row: a display
  that has nothing to show for a row empties at once (no shrink onto a thumbnail
  that never held it), and coming back onto a media file fills it again without
  the reveal — nothing grew out of that thumbnail either. Leaving the mode plays
  the same gesture backwards and waits for it: the media shrinks back onto the
  thumbnail it came from and is only taken off screen when it has arrived, so
  `FilePanel` holds the request it is showing (`shownStage`) past the prop that
  asked for it, and a display asked for again mid-dismissal calls the shrink off
  instead of flickering. A display is watched rather than glanced at, so an
  enlarged clip is the one thing that makes a sound: its element stays muted
  until the reveal, then its volume is ramped up over the reveal's own length,
  and ramped back down — ending muted — as it shrinks away. The footer's own
  thumbnail stays silent throughout. The ramp follows frame callbacks for
  smoothness but is bounded in time as well, because those stop while the window
  is hidden and a dismissal waits on it. The display *takes the clip over*: the
  pane that asked gives up its own copy rather than playing it twice — no
  `<video>` is mounted in its footer, so a 4K clip is not decoded to draw the
  same thing twice — while the space the thumbnail had is kept, so nothing about
  the strip moves and the shrink still has somewhere to land. Its play bar is
  drawn from the display instead: the displaying pane publishes the clock it is
  playing (`stage-clock`, a `PlaybackClock`) and the pane that asked reads it,
  asking the file itself for a length when the display can only say where it is
  (a clip still being encoded). The position travels with the clip in *both*
  directions, so enlarging one is the same clip changing place rather than
  starting over: the ask carries where the footer's own preview had got to
  (`resumeAt`, taken before the display exists, because the display is what takes
  that element away), and dismissing hands it back the same way. Each element is
  created fresh for the hand, so the position is applied as soon as the new one
  knows enough to be moved — and it is held with the clip it belongs to, so it
  can never be carried onto a different one. A preview that has played itself out
  hands nothing over: the display is where a clip is *watched*, so it starts that
  one again rather than sitting on the last frame the thumbnail stopped at. The
  bar spans the hand-off for the same reason it must not flicker: it reads the
  display's clock while the display has the clip, the held position while the
  clip is on its way back to an element that is still at 0:00, and its own
  element otherwise — the clock is read from `loadeddata` rather than
  `durationchange` for exactly that reason, since the earlier of the two fires
  before the hand-back has been applied. With the command line
  empty the arrow keys — and the coarser `Ctrl+J`/`Ctrl+L` (a minute) and
  `Ctrl+H`/`Ctrl+;` (ten) steps — are a scrubber for what is showing
  (`seekPreview` steps
  the footer's clip and, when a display is up, the same clip in the other pane, so
  the two cannot drift apart): stepping back into a clip that had played itself
  out plays on from there, and stepping past its end stops there — the end of a
  clip is not quietly its beginning again. The wheel over a clip is a scrubber
  too (`wheelScrub` in `FilePanel`): a plain wheel steps it ten seconds, the
  left button held a minute and the right button ten — wheel-up forward — and in
  a footer it is bound to the media box rather than the whole pane, so the
  wheel over the listing still scrolls the listing. In the *display* the media box
  is not the element (`overStageMedia`): the wheel is measured against the
  picture's own rectangle — an image's element is the whole stage with the picture
  letterboxed inside it — and against the transport directly under it, so a wheel
  on the picture or the bar seeks, while one anywhere else in the pane — the
  letterbox, the padding, an emptied display — steps the *folder being browsed*
  instead: one row a notch, up for the row above and down for the one below, which
  a display follows on its own. That is a way of flicking through what a display
  is showing without leaving the mode, and a wheel turned with a button held is
  part of that press's gesture here too, so its release neither leaves the mode
  nor counts as a click.
- **An action on a clip is answered by a YouTube-style on-screen display.** A
  pause, a resume or a seek flashes a glyph over the picture that holds for a
  moment and fades on its own (`PlaybackOsd.vue`, `styles/osd.css`) — nothing is
  permanently drawn over the video, and a repeat of the action restarts the
  flash rather than being swallowed. It is a play/pause glyph in the middle, or
  a direction chevron with how far the clip was stepped on the side it is moving
  toward — seconds as `10`, and a coarser step as `1m`/`10m` (`formatSeekStep`),
  at the size of the box it is over: the enlarged display's, or — when
  no display is up, so the footer's own preview is the thing being driven — the
  small thumbnail's, compact. The overlay owns only the *animation*: it reports
  the end of the flash back with a `done` event, so no timer has to be kept in
  step with the CSS, and it never takes a click (`pointer-events-none`). The
  footer and the display keep one display each, since the two can be showing
  different clips. A seek is flashed in `seek()` itself, so the keyboard, the
  wheel and the coarser Ctrl steps read the same, while a drag of the transport
  does not — that is a scrub with the bar under the pointer rather than a step.
- **The full-screen mode is the display, presented over the whole window.** It is
  not a third thing to maintain: `Ctrl+Enter` (and a triple-click on a media
  file's name, which is the same gesture with the mouse) opens the display the
  arrow keys already drive and asks the pane showing it to lay it out over
  everything instead of in its pane (`stageFullscreen` in `App.vue`, broadcast to
  both panes; the overlay in `FilePanel` becomes `fixed inset-0 z-50` — the pane
  row is `isolate` and its parent is positioned, so the fixed layer paints over
  the tab strip and the terminal without anything being teleported or hidden).
  Everything else is untouched: the pane that asked keeps the keyboard, so
  arrowing still browses the folder and the media follows the cursor; seek,
  play/pause, the wheel, the transport and the sound ramp are the same code. The
  reveal still grows out of the footer thumbnail — the source pane is behind the
  overlay, not unmounted, so its footer is still measurable — and the reverse
  still shrinks back onto it. That is why leaving the mode holds the full-window
  layout until the dismissal has landed (`fullscreenPresentation` latches past
  the `fullscreen` prop, which `Ctrl+Enter`-back-to-the-pane clears at once but
  Escape does not): snapping the overlay back to its pane under the shrinking
  picture would resize the media out from under its own animation.
- **A clip Chromium cannot play is transcoded, when ffmpeg is there to do it.**
  Chromium has no demuxer for AVI or ASF, and no decoder for the motion JPEG of
  an old camcorder AVI or the WMV3/VC-1 of an ASF one — `canPlayType` answers no
  for every one of them — so `src/shared/video.ts` keeps a second extension list
  of what only ffmpeg can make playable, and main encodes those into H.264 for
  the same `bipane-media` stream (at most 720px wide, with its sound: a footer
  thumbnail is muted by the element that plays it, but a display is heard).
  The encode is streamed out **as it is produced** (`empty_moov` +
  `frag_keyframe`, a keyframe every thirty frames, straight to the response with
  nothing written to disk): a plain mp4 has no header until its encode has ended,
  so waiting for one would mean a black box for the length of the whole clip, and
  a fragment is on screen a tenth of a second in instead. There is no length
  limit and no finished file to wait for — a display is a *player*, so a
  feature-length file is watched rather than prepared, and the encode runs for as
  long as the clip is looked at (the element going away is what stops it).
  `from` is the whole of seeking, and is why the keys work on such a clip at all:
  a live stream reports no range to move within, so moving about the clip means
  asking for the stream again — `-ss` before the input — from the position
  wanted. The element rebases whatever it is given to zero, so the pane that
  asked adds that offset back to say where the clip is, and takes the length from
  the file itself (`fs:video-duration`) rather than from a stream that only knows
  what is left of it. However many elements ask for a clip — a footer playing it
  and a display showing it — each has its own stream, and a seek on either is a
  position in the clip. All of this is gated on ffmpeg existing: the renderer asks once
  (`fs:can-transcode`) and, with no answer, those files are not media at all —
  `Enter` opens them in the system player, exactly as before that list existed.
  `BIPANE_FFMPEG` names the binary for a machine that keeps it off the PATH.
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
  injection from being appended to a half-typed command. Erasing the echo is
  only half of it, because readline added the line to the **history list** before
  running it, so Up offered the sync as if the user had typed it: the line ends
  by deleting the entry it just became (`history -d "$HISTCMD"`, guarded on
  `$BASH_VERSION` so a non-bash `$SHELL` is not handed a command that errors).
  It must *not* be prefixed with a space: a space is the usual request to forget
  a line, but `HISTCONTROL=ignorespace` drops it before it is ever numbered, so
  `$HISTCMD` would still name the user's previous command and the delete would
  take that one. Started at column 0 the entry is always ours — and if a shell
  drops the line anyway (`ignoredups` on a repeat) the worst it can reach is an
  earlier copy of this same line. This erase only works
  while the terminal has a row to spare: a **one-row** terminal scrolls on every
  newline, so the echoed `cd` leaves the viewport for the scrollback before the
  `printf` runs, and `Ctrl+O` then shows a transcript of them. `refit()` in
  `TerminalPane` therefore clamps the terminal to at least two rows, and the
  collapsed strip clips the spare row away rather than showing it. What is
  visible must be the row the **cursor** is on, not the top of the buffer: the
  strip is the command line, so `applyStripViewport()` measures a row's height,
  sizes the host's content box to exactly that, and shifts the terminal up so the
  cursor's row lands inside it. Leaving the terminal at the top instead showed
  the row *above* the cursor — after `ls`, the last output line rather than the
  prompt sitting under it. The clip must be the row exactly, so the host carries
  no vertical padding: `overflow: hidden` clips at the **padding box**, and with
  the `py-1` the strip used to have, the translated row above the cursor painted
  its descender tips into the top padding — a stray pixel of the previous line
  under the strip's border, visible only when that line had a `p`/`y`/`g`/`q` or
  an underscore low enough to reach it. The gutter above and below is the host's
  margin (`my-1`), which lies outside the clip edge, so the height written there
  is one row on its own.
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
  the tail. **Viewing (F3) has no cursor, because its keys are a viewer's and not
  an editor's**: the arrows scroll the document a line at a time, the pages a
  screenful, and `Home`/`End` jump to its ends, instead of walking an invisible
  caret that would keep the view still until it had passed the bottom of the
  screen. The remap is `editor.addCommand(...)` at the core commands' own
  `scroll*` ids (`scrollLineUp`/`scrollLineDown`/`scrollPageUp`/`scrollPageDown`/
  `scrollEditorTop`/`scrollEditorBottom`), gated on `'textInputFocus'` so it stays
  out of the find box the way Monaco's core navigation does, and only in view
  mode — F4 keeps the caret. The caret itself is hidden by
  `styles/viewer.css` (`.viewer-no-cursor .cursors-layer { display: none }`, the
  host carrying that class only when read-only), which leaves the selection
  highlight — a different layer — so the mouse still selects and copies; the
  current-line highlight goes too, via `renderLineHighlight: 'none'`, since with
  no caret there is nothing for it to point out.
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
  (`ws://localhost:*`, `'unsafe-inline'` styles) are required for Vite HMR, and
  `img-src data:` / `media-src bipane-media:` are what let a footer show a
  preview the renderer has no URL of its own for.

## Verifying changes in dev

**Do not visually or interactively test changes unless explicitly asked.** The
manual is here for when the user asks for it; by default they do the visual and
interaction testing themselves, and driving the app (xdotool, screenshots, CDP)
is slow and disruptive. So treat the steps below as on-request only — do not
launch, restart, or drive the dev app to check your own work unless told to.

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

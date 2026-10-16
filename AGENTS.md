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
src/main/ipc/fs.ts       IPC: fs:home, fs:list, fs:open, fs:reveal
src/main/ipc/pty.ts      IPC: pty:create/write/resize/kill, pushes pty:data, pty:exit
src/preload/index.ts     contextBridge -> window.bipane (implements BipaneApi)
src/shared/types.ts      DirEntry/DirListing/Result/Pty* types (main + renderer)
src/shared/api.ts        BipaneApi interface (the preload contract)
src/renderer/src/App.vue global keyboard model, layout, terminal toggle
src/renderer/src/components/FilePanel.vue    one pane: path bar, list, footer
src/renderer/src/components/TerminalPane.vue xterm instance bound to one pty
src/renderer/src/composables/useDirectory.ts per-pane navigation state + actions
src/renderer/src/lib/format.ts               size/date/permission formatting
```

Keys: `Tab` switches panes, arrows/`Home`/`End`/`PgUp`/`PgDn` move the cursor,
`Enter` descends or opens, `Backspace` goes up, `Ctrl+O` toggles the terminal.

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
- **Tailwind v4 is configured CSS-first** (`@theme` in
  `src/renderer/src/styles/main.css`). There is no `tailwind.config.js`.
  Theme tokens are the design system — prefer `bg-surface`, `text-fg-dim`,
  `border-border` over raw hex values.
- The renderer has a CSP in `src/renderer/index.html`. Dev-only allowances
  (`ws://localhost:*`, `'unsafe-inline'` styles) are required for Vite HMR.

## Conventions

- Keep filesystem and pty access in the main process; the renderer only talks
  to `window.bipane`. Never enable `nodeIntegration`.
- IPC handlers return `Result<T>` instead of throwing across the bridge.
- The security model is contextIsolation on, nodeIntegration off, and the
  preload exposes a narrow, explicitly typed surface.

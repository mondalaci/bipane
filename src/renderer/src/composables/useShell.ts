import { ref } from 'vue'

/**
 * The whole app shares a single shell session. The command line writes into it
 * and the Ctrl+O terminal renders it, so Enter on the command line is a real
 * Enter and everything stateful (cwd, history, pipes) works for free.
 */
const SESSION_ID = 'main'
const POLL_INTERVAL_MS = 300
const MAX_BUFFER_LENGTH = 200_000
const SPAWN_COLS = 120
const SPAWN_ROWS = 30

const started = ref(false)
const cwd = ref<string | null>(null)
const idle = ref(false)

const dataListeners = new Set<(data: string) => void>()
const exitListeners = new Set<(code: number) => void>()

let buffer = ''
let pollTimer: number | null = null
let startPromise: Promise<void> | null = null

function handleData(data: string): void {
  // Retain recent output so a terminal opened later can replay it instead of
  // showing an empty screen.
  buffer += data
  if (buffer.length > MAX_BUFFER_LENGTH) {
    buffer = buffer.slice(buffer.length - MAX_BUFFER_LENGTH)
  }
  for (const listener of dataListeners) listener(data)
}

async function refreshState(): Promise<void> {
  if (!started.value) return

  const snapshot = await window.bipane.pty.state(SESSION_ID)
  idle.value = snapshot.idle
  if (snapshot.cwd && snapshot.cwd !== cwd.value) cwd.value = snapshot.cwd
}

function beginPolling(): void {
  if (pollTimer !== null) return
  pollTimer = window.setInterval(() => {
    void refreshState()
  }, POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (pollTimer === null) return
  window.clearInterval(pollTimer)
  pollTimer = null
}

function teardown(): void {
  stopPolling()
  startPromise = null
  started.value = false
  idle.value = false
}

export function ensureStarted(spawnCwd: string): Promise<void> {
  if (startPromise) return startPromise

  const created = window.bipane.pty.create(SESSION_ID, {
    cwd: spawnCwd,
    cols: SPAWN_COLS,
    rows: SPAWN_ROWS
  })

  let cancelled = false

  const onDataDisposer = window.bipane.pty.onData((event) => {
    if (event.id === SESSION_ID) handleData(event.data)
  })

  const onExitDisposer = window.bipane.pty.onExit((event) => {
    if (event.id !== SESSION_ID) return
    if (cancelled) return
    for (const listener of exitListeners) listener(event.exitCode)
    dispose()
    teardown()
  })

  function dispose(): void {
    cancelled = true
    onDataDisposer()
    onExitDisposer()
  }

  startPromise = created.then(() => {
    if (cancelled) return
    started.value = true
    cwd.value = spawnCwd
    beginPolling()
  })

  return startPromise
}

export function write(data: string): void {
  if (!started.value) return
  window.bipane.pty.write(SESSION_ID, data)
}

export function resize(cols: number, rows: number): void {
  if (!started.value) return
  window.bipane.pty.resize(SESSION_ID, cols, rows)
}

export function attachTerminal(
  onData: (data: string) => void,
  onExit: (code: number) => void
): { initial: string; detach: () => void } {
  const initial = buffer
  buffer = ''
  dataListeners.add(onData)
  exitListeners.add(onExit)

  return {
    initial,
    detach: () => {
      dataListeners.delete(onData)
      exitListeners.delete(onExit)
    }
  }
}

export function kill(): void {
  teardown()
  window.bipane.pty.kill(SESSION_ID)
}

export function useShell() {
  return { started, cwd, idle, ensureStarted, write, resize, attachTerminal, kill }
}

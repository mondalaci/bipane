import { ref } from 'vue'

/**
 * The whole app shares a single shell session. The command line writes into it
 * and the Ctrl+O terminal renders it, so Enter on the command line is a real
 * Enter and everything stateful (cwd, history, pipes) works for free.
 */
const SESSION_ID = 'main'
const POLL_INTERVAL_MS = 300
const MAX_BUFFER_LENGTH = 200_000

const started = ref(false)
const cwd = ref<string | null>(null)
const idle = ref(false)
/**
 * What the shell's input line currently holds. We model it from the bytes
 * xterm sends, because the command line *is* the shell: the alternative is
 * poking at the terminal buffer, which cannot tell where the prompt ends.
 * Only emptiness matters, so a simple append/backspace model stays accurate
 * even when readline's own caret moves behind our back.
 */
const inputLine = ref('')

let lineBuffer = ''

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

export function ensureStarted(spawnCwd: string, cols: number, rows: number): Promise<void> {
  if (startPromise) return startPromise

  const created = window.bipane.pty.create(SESSION_ID, {
    cwd: spawnCwd,
    cols: Math.max(cols, 2),
    rows: Math.max(rows, 1)
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

function noteInput(data: string): void {
  for (const char of data) {
    const code = char.codePointAt(0) ?? 0

    if (code === 13 || code === 10 || code === 3 || code === 21) {
      lineBuffer = ''
      continue
    }
    if (code === 127 || code === 8) {
      lineBuffer = lineBuffer.slice(0, -1)
      continue
    }
    if (code === 23) {
      lineBuffer = lineBuffer.replace(/\s*\S*$/, '')
      continue
    }
    if (code === 27) break
    if (code < 32) continue
    lineBuffer += char
  }

  inputLine.value = lineBuffer
}

/** Sends input we originate, keeping the line model in step. */
export function sendInput(data: string): void {
  noteInput(data)
  write(data)
}

export function clearInputLine(): void {
  sendInput('\u0015')
}

export function resize(cols: number, rows: number): void {
  if (!started.value) return
  window.bipane.pty.resize(SESSION_ID, cols, rows)
}

export function attachTerminal(
  onData: (data: string) => void,
  onExit: (code: number) => void
): { initial: string; detach: () => void } {
  // The buffer is not drained: a terminal that attaches later — or re-attaches
  // after a reload — replays the session so far instead of showing a blank
  // screen. It is a bounded rolling window, not the full scrollback.
  const initial = buffer
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

export function useShell() {
  return {
    started,
    cwd,
    idle,
    inputLine,
    ensureStarted,
    write,
    sendInput,
    clearInputLine,
    noteInput,
    resize,
    attachTerminal
  }
}

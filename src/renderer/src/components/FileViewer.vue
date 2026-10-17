<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type * as MonacoApi from 'monaco-editor'
import { languageFor, loadMonaco } from '@renderer/lib/monaco'

const props = defineProps<{ path: string; mode: 'view' | 'edit' }>()

const emit = defineEmits<{ (event: 'close'): void }>()

const host = ref<HTMLElement | null>(null)
const loading = ref(true)
/**
 * A failure that means there is nothing to show — a failed read, a binary or
 * oversized file, a Monaco that would not load. It replaces the editor area.
 */
const error = ref<string | null>(null)
/**
 * A failed save. Kept apart from `error` on purpose: the editor must stay on
 * screen (the buffer is still the user's work) so this shows as a strip beside
 * the header instead of replacing it.
 */
const saveError = ref<string | null>(null)
const truncated = ref(false)
const dirty = ref(false)
const saving = ref(false)
const saved = ref(false)

let editor: MonacoApi.editor.IStandaloneCodeEditor | null = null
let model: MonacoApi.editor.ITextModel | null = null
let changeSubscription: MonacoApi.IDisposable | null = null
let savedTimer: number | null = null
/**
 * The read and the Monaco import are both awaited, so the view can be unmounted
 * (Escape, another F3/F4) before either settles. Without this the late
 * continuation would create an editor in a detached element and leak it.
 */
let disposed = false

const editable = computed(() => props.mode === 'edit')
const name = computed(() => props.path.split(/[\\/]/).pop() ?? props.path)

// Resolve the mono stack from the theme, exactly as the terminal does, so the
// editor and the shell cannot drift apart.
function monoFontStack(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-mono')
    .trim()
  return value || 'monospace'
}

async function save(): Promise<void> {
  const current = model
  if (!editable.value || !current || saving.value) return

  saving.value = true
  saveError.value = null

  const result = await window.bipane.fs.write(props.path, current.getValue())
  saving.value = false
  if (disposed) return

  if (!result.ok) {
    saveError.value = `${result.error.code}: ${result.error.message}`
    return
  }

  dirty.value = false
  saved.value = true
  if (savedTimer !== null) window.clearTimeout(savedTimer)
  savedTimer = window.setTimeout(() => {
    savedTimer = null
    saved.value = false
  }, 1500)
}

onMounted(async () => {
  const result = await window.bipane.fs.read(props.path)
  if (disposed) return

  if (!result.ok) {
    error.value = `${result.error.code}: ${result.error.message}`
    loading.value = false
    return
  }

  truncated.value = result.data.truncated

  // An edit of a truncated read would write back only the first chunk and
  // silently destroy the rest of the file, so that combination is refused
  // outright rather than opened read-only and hoped about.
  if (editable.value && result.data.truncated) {
    error.value = 'Too large to edit safely — only the first 8 MiB was read'
    loading.value = false
    return
  }

  let monaco: typeof MonacoApi
  try {
    monaco = await loadMonaco()
  } catch (cause) {
    if (disposed) return
    error.value = `Failed to load the editor: ${(cause as Error).message}`
    loading.value = false
    return
  }
  if (disposed) return

  const element = host.value
  if (!element) return

  model = monaco.editor.createModel(
    result.data.text,
    languageFor(monaco, result.data.path),
    monaco.Uri.file(result.data.path)
  )

  editor = monaco.editor.create(element, {
    model,
    // Viewing is strictly read-only; editing is a normal writable buffer whose
    // only persistence is an explicit Ctrl+S through fs:write.
    readOnly: !editable.value,
    domReadOnly: !editable.value,
    theme: 'vs-dark',
    automaticLayout: true,
    fontFamily: monoFontStack(),
    fontSize: 12,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    stickyScroll: { enabled: false },
    smoothScrolling: true,
    padding: { top: 6, bottom: 6 }
  })

  changeSubscription = model.onDidChangeContent(() => {
    dirty.value = true
  })

  if (editable.value) {
    // Ctrl/Cmd+S is the save gesture; the window-level handler lets it through
    // to the editor while the viewer is open.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void save()
    })
  }

  loading.value = false
  editor.focus()
})

onBeforeUnmount(() => {
  disposed = true
  if (savedTimer !== null) window.clearTimeout(savedTimer)
  savedTimer = null
  changeSubscription?.dispose()
  changeSubscription = null
  editor?.dispose()
  editor = null
  model?.dispose()
  model = null
})

/**
 * Whether the viewer may close. An edit with unsaved changes asks first, so
 * Escape (or the close button) never discards work silently. Called by App.vue,
 * which owns the open/closed state.
 */
function confirmClose(): boolean {
  if (!dirty.value) return true
  return window.confirm(`Discard unsaved changes to "${name.value}"?`)
}

defineExpose({ confirmClose })
</script>

<template>
  <section
    class="absolute inset-0 z-20 flex flex-col overflow-hidden border border-border bg-bg"
  >
    <div class="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <svg
        viewBox="0 0 24 24"
        class="h-3.5 w-3.5 shrink-0 text-fg-dim"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
      <span class="shrink-0 text-ui font-medium text-fg-bright">{{ name }}</span>
      <span
        v-if="editable && dirty"
        class="shrink-0 text-selected"
        title="Unsaved changes"
        aria-label="Unsaved changes"
        >●</span
      >
      <span class="truncate font-mono text-ui-sm text-fg-dim" :title="path">{{ path }}</span>

      <span
        v-if="truncated"
        class="shrink-0 rounded bg-bg-alt px-1.5 py-0.5 text-ui-sm text-selected"
        title="Only the beginning of this file is shown"
      >
        truncated
      </span>
      <span v-if="saved" class="shrink-0 text-ui-sm text-fg-dim">saved</span>
      <span
        v-if="saveError"
        class="min-w-0 truncate text-ui-sm text-danger"
        :title="saveError"
      >
        {{ saveError }}
      </span>

      <div class="min-w-0 flex-1"></div>

      <button
        v-if="editable"
        type="button"
        class="shrink-0 rounded px-1.5 py-0.5 text-ui-sm transition-colors"
        :class="dirty ? 'bg-accent text-fg-bright hover:bg-accent-strong' : 'text-fg-dim hover:bg-hover hover:text-fg'"
        :disabled="saving"
        title="Save (Ctrl+S)"
        @click="save"
      >
        Save
      </button>

      <button
        type="button"
        class="shrink-0 rounded p-0.5 text-fg-dim transition-colors hover:bg-hover hover:text-fg"
        title="Close the viewer (Esc)"
        @click="emit('close')"
      >
        <svg
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>

    <div class="relative min-h-0 flex-1">
      <p
        v-if="error"
        class="flex h-full items-center justify-center px-4 text-center text-ui text-danger"
      >
        {{ error }}
      </p>
      <div v-else ref="host" class="h-full w-full"></div>

      <p
        v-if="loading"
        class="absolute inset-0 flex items-center justify-center text-ui text-fg-dim"
      >
        Loading…
      </p>
    </div>
  </section>
</template>

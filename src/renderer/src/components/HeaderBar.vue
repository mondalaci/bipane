<script setup lang="ts">
defineProps<{ terminalOpen: boolean }>()

const emit = defineEmits<{ (event: 'toggle-terminal'): void }>()
</script>

<template>
  <header
    class="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface pr-2 pl-3"
  >
    <div class="flex items-center gap-2">
      <svg
        viewBox="0 0 24 24"
        class="h-4 w-4 text-accent-strong"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
        <path d="M12 4.5v15" />
      </svg>
      <span class="text-ui-lg font-medium tracking-tight text-fg-bright">Bipane</span>
    </div>

    <button
      type="button"
      class="flex items-center gap-2 rounded px-2 py-1 text-ui-sm transition-colors"
      :class="
        terminalOpen
          ? 'bg-selection text-fg-bright'
          : 'text-fg-dim hover:bg-hover hover:text-fg'
      "
      title="Toggle terminal (Ctrl+O)"
      @click="emit('toggle-terminal')"
    >
      <svg
        viewBox="0 0 24 24"
        class="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m3 7 5 5-5 5" />
        <path d="M12 17h9" />
      </svg>
      <span>Terminal</span>
      <kbd
        class="rounded border border-border bg-bg-alt px-1 font-mono text-2xs text-fg-dim"
      >
        Ctrl+O
      </kbd>
    </button>
  </header>
</template>

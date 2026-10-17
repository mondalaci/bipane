<script setup lang="ts">
import { computed } from 'vue'
import type { PaneController } from '@renderer/composables/useDirectory'
import { formatDate, formatMode, formatSize } from '@renderer/lib/format'
import type { PanelSide } from '@shared/types'

const props = defineProps<{
  pane: PaneController
  activeSide: PanelSide
  terminalOpen: boolean
}>()

const entry = computed(() => props.pane.current())
const itemCount = computed(() => props.pane.state.itemCount)
const selectedCount = computed(() => props.pane.selectedCount())
</script>

<template>
  <footer
    class="flex h-6 shrink-0 items-center justify-between gap-4 border-t border-border bg-surface px-3 text-ui-sm text-fg-dim"
  >
    <div class="flex min-w-0 items-center gap-3">
      <span class="shrink-0 text-fg-dim">
        {{ activeSide === 'left' ? 'Left' : 'Right' }} panel
      </span>
      <span class="truncate font-mono" :title="pane.state.path">{{ pane.state.path }}</span>
    </div>

    <div class="flex shrink-0 items-center gap-3">
      <template v-if="entry && !entry.isParent">
        <span class="hidden tabular-nums lg:inline">{{ formatMode(entry.mode) }}</span>
        <span class="tabular-nums">
          {{ entry.kind === 'directory' ? 'dir' : formatSize(entry.size) }}
        </span>
        <span class="hidden tabular-nums lg:inline">{{ formatDate(entry.mtimeMs) }}</span>
      </template>

      <span class="tabular-nums">{{ itemCount }} items</span>

      <span v-if="selectedCount > 0" class="tabular-nums text-selected">
        {{ selectedCount }} selected
      </span>

      <span class="hidden items-center gap-1 md:flex">
        <kbd class="rounded border border-border bg-bg-alt px-1 font-mono text-2xs">Tab</kbd>
        <span>switch</span>
        <kbd class="rounded border border-border bg-bg-alt px-1 font-mono text-2xs">↵</kbd>
        <span>open</span>
        <kbd class="rounded border border-border bg-bg-alt px-1 font-mono text-2xs">Ins</kbd>
        <span>select</span>
        <kbd class="rounded border border-border bg-bg-alt px-1 font-mono text-2xs">Alt+S</kbd>
        <span>find</span>
        <kbd class="rounded border border-border bg-bg-alt px-1 font-mono text-2xs">Ctrl+O</kbd>
        <span>terminal</span>
        <kbd class="rounded border border-border bg-bg-alt px-1 font-mono text-2xs">Ctrl+R</kbd>
        <span>refresh</span>
      </span>
    </div>
  </footer>
</template>

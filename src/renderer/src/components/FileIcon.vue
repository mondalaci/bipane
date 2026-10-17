<script setup lang="ts">
import { computed } from 'vue'
import type { PaneEntry } from '@renderer/composables/useDirectory'
import { iconForEntry } from '@renderer/lib/fileIcon'

const props = defineProps<{ entry: PaneEntry }>()

const icon = computed(() => iconForEntry(props.entry))
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    class="h-3.5 w-3.5"
    :style="{ color: icon.color }"
    :fill="icon.filled ? 'currentColor' : 'none'"
    :stroke="icon.filled ? 'none' : 'currentColor'"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="icon.body"
  ></svg>
</template>

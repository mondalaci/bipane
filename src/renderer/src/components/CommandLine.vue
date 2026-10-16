<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ modelValue: string; cwd: string | null }>()

const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>()

const inputEl = ref<HTMLInputElement | null>(null)

function onInput(event: Event): void {
  const target = event.target
  if (target instanceof HTMLInputElement) emit('update:modelValue', target.value)
}

defineExpose({ focus: () => inputEl.value?.focus() })
</script>

<template>
  <div
    class="flex h-7 shrink-0 items-center gap-2 border-t border-border bg-bg-alt px-3"
  >
    <span
      class="max-w-[45%] shrink-0 truncate font-mono text-ui-sm text-fg-dim"
      :title="cwd ?? ''"
    >
      {{ cwd ?? '~' }}
    </span>
    <span class="shrink-0 font-mono text-ui-sm text-accent-strong">❯</span>
    <input
      ref="inputEl"
      type="text"
      class="min-w-0 flex-1 bg-transparent font-mono text-ui text-fg outline-none placeholder:text-fg-dim"
      placeholder="command"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      :value="modelValue"
      @input="onInput"
    />
  </div>
</template>

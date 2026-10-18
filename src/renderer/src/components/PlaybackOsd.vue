<script setup lang="ts">
import { computed } from 'vue'
import { formatSeekStep } from '@renderer/lib/format'
import type { OsdFlash } from '@renderer/lib/preview'

const props = defineProps<{
  osd: OsdFlash
  /**
   * The footer's own thumbnail rather than the enlarged display: the same glyph
   * drawn at a size the small box can hold.
   */
  compact?: boolean
}>()

/** The flash is over when its own animation ends (see styles/osd.css). */
const emit = defineEmits<{ (event: 'done'): void }>()

/**
 * A seek's glyph sits on the side the clip is moving toward — left for a step
 * back, right for a step forward — while a play/pause glyph sits in the middle.
 */
const placement = computed(() =>
  props.osd.kind !== 'seek'
    ? 'justify-center'
    : props.osd.delta < 0
      ? 'justify-start pl-[8%]'
      : 'justify-end pr-[8%]'
)

const boxClass = computed(() => {
  if (props.osd.kind === 'seek') {
    return props.compact ? 'h-6 gap-0.5 px-1.5 text-2xs' : 'h-14 gap-1.5 px-3 text-ui-lg'
  }
  return props.compact ? 'h-6 w-6' : 'h-16 w-16'
})

const iconClass = computed(() => (props.compact ? 'h-2.5 w-2.5' : 'h-6 w-6'))
</script>

<template>
  <div class="pointer-events-none absolute inset-0 z-10 flex items-center" :class="placement">
    <div
      class="osd-pop flex items-center justify-center rounded-full bg-black/60 text-white"
      :class="boxClass"
      @animationend="emit('done')"
    >
      <template v-if="osd.kind === 'seek'">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          :class="[iconClass, osd.delta < 0 ? '' : '-scale-x-100']"
        >
          <path d="M13 6 7 12l6 6" />
          <path d="M19 6l-6 6 6 6" />
        </svg>
        <span class="font-semibold tabular-nums">{{ formatSeekStep(osd.delta) }}</span>
      </template>
      <svg v-else viewBox="0 0 24 24" fill="currentColor" :class="iconClass" aria-hidden="true">
        <path v-if="osd.kind === 'pause'" d="M7 5h4v14H7zM14 5h4v14h-4z" />
        <path v-else d="M8 5v14l11-7z" />
      </svg>
    </div>
  </div>
</template>

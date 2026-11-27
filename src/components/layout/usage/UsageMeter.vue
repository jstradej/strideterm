<template>
  <span
    class="usage-meter"
    :class="{ 'usage-meter--large': large }"
    role="img"
    :aria-label="label"
    :style="{ '--c': toneColor(tone) }"
  >
    <b class="usage-meter__fill" :style="{ width: `${clampPercent(used)}%` }" />
    <em v-if="tick != null" class="usage-meter__tick" :style="{ left: `${clampPercent(tick)}%` }" aria-hidden="true" />
  </span>
</template>

<script setup lang="ts">
import { clampPercent, toneColor, type UsageTone } from "../../../lib/usage-advice.js";

defineProps<{
  used: number;
  /** Even-pace position in percent of the window. */
  tick?: number;
  tone: UsageTone;
  label: string;
  large?: boolean;
}>();
</script>

<style scoped>
.usage-meter {
  position: relative;
  display: block;
  min-width: 0;
  height: 5px;
  border-radius: 3px;
  background: rgba(var(--tint), 0.08);
}
.usage-meter--large {
  height: 8px;
  border-radius: 4px;
}
.usage-meter__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--c);
}
.usage-meter__tick {
  position: absolute;
  top: -2px;
  width: 2px;
  height: calc(100% + 4px);
  border-radius: 1px;
  background: var(--text);
  transform: translateX(-1px);
}
</style>

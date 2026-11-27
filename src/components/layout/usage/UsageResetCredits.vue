<template>
  <div v-if="advice" class="usage-resets">
    <div class="usage-resets__head">
      <span class="usage-resets__tokens" aria-hidden="true">
        <span
          v-for="(token, index) in tokens"
          :key="index"
          class="usage-resets__token"
          :class="{ 'usage-resets__token--soon': token.soon }"
          >↻</span
        >
      </span>
      <strong>{{ resetCreditHeadline(advice.available) }}</strong>
    </div>
    <p class="usage-resets__tip">{{ resetAdviceText(advice, window, pace, now) }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { UsageResetCredits, UsageWindow } from "../../../../electron/shared/agent-usage.js";
import { resetAdviceText, resetCreditHeadline } from "../../../lib/usage-advice.js";
import { adviseResetCredit, type UsagePace } from "../../../lib/usage-pace.js";

const MAX_TOKENS = 8;
const props = defineProps<{
  window: UsageWindow;
  pace: UsagePace;
  credits: UsageResetCredits;
  checkedAt: number;
  now: number;
}>();

const advice = computed(() => adviseResetCredit(props.window, props.pace, props.credits, props.checkedAt));
const tokens = computed(() => {
  const resetsAt = props.window.resetsAt;
  const total = Math.min(MAX_TOKENS, props.credits.available);
  return Array.from({ length: total }, (_, index) => {
    const expiresAt = props.credits.expiresAt[index];
    return { soon: expiresAt != null && resetsAt != null && expiresAt > props.checkedAt && expiresAt < resetsAt };
  });
});
</script>

<style scoped>
.usage-resets {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(var(--tint), 0.04);
}
.usage-resets__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.usage-resets__tokens {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.usage-resets__token {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: 1.5px solid var(--accent);
  border-radius: 50%;
  color: var(--accent);
  font-size: 10px;
  line-height: 1;
}
.usage-resets__token--soon {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
.usage-resets__tip {
  margin: 0;
  color: var(--muted);
  font-size: 10.5px;
  line-height: 1.4;
}
</style>

<template>
  <section class="agent-usage" aria-label="Agent account usage">
    <header class="agent-usage__header">
      <div class="agent-usage__intro">
        <h2>Usage pace</h2>
        <p>{{ usageSourceText }}</p>
        <p v-if="accountCheckedAt">Checked {{ formatTime(accountCheckedAt) }}</p>
        <p v-else-if="!loading">Usage has not been checked yet.</p>
      </div>
      <button type="button" class="agent-usage__refresh" :disabled="loading" @click="() => refresh()">
        <Spinner v-if="loading" label="" />
        {{ loading ? "Checking…" : "Refresh" }}
      </button>
    </header>

    <p v-if="error" class="agent-usage__message" role="alert">{{ error }}</p>
    <div v-if="loading && entries.length === 0" class="agent-usage__empty" role="status">
      <Spinner size="md" label="" />
      Checking provider usage…
    </div>
    <p v-else-if="!loading && entries.length === 0 && !error" class="agent-usage__message">
      No provider usage data is available.
    </p>

    <section v-if="nextTaskAdvice" class="agent-usage__next-task" aria-live="polite">
      <span class="agent-usage__next-icon" aria-hidden="true">→</span>
      <span>
        <strong>Use {{ providerName(nextTaskAdvice.provider) }} for the next task</strong>
        ·
        <template v-if="nextTaskAdvice.exhausted">
          {{ providerName(nextTaskAdvice.otherProvider) }} {{ nextTaskAdvice.window.label }} quota is exhausted.
        </template>
        <template v-else>
          {{ providerName(nextTaskAdvice.otherProvider) }} is pacing above its {{ nextTaskAdvice.window.label }} budget.
        </template>
      </span>
    </section>

    <ul v-if="entries.length" class="agent-usage__providers">
      <UsageProviderCard
        v-for="entry in entries"
        :key="entry.provider"
        :entry="entry"
        :now="now"
        :gemini-source-text="geminiSourceText"
      />
    </ul>
    <p v-if="hasForecast" class="agent-usage__confidence">Pace estimates use the average since each window began.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from "vue";
import Spinner from "../common/Spinner.vue";
import UsageProviderCard from "./usage/UsageProviderCard.vue";
import { useAgentUsage } from "../../composables/useAgentUsage.js";
import { useAppStore } from "../../stores/app.js";
import { apiKey } from "../../types/keys.js";
import { formatTime, providerName } from "../../lib/usage-advice.js";
import { assessUsagePace, recommendNextUsageAccount } from "../../lib/usage-pace.js";

const { entries, loading, error, accountCheckedAt, refresh } = useAgentUsage();
const appStore = useAppStore();
const injectedApi = inject(apiKey, null);
const isRemote = computed(() => (injectedApi ?? appStore.getApi())?.isRemote);
const usageSourceText = computed(() =>
  isRemote.value
    ? "Claude and Codex usage comes from the paired desktop's default CLI accounts."
    : "Claude and Codex use the default CLI accounts on this computer.",
);
const geminiSourceText = computed(() =>
  isRemote.value
    ? "Rounded usage from the selected Gemini terminal on the paired desktop."
    : "Rounded usage from the selected local Gemini terminal.",
);
const now = ref(Date.now());
let countdownTimer: ReturnType<typeof setInterval> | undefined;
const hasForecast = computed(() =>
  entries.value.some(
    (entry) =>
      entry.provider !== "gemini" &&
      entry.windows.some((window) => assessUsagePace(window, entry.checkedAt).elapsedPercent != null),
  ),
);
const nextTaskAdvice = computed(() => recommendNextUsageAccount(entries.value));

onMounted(() => {
  countdownTimer = setInterval(() => {
    now.value = Date.now();
  }, 60_000);
});
onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer);
});
</script>

<style scoped>
.agent-usage {
  --usage-mono: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  color: var(--text);
  font-size: 11px;
}
.agent-usage__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.agent-usage__intro {
  flex: 1 1 160px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.agent-usage__intro h2 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}
.agent-usage__intro p {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: 11px;
}
.agent-usage__refresh {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: rgba(var(--tint), 0.06);
  color: var(--text);
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.agent-usage__refresh:hover:not(:disabled) {
  background: rgba(var(--tint), 0.12);
}
.agent-usage__refresh:disabled {
  opacity: 0.55;
  cursor: default;
}
.agent-usage__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px;
  color: var(--muted);
  font-size: 13px;
}
.agent-usage__message,
.agent-usage__confidence {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.4;
}
.agent-usage__next-task {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--success) 12%, transparent);
  font-size: 11px;
  line-height: 1.4;
}
.agent-usage__next-task strong {
  font-weight: 600;
}
.agent-usage__next-icon {
  flex: none;
  color: var(--success-fg);
  font-size: 13px;
}
.agent-usage__providers {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
@media (max-width: 360px) {
  .agent-usage {
    padding: 10px;
  }
}
@media (pointer: coarse) {
  .agent-usage__refresh {
    min-height: 44px;
  }
}
</style>

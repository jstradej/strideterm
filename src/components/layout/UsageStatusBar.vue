<template>
  <button
    type="button"
    class="usage-status-bar"
    :aria-label="accessibleSummary"
    title="Open full usage details"
    @click="$emit('open')"
  >
    <span class="usage-status-bar__label"> Usage<Spinner v-if="loading && displayRows.length" label="" /> </span>
    <span v-if="displayRows.length" class="usage-status-bar__providers">
      <span
        v-for="row in displayRows"
        :key="row.provider"
        class="usage-status-bar__provider"
        :style="{ '--c': toneColor(row.tone) }"
        :title="row.chartLabel"
      >
        <span class="usage-status-bar__heading">
          <span class="usage-status-bar__name">{{ row.name }}</span>
          <span v-if="row.period" class="usage-status-bar__period">{{ row.period }}</span>
        </span>
        <span v-if="row.used !== undefined" class="usage-status-bar__chart" role="img" :aria-label="row.chartLabel">
          <span class="usage-status-bar__actual" :style="{ width: `${clampPercent(row.used)}%` }" />
          <span
            v-if="row.projectedEnd !== undefined && row.projectedEnd > row.used"
            class="usage-status-bar__projection"
            :style="{ left: `${clampPercent(row.used)}%`, width: `${row.projectedEnd - clampPercent(row.used)}%` }"
          />
          <span
            v-if="row.pace !== undefined"
            class="usage-status-bar__pace"
            :style="{ left: `${clampPercent(row.pace)}%` }"
          />
        </span>
        <span v-if="row.percent" class="usage-status-bar__value">{{ row.percent }}</span>
        <span class="usage-status-bar__status">
          <span class="usage-status-bar__dot" aria-hidden="true" />
          <span class="usage-status-bar__intent">{{ row.intent }}</span>
        </span>
        <span v-if="row.resetsAt !== undefined || row.credits" class="usage-status-bar__meta">
          <span v-if="row.resetsAt !== undefined" class="usage-status-bar__reset" title="Resets in">{{
            countdown(row.resetsAt, now)
          }}</span>
          <span v-if="row.credits" class="usage-status-bar__credits" :title="resetCreditHeadline(row.credits)"
            >{{ row.credits }}× reset</span
          >
        </span>
      </span>
    </span>
    <span v-else class="usage-status-bar__empty" role="status">
      <Spinner v-if="loading" label="" />
      {{ emptyText }}
    </span>
    <span class="usage-status-bar__hint" aria-hidden="true">Details ›</span>
  </button>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import Spinner from "../common/Spinner.vue";
import { useAgentUsage } from "../../composables/useAgentUsage.js";
import type { AgentUsage } from "../../../electron/shared/agent-usage.js";
import {
  PACE_LABEL,
  clampPercent,
  countdown,
  resetCreditHeadline,
  toneColor,
  toneForState,
  type UsageTone,
} from "../../lib/usage-advice.js";
import { formatQuotaPercent, recommendNextUsageAccount, selectPacingWindow } from "../../lib/usage-pace.js";

type Provider = AgentUsage["provider"];
interface BarRow {
  provider: Provider;
  name: string;
  period: string;
  percent?: string;
  intent: string;
  tone: UsageTone;
  used?: number;
  pace?: number;
  /** End of the projected use, capped at the full quota. */
  projectedEnd?: number;
  resetsAt?: number;
  credits?: number;
  hasAlternate?: boolean;
  chartLabel: string;
}

defineEmits<{ open: [] }>();
const { entries, loading } = useAgentUsage();
const now = ref(Date.now());
let countdownTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  countdownTimer = setInterval(() => {
    now.value = Date.now();
  }, 60_000);
});
onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer);
});

const displayRows = computed<BarRow[]>(() => {
  if (!entries.value.length) return [];
  const next = recommendNextUsageAccount(entries.value)?.provider;
  const accounts = (["claude", "codex"] as const).map((provider): BarRow => {
    const name = provider === "claude" ? "Claude" : "Codex";
    const entry = entries.value.find((item) => item.provider === provider);
    const selected = entry && !entry.unavailable ? selectPacingWindow(entry.windows, entry.checkedAt) : undefined;
    if (!selected) {
      const hasAlternate = entry?.otherAccounts?.some(
        (account) => account.status === "separate-login" && !account.identityUnknown && account.windows?.length,
      );
      return {
        provider,
        name,
        period: "",
        intent: hasAlternate ? "See other logins" : "Unavailable",
        hasAlternate,
        tone: "neutral",
        chartLabel: hasAlternate
          ? `${name} usage is available for another login.`
          : entry?.unavailable || `${name} usage unavailable.`,
      };
    }
    const { window, pace } = selected;
    const scope = window.scope;
    const period =
      scope && !window.label.toLowerCase().includes(scope.toLowerCase()) ? `${window.label} · ${scope}` : window.label;
    const percent = formatQuotaPercent(window.usedPercent);
    const intent = next === provider ? "Use next" : statusText(pace.state);
    const target = pace.elapsedPercent;
    const evenPace = target === undefined ? "Even pace unavailable." : `Even pace now ${Math.round(target)}%.`;
    const credits = entry?.resetCredits?.available || undefined;
    return {
      provider,
      name,
      period,
      percent,
      intent,
      tone: toneForState(pace.state),
      used: window.usedPercent,
      pace: target,
      ...(pace.projectedUsedPercent !== undefined ? { projectedEnd: clampPercent(pace.projectedUsedPercent) } : {}),
      ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
      ...(credits ? { credits } : {}),
      chartLabel: `${name} ${period}, ${percent} used. ${evenPace}${credits ? ` ${resetCreditHeadline(credits)}.` : ""}`,
    };
  });
  if (accounts.some((row) => row.used !== undefined)) return accounts;
  const gemini = entries.value.find((item) => item.provider === "gemini" && !item.unavailable)?.windows[0];
  if (!gemini) return accounts.filter((row) => row.hasAlternate);
  const percent = `≈${formatQuotaPercent(gemini.usedPercent)}`;
  return [
    {
      provider: "gemini",
      name: "Gemini",
      period: gemini.label,
      percent,
      used: gemini.usedPercent,
      intent: "Observed",
      tone: "neutral",
      chartLabel: `Gemini ${gemini.label}, approximately ${formatQuotaPercent(gemini.usedPercent)} used.`,
    },
  ];
});
function statusText(state: keyof typeof PACE_LABEL): string {
  return state === "unknown" ? "Forecast unknown" : PACE_LABEL[state];
}
const emptyText = computed(() => (loading.value ? "Checking usage…" : "Usage unavailable"));
const accessibleSummary = computed(() => {
  const summary = displayRows.value
    .map((row) => `${row.chartLabel} ${row.used !== undefined ? row.intent : ""}`.trim())
    .join(" ");
  return `Open usage details. ${summary || emptyText.value}`;
});
</script>

<style scoped>
.usage-status-bar {
  --usage-mono: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  container-type: inline-size;
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  min-width: 0;
  min-height: 29px;
  padding: 3px 10px;
  border: 0;
  border-top: 1px solid var(--border);
  background: var(--surface-pane);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  font-size: 11px;
}
.usage-status-bar:hover {
  background: var(--surface-pane-raised);
}
.usage-status-bar:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
@media (pointer: coarse) {
  .usage-status-bar {
    min-height: calc(44px + env(safe-area-inset-bottom, 0px));
    padding-inline: max(10px, env(safe-area-inset-left, 0px)) max(10px, env(safe-area-inset-right, 0px));
    padding-bottom: calc(3px + env(safe-area-inset-bottom, 0px));
  }
}
.usage-status-bar__label,
.usage-status-bar__name {
  font-weight: 600;
}
.usage-status-bar__label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.usage-status-bar__providers,
.usage-status-bar__provider,
.usage-status-bar__heading,
.usage-status-bar__status,
.usage-status-bar__meta {
  display: flex;
  align-items: center;
  min-width: 0;
}
.usage-status-bar__providers {
  flex: 1;
}
.usage-status-bar__provider {
  gap: 7px;
}
.usage-status-bar__provider + .usage-status-bar__provider {
  border-inline-start: 1px solid var(--border);
  padding-inline-start: 14px;
  margin-inline-start: 14px;
}
.usage-status-bar__heading {
  gap: 4px;
}
.usage-status-bar__period,
.usage-status-bar__intent,
.usage-status-bar__hint,
.usage-status-bar__empty,
.usage-status-bar__reset {
  color: var(--muted);
}
.usage-status-bar__period {
  max-width: 12ch;
  overflow: hidden;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-status-bar__empty {
  display: inline-flex;
  flex: 1;
  align-items: center;
  gap: 6px;
}
.usage-status-bar__status {
  gap: 6px;
}
.usage-status-bar__intent,
.usage-status-bar__value,
.usage-status-bar__reset,
.usage-status-bar__credits {
  white-space: nowrap;
}
.usage-status-bar__value,
.usage-status-bar__reset {
  font-family: var(--usage-mono);
  font-variant-numeric: tabular-nums;
}
.usage-status-bar__reset {
  font-size: 10.5px;
}
.usage-status-bar__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c);
}
.usage-status-bar__meta {
  gap: 7px;
}
.usage-status-bar__credits {
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
  border-radius: 99px;
  font-size: 10px;
}
.usage-status-bar__chart {
  position: relative;
  flex: none;
  width: 72px;
  height: 6px;
  border-radius: 3px;
  background: rgba(var(--tint), 0.09);
}
.usage-status-bar__actual,
.usage-status-bar__projection {
  position: absolute;
  top: 0;
  bottom: 0;
}
.usage-status-bar__actual {
  left: 0;
  border-radius: 3px;
  background: var(--c);
}
.usage-status-bar__projection {
  border-radius: 0 3px 3px 0;
  background: color-mix(in srgb, var(--c) 35%, transparent);
}
.usage-status-bar__pace {
  position: absolute;
  top: -2px;
  width: 2px;
  height: 10px;
  border-radius: 1px;
  transform: translateX(-1px);
  background: var(--text);
}
.usage-status-bar__hint {
  margin-inline-start: auto;
  white-space: nowrap;
}
@container (max-width: 660px) {
  .usage-status-bar__provider {
    flex: 1;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    column-gap: 6px;
    row-gap: 2px;
  }
  .usage-status-bar__period {
    display: none;
  }
  .usage-status-bar__chart {
    width: auto;
    min-width: 24px;
  }
  .usage-status-bar__status {
    grid-column: 1 / 3;
  }
  .usage-status-bar__meta {
    justify-self: end;
  }
  .usage-status-bar__hint {
    display: none;
  }
}
@container (max-width: 440px) {
  .usage-status-bar__label {
    display: none;
  }
  .usage-status-bar__provider + .usage-status-bar__provider {
    margin-inline-start: 7px;
    padding-inline-start: 7px;
  }
}
</style>

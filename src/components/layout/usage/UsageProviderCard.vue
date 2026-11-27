<template>
  <li class="usage-card">
    <div class="usage-card__head">
      <h3 class="usage-card__name">{{ providerName(entry.provider) }}</h3>
      <span v-if="entry.account" class="usage-card__acct" :title="`${entry.account.label} (default CLI)`">
        {{ entry.account.label }} (default CLI)
      </span>
      <span v-if="!entry.unavailable && entry.windows.length && entry.provider === 'gemini'" class="usage-card__acct"
        >Observed {{ formatTime(entry.checkedAt) }}</span
      >
      <span class="usage-card__pill" :style="{ '--c': toneColor(pill.tone) }" :title="pill.title">{{ pill.text }}</span>
    </div>

    <p v-if="entry.unavailable" class="usage-card__note" role="status">{{ entry.unavailable }}</p>
    <p v-else-if="!selected" class="usage-card__note" role="status">No usage windows were returned.</p>
    <template v-else>
      <div class="usage-card__stats">
        <div class="usage-stat">
          <span class="usage-stat__v"
            >{{ approx }}{{ percentNumber(selected.window.usedPercent) }}<small>%</small></span
          >
          <span class="usage-stat__l" :title="`${selected.displayName} used`">{{ selected.displayName }} used</span>
        </div>
        <div class="usage-stat">
          <span class="usage-stat__v"
            >{{ approx }}{{ percentNumber(Math.max(0, 100 - selected.window.usedPercent)) }}<small>%</small></span
          >
          <span class="usage-stat__l">Left</span>
        </div>
        <div class="usage-stat">
          <span class="usage-stat__v">{{
            selected.window.resetsAt ? countdown(selected.window.resetsAt, now) : "—"
          }}</span>
          <span
            class="usage-stat__l"
            :title="selected.window.resetsAt ? formatTime(selected.window.resetsAt) : undefined"
            >Until reset</span
          >
        </div>
      </div>

      <template v-if="showChart && selected.pace">
        <UsageBurnChart :window="selected.window" :pace="selected.pace" :tone="selected.tone" :label="chartLabel" />
        <div class="usage-legend" :style="{ '--c': toneColor(selected.tone) }">
          <span><i />used</span>
          <span v-if="hasProjection"><i class="usage-legend__dash" />projected</span>
          <span class="usage-legend__even"><i class="usage-legend__dash" />even pace</span>
        </div>
      </template>
      <UsageMeter
        v-else
        large
        :used="selected.window.usedPercent"
        :tick="selected.pace?.elapsedPercent"
        :tone="selected.tone"
        :label="selected.ariaLabel"
      />

      <p v-if="entry.provider === 'gemini'" class="usage-card__note">{{ geminiSourceText }}</p>
      <p v-else class="usage-card__advice">{{ advice }}</p>

      <UsageResetCredits
        v-if="entry.resetCredits?.available && selected.pace && entry.provider !== 'gemini'"
        :window="selected.window"
        :pace="selected.pace"
        :credits="entry.resetCredits"
        :checked-at="entry.checkedAt"
        :now="now"
      />

      <details v-if="secondary.length" class="usage-card__more" open>
        <summary>Other windows ({{ secondary.length }})</summary>
        <div
          v-for="item in secondary"
          :key="`${entry.provider}-${item.displayName}`"
          class="usage-row"
          :style="{ '--c': toneColor(item.tone) }"
        >
          <span class="usage-row__name" :title="item.displayName">{{ item.displayName }}</span>
          <UsageMeter
            :used="item.window.usedPercent"
            :tick="item.pace?.elapsedPercent"
            :tone="item.tone"
            :label="item.ariaLabel"
          />
          <span class="usage-row__v">{{ approx }}{{ formatQuotaPercent(item.window.usedPercent) }}</span>
          <span
            class="usage-row__rs"
            :title="item.window.resetsAt ? `Resets ${formatTime(item.window.resetsAt)}` : undefined"
            >{{ item.window.resetsAt ? countdown(item.window.resetsAt, now) : "" }}</span
          >
        </div>
      </details>
    </template>

    <UsageAccounts :entry="entry" />
  </li>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { AgentUsage } from "../../../../electron/shared/agent-usage.js";
import {
  PACE_LABEL,
  adviceText,
  countdown,
  formatMoment,
  formatTime,
  presentProvider,
  providerName,
  toneColor,
  verdictText,
  type UsageTone,
} from "../../../lib/usage-advice.js";
import { formatQuotaPercent } from "../../../lib/usage-pace.js";
import UsageAccounts from "./UsageAccounts.vue";
import UsageBurnChart from "./UsageBurnChart.vue";
import UsageMeter from "./UsageMeter.vue";
import UsageResetCredits from "./UsageResetCredits.vue";

const props = defineProps<{ entry: AgentUsage; now: number; geminiSourceText: string }>();

const presentation = computed(() => presentProvider(props.entry));
const selected = computed(() => presentation.value.selected);
const secondary = computed(() => presentation.value.secondary);
const approx = computed(() => (props.entry.provider === "gemini" ? "≈" : ""));
const showChart = computed(() => props.entry.provider !== "gemini" && selected.value?.pace?.elapsedPercent != null);
const hasProjection = computed(() => selected.value?.pace?.projectedUsedPercent != null);
const advice = computed(() => (selected.value ? adviceText(selected.value, props.entry.checkedAt) : ""));
const chartLabel = computed(() => {
  const item = selected.value;
  const pace = item?.pace;
  if (!item || !pace) return "";
  const runout =
    pace.state === "slow-down" && pace.reachesLimitAt != null
      ? ` Projected to reach the limit around ${formatMoment(pace.reachesLimitAt, props.entry.checkedAt)}.`
      : "";
  return `${item.ariaLabel}${runout}`;
});
const pill = computed<{ text: string; tone: UsageTone; title?: string }>(() => {
  if (props.entry.unavailable) return { text: "Unavailable", tone: "neutral" };
  const item = selected.value;
  if (!item) return { text: "No data", tone: "neutral" };
  if (props.entry.provider === "gemini") return { text: "Approximate", tone: "neutral" };
  const state = item.pace?.state ?? "unknown";
  return {
    text: PACE_LABEL[state],
    tone: item.tone,
    title: verdictText(props.entry.provider, state, item.window.scope),
  };
});

function percentNumber(value: number): string {
  return formatQuotaPercent(value).slice(0, -1);
}
</script>

<style scoped>
.usage-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(var(--tint), 0.03);
  list-style: none;
}
.usage-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.usage-card__name {
  flex: none;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}
.usage-card__acct {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-card__pill {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 99px;
  background: color-mix(in srgb, var(--c) 14%, transparent);
  color: var(--text);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  white-space: nowrap;
}
.usage-card__pill::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c);
}
.usage-card__stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.usage-stat {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.usage-stat__v {
  font-family: var(--usage-mono, monospace);
  font-size: 18px;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
  white-space: nowrap;
}
.usage-stat__v small {
  margin-left: 2px;
  color: var(--muted);
  font-size: 11px;
}
.usage-stat__l {
  overflow: hidden;
  color: var(--muted);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.usage-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--muted);
  font-size: 10px;
}
.usage-legend i {
  display: inline-block;
  width: 14px;
  height: 0;
  margin-right: 4px;
  border-top: 2px solid var(--c);
  vertical-align: middle;
}
.usage-legend .usage-legend__dash {
  border-top-style: dashed;
}
.usage-legend__even i {
  border-top-color: var(--muted);
}
.usage-card__advice,
.usage-card__note {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
}
.usage-card__note {
  color: var(--muted);
}
.usage-card__more {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 7px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 10.5px;
}
.usage-card__more summary {
  margin-bottom: 6px;
  cursor: pointer;
}
.usage-row {
  display: grid;
  grid-template-columns: minmax(56px, 84px) minmax(0, 1fr) 42px 52px;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.usage-row__name {
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-row__v,
.usage-row__rs {
  font-family: var(--usage-mono, monospace);
  text-align: right;
  white-space: nowrap;
}
.usage-row__v {
  color: var(--text);
}
@media (pointer: coarse) {
  .usage-card__more summary {
    display: flex;
    align-items: center;
    min-height: 44px;
  }
}
</style>

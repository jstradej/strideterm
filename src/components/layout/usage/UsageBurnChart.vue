<template>
  <div class="usage-chart" :style="{ '--c': toneColor(tone) }">
    <div class="usage-chart__plot">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" :aria-label="label">
        <line class="usage-chart__grid usage-chart__grid--edge" x1="0" y1="0" x2="100" y2="0" />
        <line class="usage-chart__grid" x1="0" y1="50" x2="100" y2="50" />
        <line class="usage-chart__grid usage-chart__grid--edge" x1="0" y1="100" x2="100" y2="100" />
        <rect
          v-if="layout.runoutX != null"
          class="usage-chart__zone"
          :x="layout.runoutX"
          y="0"
          :width="100 - layout.runoutX"
          height="100"
        />
        <line class="usage-chart__even" x1="0" y1="100" x2="100" y2="0" />
        <path class="usage-chart__area" :d="`M0 100 L${layout.nowX} ${layout.usedY} L${layout.nowX} 100 Z`" />
        <line class="usage-chart__used" x1="0" y1="100" :x2="layout.nowX" :y2="layout.usedY" />
        <line
          v-if="layout.projection"
          class="usage-chart__projection"
          :x1="layout.nowX"
          :y1="layout.usedY"
          :x2="layout.projection.x"
          :y2="layout.projection.y"
        />
        <line class="usage-chart__now" :x1="layout.nowX" y1="0" :x2="layout.nowX" y2="100" />
      </svg>
      <span class="usage-chart__dot" :style="{ left: `${layout.nowX}%`, top: `${layout.usedY}%` }" />
      <span
        v-if="layout.runoutX != null"
        class="usage-chart__dot usage-chart__dot--limit"
        :style="{ left: `${layout.runoutX}%`, top: '0%' }"
      />
      <span
        v-if="layout.flagX != null && layout.runoutAt != null"
        class="usage-chart__flag"
        :style="{ left: `${layout.flagX}%`, top: '0%' }"
      >
        limit ~{{ formatMoment(layout.runoutAt, layout.nowAt) }}
      </span>
      <span
        class="usage-chart__value"
        :class="`usage-chart__value--${layout.labelPlacement}`"
        :style="{ left: `${layout.nowX}%`, top: `${layout.usedY}%` }"
      >
        {{ usedText }}
      </span>
      <span class="usage-chart__ylab">100%</span>
    </div>
    <div class="usage-chart__axis" aria-hidden="true">
      <span class="usage-chart__axis-start">{{ axisTime(layout.startAt) }}</span>
      <span v-if="layout.showNowAxisLabel" class="usage-chart__axis-now" :style="{ left: `${layout.nowX}%` }">now</span>
      <span class="usage-chart__axis-end">reset {{ axisTime(layout.resetAt) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { UsageWindow } from "../../../../electron/shared/agent-usage.js";
import { formatMoment, toneColor, type UsageTone } from "../../../lib/usage-advice.js";
import { burnChartLayout } from "../../../lib/usage-chart.js";
import { formatQuotaPercent, type UsagePace } from "../../../lib/usage-pace.js";

const props = defineProps<{
  window: UsageWindow;
  pace: UsagePace;
  tone: UsageTone;
  label: string;
}>();

const layout = computed(() => burnChartLayout(props.window, props.pace)!);
const usedText = computed(() => formatQuotaPercent(props.window.usedPercent));
const shortWindow = computed(() => (props.window.durationMinutes ?? 0) <= 36 * 60);
function axisTime(value: number): string {
  return new Intl.DateTimeFormat(
    undefined,
    shortWindow.value ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" },
  ).format(value);
}
</script>

<style scoped>
.usage-chart {
  padding-top: 16px;
  font-family: var(--usage-mono, monospace);
}
.usage-chart__plot {
  position: relative;
}
.usage-chart svg {
  display: block;
  width: 100%;
  height: 92px;
  overflow: visible;
}
.usage-chart line,
.usage-chart path {
  vector-effect: non-scaling-stroke;
}
.usage-chart__grid {
  stroke: rgba(var(--tint), 0.06);
  stroke-width: 1;
}
.usage-chart__grid--edge {
  stroke: rgba(var(--tint), 0.12);
}
.usage-chart__zone {
  fill: color-mix(in srgb, var(--danger) 9%, transparent);
}
.usage-chart__even {
  stroke: var(--muted);
  stroke-width: 1.5;
  stroke-dasharray: 3 3;
}
.usage-chart__area {
  fill: var(--c);
  fill-opacity: 0.14;
}
.usage-chart__used,
.usage-chart__projection {
  stroke: var(--c);
  stroke-width: 2;
  stroke-linecap: round;
}
.usage-chart__projection {
  stroke-dasharray: 4 3;
  stroke-opacity: 0.7;
}
.usage-chart__now {
  stroke: var(--text);
  stroke-opacity: 0.35;
  stroke-width: 1;
}
.usage-chart__dot {
  position: absolute;
  width: 9px;
  height: 9px;
  margin: -4.5px 0 0 -4.5px;
  border-radius: 50%;
  background: var(--c);
  box-shadow: 0 0 0 2px var(--surface-pane);
}
.usage-chart__dot--limit {
  background: var(--danger);
}
.usage-chart__flag,
.usage-chart__value {
  position: absolute;
  color: var(--text);
  font-size: 9.5px;
  white-space: nowrap;
}
.usage-chart__flag {
  transform: translate(-50%, -100%);
  padding-bottom: 5px;
}
.usage-chart__value--above {
  transform: translate(-50%, -100%);
  padding-bottom: 7px;
}
.usage-chart__value--right {
  transform: translate(0, -50%);
  padding-left: 9px;
}
.usage-chart__value--left {
  transform: translate(-100%, -50%);
  padding-right: 9px;
}
.usage-chart__ylab {
  position: absolute;
  top: 0;
  right: 0;
  transform: translateY(-100%);
  padding-bottom: 2px;
  color: var(--muted);
  font-size: 9px;
}
.usage-chart__axis {
  position: relative;
  height: 12px;
  margin-top: 4px;
  color: var(--muted);
  font-size: 9.5px;
}
.usage-chart__axis span {
  position: absolute;
  white-space: nowrap;
}
.usage-chart__axis-start {
  left: 0;
}
.usage-chart__axis-end {
  right: 0;
}
.usage-chart__axis-now {
  transform: translateX(-50%);
}
</style>

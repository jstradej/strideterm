<template>
  <div
    ref="rootEl"
    class="sparkline-host"
    @pointermove="onPointerMove"
    @pointerdown="onPointerDown"
    @pointerleave="onPointerLeave"
    @pointercancel="onPointerLeave"
  >
    <svg
      class="sparkline"
      :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`"
      preserveAspectRatio="none"
      role="img"
      :aria-label="ariaLabel"
    >
      <!-- Grid -->
      <line v-for="g in gridLines" :key="g" class="sparkline__grid" :x1="0" :x2="VIEW_W" :y1="g" :y2="g" />
      <!-- Fill area under the curve -->
      <path v-if="areaPath" class="sparkline__fill" :d="areaPath" :fill="fill" />
      <!-- Line -->
      <path v-if="linePath" class="sparkline__line" :d="linePath" :stroke="stroke" fill="none" />
      <!-- Last value marker (only when not hovering, so it doesn't fight the
           hover dot for the same pixel). -->
      <circle
        v-if="lastPoint && hoverIndex === null"
        class="sparkline__dot"
        :cx="lastPoint.x"
        :cy="lastPoint.y"
        r="2.5"
        :fill="stroke"
      />
      <!-- Hover guide + dot -->
      <template v-if="hoverPoint && hoverIndex !== null">
        <line
          class="sparkline__guide"
          :x1="hoverPoint.x"
          :x2="hoverPoint.x"
          :y1="0"
          :y2="VIEW_H"
          :stroke="stroke"
        />
        <circle class="sparkline__dot" :cx="hoverPoint.x" :cy="hoverPoint.y" r="3.5" :fill="stroke" />
      </template>
      <!-- Empty state -->
      <text v-if="data.length === 0" class="sparkline__empty-text" :x="VIEW_W / 2" :y="VIEW_H / 2 + 4">
        collecting samples…
      </text>
    </svg>

    <!-- Tooltip: HTML overlay so we can style with native fonts/padding rather
         than hand-rolling SVG <text> + <rect>. Positioned in CSS pixels via
         the host element's bounding rect, so the floating box stays crisp
         even though the SVG itself stretches via preserveAspectRatio=none. -->
    <div v-if="tooltip" class="sparkline__tooltip" :style="tooltipStyle" role="status">
      <span class="sparkline__tooltip-value">{{ tooltip.label }}</span>
      <span v-if="tooltip.subLabel" class="sparkline__tooltip-sub">{{ tooltip.subLabel }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    data: number[];
    max: number;
    stroke: string;
    fill: string;
    ariaLabel?: string;
    /**
     * Function that turns a raw sample (already clamped to [0, max]) into the
     * primary tooltip line. Default: `<value.toFixed(1)>%` since this component
     * is currently only used for percentage history.
     */
    valueFormatter?: (value: number) => string;
    /**
     * Seconds between samples. Used to compute the "Ns ago" sub-label in the
     * tooltip — newest sample is "0s ago", oldest is `(n - 1) * interval` ago.
     * 0 / unset hides the sub-label.
     */
    sampleIntervalSec?: number;
  }>(),
  {
    ariaLabel: "history sparkline",
    valueFormatter: (v: number) => `${v.toFixed(1)}%`,
    sampleIntervalSec: 0,
  },
);

const VIEW_W = 200;
const VIEW_H = 60;
const PAD = 2;

const gridLines = [VIEW_H * 0.25, VIEW_H * 0.5, VIEW_H * 0.75];

const rootEl = ref<HTMLElement | null>(null);
const hoverIndex = ref<number | null>(null);

const points = computed<Array<{ x: number; y: number }>>(() => {
  const n = props.data.length;
  if (n === 0) return [];
  // If only one sample, render it at the right edge so it doesn't ghost
  // across the chart as a flat line.
  if (n === 1) {
    const v = clamp(props.data[0], 0, props.max);
    return [{ x: VIEW_W - PAD, y: yFor(v) }];
  }
  // Spread the available samples evenly. Right-anchored: newest sample at
  // VIEW_W - PAD, oldest near 0. Once n >= VIEW_W/2 we run out of horizontal
  // resolution but lines just compress, which is the desired "scrolling" look.
  const step = (VIEW_W - 2 * PAD) / Math.max(1, n - 1);
  return props.data.map((raw, i) => ({
    x: PAD + i * step,
    y: yFor(clamp(raw, 0, props.max)),
  }));
});

const linePath = computed(() => {
  if (points.value.length === 0) return "";
  return points.value.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
});

const areaPath = computed(() => {
  if (points.value.length === 0) return "";
  const first = points.value[0];
  const last = points.value[points.value.length - 1];
  return (
    `M${first.x.toFixed(2)},${VIEW_H} ` +
    points.value.map((p) => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ") +
    ` L${last.x.toFixed(2)},${VIEW_H} Z`
  );
});

const lastPoint = computed(() => points.value[points.value.length - 1] ?? null);

const hoverPoint = computed(() => {
  if (hoverIndex.value === null) return null;
  return points.value[hoverIndex.value] ?? null;
});

interface Tooltip {
  label: string;
  subLabel: string;
  leftPx: number;
  topPx: number;
}

/**
 * Tooltip data + CSS position. Computed from the hovered sample's index, then
 * resolved to pixel offsets via the host element's bounding rect so the
 * floating box anchors on the actual rendered point (not the SVG viewport).
 */
const tooltip = ref<Tooltip | null>(null);

const tooltipStyle = computed(() => {
  if (!tooltip.value) return {};
  return { left: tooltip.value.leftPx + "px", top: tooltip.value.topPx + "px" };
});

function yFor(v: number): number {
  const norm = v / props.max;
  return VIEW_H - PAD - norm * (VIEW_H - 2 * PAD);
}

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function indexNearestX(svgX: number): number | null {
  const n = props.data.length;
  if (n === 0) return null;
  if (n === 1) return 0;
  const step = (VIEW_W - 2 * PAD) / (n - 1);
  const raw = (svgX - PAD) / step;
  const idx = Math.round(raw);
  return Math.max(0, Math.min(n - 1, idx));
}

function buildTooltip(idx: number, hostRect: DOMRect): Tooltip {
  const value = clamp(props.data[idx], 0, props.max);
  const label = props.valueFormatter(value);
  // Newest sample is at the right; data[length-1] = newest = "now". The age of
  // sample idx is (length - 1 - idx) * interval.
  const stepsBack = props.data.length - 1 - idx;
  const secAgo = stepsBack * (props.sampleIntervalSec || 0);
  const subLabel = props.sampleIntervalSec > 0 ? (secAgo === 0 ? "now" : `${secAgo}s ago`) : "";
  // Map the sample's SVG-space x onto the rendered host width.
  const p = points.value[idx];
  const xRatio = p.x / VIEW_W;
  const yRatio = p.y / VIEW_H;
  // Clamp inside the host so the tooltip stays visible at the edges. 6px gap
  // above the data point.
  const tipLeft = clamp(xRatio * hostRect.width, 30, hostRect.width - 30);
  const tipTop = Math.max(0, yRatio * hostRect.height - 30);
  return { label, subLabel, leftPx: tipLeft, topPx: tipTop };
}

function syncTooltip(svgX: number): void {
  const idx = indexNearestX(svgX);
  if (idx === null || !rootEl.value) {
    hoverIndex.value = null;
    tooltip.value = null;
    return;
  }
  hoverIndex.value = idx;
  tooltip.value = buildTooltip(idx, rootEl.value.getBoundingClientRect());
}

function pointerSvgX(evt: PointerEvent): number {
  if (!rootEl.value) return 0;
  const rect = rootEl.value.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  // Map client coords back into SVG-space x using viewBox width.
  return ((evt.clientX - rect.left) / rect.width) * VIEW_W;
}

function onPointerMove(e: PointerEvent): void {
  // Skip hover-style updates for fingers — touchstart/down already wired up.
  if (e.pointerType === "touch" && e.buttons === 0 && !e.isPrimary) return;
  syncTooltip(pointerSvgX(e));
}

function onPointerDown(e: PointerEvent): void {
  // For touch, treat the initial tap as the hover. We don't capture the
  // pointer — the user can drag a finger across to scrub through samples and
  // pointermove keeps firing because the SVG is fixed in place.
  syncTooltip(pointerSvgX(e));
}

function onPointerLeave(): void {
  hoverIndex.value = null;
  tooltip.value = null;
}
</script>

<style scoped>
.sparkline-host {
  position: relative;
  width: 100%;
  /* Reserve the same vertical space as the SVG so absolute-positioned tooltip
     coords resolve against the actual chart area. */
  height: 60px;
}

.sparkline {
  display: block;
  width: 100%;
  height: 60px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 4px;
  touch-action: none; /* swipe-on-chart updates the tooltip; don't scroll the page */
}

.sparkline__grid {
  stroke: rgba(255, 255, 255, 0.05);
  stroke-width: 1;
  stroke-dasharray: 2 2;
}

.sparkline__line {
  fill: none;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.sparkline__guide {
  stroke-width: 1;
  stroke-opacity: 0.5;
  stroke-dasharray: 3 3;
  pointer-events: none;
}

.sparkline__empty-text {
  fill: var(--text-dim, #888);
  font-size: 10px;
  text-anchor: middle;
  font-style: italic;
}

.sparkline__tooltip {
  position: absolute;
  transform: translate(-50%, -100%);
  background: rgba(20, 20, 22, 0.95);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-primary, #e2e8f0);
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  white-space: nowrap;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 1px;
  z-index: 5;
}

.sparkline__tooltip-value {
  font-weight: 600;
  line-height: 1.2;
}

.sparkline__tooltip-sub {
  color: var(--text-dim, #888);
  font-size: 10px;
  line-height: 1.2;
}
</style>

import type { UsageWindow } from "../../electron/shared/agent-usage.js";
import { clampPercent } from "./usage-advice.js";
import type { UsagePace } from "./usage-pace.js";

const EDGE_PERCENT = 14;
const FLAG_MIN_PERCENT = 16;
const FLAG_MAX_PERCENT = 74;

export interface BurnChartLayout {
  /** Window start to reset, 0 to 100. */
  nowX: number;
  /** Percent from the top of the plot, so 100 % used is 0. */
  usedY: number;
  startAt: number;
  nowAt: number;
  resetAt: number;
  projection?: { x: number; y: number; hitsLimit: boolean };
  runoutX?: number;
  runoutAt?: number;
  flagX?: number;
  labelPlacement: "above" | "right" | "left";
  showNowAxisLabel: boolean;
}

function labelPlacement(nowX: number, used: number): BurnChartLayout["labelPlacement"] {
  if (used > 86 && nowX >= EDGE_PERCENT) return "left";
  if (nowX < EDGE_PERCENT || used < EDGE_PERCENT) return nowX > 100 - 2 * EDGE_PERCENT ? "left" : "right";
  return "above";
}

/** Only the window start and the current reading are real; nothing between them is drawn. */
export function burnChartLayout(window: UsageWindow, pace: UsagePace): BurnChartLayout | undefined {
  if (pace.elapsedPercent == null || window.durationMinutes == null || window.resetsAt == null) return undefined;
  const durationMs = window.durationMinutes * 60_000;
  const startAt = window.resetsAt - durationMs;
  const nowX = clampPercent(pace.elapsedPercent);
  const used = clampPercent(window.usedPercent);
  let projection: BurnChartLayout["projection"];
  let runoutX: number | undefined;
  if (pace.state === "slow-down" && pace.reachesLimitAt != null) {
    runoutX = clampPercent(((pace.reachesLimitAt - startAt) / durationMs) * 100);
    projection = { x: runoutX, y: 0, hitsLimit: true };
  } else if (pace.projectedUsedPercent != null) {
    projection = { x: 100, y: 100 - clampPercent(pace.projectedUsedPercent), hitsLimit: false };
  }
  return {
    nowX,
    usedY: 100 - used,
    startAt,
    nowAt: startAt + (nowX / 100) * durationMs,
    resetAt: window.resetsAt,
    ...(projection ? { projection } : {}),
    ...(runoutX != null && pace.reachesLimitAt != null
      ? {
          runoutX,
          runoutAt: pace.reachesLimitAt,
          flagX: Math.min(FLAG_MAX_PERCENT, Math.max(FLAG_MIN_PERCENT, runoutX)),
        }
      : {}),
    labelPlacement: labelPlacement(nowX, used),
    showNowAxisLabel: nowX > EDGE_PERCENT && nowX < 100 - EDGE_PERCENT,
  };
}

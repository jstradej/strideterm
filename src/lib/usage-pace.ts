import type { AgentUsage, UsageResetCredits, UsageWindow } from "../../electron/shared/agent-usage.js";

export type UsagePaceState = "exhausted" | "slow-down" | "on-track" | "use-more" | "early" | "unknown";

export interface UsagePace {
  state: UsagePaceState;
  elapsedPercent?: number;
  /** Linear projection of current use through the full window; intentionally not capped. */
  projectedUsedPercent?: number;
  reachesLimitAt?: number;
  /** Percentage points per day still available to use before reset. */
  targetPerDay?: number;
}

const MIN_SAMPLE_FRACTION = 0.05;
const MIN_SAMPLE_MS = 6 * 60 * 60_000;
const INITIAL_TOLERANCE_POINTS = 10;
const MIN_TOLERANCE_POINTS = 2;
const MATERIAL_EARLY_USE_PERCENT = 20;

export function assessUsagePace(window: UsageWindow, checkedAt: number): UsagePace {
  const { usedPercent: used, durationMinutes, resetsAt } = window;
  if (
    !Number.isFinite(used) ||
    used < 0 ||
    used > 100 ||
    !Number.isFinite(checkedAt) ||
    (window.rounded && used === 100) ||
    (resetsAt !== undefined && (!Number.isFinite(resetsAt) || resetsAt <= checkedAt))
  ) {
    return { state: "unknown" };
  }
  const withoutTiming: UsagePace = { state: used === 100 ? "exhausted" : "unknown" };
  if (
    durationMinutes === undefined ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0 ||
    resetsAt === undefined
  )
    return withoutTiming;
  const durationMs = durationMinutes * 60_000;
  const startAt = resetsAt - durationMs;
  const elapsedMs = checkedAt - startAt;
  const elapsedFraction = elapsedMs / durationMs;
  if (!Number.isFinite(elapsedFraction) || elapsedFraction < 0 || elapsedFraction >= 1) return withoutTiming;

  const elapsedPercent = elapsedFraction * 100;
  if (used === 100) return { state: "exhausted", elapsedPercent };
  const targetPerDay = ((100 - used) * 86_400_000) / (resetsAt - checkedAt);
  const stats = { elapsedPercent, targetPerDay };
  const sampleIsEnough = elapsedMs >= Math.min(durationMs * MIN_SAMPLE_FRACTION, MIN_SAMPLE_MS);

  // Permit a strong signal before the minimum sample, but avoid amplifying a
  // tiny percentage into an alarming projection from only a few minutes.
  if (elapsedMs === 0 || (!sampleIsEnough && used < MATERIAL_EARLY_USE_PERCENT)) return { state: "early", ...stats };

  const projectedUsedPercent = used / elapsedFraction;
  // A few points are easy to spread across a fresh week, but can represent
  // most of the remaining budget on its last day. Keep a floor for rounding.
  const tolerance = Math.max(MIN_TOLERANCE_POINTS, INITIAL_TOLERANCE_POINTS * (1 - elapsedFraction));
  if (projectedUsedPercent >= 100 + tolerance) {
    const reachesLimitAt = startAt + durationMs * (100 / projectedUsedPercent);
    return { state: "slow-down", ...stats, projectedUsedPercent, reachesLimitAt };
  }
  if (projectedUsedPercent <= 100 - tolerance) {
    return { state: "use-more", ...stats, projectedUsedPercent };
  }
  return { state: "on-track", ...stats, projectedUsedPercent };
}

/** Pick a binding quota window without adding usage across independent pools. */
export function selectPacingWindow(
  windows: UsageWindow[],
  checkedAt: number,
): { window: UsageWindow; pace: UsagePace } | undefined {
  const active = windows.filter(
    (window) => window.resetsAt === undefined || (Number.isFinite(window.resetsAt) && window.resetsAt > checkedAt),
  );
  if (active.length === 0) return undefined;

  // Account-wide budgets govern general advice. Scoped windows only compete
  // with one another when no account-wide row was returned.
  const unscoped = active.filter((window) => !window.scope);
  const candidates = unscoped.length ? unscoped : active;
  const assessed = candidates.map((window) => ({ window, pace: assessUsagePace(window, checkedAt) }));
  // A just-reset window has too little data to steer anything, so it yields to
  // any window with a forecast. Early states never hold material usage.
  const riskRank: Record<UsagePaceState, number> = {
    exhausted: 0,
    "slow-down": 1,
    unknown: 2,
    "on-track": 3,
    "use-more": 4,
    early: 5,
  };
  assessed.sort((a, b) => {
    const rankDiff = riskRank[a.pace.state] - riskRank[b.pace.state];
    if (rankDiff) return rankDiff;

    if (a.pace.state === "slow-down") {
      const timeA = a.pace.reachesLimitAt ?? Infinity;
      const timeB = b.pace.reachesLimitAt ?? Infinity;
      if (timeA !== timeB) return timeA - timeB;
    }
    if (a.pace.state === "use-more") {
      const projectionA = a.pace.projectedUsedPercent ?? -Infinity;
      const projectionB = b.pace.projectedUsedPercent ?? -Infinity;
      if (projectionA !== projectionB) return projectionB - projectionA;
    }

    // Prefer the shorter known reset period when risk is otherwise equal.
    const durationA = a.window.durationMinutes ?? Infinity;
    const durationB = b.window.durationMinutes ?? Infinity;
    if (durationA !== durationB) return durationA - durationB;
    return b.window.usedPercent - a.window.usedPercent;
  });
  return assessed[0];
}

/** Suggest switching only when the two account-wide forecasts clearly favor it. */
export function recommendNextUsageAccount(entries: AgentUsage[]) {
  const accounts = (["claude", "codex"] as const).flatMap((provider) => {
    const entry = entries.find((item) => item.provider === provider);
    if (!entry || entry.unavailable) return [];
    const selected = selectPacingWindow(entry.windows, entry.checkedAt);
    return selected && !selected.window.scope ? [{ provider, ...selected }] : [];
  });
  const spare = accounts.find(({ pace }) => pace.state === "use-more");
  const constrained = accounts.find(({ pace }) => pace.state === "slow-down" || pace.state === "exhausted");
  if (spare && constrained) {
    return {
      provider: spare.provider,
      otherProvider: constrained.provider,
      window: constrained.window,
      exhausted: constrained.pace.state === "exhausted",
    };
  }
}

export type ResetCreditAdviceState = "use-now" | "at-limit-later" | "wait-for-reset" | "keep";

export interface ResetCreditAdvice {
  state: ResetCreditAdviceState;
  available: number;
  nextExpiresAt?: number;
  /** Credits that expire before this window resets on its own. */
  expiringBeforeReset: number;
}

const RESET_WORTH_PERCENT = 90;
const RESET_MIN_TIME_LEFT_MS = 6 * 60 * 60_000;

/**
 * A reset recovers what has been used so far, so it is worth spending only near
 * the limit while real time remains in the window. Nothing here assumes how a
 * provider applies the reset to the window's timing.
 */
export function adviseResetCredit(
  window: UsageWindow,
  pace: UsagePace,
  credits: UsageResetCredits | undefined,
  checkedAt: number,
): ResetCreditAdvice | undefined {
  if (!credits || credits.available <= 0) return undefined;
  const { resetsAt } = window;
  const live = credits.expiresAt.filter((value) => value > checkedAt);
  const base = {
    available: credits.available,
    ...(live.length ? { nextExpiresAt: live[0] } : {}),
    expiringBeforeReset: resetsAt === undefined ? 0 : live.filter((value) => value < resetsAt).length,
  };
  const timeLeft = resetsAt === undefined ? Infinity : resetsAt - checkedAt;
  if (pace.state === "exhausted" || window.usedPercent >= RESET_WORTH_PERCENT) {
    return { state: timeLeft >= RESET_MIN_TIME_LEFT_MS ? "use-now" : "wait-for-reset", ...base };
  }
  if (pace.state === "slow-down") return { state: "at-limit-later", ...base };
  return { state: "keep", ...base };
}

const percentFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function formatQuotaPercent(value: number): string {
  const rounded = Number(value.toFixed(2));
  if (value > 0 && rounded === 0) return "<0.01%";
  if (value < 100 && rounded === 100) return ">99.99%";
  return `${percentFormatter.format(value)}%`;
}

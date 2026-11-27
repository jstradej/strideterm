import type { AgentUsage, UsageWindow } from "../../electron/shared/agent-usage.js";
import {
  assessUsagePace,
  formatQuotaPercent,
  selectPacingWindow,
  type ResetCreditAdvice,
  type UsagePace,
  type UsagePaceState,
} from "./usage-pace.js";

export type UsageProvider = AgentUsage["provider"];
export type UsageTone = "good" | "warning" | "danger" | "neutral";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const PACE_LABEL: Record<UsagePaceState, string> = {
  exhausted: "Exhausted",
  "slow-down": "Slow down",
  "use-more": "Room to use",
  "on-track": "On pace",
  early: "Too early",
  unknown: "No data",
};

const TONE_COLOR: Record<UsageTone, string> = {
  good: "var(--success)",
  warning: "var(--status-paused)",
  danger: "var(--danger)",
  neutral: "var(--muted)",
};

export function toneForState(state?: UsagePaceState): UsageTone {
  if (state === "slow-down") return "warning";
  if (state === "exhausted") return "danger";
  if (state === "use-more" || state === "on-track") return "good";
  return "neutral";
}

export function toneColor(tone: UsageTone): string {
  return TONE_COLOR[tone];
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function providerName(provider: UsageProvider): string {
  return provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : "Gemini CLI";
}

export function formatEstimate(value: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 }).format(value)}%`;
}

export function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

/** A weekday and time for moments within the coming days, a date and time beyond that. */
export function formatMoment(value: number, now: number): string {
  const soon = Math.abs(value - now) < 6 * DAY;
  return new Intl.DateTimeFormat(
    undefined,
    soon
      ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  ).format(value);
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return `${days}d ${hours}h`;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

export function countdown(value: number, now: number): string {
  return formatDuration(value - now);
}

export function usageText(value: number, provider: UsageProvider): string {
  const percent = formatQuotaPercent(value);
  if (provider === "gemini") return `≈${percent} used`;
  return value >= 100 ? `Limit reached — ${percent} used` : `${percent} used`;
}

export function withoutScope(label: string, scope: string): string {
  const index = label.toLowerCase().indexOf(scope.toLowerCase());
  if (index < 0) return label;
  return (label.slice(0, index) + label.slice(index + scope.length)).replace(/[·\s()[\]–—:]+/g, " ").trim();
}

export interface PresentedWindow {
  window: UsageWindow;
  pace?: UsagePace;
  displayName: string;
  shortName: string;
  tone: UsageTone;
  ariaLabel: string;
}

export interface ProviderPresentation {
  selected?: PresentedWindow;
  secondary: PresentedWindow[];
}

function presentWindow(entry: AgentUsage, window: UsageWindow): PresentedWindow {
  const pace = entry.provider === "gemini" ? undefined : assessUsagePace(window, entry.checkedAt);
  const containsScope = window.scope && window.label.toLocaleLowerCase().includes(window.scope.toLocaleLowerCase());
  const displayName = window.scope && !containsScope ? `${window.scope} · ${window.label}` : window.label;
  const elapsed = pace?.elapsedPercent;
  return {
    window,
    pace,
    displayName,
    shortName: window.scope ? withoutScope(window.label, window.scope) : window.label,
    tone: toneForState(pace?.state),
    ariaLabel: `${providerName(entry.provider)} ${displayName}: ${usageText(window.usedPercent, entry.provider)}${elapsed == null ? ". Even pace unavailable." : `. Even pace now ${formatEstimate(elapsed)}.`}`,
  };
}

export function presentProvider(entry: AgentUsage): ProviderPresentation {
  const items = entry.windows.map((window) => presentWindow(entry, window));
  const raw = entry.provider === "gemini" ? undefined : selectPacingWindow(entry.windows, entry.checkedAt);
  const selected = raw ? items.find((item) => item.window === raw.window) : items[0];
  return { selected, secondary: items.filter((item) => item !== selected) };
}

/** Short title for a status pill, naming the provider and the scope when there is one. */
export function verdictText(provider: UsageProvider, state: UsagePaceState, scope?: string): string {
  const name = provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Gemini";
  const scoped = scope ? ` (${scope})` : "";
  switch (state) {
    case "exhausted":
      return `${name} quota exhausted${scoped}`;
    case "slow-down":
      return `Slow down on ${name}${scoped}`;
    case "use-more":
      return `Use more ${name}${scoped}`;
    case "on-track":
      return `${name} on track${scoped}`;
    case "early":
      return `Too early to forecast ${name}${scoped}`;
    default:
      return `${name} forecast unavailable${scoped}`;
  }
}

export interface PaceRates {
  unit: "hour" | "day" | "rest";
  /** What can still be spent per unit; for `rest` the whole remaining quota. */
  budget: string;
  /** The user's average since the window began, per unit; never for `rest`. */
  user?: string;
}

/** Hourly rates for short windows, a plain remainder in the last hour, daily rates otherwise. */
export function paceRates(window: UsageWindow, pace: UsagePace, checkedAt: number): PaceRates | undefined {
  if (pace.targetPerDay == null) return undefined;
  const remainingMs = window.resetsAt == null ? Infinity : window.resetsAt - checkedAt;
  if (remainingMs < HOUR) return { unit: "rest", budget: formatEstimate(Math.max(0, 100 - window.usedPercent)) };
  const unit =
    remainingMs <= DAY || (window.durationMinutes != null && window.durationMinutes <= 12 * 60) ? "hour" : "day";
  const perUnit = unit === "hour" ? 24 : 1;
  const elapsedDays =
    pace.elapsedPercent != null && window.durationMinutes != null
      ? ((pace.elapsedPercent / 100) * window.durationMinutes * MINUTE) / DAY
      : 0;
  const user =
    pace.state !== "early" && pace.state !== "exhausted" && elapsedDays > 0
      ? `${formatEstimate(window.usedPercent / elapsedDays / perUnit)}/${unit}`
      : undefined;
  return { unit, budget: `${formatEstimate(pace.targetPerDay / perUnit)}/${unit}`, ...(user ? { user } : {}) };
}

/** One short paragraph: where the user's own pace leads and what budget would last until reset. */
export function adviceText(item: PresentedWindow, checkedAt: number): string {
  const { window, pace, displayName } = item;
  if (!pace || pace.state === "unknown") return `A forecast is unavailable for ${displayName}.`;
  if (pace.state === "exhausted")
    return `${displayName} is exhausted at ${formatQuotaPercent(window.usedPercent)} used.`;
  if (pace.state === "early") return "Too little elapsed time for a steady estimate.";
  const rates = paceRates(window, pace, checkedAt);
  const mine = rates?.user ? ` at your pace (${rates.user})` : "";
  const budget = !rates
    ? ""
    : rates.unit === "rest"
      ? ` Available until reset: ${rates.budget} of quota.`
      : pace.state === "slow-down"
        ? ` To last, keep to ${rates.budget}.`
        : ` You can spend ${rates.budget} until reset.`;
  if (pace.state === "slow-down") {
    const when =
      pace.reachesLimitAt == null ? "before reset" : `around ${formatMoment(pace.reachesLimitAt, checkedAt)}`;
    const early =
      pace.reachesLimitAt != null && window.resetsAt != null
        ? `, ${formatDuration(window.resetsAt - pace.reachesLimitAt)} before it resets`
        : "";
    return `${rates?.user ? `At your pace (${rates.user})` : "At this pace"} this quota would run out ${when}${early}.${budget}`;
  }
  if (pace.state === "use-more" && pace.projectedUsedPercent != null) {
    return `About ${formatEstimate(Math.max(0, 100 - pace.projectedUsedPercent))} of this quota would go unused${mine}.${budget}`;
  }
  return `${rates?.user ? `Your pace (${rates.user})` : "Your pace"} is on track to use this quota by reset.${budget}`;
}

export function resetCreditHeadline(available: number): string {
  return `${available} ${available === 1 ? "reset" : "resets"} available`;
}

/** What to do with the credits. Says nothing about how a reset changes the window's timing. */
export function resetAdviceText(advice: ResetCreditAdvice, window: UsageWindow, pace: UsagePace, now: number): string {
  const used = formatQuotaPercent(window.usedPercent);
  const left = window.resetsAt == null ? undefined : countdown(window.resetsAt, now);
  let verdict: string;
  switch (advice.state) {
    case "use-now":
      verdict = `Worth using now: it recovers about ${used} used${left ? `, with ${left} left until reset` : ""}.`;
      break;
    case "wait-for-reset":
      verdict = `This window resets on its own${left ? ` in ${left}` : " soon"}, so keep the reset.`;
      break;
    case "at-limit-later":
      verdict = `At this pace you hit the limit${pace.reachesLimitAt != null ? ` around ${formatMoment(pace.reachesLimitAt, now)}` : ""}; a reset is worth it then.`;
      break;
    default:
      verdict = `Not worth using now: it would recover only ${used}.`;
  }
  const expiry =
    advice.expiringBeforeReset > 0
      ? ` ${advice.expiringBeforeReset} expire before this window resets${advice.nextExpiresAt != null ? ` (next ${formatMoment(advice.nextExpiresAt, now)})` : ""}.`
      : advice.nextExpiresAt != null
        ? ` Next one expires ${formatMoment(advice.nextExpiresAt, now)}.`
        : "";
  return `${verdict}${expiry}`;
}

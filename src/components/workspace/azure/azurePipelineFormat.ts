/**
 * Shared formatting helpers for the Azure Pipelines table + detail panel.
 *
 * Extracted from the former AzurePipelineRow so the flat table (AzurePipelinesTab)
 * and the master-detail panel (AzurePipelineDetailPanel) render status icons,
 * relative times and durations identically.
 */

export interface StatusVisual {
  icon: string;
  cls: string;
  label: string;
}

/** Map an Azure status/state + result pair to an icon, css class and label. */
export function statusVisual(statusOrState: unknown, result: unknown): StatusVisual {
  const s = String(statusOrState || "").toLowerCase();
  const r = String(result || "").toLowerCase();
  if (s === "completed") {
    if (r === "succeeded") return { icon: "✓", cls: "ok", label: "Succeeded" };
    if (r === "partiallysucceeded") return { icon: "!", cls: "warn", label: "Partially succeeded" };
    if (r === "failed") return { icon: "✗", cls: "fail", label: "Failed" };
    if (r === "canceled") return { icon: "⊘", cls: "canceled", label: "Canceled" };
    if (r === "skipped") return { icon: "–", cls: "pending", label: "Skipped" };
    return { icon: "✓", cls: "ok", label: "Completed" };
  }
  if (s === "inprogress") return { icon: "●", cls: "running", label: "Running" };
  if (s === "notstarted" || s === "postponed" || s === "pending") return { icon: "○", cls: "pending", label: "Queued" };
  if (s === "cancelling" || s === "canceling") return { icon: "●", cls: "canceled", label: "Cancelling" };
  return { icon: "○", cls: "none", label: String(statusOrState || "—") };
}

/**
 * Sort rank for the status column: in-flight first, then failures, then the
 * rest — so the table's default "what needs attention" ordering is useful.
 * Lower = higher in the list when sorting ascending.
 */
export function statusRank(statusOrState: unknown, result: unknown): number {
  const v = statusVisual(statusOrState, result);
  switch (v.cls) {
    case "running":
      return 0;
    case "fail":
      return 1;
    case "warn":
      return 2;
    case "pending":
      return 3;
    case "canceled":
      return 4;
    case "ok":
      return 5;
    default:
      return 6;
  }
}

/** A run/build is in progress until Azure marks it "completed". */
export function isRunning(stateOrStatus: string | undefined): boolean {
  const s = String(stateOrStatus || "").toLowerCase();
  return !!s && s !== "completed";
}

export function stripRef(ref: unknown): string {
  return String(ref || "").replace(/^refs\/heads\//, "");
}

export function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 8) : "";
}

export function formatRelative(dateStr?: string): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (Number.isNaN(diff)) return "";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatDuration(start?: string, finish?: string): string {
  if (!start) return "";
  const s = new Date(start).getTime();
  const e = finish ? new Date(finish).getTime() : Date.now();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return "";
  let sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  sec %= 60;
  if (m < 60) return sec ? `${m}m ${sec}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Duration in milliseconds, for sorting (0 when unknown). */
export function durationMs(start?: string, finish?: string): number {
  if (!start) return 0;
  const s = new Date(start).getTime();
  const e = finish ? new Date(finish).getTime() : Date.now();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0;
  return e - s;
}

export function formatFull(dateStr?: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

/**
 * `formatRelative` below that switches to a view-specific fallback once the
 * age crosses `thresholdMs` — shared by views that need "just now / Xm ago /
 * Xh ago" up to a point, then something else (an absolute date, "Xw ago", …).
 */
export function formatRelativeUntil(
  dateStr: string | undefined,
  thresholdMs: number,
  fallback: (dateStr: string) => string,
): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (Number.isNaN(diff)) return "";
  if (diff < thresholdMs) return formatRelative(dateStr);
  return fallback(dateStr);
}

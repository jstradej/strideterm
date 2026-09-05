import { APP_CONFIG } from "../../config/app-config.js";
import { isCompanionPrimaryViewId } from "../../electron/shared/companion-primary.js";
import type { StatePayload } from "../../electron/shared/types/state.js";
import { isInputBlockingKind } from "../../electron/shared/attention-kinds.js";

interface AttentionAlert {
  title?: string;
  kind?: string;
  exitCode?: number;
  at?: string;
}

interface AttentionLike {
  count?: number;
  alerts?: AttentionAlert[];
  latestAt?: string;
}

interface ContainerLike {
  State?: string;
  Status?: string;
}

export function safeColor(value: unknown): string {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || "")) ? String(value) : APP_CONFIG.ui.defaultProjectColor;
}

export function normalizeAbsoluteUrl(value: unknown): string {
  if (!value) {
    return "";
  }

  try {
    return new URL(String(value)).toString();
  } catch {
    return "";
  }
}

export function preferredRemoteUrl({ urls = [] as string[], tunnelUrl = "", customPublicUrl = "" } = {}): string {
  const normalizedCustom = normalizeAbsoluteUrl(customPublicUrl);
  if (normalizedCustom) {
    return normalizedCustom;
  }

  if (tunnelUrl) {
    return tunnelUrl;
  }

  const privateUrl = urls.find((url) => /:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url));
  return privateUrl || urls[0] || "";
}

export function withRemoteToken(value: unknown, token: string, profileId = ""): string {
  const normalized = normalizeAbsoluteUrl(value);
  if (!normalized) {
    return "";
  }

  try {
    const url = new URL(normalized);
    if (token) {
      url.searchParams.set("token", token);
    }
    if (profileId) {
      url.searchParams.set("profileId", profileId);
    }
    return url.toString();
  } catch {
    return "";
  }
}

export function summarizeRemoteHost(url: string): string {
  if (!url) {
    return "Unavailable";
  }

  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function openTerminalLink(event: { preventDefault?: () => void } | null | undefined, uri: string): void {
  event?.preventDefault?.();

  try {
    const url = new URL(uri);
    if (!["http:", "https:"].includes(url.protocol)) {
      return;
    }

    const href = url.toString();
    if (window.strideterm?.openExternal) {
      window.strideterm.openExternal(href);
    } else {
      window.open(href, "_blank", "noopener,noreferrer");
    }
  } catch {
    // Ignore malformed links from terminal output.
  }
}

export function downloadTextFile(filename: string, content: string, mime = "text/plain;charset=utf-8"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function safeFilenamePart(value: unknown, fallback = "terminal"): string {
  const normalized = String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return normalized || fallback;
}

export function shortcutTabDirection(event: KeyboardEvent): number {
  const key = String(event?.key || "");
  const code = String(event?.code || "");
  if (key === "PageDown" || key === "Next" || code === "PageDown") return 1;
  if (key === "PageUp" || key === "Prior" || code === "PageUp") return -1;
  return 0;
}

export function getWindowsPtyOptions(
  payload: StatePayload | null | undefined,
): { backend: string; buildNumber: number } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const windowsPty = (payload?.environment?.windowsPty as any) ?? null;
  if (!windowsPty?.backend || !Number.isInteger(windowsPty.buildNumber)) {
    return null;
  }

  return {
    backend: windowsPty.backend as string,
    buildNumber: windowsPty.buildNumber as number,
  };
}

export function makeNewProfile(name: string): { id: string; name: string; color: string; workspaceIds: string[] } {
  return { id: `profile-${crypto.randomUUID()}`, name, color: "#ffa424", workspaceIds: [] };
}

export function isContainerRunning(container: ContainerLike | null | undefined): boolean {
  const state = String(container?.State || "").toLowerCase();
  const status = String(container?.Status || "").toLowerCase();
  return state === "running" || status.startsWith("up ");
}

export function isGitViewId(value: unknown): boolean {
  return String(value || "").startsWith("git:");
}

export function isDockerViewId(value: unknown): boolean {
  return String(value || "").startsWith("docker:");
}

export function isBrowserViewId(value: unknown): boolean {
  return String(value || "").startsWith("browser:");
}

export function isAzureViewId(value: unknown): boolean {
  return String(value || "").startsWith("azure:");
}

export function isGitHubViewId(value: unknown): boolean {
  return String(value || "").startsWith("github:");
}

export function isReviewViewId(value: unknown): boolean {
  return String(value || "").startsWith("review:");
}

export function isFilesViewId(value: unknown): boolean {
  return String(value || "").startsWith("files:");
}

export function isTaskDashboardViewId(value: unknown): boolean {
  return String(value || "").startsWith("task-dashboard:");
}

/**
 * Classify a workspace view id into the pane type a cell renders — the single
 * source of truth shared by WorkspaceCell.vue (which pane to mount) and
 * useAttentionSync.ts (which terminals the remote client actually streams).
 * Mirrors WorkspaceCell's `activeViewType` fallthrough exactly: the special
 * pane kinds are matched by id prefix, a headless-copilot judge panel resolves
 * to "headless-judge" (needs the workspace's live task-runner state, so it is
 * NOT a streaming terminal), and everything else is a live terminal session.
 */
export function classifyViewType(
  viewId: string | null | undefined,
  workspaceId: string | null | undefined,
  payload: StatePayload | null | undefined,
): string {
  if (!viewId) return "";
  if (isGitViewId(viewId)) return "git";
  if (isDockerViewId(viewId)) return "docker";
  if (isAzureViewId(viewId)) return "azure";
  if (isGitHubViewId(viewId)) return "github";
  if (isReviewViewId(viewId)) return "review";
  if (isFilesViewId(viewId)) return "files";
  if (isTaskDashboardViewId(viewId)) return "task-dashboard";
  if (isBrowserViewId(viewId)) return "browser";
  // The relocated Companion Primary is a real terminal rendered under a
  // virtual view id. Classified before the headless-judge probe below, whose
  // panel-id extraction would read the task workspace id out of the alias.
  if (isCompanionPrimaryViewId(viewId)) return "terminal";
  if (workspaceId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskState = (payload as any)?.taskRunner?.[workspaceId];
    if (taskState?.judgeExecutionMode === "headless-copilot") {
      const panelId = viewId.includes(":") ? viewId.split(":").pop() : viewId;
      if (panelId === taskState.judgePanelId) return "headless-judge";
    }
  }
  return "terminal";
}

export function attentionTitle(attention: AttentionLike | null | undefined): string {
  if (!attention?.count) {
    return "";
  }

  const latest = attention.alerts?.[0] || null;
  const latestTitle = latest?.title ? `Latest: ${latest.title}` : "Terminal attention";
  // A `question` is the strongest input-blocking state there is, so it must
  // never fall through to the "finished task" branch below — a permission
  // prompt described as "1 finished terminal task" is worse than no tooltip.
  if (isInputBlockingKind(latest?.kind)) {
    return `${attention.count} terminal ${attention.count === 1 ? "needs" : "need"} input. ${latestTitle}`;
  }
  const exitCode = Number.isInteger(latest?.exitCode) ? ` (exit ${latest?.exitCode})` : "";
  return `${attention.count} finished terminal ${attention.count === 1 ? "task" : "tasks"}. ${latestTitle}${exitCode}`;
}

export function isFreshAttention(attention: AttentionLike | null | undefined): boolean {
  if (!attention?.latestAt) {
    return false;
  }

  const latestAt = new Date(attention.latestAt).getTime();
  return Number.isFinite(latestAt) && Date.now() - latestAt < 12000;
}

export function tabAttentionTitle(alert: AttentionAlert | null | undefined): string {
  if (!alert) {
    return "";
  }

  if (alert.kind === "question") {
    return `${alert.title || "Terminal"} is asking a question.`;
  }

  if (isInputBlockingKind(alert.kind)) {
    return `${alert.title || "Terminal"} is waiting for input.`;
  }

  const exitCode = Number.isInteger(alert.exitCode) ? ` (exit ${alert.exitCode})` : "";
  return `${alert.title || "Terminal"} needs attention${exitCode}.`;
}

export function isFreshAlert(alert: AttentionAlert | null | undefined): boolean {
  if (!alert?.at) {
    return false;
  }

  const at = new Date(alert.at).getTime();
  return Number.isFinite(at) && Date.now() - at < 12000;
}

export function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem("strideterm-sidebar-collapsed") === "1";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem("strideterm-sidebar-collapsed", value ? "1" : "0");
  } catch {
    // Ignore localStorage failures in restricted browser contexts.
  }
}

export function readMobileInputBarCollapsed(): boolean {
  try {
    return window.localStorage.getItem("strideterm-mobile-input-collapsed") === "1";
  } catch {
    return false;
  }
}

export function writeMobileInputBarCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem("strideterm-mobile-input-collapsed", value ? "1" : "0");
  } catch {
    // Ignore localStorage failures in restricted browser contexts.
  }
}

export function readSidebarWidth(): number | null {
  try {
    const raw = window.localStorage.getItem("strideterm-sidebar-width");
    if (!raw) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 180 && value <= 1200 ? value : null;
  } catch {
    return null;
  }
}

export function writeSidebarWidth(value: number): void {
  try {
    window.localStorage.setItem("strideterm-sidebar-width", String(value));
  } catch {
    // Ignore localStorage failures in restricted browser contexts.
  }
}

/**
 * Performance panel refresh interval (ms). Panel-local like the dock width —
 * it is a per-client UI preference, deliberately NOT part of authoritative
 * runtime state or the settings store (the diagnostics feature never touches
 * persisted state or state broadcasts). Clamped to a sane polling range.
 */
export function readPerfRefreshInterval(): number {
  try {
    const raw = window.localStorage.getItem("strideterm-perf-refresh-ms");
    if (!raw) return 2000;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 1000 && value <= 30000 ? value : 2000;
  } catch {
    return 2000;
  }
}

export function writePerfRefreshInterval(value: number): void {
  try {
    window.localStorage.setItem("strideterm-perf-refresh-ms", String(value));
  } catch {
    // Ignore localStorage failures in restricted browser contexts.
  }
}

export function readNotificationDockWidth(): number | null {
  try {
    const raw = window.localStorage.getItem("strideterm-notif-dock-width");
    if (!raw) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 200 && value <= 1200 ? value : null;
  } catch {
    return null;
  }
}

export function writeNotificationDockWidth(value: number): void {
  try {
    window.localStorage.setItem("strideterm-notif-dock-width", String(value));
  } catch {
    // Ignore localStorage failures in restricted browser contexts.
  }
}

/**
 * How many whole days ago `d` was, counted in local calendar days rather than
 * elapsed hours — 23:59 and 00:01 are a day apart even though the clock says
 * two minutes.
 */
function calendarDaysAgo(d: Date): number {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((today - target) / 86400000);
}

/**
 * Grouping key for a history list's day separators. Two entries share a band
 * exactly when they belong under the same heading, so a list can emit one
 * separator per change of key.
 */
export function dayBandKey(d: Date): string {
  const diffDays = calendarDaysAgo(d);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `weekday-${d.getDay()}`;
  return `date-${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** The heading itself: Today · Yesterday · a weekday name · an explicit date. */
export function dayBandLabel(d: Date): string {
  const diffDays = calendarDaysAgo(d);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

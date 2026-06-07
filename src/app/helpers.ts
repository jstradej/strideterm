import { APP_CONFIG } from "../../config/app-config.js";
import type { StatePayload } from "../../electron/shared/types/state.js";

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

interface DockerContextEntry {
  Current?: string;
  [key: string]: unknown;
}

interface ContainerLike {
  State?: string;
  Status?: string;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
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

export function currentDockerContext(contexts: DockerContextEntry[] = []): DockerContextEntry | null {
  return (
    contexts.find((context) => {
      const marker = String(context.Current || "")
        .trim()
        .toLowerCase();
      return marker === "*" || marker === "true";
    }) ||
    contexts[0] ||
    null
  );
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

export function isUrlCommand(value: unknown): boolean {
  const cmd = String(value || "").trim();
  return /^https?:\/\//i.test(cmd);
}

export function attentionTitle(attention: AttentionLike | null | undefined): string {
  if (!attention?.count) {
    return "";
  }

  const latest = attention.alerts?.[0] || null;
  const latestTitle = latest?.title ? `Latest: ${latest.title}` : "Terminal attention";
  if (latest?.kind === "waiting") {
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

  if (alert.kind === "waiting") {
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

import { APP_CONFIG } from "../../config/app-config.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeColor(value) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || "")) ? value : APP_CONFIG.ui.defaultProjectColor;
}

export function normalizeAbsoluteUrl(value) {
  if (!value) {
    return "";
  }

  try {
    return new URL(value).toString();
  } catch {
    return "";
  }
}

export function preferredRemoteUrl({ urls = [], tunnelUrl = "", customPublicUrl = "" } = {}) {
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

export function withRemoteToken(value, token) {
  const normalized = normalizeAbsoluteUrl(value);
  if (!normalized) {
    return "";
  }

  try {
    const url = new URL(normalized);
    if (token) {
      url.searchParams.set("token", token);
    }
    return url.toString();
  } catch {
    return "";
  }
}

export function summarizeRemoteHost(url) {
  if (!url) {
    return "Unavailable";
  }

  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function openTerminalLink(event, uri) {
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

export function downloadTextFile(filename, content) {
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

export function safeFilenamePart(value, fallback = "terminal") {
  const normalized = String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return normalized || fallback;
}

export function getWindowsPtyOptions(payload) {
  const windowsPty = payload?.environment?.windowsPty;
  if (!windowsPty?.backend || !Number.isInteger(windowsPty.buildNumber)) {
    return null;
  }

  return {
    backend: windowsPty.backend,
    buildNumber: windowsPty.buildNumber,
  };
}

export function currentDockerContext(contexts = []) {
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

export function isContainerRunning(container) {
  const state = String(container?.State || "").toLowerCase();
  const status = String(container?.Status || "").toLowerCase();
  return state === "running" || status.startsWith("up ");
}

export function isGitViewId(value) {
  return String(value || "").startsWith("git:");
}

export function isDockerViewId(value) {
  return String(value || "").startsWith("docker:");
}

export function isBrowserViewId(value) {
  return String(value || "").startsWith("browser:");
}

export function isAzureViewId(value) {
  return String(value || "").startsWith("azure:");
}

export function isGitHubViewId(value) {
  return String(value || "").startsWith("github:");
}

export function isReviewViewId(value) {
  return String(value || "").startsWith("review:");
}

export function isFilesViewId(value) {
  return String(value || "").startsWith("files:");
}

export function isTaskDashboardViewId(value) {
  return String(value || "").startsWith("task-dashboard:");
}

export function isUrlCommand(value) {
  const cmd = String(value || "").trim();
  return /^https?:\/\//i.test(cmd);
}

export function attentionTitle(attention) {
  if (!attention?.count) {
    return "";
  }

  const latest = attention.alerts?.[0] || null;
  const latestTitle = latest?.title ? `Latest: ${latest.title}` : "Terminal attention";
  if (latest?.kind === "waiting") {
    return `${attention.count} terminal ${attention.count === 1 ? "needs" : "need"} input. ${latestTitle}`;
  }
  const exitCode = Number.isInteger(latest?.exitCode) ? ` (exit ${latest.exitCode})` : "";
  return `${attention.count} finished terminal ${attention.count === 1 ? "task" : "tasks"}. ${latestTitle}${exitCode}`;
}

export function isFreshAttention(attention) {
  if (!attention?.latestAt) {
    return false;
  }

  const latestAt = new Date(attention.latestAt).getTime();
  return Number.isFinite(latestAt) && Date.now() - latestAt < 12000;
}

export function tabAttentionTitle(alert) {
  if (!alert) {
    return "";
  }

  if (alert.kind === "waiting") {
    return `${alert.title || "Terminal"} is waiting for input.`;
  }

  const exitCode = Number.isInteger(alert.exitCode) ? ` (exit ${alert.exitCode})` : "";
  return `${alert.title || "Terminal"} needs attention${exitCode}.`;
}

export function isFreshAlert(alert) {
  if (!alert?.at) {
    return false;
  }

  const at = new Date(alert.at).getTime();
  return Number.isFinite(at) && Date.now() - at < 12000;
}

export function readSidebarCollapsed() {
  try {
    return window.localStorage.getItem("strideterm-sidebar-collapsed") === "1";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(value) {
  try {
    window.localStorage.setItem("strideterm-sidebar-collapsed", value ? "1" : "0");
  } catch {
    // Ignore localStorage failures in restricted browser contexts.
  }
}

export function readSidebarWidth() {
  try {
    const raw = window.localStorage.getItem("strideterm-sidebar-width");
    if (!raw) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 180 && value <= 500 ? value : null;
  } catch {
    return null;
  }
}

export function writeSidebarWidth(value) {
  try {
    window.localStorage.setItem("strideterm-sidebar-width", String(value));
  } catch {
    // Ignore localStorage failures in restricted browser contexts.
  }
}

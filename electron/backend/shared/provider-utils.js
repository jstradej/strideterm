import { createHash } from "node:crypto";
import { access } from "node:fs/promises";

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function sanitizePathSegment(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

export function trimTrailingSlash(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

export function normalizeReviewRoot(value, defaultRoot) {
  return trimTrailingSlash(value || defaultRoot);
}

export function stripRefsPrefix(value) {
  return String(value || "").replace(/^refs\/heads\//, "");
}

export function parseDate(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function toIsoOrNull(timestamp) {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

export function firstNonEmpty(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

export function normalizeRemoteUrl(value) {
  return trimTrailingSlash(
    String(value || "")
      .trim()
      .replace(/\.git$/i, ""),
  ).toLowerCase();
}

export function shortPathKey(value, fallback = "item") {
  const normalized = sanitizePathSegment(value, fallback).toLowerCase();
  const digest = createHash("sha1")
    .update(String(value || fallback))
    .digest("hex")
    .slice(0, 10);
  const prefix = normalized.slice(0, 8).replace(/^-|-$/g, "") || fallback;
  return `${prefix}-${digest}`;
}

export async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function createEmptySnapshot() {
  return {
    connections: [],
    inbox: {
      needsMyReview: [],
      myPullRequests: [],
      recentlyUpdated: [],
      needsAttention: [],
    },
    trackedPullRequests: {},
    pullRequests: {},
    reviewActivity: [],
    sync: {
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
    },
  };
}

export function extractErrorText(error) {
  return firstNonEmpty(error?.stderr, error?.stdout, error?.error?.message, error?.message, String(error || ""));
}

export function formatReviewWorkspaceError(error, reviewRoot, providerLabel = "connection") {
  const text = extractErrorText(error);
  if (!text) return "";

  if (/filename too long|unable to create file|could not reset index file to revision 'HEAD'/i.test(text)) {
    const example = process.platform === "win32" ? "C:\\pr" : "~/pr";
    return [
      "Review workspace could not be created because some checkout paths are too long.",
      `Current review root: ${reviewRoot}`,
      `Use a much shorter Review root in the ${providerLabel} settings, for example ${example}, then try Review again.`,
    ].join("\n");
  }

  if (/empty string is not a valid path/i.test(text)) {
    return [
      "Review workspace could not be created because the checkout path was empty.",
      `Check the ${providerLabel} Review root and retry.`,
    ].join("\n");
  }

  return "";
}

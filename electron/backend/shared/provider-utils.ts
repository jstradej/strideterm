/// <reference types="node" />
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function sanitizePathSegment(value: unknown, fallback = "unknown"): string {
  const normalized = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

export function trimTrailingSlash(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

export function normalizeReviewRoot(value: unknown, defaultRoot: string): string {
  return trimTrailingSlash(value || defaultRoot);
}

export function stripRefsPrefix(value: unknown): string {
  return String(value || "").replace(/^refs\/heads\//, "");
}

export function parseDate(value: unknown): number {
  const timestamp = new Date((value as string | number | Date) || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function toIsoOrNull(timestamp: number | null | undefined): string | null {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

export function firstNonEmpty(...values: unknown[]): string {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

export function normalizeRemoteUrl(value: unknown): string {
  return trimTrailingSlash(
    String(value || "")
      .trim()
      .replace(/\.git$/i, ""),
  ).toLowerCase();
}

export function shortPathKey(value: unknown, fallback = "item"): string {
  const normalized = sanitizePathSegment(value, fallback).toLowerCase();
  const digest = createHash("sha1")
    .update(String(value || fallback))
    .digest("hex")
    .slice(0, 10);
  const prefix = normalized.slice(0, 8).replace(/^-|-$/g, "") || fallback;
  return `${prefix}-${digest}`;
}

export async function exists(targetPath: string): Promise<boolean> {
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

export function extractErrorText(error: unknown): string {
  const e = error as
    { stderr?: unknown; stdout?: unknown; error?: { message?: unknown }; message?: unknown } | null | undefined;
  return firstNonEmpty(e?.stderr, e?.stdout, e?.error?.message, e?.message, String(error || ""));
}

/**
 * Shape used by `dedupePrSummaries`. Both Azure and GitHub PR summaries
 * satisfy this — we type-parameterise so the helper returns the input shape.
 */
export interface PrSummaryDedupShape {
  orgUrl?: string;
  repository?: { id?: string };
  pullRequest?: { id?: string | number };
  hasAttention?: boolean;
  role?: string;
  lastActivityAt?: string | null;
  prKey?: string;
}

/**
 * Collapse PR summaries that point at the same canonical PR but came from
 * different connections. Triggered when the user has multiple connections
 * with access to the same Azure DevOps / GitHub org — without dedup, each
 * connection's poll appends its own copy and the inbox shows the same PR
 * N times.
 *
 * Canonical key = `${orgUrl}|${repository.id}|${pullRequest.id}`. When
 * duplicates collide, we keep the entry with the strongest signal so the
 * surviving row is the most useful one for the user:
 *   1. `hasAttention === true` wins (something needs the user's action)
 *   2. role rank: reviewer > author > other > unknown
 *   3. fresher `lastActivityAt` wins
 *
 * Entries we can't form a canonical key for (missing repo / PR id) are
 * kept under a synthetic key so they never get silently dropped.
 */
export function dedupePrSummaries<T extends PrSummaryDedupShape>(summaries: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const summary of summaries) {
    const orgUrl = summary.orgUrl || "";
    const repoId = summary.repository?.id || "";
    const prId = summary.pullRequest?.id != null ? String(summary.pullRequest.id) : "";
    if (!repoId || !prId) {
      byKey.set(`__nokey__${summary.prKey || byKey.size}`, summary);
      continue;
    }
    const key = `${orgUrl}|${repoId}|${prId}`;
    const existing = byKey.get(key);
    if (!existing || comparePrSummariesForDedup(summary, existing) > 0) {
      byKey.set(key, summary);
    }
  }
  return Array.from(byKey.values());
}

function comparePrSummariesForDedup(a: PrSummaryDedupShape, b: PrSummaryDedupShape): number {
  if (!!a.hasAttention !== !!b.hasAttention) return a.hasAttention ? 1 : -1;
  const rank = (r?: string): number => (r === "reviewer" ? 3 : r === "author" ? 2 : r === "other" ? 1 : 0);
  const diff = rank(a.role) - rank(b.role);
  if (diff !== 0) return diff;
  const ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
  const tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
  return ta - tb;
}

export function formatReviewWorkspaceError(error: unknown, reviewRoot: string, providerLabel = "connection"): string {
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

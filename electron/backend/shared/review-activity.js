/**
 * Shared helpers for detecting and emitting "review activity" delta events.
 *
 * Both AzureDevOpsManager.sync() and GitHubManager.sync() use these helpers to
 * compare a freshly-built PR summary against the persisted tracked state and
 * emit notification events (`pr-new`, `pr-new-comment`, `pr-vote-changed`,
 * `pr-source-updated`, `pr-merge-status-changed`).
 *
 * Self-filtering (don't notify the user about their own actions) is the
 * caller's responsibility — they pass an `isSelf(identity)` predicate.
 *
 * The `lastNotifiedActivityAt` timestamp is persisted per tracked PR so that
 * repeated polls don't re-fire events and app restarts don't replay history.
 * On a connection's first sync in a given process run, all PRs are baselined
 * silently (seed `lastNotifiedActivityAt` to current remote activity) to avoid
 * a flood of notifications when the user opens the app.
 */

import { parseDate } from "./provider-utils.js";

/** Maximum retained events in snapshot.reviewActivity (rolling window). */
export const MAX_REVIEW_ACTIVITY = 100;

/** Truncate comment text to a reasonable length for a notification body. */
export function truncateBody(text, max = 140) {
  const trimmed = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Build a single review activity event. Callers supply a provider-specific
 * title/body; the rest of the shape is unified so the renderer can render
 * both Azure and GitHub events the same way.
 */
export function buildReviewActivityEvent({
  provider,
  summary,
  kind,
  at,
  title,
  body,
  actor = null,
  urgency = "normal",
}) {
  return {
    id: `${summary.prKey}:${kind}:${at}`,
    prKey: summary.prKey,
    provider,
    connectionId: summary.connectionId,
    kind,
    at,
    title,
    body,
    role: summary.role || "observer",
    urgency,
    repositoryName: summary.repository?.fullName || summary.repository?.name || "",
    pullRequestNumber: summary.pullRequest?.number ?? summary.pullRequest?.id ?? 0,
    pullRequestTitle: summary.pullRequest?.title || "",
    webUrl: summary.pullRequest?.webUrl || "",
    reviewWorkspaceId: summary.reviewWorkspaceId || "",
    existingWorkspaceId: summary.existingWorkspaceId || "",
    actor,
  };
}

/**
 * Prepend new events to the rolling activity log and cap length.
 */
export function appendReviewActivity(previous, newEvents) {
  if (!newEvents || newEvents.length === 0) return previous || [];
  return [...newEvents, ...(previous || [])].slice(0, MAX_REVIEW_ACTIVITY);
}

/**
 * Parse an Azure vote signature of shape "id:vote:declined|id:vote:declined|…"
 * into a Map<id, "vote:declined"> for per-reviewer diffing.
 */
export function parseAzureVoteSignature(signature) {
  const map = new Map();
  if (!signature) return map;
  for (const entry of String(signature).split("|")) {
    const [id, vote, declined] = entry.split(":");
    if (!id) continue;
    map.set(id, `${vote || 0}:${declined || 0}`);
  }
  return map;
}

/**
 * Parse a GitHub review state signature of shape
 * "login:state:isRequested|…" into Map<login, "state:requested">.
 */
export function parseGitHubReviewSignature(signature) {
  const map = new Map();
  if (!signature) return map;
  for (const entry of String(signature).split("|")) {
    const [login, state, requested] = entry.split(":");
    if (!login) continue;
    map.set(login, `${state || ""}:${requested || 0}`);
  }
  return map;
}

/**
 * Diff two signature maps. Returns the list of keys whose entry differs,
 * optionally excluding a "self" key.
 */
export function diffSignatureKeys(prevMap, currMap, selfKey = "") {
  const changed = [];
  const seen = new Set();
  for (const key of currMap.keys()) {
    seen.add(key);
    if (selfKey && key === selfKey) continue;
    if (prevMap.get(key) !== currMap.get(key)) changed.push(key);
  }
  for (const key of prevMap.keys()) {
    if (seen.has(key)) continue;
    if (selfKey && key === selfKey) continue;
    changed.push(key);
  }
  return changed;
}

/**
 * Decide whether this is the very first sync for a connection in the current
 * process. If so, seed every PR's `lastNotifiedActivityAt` silently and return
 * `true` so the caller can skip event emission.
 *
 * `seededConnections` is a Set mutated in-place across sync calls.
 */
export function shouldSeedConnection(seededConnections, connectionId) {
  return !seededConnections.has(connectionId);
}

/**
 * Compute the baseline `lastNotifiedActivityAt` for a PR being seen for the
 * first time (either a brand-new PR on the remote, or the first sync of its
 * connection in this process run).
 */
export function seedNotifiedTimestamp(summary, fallback) {
  return summary.lastRemoteActivityAt || fallback;
}

/**
 * Given a list of comments (with `author` + `publishedDate`/`lastUpdatedDate`
 * or `created_at`/`updated_at`), return only those by non-self authors that
 * occurred strictly after `sinceIsoString`.
 *
 * The `authorKey(author)` function lets the caller decide how to extract the
 * comparable identity (Azure uses identity object, GitHub uses login string).
 */
export function filterNewComments({ comments, sinceIsoString, isSelf, getTimestamp, getAuthor }) {
  const sinceMs = parseDate(sinceIsoString);
  return comments.filter((comment) => {
    const ts = parseDate(getTimestamp(comment));
    if (!(ts > sinceMs)) return false;
    const author = getAuthor(comment);
    return !isSelf(author);
  });
}

/**
 * Build a connection-error event when status transitions into "error" or when
 * the error message changes. Returns `null` when no event should fire — that
 * happens on startup with a pre-existing, unchanged error (we already told
 * the user last session) and on repeated polls with the same failure.
 */
export function buildConnectionErrorEvent({ provider, connection, prevState, currentStatus, currentError, at }) {
  if (currentStatus !== "error") return null;
  const prevStatus = prevState?.status || "idle";
  const prevError = prevState?.lastError || "";
  const errorText = String(currentError || "Sync failed").trim();
  // Only fire when the error is new: either status crossed into "error" from
  // anything else, or the error text differs from what was already persisted.
  const transitioned = prevStatus !== "error";
  const messageChanged = prevStatus === "error" && prevError !== errorText;
  if (!transitioned && !messageChanged) return null;

  const label = connection.label || connection.id || "connection";
  return {
    id: `conn:${connection.id}:connection-error:${at}`,
    // Stable pseudo-prKey so the renderer groups repeated errors from the
    // same connection into a single session rather than spawning a new one.
    prKey: `connection:${connection.id}`,
    provider,
    connectionId: connection.id,
    kind: "connection-error",
    at,
    title: `${label}: connection error`,
    body: truncateBody(errorText),
    role: "observer",
    urgency: "normal",
    repositoryName: label,
    pullRequestNumber: 0,
    pullRequestTitle: "",
    webUrl: "",
    reviewWorkspaceId: "",
    existingWorkspaceId: "",
    actor: null,
  };
}

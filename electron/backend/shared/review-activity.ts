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

interface ReviewSummaryRef {
  prKey: string;
  connectionId?: string;
  // Profile that owns the PR's connection. The frontend stamps each session
  // with this so a window viewing profile B doesn't toast / sound / dock
  // events from profile A — without it the composables fall back to "active
  // profile" when the workspace lookup fails (deleted workspace, race), and
  // the event leaks into the wrong profile.
  profileId?: string;
  role?: string;
  repository?: { fullName?: string; name?: string };
  pullRequest?: { number?: number; id?: number; title?: string; webUrl?: string };
  reviewWorkspaceId?: string;
  existingWorkspaceId?: string;
  lastRemoteActivityAt?: string | null;
}

interface ConnectionRef {
  id: string;
  label?: string;
  profileId?: string;
}

interface ConnectionState {
  status?: string;
  lastError?: string;
}

/** Maximum retained events in snapshot.reviewActivity (rolling window). */
export const MAX_REVIEW_ACTIVITY = 100;

/** Truncate comment text to a reasonable length for a notification body. */
export function truncateBody(text: unknown, max = 140): string {
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
}: {
  provider: string;
  summary: ReviewSummaryRef;
  kind: string;
  at: string;
  title: string;
  body: string;
  actor?: unknown;
  urgency?: string;
}): {
  id: string;
  prKey: string;
  provider: string;
  connectionId: string | undefined;
  profileId: string;
  kind: string;
  at: string;
  title: string;
  body: string;
  role: string;
  urgency: string;
  repositoryName: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  webUrl: string;
  reviewWorkspaceId: string;
  existingWorkspaceId: string;
  actor: unknown;
} {
  return {
    id: `${summary.prKey}:${kind}:${at}`,
    prKey: summary.prKey,
    provider,
    connectionId: summary.connectionId,
    // Stamp authoritatively from the summary (sourced from the PR's
    // connection.profileId — see azure/github managers). Empty string means
    // the backend didn't supply one; the composables treat that as
    // "unknown" and drop the event rather than guessing the active profile.
    profileId: summary.profileId || "",
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
export function appendReviewActivity(
  previous: unknown[] | undefined | null,
  newEvents: unknown[] | undefined | null,
): unknown[] {
  if (!newEvents || newEvents.length === 0) return previous || [];
  return [...newEvents, ...(previous || [])].slice(0, MAX_REVIEW_ACTIVITY);
}

/**
 * Parse an Azure vote signature of shape "id:vote:declined|id:vote:declined|…"
 * into a Map<id, "vote:declined"> for per-reviewer diffing.
 */
export function parseAzureVoteSignature(signature: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
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
export function parseGitHubReviewSignature(signature: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
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
export function diffSignatureKeys(prevMap: Map<string, string>, currMap: Map<string, string>, selfKey = ""): string[] {
  const changed: string[] = [];
  const seen = new Set<string>();
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
export function shouldSeedConnection(seededConnections: Set<string>, connectionId: string): boolean {
  return !seededConnections.has(connectionId);
}

/**
 * Compute the baseline `lastNotifiedActivityAt` for a PR being seen for the
 * first time (either a brand-new PR on the remote, or the first sync of its
 * connection in this process run).
 */
export function seedNotifiedTimestamp(summary: ReviewSummaryRef, fallback: string | null): string | null {
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
export function filterNewComments<TComment, TAuthor>({
  comments,
  sinceIsoString,
  isSelf,
  getTimestamp,
  getAuthor,
}: {
  comments: TComment[];
  sinceIsoString: string | null | undefined;
  isSelf: (author: TAuthor) => boolean;
  getTimestamp: (comment: TComment) => unknown;
  getAuthor: (comment: TComment) => TAuthor;
}): TComment[] {
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
export function buildConnectionErrorEvent({
  provider,
  connection,
  prevState,
  currentStatus,
  currentError,
  at,
}: {
  provider: string;
  connection: ConnectionRef;
  prevState: ConnectionState | null | undefined;
  currentStatus: string;
  currentError: unknown;
  at: string;
}): {
  id: string;
  prKey: string;
  provider: string;
  connectionId: string;
  profileId: string;
  kind: string;
  at: string;
  title: string;
  body: string;
  role: string;
  urgency: string;
  repositoryName: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  webUrl: string;
  reviewWorkspaceId: string;
  existingWorkspaceId: string;
  actor: null;
} | null {
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
    // Connection errors belong to the profile that owns the connection —
    // without it the renderer would have to guess (and currently falls back
    // to the active profile, leaking a profile-A connection error into
    // profile B's notification panel).
    profileId: connection.profileId || "",
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

/**
 * remote-core.ts — the slim remote-state contract (protocol 2) and its detail
 * resources.
 *
 * The desktop renderer reads the full `StatePayload` over IPC. A remote browser
 * must not: full git logs, provider inboxes/PR threads, review-bridge contexts
 * and Docker lists are megabytes that no always-on UI reads. This module turns a
 * per-client composed `StatePayload` into a `RemoteStateV2` core (navigation,
 * session/tab descriptors, badges, notifications and small summaries) and
 * exposes on-demand *detail* builders the client fetches only for the panes it
 * actually mounts.
 *
 * Summary and detail namespaces are kept strictly distinct (see the plan): the
 * core carries `gitSummaries` and reduced provider/docker/review objects; full
 * snapshots live only behind the detail builders. A field is never "sometimes a
 * summary and sometimes a snapshot".
 *
 * Everything here is pure (input → output), so it is unit-tested directly and
 * reused by every outbound server path through the single response adapter.
 */

import type {
  GitSummary,
  RemoteResourceRevisions,
  RemoteStateV2,
  RemoteCoreAppState,
  RemoteProviderSummary,
} from "../shared/types/state.js";

export type { RemoteStateV2 } from "../shared/types/state.js";

/** Slim-core contract version advertised by protocol-2 clients. */
export const REMOTE_STATE_PROTOCOL = 2;

/**
 * Capability tokens the server supports. A protocol-2 client advertises the
 * subset it can use (WS `?caps=` / HTTP `X-Strideterm-Capabilities`); the server
 * intersects that with this list and serves the response contract accordingly.
 * `remote-core-v2` selects the slim core shape; `resource-details-v1` enables the
 * on-demand detail endpoints. Advertising a numeric protocol >= 2 without an
 * explicit `caps` list implies the full set (back-compat), so an explicit list
 * only ever NARROWS — e.g. a future terminal-only shell can advertise neither.
 */
export const REMOTE_CAPABILITIES = ["remote-core-v2", "resource-details-v1"] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

/**
 * Resolve the capabilities a client gets. Explicit advertised tokens are
 * intersected with what the server supports; an empty/absent advertisement on a
 * protocol-2 request implies the full supported set (a plain `?sp=2` client),
 * while a legacy (protocol < 2) request gets none.
 */
export function selectCapabilities(advertised: string[] | null | undefined, protocol: number): string[] {
  if (advertised && advertised.length) {
    const supported = new Set<string>(REMOTE_CAPABILITIES);
    return advertised.filter((c) => supported.has(c));
  }
  return protocol >= REMOTE_STATE_PROTOCOL ? [...REMOTE_CAPABILITIES] : [];
}

/** Whether a selected capability set means "serve the slim v2 core". */
export function servesRemoteCore(capabilities: string[]): boolean {
  return capabilities.includes("remote-core-v2");
}

// ---------------------------------------------------------------------------
// Summaries (core)
// ---------------------------------------------------------------------------

/** Reduce one git snapshot to the six fields the always-on UI reads. */
export function summarizeGit(snap: AnyRecord | null | undefined): GitSummary {
  return {
    available: Boolean(snap?.available),
    branch: String(snap?.branch || ""),
    dirty: Boolean(snap?.dirty),
    dirtyCount: Number(snap?.dirtyCount || 0),
    branchMerged: snap?.branchMerged,
    lastChangeAt: snap?.lastChangeAt ?? null,
  };
}

/**
 * Build `gitSummaries` for the workspaces in `profileWorkspaceIds` (or all when
 * the set is null, e.g. an uncomposed token socket that sees raw state).
 */
export function buildGitSummaries(
  gitWorkspaces: Record<string, AnyRecord> | undefined,
  profileWorkspaceIds: Set<string> | null,
): Record<string, GitSummary> {
  const out: Record<string, GitSummary> = {};
  for (const [wsId, snap] of Object.entries(gitWorkspaces || {})) {
    if (profileWorkspaceIds && !profileWorkspaceIds.has(wsId)) continue;
    out[wsId] = summarizeGit(snap);
  }
  return out;
}

/**
 * Heavy per-PR detail collections that never belong in the core badge summary —
 * they are megabytes (review threads with nested comments, issue comments, the
 * reviews list, changed-file diffs) and are fetched on demand via the PR detail
 * endpoint. Everything else on a PR entry is light scalar/metadata the always-on
 * sidebar badges, tab-strip counts, pipeline/review notifications and the review
 * pane header read directly off the core.
 */
const HEAVY_PR_FIELDS = [
  "threads",
  "issueComments",
  "reviews",
  "changedFiles",
  "localChangedFiles",
  "comments",
  "payload",
] as const;

function reducePrEntry(entry: AnyRecord): AnyRecord {
  const light: AnyRecord = {};
  for (const [k, v] of Object.entries(entry)) {
    if ((HEAVY_PR_FIELDS as readonly string[]).includes(k)) continue;
    light[k] = v;
  }
  return light;
}

function matchesProfile(value: AnyRecord, profileId: string | null): boolean {
  if (!profileId) return true;
  return String(value?.profileId || "default") === profileId;
}

/**
 * Reduce an Azure/GitHub provider snapshot to the badge + notification surface,
 * scoped to the client's profile. Drops the heavy `inbox` lists (fetched via the
 * inbox detail endpoint) and, from each per-PR entry, the heavy detail
 * collections (`HEAVY_PR_FIELDS`). Connections, pull requests, review activity
 * and tracked PRs are filtered to the client's profile so one browser never sees
 * another profile's PRs/connections (a null profileId — the uncomposed token
 * socket that already sees raw state — keeps everything).
 */
export function buildProviderCoreSummary(
  snapshot: AnyRecord | null | undefined,
  profileId: string | null = null,
): RemoteProviderSummary {
  const snap = (snapshot || {}) as AnyRecord;
  const connIds = profileConnectionIds(snap, profileId);
  const reducedPullRequests: Record<string, unknown> = {};
  for (const [prKey, pr] of Object.entries((snap.pullRequests || {}) as AnyRecord)) {
    const entry = pr as AnyRecord;
    if (!matchesProfile(entry, profileId)) continue;
    reducedPullRequests[prKey] = reducePrEntry(entry);
  }
  const reviewActivity = ((snap.reviewActivity || []) as AnyRecord[]).filter((ev) => matchesProfile(ev, profileId));
  const trackedPullRequests: Record<string, unknown> = {};
  for (const [prKey, tracked] of Object.entries((snap.trackedPullRequests || {}) as AnyRecord)) {
    const t = tracked as AnyRecord;
    // Tracked entries carry connectionId (not profileId); scope by the profile's
    // connection set, or keep when the PR itself survived the profile filter.
    const inScope = connIds ? connIds.has(String(t?.connectionId)) : true;
    if (inScope || prKey in reducedPullRequests) trackedPullRequests[prKey] = t;
  }
  const connections = connIds
    ? ((snap.connections || []) as AnyRecord[]).filter((c) => connIds.has(String(c.id)))
    : (snap.connections as unknown[]) || [];
  return {
    connections,
    pullRequests: reducedPullRequests,
    reviewActivity,
    trackedPullRequests,
    sync: snap.sync,
    lastUpdatedAt: snap.lastUpdatedAt ?? null,
    error: snap.error ?? "",
    // inbox intentionally dropped — fetched via the inbox detail endpoint.
  };
}

/**
 * Reduce the review-bridge snapshot: keep the global `agentPrompts` list (small,
 * read by the review pane's Agent tab) plus a per-PR BADGE summary — ids, the
 * draft/comment/syncQueue counts and the last-seen activity — for the PRs in the
 * client's profile. The heavy per-PR context (full comment/draft bodies,
 * syncQueue payloads, mcpServerSpec) is dropped and fetched on demand via the
 * review-bridge detail endpoint. `composed` is the full payload so profile
 * ownership resolves through the provider PR the review-bridge key mirrors.
 */
export function buildReviewBridgeCoreSummary(
  snapshot: AnyRecord | null | undefined,
  composed: AnyRecord,
  profileId: string | null = null,
): { agentPrompts: unknown[]; pullRequests: Record<string, unknown> } {
  const snap = (snapshot || {}) as AnyRecord;
  const size = (arr: unknown): number => (Array.isArray(arr) ? arr.length : 0);
  const pullRequests: Record<string, unknown> = {};
  for (const [prKey, ctx] of Object.entries((snap.pullRequests || {}) as AnyRecord)) {
    if (profileId && !prBelongsToProfile(composed, prKey, profileId)) continue;
    const c = ctx as AnyRecord;
    const drafts = (c.drafts || []) as AnyRecord[];
    pullRequests[prKey] = {
      prKey,
      commentCount: size(c.comments),
      draftCount: drafts.filter((d) => d?.status === "draft").length,
      syncQueueCount: size(c.syncQueue),
      lastSeenActivityAt: c.lastSeenActivityAt ?? null,
    };
  }
  return {
    agentPrompts: snap.agentPrompts || [],
    pullRequests,
  };
}

/**
 * Reduce the Docker snapshot to the counts the tab badge + hero read; drop the
 * container/image/volume/network lists (fetched via the docker detail
 * endpoint). Empty arrays are kept so any stray reader sees a loading state
 * rather than crashing on `undefined`.
 */
export function buildDockerCoreSummary(snapshot: AnyRecord | null | undefined): AnyRecord {
  const snap = (snapshot || {}) as AnyRecord;
  const containers = (snap.containers || []) as AnyRecord[];
  const running = containers.filter((c) => isContainerRunning(c)).length;
  return {
    available: Boolean(snap.available),
    error: snap.error ?? "",
    lastUpdatedAt: snap.lastUpdatedAt ?? null,
    counts: { containers: containers.length, running },
    backends: [],
    contexts: [],
    containers: [],
    images: [],
    volumes: [],
    networks: [],
    lazydocker: {},
  };
}

/** Same predicate as the renderer's helpers.isContainerRunning — kept in sync so
 *  the core's running count matches what the desktop computes locally. */
function isContainerRunning(container: AnyRecord | null | undefined): boolean {
  const state = String(container?.State || "").toLowerCase();
  const status = String(container?.Status || "").toLowerCase();
  return state === "running" || status.startsWith("up ");
}

/** Minimal remote-access surface: the connected client only needs the share
 *  URLs + tunnel status; the token is already blanked by stripSecretsForRemote. */
function reduceRemoteAccess(remoteAccess: AnyRecord | null | undefined): AnyRecord {
  const ra = (remoteAccess || {}) as AnyRecord;
  return {
    enabled: Boolean(ra.enabled),
    host: ra.host,
    port: ra.port,
    urls: ra.urls || [],
    tunnel: ra.tunnel,
  };
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

/**
 * Cheap change token for a resource, derived from timestamps already present in
 * the payload (no hashing of large blobs). The client compares tokens to decide
 * whether a cached detail is stale. Empty string when the resource is absent.
 */
export function resourceRevision(payload: AnyRecord, resourceKey: string): string {
  const { type, id } = parseResourceKey(resourceKey);
  switch (type) {
    case "git": {
      const snap = payload?.git?.workspaces?.[id || ""];
      return snap ? String(snap.lastUpdatedAt || snap.lastChangeAt || "") : "";
    }
    case "docker":
      return String(payload?.docker?.lastUpdatedAt || "");
    case "azure-inbox":
      return providerInboxRevision(payload?.azureDevops);
    case "github-inbox":
      return providerInboxRevision(payload?.github);
    case "azure-pr":
      return String(payload?.azureDevops?.pullRequests?.[id || ""]?.lastActivityAt || "");
    case "github-pr":
      return String(payload?.github?.pullRequests?.[id || ""]?.lastActivityAt || "");
    case "review-bridge":
      return reviewBridgePrRevision(payload?.reviewBridge?.pullRequests?.[id || ""]);
    default:
      return "";
  }
}

function providerInboxRevision(snapshot: AnyRecord | null | undefined): string {
  const snap = (snapshot || {}) as AnyRecord;
  const sync = (snap.sync || {}) as AnyRecord;
  const inbox = (snap.inbox || {}) as AnyRecord;
  const counts = ["needsMyReview", "myPullRequests", "recentlyUpdated", "needsAttention"]
    .map((k) => (Array.isArray(inbox[k]) ? inbox[k].length : 0))
    .join(",");
  return `${sync.lastCompletedAt || ""}|${counts}`;
}

function reviewBridgePrRevision(ctx: AnyRecord | null | undefined): string {
  const c = (ctx || {}) as AnyRecord;
  // Drafts/comments/syncQueue change on mutation; fold their sizes + newest
  // updatedAt into a cheap signature so a mutation invalidates the cache.
  const size = (arr: unknown): number => (Array.isArray(arr) ? arr.length : 0);
  const newest = (arr: unknown): string => {
    if (!Array.isArray(arr)) return "";
    let best = "";
    for (const item of arr) {
      const u = String((item as AnyRecord)?.updatedAt || "");
      if (u > best) best = u;
    }
    return best;
  };
  return [
    c.lastSeenActivityAt || "",
    size(c.comments),
    size(c.drafts),
    size(c.syncQueue),
    newest(c.comments),
    newest(c.drafts),
    newest(c.syncQueue),
  ].join("|");
}

/** Core revision map: the cheap, always-included resources (git per profile
 *  workspace, docker, both inboxes). Per-PR revisions ride the invalidation
 *  push instead, so the core stays small. */
export function buildCoreRevisions(
  payload: AnyRecord,
  profileWorkspaceIds: Set<string> | null,
): RemoteResourceRevisions {
  const revisions: RemoteResourceRevisions = {};
  for (const wsId of Object.keys((payload?.git?.workspaces || {}) as AnyRecord)) {
    if (profileWorkspaceIds && !profileWorkspaceIds.has(wsId)) continue;
    revisions[`git:${wsId}`] = resourceRevision(payload, `git:${wsId}`);
  }
  revisions["docker"] = resourceRevision(payload, "docker");
  revisions["azure-inbox"] = resourceRevision(payload, "azure-inbox");
  revisions["github-inbox"] = resourceRevision(payload, "github-inbox");
  return revisions;
}

// ---------------------------------------------------------------------------
// Core composition
// ---------------------------------------------------------------------------

function profileWorkspaceIdSet(appState: AnyRecord, profileId: string | undefined): Set<string> | null {
  if (!profileId) return null; // uncomposed socket → all workspaces (raw state)
  const workspaces = (appState?.workspaces || []) as AnyRecord[];
  return new Set(
    workspaces.filter((ws) => String(ws?.profileId || "default") === profileId).map((ws) => String(ws.id)),
  );
}

/** Strip the credential secret from each provider connection (`pat` for Azure,
 *  `token` for GitHub). The secret lives in the credentials store keyed by id;
 *  a remote browser only ever needs the connection metadata. */
function reduceProviderIntegrationConfig(cfg: AnyRecord | undefined, secretField: string): AnyRecord | undefined {
  if (!cfg) return cfg;
  const connections = ((cfg.connections || []) as AnyRecord[]).map((c) => {
    const copy = { ...c };
    delete copy[secretField];
    return copy;
  });
  return { ...cfg, connections };
}

/**
 * Slim the persisted `settings` for the remote core: keep the shape the remote
 * Settings dialog reads, but strip everything a browser must not receive — the
 * tunnel token + cloudflared binary path, provider PATs / GitHub tokens, and the
 * Telegram connections (bot-token refs + chat ids; Telegram is a desktop-managed
 * integration). Structural keys are preserved (empty arrays, blanked strings) so
 * the dialog's form initializer never reads `undefined`.
 */
export function slimRemoteSettings(settings: AnyRecord | undefined): AnyRecord {
  const s = (settings || {}) as AnyRecord;
  const integrations = (s.integrations || {}) as AnyRecord;
  const telegram = integrations.telegram as AnyRecord | undefined;
  return {
    ...s,
    remoteAccess: s.remoteAccess
      ? { ...(s.remoteAccess as AnyRecord), token: "", cloudflaredPath: "" }
      : s.remoteAccess,
    integrations: {
      ...integrations,
      azureDevops: reduceProviderIntegrationConfig(integrations.azureDevops as AnyRecord | undefined, "pat"),
      github: reduceProviderIntegrationConfig(integrations.github as AnyRecord | undefined, "token"),
      telegram: telegram
        ? { enabled: Boolean(telegram.enabled), defaultPollSeconds: telegram.defaultPollSeconds, connections: [] }
        : telegram,
    },
  };
}

/**
 * Build the slim core `appState` — an ALLOWLIST, not the full persisted state.
 * Profile-filters workspaces, reduces `ssh` to non-secret host metadata (private
 * key material in keys/certificates/knownHosts never reaches a browser), slims
 * `settings`, and drops the unread legacy `projects`/`activeProjectId` aliases.
 * `windowSlots` are already reduced by the registry's composePayload.
 */
export function buildRemoteCoreAppState(appState: AnyRecord, inProfile: Set<string> | null): RemoteCoreAppState {
  const ssh = (appState.ssh || undefined) as AnyRecord | undefined;
  const workspaces = ((appState.workspaces || []) as AnyRecord[]).filter(
    (ws) => !inProfile || inProfile.has(String(ws?.id)),
  );
  return {
    activeWorkspaceId: String(appState.activeWorkspaceId || ""),
    settings: slimRemoteSettings(appState.settings as AnyRecord | undefined) as RemoteCoreAppState["settings"],
    tabTemplates: (appState.tabTemplates || []) as RemoteCoreAppState["tabTemplates"],
    profiles: (appState.profiles || []) as RemoteCoreAppState["profiles"],
    workspaces: workspaces as RemoteCoreAppState["workspaces"],
    windowSlots: (appState.windowSlots || []) as unknown[],
    ...(ssh ? { ssh: { hosts: ssh.hosts || [], settings: ssh.settings } as RemoteCoreAppState["ssh"] } : {}),
    ...(appState.workspaceGrid !== undefined
      ? { workspaceGrid: appState.workspaceGrid as RemoteCoreAppState["workspaceGrid"] }
      : {}),
  };
}

/**
 * Turn a per-client *composed* `StatePayload` (already carrying `remoteClient`
 * and reduced windowSlots, already secret-stripped) into a `RemoteStateV2`
 * slim core. Pure — never mutates the input.
 *
 * `opts.coreRevision` is the monotonic broadcast revision the client uses to
 * apply only newer snapshots (bootstrap→WS handoff); `opts.capabilities` is the
 * negotiated set advertised back to the client.
 */
export function buildRemoteCore(
  composed: AnyRecord,
  opts: { coreRevision?: number; capabilities?: string[] } = {},
): RemoteStateV2 {
  const appState = (composed.appState || {}) as AnyRecord;
  const profileId = (composed.remoteClient?.profileId as string | undefined) ?? null;
  const inProfile = profileWorkspaceIdSet(appState, profileId ?? undefined);
  return {
    stateProtocol: REMOTE_STATE_PROTOCOL,
    capabilities: opts.capabilities ?? [...REMOTE_CAPABILITIES],
    coreRevision: opts.coreRevision ?? 0,
    meta: composed.meta,
    appState: buildRemoteCoreAppState(appState, inProfile),
    workspace: composed.workspace ?? null,
    attention: composed.attention,
    taskRunner: composed.taskRunner,
    plugins: composed.plugins || [],
    environment: composed.environment || {},
    remoteAccess: reduceRemoteAccess(composed.remoteAccess),
    gitSummaries: buildGitSummaries(composed.git?.workspaces, inProfile),
    git: { connections: composed.git?.connections || [] },
    azureDevops: buildProviderCoreSummary(composed.azureDevops, profileId),
    github: buildProviderCoreSummary(composed.github, profileId),
    reviewBridge: buildReviewBridgeCoreSummary(composed.reviewBridge, composed, profileId),
    docker: buildDockerCoreSummary(composed.docker),
    revisions: buildCoreRevisions(composed, inProfile),
    ...(composed.remoteClient ? { remoteClient: composed.remoteClient } : {}),
  };
}

/**
 * True when `body` is a full state payload (a `getPayload()` result) rather than
 * a small mutation result. Every state payload carries `appState`; no small
 * result (`{ ok }`, `{ error }`, `{ resource, revision, data }`, verification
 * blobs) does, and results that wrap a payload expose it under `.payload`
 * instead. So `appState` presence is the clean discriminator.
 */
export function looksLikeStatePayload(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return Boolean((body as AnyRecord).appState);
}

// ---------------------------------------------------------------------------
// Resource keys
// ---------------------------------------------------------------------------

/** Resource types with no id (whole-resource details). */
const ID_LESS_RESOURCES = new Set(["docker", "azure-inbox", "github-inbox"]);
/** Resource types addressed by id. */
const ID_RESOURCES = new Set(["git", "azure-pr", "github-pr", "review-bridge"]);

export interface ParsedResourceKey {
  type: string;
  id?: string;
}

/**
 * Parse a resource key. Id-bearing keys are `<type>:<id>` split on the FIRST
 * colon (a prKey may itself contain colons, so only the leading segment is the
 * type). Id-less keys (`docker`, `azure-inbox`, `github-inbox`) have no id.
 */
export function parseResourceKey(key: string): ParsedResourceKey {
  if (ID_LESS_RESOURCES.has(key)) return { type: key };
  const idx = key.indexOf(":");
  if (idx < 0) return { type: key };
  return { type: key.slice(0, idx), id: key.slice(idx + 1) };
}

/** Whether a resource key is one this server knows how to serve. */
export function isKnownResourceKey(key: string): boolean {
  const { type, id } = parseResourceKey(key);
  if (ID_LESS_RESOURCES.has(type)) return true;
  return ID_RESOURCES.has(type) && Boolean(id);
}

// ---------------------------------------------------------------------------
// Profile authorization
// ---------------------------------------------------------------------------

function prBelongsToProfile(payload: AnyRecord, prKey: string, profileId: string): boolean {
  const azure = payload?.azureDevops?.pullRequests?.[prKey] as AnyRecord | undefined;
  const github = payload?.github?.pullRequests?.[prKey] as AnyRecord | undefined;
  const pr = azure || github;
  if (!pr) return false;
  return String(pr.profileId || "default") === profileId;
}

/**
 * Whether a client bound to `profileId` may read `resourceKey`. A null profileId
 * (uncomposed token socket that already sees raw state) is allowed everything.
 * Cross-profile ids are rejected even when they exist globally.
 */
export function resourceProfileAuthorized(payload: AnyRecord, profileId: string | null, resourceKey: string): boolean {
  if (!isKnownResourceKey(resourceKey)) return false;
  if (!profileId) return true;
  const { type, id } = parseResourceKey(resourceKey);
  switch (type) {
    case "docker":
    case "azure-inbox":
    case "github-inbox":
      return true; // profile-scoped internally by the detail builder
    case "git": {
      const ws = ((payload?.appState?.workspaces || []) as AnyRecord[]).find((w) => String(w?.id) === id);
      return Boolean(ws) && String(ws?.profileId || "default") === profileId;
    }
    case "azure-pr":
    case "github-pr":
    case "review-bridge":
      return prBelongsToProfile(payload, id || "", profileId);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Detail builders (on-demand)
// ---------------------------------------------------------------------------

/** Full git snapshot (with `roots`) for one workspace. */
export function buildGitWorkspaceDetail(payload: AnyRecord, workspaceId: string): AnyRecord | null {
  return (payload?.git?.workspaces?.[workspaceId] as AnyRecord) || null;
}

/** Full docker snapshot (containers/images/volumes/networks/backends/contexts). */
export function buildDockerDetail(payload: AnyRecord): AnyRecord {
  return (payload?.docker as AnyRecord) || {};
}

/** Connection ids belonging to `profileId` for a provider snapshot. */
function profileConnectionIds(snapshot: AnyRecord, profileId: string | null): Set<string> | null {
  if (!profileId) return null;
  const connections = (snapshot?.connections || []) as AnyRecord[];
  return new Set(connections.filter((c) => String(c?.profileId || "default") === profileId).map((c) => String(c.id)));
}

/**
 * Provider inbox detail scoped to the client's profile: the four inbox lists
 * filtered to the profile's connections, plus that profile's connection cards.
 */
export function buildProviderInboxDetail(snapshot: AnyRecord | null | undefined, profileId: string | null): AnyRecord {
  const snap = (snapshot || {}) as AnyRecord;
  const inbox = (snap.inbox || {}) as AnyRecord;
  const connIds = profileConnectionIds(snap, profileId);
  const scopeList = (list: unknown): AnyRecord[] => {
    if (!Array.isArray(list)) return [];
    if (!connIds) return list as AnyRecord[];
    return (list as AnyRecord[]).filter((pr) => connIds.has(String(pr?.connectionId)));
  };
  const connections = connIds
    ? ((snap.connections || []) as AnyRecord[]).filter((c) => connIds.has(String(c.id)))
    : snap.connections || [];
  return {
    inbox: {
      needsMyReview: scopeList(inbox.needsMyReview),
      myPullRequests: scopeList(inbox.myPullRequests),
      recentlyUpdated: scopeList(inbox.recentlyUpdated),
      needsAttention: scopeList(inbox.needsAttention),
    },
    connections,
  };
}

/** Full per-PR provider detail (threads, issueComments, repository, project…). */
export function buildProviderPrDetail(snapshot: AnyRecord | null | undefined, prKey: string): AnyRecord | null {
  return ((snapshot as AnyRecord)?.pullRequests?.[prKey] as AnyRecord) || null;
}

/** Full per-PR review-bridge context (comments, drafts, syncQueue, mcpServerSpec). */
export function buildReviewBridgePrDetail(payload: AnyRecord, prKey: string): AnyRecord | null {
  const ctx = payload?.reviewBridge?.pullRequests?.[prKey] as AnyRecord | undefined;
  if (!ctx) return null;
  return { ...ctx, agentPrompts: payload?.reviewBridge?.agentPrompts || [] };
}

/**
 * Build the `{ resource, revision, data }` body for a detail request, honoring
 * profile scope. Returns null when the resource is unknown/absent (404) — the
 * caller checks authorization separately (403).
 */
export function buildResourceDetail(
  payload: AnyRecord,
  profileId: string | null,
  resourceKey: string,
): { resource: string; revision: string; data: unknown } | null {
  const { type, id } = parseResourceKey(resourceKey);
  let data: unknown;
  switch (type) {
    case "git":
      data = buildGitWorkspaceDetail(payload, id || "");
      break;
    case "docker":
      data = buildDockerDetail(payload);
      break;
    case "azure-inbox":
      data = buildProviderInboxDetail(payload?.azureDevops, profileId);
      break;
    case "github-inbox":
      data = buildProviderInboxDetail(payload?.github, profileId);
      break;
    case "azure-pr":
      data = buildProviderPrDetail(payload?.azureDevops, id || "");
      break;
    case "github-pr":
      data = buildProviderPrDetail(payload?.github, id || "");
      break;
    case "review-bridge":
      data = buildReviewBridgePrDetail(payload, id || "");
      break;
    default:
      return null;
  }
  if (data == null) return null;
  return { resource: resourceKey, revision: resourceRevision(payload, resourceKey), data };
}

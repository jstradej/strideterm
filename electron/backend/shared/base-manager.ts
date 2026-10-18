/// <reference types="node" />
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { execFileText as defaultExecFileText } from "../process-utils.js";
import {
  clone,
  createEmptySnapshot,
  stripRefsPrefix,
  exists,
  shortPathKey,
  dedupePrSummaries,
  buildInboxViews,
  sanitizePathSegment,
  normalizeReviewRoot,
} from "./provider-utils.js";
import { appendReviewActivity, buildConnectionErrorEvent, shouldSeedConnection } from "./review-activity.js";
import {
  createGitConfigEnvProbe,
  encodeAuthHeader,
  gitAuthEnvironment,
  sanitizeGitEnvironment,
} from "./git-auth-utils.js";
import type { Logger } from "../logger.js";
import { getLogger } from "../logger.js";
import type { CredentialStore } from "./credential-store.js";
import { reviewSourceIdentityKey } from "../../shared/review-source-identity.js";
import type { ReviewInfo, ReviewSourceRepository } from "../../shared/types/state.js";
import { createReviewGitEngine, type ReviewGitEngine } from "../review-git/engine.js";
import { sharedReviewGitLocks, type ReviewGitLocks } from "../review-git/locks.js";
import { compareCommits } from "../review-git/inspect.js";
import type {
  ReviewGitConfirmation,
  ReviewGitRequester,
  ReviewGitResult,
  ReviewGitSubject,
} from "../review-git/types.js";

interface PrSummaryItem {
  prKey?: string;
  lastRemoteActivityAt?: string | null;
  reviewWorkspaceId?: string;
  hasAttention?: boolean;
  attentionReason?: string;
  newCommentsCount?: number;
  [key: string]: unknown;
}

interface SnapshotConnection {
  id: string;
  tokenRef?: string;
  login?: string;
  [key: string]: unknown;
}

/** Minimal shape the review Git operations need — both AzureDevOpsManager's
 * `ReviewWorkspace` and GitHubManager's `SyncWorkspace` satisfy this structurally. */
export interface ReviewWorkspaceRef {
  id: string;
  cwd?: string;
  profileId?: string;
  review?: {
    provider?: string;
    prKey?: string;
    connectionId?: string;
    repository?: { remoteUrl?: string } | null;
    sourceRepository?: ReviewSourceRepository | null;
    sourceBaselineSha?: string;
    pullRequest?: {
      id?: string | number;
      number?: string | number;
      sourceRefName?: string;
      targetRefName?: string;
    } | null;
    /** "author" when the user owns the PR (a promoted quickfix workspace). */
    role?: string;
    checkout?: { mode?: string; rootPath?: string; cacheRepoPath?: string } | null;
  };
}

/** Outcome of `syncReviewWorkspace` — the shared review Git preflight result. */
export type ReviewWorkspaceSyncResult = ReviewGitResult;
export type ReviewWorkspaceSyncStatus = ReviewGitResult["status"];

/** Where a started review Git operation was requested from, for the audit row. */
export type { ReviewGitRequester, ReviewGitConfirmation };

/** Persists review-metadata patches (baseline, lazily captured source identity) into app state. */
export interface ReviewWorkspaceMetadataStore {
  updateReview(
    workspaceId: string,
    patch: {
      sourceBaselineSha?: string;
      sourceRepository?: ReviewSourceRepository;
      /** The source identity the caller inspected; the write is refused when the stored review no longer matches it. */
      expectedIdentityKey?: string;
    },
  ): Promise<void>;
}

interface ProviderSnapshot {
  connections: SnapshotConnection[];
  inbox: {
    needsMyReview: PrSummaryItem[];
    myPullRequests: PrSummaryItem[];
    recentlyUpdated: PrSummaryItem[];
    needsAttention: PrSummaryItem[];
  };
  trackedPullRequests: Record<string, Record<string, unknown>>;
  pullRequests: Record<string, PrSummaryItem>;
  reviewActivity: unknown[];
  sync: {
    running: boolean;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
  };
  [key: string]: unknown;
}

interface ReviewStore {
  upsertTrackedPullRequest(
    prKey: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any,
  ): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getState(): { connections?: Record<string, any> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTrackedPullRequest(prKey: string): Record<string, any> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upsertConnectionState(connectionId: string, data: any): Promise<unknown>;
}

interface ReviewBridgeStore {
  markPullRequestSeen?(prKey: string, lastSeenActivityAt: string): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  syncPullRequest?(summary: any): Promise<void>;
}

interface SyncConnectionRef {
  id: string;
  tokenRef?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

interface SyncOptions {
  connections?: SyncConnectionRef[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workspaces?: any[];
  gitSnapshots?: Record<string, unknown>;
  activeProfileId?: string;
}

interface SyncConnectionCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workspaces: any[];
  gitSnapshots: Record<string, unknown>;
  activeProfileId: string;
  seedingConnection: boolean;
  visibleSummaries: PrSummaryItem[];
  trackedPullRequests: Record<string, Record<string, unknown>>;
  detailMap: Record<string, PrSummaryItem>;
  newActivityEvents: unknown[];
}

interface ConnectionSnapshotLike {
  status?: string;
  lastError?: string | null;
  lastSyncAt?: string | null;
  lastSuccessAt?: string | null;
  [key: string]: unknown;
}

interface SyncHooks {
  /** Provider-specific connection snapshot shape (azure-devops-utils.ts /
   *  github-utils.ts each have their own createConnectionSnapshot). */
  createConnectionSnapshot(
    connection: SyncConnectionRef,
    persistedState: Record<string, unknown>,
  ): ConnectionSnapshotLike;
  /** Walk this connection's PRs (project/repo/PR nested loop for Azure, 2
   *  search queries for GitHub — the one part of sync() that's genuinely
   *  provider-specific), pushing/setting into ctx's shared accumulators. */
  fetchConnectionPrs(connection: SyncConnectionRef, token: string, ctx: SyncConnectionCtx): Promise<void>;
  /** True once `existing` already reflects a terminal PR state (Azure:
   *  status !== "active"; GitHub: state !== "open") — skips the re-fetch. */
  isPrResolved(existing: PrSummaryItem | undefined): boolean;
  /**
   * Given a workspace whose tracked PR fell out of the active poll, fetch its
   * current state and return the updated detailMap entry — resolved (still
   * open, new data) or terminal (confirmed gone via 404/410). Return
   * null/undefined to leave detailMap untouched: a transient fetch failure
   * that should retry on the next poll instead of mislabeling an active PR.
   * The hook owns its own try/catch and status-code parsing since the
   * terminal-state field shape and log wording differ per provider.
   */
  resolveStalePr(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ws: any,
    existing: PrSummaryItem | undefined,
    conn: SyncConnectionRef,
    token: string,
  ): Promise<PrSummaryItem | null | undefined>;
}

interface OpenReviewWorkspaceOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: { workspaces: any[]; windowSlots?: Array<{ profileId?: string }>; tabTemplates?: unknown[] };
  prKey: string;
  workspaceId?: string;
  /** Profile of the window that initiated the action — used as defensive
   *  fallback when the connection has no profileId (legacy/pre-migration). */
  callerProfileId?: string;
  /** Skip the author's branch-matching workspace and build a managed review
   *  checkout instead. Set by the row's separate "Review" button — see the
   *  fallback in openReviewWorkspaceCore for why it needs saying explicitly. */
  forceReview?: boolean;
  /** Always create a fresh managed checkout, never reuse/link an existing workspace. */
  isolated?: boolean;
}

interface OpenReviewWorkspaceHooks {
  /** Fetch (and cache) the full PR detail summary for `prKey`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ensurePullRequestDetail(prKey: string, opts: { workspaces: any[] }): Promise<any>;
  /** Create (or reuse) the managed-worktree checkout for a brand-new review workspace. */
  prepareManagedReviewCheckout(opts: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summary: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection: any;
    token: string;
    reviewRoot: string;
    isolatedId?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<{ mode: string; rootPath: string; cacheRepoPath: string; [key: string]: any }>;
  /** Provider-specific `review` metadata shape (Azure: project/orgUrl; GitHub: hostUrl). */
  buildReviewMetadata(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summary: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    checkout: any,
    extra: { parentWorkspaceId?: string; previousReview?: Partial<ReviewInfo> | null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any;
  /** "<repo> PR #<id>" — used for both the workspace name and its notes string. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  formatPrLabel(summary: any): string;
  /** Provider-specific lookup: find the workspace already tracking this PR, if any. */
  findWorkspaceForPullRequest(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workspaces: any[],
    prKey: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any;
}

interface OpenQuickFixWorkspaceOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: { workspaces: any[]; tabTemplates?: unknown[] };
  connectionId: string;
  baseBranch: string;
  newBranchName: string;
  /** Profile of the window that initiated the action. Refusing on mismatch
   *  keeps a remote/mobile client on profile B from spawning a profile-A
   *  quickfix workspace on disk. */
  callerProfileId?: string;
  /** Provider-specific extra identity fields (Azure: projectName/repositoryId/
   *  repositoryName; GitHub: owner/repo) — opaque to the shared skeleton,
   *  threaded through to the hooks below. */
  [key: string]: unknown;
}

interface OpenQuickFixWorkspaceHooks {
  /** Create (or reuse) the quickfix worktree checkout on disk. */
  prepareQuickFixCheckout(opts: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection: any;
    token: string;
    reviewRoot: string;
    baseBranch: string;
    newBranchName: string;
    options: OpenQuickFixWorkspaceOptions;
  }): Promise<{ rootPath: string; cacheRepoPath: string }>;
  /** Provider-specific `review` + `quickfix` metadata objects for the new workspace. */
  buildQuickFixMetadata(opts: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection: any;
    checkout: { rootPath: string; cacheRepoPath: string };
    parentWorkspaceId: string;
    options: OpenQuickFixWorkspaceOptions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): { review: Record<string, any>; quickfix: Record<string, any> };
}

interface AuditLogStore {
  logEntry(entry: Record<string, unknown>): void | boolean;
  /** Intent-first rows for review Git mutations; a store without them cannot audit those. */
  insertEntry?(entry: Record<string, unknown>): number | null;
  finishEntry?(
    id: number,
    outcome: {
      success: boolean;
      errorMessage?: string | null;
      durationMs?: number | null;
      summary?: string;
      details?: Record<string, unknown>;
    },
  ): boolean;
}

type ApiFactory = (
  fetchImpl: typeof globalThis.fetch,
  opts: { auditLogger: (raw: any) => void }, // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: audit log entry shape is open-ended
) => Record<string, unknown>;

interface BaseProviderManagerOptions {
  credentialStore: CredentialStore;
  reviewStore: ReviewStore;
  reviewBridgeStore?: ReviewBridgeStore | null;
  auditLogStore?: AuditLogStore | null;
  fetchImpl?: typeof globalThis.fetch;
  execFileTextImpl?: typeof defaultExecFileText;
  // Returns the `git --version` text; separate from execFileTextImpl so probing the version
  // does not show up as one of the git calls a test is counting.
  gitVersionImpl?: () => Promise<string>;
  now?: () => number;
  createApi: ApiFactory;
}

interface RunGitOptions {
  login?: string;
  token?: string;
}

interface PanelTemplate {
  id?: string;
  title?: string;
  command?: string;
  shell?: boolean;
  startup?: string;
  launch?: { file?: string; args?: string[] } | null;
}

/**
 * Shared base class for Azure DevOps and GitHub provider managers.
 * Contains identical methods that both managers share: snapshot management,
 * polling, audit context, PR seen/seed, git operations, and review workspace panels.
 *
 * Subclasses MUST implement:
 *   - `_logAudit(raw)` — provider-specific URL classification and field mapping
 *
 * Subclasses SHOULD set:
 *   - `this.providerLabel` — e.g. "azure-devops" or "github" (for log messages)
 *   - `this.defaultGitLogin` — default git auth login (e.g. "" for Azure, "x-access-token" for GitHub)
 *   - `this.reviewIcon` / `this.reviewColor` — review workspace badge (AZURE_REVIEW_ICON/COLOR, GITHUB_REVIEW_ICON/COLOR)
 *   - `this.parentWorkspaceKind` — workspace.kind that identifies "the provider's own workspace" (e.g. "azure", "github")
 *   - `this.providerDisplayName` — human-readable name for workspace notes (e.g. "Azure DevOps", "GitHub")
 *   - `this.getDefaultReviewRoot` — provider-specific default review root path function
 */
export class BaseProviderManager extends EventEmitter {
  credentialStore: CredentialStore;
  reviewStore: ReviewStore;
  reviewBridgeStore: ReviewBridgeStore | null;
  auditLogStore: AuditLogStore | null;
  fetchImpl: typeof globalThis.fetch;
  execFileText: typeof defaultExecFileText;
  // Memoized "git >= 2.31" (GIT_CONFIG_* support); see runGit.
  supportsGitConfigEnv: () => Promise<boolean>;
  now: () => number;
  _auditConnectionId: string;
  _auditUserInitiated: boolean;
  api: Record<string, unknown>;
  snapshot: ProviderSnapshot;
  syncTimer: ReturnType<typeof setInterval> | null;
  _seededConnections: Set<string>;
  providerLabel: string;
  defaultGitLogin: string;
  connectionNotFoundMessage: string;
  syncErrorFallbackMessage: string;
  reviewIcon: string;
  reviewColor: string;
  parentWorkspaceKind: string;
  providerDisplayName: string;
  getDefaultReviewRoot: () => string;
  _log: Logger | null;
  reviewMetadataStore: ReviewWorkspaceMetadataStore | null = null;
  reviewGitLocks: ReviewGitLocks = sharedReviewGitLocks;
  reviewGitEngine: ReviewGitEngine | null = null;

  constructor({
    credentialStore,
    reviewStore,
    reviewBridgeStore = null,
    auditLogStore = null,
    fetchImpl = globalThis.fetch,
    execFileTextImpl = defaultExecFileText,
    gitVersionImpl = async () => (await defaultExecFileText("git", ["--version"])).stdout,
    now = () => Date.now(),
    createApi,
  }: BaseProviderManagerOptions) {
    super();
    this.credentialStore = credentialStore;
    this.reviewStore = reviewStore;
    this.reviewBridgeStore = reviewBridgeStore;
    this.auditLogStore = auditLogStore;
    this.fetchImpl = fetchImpl;
    this.execFileText = execFileTextImpl;
    this.supportsGitConfigEnv = createGitConfigEnvProbe(gitVersionImpl);
    this.now = now;

    this._auditConnectionId = "";
    this._auditUserInitiated = false;

    this.api = createApi(fetchImpl, { auditLogger: (raw) => this._logAudit(raw) });
    this.snapshot = createEmptySnapshot() as ProviderSnapshot;
    this.syncTimer = null;

    // Connections that have completed their first sync in this process.
    // Used by review-activity delta detection to suppress notifications
    // on startup (otherwise every existing PR would be announced as "new").
    this._seededConnections = new Set();

    this.providerLabel = "provider";
    this.defaultGitLogin = "";
    this.connectionNotFoundMessage = "Connection was not found.";
    this.syncErrorFallbackMessage = "Sync failed.";
    this.reviewIcon = "";
    this.reviewColor = "";
    this.parentWorkspaceKind = "";
    this.providerDisplayName = "";
    this.getDefaultReviewRoot = () => "";
    this._log = null;
  }

  // Subclasses must override this
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _logAudit(_raw: any): void {}

  get log(): Logger {
    if (!this._log) this._log = getLogger(this.providerLabel);
    return this._log;
  }

  setAuditContext({
    connectionId = "",
    userInitiated = false,
  }: { connectionId?: string; userInitiated?: boolean } = {}): void {
    this._auditConnectionId = connectionId;
    this._auditUserInitiated = userInitiated;
  }

  getSnapshot(): ProviderSnapshot {
    return clone(this.snapshot);
  }

  emitUpdated(): void {
    this.emit("updated", this.getSnapshot());
  }

  setSnapshot(snapshot: ProviderSnapshot): void {
    this.snapshot = clone(snapshot);
    this.emitUpdated();
  }

  /**
   * Template-method skeleton shared by AzureDevOpsManager.sync / GitHubManager.sync:
   * reset-on-connections-changed, per-connection fetch + ok/error bookkeeping,
   * stale-PR resolution for workspaces that fell out of the active poll,
   * tracked-PR persistence, cross-connection dedup, and final snapshot build.
   * Each provider supplies the 4 genuinely-divergent pieces via `hooks`
   * (connection-snapshot shape, the PR-fetch walk itself, and stale-PR
   * resolution) — everything else here is the byte-identical part both
   * managers used to carry as their own ~250-line copy.
   */
  async syncCore(
    { connections = [], workspaces = [], gitSnapshots = {}, activeProfileId = "default" }: SyncOptions = {},
    hooks: SyncHooks,
  ): Promise<ProviderSnapshot> {
    const reviewState = this.reviewStore.getState();
    const startedAt = new Date(this.now()).toISOString();
    // Immediately apply the new connections list so any intermediate broadcastState
    // (triggered by emitUpdated) reflects the correct profile-filtered connections.
    const connectionsChanged =
      JSON.stringify(connections.map((c) => c.id).sort()) !==
      JSON.stringify((this.snapshot.connections || []).map((c) => c.id).sort());

    this.snapshot = {
      ...(connectionsChanged ? (createEmptySnapshot() as ProviderSnapshot) : this.snapshot),
      connections: connections as unknown as ProviderSnapshot["connections"],
      sync: {
        ...this.snapshot.sync,
        running: true,
        lastStartedAt: startedAt,
      },
    };
    this.emitUpdated();

    const connectionSnapshots: ConnectionSnapshotLike[] = [];
    const visibleSummaries: PrSummaryItem[] = [];
    const detailMap: Record<string, PrSummaryItem> = { ...this.snapshot.pullRequests };
    const trackedPullRequests: Record<string, Record<string, unknown>> = {};
    const newActivityEvents: unknown[] = [];

    for (const connection of connections.filter((entry) => entry.enabled !== false)) {
      this.setAuditContext({ connectionId: connection.id, userInitiated: false });
      const persistedState = reviewState.connections?.[connection.id] || {};
      const connectionSnapshot = hooks.createConnectionSnapshot(connection, persistedState);
      connectionSnapshots.push(connectionSnapshot);
      // Seed only a connection with no successful persisted poll. The in-memory
      // Set still prevents a second seed during this process, while a restart
      // can now detect PRs that arrived while the app was offline.
      const seedingConnection =
        shouldSeedConnection(this._seededConnections, connection.id) && !persistedState.lastSuccessAt;

      try {
        const token = this.credentialStore.getSecret(connection.tokenRef || "");
        if (!token) {
          throw new Error("PAT is missing.");
        }

        await hooks.fetchConnectionPrs(connection, token, {
          workspaces,
          gitSnapshots,
          activeProfileId,
          seedingConnection,
          visibleSummaries,
          trackedPullRequests,
          detailMap,
          newActivityEvents,
        });
        this._seededConnections.add(connection.id);

        connectionSnapshot.status = "ok";
        connectionSnapshot.lastError = "";
        connectionSnapshot.lastSyncAt = new Date(this.now()).toISOString();
        connectionSnapshot.lastSuccessAt = connectionSnapshot.lastSyncAt;
        await this.reviewStore.upsertConnectionState(connection.id, {
          status: "ok",
          lastError: "",
          lastSyncAt: connectionSnapshot.lastSyncAt,
          lastSuccessAt: connectionSnapshot.lastSuccessAt,
        });
      } catch (error) {
        connectionSnapshot.status = "error";
        connectionSnapshot.lastError = (error as Error).message || this.syncErrorFallbackMessage;
        connectionSnapshot.lastSyncAt = new Date(this.now()).toISOString();
        await this.reviewStore.upsertConnectionState(connection.id, {
          status: "error",
          lastError: connectionSnapshot.lastError,
          lastSyncAt: connectionSnapshot.lastSyncAt,
        });
      }

      // Connection-level errors are surfaced once per transition: when status
      // flips into "error" OR when the error message changes. Silent on
      // startup if the error was already persisted from the previous session.
      const connectionErrorEvent = buildConnectionErrorEvent({
        provider: this.providerLabel,
        connection,
        prevState: persistedState,
        currentStatus: connectionSnapshot.status || "",
        currentError: connectionSnapshot.lastError,
        at: connectionSnapshot.lastSyncAt || new Date(this.now()).toISOString(),
      });
      if (connectionErrorEvent) {
        newActivityEvents.push(connectionErrorEvent);
      }
    }

    // Resolve actual status for PRs with open workspaces that are no longer in the active poll.
    // Only fetches once — resolved status is persisted in detailMap so subsequent polls skip them.
    for (const ws of workspaces) {
      if (ws.review?.provider !== this.providerLabel || !ws.review?.prKey) continue;
      const key = ws.review.prKey;
      if (trackedPullRequests[key]) continue; // still active
      const existing = detailMap[key];
      if (existing && hooks.isPrResolved(existing)) continue; // already resolved
      const conn = connections.find((c) => c.id === ws.review!.connectionId);
      const token = conn && this.credentialStore.getSecret(conn.tokenRef || "");
      if (!conn || !token) continue;
      const resolved = await hooks.resolveStalePr(ws, existing, conn, token);
      if (resolved) detailMap[key] = resolved;
    }

    for (const [key, tracked] of Object.entries(trackedPullRequests)) {
      await this.reviewStore.upsertTrackedPullRequest(key, tracked);
    }

    // Collapse PRs that several connections fetched independently (e.g.
    // 3 connections to the same org/repo → same PR 3× otherwise). The
    // per-connection trackedPullRequests / detailMap are kept intact; dedup
    // applies only to the inbox views the user sees.
    const dedupedSummaries = dedupePrSummaries(visibleSummaries);
    const snapshot: ProviderSnapshot = {
      ...this.snapshot,
      connections: connectionSnapshots as unknown as ProviderSnapshot["connections"],
      inbox: buildInboxViews(dedupedSummaries),
      trackedPullRequests,
      pullRequests: detailMap,
      reviewActivity: appendReviewActivity(this.snapshot.reviewActivity, newActivityEvents),
      sync: {
        running: false,
        lastStartedAt: startedAt,
        lastCompletedAt: new Date(this.now()).toISOString(),
      },
    };
    this.setSnapshot(snapshot);
    return this.getSnapshot();
  }

  stopPolling(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  configurePolling(intervalMs: number, callback: () => Promise<void>): void {
    this.stopPolling();
    if (intervalMs > 0 && typeof callback === "function") {
      this.syncTimer = setInterval(() => {
        callback().catch(() => {});
      }, intervalMs);
    }
  }

  findSummary(prKey: string): PrSummaryItem | null {
    const all = [
      ...this.snapshot.inbox.needsMyReview,
      ...this.snapshot.inbox.myPullRequests,
      ...this.snapshot.inbox.recentlyUpdated,
      ...this.snapshot.inbox.needsAttention,
    ];
    return all.find((item) => item.prKey === prKey) || null;
  }

  findConnection(connectionId: string): SnapshotConnection | null {
    return this.snapshot.connections.find((connection) => connection.id === connectionId) || null;
  }

  resolveConnectionAndToken(connectionId: string): { connection: SnapshotConnection; token: string } {
    const connection = this.findConnection(connectionId);
    if (!connection) throw new Error(`${this.providerLabel} connection was not found.`);
    const token = this.credentialStore.getSecret(connection.tokenRef || "");
    if (!token) throw new Error("PAT is missing.");
    return { connection, token };
  }

  async markPullRequestSeen(prKey: string): Promise<ProviderSnapshot | undefined> {
    const summary = this.findSummary(prKey) || this.snapshot.pullRequests[prKey];
    if (!summary) {
      this.log.warn("markPullRequestSeen: PR not in snapshot, skipping", { prKey });
      return;
    }
    const lastSeenActivityAt = summary.lastRemoteActivityAt || new Date(this.now()).toISOString();
    await this.reviewStore.upsertTrackedPullRequest(prKey, {
      lastSeenActivityAt,
      reviewWorkspaceId: summary.reviewWorkspaceId || "",
    });
    if (this.reviewBridgeStore?.markPullRequestSeen) {
      try {
        await this.reviewBridgeStore.markPullRequestSeen(prKey, lastSeenActivityAt);
      } catch (error) {
        this.log.warn("review bridge mark-seen failed", { prKey, err: (error as Error).message || String(error) });
      }
    }

    const nextPullRequest = {
      ...(this.snapshot.pullRequests[prKey] || summary),
      lastSeenActivityAt,
      hasAttention: false,
      attentionReason: "",
      newCommentsCount: 0,
    };

    const updateSummaryList = (items: PrSummaryItem[]): PrSummaryItem[] =>
      items.map((item) =>
        item.prKey === prKey
          ? { ...item, lastSeenActivityAt, hasAttention: false, attentionReason: "", newCommentsCount: 0 }
          : item,
      );

    this.setSnapshot({
      ...this.snapshot,
      pullRequests: { ...this.snapshot.pullRequests, [prKey]: nextPullRequest },
      inbox: {
        needsMyReview: updateSummaryList(this.snapshot.inbox.needsMyReview),
        myPullRequests: updateSummaryList(this.snapshot.inbox.myPullRequests),
        recentlyUpdated: updateSummaryList(this.snapshot.inbox.recentlyUpdated),
        needsAttention: this.snapshot.inbox.needsAttention.filter((item) => item.prKey !== prKey),
      },
      trackedPullRequests: {
        ...this.snapshot.trackedPullRequests,
        [prKey]: { ...(this.snapshot.trackedPullRequests[prKey] || {}), lastSeenActivityAt },
      },
    });
    return this.getSnapshot();
  }

  seedPullRequestSummary(prKey: string, summary: PrSummaryItem): void {
    if (this.snapshot.pullRequests[prKey] || this.findSummary(prKey)) return;
    this.setSnapshot({
      ...this.snapshot,
      pullRequests: { ...this.snapshot.pullRequests, [prKey]: summary },
    });
  }

  async listLocalChangedFiles(cwd: string, targetRefName: string): Promise<{ changeType: string; path: string }[]> {
    const targetBranch = stripRefsPrefix(targetRefName);
    const result = await this.execFileText("git", ["diff", "--name-status", `origin/${targetBranch}...HEAD`], { cwd });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [changeType = "", ...rest] = line.split(/\s+/);
        return { changeType, path: rest.join(" ") };
      });
  }

  async runGit(
    cwd: string,
    args: string[],
    { login, token }: RunGitOptions = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const extraArgs: string[] = [];
    if (process.platform === "win32") {
      extraArgs.push("-c", "core.longpaths=true");
    }
    const effectiveLogin = login ?? this.defaultGitLogin;
    let env = sanitizeGitEnvironment();
    if (token) {
      // git >= 2.31 takes the header from the environment, keeping the token off the
      // command line; older (or unidentifiable) gits get `-c http.extraheader=…`.
      if (await this.supportsGitConfigEnv()) {
        env = gitAuthEnvironment(effectiveLogin, token, env);
      } else {
        extraArgs.push("-c", `http.extraheader=${encodeAuthHeader(effectiveLogin, token)}`);
      }
    }
    // Log only user-visible args (the argv fallback's extraArgs contain credentials)
    this.log.debug(`git ${args.join(" ")}`, { cwd });
    try {
      return await this.execFileText("git", [...extraArgs, ...args], {
        cwd,
        env,
      });
    } catch (error) {
      // Sanitize credentials from error output before re-throwing
      const sanitize = (text: string | undefined): string | undefined => {
        if (!text) return text;
        return String(text).replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic ***");
      };
      // execFileText rejects with a plain { error, stdout, stderr } object.
      // Electron IPC cannot serialize plain objects into error messages, so
      // convert to a proper Error with the stderr/message as the message.
      const err = error as { stderr?: string; stdout?: string; error?: { message?: string }; message?: string };
      const stderr = sanitize(err.stderr);
      const innerMsg = sanitize(err.error?.message || err.message);
      const msg = stderr || innerMsg || "Git command failed";
      this.log.warn(`git ${args[0]} failed`, { cwd, msg });
      const wrapped = new Error(msg) as Error & { stdout?: string; stderr?: string };
      wrapped.stdout = sanitize(err.stdout);
      wrapped.stderr = stderr;
      throw wrapped;
    }
  }

  /**
   * Ensure a bare-ish cache clone of a repository exists under
   * `<reviewRoot>/repos/<connection>/<repository>`, cloning it if not.
   *
   * Shared body of AzureDevOpsManager.ensureCacheRepo / GitHubManager.ensureCacheRepo
   * — those methods differ only in how they derive `repoIdentifier` (Azure:
   * repository.id||name; GitHub: `${owner}/${repo}`), `repoLabel` (used only in
   * the fallback warn log), and `login` (Azure passes connection.login; GitHub
   * omits it and relies on runGit's defaultGitLogin="x-access-token"). Each
   * manager's own `ensureCacheRepo` keeps its existing public signature and
   * delegates here.
   *
   * `reviewRoot` must already be normalized by the caller (each provider's
   * `normalizeReviewRoot` bakes in a different default root — azure-pr vs
   * github-pr — so that fallback can't live in this shared, provider-agnostic
   * method).
   *
   * Partial clone (`--filter=blob:none`) keeps the first checkout fast on
   * large repos — blobs are fetched lazily. Older/self-hosted servers may not
   * support promisor filters, so fall back to a full clone if the filtered
   * one fails.
   */
  async ensureCacheRepoAt({
    connectionId,
    repoIdentifier,
    repoLabel,
    remoteUrl,
    reviewRoot,
    token,
    login,
  }: {
    connectionId: string;
    repoIdentifier: string;
    repoLabel: string;
    remoteUrl: string;
    reviewRoot: string;
    token: string;
    login?: string;
  }): Promise<string> {
    const repositoryRoot = path.join(
      reviewRoot,
      "repos",
      shortPathKey(connectionId, "connection"),
      shortPathKey(repoIdentifier, "repository"),
    );
    const repositoryExists = await exists(path.join(repositoryRoot, ".git"));
    await mkdir(path.dirname(repositoryRoot), { recursive: true });
    if (!repositoryExists) {
      try {
        await this.runGit(process.cwd(), ["clone", "--no-checkout", "--filter=blob:none", remoteUrl, repositoryRoot], {
          login,
          token,
        });
      } catch (error) {
        this.log.warn("partial clone failed, retrying with full clone", {
          repository: repoLabel,
          err: (error as Error)?.message || String(error),
        });
        await rm(repositoryRoot, { recursive: true, force: true }).catch(() => {});
        await this.runGit(process.cwd(), ["clone", "--no-checkout", remoteUrl, repositoryRoot], { login, token });
      }
    }
    return repositoryRoot;
  }

  /**
   * Fetch the PR's source/target refs into the cache repo and ensure a
   * worktree checked out to `localBranch` exists at `worktreePath`.
   *
   * Shared body of AzureDevOpsManager.prepareManagedReviewCheckout /
   * GitHubManager.prepareManagedReviewCheckout's worktree-ensure step — those
   * methods differ only in how they derive `fetchRefspecs` (Azure fetches the
   * PR's raw sourceRefName/targetRefName as-is; GitHub reconstructs
   * `refs/heads/<branch>`) and `login` (Azure passes connection.login; GitHub
   * relies on runGit's defaultGitLogin).
   *
   * A reused local branch is only ever moved when no commit can be lost: it is
   * fast-forwarded when it is behind the remote. A branch that is ahead of, or
   * diverged from, the remote is left exactly as it is — there is no persisted
   * baseline yet at this point (the workspace is being created), so nothing
   * proves those commits are orphans, and role does not either. The user's
   * first Refresh then shows the commits and asks before discarding any.
   */
  async ensureManagedWorktree({
    cacheRepoPath,
    worktreePath,
    localBranch,
    sourceBranch,
    fetchRefspecs,
    login,
    token,
  }: {
    cacheRepoPath: string;
    worktreePath: string;
    localBranch: string;
    sourceBranch: string;
    fetchRefspecs: string[];
    login?: string;
    token: string;
  }): Promise<void> {
    // The cache repo is a regular clone, so its common dir is `<cache>/.git` —
    // the same canonical key the review Git engine locks on from a worktree.
    await this.reviewGitLocks.withCommon(path.join(cacheRepoPath, ".git"), async () => {
      await this.runGit(cacheRepoPath, ["fetch", "origin", ...fetchRefspecs], { login, token });

      await mkdir(path.dirname(worktreePath), { recursive: true });
      await this.runGit(cacheRepoPath, ["worktree", "prune"]).catch(() => {});
      const worktreeExists = await exists(path.join(worktreePath, ".git"));
      const remoteRef = `refs/remotes/origin/${sourceBranch}`;

      if (!worktreeExists) {
        const branchExists = await this.runGit(cacheRepoPath, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${localBranch}`,
        ])
          .then(() => true)
          .catch(() => false);

        if (branchExists) {
          await this.runGit(cacheRepoPath, ["worktree", "add", "--force", worktreePath, localBranch]);
          await this.fastForwardReusedBranch(worktreePath, remoteRef, localBranch);
        } else {
          await this.runGit(cacheRepoPath, ["worktree", "add", "--force", "-b", localBranch, worktreePath, remoteRef]);
        }
      } else {
        await this.runGit(worktreePath, ["checkout", localBranch]).catch(async () => {
          await this.runGit(worktreePath, ["checkout", "-B", localBranch, remoteRef]);
        });
        await this.fastForwardReusedBranch(worktreePath, remoteRef, localBranch);
      }
    });
  }

  private async fastForwardReusedBranch(worktreePath: string, remoteRef: string, localBranch: string): Promise<void> {
    const status = await this.runGit(worktreePath, ["status", "--porcelain"]);
    // Edits in progress are never something to move HEAD under.
    if (status.stdout.trim()) return;
    const head = (await this.runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
    const remote = (await this.runGit(worktreePath, ["rev-parse", remoteRef])).stdout.trim();
    const relation = await compareCommits(
      (cwd, args, auth) => this.runGit(cwd, args, auth),
      worktreePath,
      head,
      remote,
    );
    if (relation === "behind") {
      await this.runGit(worktreePath, ["merge", "--ff-only", remote]);
    } else if (relation === "ahead" || relation === "diverged") {
      this.log.info("reused review branch has local commits; leaving it for Refresh to ask about", {
        localBranch,
        relation,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Review Git operations — one state-based flow for the UI and the MCP broker
  // ---------------------------------------------------------------------------

  setReviewWorkspaceMetadataStore(store: ReviewWorkspaceMetadataStore | null): void {
    this.reviewMetadataStore = store;
  }

  setReviewGitLocks(locks: ReviewGitLocks): void {
    this.reviewGitLocks = locks;
    this.reviewGitEngine = null;
  }

  getReviewGitEngine(): ReviewGitEngine {
    if (!this.reviewGitEngine) {
      this.reviewGitEngine = createReviewGitEngine({
        git: (cwd, args, auth) => this.runGit(cwd, args, { login: auth?.login, token: auth?.token }),
        locks: this.reviewGitLocks,
        audit: this.createReviewGitAudit(),
        persistBaseline: async (subject, sha) => {
          if (!this.reviewMetadataStore) throw new Error("No review metadata store is configured.");
          await this.reviewMetadataStore.updateReview(subject.workspaceId, {
            sourceBaselineSha: sha,
            ...(subject.sourceRepository ? { sourceRepository: subject.sourceRepository } : {}),
            expectedIdentityKey: reviewSourceIdentityKey({
              provider: subject.provider,
              connectionId: subject.connectionId,
              prKey: subject.prKey,
              pullRequest: { sourceRefName: subject.sourceRefName } as ReviewInfo["pullRequest"],
              sourceRepository: subject.sourceRepository,
            }),
          });
        },
        log: this.log,
        now: this.now,
      });
    }
    return this.reviewGitEngine;
  }

  private createReviewGitAudit() {
    const writeKinds = new Set([
      "push",
      "force-push",
      "sync-reset",
      "sync-merge",
      "rebase",
      "commit",
      "stage",
      "unstage",
      "continue",
      "skip",
      "abort",
    ]);
    return {
      begin: (entry: {
        operationId: string;
        kind: string;
        subject: ReviewGitSubject;
        requester: ReviewGitRequester;
        refs: Record<string, string>;
      }): unknown | null => {
        const store = this.auditLogStore;
        if (!store?.insertEntry) return null;
        const { subject, requester } = entry;
        const connection = this.findConnection(subject.connectionId) as
          (SnapshotConnection & { orgUrl?: string; hostUrl?: string; baseUrl?: string; label?: string }) | null;
        const id = store.insertEntry({
          timestamp: new Date(this.now()).toISOString(),
          connectionId: subject.connectionId,
          organization: String(
            connection?.orgUrl || connection?.hostUrl || connection?.baseUrl || connection?.label || "",
          ),
          project: "",
          operation: `git${entry.kind.charAt(0).toUpperCase()}${entry.kind.slice(1)}`,
          category: writeKinds.has(entry.kind) ? "write" : "read",
          method: "GIT",
          url: "",
          statusCode: null,
          success: false,
          errorMessage: "started; outcome not yet recorded",
          durationMs: null,
          resourceType: "git",
          resourceId: subject.workspaceId,
          summary: `git ${entry.kind} (review workspace)`,
          userInitiated: requester.source === "ui",
          operationId: entry.operationId,
          details: JSON.stringify({
            workspaceId: subject.workspaceId,
            profileId: subject.profileId,
            provider: subject.provider,
            prKey: subject.prKey,
            connectionId: subject.connectionId,
            sourceRef: subject.sourceRefName,
            sourceRepository: subject.sourceRepository?.fullName || subject.sourceRepository?.remoteUrl || "",
            requester: {
              source: requester.source,
              agent: requester.agent || "",
              panelId: requester.panelId || "",
              reportedConsent: requester.consent || "",
            },
            refs: entry.refs,
            outcome: "started",
          }),
        });
        return id === null || id === undefined ? null : { id, startedAt: this.now() };
      },
      finish: (
        handle: unknown,
        outcome: { success: boolean; outcome: string; errorMessage?: string; refs?: Record<string, string> },
      ) => {
        const store = this.auditLogStore;
        const { id, startedAt } = handle as { id: number; startedAt: number };
        if (!store?.finishEntry) return false;
        return store.finishEntry(id, {
          success: outcome.success,
          errorMessage: outcome.errorMessage || null,
          durationMs: this.now() - startedAt,
          details: { outcome: outcome.outcome, ...(outcome.refs ? { resultRefs: outcome.refs } : {}) },
        });
      },
    };
  }

  /** Build the engine's view of one PR-linked checkout from persisted state plus the live provider snapshot. */
  buildReviewSubject(workspace: ReviewWorkspaceRef): ReviewGitSubject {
    const review = workspace.review;
    if (!review) throw new Error("This workspace is not linked to a pull request.");
    const connection = this.findConnection(review.connectionId || "");
    if (!connection) throw new Error(this.connectionNotFoundMessage);
    // Profile-aware: a workspace never borrows the credentials of another profile's connection.
    const connectionProfile = (connection as { profileId?: string }).profileId;
    const workspaceProfile = workspace.profileId || "default";
    if (connectionProfile && connectionProfile !== workspaceProfile) {
      throw new Error(
        `Cross-profile refused: connection ${connection.id} is in profile ${connectionProfile}, the workspace is in ${workspaceProfile}.`,
      );
    }
    const token = this.credentialStore.getSecret(connection.tokenRef || "");
    if (!token) throw new Error("PAT is missing.");
    const cwd = workspace.cwd || "";
    if (!cwd) throw new Error("Review workspace has no working directory.");
    const summary = (
      review.prKey ? this.findSummary(review.prKey) || this.snapshot.pullRequests[review.prKey] : null
    ) as {
      sourceRepository?: ReviewSourceRepository | null;
    } | null;
    // The live provider snapshot knows better than the persisted copy whether the PR is still open.
    const prInfo = ((summary as { pullRequest?: Record<string, unknown> } | null)?.pullRequest ||
      review.pullRequest ||
      {}) as {
      status?: string;
      state?: string;
      mergedAt?: string | null;
      closedAt?: string | null;
      targetRefName?: string | null;
    };
    const prStatus = String(prInfo.status || prInfo.state || "").toLowerCase();
    const pullRequestClosed = prInfo.mergedAt
      ? "merged"
      : ["abandoned", "completed", "closed", "merged"].includes(prStatus)
        ? prStatus
        : prInfo.closedAt
          ? "closed"
          : "";
    const persistedKey = reviewSourceIdentityKey(review as Partial<ReviewInfo>);
    const liveKey = summary
      ? reviewSourceIdentityKey({
          provider: review.provider,
          connectionId: review.connectionId,
          prKey: review.prKey,
          pullRequest: (summary as { pullRequest?: ReviewInfo["pullRequest"] }).pullRequest ?? null,
          sourceRepository: summary.sourceRepository,
        })
      : "";
    return {
      workspaceId: workspace.id,
      profileId: workspace.profileId || "default",
      cwd,
      provider: review.provider || this.providerLabel,
      connectionId: review.connectionId || "",
      prKey: review.prKey || "",
      prId: review.pullRequest?.id ?? review.pullRequest?.number ?? "",
      role: review.role || "",
      sourceRefName: review.pullRequest?.sourceRefName || "",
      // The live target wins: a provider-side retarget must be seen by the next
      // proposal (and invalidate one still open), not wait for the PR to be reopened.
      targetRefName: prInfo.targetRefName || review.pullRequest?.targetRefName || "",
      sourceRepository: review.sourceRepository || summary?.sourceRepository || null,
      targetRemoteUrl: review.repository?.remoteUrl || "",
      baselineSha: review.sourceBaselineSha || "",
      ...(pullRequestClosed ? { pullRequestClosed } : {}),
      ...(persistedKey && liveKey && persistedKey !== liveKey
        ? {
            identityConflict: `${review.sourceRepository?.fullName || "recorded source"} → ${(summary as { sourceRepository?: ReviewSourceRepository | null }).sourceRepository?.fullName || "current source"}`,
          }
        : {}),
      checkout: (review.checkout as ReviewGitSubject["checkout"]) || null,
      auth: { login: connection.login, token },
    };
  }

  /**
   * Initialize a missing baseline for a workspace that is about to be saved
   * (a new managed checkout, or "Work here" onto an existing one) — only when
   * Git and the provider prove the live source tip is incorporated. A failure
   * to prove leaves the baseline unknown; it never blocks opening the review.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async withProvenBaseline(workspace: any): Promise<any> {
    const review = workspace?.review;
    if (!review || review.sourceBaselineSha) return workspace;
    try {
      const sha = await this.getReviewGitEngine().proveBaseline(this.buildReviewSubject(workspace));
      if (sha) return { ...workspace, review: { ...review, sourceBaselineSha: sha } };
    } catch (error) {
      this.log.warn("source baseline could not be proven; leaving it unknown", {
        workspaceId: workspace.id,
        err: (error as Error)?.message || String(error),
      });
    }
    return workspace;
  }

  private reviewRequester(requester?: ReviewGitRequester): ReviewGitRequester {
    return requester || { source: "ui" };
  }

  /** Shared body of AzureDevOpsManager.fetchReviewWorkspace / GitHubManager.fetchReviewWorkspace. */
  async fetchReviewWorkspace({
    workspace,
    requester,
  }: {
    workspace: ReviewWorkspaceRef;
    requester?: ReviewGitRequester;
  }): Promise<ReviewGitResult> {
    this.log.info("fetch review workspace", { workspaceId: workspace.id });
    return this.getReviewGitEngine().fetch(this.buildReviewSubject(workspace), this.reviewRequester(requester));
  }

  /** Rebase onto the PR TARGET branch. Asks for confirmation first; never touches the source baseline. */
  async rebaseReviewWorkspace({
    workspace,
    requester,
    confirmation,
  }: {
    workspace: ReviewWorkspaceRef;
    requester?: ReviewGitRequester;
    confirmation?: ReviewGitConfirmation;
  }): Promise<ReviewGitResult> {
    this.log.info("rebase review workspace", { workspaceId: workspace.id });
    return this.getReviewGitEngine().rebase(
      this.buildReviewSubject(workspace),
      this.reviewRequester(requester),
      confirmation,
    );
  }

  /**
   * Push HEAD to the PR SOURCE ref in the verified source repository — never
   * to `origin` by assumption, never to the local branch alias. Regular push
   * needs a fast-forward; force push is explicit and leases the exact live SHA.
   */
  async pushReviewWorkspace({
    workspace,
    force = false,
    requester,
    confirmation,
    requireProposal = false,
  }: {
    workspace: ReviewWorkspaceRef;
    force?: boolean;
    requester?: ReviewGitRequester;
    confirmation?: ReviewGitConfirmation;
    /** Describe the push first and only run it when the continuation names that proposal. */
    requireProposal?: boolean;
  }): Promise<ReviewGitResult> {
    this.log.info("push review workspace", { workspaceId: workspace.id, force });
    return this.getReviewGitEngine().push(this.buildReviewSubject(workspace), this.reviewRequester(requester), {
      force,
      confirmation,
      requireProposal,
    });
  }

  /**
   * Bring a review checkout up to the PR's latest source commit — the Refresh
   * button's git-mutating half. The exact live source SHA is pinned, then:
   * equal → nothing; fast-forwardable → fast-forward; HEAD exactly equal to the
   * persisted baseline (nothing local on top of the last integrated source
   * state) → reset after a recovery ref; anything else that would discard
   * commits → a confirmation proposal. Dirty trees and active operations block.
   * The same flow serves the UI and the MCP broker; role never decides it.
   */
  async syncReviewWorkspace({
    workspace,
    requester,
    confirmation,
  }: {
    workspace: ReviewWorkspaceRef;
    requester?: ReviewGitRequester;
    confirmation?: ReviewGitConfirmation;
  }): Promise<ReviewWorkspaceSyncResult> {
    this.log.info("sync review workspace", { workspaceId: workspace.id });
    return this.getReviewGitEngine().refresh(
      this.buildReviewSubject(workspace),
      this.reviewRequester(requester),
      confirmation,
    );
  }

  /**
   * Shared body of AzureDevOpsManager.openReviewWorkspace / GitHubManager.openReviewWorkspace:
   * resolve the connection + cross-profile guard, find (or create) the review
   * workspace, and track it as the PR's seen workspace. Providers supply the
   * 3 genuinely-divergent pieces via `hooks` (PR-detail fetch, checkout
   * creation, and the `review` metadata shape) — everything else here is the
   * line-for-line identical construction both managers used to carry as
   * their own copy.
   */
  async openReviewWorkspaceCore(
    {
      state,
      prKey,
      workspaceId = "",
      callerProfileId = "",
      forceReview = false,
      isolated = false,
    }: OpenReviewWorkspaceOptions,
    hooks: OpenReviewWorkspaceHooks,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ workspace: any; created: boolean; attached: boolean }> {
    const summary = await hooks.ensurePullRequestDetail(prKey, { workspaces: state.workspaces });
    const connection = this.findConnection(summary.connectionId);
    if (!connection) throw new Error(this.connectionNotFoundMessage);
    const token = this.credentialStore.getSecret(connection.tokenRef || "");
    if (!token) throw new Error("PAT is missing.");

    // The review workspace belongs to the same profile as its connection.
    // Using windowSlots[0]?.profileId as "active" silently lands the review
    // on the wrong profile when the user clicked from a non-primary window.
    const connectionProfileId = (connection as { profileId?: string }).profileId || "";
    // Refuse upfront when the caller's window is bound to a different
    // profile than the connection. Previously we just suppressed the slot
    // mirror, but the PR review checkout (cloned repo on disk) still
    // happened in the foreign profile.
    if (callerProfileId && connectionProfileId && callerProfileId !== connectionProfileId) {
      throw new Error(
        `Cross-profile refused: connection ${connection.id} is in profile ${connectionProfileId}, caller window is bound to ${callerProfileId}.`,
      );
    }
    const activeProfile = connectionProfileId || callerProfileId || "default";
    const profileWorkspaces = state.workspaces.filter((ws) => (ws.profileId || "default") === activeProfile);
    // An author whose checkout already sits on the PR's source branch is
    // offered that workspace as the attach target — but only when the caller
    // did not explicitly ask for a review checkout. Without the forceReview
    // gate the row's "Review" button would silently attach instead, since
    // "no workspaceId" is exactly what the Attach button sends too.
    const existingWorkspace = isolated
      ? null
      : (workspaceId
          ? profileWorkspaces.find((workspace) => workspace.id === workspaceId)
          : hooks.findWorkspaceForPullRequest(profileWorkspaces, prKey) ||
            (!forceReview && summary.role === "author" && summary.existingWorkspaceId
              ? profileWorkspaces.find((workspace) => workspace.id === summary.existingWorkspaceId)
              : null)) || null;

    const reviewProfileId = existingWorkspace?.profileId || activeProfile;
    const parentWorkspace =
      state.workspaces.find(
        (workspace) =>
          workspace.kind === this.parentWorkspaceKind && (workspace.profileId || "default") === reviewProfileId,
      ) || null;
    const parentWorkspaceId = parentWorkspace?.id || existingWorkspace?.review?.parentWorkspaceId || "";

    if (existingWorkspace) {
      if (!String(existingWorkspace.cwd || "").trim()) {
        throw new Error(
          `Matched workspace "${existingWorkspace.name || existingWorkspace.id}" does not have a working directory.`,
        );
      }
      const checkout = existingWorkspace.review?.checkout || {
        mode:
          existingWorkspace.review?.provider === this.providerLabel ? "managed-worktree" : "linked-existing-workspace",
        rootPath: existingWorkspace.cwd || "",
        cacheRepoPath: "",
      };
      const workspace = {
        ...existingWorkspace,
        review: hooks.buildReviewMetadata(summary, checkout, {
          parentWorkspaceId: checkout.mode === "managed-worktree" ? parentWorkspaceId : "",
          previousReview: existingWorkspace.review,
        }),
      };
      await this.reviewStore.upsertTrackedPullRequest(prKey, {
        reviewWorkspaceId: workspace.id,
        lastSeenActivityAt: summary.lastRemoteActivityAt || new Date(this.now()).toISOString(),
      });
      return {
        workspace: await this.withProvenBaseline(workspace),
        created: false,
        attached: checkout.mode === "linked-existing-workspace",
      };
    }

    const checkout = await hooks.prepareManagedReviewCheckout({
      summary,
      connection,
      token,
      reviewRoot:
        parentWorkspace?.cwd || (connection as { reviewRoot?: string }).reviewRoot || this.getDefaultReviewRoot(),
      ...(isolated ? { isolatedId: randomUUID() } : {}),
    });
    const panels = createReviewWorkspacePanels(
      (parentWorkspace?.panels || []) as PanelTemplate[],
      (state.tabTemplates || []) as PanelTemplate[],
    );
    const label = hooks.formatPrLabel(summary);
    const workspace = {
      id: `workspace-${randomUUID()}`,
      name: label,
      icon: this.reviewIcon,
      color: this.reviewColor,
      kind: "terminal",
      source: "manual",
      pluginId: "",
      cwd: checkout.rootPath,
      notes: `${this.providerDisplayName} review workspace for ${label}`,
      // Land the review workspace on the same profile as its provider parent /
      // its connection (already resolved as reviewProfileId above) — using
      // state.activeProfileId here puts the review on whatever profile the
      // user happens to be looking at, hiding it on the profile that owns
      // the connection.
      profileId: reviewProfileId,
      activePanelId: panels[0]?.id || "",
      panels,
      review: hooks.buildReviewMetadata(summary, checkout, { parentWorkspaceId: parentWorkspaceId || "" }),
    };
    await this.reviewStore.upsertTrackedPullRequest(prKey, {
      reviewWorkspaceId: workspace.id,
      lastSeenActivityAt: summary.lastRemoteActivityAt || new Date(this.now()).toISOString(),
    });
    return {
      workspace: await this.withProvenBaseline(workspace),
      created: true,
      attached: false,
    };
  }

  /**
   * Shared git/worktree mechanics of AzureDevOpsManager.prepareQuickFixCheckout
   * and GitHubManager's equivalent inline logic: fetch the base branch into
   * the cache repo, then create (or reuse) a worktree checked out to a new
   * branch off it. `ensureCacheRepo` is provided by the caller since each
   * provider's own `ensureCacheRepo` wrapper needs different identity fields
   * (Azure: repository object; GitHub: owner/repo).
   */
  async prepareQuickFixCheckout({
    connection,
    token,
    reviewRoot,
    baseBranch,
    newBranchName,
    repoPathSegment,
    login,
    ensureCacheRepo,
  }: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection: any;
    token: string;
    reviewRoot: string;
    baseBranch: string;
    newBranchName: string;
    repoPathSegment: string;
    login?: string;
    ensureCacheRepo: () => Promise<string>;
  }): Promise<{ rootPath: string; cacheRepoPath: string }> {
    const cacheRepoPath = await ensureCacheRepo();

    await this.runGit(
      cacheRepoPath,
      ["fetch", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
      { login, token },
    );

    const worktreePath = path.join(
      normalizeReviewRoot(reviewRoot, this.getDefaultReviewRoot()),
      "quickfix",
      shortPathKey(connection.id, "connection"),
      sanitizePathSegment(repoPathSegment),
      sanitizePathSegment(newBranchName),
    );
    await mkdir(path.dirname(worktreePath), { recursive: true });

    const worktreeExists = await exists(path.join(worktreePath, ".git"));
    if (!worktreeExists) {
      try {
        await this.runGit(cacheRepoPath, [
          "worktree",
          "add",
          "--force",
          "-b",
          newBranchName,
          worktreePath,
          `refs/remotes/origin/${baseBranch}`,
        ]);
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const msg = String(e?.stderr || e?.message || err);
        if (msg.includes("already exists")) {
          throw new Error(`Branch "${newBranchName}" already exists. Choose a different name.`, { cause: err });
        }
        throw err;
      }
    }

    return { rootPath: worktreePath, cacheRepoPath };
  }

  /**
   * Shared skeleton of AzureDevOpsManager.openQuickFixWorkspace /
   * GitHubManager.openQuickFixWorkspace: cross-profile guard, parent-workspace
   * resolution, and the common workspace envelope. Providers supply checkout
   * creation and the `review`/`quickfix` metadata shape via hooks — Azure's
   * 3-level project/repository/branch hierarchy and GitHub's 2-level
   * owner/repo hierarchy produce genuinely different metadata, so those stay
   * per-provider rather than being forced into one shape.
   */
  async openQuickFixWorkspaceCore(
    options: OpenQuickFixWorkspaceOptions,
    hooks: OpenQuickFixWorkspaceHooks,
  ): Promise<{ workspace: Record<string, unknown>; parentWorkspaceId: string }> {
    const { state, connectionId, baseBranch, newBranchName, callerProfileId = "" } = options;
    const { connection, token } = this.resolveConnectionAndToken(connectionId);

    // Pin quickfix to the profile that owns the connection — falling back to
    // active profile breaks when the user triggers quickfix from a different
    // profile than the one the connection lives on (the workspace lands on
    // the wrong profile and goes invisible).
    const connectionProfileId = (connection as { profileId?: string }).profileId || "";
    if (callerProfileId && connectionProfileId && callerProfileId !== connectionProfileId) {
      throw new Error(
        `Cross-profile refused: connection ${connection.id} is in profile ${connectionProfileId}, caller window is bound to ${callerProfileId}.`,
      );
    }
    const activeProfile = connectionProfileId || callerProfileId || "default";
    const parentWorkspace =
      state.workspaces.find(
        (ws) => ws.kind === this.parentWorkspaceKind && (ws.profileId || "default") === activeProfile,
      ) || null;
    const reviewRoot =
      parentWorkspace?.cwd || (connection as { reviewRoot?: string }).reviewRoot || this.getDefaultReviewRoot();

    const checkout = await hooks.prepareQuickFixCheckout({
      connection,
      token,
      reviewRoot,
      baseBranch,
      newBranchName,
      options,
    });

    const panels = createReviewWorkspacePanels(
      (parentWorkspace?.panels || []) as PanelTemplate[],
      (state.tabTemplates || []) as PanelTemplate[],
    );

    const { review, quickfix } = hooks.buildQuickFixMetadata({
      connection,
      checkout,
      parentWorkspaceId: parentWorkspace?.id || "",
      options,
    });

    const workspace: Record<string, unknown> = {
      id: `workspace-${randomUUID()}`,
      name: newBranchName,
      icon: this.reviewIcon,
      color: this.reviewColor,
      kind: "terminal",
      source: "manual",
      pluginId: "",
      cwd: checkout.rootPath,
      notes: "",
      profileId: activeProfile,
      activePanelId: panels[0]?.id || "",
      panels,
      review,
      quickfix,
    };

    return { workspace, parentWorkspaceId: parentWorkspace?.id || "" };
  }
}

/**
 * Build initial panel list for a review workspace from parent panels or tab templates.
 */
export function createReviewWorkspacePanels(
  panelTemplates: PanelTemplate[] = [],
  tabTemplates: PanelTemplate[] = [],
): Array<{
  id: string;
  title: string;
  command: string;
  launch: { file: string; args: string[] } | null;
  shell: boolean;
  startup: string;
}> {
  const selected: PanelTemplate[] = [];

  if (Array.isArray(panelTemplates) && panelTemplates.length) {
    selected.push(...panelTemplates);
  } else {
    const preferredTemplates = ["shell", "claude", "codex"];
    for (const templateId of preferredTemplates) {
      const template = tabTemplates.find((entry) => entry.id === templateId);
      if (template) selected.push(template);
    }

    if (!selected.length) selected.push(...tabTemplates.slice(0, 3));

    if (!selected.length) {
      selected.push(
        { title: "Shell", command: "" },
        { title: "Claude Code", command: "claude" },
        { title: "Codex", command: "codex" },
      );
    }
  }

  return selected.map((template, index) => ({
    id: `panel-${randomUUID()}`,
    title: template.title || (index === 0 ? "Shell" : `Panel ${index + 1}`),
    command: template.command || "",
    launch: template.launch ? { file: template.launch.file || "", args: [...(template.launch.args || [])] } : null,
    shell: template.shell !== false,
    startup: template.startup || (index === 0 ? "default" : "manual"),
  }));
}

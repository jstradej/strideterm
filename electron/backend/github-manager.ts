import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { execFileText } from "./process-utils.js";
import { createGitHubApi } from "./github-api.js";
import { BaseProviderManager, createReviewWorkspacePanels } from "./shared/base-manager.js";
import { classifyGitHubRequest, parseGitHubUrl } from "./github-audit-log-store.js";
import { buildPullRequestSummary, findWorkspaceForPullRequest } from "./github-pr-summary.js";
import {
  appendReviewActivity,
  buildConnectionErrorEvent,
  buildReviewActivityEvent,
  diffSignatureKeys,
  filterNewComments,
  parseGitHubReviewSignature,
  seedNotifiedTimestamp,
  shouldSeedConnection,
  truncateBody,
} from "./shared/review-activity.js";
import {
  GITHUB_REVIEW_ICON,
  GITHUB_REVIEW_COLOR,
  getDefaultReviewRoot,
  clone,
  sanitizePathSegment,
  normalizeReviewRoot,
  createPullRequestKey,
  stripRefsPrefix,
  parseDate,
  shortPathKey,
  formatReviewWorkspaceError,
  normalizeConnectionInput,
  createConnectionSnapshot,
  createEmptySnapshot,
  exists,
  buildRepositoryRemoteUrl,
} from "./github-utils.js";

interface SyncConnection {
  id: string;
  enabled?: boolean;
  tokenRef?: string;
  currentUserLogin?: string;
  ownerFilters?: string[];
  repositoryFilters?: string[];
  hostUrl?: string;
  reviewRoot?: string;
  [key: string]: unknown;
}

interface SyncWorkspace {
  id: string;
  cwd?: string;
  kind?: string;
  profileId?: string;
  panels?: unknown[];
  review?: {
    provider?: string;
    prKey?: string;
    connectionId?: string;
    repository?: { fullName?: string; owner?: string; name?: string; remoteUrl?: string };
    pullRequest?: {
      number?: number;
      id?: number;
      sourceRefName?: string;
      targetRefName?: string;
      [key: string]: unknown;
    } | null;
    checkout?: { mode?: string; rootPath?: string; cacheRepoPath?: string };
    parentWorkspaceId?: string;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

interface GitHubReviewStore {
  getState(): {
    connections?: Record<
      string,
      { status?: string; lastError?: string; lastSyncAt?: string | null; lastSuccessAt?: string | null }
    >;
    trackedPullRequests?: Record<string, Record<string, unknown>>;
  };
  getTrackedPullRequest(key: string): Record<string, unknown> | null;
  upsertTrackedPullRequest(key: string, patch: Record<string, unknown>): Promise<void>;
  upsertConnectionState(
    connectionId: string,
    patch: { status: string; lastError?: string; lastSyncAt?: string; lastSuccessAt?: string },
  ): Promise<void>;
}

interface SyncOptions {
  connections?: SyncConnection[];
  workspaces?: SyncWorkspace[];
  gitSnapshots?: Record<string, unknown>;
  activeProfileId?: string;
}

interface CheckItem {
  kind?: string;
  checkSuiteId?: string | number;
  [key: string]: unknown;
}

interface EnsureCacheRepoOptions {
  connection: SyncConnection;
  token: string;
  owner: string;
  repo: string;
  remoteUrl: string;
  reviewRoot: string;
}

interface PrepareManagedReviewCheckoutOptions {
  summary: Record<string, unknown>;
  connection: SyncConnection;
  token: string;
  reviewRoot: string;
}

interface OpenReviewWorkspaceOptions {
  state: {
    workspaces: SyncWorkspace[];
    windowSlots?: Array<{ profileId?: string }>;
    tabTemplates?: unknown[];
  };
  prKey: string;
  workspaceId?: string;
}

interface OpenQuickFixWorkspaceOptions {
  state: {
    workspaces: SyncWorkspace[];
    windowSlots?: Array<{ profileId?: string }>;
    tabTemplates?: unknown[];
  };
  connectionId: string;
  owner: string;
  repo: string;
  remoteUrl: string;
  baseBranch: string;
  newBranchName: string;
}

interface DetectDeltasOptions {
  tracked: Record<string, unknown>;
  summary: Record<string, unknown>;
  internals: Record<string, unknown>;
  seedingConnection: boolean;
}

export class GitHubManager extends BaseProviderManager {
  declare reviewStore: GitHubReviewStore;
  constructor(
    {
      credentialStore,
      reviewStore,
      reviewBridgeStore = null,
      auditLogStore = null,
      fetchImpl = globalThis.fetch,
      execFileTextImpl = execFileText,
      now = () => Date.now(),
    }: {
      credentialStore: ConstructorParameters<typeof BaseProviderManager>[0]["credentialStore"];
      reviewStore: GitHubReviewStore;
      reviewBridgeStore?: ConstructorParameters<typeof BaseProviderManager>[0]["reviewBridgeStore"];
      auditLogStore?: ConstructorParameters<typeof BaseProviderManager>[0]["auditLogStore"];
      fetchImpl?: typeof globalThis.fetch;
      execFileTextImpl?: typeof execFileText;
      now?: () => number;
    } = {} as never,
  ) {
    super({
      credentialStore,
      reviewStore,
      reviewBridgeStore,
      auditLogStore,
      fetchImpl,
      execFileTextImpl,
      now,
      createApi: createGitHubApi,
    });
    this.providerLabel = "github";
    this.defaultGitLogin = "x-access-token";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override _logAudit(raw: any): void {
    if (!this.auditLogStore) return;
    const classification = classifyGitHubRequest(raw.method, raw.url);
    const urlInfo = parseGitHubUrl(raw.url);
    this.auditLogStore.logEntry({
      ...classification,
      timestamp: new Date().toISOString(),
      connectionId: this._auditConnectionId,
      owner: urlInfo.owner,
      repository: urlInfo.repository,
      method: raw.method || "GET",
      url: raw.url || "",
      statusCode: raw.statusCode,
      success: raw.success !== false,
      errorMessage: raw.errorMessage || null,
      durationMs: raw.durationMs ?? null,
      userInitiated: this._auditUserInitiated,
    });
  }

  // ---------------------------------------------------------------------------
  // Connection verification
  // ---------------------------------------------------------------------------

  async verifyConnection(connectionInput: Record<string, unknown>): Promise<{
    ok: boolean;
    login: string;
    name: string;
    avatarUrl: string;
    hostUrl: string;
  }> {
    this.setAuditContext({ connectionId: String(connectionInput.id || ""), userInitiated: true });
    const connection = normalizeConnectionInput(connectionInput as Parameters<typeof normalizeConnectionInput>[0]);
    const token = String(connectionInput.pat || "").trim();
    if (!connection.hostUrl || !token) {
      throw new Error("Host URL and PAT are required.");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = this.api as any;
    const user = await api.getAuthenticatedUser(connection, token);
    return {
      ok: true,
      login: user.login,
      name: user.name || user.login,
      avatarUrl: user.avatar_url || "",
      hostUrl: connection.hostUrl,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Sync (inbox polling)
  // ---------------------------------------------------------------------------

  async sync({
    connections = [],
    workspaces = [],
    gitSnapshots = {},
    activeProfileId = "default",
  }: SyncOptions = {}): Promise<Record<string, unknown>> {
    const reviewState = this.reviewStore.getState();
    const startedAt = new Date(this.now()).toISOString();
    const connectionsChanged =
      JSON.stringify(connections.map((c) => c.id).sort()) !==
      JSON.stringify((this.snapshot.connections || []).map((c) => c.id).sort());
    this.snapshot = {
      ...(connectionsChanged ? (createEmptySnapshot() as typeof this.snapshot) : this.snapshot),
      connections,
      sync: {
        ...this.snapshot.sync,
        running: true,
        lastStartedAt: startedAt,
      },
    };
    this.emitUpdated();

    const connectionSnapshots: Record<string, unknown>[] = [];
    const visibleSummaries: Record<string, unknown>[] = [];
    const detailMap: Record<string, Record<string, unknown>> = { ...this.snapshot.pullRequests };
    const trackedPullRequests: Record<string, Record<string, unknown>> = {};
    const newActivityEvents: unknown[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = this.api as any;

    for (const connection of connections.filter((c) => c.enabled !== false)) {
      this.setAuditContext({ connectionId: connection.id, userInitiated: false });
      const persistedState = reviewState.connections?.[connection.id] || {};
      const connectionSnapshot = createConnectionSnapshot(connection, persistedState);
      connectionSnapshots.push(connectionSnapshot);
      const seedingConnection = shouldSeedConnection(this._seededConnections, connection.id);

      try {
        const token = this.credentialStore.getSecret(connection.tokenRef || "");
        if (!token) throw new Error("PAT is missing.");

        const login = connection.currentUserLogin;
        if (!login) throw new Error("GitHub login is not configured. Re-verify the connection.");

        // Build search queries for inbox
        const ownerScope = connection.ownerFilters?.length
          ? connection.ownerFilters.map((o) => `org:${o}`).join(" ")
          : "";

        const repoScope = connection.repositoryFilters?.length
          ? connection.repositoryFilters.map((r) => `repo:${r}`).join(" ")
          : "";

        const scope = repoScope || ownerScope;

        const queries = [
          `is:pr is:open archived:false review-requested:${login} ${scope}`.trim(),
          `is:pr is:open archived:false author:${login} ${scope}`.trim(),
        ];

        const seenPrKeys = new Set<string>();

        for (const query of queries) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const searchResults: any[] = await api.searchPullRequests(connection, token, query);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const item of searchResults as any[]) {
            const prUrl = item.pull_request?.url;
            if (!prUrl) continue;

            // Extract owner/repo from the search result
            const repoFullName = item.repository_url?.split("/repos/")[1] || "";
            const [prOwner, prRepo] = repoFullName.split("/");
            if (!prOwner || !prRepo) continue;

            const pullNumber = item.number;
            const prKey = createPullRequestKey(connection.id, prOwner, prRepo, pullNumber);
            if (seenPrKeys.has(prKey)) continue;
            seenPrKeys.add(prKey);

            // Fetch full PR detail
            const pr = await api.getPullRequest(connection, token, prOwner, prRepo, pullNumber);

            // Fetch reviews, review comments, issue comments, requested reviewers
            const [reviews, reviewComments, issueCommentsList, requestedReviewers] = await Promise.all([
              api.listReviews(connection, token, prOwner, prRepo, pullNumber).catch(() => []),
              api.listReviewComments(connection, token, prOwner, prRepo, pullNumber).catch(() => []),
              api.listIssueComments(connection, token, prOwner, prRepo, pullNumber).catch(() => []),
              api.listRequestedReviewers(connection, token, prOwner, prRepo, pullNumber).catch(() => ({})),
            ]);

            const tracked: Record<string, unknown> = this.reviewStore.getTrackedPullRequest(prKey) || {};
            const { summary, internals } = buildPullRequestSummary({
              connection,
              pr,
              reviews,
              reviewComments,
              issueComments: issueCommentsList,
              requestedReviewers,
              tracked,
              workspaces,
              gitSnapshots,
              activeProfileId,
              now: this.now,
            });
            visibleSummaries.push(summary);

            const { events, lastNotifiedActivityAt } = this._detectGitHubReviewActivityDeltas({
              tracked,
              summary,
              internals,
              seedingConnection,
            });
            newActivityEvents.push(...events);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const bridgeStore = this.reviewBridgeStore as any;
            if (bridgeStore?.syncPullRequest) {
              try {
                await bridgeStore.syncPullRequest(summary);
              } catch (error) {
                this.log.warn("review bridge sync failed", { prKey, err: (error as Error).message || String(error) });
              }
            }

            trackedPullRequests[prKey] = {
              ...(tracked || {}),
              key: prKey,
              connectionId: connection.id,
              pullRequestNumber: pullNumber,
              owner: prOwner,
              repo: prRepo,
              reviewWorkspaceId: summary.reviewWorkspaceId || tracked.reviewWorkspaceId || "",
              lastRemoteActivityAt: summary.lastRemoteActivityAt,
              lastReviewStateSignature: internals.reviewStateSignature,
              lastHeadSha: internals.headSha,
              lastChecksSignature: internals.checksSignature,
              lastSeenActivityAt: tracked.lastSeenActivityAt || null,
              lastNotifiedActivityAt,
            };
            detailMap[prKey] = {
              ...(detailMap[prKey] || {}),
              ...summary,
            };
          }
        }
        this._seededConnections.add(connection.id);

        connectionSnapshot.status = "ok";
        connectionSnapshot.lastError = "";
        connectionSnapshot.lastSyncAt = new Date(this.now()).toISOString();
        connectionSnapshot.lastSuccessAt = connectionSnapshot.lastSyncAt;
        await this.reviewStore.upsertConnectionState(connection.id, {
          status: "ok",
          lastError: "",
          lastSyncAt: connectionSnapshot.lastSyncAt as string,
          lastSuccessAt: connectionSnapshot.lastSuccessAt as string,
        });
      } catch (error) {
        connectionSnapshot.status = "error";
        connectionSnapshot.lastError = (error as Error).message || "GitHub sync failed.";
        connectionSnapshot.lastSyncAt = new Date(this.now()).toISOString();
        await this.reviewStore.upsertConnectionState(connection.id, {
          status: "error",
          lastError: connectionSnapshot.lastError as string,
          lastSyncAt: connectionSnapshot.lastSyncAt as string,
        });
      }

      // Mirrors AzureDevOpsManager — notify once per transition into error
      // (or on a different error message), not every poll while the error
      // persists and not on startup if the same error was already persisted.
      const connectionErrorEvent = buildConnectionErrorEvent({
        provider: "github",
        connection,
        prevState: persistedState,
        currentStatus: connectionSnapshot.status as string,
        currentError: connectionSnapshot.lastError as string,
        at: (connectionSnapshot.lastSyncAt || new Date(this.now()).toISOString()) as string,
      });
      if (connectionErrorEvent) {
        newActivityEvents.push(connectionErrorEvent);
      }
    }

    // Resolve actual status for PRs with open workspaces that are no longer in the active poll.
    // Only fetches once — resolved status is persisted in detailMap so subsequent polls skip them.
    for (const ws of workspaces) {
      if (ws.review?.provider !== "github" || !ws.review?.prKey) continue;
      const key = ws.review.prKey;
      if (trackedPullRequests[key]) continue; // still active
      const existing = detailMap[key];
      if (existing && (existing.pullRequest as Record<string, unknown> | undefined)?.state !== "open") continue; // already resolved
      const conn = connections.find((c) => c.id === ws.review?.connectionId);
      const token = conn && this.credentialStore.getSecret(conn.tokenRef || "");
      if (!conn || !token) continue;
      const [owner, repo] = (ws.review.repository?.fullName || "").split("/");
      const pullNumber = ws.review.pullRequest?.number || ws.review.pullRequest?.id;
      if (!owner || !repo || !pullNumber) continue;
      try {
        const pr = await api.getPullRequest(conn, token, owner, repo, pullNumber);
        detailMap[key] = {
          ...(existing || {}),
          connectionId: ws.review.connectionId,
          repository: ws.review.repository,
          pullRequest: {
            ...((existing?.pullRequest as Record<string, unknown>) || ws.review.pullRequest || {}),
            state: pr.state || "closed",
            mergedAt: pr.merged_at || null,
            closedAt: pr.closed_at || null,
          },
        };
      } catch {
        detailMap[key] = {
          ...(existing || {}),
          connectionId: ws.review.connectionId,
          repository: ws.review.repository,
          pullRequest: {
            ...((existing?.pullRequest as Record<string, unknown>) || ws.review.pullRequest || {}),
            state: "closed",
            mergedAt: null,
          },
        };
      }
    }

    for (const [key, tracked] of Object.entries(trackedPullRequests)) {
      await this.reviewStore.upsertTrackedPullRequest(key, tracked);
    }

    const recentlyUpdated = visibleSummaries
      .slice()
      .sort((a, b) => parseDate(b.lastActivityAt) - parseDate(a.lastActivityAt));

    const snapshot = {
      connections: connectionSnapshots,
      inbox: {
        needsMyReview: visibleSummaries
          .filter((s) => s.role === "reviewer")
          .sort((a, b) => {
            if (a.hasAttention !== b.hasAttention) return Number(b.hasAttention) - Number(a.hasAttention);
            return parseDate(b.lastActivityAt) - parseDate(a.lastActivityAt);
          }),
        myPullRequests: visibleSummaries
          .filter((s) => s.role === "author")
          .sort((a, b) => {
            if (a.hasAttention !== b.hasAttention) return Number(b.hasAttention) - Number(a.hasAttention);
            return parseDate(b.lastActivityAt) - parseDate(a.lastActivityAt);
          }),
        recentlyUpdated,
        needsAttention: visibleSummaries
          .filter((s) => s.hasAttention)
          .sort((a, b) => parseDate(b.lastActivityAt) - parseDate(a.lastActivityAt)),
      },
      trackedPullRequests,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pullRequests: detailMap as any,
      reviewActivity: appendReviewActivity(this.snapshot.reviewActivity, newActivityEvents),
      sync: {
        running: false,
        lastStartedAt: startedAt,
        lastCompletedAt: new Date(this.now()).toISOString(),
      },
    };
    this.setSnapshot(snapshot as typeof this.snapshot);
    return this.getSnapshot();
  }

  /**
   * Compare a PR summary against its tracked state and emit review-activity
   * events for changes caused by people other than the current user.
   *
   * Mirror of AzureDevOpsManager._detectAzureReviewActivityDeltas — same
   * contract, GitHub-specific identity and vote logic.
   */
  _detectGitHubReviewActivityDeltas({ tracked, summary, internals, seedingConnection }: DetectDeltasOptions): {
    events: unknown[];
    lastNotifiedActivityAt: string;
  } {
    const nowIso = new Date(this.now()).toISOString();
    const events: unknown[] = [];
    const myLogin = String(internals.myLogin || "").toLowerCase();
    const isSelfLogin = (login: unknown): boolean => Boolean(myLogin) && String(login || "").toLowerCase() === myLogin;

    if (seedingConnection) {
      return {
        events,
        lastNotifiedActivityAt:
          seedNotifiedTimestamp(summary as unknown as Parameters<typeof seedNotifiedTimestamp>[0], nowIso) || nowIso,
      };
    }

    const prevNotifiedAt = (tracked.lastNotifiedActivityAt as string) || "";
    const summaryRepo = summary.repository as Record<string, unknown>;
    const summaryPr = summary.pullRequest as Record<string, unknown>;
    const summaryAuthor = summary.author as Record<string, unknown>;

    if (!prevNotifiedAt) {
      if (summary.role === "reviewer") {
        events.push(
          buildReviewActivityEvent({
            provider: "github",
            summary: summary as unknown as Parameters<typeof buildReviewActivityEvent>[0]["summary"],
            kind: "pr-new",
            at: (summary.lastRemoteActivityAt as string) || nowIso,
            title: `Review requested: ${summaryRepo.fullName} #${summaryPr.number}`,
            body: truncateBody(`${summaryAuthor.displayName}: ${summaryPr.title}`),
            actor: { login: summaryAuthor.login as string, displayName: summaryAuthor.displayName as string },
          }),
        );
      }
      return {
        events,
        lastNotifiedActivityAt:
          seedNotifiedTimestamp(summary as unknown as Parameters<typeof seedNotifiedTimestamp>[0], nowIso) || nowIso,
      };
    }

    // 1) New issue + review comments from other users.
    const newIssue = filterNewComments({
      comments: internals.otherIssueComments as unknown[],
      sinceIsoString: prevNotifiedAt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isSelf: (author: any) => isSelfLogin(author?.login),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getTimestamp: (comment: any) => comment.updated_at || comment.created_at,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getAuthor: (comment: any) => comment.user || {},
    });
    const newReview = filterNewComments({
      comments: internals.otherReviewComments as unknown[],
      sinceIsoString: prevNotifiedAt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isSelf: (author: any) => isSelfLogin(author?.login),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getTimestamp: (comment: any) => comment.updated_at || comment.created_at,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getAuthor: (comment: any) => comment.user || {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newComments = ([...newIssue, ...newReview] as any[]).sort(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (a: any, b: any) => parseDate(a.updated_at || a.created_at) - parseDate(b.updated_at || b.created_at),
    );
    if (newComments.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const latest: any = newComments[newComments.length - 1];
      const actor = {
        login: latest.user?.login || "",
        displayName: latest.user?.name || latest.user?.login || "Someone",
      };
      const title =
        newComments.length > 1
          ? `${newComments.length} new comments on ${summaryRepo.fullName} #${summaryPr.number}`
          : `New comment on ${summaryRepo.fullName} #${summaryPr.number}`;
      events.push(
        buildReviewActivityEvent({
          provider: "github",
          summary: summary as unknown as Parameters<typeof buildReviewActivityEvent>[0]["summary"],
          kind: "pr-new-comment",
          at: latest.updated_at || latest.created_at || nowIso,
          title,
          body: truncateBody(`${actor.displayName}: ${latest.body || ""}`),
          actor,
        }),
      );
    }

    // 2) Review state change by somebody other than me.
    if (tracked.lastReviewStateSignature && tracked.lastReviewStateSignature !== internals.reviewStateSignature) {
      const prevMap = parseGitHubReviewSignature(tracked.lastReviewStateSignature as string);
      const currMap = parseGitHubReviewSignature(internals.reviewStateSignature as string);
      const changedLogins = diffSignatureKeys(prevMap, currMap, myLogin);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reviewerMap = internals.reviewerMap as Map<string, any>;
      const changedReviewers = changedLogins
        .map((login) => reviewerMap.get(login))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((reviewer: any) => reviewer && !isSelfLogin(reviewer.login));
      if (changedReviewers.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reviewer: any = changedReviewers[0];
        const verb =
          reviewer.state === "approved"
            ? "approved"
            : reviewer.state === "changes_requested"
              ? "requested changes"
              : reviewer.state === "dismissed"
                ? "dismissed their review"
                : "updated their review";
        events.push(
          buildReviewActivityEvent({
            provider: "github",
            summary: summary as unknown as Parameters<typeof buildReviewActivityEvent>[0]["summary"],
            kind: "pr-vote-changed",
            at: nowIso,
            title: `Review updated on ${summaryRepo.fullName} #${summaryPr.number}`,
            body: truncateBody(`${reviewer.displayName} ${verb}.`),
            actor: { login: reviewer.login, displayName: reviewer.displayName },
            urgency: reviewer.state === "changes_requested" ? "urgent" : "normal",
          }),
        );
      }
    }

    // 3) Source HEAD updated — GitHub doesn't tell us the pusher cheaply, so
    // only notify reviewers (the author almost always pushed themselves).
    if (tracked.lastHeadSha && tracked.lastHeadSha !== internals.headSha && summary.role === "reviewer") {
      events.push(
        buildReviewActivityEvent({
          provider: "github",
          summary: summary as unknown as Parameters<typeof buildReviewActivityEvent>[0]["summary"],
          kind: "pr-source-updated",
          at: (summaryPr.updatedAt as string) || nowIso,
          title: `${summaryRepo.fullName} #${summaryPr.number} has new commits`,
          body: "The source branch was updated.",
        }),
      );
    }

    // 4) Checks newly failing — relevant to the author (they need to fix).
    if (
      summary.role === "author" &&
      tracked.lastChecksSignature &&
      tracked.lastChecksSignature !== internals.checksSignature &&
      (internals.checksFailedCount as number) > 0
    ) {
      events.push(
        buildReviewActivityEvent({
          provider: "github",
          summary: summary as unknown as Parameters<typeof buildReviewActivityEvent>[0]["summary"],
          kind: "pr-checks-failed",
          at: nowIso,
          title: `Checks failing on ${summaryRepo.fullName} #${summaryPr.number}`,
          body: truncateBody(`${internals.checksFailedCount} check(s) failed.`),
          urgency: "urgent",
        }),
      );
    }

    return {
      events,
      lastNotifiedActivityAt: events.length > 0 ? nowIso : prevNotifiedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Mark PR as seen
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // PR detail enrichment (checks, files)
  // ---------------------------------------------------------------------------

  async ensurePullRequestDetail(
    prKey: string,
    { workspaces = [], force = false }: { workspaces?: SyncWorkspace[]; force?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const current = this.snapshot.pullRequests[prKey] || this.findSummary(prKey);
    if (!current) throw new Error("Pull request is not available in the current GitHub snapshot.");
    const currentRec = current as Record<string, unknown>;
    if (
      !force &&
      Array.isArray(currentRec.changedFiles) &&
      (currentRec.checks as Record<string, unknown> | undefined)?.items
    )
      return currentRec;

    this.setAuditContext({ connectionId: (currentRec.connectionId as string) || "", userInitiated: true });
    const connection = this.findConnection(currentRec.connectionId as string);
    if (!connection) throw new Error("GitHub connection was not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef || "");
    if (!token) throw new Error("PAT is missing.");

    const repository = currentRec.repository as Record<string, unknown>;
    const pullRequest = currentRec.pullRequest as Record<string, unknown>;
    const owner = repository.owner as string;
    const repo = repository.name as string;
    const pullNumber = pullRequest.number as number;
    const headSha = pullRequest.headSha as string | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = this.api as any;

    const [files, checkRuns, combinedStatus] = await Promise.all([
      api.listPullRequestFiles(connection, token, owner, repo, pullNumber).catch(() => []),
      headSha ? api.listCheckRuns(connection, token, owner, repo, headSha).catch(() => []) : [],
      headSha ? api.getCombinedStatus(connection, token, owner, repo, headSha).catch(() => null) : null,
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const changedFiles = (files as any[]).map((f: any) => ({
      path: f.filename || "",
      changeType: f.status || "modified",
      additions: f.additions || 0,
      deletions: f.deletions || 0,
      patch: f.patch || "",
    }));

    // Inline check aggregation
    const checks: { failedCount: number; pendingCount: number; passedCount: number; items: Record<string, unknown>[] } =
      { failedCount: 0, pendingCount: 0, passedCount: 0, items: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const run of checkRuns as any[]) {
      const conclusion = String(run.conclusion || run.status || "").toLowerCase();
      let state = "unknown";
      if (["failure", "timed_out", "action_required", "cancelled"].includes(conclusion)) state = "failed";
      else if (["queued", "in_progress", "waiting", "pending", "requested"].includes(conclusion)) state = "pending";
      else if (["success", "neutral", "skipped"].includes(conclusion)) state = "succeeded";
      checks.items.push({
        id: `check:${run.id}`,
        kind: "check",
        name: run.name || "Check",
        description: run.output?.title || "",
        state,
        url: run.html_url || run.details_url || "",
      });
      if (state === "failed") checks.failedCount++;
      else if (state === "pending") checks.pendingCount++;
      else if (state === "succeeded") checks.passedCount++;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((combinedStatus as any)?.statuses) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const status of (combinedStatus as any).statuses as any[]) {
        const s = String(status.state || "").toLowerCase();
        let state = "unknown";
        if (["failure", "error"].includes(s)) state = "failed";
        else if (["pending"].includes(s)) state = "pending";
        else if (["success"].includes(s)) state = "succeeded";
        checks.items.push({
          id: `status:${status.id || status.context}`,
          kind: "status",
          name: status.context || "Status",
          description: status.description || "",
          state,
          url: status.target_url || "",
        });
        if (state === "failed") checks.failedCount++;
        else if (state === "pending") checks.pendingCount++;
        else if (state === "succeeded") checks.passedCount++;
      }
    }

    const workspace =
      findWorkspaceForPullRequest(workspaces as Array<{ id: string; [key: string]: unknown }>, prKey) ||
      (currentRec.existingWorkspaceId ? workspaces.find((ws) => ws.id === currentRec.existingWorkspaceId) : null);
    const workspaceCwd = (workspace as SyncWorkspace | undefined)?.cwd;
    const localChanges = workspaceCwd
      ? await this.listLocalChangedFiles(workspaceCwd, stripRefsPrefix(pullRequest.targetRefName as string)).catch(
          () => [],
        )
      : [];

    const next: Record<string, unknown> = {
      ...currentRec,
      changedFiles,
      localChangedFiles: localChanges,
      checks,
      existingWorkspaceId: (workspace as SyncWorkspace | undefined)?.id || currentRec.existingWorkspaceId || "",
      reviewWorkspaceId:
        (workspace as SyncWorkspace | undefined)?.review?.provider === "github"
          ? (workspace as SyncWorkspace).id
          : currentRec.reviewWorkspaceId || "",
    };

    this.setSnapshot({
      ...this.snapshot,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pullRequests: { ...this.snapshot.pullRequests, [prKey]: next as any },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridgeStore = this.reviewBridgeStore as any;
    if (bridgeStore?.syncPullRequest) {
      try {
        await bridgeStore.syncPullRequest(next);
      } catch (error) {
        this.log.warn("review bridge detail sync failed", { prKey, err: (error as Error).message || String(error) });
      }
    }
    return next;
  }

  async rerunCheck(prKey: string, checkItem: CheckItem): Promise<Record<string, unknown>> {
    const current = this.snapshot.pullRequests?.[prKey];
    if (!current) throw new Error(`PR ${prKey} not found in snapshot`);
    const currentRec = current as Record<string, unknown>;
    const connection = this.findConnection(currentRec.connectionId as string);
    if (!connection) throw new Error(`Connection not found for PR ${prKey}`);
    const token = this.credentialStore.getSecret(connection.tokenRef || "");
    if (!token) throw new Error(`No credentials found for connection "${connection.label || connection.id}"`);
    this.setAuditContext({ connectionId: connection.id, userInitiated: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = this.api as any;

    if (checkItem.kind === "check" && checkItem.checkSuiteId) {
      const repo = currentRec.repository as Record<string, unknown> | undefined;
      const owner = repo?.owner as string;
      const repoName = repo?.name as string;
      await api.rerunCheckSuite(connection, token, owner, repoName, checkItem.checkSuiteId);
    } else {
      throw new Error("Cannot re-run this check type");
    }

    return this.ensurePullRequestDetail(prKey, { force: true });
  }

  // ---------------------------------------------------------------------------
  // Managed checkout (cache repo + worktree)
  // ---------------------------------------------------------------------------

  async ensureCacheRepo({
    connection,
    token,
    owner,
    repo,
    remoteUrl,
    reviewRoot,
  }: EnsureCacheRepoOptions): Promise<string> {
    const repositoryRoot = path.join(
      normalizeReviewRoot(reviewRoot),
      "repos",
      shortPathKey(connection.id, "connection"),
      shortPathKey(`${owner}/${repo}`, "repository"),
    );
    const repoExists = await exists(path.join(repositoryRoot, ".git"));
    await mkdir(path.dirname(repositoryRoot), { recursive: true });
    if (!repoExists) {
      await this.runGit(process.cwd(), ["clone", "--no-checkout", remoteUrl, repositoryRoot], { token });
    }
    return repositoryRoot;
  }

  async prepareManagedReviewCheckout({
    summary,
    connection,
    token,
    reviewRoot,
  }: PrepareManagedReviewCheckoutOptions): Promise<{
    mode: string;
    rootPath: string;
    cacheRepoPath: string;
    sourceBranch: string;
    targetBranch: string;
  }> {
    try {
      const repository = summary.repository as Record<string, unknown>;
      const pullRequest = summary.pullRequest as Record<string, unknown>;
      const owner = repository.owner as string;
      const repo = repository.name as string;
      const remoteUrl = (repository.remoteUrl as string) || buildRepositoryRemoteUrl(connection.hostUrl, owner, repo);
      if (!remoteUrl) throw new Error("Pull request repository clone URL is missing.");

      const sourceBranch = stripRefsPrefix(pullRequest.sourceRefName as string);
      if (!sourceBranch) throw new Error("Pull request source branch is missing.");
      const targetBranch = stripRefsPrefix(pullRequest.targetRefName as string);
      if (!targetBranch) throw new Error("Pull request target branch is missing.");

      const cacheRepoPath = await this.ensureCacheRepo({ connection, token, owner, repo, remoteUrl, reviewRoot });
      const worktreePath = path.join(
        normalizeReviewRoot(reviewRoot),
        "reviews",
        shortPathKey(connection.id, "connection"),
        `pr-${pullRequest.number}`,
      );

      await this.runGit(
        cacheRepoPath,
        [
          "fetch",
          "origin",
          `+refs/heads/${sourceBranch}:refs/remotes/origin/${sourceBranch}`,
          `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`,
        ],
        { token },
      );

      await mkdir(path.dirname(worktreePath), { recursive: true });
      const worktreeExists = await exists(path.join(worktreePath, ".git"));
      const localBranch = `pr-${pullRequest.number}-${sanitizePathSegment(sourceBranch)}`;

      if (!worktreeExists) {
        try {
          await this.runGit(cacheRepoPath, [
            "worktree",
            "add",
            "--force",
            "-b",
            localBranch,
            worktreePath,
            `refs/remotes/origin/${sourceBranch}`,
          ]);
        } catch {
          // Branch may already exist from a previous (deleted) worktree — force-recreate
          await this.runGit(cacheRepoPath, ["worktree", "prune"]);
          await this.runGit(cacheRepoPath, [
            "worktree",
            "add",
            "--force",
            "-B",
            localBranch,
            worktreePath,
            `refs/remotes/origin/${sourceBranch}`,
          ]);
        }
      } else {
        await this.runGit(worktreePath, ["checkout", localBranch]).catch(async () => {
          await this.runGit(worktreePath, ["checkout", "-B", localBranch, `refs/remotes/origin/${sourceBranch}`]);
        });
        const status = await this.runGit(worktreePath, ["status", "--porcelain"]);
        if (!status.stdout.trim()) {
          const ahead = await this.runGit(worktreePath, [
            "rev-list",
            "--count",
            `refs/remotes/origin/${sourceBranch}..HEAD`,
          ]).catch(() => ({ stdout: "0" }));
          if (Number(ahead.stdout.trim()) === 0) {
            await this.runGit(worktreePath, ["reset", "--hard", `refs/remotes/origin/${sourceBranch}`]);
          }
        }
      }

      return {
        mode: "managed-worktree",
        rootPath: worktreePath,
        cacheRepoPath,
        sourceBranch,
        targetBranch,
      };
    } catch (error) {
      const friendlyMessage = formatReviewWorkspaceError(error, reviewRoot);
      if (friendlyMessage) throw new Error(friendlyMessage, { cause: error });
      throw error;
    }
  }

  buildReviewMetadata(
    summary: Record<string, unknown>,
    checkout: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      provider: "github",
      prKey: summary.prKey,
      connectionId: summary.connectionId,
      hostUrl: summary.hostUrl,
      parentWorkspaceId: extra.parentWorkspaceId || "",
      repository: clone(summary.repository as Record<string, unknown>),
      pullRequest: clone(summary.pullRequest as Record<string, unknown>),
      role: summary.role,
      checkout: {
        mode: checkout.mode || "managed-worktree",
        rootPath: checkout.rootPath,
        cacheRepoPath: checkout.cacheRepoPath || "",
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Open review workspace
  // ---------------------------------------------------------------------------

  async openReviewWorkspace({ state, prKey, workspaceId = "" }: OpenReviewWorkspaceOptions): Promise<{
    workspace: Record<string, unknown>;
    created: boolean;
    attached: boolean;
  }> {
    const summary = await this.ensurePullRequestDetail(prKey, { workspaces: state.workspaces });
    const connection = this.findConnection(summary.connectionId as string);
    if (!connection) throw new Error("GitHub connection was not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef || "");
    if (!token) throw new Error("PAT is missing.");

    const activeProfile = (state.windowSlots || [])[0]?.profileId || "default";
    const profileWorkspaces = state.workspaces.filter((ws) => (ws.profileId || "default") === activeProfile);
    const existingWorkspace = workspaceId
      ? profileWorkspaces.find((ws) => ws.id === workspaceId)
      : findWorkspaceForPullRequest(profileWorkspaces as Array<{ id: string; [key: string]: unknown }>, prKey) ||
        (summary.role === "author" && summary.existingWorkspaceId
          ? profileWorkspaces.find((ws) => ws.id === summary.existingWorkspaceId)
          : null);

    const reviewProfileId =
      (existingWorkspace as SyncWorkspace | undefined)?.profileId || activeProfile;
    const parentGitHubWorkspace =
      state.workspaces.find((ws) => ws.kind === "github" && (ws.profileId || "default") === reviewProfileId) || null;
    const parentWorkspaceId =
      parentGitHubWorkspace?.id || (existingWorkspace as SyncWorkspace | undefined)?.review?.parentWorkspaceId || "";

    if (existingWorkspace) {
      const ew = existingWorkspace as SyncWorkspace;
      if (!String(ew.cwd || "").trim()) {
        throw new Error(`Matched workspace "${ew.name || ew.id}" does not have a working directory.`);
      }
      const checkout = ew.review?.checkout || {
        mode: ew.review?.provider === "github" ? "managed-worktree" : "linked-existing-workspace",
        rootPath: ew.cwd,
        cacheRepoPath: ew.review?.checkout?.cacheRepoPath || "",
      };
      const workspace: Record<string, unknown> = {
        ...ew,
        review: this.buildReviewMetadata(summary, checkout as Record<string, unknown>, {
          parentWorkspaceId: checkout.mode === "managed-worktree" ? parentWorkspaceId : "",
        }),
      };
      await this.reviewStore.upsertTrackedPullRequest(prKey, {
        reviewWorkspaceId: workspace.id as string,
        lastSeenActivityAt: (summary.lastRemoteActivityAt as string) || new Date(this.now()).toISOString(),
      });
      return { workspace, created: false, attached: checkout.mode === "linked-existing-workspace" };
    }

    const checkout = await this.prepareManagedReviewCheckout({
      summary,
      connection,
      token,
      reviewRoot:
        parentGitHubWorkspace?.cwd ||
        ((connection as Record<string, unknown>).reviewRoot as string) ||
        getDefaultReviewRoot(),
    });
    const panels = createReviewWorkspacePanels(
      (parentGitHubWorkspace?.panels || []) as Parameters<typeof createReviewWorkspacePanels>[0],
      (state.tabTemplates || []) as Parameters<typeof createReviewWorkspacePanels>[1],
    );
    const summaryRepo = summary.repository as Record<string, unknown>;
    const summaryPr = summary.pullRequest as Record<string, unknown>;
    const workspace: Record<string, unknown> = {
      id: `workspace-${randomUUID()}`,
      name: `${summaryRepo.fullName} PR #${summaryPr.number}`,
      icon: GITHUB_REVIEW_ICON,
      color: GITHUB_REVIEW_COLOR,
      kind: "terminal",
      source: "manual",
      pluginId: "",
      cwd: checkout.rootPath,
      notes: `GitHub review workspace for ${summaryRepo.fullName} PR #${summaryPr.number}`,
      // Land the review workspace on the same profile as its GitHub parent /
      // connection (reviewProfileId), not on whatever profile the UI happens
      // to show right now — otherwise the review is invisible on the profile
      // that owns the connection.
      profileId: reviewProfileId,
      activePanelId: panels[0]?.id || "",
      panels,
      review: this.buildReviewMetadata(summary, checkout as unknown as Record<string, unknown>, {
        parentWorkspaceId: parentWorkspaceId || "",
      }),
    };
    await this.reviewStore.upsertTrackedPullRequest(prKey, {
      reviewWorkspaceId: workspace.id as string,
      lastSeenActivityAt: (summary.lastRemoteActivityAt as string) || new Date(this.now()).toISOString(),
    });
    return { workspace, created: true, attached: false };
  }

  // ---------------------------------------------------------------------------
  // Write actions
  // ---------------------------------------------------------------------------

  async addPullRequestComment({ prKey, body }: { prKey: string; body: string }): Promise<void> {
    const summary = await this.ensurePullRequestDetail(prKey);
    this.setAuditContext({ connectionId: (summary.connectionId as string) || "", userInitiated: true });
    const connection = this.findConnection(summary.connectionId as string);
    if (!connection) throw new Error("GitHub connection was not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef || "");
    if (!token) throw new Error("PAT is missing.");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = this.api as any;
    const repository = summary.repository as Record<string, unknown>;
    const pullRequest = summary.pullRequest as Record<string, unknown>;
    await api.createIssueComment(connection, token, repository.owner, repository.name, pullRequest.number, body);
  }

  async submitPullRequestReview({
    prKey,
    event,
    body = "",
  }: {
    prKey: string;
    event: string;
    body?: string;
  }): Promise<void> {
    const summary = await this.ensurePullRequestDetail(prKey);
    this.setAuditContext({ connectionId: (summary.connectionId as string) || "", userInitiated: true });
    const connection = this.findConnection(summary.connectionId as string);
    if (!connection) throw new Error("GitHub connection was not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef || "");
    if (!token) throw new Error("PAT is missing.");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = this.api as any;
    const repository = summary.repository as Record<string, unknown>;
    const pullRequest = summary.pullRequest as Record<string, unknown>;
    // event: APPROVE, REQUEST_CHANGES, COMMENT
    await api.submitReview(connection, token, repository.owner, repository.name, pullRequest.number, { event, body });
  }

  // ---------------------------------------------------------------------------
  // Workspace git operations
  // ---------------------------------------------------------------------------

  async fetchReviewWorkspace({ workspace }: { workspace: SyncWorkspace }): Promise<void> {
    const connection = this.findConnection(workspace.review?.connectionId || "");
    if (!connection) throw new Error("GitHub connection was not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef || "");
    if (!token) throw new Error("PAT is missing.");
    this.log.info("fetch review workspace", { workspaceId: workspace.id });
    await this.runGit(workspace.cwd!, ["fetch", "origin"], { token });
  }

  async rebaseReviewWorkspace({ workspace }: { workspace: SyncWorkspace }): Promise<void> {
    await this.fetchReviewWorkspace({ workspace });
    const targetBranch = stripRefsPrefix((workspace.review?.pullRequest?.targetRefName as string) || "");
    this.log.info("rebase review workspace", { workspaceId: workspace.id, targetBranch });
    await this.runGit(workspace.cwd!, ["rebase", `origin/${targetBranch}`]);
  }

  async pushReviewWorkspace({
    workspace,
    force = false,
    branch = "",
  }: {
    workspace: SyncWorkspace;
    force?: boolean;
    branch?: string;
  }): Promise<void> {
    const connection = this.findConnection(workspace.review?.connectionId || "");
    if (!connection) throw new Error("GitHub connection was not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef || "");
    if (!token) throw new Error("PAT is missing.");

    const sourceBranch = stripRefsPrefix((workspace.review?.pullRequest?.sourceRefName as string) || "") || branch;
    if (!sourceBranch) throw new Error("Cannot determine branch name for push.");

    // Local branch may be named differently (e.g. pr-1-feature) so push HEAD to the remote branch name
    const pushArgs = force
      ? ["push", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${sourceBranch}`]
      : ["push", "-u", "origin", `HEAD:refs/heads/${sourceBranch}`];
    this.log.info("push review workspace", { workspaceId: workspace.id, sourceBranch, force });
    await this.runGit(workspace.cwd!, pushArgs, { token });
  }

  async listRemoteBranches(connectionId: string, owner: string, repo: string): Promise<string[]> {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveConnectionAndToken(connectionId);
    // If owner/repo not provided, try to resolve from workspace git remote
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = this.api as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const branches = (await api.listBranches(connection, token, owner, repo)) as any[];
    return branches.map((b) => b.name);
  }

  async createPullRequestForWorkspace({
    connectionId,
    owner,
    repo,
    sourceBranch,
    targetBranch,
    title,
    description,
    isDraft = false,
  }: {
    connectionId: string;
    owner: string;
    repo: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
    isDraft?: boolean;
  }): Promise<{ pullRequestNumber: number; url: string; title: string }> {
    const { connection, token } = this.resolveConnectionAndToken(connectionId);
    this.setAuditContext({ connectionId, userInitiated: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = this.api as any;
    const result = await api.createPullRequest(connection, token, owner, repo, {
      title,
      body: description,
      head: sourceBranch,
      base: targetBranch,
      draft: isDraft,
    });
    return {
      pullRequestNumber: result.number,
      url: result.html_url || "",
      title: result.title,
    };
  }

  // ---------------------------------------------------------------------------
  // Quick Fix — new branch workflow
  // ---------------------------------------------------------------------------

  async listQuickFixRepositories(connectionId: string): Promise<
    Array<{
      id: unknown;
      name: string;
      fullName: string;
      owner: string;
      remoteUrl: string;
      defaultBranch: string;
    }>
  > {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveConnectionAndToken(connectionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = this.api as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allRepos: any[] = await api.listUserRepos(connection, token);
    let repos = allRepos;
    const connRec = connection as Record<string, unknown>;
    if ((connRec.ownerFilters as string[] | undefined)?.length) {
      const owners = new Set((connRec.ownerFilters as string[]).map((o) => o.toLowerCase()));
      repos = repos.filter((r) => owners.has((r.owner?.login || "").toLowerCase()));
    }
    if ((connRec.repositoryFilters as string[] | undefined)?.length) {
      const filters = new Set((connRec.repositoryFilters as string[]).map((f) => f.toLowerCase()));
      repos = repos.filter((r) => filters.has((r.full_name || "").toLowerCase()));
    }
    return repos.map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      owner: r.owner?.login || "",
      remoteUrl: r.clone_url || r.html_url,
      defaultBranch: r.default_branch || "main",
    }));
  }

  async listQuickFixBranches(connectionId: string, owner: string, repo: string): Promise<string[]> {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveConnectionAndToken(connectionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = this.api as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const branches = (await api.listBranches(connection, token, owner, repo)) as any[];
    return branches.map((b) => b.name);
  }

  async openQuickFixWorkspace({
    state,
    connectionId,
    owner,
    repo,
    remoteUrl,
    baseBranch,
    newBranchName,
  }: OpenQuickFixWorkspaceOptions): Promise<{
    workspace: Record<string, unknown>;
    parentWorkspaceId: string;
  }> {
    const { connection, token } = this.resolveConnectionAndToken(connectionId);
    const connRec = connection as Record<string, unknown>;

    // Pin to the connection's profile — falling back to active profile breaks
    // when quickfix is invoked from a profile that doesn't own the connection
    // (the workspace ends up on the wrong profile and goes invisible).
    const activeProfile = (connRec.profileId as string) || (state.windowSlots || [])[0]?.profileId || "default";
    const parentGitHubWorkspace =
      state.workspaces.find((ws) => ws.kind === "github" && (ws.profileId || "default") === activeProfile) || null;
    const reviewRoot = parentGitHubWorkspace?.cwd || (connRec.reviewRoot as string) || getDefaultReviewRoot();

    const cacheRepoPath = await this.ensureCacheRepo({ connection, token, owner, repo, remoteUrl, reviewRoot });

    await this.runGit(
      cacheRepoPath,
      ["fetch", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
      { token },
    );

    const worktreePath = path.join(
      normalizeReviewRoot(reviewRoot),
      "quickfix",
      shortPathKey(connection.id, "connection"),
      sanitizePathSegment(`${owner}-${repo}`),
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
        const errRec = err as Record<string, unknown>;
        const msg = String(errRec?.stderr || (err as Error)?.message || err);
        if (msg.includes("already exists")) {
          throw new Error(`Branch "${newBranchName}" already exists. Choose a different name.`, { cause: err });
        }
        throw err;
      }
    }

    const panels = createReviewWorkspacePanels(
      (parentGitHubWorkspace?.panels || []) as Parameters<typeof createReviewWorkspacePanels>[0],
      (state.tabTemplates || []) as Parameters<typeof createReviewWorkspacePanels>[1],
    );
    const workspace: Record<string, unknown> = {
      id: `workspace-${randomUUID()}`,
      name: newBranchName,
      icon: GITHUB_REVIEW_ICON,
      color: GITHUB_REVIEW_COLOR,
      kind: "terminal",
      source: "manual",
      pluginId: "",
      cwd: worktreePath,
      notes: "",
      profileId: activeProfile,
      connectionId,
      activePanelId: panels[0]?.id || "",
      panels,
      review: {
        provider: "github",
        prKey: "",
        connectionId,
        hostUrl: (connRec.hostUrl as string) || "",
        parentWorkspaceId: parentGitHubWorkspace?.id || "",
        repository: { owner, name: repo, fullName: `${owner}/${repo}`, remoteUrl },
        pullRequest: null,
        role: "author",
        checkout: {
          mode: "managed-worktree",
          rootPath: worktreePath,
          cacheRepoPath,
        },
      },
      quickfix: {
        connectionId,
        owner,
        repo,
        remoteUrl,
        baseBranch,
        parentWorkspaceId: parentGitHubWorkspace?.id || "",
      },
    };

    return { workspace, parentWorkspaceId: parentGitHubWorkspace?.id || "" };
  }
}

export {
  GITHUB_REVIEW_COLOR,
  GITHUB_REVIEW_ICON,
  getDefaultReviewRoot,
  createPullRequestKey,
  normalizeConnectionInput,
  normalizeRemoteUrl,
  normalizeReviewRoot,
  shortPathKey,
} from "./github-utils.js";

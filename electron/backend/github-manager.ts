import path from "node:path";
import { execFileText } from "./process-utils.js";
import { createGitHubApi } from "./github-api.js";
import { BaseProviderManager } from "./shared/base-manager.js";
import { classifyGitHubRequest, parseGitHubUrl } from "./github-audit-log-store.js";
import { buildCheckSummary, buildPullRequestSummary, findWorkspaceForPullRequest } from "./github-pr-summary.js";
import {
  buildReviewActivityEvent,
  diffSignatureKeys,
  filterNewComments,
  parseGitHubReviewSignature,
  seedNotifiedTimestamp,
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
  /** Profile of the window that initiated the action — used as defensive
   * fallback when the connection has no profileId (legacy/pre-migration). */
  callerProfileId?: string;
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
  /** Profile of the window that initiated the action. Refusing on mismatch
   * keeps a remote/mobile client on profile B from spawning a profile-A
   * quickfix workspace on disk. */
  callerProfileId?: string;
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
    this.connectionNotFoundMessage = "GitHub connection was not found.";
    this.syncErrorFallbackMessage = "GitHub sync failed.";
    this.reviewIcon = GITHUB_REVIEW_ICON;
    this.reviewColor = GITHUB_REVIEW_COLOR;
    this.parentWorkspaceKind = "github";
    this.providerDisplayName = "GitHub";
    this.getDefaultReviewRoot = getDefaultReviewRoot;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.syncCore({ connections: connections as any, workspaces, gitSnapshots, activeProfileId }, {
      createConnectionSnapshot: (connection, persistedState) =>
        createConnectionSnapshot(connection as unknown as SyncConnection, persistedState),
      fetchConnectionPrs: (connection, token, ctx) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this._fetchGitHubConnectionPrs(connection as unknown as SyncConnection, token, ctx as any),
      isPrResolved: (existing) =>
        (existing?.pullRequest as Record<string, unknown> | undefined)?.state !== "open",
      resolveStalePr: (ws, existing, conn, token) =>
        this._resolveStaleGitHubPr(
          ws as unknown as SyncWorkspace,
          existing,
          conn as unknown as SyncConnection,
          token,
        ),
    }) as Promise<Record<string, unknown>>;
  }

  /**
   * GitHub-specific per-connection PR walk: 2 search queries (review-requested
   * + author) with cross-query dedup, then per-PR detail/reviews/comments
   * fetches. This is the one part of sync() that's genuinely provider-specific
   * (Azure's equivalent walks project → repository → PR instead) — everything
   * else lives in BaseProviderManager.syncCore.
   */
  async _fetchGitHubConnectionPrs(
    connection: SyncConnection,
    token: string,
    ctx: {
      workspaces: SyncWorkspace[];
      gitSnapshots: Record<string, unknown>;
      activeProfileId: string;
      seedingConnection: boolean;
      visibleSummaries: Record<string, unknown>[];
      trackedPullRequests: Record<string, Record<string, unknown>>;
      detailMap: Record<string, Record<string, unknown>>;
      newActivityEvents: unknown[];
    },
  ): Promise<void> {
    const {
      workspaces,
      gitSnapshots,
      activeProfileId,
      seedingConnection,
      visibleSummaries,
      trackedPullRequests,
      detailMap,
      newActivityEvents,
    } = ctx;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = this.api as any;

    const login = connection.currentUserLogin;
    if (!login) throw new Error("GitHub login is not configured. Re-verify the connection.");

    // Build search queries for inbox
    const ownerScope = connection.ownerFilters?.length ? connection.ownerFilters.map((o) => `org:${o}`).join(" ") : "";

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
  }

  /**
   * Fetch a single stale/inactive PR by number and return either its updated
   * state or (on a confirmed 404/410) a terminal "closed" summary. Returns
   * null on any other failure so BaseProviderManager.syncCore leaves the
   * existing detailMap entry untouched and retries on the next poll instead
   * of mislabeling a still-active PR.
   */
  async _resolveStaleGitHubPr(
    ws: SyncWorkspace,
    existing: Record<string, unknown> | undefined,
    conn: SyncConnection,
    token: string,
  ): Promise<Record<string, unknown> | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = this.api as any;
    const key = ws.review!.prKey!;
    const [owner, repo] = (ws.review!.repository?.fullName || "").split("/");
    const pullNumber = ws.review!.pullRequest?.number || ws.review!.pullRequest?.id;
    if (!owner || !repo || !pullNumber) return null;
    try {
      const pr = await api.getPullRequest(conn, token, owner, repo, pullNumber);
      return {
        ...(existing || {}),
        connectionId: ws.review!.connectionId,
        repository: ws.review!.repository,
        pullRequest: {
          ...((existing?.pullRequest as Record<string, unknown>) || ws.review!.pullRequest || {}),
          state: pr.state || "closed",
          mergedAt: pr.merged_at || null,
          closedAt: pr.closed_at || null,
        },
      };
    } catch (error) {
      // GitHub's requestJson embeds the HTTP status in the thrown message, e.g.
      // "GitHub request failed (404): ...". Only a 404/410 means the PR is
      // genuinely gone — any other failure (network blip, 500, timeout,
      // unparseable status) is transient, so leave detailMap[key] untouched
      // and let the next poll cycle retry the check instead of permanently
      // mislabeling a still-active PR as closed.
      const message = (error as Error).message || String(error);
      const statusMatch = message.match(/request failed \((\d+)\)/);
      const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
      if (statusCode !== 404 && statusCode !== 410) {
        this.log.warn("stale PR check failed, will retry next poll", { prKey: key, statusCode, err: message });
        return null;
      }
      this.log.warn("stale PR confirmed gone, marking closed", { prKey: key, statusCode, err: message });
      return {
        ...(existing || {}),
        connectionId: ws.review!.connectionId,
        repository: ws.review!.repository,
        pullRequest: {
          ...((existing?.pullRequest as Record<string, unknown>) || ws.review!.pullRequest || {}),
          state: "closed",
          mergedAt: null,
        },
      };
    }
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

    // Shared with github-pr-summary.ts's ensurePullRequestSummary path so a check's
    // aggregated state (failed/pending/succeeded) can't drift between the inbox
    // summary and this detail view.
    const checks = buildCheckSummary(
      checkRuns as Array<Record<string, unknown>>,
      combinedStatus as Record<string, unknown> | null,
    );

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
    return this.ensureCacheRepoAt({
      connectionId: connection.id,
      repoIdentifier: `${owner}/${repo}`,
      repoLabel: `${owner}/${repo}`,
      remoteUrl,
      reviewRoot: normalizeReviewRoot(reviewRoot),
      token,
    });
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
      const localBranch = `pr-${pullRequest.number}-${sanitizePathSegment(sourceBranch)}`;

      await this.ensureManagedWorktree({
        cacheRepoPath,
        worktreePath,
        localBranch,
        sourceBranch,
        // GitHub's PR source/target refs are always refs/heads/* — reconstruct
        // rather than relying on a raw ref-name field like Azure does.
        fetchRefspecs: [
          `+refs/heads/${sourceBranch}:refs/remotes/origin/${sourceBranch}`,
          `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`,
        ],
        token,
      });

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
      writable: extra.writable === true,
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

  async openReviewWorkspace({
    state,
    prKey,
    workspaceId = "",
    callerProfileId = "",
  }: OpenReviewWorkspaceOptions): Promise<{
    workspace: Record<string, unknown>;
    created: boolean;
    attached: boolean;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.openReviewWorkspaceCore({ state: state as any, prKey, workspaceId, callerProfileId }, {
      ensurePullRequestDetail: (key, opts) => this.ensurePullRequestDetail(key, opts),
      prepareManagedReviewCheckout: (opts) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.prepareManagedReviewCheckout(opts as any),
      buildReviewMetadata: (summary, checkout, extra) =>
         
        this.buildReviewMetadata(summary as Record<string, unknown>, checkout as Record<string, unknown>, extra),
      formatPrLabel: (summary) => {
        const repo = summary.repository as Record<string, unknown>;
        const pr = summary.pullRequest as Record<string, unknown>;
        return `${repo.fullName} PR #${pr.number}`;
      },
      findWorkspaceForPullRequest: (workspaces, key) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findWorkspaceForPullRequest(workspaces as any, key),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
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
    workspaceProfileId = "",
  }: {
    connectionId: string;
    owner: string;
    repo: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
    isDraft?: boolean;
    /** Owner profile of the originating workspace — the connection must live in the same profile. */
    workspaceProfileId?: string;
  }): Promise<{ pullRequestNumber: number; url: string; title: string }> {
    const { connection, token } = this.resolveConnectionAndToken(connectionId);
    // See azure-devops-manager.createPullRequestForWorkspace — the PR is
    // owned by the workspace's profile; cross-profile connections refuse.
    const connectionProfileId = (connection as { profileId?: string }).profileId || "default";
    if (workspaceProfileId && connectionProfileId !== workspaceProfileId) {
      throw new Error(
        `Cross-profile refused: connection ${connection.id} belongs to profile ${connectionProfileId}, ` +
          `but this workspace is in profile ${workspaceProfileId}. Create the PR from a workspace in ` +
          `profile ${connectionProfileId}, or add a connection to profile ${workspaceProfileId}.`,
      );
    }
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
    // Identical to listRemoteBranches — kept as a separate name because it's
    // called from the quick-fix workflow specifically; delegate to avoid
    // duplicating the implementation.
    return this.listRemoteBranches(connectionId, owner, repo);
  }

  async openQuickFixWorkspace({
    state,
    connectionId,
    owner,
    repo,
    remoteUrl,
    baseBranch,
    newBranchName,
    callerProfileId = "",
  }: OpenQuickFixWorkspaceOptions): Promise<{
    workspace: Record<string, unknown>;
    parentWorkspaceId: string;
  }> {
     
    const result = await this.openQuickFixWorkspaceCore(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { state: state as any, connectionId, baseBranch, newBranchName, callerProfileId },
      {
        prepareQuickFixCheckout: ({ connection, token, reviewRoot }) =>
          this.prepareQuickFixCheckout({
            connection,
            token,
            reviewRoot,
            baseBranch,
            newBranchName,
            repoPathSegment: `${owner}-${repo}`,
            ensureCacheRepo: () => this.ensureCacheRepo({ connection, token, owner, repo, remoteUrl, reviewRoot }),
          }),
        buildQuickFixMetadata: ({ connection, checkout, parentWorkspaceId }) => {
          const connRec = connection as Record<string, unknown>;
          return {
            review: {
              provider: "github",
              prKey: "",
              connectionId,
              hostUrl: (connRec.hostUrl as string) || "",
              parentWorkspaceId,
              repository: { owner, name: repo, fullName: `${owner}/${repo}`, remoteUrl },
              pullRequest: null,
              role: "author",
              checkout: {
                mode: "managed-worktree",
                rootPath: checkout.rootPath,
                cacheRepoPath: checkout.cacheRepoPath,
              },
            },
            quickfix: {
              connectionId,
              owner,
              repo,
              remoteUrl,
              baseBranch,
              parentWorkspaceId,
            },
          };
        },
      },
    );
    result.workspace.connectionId = connectionId;
    return result as { workspace: Record<string, unknown>; parentWorkspaceId: string };
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

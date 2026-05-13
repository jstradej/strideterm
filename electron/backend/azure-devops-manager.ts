/// <reference types="node" />
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { execFileText } from "./process-utils.js";
import { createAzureApi } from "./azure-devops-api.js";
import { BaseProviderManager, createReviewWorkspacePanels } from "./shared/base-manager.js";
import type { CredentialStore } from "./shared/credential-store.js";
import { classifyAzureRequest, parseAzureUrl } from "./azure-audit-log-store.js";
import { buildPullRequestSummary, findWorkspaceForPullRequest } from "./azure-devops-pr-summary.js";
import {
  appendReviewActivity,
  buildConnectionErrorEvent,
  buildReviewActivityEvent,
  diffSignatureKeys,
  filterNewComments,
  parseAzureVoteSignature,
  seedNotifiedTimestamp,
  shouldSeedConnection,
  truncateBody,
} from "./shared/review-activity.js";
import {
  AZURE_REVIEW_ICON,
  AZURE_REVIEW_COLOR,
  getDefaultReviewRoot,
  clone,
  identityMatches,
  sanitizePathSegment,
  normalizeReviewRoot,
  createPullRequestKey,
  stripRefsPrefix,
  parseDate,
  firstNonEmpty,
  normalizeRemoteUrl,
  buildRepositoryRemoteUrl,
  sanitizeGitEnvironment,
  shortPathKey,
  formatReviewWorkspaceError,
  buildCheckSummary,
  createConnectionSnapshot,
  createEmptySnapshot,
  normalizeConnectionInput,
  exists,
} from "./azure-devops-utils.js";

// ─── Local type aliases ──────────────────────────────────────────────────────

interface AzureConnection {
  id: string;
  label?: string;
  orgUrl: string;
  login: string;
  tokenRef: string;
  enabled?: boolean;
  projectFilters?: string[];
  repositoryFilters?: string[];
  pollSeconds?: number;
  reviewRoot?: string;
  [key: string]: unknown;
}

interface AzureConnectionInput {
  id?: string;
  orgUrl?: string;
  login?: string;
  pat?: string;
  tokenRef?: string;
  enabled?: boolean;
  projectFilters?: string[];
  repositoryFilters?: string[];
  pollSeconds?: number;
  reviewRoot?: string;
  [key: string]: unknown;
}

interface AzureProject {
  id: string;
  name: string;
  description?: string;
  state?: string;
  [key: string]: unknown;
}

interface AzurePrSummary {
  prKey: string;
  connectionId: string;
  orgUrl?: string;
  role?: string;
  provider?: string;
  project?: { id: string; name: string };
  repository?: { id: string; name: string; remoteUrl?: string };
  pullRequest?: {
    id: string | number;
    title?: string;
    status?: string;
    mergeStatus?: string;
    sourceRefName?: string;
    targetRefName?: string;
    sourceCommitId?: string;
    closedDate?: string;
    webUrl?: string;
  };
  author?: { displayName?: string; uniqueName?: string };
  myReviewerId?: string;
  threads?: AzureThread[];
  changedFiles?: unknown[];
  localChangedFiles?: { changeType: string; path: string }[];
  checks?: {
    items?: AzureCheckItem[];
    failedCount?: number;
    pendingCount?: number;
    passedCount?: number;
    optionalFailedCount?: number;
    requiredFailedCount?: number;
  };
  hasAttention?: boolean;
  attentionReason?: string;
  newCommentsCount?: number;
  unresolvedThreadCount?: number;
  lastRemoteActivityAt?: string | null;
  lastSeenActivityAt?: string | null;
  lastActivityAt?: string | null;
  reviewWorkspaceId?: string;
  existingWorkspaceId?: string;
  [key: string]: unknown;
}

interface AzureThread {
  id?: number | string;
  status?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  publishedDate?: string;
  lastUpdatedDate?: string;
  comments?: AzureComment[];
  [key: string]: unknown;
}

interface AzureComment {
  id?: number | string;
  content?: string;
  parentCommentId?: number;
  commentType?: string | number;
  author?: { id?: string; displayName?: string; uniqueName?: string; mailAddress?: string };
  publishedDate?: string;
  lastUpdatedDate?: string;
  threadId?: number | string;
  threadStatus?: string;
  [key: string]: unknown;
}

interface AzureCheckItem {
  id?: string;
  kind?: string;
  evaluationId?: string | null;
  name?: string;
  state?: string;
  buildId?: string | number | null;
  errorMessage?: string;
  [key: string]: unknown;
}

interface TrackedPullRequest {
  key?: string;
  connectionId?: string;
  pullRequestId?: string | number;
  repositoryId?: string;
  projectName?: string;
  repositoryName?: string;
  reviewWorkspaceId?: string;
  lastRemoteActivityAt?: string | null;
  lastVoteSignature?: string | null;
  lastMergeStatus?: string | null;
  lastSourceCommitId?: string | null;
  lastSeenActivityAt?: string | null;
  lastNotifiedActivityAt?: string | null;
  [key: string]: unknown;
}

interface AzureConnectionSnapshot {
  id: string;
  label: string;
  orgUrl: string;
  login: string;
  tokenRef: string;
  enabled: boolean;
  projectFilters: string[];
  repositoryFilters: string[];
  pollSeconds: number;
  reviewRoot: string;
  status: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string;
  [key: string]: unknown;
}

interface AzureReviewStore {
  getState(): {
    connections?: Record<
      string,
      { status?: string; lastError?: string; lastSyncAt?: string | null; lastSuccessAt?: string | null }
    >;
    trackedPullRequests?: Record<string, TrackedPullRequest>;
  };
  getTrackedPullRequest(key: string): TrackedPullRequest | null;
  upsertTrackedPullRequest(key: string, patch: Partial<TrackedPullRequest>): Promise<void>;
  upsertConnectionState(
    connectionId: string,
    patch: { status: string; lastError?: string; lastSyncAt?: string; lastSuccessAt?: string },
  ): Promise<void>;
}

interface AzureReviewBridgeStore {
  syncPullRequest?(summary: AzurePrSummary): Promise<void>;
  markPullRequestSeen?(prKey: string, lastSeenActivityAt: string): Promise<void>;
}

interface AzureAuditLogStore {
  logEntry(entry: Record<string, unknown>): void;
}

interface ReviewCheckout {
  mode?: string;
  rootPath: string;
  cacheRepoPath?: string;
}

interface ReviewWorkspace {
  id: string;
  name?: string;
  kind?: string;
  profileId?: string;
  cwd?: string;
  panels?: unknown[];
  review?: {
    provider?: string;
    prKey?: string;
    connectionId?: string;
    project?: { id?: string; name?: string };
    repository?: { id?: string; name?: string; remoteUrl?: string };
    pullRequest?: {
      sourceRefName?: string;
      targetRefName?: string;
      id?: string | number;
      title?: string;
      status?: string;
    };
    checkout?: ReviewCheckout;
    parentWorkspaceId?: string;
    role?: string;
    orgUrl?: string;
  };
  quickfix?: Record<string, unknown>;
  [key: string]: unknown;
}

interface AzureManagerOptions {
  credentialStore: CredentialStore;
  reviewStore: AzureReviewStore;
  reviewBridgeStore?: AzureReviewBridgeStore | null;
  auditLogStore?: AzureAuditLogStore | null;
  fetchImpl?: typeof globalThis.fetch;
  execFileTextImpl?: typeof execFileText;
  now?: () => number;
}

interface AuditRaw {
  method?: string;
  url?: string;
  statusCode?: number;
  success?: boolean;
  errorMessage?: string;
  durationMs?: number;
}

// Typed return of createAzureApi (inferred from the factory)
type AzureApi = ReturnType<typeof createAzureApi>;

export class AzureDevOpsManager extends BaseProviderManager {
  declare reviewStore: AzureReviewStore;
  declare reviewBridgeStore: AzureReviewBridgeStore | null;
  declare auditLogStore: AzureAuditLogStore | null;

  get azureApi(): AzureApi {
    return this.api as AzureApi;
  }

  findAzureConnection(connectionId: string): AzureConnection | null {
    return this.findConnection(connectionId) as AzureConnection | null;
  }

  resolveAzureConnectionAndToken(connectionId: string): { connection: AzureConnection; token: string } {
    const result = this.resolveConnectionAndToken(connectionId);
    return { connection: result.connection as AzureConnection, token: result.token };
  }

  constructor(
    {
      credentialStore,
      reviewStore,
      reviewBridgeStore = null,
      auditLogStore = null,
      fetchImpl = globalThis.fetch,
      execFileTextImpl = execFileText,
      now = () => Date.now(),
    }: AzureManagerOptions = {} as AzureManagerOptions,
  ) {
    super({
      credentialStore,
      reviewStore,
      reviewBridgeStore,
      auditLogStore,
      fetchImpl,
      execFileTextImpl,
      now,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createApi: createAzureApi as any,
    });
    this.providerLabel = "azure-devops";
    this.defaultGitLogin = "";
  }

  /**
   * Log an Azure DevOps API call to the audit store.
   * Enriches raw request data with current audit context and URL classification.
   */
  override _logAudit(raw: AuditRaw): void {
    if (!this.auditLogStore) return;
    const classification = classifyAzureRequest(raw.method, raw.url);
    const urlInfo = parseAzureUrl(raw.url);
    this.auditLogStore.logEntry({
      ...classification,
      timestamp: new Date().toISOString(),
      connectionId: this._auditConnectionId,
      organization: urlInfo.organization,
      project: urlInfo.project,
      method: raw.method || "GET",
      url: raw.url || "",
      statusCode: raw.statusCode,
      success: raw.success !== false,
      errorMessage: raw.errorMessage || null,
      durationMs: raw.durationMs ?? null,
      userInitiated: this._auditUserInitiated,
    });
  }

  async verifyConnection(
    connectionInput: AzureConnectionInput,
  ): Promise<{ ok: boolean; organization: string; projectCount: number; projects: AzureProject[] }> {
    this.setAuditContext({ connectionId: connectionInput.id || "", userInitiated: true });
    const connection = normalizeConnectionInput(connectionInput);
    const token = String(connectionInput.pat || "").trim();
    if (!connection.orgUrl || !connection.login || !token) {
      throw new Error("Organization URL, login, and PAT are required.");
    }

    const projects = await this.azureApi.listProjects(connection, token);
    return {
      ok: true,
      organization: connection.orgUrl,
      projectCount: projects.length,
      projects: (projects as AzureProject[]).map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description || "",
        state: project.state || "",
      })),
    };
  }

  async sync({
    connections = [] as AzureConnection[],
    workspaces = [] as ReviewWorkspace[],
    gitSnapshots = {} as Record<string, unknown>,
    activeProfileId = "default",
  } = {}) {
    const reviewState = this.reviewStore.getState();
    const startedAt = new Date(this.now()).toISOString();
    // Immediately apply the new connections list so any intermediate broadcastState
    // (triggered by emitUpdated) reflects the correct profile-filtered connections.
    const connectionsChanged =
      JSON.stringify(connections.map((c) => c.id).sort()) !==
      JSON.stringify((this.snapshot.connections || []).map((c) => c.id).sort());

    this.snapshot = {
      ...(connectionsChanged ? createEmptySnapshot() : this.snapshot),
      connections: connections as unknown as typeof this.snapshot.connections,
      sync: {
        ...this.snapshot.sync,
        running: true,
        lastStartedAt: startedAt,
      },
    };
    this.emitUpdated();

    const connectionSnapshots: AzureConnectionSnapshot[] = [];
    const visibleSummaries: AzurePrSummary[] = [];
    const detailMap: Record<string, AzurePrSummary> = { ...this.snapshot.pullRequests } as Record<
      string,
      AzurePrSummary
    >;
    const trackedPullRequests: Record<string, TrackedPullRequest> = {};
    const newActivityEvents: unknown[] = [];

    for (const connection of connections.filter((entry) => entry.enabled !== false)) {
      this.setAuditContext({ connectionId: connection.id, userInitiated: false });
      const persistedState = reviewState.connections?.[connection.id] || {};
      const connectionSnapshot = createConnectionSnapshot(connection, persistedState);
      connectionSnapshots.push(connectionSnapshot);
      const seedingConnection = shouldSeedConnection(this._seededConnections, connection.id);

      try {
        const token = this.credentialStore.getSecret(connection.tokenRef);
        if (!token) {
          throw new Error("PAT is missing.");
        }

        const projects = (await this.azureApi.listProjects(connection, token)) as AzureProject[];
        const filteredProjects = connection.projectFilters?.length
          ? projects.filter(
              (project) =>
                connection.projectFilters!.includes(project.name) || connection.projectFilters!.includes(project.id),
            )
          : projects;

        for (const project of filteredProjects) {
          const pullRequests = (await this.azureApi.listPullRequestsByProject(
            connection,
            token,
            project.name,
          )) as Array<{
            pullRequestId: string | number;
            repository: { id: string; name: string };
            [key: string]: unknown;
          }>;
          for (const pr of pullRequests) {
            if (connection.repositoryFilters?.length) {
              const matchesRepository =
                connection.repositoryFilters.includes(pr.repository?.id) ||
                connection.repositoryFilters.includes(pr.repository?.name);
              if (!matchesRepository) {
                continue;
              }
            }

            const threads = (await this.azureApi.listThreads(
              connection,
              token,
              project.name,
              pr.repository.id,
              pr.pullRequestId,
            )) as Array<Record<string, unknown>>;
            const prKey = createPullRequestKey(connection.id, pr.repository.id, pr.pullRequestId);
            const tracked = this.reviewStore.getTrackedPullRequest(prKey) || {};
            const { summary, internals } = buildPullRequestSummary({
              connection,
              pr: pr as Record<string, unknown>,
              projectName: project.name,
              threads,
              tracked,
              workspaces: workspaces as Array<{ id: string; profileId?: string; [key: string]: unknown }>,
              gitSnapshots,
              activeProfileId,
              now: this.now,
            });
            const typedSummary = summary as AzurePrSummary;
            const typedInternals = internals as Record<string, unknown>;
            visibleSummaries.push(typedSummary);

            const { events, lastNotifiedActivityAt } = this._detectAzureReviewActivityDeltas({
              connection,
              tracked,
              summary: typedSummary,
              internals: typedInternals,
              seedingConnection,
            });
            newActivityEvents.push(...events);

            if (this.reviewBridgeStore?.syncPullRequest) {
              try {
                await this.reviewBridgeStore.syncPullRequest(typedSummary);
              } catch (error) {
                this.log.warn("review bridge sync failed", { prKey, err: (error as Error).message || String(error) });
              }
            }
            trackedPullRequests[prKey] = {
              ...(tracked || {}),
              key: prKey,
              connectionId: connection.id,
              pullRequestId: pr.pullRequestId,
              repositoryId: pr.repository.id,
              projectName: project.name,
              repositoryName: pr.repository.name,
              reviewWorkspaceId: typedSummary.reviewWorkspaceId || tracked.reviewWorkspaceId || "",
              lastRemoteActivityAt: typedSummary.lastRemoteActivityAt,
              lastVoteSignature: typedInternals.voteSignature as string | null,
              lastMergeStatus: typedSummary.pullRequest?.mergeStatus,
              lastSourceCommitId: typedSummary.pullRequest?.sourceCommitId,
              lastSeenActivityAt: tracked.lastSeenActivityAt || null,
              lastNotifiedActivityAt: lastNotifiedActivityAt as string | null,
            };
            detailMap[prKey] = {
              ...(detailMap[prKey] || {}),
              ...typedSummary,
              threads: typedSummary.threads,
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
          lastSyncAt: connectionSnapshot.lastSyncAt,
          lastSuccessAt: connectionSnapshot.lastSuccessAt ?? undefined,
        });
      } catch (error) {
        connectionSnapshot.status = "error";
        connectionSnapshot.lastError = (error as Error).message || "Azure sync failed.";
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
        provider: "azure-devops",
        connection,
        prevState: persistedState,
        currentStatus: connectionSnapshot.status,
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
      if (ws.review?.provider !== "azure-devops" || !ws.review?.prKey) continue;
      const key = ws.review.prKey;
      if (trackedPullRequests[key]) continue; // still active
      const existing = detailMap[key];
      if (existing && existing.pullRequest?.status !== "active") continue; // already resolved
      const conn = connections.find((c) => c.id === ws.review!.connectionId);
      const token = conn && this.credentialStore.getSecret(conn.tokenRef);
      if (!conn || !token) continue;
      try {
        const pr = (await this.azureApi.getPullRequestById(
          conn,
          token,
          ws.review!.project?.name || "",
          ws.review!.repository?.id || "",
          ws.review!.pullRequest?.id || "",
        )) as { status?: string; closedDate?: string | null };
        const resolved: AzurePrSummary = {
          ...(existing || {}),
          connectionId: ws.review!.connectionId || "",
          project: ws.review!.project as AzurePrSummary["project"],
          repository: ws.review!.repository as AzurePrSummary["repository"],
          prKey: key,
          pullRequest: {
            ...((existing?.pullRequest || ws.review!.pullRequest || {}) as AzurePrSummary["pullRequest"]),
            id: existing?.pullRequest?.id ?? "",
            status: pr.status || "completed",
            closedDate: pr.closedDate ?? undefined,
          },
        };
        detailMap[key] = resolved;
      } catch {
        // API failed — mark as completed so we don't retry every poll
        detailMap[key] = {
          ...(existing || {}),
          connectionId: ws.review!.connectionId || "",
          project: ws.review!.project as AzurePrSummary["project"],
          repository: ws.review!.repository as AzurePrSummary["repository"],
          prKey: key,
          pullRequest: {
            ...((existing?.pullRequest || ws.review!.pullRequest || {}) as AzurePrSummary["pullRequest"]),
            id: existing?.pullRequest?.id ?? "",
            status: "completed",
          },
        };
      }
    }

    for (const [key, tracked] of Object.entries(trackedPullRequests)) {
      await this.reviewStore.upsertTrackedPullRequest(key, tracked);
    }

    const recentlyUpdated = visibleSummaries
      .slice()
      .sort((left, right) => parseDate(right.lastActivityAt) - parseDate(left.lastActivityAt));
    const snapshot = {
      connections: connectionSnapshots as unknown as typeof this.snapshot.connections,
      inbox: {
        needsMyReview: visibleSummaries
          .filter((summary) => summary.role === "reviewer")
          .sort((left, right) => {
            if (left.hasAttention !== right.hasAttention) {
              return Number(right.hasAttention) - Number(left.hasAttention);
            }
            return parseDate(right.lastActivityAt) - parseDate(left.lastActivityAt);
          }),
        myPullRequests: visibleSummaries
          .filter((summary) => summary.role === "author")
          .sort((left, right) => {
            if (left.hasAttention !== right.hasAttention) {
              return Number(right.hasAttention) - Number(left.hasAttention);
            }
            return parseDate(right.lastActivityAt) - parseDate(left.lastActivityAt);
          }),
        recentlyUpdated,
        needsAttention: visibleSummaries
          .filter((summary) => summary.hasAttention)
          .sort((left, right) => parseDate(right.lastActivityAt) - parseDate(left.lastActivityAt)),
      },
      trackedPullRequests,
      pullRequests: detailMap,
      reviewActivity: appendReviewActivity(this.snapshot.reviewActivity, newActivityEvents),
      sync: {
        running: false,
        lastStartedAt: startedAt,
        lastCompletedAt: new Date(this.now()).toISOString(),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.setSnapshot(snapshot as any);
    return this.getSnapshot();
  }

  /**
   * Compare a PR summary against its tracked state and emit review-activity
   * events for changes caused by people other than the current user.
   *
   * Returns `{ events, lastNotifiedActivityAt }`. The caller persists the new
   * marker in the tracked store so the next poll starts from here.
   *
   * On the connection's first sync (seedingConnection=true) we silently seed
   * every PR's marker to avoid a flood of "new" events at app startup.
   */
  _detectAzureReviewActivityDeltas({
    connection,
    tracked,
    summary: summaryIn,
    internals,
    seedingConnection,
  }: {
    connection: AzureConnection;
    tracked: TrackedPullRequest;
    summary: AzurePrSummary;
    internals: Record<string, unknown>;
    seedingConnection: boolean;
  }): { events: unknown[]; lastNotifiedActivityAt: string | null } {
    // Cast to the ReviewSummaryRef shape expected by buildReviewActivityEvent
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = summaryIn as any;
    const nowIso = new Date(this.now()).toISOString();
    const events: unknown[] = [];

    if (seedingConnection) {
      return {
        events,
        lastNotifiedActivityAt: seedNotifiedTimestamp(summary, nowIso),
      };
    }

    const prevNotifiedAt = tracked.lastNotifiedActivityAt || "";

    // Brand-new PR that wasn't in the tracked store before this poll.
    // Emit a `pr-new` event when the current user is the requested reviewer.
    if (!prevNotifiedAt) {
      if (summary.role === "reviewer") {
        events.push(
          buildReviewActivityEvent({
            provider: "azure-devops",
            summary,
            kind: "pr-new",
            at: summary.lastRemoteActivityAt || nowIso,
            title: `Review requested: ${summary.repository.name} #${summary.pullRequest.id}`,
            body: truncateBody(`${summary.author.displayName}: ${summary.pullRequest.title}`),
            actor: { login: summary.author.uniqueName, displayName: summary.author.displayName },
          }),
        );
      }
      return {
        events,
        lastNotifiedActivityAt: seedNotifiedTimestamp(summary, nowIso),
      };
    }

    // 1) New comments from other people.
    const newComments = filterNewComments({
      comments: internals.commentsByOthers as AzureComment[],
      sinceIsoString: prevNotifiedAt,
      isSelf: (author) =>
        identityMatches(
          connection.login,
          author as { uniqueName?: string; mailAddress?: string; displayName?: string; id?: string },
        ),
      getTimestamp: (comment) => comment.lastUpdatedDate || comment.publishedDate,
      getAuthor: (comment) => comment.author,
    });
    if (newComments.length > 0) {
      const latest = newComments[newComments.length - 1];
      const actor = {
        login: latest.author?.uniqueName || "",
        displayName: latest.author?.displayName || latest.author?.uniqueName || "Someone",
      };
      const title =
        newComments.length > 1
          ? `${newComments.length} new comments on ${summary.repository.name} #${summary.pullRequest.id}`
          : `New comment on ${summary.repository.name} #${summary.pullRequest.id}`;
      events.push(
        buildReviewActivityEvent({
          provider: "azure-devops",
          summary,
          kind: "pr-new-comment",
          at: latest.lastUpdatedDate || latest.publishedDate || nowIso,
          title,
          body: truncateBody(`${actor.displayName}: ${latest.content || ""}`),
          actor,
        }),
      );
    }

    // 2) Vote change by a reviewer other than the current user.
    if (tracked.lastVoteSignature && tracked.lastVoteSignature !== (internals.voteSignature as string | undefined)) {
      const prevMap = parseAzureVoteSignature(tracked.lastVoteSignature);
      const currMap = parseAzureVoteSignature(internals.voteSignature as string | undefined);
      const changedIds = diffSignatureKeys(prevMap, currMap, internals.myReviewerId as string | undefined);
      const reviewerMap = internals.reviewerMap as Map<
        string,
        {
          id: string;
          displayName: string;
          uniqueName: string;
          vote: number;
          isRequired: boolean;
          hasDeclined: boolean;
          isContainer: boolean;
        }
      >;
      const changedReviewers = changedIds
        .map((id) => reviewerMap.get(id))
        .filter((reviewer) => reviewer && !identityMatches(connection.login, reviewer));
      if (changedReviewers.length > 0) {
        const reviewer = changedReviewers[0]!;
        const voteLabel =
          reviewer.vote >= 10
            ? "approved"
            : reviewer.vote === 5
              ? "approved with suggestions"
              : reviewer.vote === -5
                ? "is waiting for the author"
                : reviewer.vote <= -10
                  ? "rejected the changes"
                  : "reset their vote";
        events.push(
          buildReviewActivityEvent({
            provider: "azure-devops",
            summary,
            kind: "pr-vote-changed",
            at: nowIso,
            title: `Review updated on ${summary.repository.name} #${summary.pullRequest.id}`,
            body: truncateBody(`${reviewer.displayName} ${voteLabel}.`),
            actor: { login: reviewer.uniqueName, displayName: reviewer.displayName },
            urgency: reviewer.vote <= -10 ? "urgent" : "normal",
          }),
        );
      }
    }

    // 3) Source branch updated — only notify when the pusher is someone else.
    if (
      tracked.lastSourceCommitId &&
      tracked.lastSourceCommitId !== (internals.sourceCommitId as string | undefined) &&
      internals.sourceCommitId
    ) {
      type GitIdentity = {
        name?: string;
        email?: string;
        mailAddress?: string;
        uniqueName?: string;
        displayName?: string;
      };
      const pusher = (internals.sourceCommitter || internals.sourceCommitAuthor || null) as GitIdentity | null;
      // Azure git-commit identity uses `{ name, email }` while user identity
      // uses `{ uniqueName, mailAddress, displayName }` — normalize before
      // comparing so a push by the current user is correctly self-filtered.
      const pusherIdentity = pusher
        ? {
            ...pusher,
            mailAddress: pusher.email || pusher.mailAddress || "",
            uniqueName: pusher.email || pusher.uniqueName || "",
            displayName: pusher.name || pusher.displayName || "",
          }
        : null;
      if (!identityMatches(connection.login, pusherIdentity)) {
        events.push(
          buildReviewActivityEvent({
            provider: "azure-devops",
            summary,
            kind: "pr-source-updated",
            at: (internals.latestCommitAt as string | undefined) || nowIso,
            title: `${summary.repository.name} #${summary.pullRequest.id} has new commits`,
            body: truncateBody(pusher?.name ? `${pusher.name} pushed updates.` : "New commits were pushed."),
            actor: pusher ? { login: pusher.email || "", displayName: pusher.name || "" } : null,
          }),
        );
      }
    }

    // 4) Merge status turned bad (conflicts, policy rejection) — urgent for the author.
    if (
      summary.role === "author" &&
      tracked.lastMergeStatus &&
      tracked.lastMergeStatus !== (internals.mergeStatus as string | undefined)
    ) {
      const normalized = String(internals.mergeStatus || "").toLowerCase();
      const isBad =
        normalized.includes("conflict") ||
        normalized.includes("fail") ||
        normalized.includes("reject") ||
        normalized === "rejectedbypolicy";
      if (isBad) {
        events.push(
          buildReviewActivityEvent({
            provider: "azure-devops",
            summary,
            kind: "pr-merge-status-changed",
            at: nowIso,
            title: `${summary.repository.name} #${summary.pullRequest.id} needs attention`,
            body: truncateBody(`Merge status: ${internals.mergeStatus}`),
            urgency: "urgent",
          }),
        );
      }
    }

    return {
      events,
      lastNotifiedActivityAt: events.length > 0 ? nowIso : prevNotifiedAt,
    };
  }

  async ensurePullRequestDetail(
    prKey: string,
    { workspaces = [] as ReviewWorkspace[], force = false } = {},
  ): Promise<AzurePrSummary> {
    const current = (this.snapshot.pullRequests[prKey] || this.findSummary(prKey)) as AzurePrSummary | null;
    if (!current) {
      throw new Error("Pull request is not available in the current Azure snapshot.");
    }
    if (!force && Array.isArray(current.changedFiles) && current.checks?.items) {
      return current;
    }

    this.setAuditContext({ connectionId: current.connectionId || "", userInitiated: true });
    const connection = this.findConnection(current.connectionId) as AzureConnection | null;
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }

    const [changes, pullRequestStatuses, policyEvaluations] = await Promise.all([
      this.azureApi
        .listIterationChanges(connection, token, current.project!.name, current.repository!.id, current.pullRequest!.id)
        .catch(() => []),
      this.azureApi
        .listPullRequestStatuses(
          connection,
          token,
          current.project!.name,
          current.repository!.id,
          current.pullRequest!.id,
        )
        .catch(() => []),
      this.azureApi
        .listPolicyEvaluations(connection, token, current.project!.name, current.project!.id, current.pullRequest!.id)
        .catch(() => []),
    ]);
    const workspace: ReviewWorkspace | undefined =
      (findWorkspaceForPullRequest(workspaces as Array<{ id: string; [key: string]: unknown }>, prKey) as
        | ReviewWorkspace
        | undefined) ||
      (current.existingWorkspaceId
        ? (workspaces as ReviewWorkspace[]).find((entry) => entry.id === current.existingWorkspaceId)
        : undefined);
    const localChanges = workspace?.cwd
      ? await this.listLocalChangedFiles(workspace.cwd, current.pullRequest!.targetRefName || "").catch(() => [])
      : [];

    const enrichedThreads = workspace?.cwd
      ? await this.readThreadCodeSnippets(
          workspace.cwd,
          current.threads || [],
          current.pullRequest!.targetRefName || "",
        ).catch(() => current.threads || [])
      : current.threads || [];

    // Fetch build details for timestamps (for all checks with buildId)
    type PolicyEval = { context?: { buildId?: string | number | null } };
    const buildIds = [
      ...new Set((policyEvaluations as PolicyEval[]).map((e) => e?.context?.buildId).filter(Boolean)),
    ] as Array<string | number>;
    const buildDetails: Record<string, unknown> = {};
    if (buildIds.length) {
      const details = await Promise.all(
        buildIds.map((id) =>
          this.azureApi.fetchBuildDetail(connection, token, current.project!.name, id).catch(() => null),
        ),
      );
      for (const detail of details as Array<{ id?: string | number } | null>) {
        if (detail?.id) buildDetails[String(detail.id)] = detail;
      }
    }

    const checksResult = buildCheckSummary({
      policyEvaluations: policyEvaluations as any, // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: runtime policy evaluation shape is open-ended ADO API JSON
      statuses: pullRequestStatuses as any, // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: runtime status shape is open-ended ADO API JSON
      buildDetails: buildDetails as any, // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: runtime build detail shape is open-ended ADO API JSON
    });

    // Fetch build timeline errors for failed checks that have a buildId
    type CheckItem = {
      id?: string;
      state?: string;
      buildId?: string | number | null;
      errorMessage?: string;
      [key: string]: unknown;
    };
    const failedWithBuild = ((checksResult.items as CheckItem[]) || []).filter(
      (item) => item.state === "failed" && item.buildId && !item.errorMessage,
    );
    if (failedWithBuild.length) {
      const errorResults = await Promise.all(
        failedWithBuild.map((item) =>
          this.azureApi
            .fetchBuildErrors(connection, token, current.project!.name, item.buildId)
            .then((msg) => ({ id: item.id, errorMessage: msg as string })),
        ),
      );
      const errorMap = new Map(errorResults.filter((e) => e.errorMessage).map((e) => [e.id, e.errorMessage]));
      if (errorMap.size) {
        checksResult.items = (checksResult.items as CheckItem[]).map((item) =>
          errorMap.has(item.id) ? { ...item, errorMessage: errorMap.get(item.id) } : item,
        );
      }
    }

    const next: AzurePrSummary = {
      ...current,
      changedFiles: changes,
      localChangedFiles: localChanges,
      threads: enrichedThreads as AzureThread[],
      checks: checksResult as AzurePrSummary["checks"],
      existingWorkspaceId: workspace?.id || current.existingWorkspaceId || "",
      reviewWorkspaceId:
        (workspace as ReviewWorkspace)?.review?.provider === "azure-devops"
          ? (workspace as ReviewWorkspace).id
          : current.reviewWorkspaceId || "",
    };

    this.setSnapshot({
      ...this.snapshot,
      pullRequests: {
        ...this.snapshot.pullRequests,
        [prKey]: next as unknown as (typeof this.snapshot.pullRequests)[string],
      },
    });
    if (this.reviewBridgeStore?.syncPullRequest) {
      try {
        await this.reviewBridgeStore.syncPullRequest(next);
      } catch (error) {
        this.log.warn("review bridge detail sync failed", { prKey, err: (error as Error).message || String(error) });
      }
    }
    return next;
  }

  async rerunCheck(prKey: string, checkItem: AzureCheckItem): Promise<AzurePrSummary> {
    const current = this.snapshot.pullRequests?.[prKey] as AzurePrSummary | undefined;
    if (!current) throw new Error(`PR ${prKey} not found in snapshot`);
    const connection = this.findConnection(current.connectionId) as AzureConnection | null;
    if (!connection) throw new Error(`Connection not found for PR ${prKey}`);
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error(`No credentials found for connection "${connection.label || connection.id}"`);
    this.setAuditContext({ connectionId: connection.id, userInitiated: true });

    if (checkItem.kind === "policy" && checkItem.evaluationId) {
      this.log.info("re-evaluating policy", { evaluationId: checkItem.evaluationId, prKey });
      await this.azureApi.reEvaluatePolicy(
        connection,
        token,
        current.project!.name,
        current.project!.id,
        checkItem.evaluationId,
      );
    } else {
      throw new Error(
        `Cannot re-run check "${checkItem.name || checkItem.id}": kind=${checkItem.kind}, evaluationId=${checkItem.evaluationId || "missing"}`,
      );
    }

    // Refresh checks after re-run
    return this.ensurePullRequestDetail(prKey, { force: true });
  }

  async readThreadCodeSnippets(cwd: string, threads: AzureThread[] = [], targetRefName = ""): Promise<AzureThread[]> {
    if (!cwd || !threads.length) return threads;
    const targetBranch = stripRefsPrefix(targetRefName);
    const filesNeeded = new Map<string, AzureThread[]>();
    for (const thread of threads) {
      if (thread.filePath && thread.lineStart) {
        const key = thread.filePath;
        if (!filesNeeded.has(key)) {
          filesNeeded.set(key, []);
        }
        filesNeeded.get(key)!.push(thread);
      }
    }
    if (!filesNeeded.size) return threads;

    const snippetMap = new Map<string, string>();
    for (const [filePath] of filesNeeded) {
      try {
        const normalizedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
        const result = await this.execFileText(
          "git",
          ["diff", `origin/${targetBranch}...HEAD`, "--unified=4", "--", normalizedPath],
          { cwd, env: sanitizeGitEnvironment() },
        );
        if (result.stdout) {
          snippetMap.set(filePath, result.stdout);
        }
      } catch {
        // file may not exist in diff
      }
    }

    return threads.map((thread) => {
      if (!thread.filePath || !thread.lineStart) return thread;
      const fullDiff = snippetMap.get(thread.filePath);
      if (!fullDiff) return thread;

      // Extract the relevant hunk around the comment lines
      const lines = fullDiff.split(/\r?\n/);
      const contextLines: string[] = [];
      let inRelevantHunk = false;
      let currentNewLine = 0;
      const targetStart = Math.max(1, thread.lineStart - 2);
      const targetEnd = (thread.lineEnd || thread.lineStart) + 2;

      for (const line of lines) {
        // eslint-disable-next-line security/detect-unsafe-regex -- git diff hunk header; bounded by \d+ quantifiers, no exponential backtracking path
        const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
        if (hunkMatch) {
          currentNewLine = Number.parseInt(hunkMatch[1], 10);
          inRelevantHunk = currentNewLine <= targetEnd + 10;
          if (inRelevantHunk) contextLines.push(line);
          continue;
        }
        if (!inRelevantHunk) continue;

        if (line.startsWith("-")) {
          if (currentNewLine >= targetStart && currentNewLine <= targetEnd + 5) {
            contextLines.push(line);
          }
        } else {
          if (line.startsWith("+")) {
            if (currentNewLine >= targetStart && currentNewLine <= targetEnd) {
              contextLines.push(`${String(currentNewLine).padStart(4)} ${line}`);
            }
            currentNewLine++;
          } else {
            if (currentNewLine >= targetStart && currentNewLine <= targetEnd) {
              contextLines.push(`${String(currentNewLine).padStart(4)} ${line}`);
            }
            currentNewLine++;
          }
        }
        if (currentNewLine > targetEnd + 5) {
          inRelevantHunk = false;
        }
      }

      return {
        ...thread,
        codeSnippet: contextLines.length > 0 ? contextLines.join("\n") : "",
      };
    });
  }

  async ensureCacheRepo({
    connection,
    token,
    repository,
    reviewRoot,
  }: {
    connection: AzureConnection;
    token: string;
    repository: { id?: string; name: string; remoteUrl?: string };
    reviewRoot: string;
  }): Promise<string> {
    const repositoryRoot = path.join(
      normalizeReviewRoot(reviewRoot),
      "repos",
      shortPathKey(connection.id, "connection"),
      shortPathKey(repository.id || repository.name, "repository"),
    );
    const repositoryExists = await exists(path.join(repositoryRoot, ".git"));
    await mkdir(path.dirname(repositoryRoot), { recursive: true });
    if (!repositoryExists) {
      await this.runGit(process.cwd(), ["clone", "--no-checkout", repository.remoteUrl!, repositoryRoot], {
        login: connection.login,
        token,
      });
    }
    return repositoryRoot;
  }

  async prepareManagedReviewCheckout({
    summary,
    connection,
    token,
    reviewRoot,
  }: {
    summary: AzurePrSummary;
    connection: AzureConnection;
    token: string;
    reviewRoot: string;
  }): Promise<{ mode: string; rootPath: string; cacheRepoPath: string; sourceBranch: string; targetBranch: string }> {
    try {
      const remoteUrl = firstNonEmpty(
        summary.repository?.remoteUrl,
        buildRepositoryRemoteUrl(
          connection,
          summary.project?.name || "",
          summary.repository?.name || summary.repository?.id || "",
        ),
      );
      if (!remoteUrl) {
        throw new Error("Pull request repository clone URL is missing.");
      }

      const sourceBranch = stripRefsPrefix(summary.pullRequest!.sourceRefName || "");
      if (!sourceBranch) {
        throw new Error("Pull request source branch is missing.");
      }

      const targetBranch = stripRefsPrefix(summary.pullRequest!.targetRefName || "");
      if (!targetBranch) {
        throw new Error("Pull request target branch is missing.");
      }

      const repository: { id?: string; name: string; remoteUrl?: string } = {
        ...summary.repository,
        name: summary.repository?.name || summary.repository?.id || "",
        remoteUrl,
      };
      const cacheRepoPath = await this.ensureCacheRepo({ connection, token, repository, reviewRoot });
      const worktreePath = path.join(
        normalizeReviewRoot(reviewRoot),
        "reviews",
        shortPathKey(connection.id, "connection"),
        `pr-${summary.pullRequest!.id}`,
      );

      await this.runGit(
        cacheRepoPath,
        [
          "fetch",
          "origin",
          `+${summary.pullRequest!.sourceRefName}:refs/remotes/origin/${sourceBranch}`,
          `+${summary.pullRequest!.targetRefName}:refs/remotes/origin/${targetBranch}`,
        ],
        {
          login: connection.login,
          token,
        },
      );

      await mkdir(path.dirname(worktreePath), { recursive: true });
      await this.runGit(cacheRepoPath, ["worktree", "prune"]).catch(() => {});
      const worktreeExists = await exists(path.join(worktreePath, ".git"));
      const localBranch = `pr-${summary.pullRequest!.id}-${sanitizePathSegment(sourceBranch)}`;

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
          const ahead = await this.runGit(worktreePath, [
            "rev-list",
            "--count",
            `refs/remotes/origin/${sourceBranch}..HEAD`,
          ]).catch(() => ({ stdout: "0" }));
          if (Number(ahead.stdout.trim()) === 0) {
            await this.runGit(worktreePath, ["reset", "--hard", `refs/remotes/origin/${sourceBranch}`]);
          }
        } else {
          await this.runGit(cacheRepoPath, [
            "worktree",
            "add",
            "--force",
            "-b",
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
          // Only reset if local branch has no commits ahead of remote,
          // to avoid discarding unpushed work from a previous session.
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
      if (friendlyMessage) {
        throw new Error(friendlyMessage, { cause: error });
      }
      throw error;
    }
  }

  buildReviewMetadata(
    summary: AzurePrSummary,
    checkout: ReviewCheckout,
    mode = checkout.mode,
    extra: { parentWorkspaceId?: string } = {},
  ) {
    return {
      provider: "azure-devops",
      prKey: summary.prKey,
      connectionId: summary.connectionId,
      orgUrl: summary.orgUrl,
      parentWorkspaceId: extra.parentWorkspaceId || "",
      project: clone(summary.project),
      repository: clone(summary.repository),
      pullRequest: clone(summary.pullRequest),
      role: summary.role,
      checkout: {
        mode,
        rootPath: checkout.rootPath,
        cacheRepoPath: checkout.cacheRepoPath || "",
      },
    };
  }

  buildManagedReviewPaths(
    summary: AzurePrSummary | null | undefined,
    { profileId = "default", workspaces = [] as ReviewWorkspace[] } = {},
  ) {
    const connection = this.findConnection(summary?.connectionId || "") as AzureConnection | null;
    if (!connection || !summary?.pullRequest?.id) {
      return null;
    }

    const parentAzureWorkspace =
      (workspaces || []).find(
        (workspace) => workspace.kind === "azure" && (workspace.profileId || "default") === (profileId || "default"),
      ) || null;
    const reviewRoot = parentAzureWorkspace?.cwd || connection.reviewRoot || getDefaultReviewRoot();

    return {
      parentWorkspaceId: parentAzureWorkspace?.id || "",
      reviewRoot: normalizeReviewRoot(reviewRoot),
      cacheRepoPath: path.join(
        normalizeReviewRoot(reviewRoot),
        "repos",
        shortPathKey(connection.id, "connection"),
        shortPathKey(summary.repository?.id || summary.repository?.name, "repository"),
      ),
      rootPath: path.join(
        normalizeReviewRoot(reviewRoot),
        "reviews",
        shortPathKey(connection.id, "connection"),
        `pr-${summary.pullRequest.id}`,
      ),
    };
  }

  async openReviewWorkspace({
    state,
    prKey,
    workspaceId = "",
  }: {
    state: { workspaces: ReviewWorkspace[]; windowSlots?: Array<{ profileId?: string }>; tabTemplates?: unknown[] };
    prKey: string;
    workspaceId?: string;
  }) {
    const summary = await this.ensurePullRequestDetail(prKey, {
      workspaces: state.workspaces,
    });
    const connection = this.findAzureConnection(summary.connectionId);
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }

    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }

    const activeProfile = (state.windowSlots || [])[0]?.profileId || "default";
    const profileWorkspaces = state.workspaces.filter((ws) => (ws.profileId || "default") === activeProfile);
    const existingWorkspace: ReviewWorkspace | null | undefined = workspaceId
      ? profileWorkspaces.find((workspace) => workspace.id === workspaceId)
      : (findWorkspaceForPullRequest(profileWorkspaces, prKey) as ReviewWorkspace | undefined) ||
        (summary.role === "author" && summary.existingWorkspaceId
          ? profileWorkspaces.find((workspace) => workspace.id === summary.existingWorkspaceId)
          : null);

    const reviewProfileId = existingWorkspace?.profileId || activeProfile;
    const parentAzureWorkspace =
      state.workspaces.find(
        (workspace) => workspace.kind === "azure" && (workspace.profileId || "default") === reviewProfileId,
      ) || null;
    const parentWorkspaceId = parentAzureWorkspace?.id || existingWorkspace?.review?.parentWorkspaceId || "";

    if (existingWorkspace) {
      if (!String(existingWorkspace.cwd || "").trim()) {
        throw new Error(
          `Matched workspace "${existingWorkspace.name || existingWorkspace.id}" does not have a working directory.`,
        );
      }
      const checkout: ReviewCheckout = existingWorkspace.review?.checkout || {
        mode: existingWorkspace.review?.provider === "azure-devops" ? "managed-worktree" : "linked-existing-workspace",
        rootPath: existingWorkspace.cwd || "",
        cacheRepoPath: "",
      };
      const workspace = {
        ...existingWorkspace,
        review: this.buildReviewMetadata(summary, checkout, checkout.mode, {
          parentWorkspaceId: checkout.mode === "managed-worktree" ? parentWorkspaceId : "",
        }),
      };
      await this.reviewStore.upsertTrackedPullRequest(prKey, {
        reviewWorkspaceId: workspace.id,
        lastSeenActivityAt: summary.lastRemoteActivityAt || new Date(this.now()).toISOString(),
      });
      return {
        workspace,
        created: false,
        attached: checkout.mode === "linked-existing-workspace",
      };
    }

    const checkout = await this.prepareManagedReviewCheckout({
      summary,
      connection,
      token,
      reviewRoot: parentAzureWorkspace?.cwd || connection.reviewRoot || getDefaultReviewRoot(),
    });
    const panels = createReviewWorkspacePanels(
      (parentAzureWorkspace?.panels || []) as any[], // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: panels is open-ended server JSON
      (state.tabTemplates || []) as any[], // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: tabTemplates is open-ended server JSON
    );
    const workspace = {
      id: `workspace-${randomUUID()}`,
      name: `${summary.repository?.name} PR #${summary.pullRequest?.id}`,
      icon: AZURE_REVIEW_ICON,
      color: AZURE_REVIEW_COLOR,
      kind: "terminal",
      source: "manual",
      pluginId: "",
      cwd: checkout.rootPath,
      notes: `Azure DevOps review workspace for ${summary.repository?.name} PR #${summary.pullRequest?.id}`,
      // Land the review workspace on the same profile as its Azure parent /
      // its connection (already resolved as reviewProfileId above) — using
      // state.activeProfileId here puts the review on whatever profile the
      // user happens to be looking at, hiding it on the profile that owns
      // the connection.
      profileId: reviewProfileId,
      activePanelId: panels[0]?.id || "",
      panels,
      review: this.buildReviewMetadata(summary, checkout, checkout.mode, {
        parentWorkspaceId: parentWorkspaceId || "",
      }),
    };
    await this.reviewStore.upsertTrackedPullRequest(prKey, {
      reviewWorkspaceId: workspace.id,
      lastSeenActivityAt: summary.lastRemoteActivityAt || new Date(this.now()).toISOString(),
    });
    return {
      workspace,
      created: true,
      attached: false,
    };
  }

  async addPullRequestComment({
    prKey,
    content,
    threadId = null as string | number | null,
    parentCommentId = 0,
  }: {
    prKey: string;
    content: string;
    threadId?: string | number | null;
    parentCommentId?: number;
  }): Promise<void> {
    const summary = await this.ensurePullRequestDetail(prKey);
    this.setAuditContext({ connectionId: summary.connectionId || "", userInitiated: true });
    const connection = this.findAzureConnection(summary.connectionId);
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }
    const payload = threadId
      ? {
          content,
          parentCommentId,
          commentType: 1,
        }
      : {
          comments: [
            {
              parentCommentId: 0,
              content,
              commentType: 1,
            },
          ],
          status: "active",
        };
    const url = threadId
      ? this.azureApi.buildCreateCommentUrl(
          connection,
          summary.project!.name,
          summary.repository!.id,
          summary.pullRequest!.id,
          threadId,
        )
      : this.azureApi.buildCreateThreadUrl(
          connection,
          summary.project!.name,
          summary.repository!.id,
          summary.pullRequest!.id,
        );
    await this.azureApi.requestJson(url, {
      login: connection.login,
      token,
      method: "POST",
      body: payload,
    });
  }

  async updateThreadStatus({
    prKey,
    threadId,
    status,
  }: {
    prKey: string;
    threadId: string | number;
    status: string;
  }): Promise<void> {
    const summary = await this.ensurePullRequestDetail(prKey);
    this.setAuditContext({ connectionId: summary.connectionId || "", userInitiated: true });
    const connection = this.findAzureConnection(summary.connectionId);
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }
    await this.azureApi.requestJson(
      this.azureApi.buildUpdateThreadUrl(
        connection,
        summary.project!.name,
        summary.repository!.id,
        summary.pullRequest!.id,
        threadId,
      ),
      {
        login: connection.login,
        token,
        method: "PATCH",
        body: { status },
      },
    );
  }

  async setPullRequestVote({ prKey, vote }: { prKey: string; vote: number }): Promise<void> {
    const summary = await this.ensurePullRequestDetail(prKey);
    this.setAuditContext({ connectionId: summary.connectionId || "", userInitiated: true });
    const connection = this.findAzureConnection(summary.connectionId);
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    if (!summary.myReviewerId) {
      throw new Error("Current user is not an active reviewer on this pull request.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }
    await this.azureApi.requestJson(
      this.azureApi.buildReviewerUrl(
        connection,
        summary.project!.name,
        summary.repository!.id,
        summary.pullRequest!.id,
        summary.myReviewerId,
      ),
      {
        login: connection.login,
        token,
        method: "PUT",
        body: {
          id: summary.myReviewerId,
          vote,
        },
      },
    );
  }

  async fetchReviewWorkspace({ workspace }: { workspace: ReviewWorkspace }): Promise<void> {
    const connection = this.findAzureConnection(workspace.review?.connectionId || "");
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }
    this.log.info("fetch review workspace", { workspaceId: workspace.id });
    await this.runGit(workspace.cwd || "", ["fetch", "origin"], {
      login: connection.login,
      token,
    });
  }

  async rebaseReviewWorkspace({ workspace }: { workspace: ReviewWorkspace }): Promise<void> {
    await this.fetchReviewWorkspace({ workspace });
    const targetBranch = stripRefsPrefix(workspace.review?.pullRequest?.targetRefName || "");
    this.log.info("rebase review workspace", { workspaceId: workspace.id, targetBranch });
    await this.runGit(workspace.cwd || "", ["rebase", `origin/${targetBranch}`]);
  }

  findConnectionForRemote(remoteUrl: string): AzureConnection | null {
    const normalized = normalizeRemoteUrl(remoteUrl);
    if (!normalized) return null;
    for (const connection of this.snapshot.connections as AzureConnection[]) {
      if (!connection.enabled) continue;
      const orgNorm = normalizeRemoteUrl(connection.orgUrl);
      if (orgNorm && normalized.startsWith(orgNorm)) {
        return connection;
      }
    }
    return null;
  }

  async resolveRepository(
    connectionId: string,
    remoteUrl: string,
  ): Promise<{
    connection: AzureConnection;
    token: string;
    projectName: string;
    repository: { id: string; name: string; remoteUrl?: string };
  }> {
    const connection = this.findAzureConnection(connectionId);
    if (!connection) throw new Error("Azure DevOps connection not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error("PAT is missing.");

    const normalized = normalizeRemoteUrl(remoteUrl);
    const projects = (await this.azureApi.listProjects(connection, token)) as Array<{ id: string; name: string }>;
    const filteredProjects = connection.projectFilters?.length
      ? projects.filter((p) => connection.projectFilters!.includes(p.name) || connection.projectFilters!.includes(p.id))
      : projects;

    for (const project of filteredProjects) {
      const repos = (await this.azureApi.listRepositories(connection, token, project.name)) as Array<{
        id: string;
        name: string;
        remoteUrl?: string;
      }>;
      for (const repo of repos) {
        if (normalizeRemoteUrl(repo.remoteUrl || "") === normalized) {
          return { connection, token, projectName: project.name, repository: repo };
        }
      }
    }
    throw new Error("Could not find a matching Azure DevOps repository for this workspace.");
  }

  async listRemoteBranches(connectionId: string, remoteUrl: string): Promise<string[]> {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token, projectName, repository } = await this.resolveRepository(connectionId, remoteUrl);
    const refs = (await this.azureApi.listRepositoryRefs(
      connection,
      token,
      projectName,
      repository.id,
      "heads",
    )) as Array<{ name?: string }>;
    return refs.map((ref) => stripRefsPrefix(ref.name || ""));
  }

  async createPullRequestForWorkspace({
    remoteUrl,
    sourceBranch,
    targetBranch,
    title,
    description,
    isDraft = false,
    connectionId = "",
  }: {
    remoteUrl: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description?: string;
    isDraft?: boolean;
    connectionId?: string;
  }): Promise<{ pullRequestId: unknown; url: string; title: unknown }> {
    const connection =
      (connectionId && this.findAzureConnection(connectionId)) || this.findConnectionForRemote(remoteUrl);
    if (!connection) throw new Error("No Azure DevOps connection found for this repository.");
    this.setAuditContext({ connectionId: connection.id, userInitiated: true });
    const { token, projectName, repository } = await this.resolveRepository(connection.id, remoteUrl);
    const result = (await this.azureApi.createPullRequest(connection, token, projectName, repository.id, {
      title,
      description,
      sourceBranch,
      targetBranch,
      isDraft,
    })) as { pullRequestId?: unknown; _links?: { web?: { href?: string } }; title?: unknown };
    return {
      pullRequestId: result.pullRequestId,
      url: result._links?.web?.href || "",
      title: result.title,
    };
  }

  async pushReviewWorkspace({
    workspace,
    force = false,
    branch = "",
  }: {
    workspace: ReviewWorkspace;
    force?: boolean;
    branch?: string;
  }): Promise<void> {
    const connection = this.findAzureConnection(workspace.review?.connectionId || "");
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }
    const prRef = stripRefsPrefix(workspace.review?.pullRequest?.sourceRefName || "");
    const sourceBranch = prRef || branch;
    if (!sourceBranch) {
      throw new Error("Cannot determine branch name for push.");
    }
    // Local branch may be named differently (e.g. pr-123-feature) so push HEAD to the remote branch name
    const pushArgs = force
      ? ["push", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${sourceBranch}`]
      : ["push", "-u", "origin", `HEAD:refs/heads/${sourceBranch}`];
    this.log.info("push review workspace", { workspaceId: workspace.id, sourceBranch, force });
    await this.runGit(workspace.cwd || "", pushArgs, {
      login: connection.login,
      token,
    });
  }

  // ---------------------------------------------------------------------------
  // Quick Fix — forward flow: pick repo/branch → checkout → workspace → PR
  // ---------------------------------------------------------------------------

  buildPrKey(connectionId: string, repositoryId: string, pullRequestId: string | number): string {
    return createPullRequestKey(connectionId, repositoryId, pullRequestId);
  }

  async listQuickFixProjects(connectionId: string): Promise<Array<{ id: string; name: string }>> {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    const projects = (await this.azureApi.listProjects(connection, token)) as Array<{ id: string; name: string }>;
    const filtered = connection.projectFilters?.length
      ? projects.filter((p) => connection.projectFilters!.includes(p.name) || connection.projectFilters!.includes(p.id))
      : projects;
    return filtered.map((p) => ({ id: p.id, name: p.name }));
  }

  async listQuickFixRepositories(
    connectionId: string,
    projectName: string,
  ): Promise<Array<{ id: string; name: string; remoteUrl?: string }>> {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    const repos = (await this.azureApi.listRepositories(connection, token, projectName)) as Array<{
      id: string;
      name: string;
      remoteUrl?: string;
    }>;
    const filtered = connection.repositoryFilters?.length
      ? repos.filter(
          (r) => connection.repositoryFilters!.includes(r.id) || connection.repositoryFilters!.includes(r.name),
        )
      : repos;
    return filtered.map((r) => ({ id: r.id, name: r.name, remoteUrl: r.remoteUrl }));
  }

  async listQuickFixBranches(connectionId: string, projectName: string, repositoryId: string): Promise<string[]> {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    const refs = (await this.azureApi.listRepositoryRefs(
      connection,
      token,
      projectName,
      repositoryId,
      "heads",
    )) as Array<{ name?: string }>;
    return refs.map((ref) => stripRefsPrefix(ref.name || ""));
  }

  async prepareQuickFixCheckout({
    connection,
    token,
    repository,
    baseBranch,
    newBranchName,
    reviewRoot,
  }: {
    connection: AzureConnection;
    token: string;
    repository: { id?: string; name: string; remoteUrl?: string };
    baseBranch: string;
    newBranchName: string;
    reviewRoot: string;
  }): Promise<{ rootPath: string; cacheRepoPath: string; baseBranch: string; newBranchName: string }> {
    const cacheRepoPath = await this.ensureCacheRepo({ connection, token, repository, reviewRoot });

    await this.runGit(
      cacheRepoPath,
      ["fetch", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
      { login: connection.login, token },
    );

    const worktreePath = path.join(
      normalizeReviewRoot(reviewRoot),
      "quickfix",
      shortPathKey(connection.id, "connection"),
      sanitizePathSegment(repository.name),
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

    return { rootPath: worktreePath, cacheRepoPath, baseBranch, newBranchName };
  }

  async openQuickFixWorkspace({
    state,
    connectionId,
    projectName,
    repositoryId,
    repositoryName,
    remoteUrl,
    baseBranch,
    newBranchName,
  }: {
    state: { workspaces: ReviewWorkspace[]; windowSlots?: Array<{ profileId?: string }>; tabTemplates?: unknown[] };
    connectionId: string;
    projectName: string;
    repositoryId: string;
    repositoryName: string;
    remoteUrl: string;
    baseBranch: string;
    newBranchName: string;
  }): Promise<{ workspace: ReviewWorkspace; parentWorkspaceId: string }> {
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);

    // Pin quickfix to the profile that owns the connection — falling back to
    // active profile breaks when the user triggers quickfix from a different
    // profile than the one the connection lives on (the workspace lands on
    // the wrong profile and goes invisible).
    const activeProfile = (connection as { profileId?: string }).profileId || (state.windowSlots || [])[0]?.profileId || "default";
    const parentAzureWorkspace: ReviewWorkspace | null =
      state.workspaces.find(
        (ws: ReviewWorkspace) => ws.kind === "azure" && (ws.profileId || "default") === activeProfile,
      ) || null;
    const reviewRoot = parentAzureWorkspace?.cwd || connection.reviewRoot || getDefaultReviewRoot();

    const repository = { id: repositoryId, name: repositoryName, remoteUrl };
    const checkout = await this.prepareQuickFixCheckout({
      connection,
      token,
      repository,
      baseBranch,
      newBranchName,
      reviewRoot,
    });

    const panels = createReviewWorkspacePanels(
      (parentAzureWorkspace?.panels || []) as any[], // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: panels is open-ended server JSON
      (state.tabTemplates || []) as any[], // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: tabTemplates is open-ended server JSON
    );
    const workspace = {
      id: `workspace-${randomUUID()}`,
      name: newBranchName,
      icon: AZURE_REVIEW_ICON,
      color: AZURE_REVIEW_COLOR,
      kind: "terminal",
      source: "manual",
      pluginId: "",
      cwd: checkout.rootPath,
      notes: "",
      profileId: activeProfile,
      activePanelId: panels[0]?.id || "",
      panels,
      review: {
        provider: "azure-devops",
        prKey: "",
        connectionId,
        orgUrl: connection.orgUrl || "",
        parentWorkspaceId: parentAzureWorkspace?.id || "",
        project: undefined,
        repository: { id: repositoryId, name: repositoryName, remoteUrl },
        pullRequest: undefined,
        role: "author",
        checkout: {
          mode: "managed-worktree",
          rootPath: checkout.rootPath,
          cacheRepoPath: checkout.cacheRepoPath || "",
        },
      },
      quickfix: {
        connectionId,
        projectName,
        repositoryId,
        repositoryName,
        remoteUrl,
        baseBranch,
        parentWorkspaceId: parentAzureWorkspace?.id || "",
      },
    };

    return { workspace, parentWorkspaceId: parentAzureWorkspace?.id || "" };
  }
}

export {
  AZURE_REVIEW_COLOR,
  AZURE_REVIEW_ICON,
  getDefaultReviewRoot,
  createPullRequestKey,
  normalizeConnectionInput,
  normalizeRemoteUrl,
  normalizeReviewRoot,
  shortPathKey,
  stripRefsPrefix,
} from "./azure-devops-utils.js";

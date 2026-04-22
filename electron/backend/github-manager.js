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

export class GitHubManager extends BaseProviderManager {
  constructor({
    credentialStore,
    reviewStore,
    reviewBridgeStore = null,
    auditLogStore = null,
    fetchImpl = globalThis.fetch,
    execFileTextImpl = execFileText,
    now = () => Date.now(),
  } = {}) {
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

  _logAudit(raw) {
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

  async verifyConnection(connectionInput) {
    this.setAuditContext({ connectionId: connectionInput.id || "", userInitiated: true });
    const connection = normalizeConnectionInput(connectionInput);
    const token = String(connectionInput.pat || "").trim();
    if (!connection.hostUrl || !token) {
      throw new Error("Host URL and PAT are required.");
    }

    const user = await this.api.getAuthenticatedUser(connection, token);
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

  async sync({ connections = [], workspaces = [], gitSnapshots = {}, activeProfileId = "default" } = {}) {
    const reviewState = this.reviewStore.getState();
    const startedAt = new Date(this.now()).toISOString();
    const connectionsChanged =
      JSON.stringify(connections.map((c) => c.id).sort()) !==
      JSON.stringify((this.snapshot.connections || []).map((c) => c.id).sort());
    this.snapshot = {
      ...(connectionsChanged ? createEmptySnapshot() : this.snapshot),
      connections,
      sync: {
        ...this.snapshot.sync,
        running: true,
        lastStartedAt: startedAt,
      },
    };
    this.emitUpdated();

    const connectionSnapshots = [];
    const visibleSummaries = [];
    const detailMap = { ...this.snapshot.pullRequests };
    const trackedPullRequests = {};
    const newActivityEvents = [];

    for (const connection of connections.filter((c) => c.enabled !== false)) {
      this.setAuditContext({ connectionId: connection.id, userInitiated: false });
      const persistedState = reviewState.connections?.[connection.id] || {};
      const connectionSnapshot = createConnectionSnapshot(connection, persistedState);
      connectionSnapshots.push(connectionSnapshot);
      const seedingConnection = shouldSeedConnection(this._seededConnections, connection.id);

      try {
        const token = this.credentialStore.getSecret(connection.tokenRef);
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

        const seenPrKeys = new Set();

        for (const query of queries) {
          const searchResults = await this.api.searchPullRequests(connection, token, query);

          for (const item of searchResults) {
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
            const pr = await this.api.getPullRequest(connection, token, prOwner, prRepo, pullNumber);

            // Fetch reviews, review comments, issue comments, requested reviewers
            const [reviews, reviewComments, issueCommentsList, requestedReviewers] = await Promise.all([
              this.api.listReviews(connection, token, prOwner, prRepo, pullNumber).catch(() => []),
              this.api.listReviewComments(connection, token, prOwner, prRepo, pullNumber).catch(() => []),
              this.api.listIssueComments(connection, token, prOwner, prRepo, pullNumber).catch(() => []),
              this.api.listRequestedReviewers(connection, token, prOwner, prRepo, pullNumber).catch(() => ({})),
            ]);

            const tracked = this.reviewStore.getTrackedPullRequest(prKey) || {};
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

            if (this.reviewBridgeStore?.syncPullRequest) {
              try {
                await this.reviewBridgeStore.syncPullRequest(summary);
              } catch (error) {
                this.log.warn("review bridge sync failed", { prKey, err: error.message || String(error) });
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
          lastSyncAt: connectionSnapshot.lastSyncAt,
          lastSuccessAt: connectionSnapshot.lastSuccessAt,
        });
      } catch (error) {
        connectionSnapshot.status = "error";
        connectionSnapshot.lastError = error.message || "GitHub sync failed.";
        connectionSnapshot.lastSyncAt = new Date(this.now()).toISOString();
        await this.reviewStore.upsertConnectionState(connection.id, {
          status: "error",
          lastError: connectionSnapshot.lastError,
          lastSyncAt: connectionSnapshot.lastSyncAt,
        });
      }

      // Mirrors AzureDevOpsManager — notify once per transition into error
      // (or on a different error message), not every poll while the error
      // persists and not on startup if the same error was already persisted.
      const connectionErrorEvent = buildConnectionErrorEvent({
        provider: "github",
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
      if (ws.review?.provider !== "github" || !ws.review?.prKey) continue;
      const key = ws.review.prKey;
      if (trackedPullRequests[key]) continue; // still active
      const existing = detailMap[key];
      if (existing && existing.pullRequest?.state !== "open") continue; // already resolved
      const conn = connections.find((c) => c.id === ws.review.connectionId);
      const token = conn && this.credentialStore.getSecret(conn.tokenRef);
      if (!conn || !token) continue;
      const [owner, repo] = (ws.review.repository?.fullName || "").split("/");
      const pullNumber = ws.review.pullRequest?.number || ws.review.pullRequest?.id;
      if (!owner || !repo || !pullNumber) continue;
      try {
        const pr = await this.api.getPullRequest(conn, token, owner, repo, pullNumber);
        detailMap[key] = {
          ...(existing || {}),
          connectionId: ws.review.connectionId,
          repository: ws.review.repository,
          pullRequest: {
            ...(existing?.pullRequest || ws.review.pullRequest || {}),
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
            ...(existing?.pullRequest || ws.review.pullRequest || {}),
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

  /**
   * Compare a PR summary against its tracked state and emit review-activity
   * events for changes caused by people other than the current user.
   *
   * Mirror of AzureDevOpsManager._detectAzureReviewActivityDeltas — same
   * contract, GitHub-specific identity and vote logic.
   */
  _detectGitHubReviewActivityDeltas({ tracked, summary, internals, seedingConnection }) {
    const nowIso = new Date(this.now()).toISOString();
    const events = [];
    const myLogin = String(internals.myLogin || "").toLowerCase();
    const isSelfLogin = (login) => Boolean(myLogin) && String(login || "").toLowerCase() === myLogin;

    if (seedingConnection) {
      return {
        events,
        lastNotifiedActivityAt: seedNotifiedTimestamp(summary, nowIso),
      };
    }

    const prevNotifiedAt = tracked.lastNotifiedActivityAt || "";

    if (!prevNotifiedAt) {
      if (summary.role === "reviewer") {
        events.push(
          buildReviewActivityEvent({
            provider: "github",
            summary,
            kind: "pr-new",
            at: summary.lastRemoteActivityAt || nowIso,
            title: `Review requested: ${summary.repository.fullName} #${summary.pullRequest.number}`,
            body: truncateBody(`${summary.author.displayName}: ${summary.pullRequest.title}`),
            actor: { login: summary.author.login, displayName: summary.author.displayName },
          }),
        );
      }
      return {
        events,
        lastNotifiedActivityAt: seedNotifiedTimestamp(summary, nowIso),
      };
    }

    // 1) New issue + review comments from other users.
    const newIssue = filterNewComments({
      comments: internals.otherIssueComments,
      sinceIsoString: prevNotifiedAt,
      isSelf: (author) => isSelfLogin(author?.login),
      getTimestamp: (comment) => comment.updated_at || comment.created_at,
      getAuthor: (comment) => comment.user || {},
    });
    const newReview = filterNewComments({
      comments: internals.otherReviewComments,
      sinceIsoString: prevNotifiedAt,
      isSelf: (author) => isSelfLogin(author?.login),
      getTimestamp: (comment) => comment.updated_at || comment.created_at,
      getAuthor: (comment) => comment.user || {},
    });
    const newComments = [...newIssue, ...newReview].sort(
      (a, b) => parseDate(a.updated_at || a.created_at) - parseDate(b.updated_at || b.created_at),
    );
    if (newComments.length > 0) {
      const latest = newComments[newComments.length - 1];
      const actor = {
        login: latest.user?.login || "",
        displayName: latest.user?.name || latest.user?.login || "Someone",
      };
      const title =
        newComments.length > 1
          ? `${newComments.length} new comments on ${summary.repository.fullName} #${summary.pullRequest.number}`
          : `New comment on ${summary.repository.fullName} #${summary.pullRequest.number}`;
      events.push(
        buildReviewActivityEvent({
          provider: "github",
          summary,
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
      const prevMap = parseGitHubReviewSignature(tracked.lastReviewStateSignature);
      const currMap = parseGitHubReviewSignature(internals.reviewStateSignature);
      const changedLogins = diffSignatureKeys(prevMap, currMap, myLogin);
      const changedReviewers = changedLogins
        .map((login) => internals.reviewerMap.get(login))
        .filter((reviewer) => reviewer && !isSelfLogin(reviewer.login));
      if (changedReviewers.length > 0) {
        const reviewer = changedReviewers[0];
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
            summary,
            kind: "pr-vote-changed",
            at: nowIso,
            title: `Review updated on ${summary.repository.fullName} #${summary.pullRequest.number}`,
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
          summary,
          kind: "pr-source-updated",
          at: summary.pullRequest.updatedAt || nowIso,
          title: `${summary.repository.fullName} #${summary.pullRequest.number} has new commits`,
          body: "The source branch was updated.",
        }),
      );
    }

    // 4) Checks newly failing — relevant to the author (they need to fix).
    if (
      summary.role === "author" &&
      tracked.lastChecksSignature &&
      tracked.lastChecksSignature !== internals.checksSignature &&
      internals.checksFailedCount > 0
    ) {
      events.push(
        buildReviewActivityEvent({
          provider: "github",
          summary,
          kind: "pr-checks-failed",
          at: nowIso,
          title: `Checks failing on ${summary.repository.fullName} #${summary.pullRequest.number}`,
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

  async ensurePullRequestDetail(prKey, { workspaces = [], force = false } = {}) {
    const current = this.snapshot.pullRequests[prKey] || this.findSummary(prKey);
    if (!current) throw new Error("Pull request is not available in the current GitHub snapshot.");
    if (!force && Array.isArray(current.changedFiles) && current.checks?.items) return current;

    this.setAuditContext({ connectionId: current.connectionId || "", userInitiated: true });
    const connection = this.findConnection(current.connectionId);
    if (!connection) throw new Error("GitHub connection was not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error("PAT is missing.");

    const owner = current.repository.owner;
    const repo = current.repository.name;
    const pullNumber = current.pullRequest.number;
    const headSha = current.pullRequest.headSha;

    const [files, checkRuns, combinedStatus] = await Promise.all([
      this.api.listPullRequestFiles(connection, token, owner, repo, pullNumber).catch(() => []),
      headSha ? this.api.listCheckRuns(connection, token, owner, repo, headSha).catch(() => []) : [],
      headSha ? this.api.getCombinedStatus(connection, token, owner, repo, headSha).catch(() => null) : null,
    ]);

    const changedFiles = files.map((f) => ({
      path: f.filename || "",
      changeType: f.status || "modified",
      additions: f.additions || 0,
      deletions: f.deletions || 0,
      patch: f.patch || "",
    }));

    // Inline check aggregation
    const checks = { failedCount: 0, pendingCount: 0, passedCount: 0, items: [] };
    for (const run of checkRuns) {
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
    if (combinedStatus?.statuses) {
      for (const status of combinedStatus.statuses) {
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
      findWorkspaceForPullRequest(workspaces, prKey) ||
      (current.existingWorkspaceId ? workspaces.find((ws) => ws.id === current.existingWorkspaceId) : null);
    const localChanges = workspace?.cwd
      ? await this.listLocalChangedFiles(workspace.cwd, stripRefsPrefix(current.pullRequest.targetRefName)).catch(
          () => [],
        )
      : [];

    const next = {
      ...current,
      changedFiles,
      localChangedFiles: localChanges,
      checks,
      existingWorkspaceId: workspace?.id || current.existingWorkspaceId || "",
      reviewWorkspaceId: workspace?.review?.provider === "github" ? workspace.id : current.reviewWorkspaceId || "",
    };

    this.setSnapshot({
      ...this.snapshot,
      pullRequests: { ...this.snapshot.pullRequests, [prKey]: next },
    });

    if (this.reviewBridgeStore?.syncPullRequest) {
      try {
        await this.reviewBridgeStore.syncPullRequest(next);
      } catch (error) {
        this.log.warn("review bridge detail sync failed", { prKey, err: error.message || String(error) });
      }
    }
    return next;
  }

  async rerunCheck(prKey, checkItem) {
    const current = this.snapshot.pullRequests?.[prKey];
    if (!current) throw new Error(`PR ${prKey} not found in snapshot`);
    const connection = this.findConnection(current.connectionId);
    if (!connection) throw new Error(`Connection not found for PR ${prKey}`);
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error(`No credentials found for connection "${connection.label || connection.id}"`);
    this.setAuditContext({ connectionId: connection.id, userInitiated: true });

    if (checkItem.kind === "check" && checkItem.checkSuiteId) {
      const owner = current.repository?.owner;
      const repo = current.repository?.name;
      await this.api.rerunCheckSuite(connection, token, owner, repo, checkItem.checkSuiteId);
    } else {
      throw new Error("Cannot re-run this check type");
    }

    return this.ensurePullRequestDetail(prKey, { force: true });
  }

  // ---------------------------------------------------------------------------
  // Managed checkout (cache repo + worktree)
  // ---------------------------------------------------------------------------

  async ensureCacheRepo({ connection, token, owner, repo, remoteUrl, reviewRoot }) {
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

  async prepareManagedReviewCheckout({ summary, connection, token, reviewRoot }) {
    try {
      const owner = summary.repository.owner;
      const repo = summary.repository.name;
      const remoteUrl = summary.repository.remoteUrl || buildRepositoryRemoteUrl(connection.hostUrl, owner, repo);
      if (!remoteUrl) throw new Error("Pull request repository clone URL is missing.");

      const sourceBranch = stripRefsPrefix(summary.pullRequest.sourceRefName);
      if (!sourceBranch) throw new Error("Pull request source branch is missing.");
      const targetBranch = stripRefsPrefix(summary.pullRequest.targetRefName);
      if (!targetBranch) throw new Error("Pull request target branch is missing.");

      const cacheRepoPath = await this.ensureCacheRepo({ connection, token, owner, repo, remoteUrl, reviewRoot });
      const worktreePath = path.join(
        normalizeReviewRoot(reviewRoot),
        "reviews",
        shortPathKey(connection.id, "connection"),
        `pr-${summary.pullRequest.number}`,
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
      const localBranch = `pr-${summary.pullRequest.number}-${sanitizePathSegment(sourceBranch)}`;

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

  buildReviewMetadata(summary, checkout, extra = {}) {
    return {
      provider: "github",
      prKey: summary.prKey,
      connectionId: summary.connectionId,
      hostUrl: summary.hostUrl,
      parentWorkspaceId: extra.parentWorkspaceId || "",
      repository: clone(summary.repository),
      pullRequest: clone(summary.pullRequest),
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

  async openReviewWorkspace({ state, prKey, workspaceId = "" }) {
    const summary = await this.ensurePullRequestDetail(prKey, { workspaces: state.workspaces });
    const connection = this.findConnection(summary.connectionId);
    if (!connection) throw new Error("GitHub connection was not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error("PAT is missing.");

    const activeProfile = state.activeProfileId || "default";
    const profileWorkspaces = state.workspaces.filter((ws) => (ws.profileId || "default") === activeProfile);
    const existingWorkspace = workspaceId
      ? profileWorkspaces.find((ws) => ws.id === workspaceId)
      : findWorkspaceForPullRequest(profileWorkspaces, prKey) ||
        (summary.role === "author" && summary.existingWorkspaceId
          ? profileWorkspaces.find((ws) => ws.id === summary.existingWorkspaceId)
          : null);

    const reviewProfileId = existingWorkspace?.profileId || state.activeProfileId || "default";
    const parentGitHubWorkspace =
      state.workspaces.find((ws) => ws.kind === "github" && (ws.profileId || "default") === reviewProfileId) || null;
    const parentWorkspaceId = parentGitHubWorkspace?.id || existingWorkspace?.review?.parentWorkspaceId || "";

    if (existingWorkspace) {
      if (!String(existingWorkspace.cwd || "").trim()) {
        throw new Error(
          `Matched workspace "${existingWorkspace.name || existingWorkspace.id}" does not have a working directory.`,
        );
      }
      const checkout = existingWorkspace.review?.checkout || {
        mode: existingWorkspace.review?.provider === "github" ? "managed-worktree" : "linked-existing-workspace",
        rootPath: existingWorkspace.cwd,
        cacheRepoPath: existingWorkspace.review?.checkout?.cacheRepoPath || "",
      };
      const workspace = {
        ...existingWorkspace,
        review: this.buildReviewMetadata(summary, checkout, {
          parentWorkspaceId: checkout.mode === "managed-worktree" ? parentWorkspaceId : "",
        }),
      };
      await this.reviewStore.upsertTrackedPullRequest(prKey, {
        reviewWorkspaceId: workspace.id,
        lastSeenActivityAt: summary.lastRemoteActivityAt || new Date(this.now()).toISOString(),
      });
      return { workspace, created: false, attached: checkout.mode === "linked-existing-workspace" };
    }

    const checkout = await this.prepareManagedReviewCheckout({
      summary,
      connection,
      token,
      reviewRoot: parentGitHubWorkspace?.cwd || connection.reviewRoot || getDefaultReviewRoot(),
    });
    const panels = createReviewWorkspacePanels(parentGitHubWorkspace?.panels || [], state.tabTemplates || []);
    const workspace = {
      id: `workspace-${randomUUID()}`,
      name: `${summary.repository.fullName} PR #${summary.pullRequest.number}`,
      icon: GITHUB_REVIEW_ICON,
      color: GITHUB_REVIEW_COLOR,
      kind: "terminal",
      source: "manual",
      pluginId: "",
      cwd: checkout.rootPath,
      notes: `GitHub review workspace for ${summary.repository.fullName} PR #${summary.pullRequest.number}`,
      profileId: state.activeProfileId || "default",
      activePanelId: panels[0]?.id || "",
      panels,
      review: this.buildReviewMetadata(summary, checkout, {
        parentWorkspaceId: parentWorkspaceId || "",
      }),
    };
    await this.reviewStore.upsertTrackedPullRequest(prKey, {
      reviewWorkspaceId: workspace.id,
      lastSeenActivityAt: summary.lastRemoteActivityAt || new Date(this.now()).toISOString(),
    });
    return { workspace, created: true, attached: false };
  }

  // ---------------------------------------------------------------------------
  // Write actions
  // ---------------------------------------------------------------------------

  async addPullRequestComment({ prKey, body }) {
    const summary = await this.ensurePullRequestDetail(prKey);
    this.setAuditContext({ connectionId: summary.connectionId || "", userInitiated: true });
    const connection = this.findConnection(summary.connectionId);
    if (!connection) throw new Error("GitHub connection was not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error("PAT is missing.");

    await this.api.createIssueComment(
      connection,
      token,
      summary.repository.owner,
      summary.repository.name,
      summary.pullRequest.number,
      body,
    );
  }

  async submitPullRequestReview({ prKey, event, body = "" }) {
    const summary = await this.ensurePullRequestDetail(prKey);
    this.setAuditContext({ connectionId: summary.connectionId || "", userInitiated: true });
    const connection = this.findConnection(summary.connectionId);
    if (!connection) throw new Error("GitHub connection was not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error("PAT is missing.");

    // event: APPROVE, REQUEST_CHANGES, COMMENT
    await this.api.submitReview(
      connection,
      token,
      summary.repository.owner,
      summary.repository.name,
      summary.pullRequest.number,
      { event, body },
    );
  }

  // ---------------------------------------------------------------------------
  // Workspace git operations
  // ---------------------------------------------------------------------------

  async fetchReviewWorkspace({ workspace, pullFfOnly = false } = {}) {
    const connection = this.findConnection(workspace.review?.connectionId);
    if (!connection) throw new Error("GitHub connection was not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error("PAT is missing.");
    const auth = { token };
    if (pullFfOnly) {
      // Refresh-from-review path: fetch refs then fast-forward the working
      // copy so the reviewer sees the author's latest code locally. --ff-only
      // will refuse if the reviewer has local commits or a dirty tree; we
      // let the error propagate so the user knows exactly why HEAD didn't
      // advance. Fetch has already succeeded by then, so History is current.
      this.log.info("pull review workspace (ff-only)", { workspaceId: workspace.id });
      await this.runGit(workspace.cwd, ["fetch", "origin"], auth);
      await this.runGit(workspace.cwd, ["merge", "--ff-only", "@{u}"], auth);
      return;
    }
    this.log.info("fetch review workspace", { workspaceId: workspace.id });
    await this.runGit(workspace.cwd, ["fetch", "origin"], auth);
  }

  async rebaseReviewWorkspace({ workspace }) {
    await this.fetchReviewWorkspace({ workspace });
    const targetBranch = stripRefsPrefix(workspace.review?.pullRequest?.targetRefName);
    this.log.info("rebase review workspace", { workspaceId: workspace.id, targetBranch });
    await this.runGit(workspace.cwd, ["rebase", `origin/${targetBranch}`]);
  }

  async pushReviewWorkspace({ workspace, force = false, branch = "" }) {
    const connection = this.findConnection(workspace.review?.connectionId);
    if (!connection) throw new Error("GitHub connection was not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error("PAT is missing.");

    const sourceBranch = stripRefsPrefix(workspace.review?.pullRequest?.sourceRefName) || branch;
    if (!sourceBranch) throw new Error("Cannot determine branch name for push.");

    // Local branch may be named differently (e.g. pr-1-feature) so push HEAD to the remote branch name
    const pushArgs = force
      ? ["push", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${sourceBranch}`]
      : ["push", "-u", "origin", `HEAD:refs/heads/${sourceBranch}`];
    this.log.info("push review workspace", { workspaceId: workspace.id, sourceBranch, force });
    await this.runGit(workspace.cwd, pushArgs, { token });
  }

  async listRemoteBranches(connectionId, owner, repo) {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveConnectionAndToken(connectionId);
    // If owner/repo not provided, try to resolve from workspace git remote
    const branches = await this.api.listBranches(connection, token, owner, repo);
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
  }) {
    const { connection, token } = this.resolveConnectionAndToken(connectionId);
    this.setAuditContext({ connectionId, userInitiated: true });
    const result = await this.api.createPullRequest(connection, token, owner, repo, {
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

  async listQuickFixRepositories(connectionId) {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveConnectionAndToken(connectionId);
    const allRepos = await this.api.listUserRepos(connection, token);
    let repos = allRepos;
    if (connection.ownerFilters?.length) {
      const owners = new Set(connection.ownerFilters.map((o) => o.toLowerCase()));
      repos = repos.filter((r) => owners.has((r.owner?.login || "").toLowerCase()));
    }
    if (connection.repositoryFilters?.length) {
      const filters = new Set(connection.repositoryFilters.map((f) => f.toLowerCase()));
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

  async listQuickFixBranches(connectionId, owner, repo) {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveConnectionAndToken(connectionId);
    const branches = await this.api.listBranches(connection, token, owner, repo);
    return branches.map((b) => b.name);
  }

  async openQuickFixWorkspace({ state, connectionId, owner, repo, remoteUrl, baseBranch, newBranchName }) {
    const { connection, token } = this.resolveConnectionAndToken(connectionId);

    const activeProfile = state.activeProfileId || "default";
    const parentGitHubWorkspace =
      state.workspaces.find((ws) => ws.kind === "github" && (ws.profileId || "default") === activeProfile) || null;
    const reviewRoot = parentGitHubWorkspace?.cwd || connection.reviewRoot || getDefaultReviewRoot();

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
        const msg = String(err?.stderr || err?.message || err);
        if (msg.includes("already exists")) {
          throw new Error(`Branch "${newBranchName}" already exists. Choose a different name.`, { cause: err });
        }
        throw err;
      }
    }

    const panels = createReviewWorkspacePanels(parentGitHubWorkspace?.panels || [], state.tabTemplates || []);
    const workspace = {
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
        hostUrl: connection.hostUrl || "",
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

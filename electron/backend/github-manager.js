import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { execFileText } from "./process-utils.js";
import { createGitHubApi } from "./github-api.js";
import { BaseProviderManager, createReviewWorkspacePanels } from "./shared/base-manager.js";
import { classifyGitHubRequest, parseGitHubUrl } from "./github-audit-log-store.js";
import { buildPullRequestSummary, findWorkspaceForPullRequest } from "./github-pr-summary.js";
import {
  GITHUB_REVIEW_ICON,
  GITHUB_REVIEW_COLOR,
  DEFAULT_REVIEW_ROOT,
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

    for (const connection of connections.filter((c) => c.enabled !== false)) {
      this.setAuditContext({ connectionId: connection.id, userInitiated: false });
      const persistedState = reviewState.connections?.[connection.id] || {};
      const connectionSnapshot = createConnectionSnapshot(connection, persistedState);
      connectionSnapshots.push(connectionSnapshot);

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
            const summary = buildPullRequestSummary({
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
              lastReviewStateSignature: summary._reviewStateSignature,
              lastHeadSha: summary._headSha,
              lastChecksSignature: summary._checksSignature,
              lastSeenActivityAt: tracked.lastSeenActivityAt || null,
            };
            detailMap[prKey] = {
              ...(detailMap[prKey] || {}),
              ...summary,
            };
          }
        }

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
      sync: {
        running: false,
        lastStartedAt: startedAt,
        lastCompletedAt: new Date(this.now()).toISOString(),
      },
    };
    this.setSnapshot(snapshot);
    return this.getSnapshot();
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
      reviewRoot: parentGitHubWorkspace?.cwd || connection.reviewRoot || DEFAULT_REVIEW_ROOT,
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

  async fetchReviewWorkspace({ workspace }) {
    const connection = this.findConnection(workspace.review?.connectionId);
    if (!connection) throw new Error("GitHub connection was not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error("PAT is missing.");
    await this.runGit(workspace.cwd, ["fetch", "origin"], { token });
  }

  async rebaseReviewWorkspace({ workspace }) {
    await this.fetchReviewWorkspace({ workspace });
    const targetBranch = stripRefsPrefix(workspace.review?.pullRequest?.targetRefName);
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
    const reviewRoot = parentGitHubWorkspace?.cwd || connection.reviewRoot || DEFAULT_REVIEW_ROOT;

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
  DEFAULT_REVIEW_ROOT,
  createPullRequestKey,
  normalizeConnectionInput,
  normalizeRemoteUrl,
  normalizeReviewRoot,
  shortPathKey,
} from "./github-utils.js";

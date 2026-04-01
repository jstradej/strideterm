import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { execFileText } from "./process-utils.js";
import { createAzureApi } from "./azure-devops-api.js";
import { BaseProviderManager, createReviewWorkspacePanels } from "./shared/base-manager.js";
import { classifyAzureRequest, parseAzureUrl } from "./azure-audit-log-store.js";
import {
  buildPullRequestSummary,
  findWorkspaceForPullRequest,
  findMatchingWorkspace,
} from "./azure-devops-pr-summary.js";
import {
  AZURE_REVIEW_ICON,
  AZURE_REVIEW_COLOR,
  DEFAULT_REVIEW_ROOT,
  clone,
  sanitizePathSegment,
  trimTrailingSlash,
  normalizeReviewRoot,
  encodeAuthHeader,
  createPullRequestKey,
  stripRefsPrefix,
  parseDate,
  toIsoOrNull,
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

export class AzureDevOpsManager extends BaseProviderManager {
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
      createApi: createAzureApi,
    });
    this.providerLabel = "azure-devops";
    this.defaultGitLogin = "";
  }

  /**
   * Log an Azure DevOps API call to the audit store.
   * Enriches raw request data with current audit context and URL classification.
   */
  _logAudit(raw) {
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

  async verifyConnection(connectionInput) {
    this.setAuditContext({ connectionId: connectionInput.id || "", userInitiated: true });
    const connection = normalizeConnectionInput(connectionInput);
    const token = String(connectionInput.pat || "").trim();
    if (!connection.orgUrl || !connection.login || !token) {
      throw new Error("Organization URL, login, and PAT are required.");
    }

    const projects = await this.api.listProjects(connection, token);
    return {
      ok: true,
      organization: connection.orgUrl,
      projectCount: projects.length,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description || "",
        state: project.state || "",
      })),
    };
  }

  async sync({ connections = [], workspaces = [], gitSnapshots = {}, activeProfileId = "default" } = {}) {
    const reviewState = this.reviewStore.getState();
    const startedAt = new Date(this.now()).toISOString();
    // Immediately apply the new connections list so any intermediate broadcastState
    // (triggered by emitUpdated) reflects the correct profile-filtered connections.
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

    for (const connection of connections.filter((entry) => entry.enabled !== false)) {
      this.setAuditContext({ connectionId: connection.id, userInitiated: false });
      const persistedState = reviewState.connections?.[connection.id] || {};
      const connectionSnapshot = createConnectionSnapshot(connection, persistedState);
      connectionSnapshots.push(connectionSnapshot);

      try {
        const token = this.credentialStore.getSecret(connection.tokenRef);
        if (!token) {
          throw new Error("PAT is missing.");
        }

        const projects = await this.api.listProjects(connection, token);
        const filteredProjects = connection.projectFilters?.length
          ? projects.filter(
              (project) =>
                connection.projectFilters.includes(project.name) || connection.projectFilters.includes(project.id),
            )
          : projects;

        for (const project of filteredProjects) {
          const pullRequests = await this.api.listPullRequestsByProject(connection, token, project.name);
          for (const pr of pullRequests) {
            if (connection.repositoryFilters?.length) {
              const matchesRepository =
                connection.repositoryFilters.includes(pr.repository?.id) ||
                connection.repositoryFilters.includes(pr.repository?.name);
              if (!matchesRepository) {
                continue;
              }
            }

            const threads = await this.api.listThreads(
              connection,
              token,
              project.name,
              pr.repository.id,
              pr.pullRequestId,
            );
            const prKey = createPullRequestKey(connection.id, pr.repository.id, pr.pullRequestId);
            const tracked = this.reviewStore.getTrackedPullRequest(prKey) || {};
            const summary = buildPullRequestSummary({
              connection,
              pr,
              projectName: project.name,
              threads,
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
                console.warn(`[azure-devops] review bridge sync failed for ${prKey}: ${error.message || error}`);
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
              reviewWorkspaceId: summary.reviewWorkspaceId || tracked.reviewWorkspaceId || "",
              lastRemoteActivityAt: summary.lastRemoteActivityAt,
              lastVoteSignature: summary.reviewerSummary.reviewers
                .map((reviewer) => `${reviewer.id}:${reviewer.vote}:${reviewer.hasDeclined ? 1 : 0}`)
                .sort()
                .join("|"),
              lastMergeStatus: summary.pullRequest.mergeStatus,
              lastSourceCommitId: summary.pullRequest.sourceCommitId,
              lastSeenActivityAt: tracked.lastSeenActivityAt || null,
            };
            detailMap[prKey] = {
              ...(detailMap[prKey] || {}),
              ...summary,
              threads: summary.threads,
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
        connectionSnapshot.lastError = error.message || "Azure sync failed.";
        connectionSnapshot.lastSyncAt = new Date(this.now()).toISOString();
        await this.reviewStore.upsertConnectionState(connection.id, {
          status: "error",
          lastError: connectionSnapshot.lastError,
          lastSyncAt: connectionSnapshot.lastSyncAt,
        });
      }
    }

    for (const [key, tracked] of Object.entries(trackedPullRequests)) {
      await this.reviewStore.upsertTrackedPullRequest(key, tracked);
    }

    const recentlyUpdated = visibleSummaries
      .slice()
      .sort((left, right) => parseDate(right.lastActivityAt) - parseDate(left.lastActivityAt));
    const snapshot = {
      connections: connectionSnapshots,
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
      sync: {
        running: false,
        lastStartedAt: startedAt,
        lastCompletedAt: new Date(this.now()).toISOString(),
      },
    };
    this.setSnapshot(snapshot);
    return this.getSnapshot();
  }

  async ensurePullRequestDetail(prKey, { workspaces = [], force = false } = {}) {
    const current = this.snapshot.pullRequests[prKey] || this.findSummary(prKey);
    if (!current) {
      throw new Error("Pull request is not available in the current Azure snapshot.");
    }
    if (!force && Array.isArray(current.changedFiles) && current.checks?.items) {
      return current;
    }

    this.setAuditContext({ connectionId: current.connectionId || "", userInitiated: true });
    const connection = this.findConnection(current.connectionId);
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }

    const [changes, pullRequestStatuses, policyEvaluations] = await Promise.all([
      this.api
        .listIterationChanges(connection, token, current.project.name, current.repository.id, current.pullRequest.id)
        .catch(() => []),
      this.api
        .listPullRequestStatuses(connection, token, current.project.name, current.repository.id, current.pullRequest.id)
        .catch(() => []),
      this.api
        .listPolicyEvaluations(connection, token, current.project.name, current.project.id, current.pullRequest.id)
        .catch(() => []),
    ]);
    const workspace =
      findWorkspaceForPullRequest(workspaces, prKey) ||
      (current.existingWorkspaceId ? workspaces.find((entry) => entry.id === current.existingWorkspaceId) : null);
    const localChanges = workspace?.cwd
      ? await this.listLocalChangedFiles(workspace.cwd, current.pullRequest.targetRefName).catch(() => [])
      : [];

    const enrichedThreads = workspace?.cwd
      ? await this.readThreadCodeSnippets(
          workspace.cwd,
          current.threads || [],
          current.pullRequest.targetRefName,
        ).catch(() => current.threads || [])
      : current.threads || [];

    // Fetch build details for timestamps (for all checks with buildId)
    const buildIds = [...new Set(policyEvaluations.map((e) => e?.context?.buildId).filter(Boolean))];
    const buildDetails = {};
    if (buildIds.length) {
      const details = await Promise.all(
        buildIds.map((id) => this.api.fetchBuildDetail(connection, token, current.project.name, id).catch(() => null)),
      );
      for (const detail of details) {
        if (detail?.id) buildDetails[detail.id] = detail;
      }
    }

    const checksResult = buildCheckSummary({
      policyEvaluations,
      statuses: pullRequestStatuses,
      buildDetails,
    });

    // Fetch build timeline errors for failed checks that have a buildId
    const failedWithBuild = (checksResult.items || []).filter(
      (item) => item.state === "failed" && item.buildId && !item.errorMessage,
    );
    if (failedWithBuild.length) {
      const errorResults = await Promise.all(
        failedWithBuild.map((item) =>
          this.api
            .fetchBuildErrors(connection, token, current.project.name, item.buildId)
            .then((msg) => ({ id: item.id, errorMessage: msg })),
        ),
      );
      const errorMap = new Map(errorResults.filter((e) => e.errorMessage).map((e) => [e.id, e.errorMessage]));
      if (errorMap.size) {
        checksResult.items = checksResult.items.map((item) =>
          errorMap.has(item.id) ? { ...item, errorMessage: errorMap.get(item.id) } : item,
        );
      }
    }

    const next = {
      ...current,
      changedFiles: changes,
      localChangedFiles: localChanges,
      threads: enrichedThreads,
      checks: checksResult,
      existingWorkspaceId: workspace?.id || current.existingWorkspaceId || "",
      reviewWorkspaceId:
        workspace?.review?.provider === "azure-devops" ? workspace.id : current.reviewWorkspaceId || "",
    };

    this.setSnapshot({
      ...this.snapshot,
      pullRequests: {
        ...this.snapshot.pullRequests,
        [prKey]: next,
      },
    });
    if (this.reviewBridgeStore?.syncPullRequest) {
      try {
        await this.reviewBridgeStore.syncPullRequest(next);
      } catch (error) {
        console.warn(`[azure-devops] review bridge detail sync failed for ${prKey}: ${error.message || error}`);
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

    if (checkItem.kind === "policy" && checkItem.evaluationId) {
      console.log(`[azure-devops] Re-evaluating policy ${checkItem.evaluationId} for ${prKey}`);
      await this.api.reEvaluatePolicy(
        connection,
        token,
        current.project.name,
        current.project.id,
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

  async readThreadCodeSnippets(cwd, threads = [], targetRefName = "") {
    if (!cwd || !threads.length) return threads;
    const targetBranch = stripRefsPrefix(targetRefName);
    const filesNeeded = new Map();
    for (const thread of threads) {
      if (thread.filePath && thread.lineStart) {
        const key = thread.filePath;
        if (!filesNeeded.has(key)) {
          filesNeeded.set(key, []);
        }
        filesNeeded.get(key).push(thread);
      }
    }
    if (!filesNeeded.size) return threads;

    const snippetMap = new Map();
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
      const contextLines = [];
      let inRelevantHunk = false;
      let currentNewLine = 0;
      const targetStart = Math.max(1, thread.lineStart - 2);
      const targetEnd = (thread.lineEnd || thread.lineStart) + 2;

      for (const line of lines) {
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

  async ensureCacheRepo({ connection, token, repository, reviewRoot }) {
    const repositoryRoot = path.join(
      normalizeReviewRoot(reviewRoot),
      "repos",
      shortPathKey(connection.id, "connection"),
      shortPathKey(repository.id || repository.name, "repository"),
    );
    const repositoryExists = await exists(path.join(repositoryRoot, ".git"));
    await mkdir(path.dirname(repositoryRoot), { recursive: true });
    if (!repositoryExists) {
      await this.runGit(process.cwd(), ["clone", "--no-checkout", repository.remoteUrl, repositoryRoot], {
        login: connection.login,
        token,
      });
    }
    return repositoryRoot;
  }

  async prepareManagedReviewCheckout({ summary, connection, token, reviewRoot }) {
    try {
      const remoteUrl = firstNonEmpty(
        summary.repository?.remoteUrl,
        buildRepositoryRemoteUrl(connection, summary.project?.name, summary.repository?.name || summary.repository?.id),
      );
      if (!remoteUrl) {
        throw new Error("Pull request repository clone URL is missing.");
      }

      const sourceBranch = stripRefsPrefix(summary.pullRequest.sourceRefName);
      if (!sourceBranch) {
        throw new Error("Pull request source branch is missing.");
      }

      const targetBranch = stripRefsPrefix(summary.pullRequest.targetRefName);
      if (!targetBranch) {
        throw new Error("Pull request target branch is missing.");
      }

      const repository = {
        ...summary.repository,
        remoteUrl,
        project: summary.project,
      };
      const cacheRepoPath = await this.ensureCacheRepo({ connection, token, repository, reviewRoot });
      const worktreePath = path.join(
        normalizeReviewRoot(reviewRoot),
        "reviews",
        shortPathKey(connection.id, "connection"),
        `pr-${summary.pullRequest.id}`,
      );

      await this.runGit(
        cacheRepoPath,
        [
          "fetch",
          "origin",
          `+${summary.pullRequest.sourceRefName}:refs/remotes/origin/${sourceBranch}`,
          `+${summary.pullRequest.targetRefName}:refs/remotes/origin/${targetBranch}`,
        ],
        {
          login: connection.login,
          token,
        },
      );

      await mkdir(path.dirname(worktreePath), { recursive: true });
      const worktreeExists = await exists(path.join(worktreePath, ".git"));
      const localBranch = `pr-${summary.pullRequest.id}-${sanitizePathSegment(sourceBranch)}`;

      if (!worktreeExists) {
        await this.runGit(cacheRepoPath, [
          "worktree",
          "add",
          "--force",
          "-b",
          localBranch,
          worktreePath,
          `refs/remotes/origin/${sourceBranch}`,
        ]);
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

  buildReviewMetadata(summary, checkout, mode = checkout.mode, extra = {}) {
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

  buildManagedReviewPaths(summary, { profileId = "default", workspaces = [] } = {}) {
    const connection = this.findConnection(summary?.connectionId);
    if (!connection || !summary?.pullRequest?.id) {
      return null;
    }

    const parentAzureWorkspace =
      (workspaces || []).find(
        (workspace) => workspace.kind === "azure" && (workspace.profileId || "default") === (profileId || "default"),
      ) || null;
    const reviewRoot = parentAzureWorkspace?.cwd || connection.reviewRoot || DEFAULT_REVIEW_ROOT;

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

  async openReviewWorkspace({ state, prKey, workspaceId = "" }) {
    const summary = await this.ensurePullRequestDetail(prKey, {
      workspaces: state.workspaces,
    });
    const connection = this.findConnection(summary.connectionId);
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }

    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }

    const activeProfile = state.activeProfileId || "default";
    const profileWorkspaces = state.workspaces.filter((ws) => (ws.profileId || "default") === activeProfile);
    const existingWorkspace = workspaceId
      ? profileWorkspaces.find((workspace) => workspace.id === workspaceId)
      : findWorkspaceForPullRequest(profileWorkspaces, prKey) ||
        (summary.role === "author" && summary.existingWorkspaceId
          ? profileWorkspaces.find((workspace) => workspace.id === summary.existingWorkspaceId)
          : null);

    const reviewProfileId = existingWorkspace?.profileId || state.activeProfileId || "default";
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
      const checkout = existingWorkspace.review?.checkout || {
        mode: existingWorkspace.review?.provider === "azure-devops" ? "managed-worktree" : "linked-existing-workspace",
        rootPath: existingWorkspace.cwd,
        cacheRepoPath: existingWorkspace.review?.checkout?.cacheRepoPath || "",
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
      reviewRoot: parentAzureWorkspace?.cwd || connection.reviewRoot || DEFAULT_REVIEW_ROOT,
    });
    const panels = createReviewWorkspacePanels(parentAzureWorkspace?.panels || [], state.tabTemplates || []);
    const workspace = {
      id: `workspace-${randomUUID()}`,
      name: `${summary.repository.name} PR #${summary.pullRequest.id}`,
      icon: AZURE_REVIEW_ICON,
      color: AZURE_REVIEW_COLOR,
      kind: "terminal",
      source: "manual",
      pluginId: "",
      cwd: checkout.rootPath,
      notes: `Azure DevOps review workspace for ${summary.repository.name} PR #${summary.pullRequest.id}`,
      profileId: state.activeProfileId || "default",
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

  async addPullRequestComment({ prKey, content, threadId = null, parentCommentId = 0 }) {
    const summary = await this.ensurePullRequestDetail(prKey);
    this.setAuditContext({ connectionId: summary.connectionId || "", userInitiated: true });
    const connection = this.findConnection(summary.connectionId);
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
      ? this.api.buildCreateCommentUrl(
          connection,
          summary.project.name,
          summary.repository.id,
          summary.pullRequest.id,
          threadId,
        )
      : this.api.buildCreateThreadUrl(connection, summary.project.name, summary.repository.id, summary.pullRequest.id);
    await this.api.requestJson(url, {
      login: connection.login,
      token,
      method: "POST",
      body: payload,
    });
  }

  async updateThreadStatus({ prKey, threadId, status }) {
    const summary = await this.ensurePullRequestDetail(prKey);
    this.setAuditContext({ connectionId: summary.connectionId || "", userInitiated: true });
    const connection = this.findConnection(summary.connectionId);
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }
    await this.api.requestJson(
      this.api.buildUpdateThreadUrl(
        connection,
        summary.project.name,
        summary.repository.id,
        summary.pullRequest.id,
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

  async setPullRequestVote({ prKey, vote }) {
    const summary = await this.ensurePullRequestDetail(prKey);
    this.setAuditContext({ connectionId: summary.connectionId || "", userInitiated: true });
    const connection = this.findConnection(summary.connectionId);
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
    await this.api.requestJson(
      this.api.buildReviewerUrl(
        connection,
        summary.project.name,
        summary.repository.id,
        summary.pullRequest.id,
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

  async fetchReviewWorkspace({ workspace }) {
    const connection = this.findConnection(workspace.review?.connectionId);
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }
    await this.runGit(workspace.cwd, ["fetch", "origin"], {
      login: connection.login,
      token,
    });
  }

  async rebaseReviewWorkspace({ workspace }) {
    await this.fetchReviewWorkspace({ workspace });
    const targetBranch = stripRefsPrefix(workspace.review?.pullRequest?.targetRefName);
    await this.runGit(workspace.cwd, ["rebase", `origin/${targetBranch}`]);
  }

  findConnectionForRemote(remoteUrl) {
    const normalized = normalizeRemoteUrl(remoteUrl);
    if (!normalized) return null;
    for (const connection of this.snapshot.connections) {
      if (!connection.enabled) continue;
      const orgNorm = normalizeRemoteUrl(connection.orgUrl);
      if (orgNorm && normalized.startsWith(orgNorm)) {
        return connection;
      }
    }
    return null;
  }

  async resolveRepository(connectionId, remoteUrl) {
    const connection = this.findConnection(connectionId);
    if (!connection) throw new Error("Azure DevOps connection not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error("PAT is missing.");

    const normalized = normalizeRemoteUrl(remoteUrl);
    const projects = await this.api.listProjects(connection, token);
    const filteredProjects = connection.projectFilters?.length
      ? projects.filter((p) => connection.projectFilters.includes(p.name) || connection.projectFilters.includes(p.id))
      : projects;

    for (const project of filteredProjects) {
      const repos = await this.api.listRepositories(connection, token, project.name);
      for (const repo of repos) {
        if (normalizeRemoteUrl(repo.remoteUrl) === normalized) {
          return { connection, token, projectName: project.name, repository: repo };
        }
      }
    }
    throw new Error("Could not find a matching Azure DevOps repository for this workspace.");
  }

  async listRemoteBranches(connectionId, remoteUrl) {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token, projectName, repository } = await this.resolveRepository(connectionId, remoteUrl);
    const refs = await this.api.listRepositoryRefs(connection, token, projectName, repository.id, "heads");
    return refs.map((ref) => stripRefsPrefix(ref.name));
  }

  async createPullRequestForWorkspace({
    remoteUrl,
    sourceBranch,
    targetBranch,
    title,
    description,
    isDraft = false,
    connectionId = "",
  }) {
    const connection = (connectionId && this.findConnection(connectionId)) || this.findConnectionForRemote(remoteUrl);
    if (!connection) throw new Error("No Azure DevOps connection found for this repository.");
    this.setAuditContext({ connectionId: connection.id, userInitiated: true });
    const { token, projectName, repository } = await this.resolveRepository(connection.id, remoteUrl);
    const result = await this.api.createPullRequest(connection, token, projectName, repository.id, {
      title,
      description,
      sourceBranch,
      targetBranch,
      isDraft,
    });
    return {
      pullRequestId: result.pullRequestId,
      url: result._links?.web?.href || "",
      title: result.title,
    };
  }

  async pushReviewWorkspace({ workspace, force = false, branch = "" }) {
    const connection = this.findConnection(workspace.review?.connectionId);
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }
    const prRef = stripRefsPrefix(workspace.review?.pullRequest?.sourceRefName);
    const sourceBranch = prRef || branch;
    if (!sourceBranch) {
      throw new Error("Cannot determine branch name for push.");
    }
    // Local branch may be named differently (e.g. pr-123-feature) so push HEAD to the remote branch name
    const pushArgs = force
      ? ["push", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${sourceBranch}`]
      : ["push", "-u", "origin", `HEAD:refs/heads/${sourceBranch}`];
    await this.runGit(workspace.cwd, pushArgs, {
      login: connection.login,
      token,
    });
  }

  // ---------------------------------------------------------------------------
  // Quick Fix — forward flow: pick repo/branch → checkout → workspace → PR
  // ---------------------------------------------------------------------------

  buildPrKey(connectionId, repositoryId, pullRequestId) {
    return createPullRequestKey(connectionId, repositoryId, pullRequestId);
  }

  async listQuickFixProjects(connectionId) {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveConnectionAndToken(connectionId);
    const projects = await this.api.listProjects(connection, token);
    const filtered = connection.projectFilters?.length
      ? projects.filter((p) => connection.projectFilters.includes(p.name) || connection.projectFilters.includes(p.id))
      : projects;
    return filtered.map((p) => ({ id: p.id, name: p.name }));
  }

  async listQuickFixRepositories(connectionId, projectName) {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveConnectionAndToken(connectionId);
    const repos = await this.api.listRepositories(connection, token, projectName);
    const filtered = connection.repositoryFilters?.length
      ? repos.filter(
          (r) => connection.repositoryFilters.includes(r.id) || connection.repositoryFilters.includes(r.name),
        )
      : repos;
    return filtered.map((r) => ({ id: r.id, name: r.name, remoteUrl: r.remoteUrl }));
  }

  async listQuickFixBranches(connectionId, projectName, repositoryId) {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveConnectionAndToken(connectionId);
    const refs = await this.api.listRepositoryRefs(connection, token, projectName, repositoryId, "heads");
    return refs.map((ref) => stripRefsPrefix(ref.name));
  }

  async prepareQuickFixCheckout({ connection, token, repository, baseBranch, newBranchName, reviewRoot }) {
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
        const msg = String(err?.stderr || err?.message || err);
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
  }) {
    const { connection, token } = this.resolveConnectionAndToken(connectionId);

    const activeProfile = state.activeProfileId || "default";
    const parentAzureWorkspace =
      state.workspaces.find((ws) => ws.kind === "azure" && (ws.profileId || "default") === activeProfile) || null;
    const reviewRoot = parentAzureWorkspace?.cwd || connection.reviewRoot || DEFAULT_REVIEW_ROOT;

    const repository = { id: repositoryId, name: repositoryName, remoteUrl };
    const checkout = await this.prepareQuickFixCheckout({
      connection,
      token,
      repository,
      baseBranch,
      newBranchName,
      reviewRoot,
    });

    const panels = createReviewWorkspacePanels(parentAzureWorkspace?.panels || [], state.tabTemplates || []);
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
        project: null,
        repository: { id: repositoryId, name: repositoryName, remoteUrl },
        pullRequest: null,
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
  DEFAULT_REVIEW_ROOT,
  createPullRequestKey,
  normalizeConnectionInput,
  normalizeRemoteUrl,
  normalizeReviewRoot,
  shortPathKey,
  stripRefsPrefix,
} from "./azure-devops-utils.js";

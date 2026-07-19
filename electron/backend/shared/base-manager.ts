/// <reference types="node" />
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { execFileText as defaultExecFileText } from "../process-utils.js";
import { clone, createEmptySnapshot, stripRefsPrefix, exists, shortPathKey } from "./provider-utils.js";
import { encodeAuthHeader, sanitizeGitEnvironment } from "./git-auth-utils.js";
import type { Logger } from "../logger.js";
import { getLogger } from "../logger.js";
import type { CredentialStore } from "./credential-store.js";

interface PrSummaryItem {
  prKey: string;
  lastRemoteActivityAt?: string;
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

/** Minimal shape `fetch/rebase/pushReviewWorkspace` need — both AzureDevOpsManager's
 * `ReviewWorkspace` and GitHubManager's `SyncWorkspace` satisfy this structurally. */
interface ReviewWorkspaceRef {
  id: string;
  cwd?: string;
  review?: {
    connectionId?: string;
    pullRequest?: {
      sourceRefName?: string;
      targetRefName?: string;
    };
  };
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
    data: { lastSeenActivityAt: string; reviewWorkspaceId: string },
  ): Promise<void>;
}

interface ReviewBridgeStore {
  markPullRequestSeen?(prKey: string, lastSeenActivityAt: string): Promise<void>;
}

interface AuditLogStore {
  logEntry(entry: Record<string, unknown>): void;
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
 */
export class BaseProviderManager extends EventEmitter {
  credentialStore: CredentialStore;
  reviewStore: ReviewStore;
  reviewBridgeStore: ReviewBridgeStore | null;
  auditLogStore: AuditLogStore | null;
  fetchImpl: typeof globalThis.fetch;
  execFileText: typeof defaultExecFileText;
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
  _log: Logger | null;

  constructor({
    credentialStore,
    reviewStore,
    reviewBridgeStore = null,
    auditLogStore = null,
    fetchImpl = globalThis.fetch,
    execFileTextImpl = defaultExecFileText,
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

  /**
   * Run a user-initiated git operation on a review checkout and log it to the
   * audit store. API calls are audited via _logAudit's fetch hook; git
   * subprocesses bypass it, so review git ops (fetch/rebase/push) go through
   * this wrapper instead. Entry shape mirrors GitManager._logGitAudit.
   */
  async runAuditedGitOperation<T>(
    {
      type,
      connection,
      workspaceId = "",
    }: {
      type: string;
      connection: {
        id?: string;
        orgUrl?: string;
        hostUrl?: string;
        baseUrl?: string;
        label?: string;
        provider?: string;
      } | null;
      workspaceId?: string;
    },
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const logAudit = (success: boolean, errorMessage = "") => {
      if (!connection?.id || !this.auditLogStore) return;
      const writeOps = new Set(["push", "force-push"]);
      try {
        this.auditLogStore.logEntry({
          timestamp: new Date().toISOString(),
          connectionId: connection.id,
          organization: String(connection.orgUrl || connection.hostUrl || connection.baseUrl || connection.label || ""),
          project: "",
          operation: `git${type.charAt(0).toUpperCase()}${type.slice(1)}`,
          category: writeOps.has(type) ? "write" : "read",
          method: "GIT",
          url: "",
          statusCode: null,
          success,
          errorMessage: errorMessage || null,
          durationMs: Date.now() - startedAt,
          resourceType: "git",
          resourceId: workspaceId,
          summary: `git ${type} (review workspace)`,
          userInitiated: true,
        });
      } catch {
        // Never let audit logging break the main flow
      }
    };
    try {
      const result = await fn();
      logAudit(true);
      return result;
    } catch (error) {
      logAudit(false, (error as Error)?.message || String(error));
      throw error;
    }
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
    if (token) {
      extraArgs.push("-c", `http.extraheader=${encodeAuthHeader(effectiveLogin, token)}`);
    }
    // Log only user-visible args (extraArgs contain credentials)
    this.log.debug(`git ${args.join(" ")}`, { cwd });
    try {
      return await this.execFileText("git", [...extraArgs, ...args], {
        cwd,
        env: sanitizeGitEnvironment(),
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
        await this.runGit(
          process.cwd(),
          ["clone", "--no-checkout", "--filter=blob:none", remoteUrl, repositoryRoot],
          { login, token },
        );
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
   * relies on runGit's defaultGitLogin). Both providers now use the same
   * worktree-reuse strategy: prune stale worktree metadata up front, and when
   * (re)creating a worktree for a branch that already exists locally, reuse
   * it and only hard-reset when it has no unpushed commits — this used to be
   * Azure-only; GitHub's prior force-recreate (`-B`) had no such guard and
   * could silently discard unpushed work from a previous session.
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
    await this.runGit(cacheRepoPath, ["fetch", "origin", ...fetchRefspecs], { login, token });

    await mkdir(path.dirname(worktreePath), { recursive: true });
    await this.runGit(cacheRepoPath, ["worktree", "prune"]).catch(() => {});
    const worktreeExists = await exists(path.join(worktreePath, ".git"));

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
  }

  /**
   * Shared body of AzureDevOpsManager.fetchReviewWorkspace /
   * GitHubManager.fetchReviewWorkspace — identical except the connection's
   * login is Azure-only (GitHub relies on runGit's defaultGitLogin).
   */
  async fetchReviewWorkspace({ workspace }: { workspace: ReviewWorkspaceRef }): Promise<void> {
    const connection = this.findConnection(workspace.review?.connectionId || "");
    if (!connection) throw new Error(this.connectionNotFoundMessage);
    const token = this.credentialStore.getSecret(connection.tokenRef || "");
    if (!token) throw new Error("PAT is missing.");
    this.log.info("fetch review workspace", { workspaceId: workspace.id });
    await this.runAuditedGitOperation({ type: "fetch", connection, workspaceId: workspace.id }, () =>
      this.runGit(workspace.cwd || "", ["fetch", "origin"], { login: connection.login, token }),
    );
  }

  /** Shared body of AzureDevOpsManager.rebaseReviewWorkspace / GitHubManager.rebaseReviewWorkspace. */
  async rebaseReviewWorkspace({ workspace }: { workspace: ReviewWorkspaceRef }): Promise<void> {
    await this.fetchReviewWorkspace({ workspace });
    const targetBranch = stripRefsPrefix(workspace.review?.pullRequest?.targetRefName || "");
    this.log.info("rebase review workspace", { workspaceId: workspace.id, targetBranch });
    // Token so partial-clone checkouts can lazily fetch blobs mid-rebase.
    const connection = this.findConnection(workspace.review?.connectionId || "");
    const token = connection ? this.credentialStore.getSecret(connection.tokenRef || "") : "";
    await this.runAuditedGitOperation({ type: "rebase", connection, workspaceId: workspace.id }, () =>
      this.runGit(workspace.cwd || "", ["rebase", `origin/${targetBranch}`], {
        login: connection?.login,
        token: token || undefined,
      }),
    );
  }

  /** Shared body of AzureDevOpsManager.pushReviewWorkspace / GitHubManager.pushReviewWorkspace. */
  async pushReviewWorkspace({
    workspace,
    force = false,
    branch = "",
  }: {
    workspace: ReviewWorkspaceRef;
    force?: boolean;
    branch?: string;
  }): Promise<void> {
    const connection = this.findConnection(workspace.review?.connectionId || "");
    if (!connection) throw new Error(this.connectionNotFoundMessage);
    const token = this.credentialStore.getSecret(connection.tokenRef || "");
    if (!token) throw new Error("PAT is missing.");
    const sourceBranch = stripRefsPrefix(workspace.review?.pullRequest?.sourceRefName || "") || branch;
    if (!sourceBranch) throw new Error("Cannot determine branch name for push.");
    // Local branch may be named differently (e.g. pr-123-feature) so push HEAD to the remote branch name
    const pushArgs = force
      ? ["push", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${sourceBranch}`]
      : ["push", "-u", "origin", `HEAD:refs/heads/${sourceBranch}`];
    this.log.info("push review workspace", { workspaceId: workspace.id, sourceBranch, force });
    await this.runAuditedGitOperation(
      { type: force ? "force-push" : "push", connection, workspaceId: workspace.id },
      () => this.runGit(workspace.cwd || "", pushArgs, { login: connection.login, token }),
    );
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

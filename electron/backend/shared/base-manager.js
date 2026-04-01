import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { execFileText as defaultExecFileText } from "../process-utils.js";
import { clone, createEmptySnapshot, stripRefsPrefix } from "./provider-utils.js";
import { encodeAuthHeader, sanitizeGitEnvironment } from "./git-auth-utils.js";

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
  constructor({
    credentialStore,
    reviewStore,
    reviewBridgeStore = null,
    auditLogStore = null,
    fetchImpl = globalThis.fetch,
    execFileTextImpl = defaultExecFileText,
    now = () => Date.now(),
    createApi,
  } = {}) {
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
    this.snapshot = createEmptySnapshot();
    this.syncTimer = null;

    this.providerLabel = "provider";
    this.defaultGitLogin = "";
  }

  // Subclasses must override this
  _logAudit(_raw) {}

  setAuditContext({ connectionId = "", userInitiated = false } = {}) {
    this._auditConnectionId = connectionId;
    this._auditUserInitiated = userInitiated;
  }

  getSnapshot() {
    return clone(this.snapshot);
  }

  emitUpdated() {
    this.emit("updated", this.getSnapshot());
  }

  setSnapshot(snapshot) {
    this.snapshot = clone(snapshot);
    this.emitUpdated();
  }

  stopPolling() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  configurePolling(intervalMs, callback) {
    this.stopPolling();
    if (intervalMs > 0 && typeof callback === "function") {
      this.syncTimer = setInterval(() => {
        callback().catch(() => {});
      }, intervalMs);
    }
  }

  findSummary(prKey) {
    const all = [
      ...this.snapshot.inbox.needsMyReview,
      ...this.snapshot.inbox.myPullRequests,
      ...this.snapshot.inbox.recentlyUpdated,
      ...this.snapshot.inbox.needsAttention,
    ];
    return all.find((item) => item.prKey === prKey) || null;
  }

  findConnection(connectionId) {
    return this.snapshot.connections.find((connection) => connection.id === connectionId) || null;
  }

  resolveConnectionAndToken(connectionId) {
    const connection = this.findConnection(connectionId);
    if (!connection) throw new Error(`${this.providerLabel} connection was not found.`);
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error("PAT is missing.");
    return { connection, token };
  }

  async markPullRequestSeen(prKey) {
    const summary = this.findSummary(prKey) || this.snapshot.pullRequests[prKey];
    if (!summary) {
      console.warn(`[${this.providerLabel}] markPullRequestSeen: PR ${prKey} not in snapshot, skipping`);
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
        console.warn(`[${this.providerLabel}] review bridge mark-seen failed for ${prKey}: ${error.message || error}`);
      }
    }

    const nextPullRequest = {
      ...(this.snapshot.pullRequests[prKey] || summary),
      lastSeenActivityAt,
      hasAttention: false,
      attentionReason: "",
      newCommentsCount: 0,
    };

    const updateSummaryList = (items) =>
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

  seedPullRequestSummary(prKey, summary) {
    if (this.snapshot.pullRequests[prKey] || this.findSummary(prKey)) return;
    this.setSnapshot({
      ...this.snapshot,
      pullRequests: { ...this.snapshot.pullRequests, [prKey]: summary },
    });
  }

  async listLocalChangedFiles(cwd, targetRefName) {
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

  async runGit(cwd, args, { login, token } = {}) {
    const extraArgs = [];
    if (process.platform === "win32") {
      extraArgs.push("-c", "core.longpaths=true");
    }
    const effectiveLogin = login ?? this.defaultGitLogin;
    if (token) {
      extraArgs.push("-c", `http.extraheader=${encodeAuthHeader(effectiveLogin, token)}`);
    }
    try {
      return await this.execFileText("git", [...extraArgs, ...args], {
        cwd,
        env: sanitizeGitEnvironment(),
      });
    } catch (error) {
      // Sanitize credentials from error output before re-throwing
      const sanitize = (text) => {
        if (!text) return text;
        return String(text).replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic ***");
      };
      if (error.stdout) error.stdout = sanitize(error.stdout);
      if (error.stderr) error.stderr = sanitize(error.stderr);
      if (error.message) error.message = sanitize(error.message);
      throw error;
    }
  }
}

/**
 * Build initial panel list for a review workspace from parent panels or tab templates.
 */
export function createReviewWorkspacePanels(panelTemplates = [], tabTemplates = []) {
  const selected = [];

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

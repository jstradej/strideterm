import { defineStore } from "pinia";
import { ref } from "vue";
import type { Transport } from "../transport.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GitSnapshot = Record<string, any>;

interface PendingGitAction {
  type: string;
  baseBranch: string;
  stashDirty?: boolean;
  message?: string;
  severity?: string;
  isDestructive?: boolean;
  snapshotHash?: string;
  // Destructive action fields
  action?: string;
  title?: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: Record<string, any>;
}

interface ConflictFileEntry {
  path: string;
  conflictType: string;
  stages: number[];
  binary: boolean;
  resolved: boolean;
}

interface ConflictDialogState {
  open: boolean;
  workspaceId: string;
  rootPath: string;
  /** All files (pending + resolved) — merged across loads so resolved files stay visible */
  conflicts: ConflictFileEntry[];
  loading: boolean;
  error: string;
}

interface GitUiState {
  busyAction?: string;
  lastResult?: {
    ok: boolean;
    summary: string;
    warnings: unknown[];
    conflicts: unknown[];
    rawOutput: string;
    operationState: unknown;
    at: string;
  } | null;
  conflictDialog?: ConflictDialogState | null;
  selectedDiff?: { path: string; scope: string } | null;
  diffPreview?: unknown;
  pendingAction?: PendingGitAction | null;
  snapshotHash?: string;
  activeRootPath?: string;
  selectedCommit?: string;
  commitDiffPreview?: unknown;
  activeTab?: string;
  tags?: unknown[];
  tagsLoading?: boolean;
  tagsError?: string;
  remoteBranches?: unknown[];
  remoteBranchesLoading?: boolean;
  branchesLoading?: boolean;
  branchesError?: string;
  branchList?: {
    current: string;
    upstream: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    local: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    remotes: any[];
    defaultBranch: string;
    defaultRemote: string;
  };
  graphLoading?: boolean;
  graphError?: string;
  graph?: {
    head: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commits: any[];
    refs: Record<string, string>;
  };
  overrideBaseBranch?: string;
  baseComparison?: {
    baseBranch: string;
    aheadCount: number;
    behindCount: number;
    ok: boolean;
    error?: string;
  } | null;
  baseComparisonLoading?: boolean;
  activeReviewTab?: string;
  commentFilter?: string;
  commentSort?: string;
  commentSortDir?: string;
  commentSearch?: string;
  agentSubTab?: string;
  reviewSelectedFile?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reviewFileDiffPreview?: Record<string, any>;
  [key: string]: unknown;
}

interface ConfirmParams {
  action: string;
  severity?: string;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: Record<string, any>;
}

function buildConfirmMessage({
  type,
  snapshot,
  baseBranch,
}: {
  type: string;
  snapshot: GitSnapshot | null;
  baseBranch?: string;
}): string {
  const target = baseBranch || snapshot?.baseBranch || "base";
  const lines: string[] = [];

  if (type === "merge") {
    lines.push(`Merge ${target} into ${snapshot!.branch}?`);
  } else if (type === "rebase") {
    lines.push(
      `Rebase ${snapshot!.branch} onto ${target}? Your commits will be replayed on top of ${target} (commit hashes will change, content is preserved).`,
    );
  } else if (type === "merge-into-base") {
    lines.push(`Merge ${snapshot?.branch || "current branch"} into ${target}?`);
    lines.push("This runs git merge in the base worktree.");
  } else if (type === "abort") {
    lines.push("Abort the current Git operation?");
  }

  if (snapshot?.dirty && type !== "abort") {
    lines.push("This workspace has uncommitted changes. Local changes will be stashed and restored afterwards.");
  }
  if (snapshot?.upstream && type !== "abort") {
    lines.push(`Upstream: ${snapshot.upstream}.`);
  }

  return lines.join("\n");
}

function computeSnapshotHash(snapshot: GitSnapshot | null): string {
  if (!snapshot) return "";
  return [
    snapshot.operationState?.kind,
    snapshot.aheadCount,
    snapshot.behindCount,
    snapshot.compareWithBase?.aheadCount,
    snapshot.compareWithBase?.behindCount,
    snapshot.dirtyCount,
  ].join("|");
}

function buildDestructiveConfirm({
  action,
  severity,
  title,
  body,
  confirmLabel,
  cancelLabel,
  payload,
}: ConfirmParams): PendingGitAction {
  return {
    action,
    severity: severity || "info",
    title,
    body: body || "",
    confirmLabel: confirmLabel || "Confirm",
    cancelLabel: cancelLabel || "Cancel",
    payload: payload || {},
    isDestructive: true,
    type: "",
    baseBranch: "",
  };
}

export const useGitUiStore = defineStore("git-ui", () => {
  // Per-workspace UI state indexed by workspaceId.
  //
  // VIEWER-LOCAL by design: this Pinia store lives in each renderer process,
  // so two windows showing the same workspace keep independent active tabs,
  // selected diffs/commits and active git roots — one window's clicks never
  // flip the other's view. Durable git data (snapshots, branches, repo
  // state) stays workspace-owned in the backend payload.
  const state = ref<Record<string, GitUiState>>({});

  let _api: Transport | null = null;

  function init(api: Transport): void {
    _api = api;
  }

  function ensure(workspaceId: string): GitUiState {
    if (!workspaceId) return {};
    if (!state.value[workspaceId]) {
      // Assign via spread to guarantee Vue detects the new key
      state.value = { ...state.value, [workspaceId]: {} };
    }
    return state.value[workspaceId];
  }

  function get(workspaceId: string): GitUiState {
    return state.value[workspaceId] || {};
  }

  function clearBusy(workspaceId: string): void {
    const ui = ensure(workspaceId);
    ui.busyAction = "";
  }

  function cleanup(workspaceId: string): void {
    const next = { ...state.value };
    delete next[workspaceId];
    state.value = next;
  }

  function setActiveRoot(workspaceId: string, rootPath: string): void {
    const ui = ensure(workspaceId);
    // The LIVE active root is viewer-local (this renderer only). The
    // persisted workspace.activeRootPath below is just the durable DEFAULT
    // used to seed a fresh viewer on reload/first open — sibling windows
    // showing this workspace keep their own in-memory root and are never
    // flipped by this write (see getActiveGitSnapshot in app.ts).
    ui.activeRootPath = rootPath || "";
    if (_api?.setWorkspaceUIState) {
      (_api.setWorkspaceUIState as (id: string, patch: Record<string, unknown>) => Promise<unknown>)(workspaceId, {
        activeRootPath: rootPath || "",
      }).catch(() => {});
    }
  }

  function getActiveRoot(workspaceId: string): string {
    return state.value[workspaceId]?.activeRootPath || "";
  }

  async function runGitAction(
    workspaceId: string,
    busyAction: string,
    runner: () => Promise<unknown>,
  ): Promise<unknown> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();

    const ui = ensure(workspaceId);
    ui.busyAction = busyAction;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = (await runner()) as any;
      if (response?.payload) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        appStore.payload = response.payload as any;
      }
      const result = response?.result;
      // Success path: surface a transient toast and drop any prior banner.
      // Failure (or success with warnings/conflicts the user must read) keeps
      // the full GitOperationCard banner so they can act on it.
      const hasReadworthyExtras =
        !!result && ((result.warnings?.length ?? 0) > 0 || (result.conflicts?.length ?? 0) > 0);
      if (result && result.ok && !hasReadworthyExtras) {
        const { useNotificationStore } = await import("./notifications.js");
        useNotificationStore().pushEphemeralToast({
          title: "Git",
          body: String(result.summary || "Action completed."),
          kind: "info",
          durationMs: 4000,
        });
        ui.lastResult = null;
      } else {
        ui.lastResult = result ? { ...result, at: new Date().toISOString() } : null;
      }

      // Auto-switch to the Conflicts tab when a git action produces conflicts
      if (result && (result.conflicts?.length ?? 0) > 0) {
        const rootPath = getActiveRoot(workspaceId);
        openConflictDialog(workspaceId, rootPath);
        gitSwitchTab(workspaceId, "conflicts");
      }

      if (ui.selectedDiff?.path) {
        const rootPath = getActiveRoot(workspaceId);
        const snapshot = appStore.getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
        const preview = await (_api as Transport & { gitDiffPreview: (p: unknown) => Promise<unknown> })
          .gitDiffPreview!({
          workspaceId,
          path: ui.selectedDiff.path,
          scope: ui.selectedDiff.scope,
          baseBranch: snapshot?.baseBranch || snapshot?.compareWithBase?.baseBranch || "",
          rootPath,
        }).catch(() => null);
        if (preview) ui.diffPreview = preview;
      }

      return response?.payload || null;
    } catch (error) {
      // Surface to console as well — the in-app GitOperationCard banner reads
      // ui.lastResult, but DevTools is where we want a stack trace.
      console.error(`[git-ui] action "${busyAction}" failed for workspace ${workspaceId}:`, error);
      ui.lastResult = {
        ok: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        summary: (error as any)?.message || "Git action failed.",
        warnings: [],
        conflicts: [],
        rawOutput: "",
        operationState: null,
        at: new Date().toISOString(),
      };
      return null;
    } finally {
      clearBusy(workspaceId);
    }
  }

  // --- Git actions ---

  async function refreshGit(workspaceId: string): Promise<void> {
    await runGitAction(workspaceId, "refresh", async () => {
      const payload = await (_api as Transport & { refreshGit: (id: string) => Promise<unknown> }).refreshGit!(
        workspaceId,
      );
      return { payload };
    });
  }

  async function gitFetch(workspaceId: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "fetch", () =>
      (_api as Transport & { gitFetch: (p: unknown) => Promise<unknown> }).gitFetch!({ workspaceId, rootPath }),
    );
  }

  async function gitPull(workspaceId: string, { stashDirty = false }: { stashDirty?: boolean } = {}): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "pull", () =>
      (_api as Transport & { gitPull: (p: unknown) => Promise<unknown> }).gitPull!({
        workspaceId,
        rootPath,
        stashDirty,
      }),
    );
  }

  async function gitPush(workspaceId: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "push", () =>
      (_api as Transport & { gitPush: (p: unknown) => Promise<unknown> }).gitPush!({ workspaceId, rootPath }),
    );
  }

  async function gitCheckoutBranch(workspaceId: string, branch: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "checkout", () =>
      (_api as Transport & { gitCheckoutBranch: (p: unknown) => Promise<unknown> }).gitCheckoutBranch!({
        workspaceId,
        branch,
        rootPath,
      }),
    );
  }

  async function gitCreateBranch(workspaceId: string, branch: string, startPoint: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "create-branch", () =>
      (_api as Transport & { gitCreateBranch: (p: unknown) => Promise<unknown> }).gitCreateBranch!({
        workspaceId,
        branch,
        startPoint,
        rootPath,
      }),
    );
  }

  // --- Branch list & graph (Branches sub-tab) ---

  // Skip a refetch when the same workspace+rootPath was hit recently and the
  // caller didn't explicitly ask for fresh data. Mutations (checkout, merge,
  // etc.) pass force=true so they always re-read.
  const FRESH_TTL_MS = 15_000;

  async function gitListBranches(workspaceId: string, opts: { force?: boolean } = {}): Promise<void> {
    if (!_api) return;
    const ui = ensure(workspaceId);
    const rootPath = getActiveRoot(workspaceId);
    const now = Date.now();
    if (
      !opts.force &&
      !ui.branchesLoading &&
      ui.branchList &&
      ui.branchListKey === rootPath &&
      typeof ui.branchListFetchedAt === "number" &&
      now - (ui.branchListFetchedAt as number) < FRESH_TTL_MS
    ) {
      return;
    }
    ui.branchesLoading = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (_api as any).gitListBranches({ workspaceId, rootPath })) as any;
      if (result?.ok) {
        ui.branchList = {
          current: result.current || "",
          upstream: result.upstream || "",
          local: result.local || [],
          remotes: result.remotes || [],
          defaultBranch: result.defaultBranch || "",
          defaultRemote: result.defaultRemote || "",
        };
        ui.branchesError = "";
        ui.branchListKey = rootPath;
        ui.branchListFetchedAt = Date.now();
      } else {
        ui.branchList = { current: "", upstream: "", local: [], remotes: [], defaultBranch: "", defaultRemote: "" };
        ui.branchesError = result?.error || "Failed to load branches.";
        ui.branchListKey = undefined;
        ui.branchListFetchedAt = undefined;
      }
    } catch (error) {
      ui.branchList = { current: "", upstream: "", local: [], remotes: [], defaultBranch: "", defaultRemote: "" };
      ui.branchesError = (error as Error)?.message || "Failed to load branches.";
      ui.branchListKey = undefined;
      ui.branchListFetchedAt = undefined;
    } finally {
      ui.branchesLoading = false;
    }
  }

  async function gitDeleteBranch(workspaceId: string, branch: string, force: boolean): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "delete-branch", () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_api as any).gitDeleteBranch({ workspaceId, branch, force, rootPath }),
    );
    // Race-net: branchList may have been stale (worktree created since the
    // last refresh). When the backend rejects with the structured code, fall
    // through to the worktree-aware confirm so the user has a one-click path
    // forward instead of just a red error banner.
    const last = state.value[workspaceId]?.lastResult as Record<string, unknown> | null | undefined;
    if (last && last.ok === false && last.code === "branch-in-worktree" && typeof last.worktreePath === "string") {
      confirmRemoveWorktreeDeleteBranch(workspaceId, {
        worktreePath: last.worktreePath,
        branch,
        // force=true means the caller already knew the branch had unmerged
        // commits; force=false means merged. Use that as the best-effort hint.
        branchMerged: !force,
      });
      return;
    }
    await gitListBranches(workspaceId);
  }

  async function gitDeleteRemoteBranch(workspaceId: string, branch: string, remote: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "delete-remote-branch", () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_api as any).gitDeleteRemoteBranch({ workspaceId, branch, remote, rootPath }),
    );
    await gitListBranches(workspaceId);
  }

  async function gitRenameBranch(workspaceId: string, branch: string, newName: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "rename-branch", () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_api as any).gitRenameBranch({ workspaceId, branch, newName, rootPath }),
    );
    await gitListBranches(workspaceId);
  }

  async function gitCheckoutRemoteBranch(
    workspaceId: string,
    remoteBranch: string,
    localBranch: string,
  ): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "checkout-remote", () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_api as any).gitCheckoutRemoteBranch({ workspaceId, remoteBranch, localBranch, rootPath }),
    );
    await gitListBranches(workspaceId);
  }

  async function gitLoadGraph(
    workspaceId: string,
    opts: {
      limit?: number;
      includeRemotes?: boolean;
      branch?: string;
      sinceDate?: string;
      untilDate?: string;
      paths?: string[];
      topoOrder?: boolean;
      author?: string;
      force?: boolean;
    } = {},
  ): Promise<void> {
    if (!_api) return;
    const ui = ensure(workspaceId);
    const rootPath = getActiveRoot(workspaceId);
    const payload = {
      workspaceId,
      rootPath,
      limit: opts.limit || 300,
      includeRemotes: opts.includeRemotes !== false,
      branch: opts.branch || "",
      sinceDate: opts.sinceDate || "",
      untilDate: opts.untilDate || "",
      paths: Array.isArray(opts.paths) ? opts.paths.filter(Boolean) : [],
      topoOrder: opts.topoOrder === true,
      author: opts.author || "",
    };
    // Cache key includes every param that influences the git log walk — any
    // change of these means a different commit set and we must re-fetch.
    // workspaceId is the bucket itself so we don't include it in the key.
    const { workspaceId: _ignored, ...payloadForKey } = payload;
    void _ignored;
    const cacheKey = JSON.stringify(payloadForKey);
    const now = Date.now();
    if (
      !opts.force &&
      !ui.graphLoading &&
      ui.graph &&
      Array.isArray(ui.graph.commits) &&
      ui.graphKey === cacheKey &&
      typeof ui.graphFetchedAt === "number" &&
      now - (ui.graphFetchedAt as number) < FRESH_TTL_MS
    ) {
      return;
    }
    ui.graphLoading = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (_api as any).gitLogGraph(payload)) as {
        ok?: boolean;
        head?: string;
        commits?: unknown[];
        refs?: Record<string, string>;
        error?: string;
      };
      if (result?.ok) {
        ui.graph = {
          head: result.head || "",
          commits: result.commits || [],
          refs: result.refs || {},
        };
        ui.graphError = "";
        ui.graphKey = cacheKey;
        ui.graphFetchedAt = Date.now();
      } else {
        ui.graph = { head: "", commits: [], refs: {} };
        ui.graphError = result?.error || "Failed to load graph.";
        ui.graphKey = undefined;
        ui.graphFetchedAt = undefined;
        if (ui.graphError) console.warn(`[git-ui] gitLoadGraph(${workspaceId}) reported error:`, ui.graphError);
      }
    } catch (error) {
      ui.graph = { head: "", commits: [], refs: {} };
      ui.graphError = (error as Error)?.message || "Failed to load graph.";
      ui.graphKey = undefined;
      ui.graphFetchedAt = undefined;
      console.error(`[git-ui] gitLoadGraph(${workspaceId}) threw:`, error);
    } finally {
      ui.graphLoading = false;
    }
  }

  async function bulkFetch(workspaceId: string): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const workspace = appStore.filteredWorkspaces?.find((w: { id: string }) => w.id === workspaceId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = workspace as any;
    const roots: string[] = ws?.gitRoots?.length ? ws.gitRoots : [ws?.cwd].filter(Boolean);
    for (const rootPath of roots) {
      await runGitAction(workspaceId, `bulk-fetch:${rootPath}`, () =>
        (_api as Transport & { gitFetch: (p: unknown) => Promise<unknown> }).gitFetch!({ workspaceId, rootPath }),
      );
    }
  }

  async function bulkPull(workspaceId: string): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const workspace = appStore.filteredWorkspaces?.find((w: { id: string }) => w.id === workspaceId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = workspace as any;
    const roots: string[] = ws?.gitRoots?.length ? ws.gitRoots : [ws?.cwd].filter(Boolean);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (appStore.payload as any)?.git?.workspaces?.[workspaceId];
    for (const rootPath of roots) {
      // Skip dirty repos
      const snap = entry?.roots?.[rootPath] || (entry?.rootPath === rootPath ? entry : null);
      if (snap?.dirty) continue;
      await runGitAction(workspaceId, `bulk-pull:${rootPath}`, () =>
        (_api as Transport & { gitPull: (p: unknown) => Promise<unknown> }).gitPull!({ workspaceId, rootPath }),
      );
    }
  }

  function setPendingGitAction(
    workspaceId: string,
    { type, baseBranch, snapshot }: { type: string; baseBranch: string; snapshot: GitSnapshot | null },
  ): void {
    const ui = ensure(workspaceId);
    ui.pendingAction = {
      type,
      baseBranch,
      stashDirty: snapshot?.dirty || false,
      message: buildConfirmMessage({ type, snapshot, baseBranch }),
      severity: "info",
      isDestructive: false,
      snapshotHash: computeSnapshotHash(snapshot),
    };
  }

  function setPendingDestructiveAction(
    workspaceId: string,
    confirm: PendingGitAction,
    snapshot: GitSnapshot | null = null,
  ): void {
    const ui = ensure(workspaceId);
    ui.pendingAction = { ...confirm, snapshotHash: computeSnapshotHash(snapshot) };
  }

  function dismissStalePending(workspaceId: string, currentSnapshot: GitSnapshot | null): void {
    const ui = get(workspaceId);
    if (!ui.pendingAction) return;
    const stored = ui.pendingAction.snapshotHash;
    if (!stored) return;
    if (stored !== computeSnapshotHash(currentSnapshot)) {
      const ws = ensure(workspaceId);
      ws.pendingAction = null;
      ws.lastResult = {
        ok: false,
        summary: "Repository state changed — please reconfirm.",
        warnings: [],
        conflicts: [],
        rawOutput: "",
        operationState: null,
        at: new Date().toISOString(),
      };
    }
  }

  function clearPendingGitAction(workspaceId: string): void {
    const ui = ensure(workspaceId);
    ui.pendingAction = null;
  }

  async function gitConfirmAction(workspaceId: string): Promise<void> {
    const ui = ensure(workspaceId);
    const pending = ui.pendingAction;
    if (!pending) return;
    ui.pendingAction = null;

    const rootPath = getActiveRoot(workspaceId);

    // Destructive actions dispatched by buildDestructiveConfirm
    if (pending.isDestructive) {
      const { action, payload: p } = pending;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = _api as any;
      if (action === "deleteLocalTag") {
        await runGitAction(workspaceId, "delete-tag", () =>
          api.gitDeleteTag({ workspaceId, tagName: p!.tagName, rootPath }),
        );
        await gitListTags(workspaceId);
      } else if (action === "deleteRemoteTag") {
        await runGitAction(workspaceId, "delete-remote-tag", () =>
          api.gitDeleteRemoteTag({ workspaceId, tagName: p!.tagName, rootPath }),
        );
        await gitListTags(workspaceId);
      } else if (action === "removeWorktree") {
        await runGitAction(workspaceId, "remove-worktree", () =>
          api.gitRemoveWorktree({ workspaceId, worktreePath: p!.worktreePath, deleteBranch: false }),
        );
      } else if (action === "removeWorktreeDeleteBranch") {
        await runGitAction(workspaceId, "remove-worktree", () =>
          api.gitRemoveWorktree({ workspaceId, worktreePath: p!.worktreePath, deleteBranch: true }),
        );
      } else if (action === "forcePushWithLease") {
        await runGitAction(workspaceId, "force-push", () => api.gitForcePushWithLease({ workspaceId, rootPath }));
      }
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = _api as any;
    if (pending.type === "abort") {
      await runGitAction(workspaceId, "abort", () => api.gitAbortOperation({ workspaceId, rootPath }));
      return;
    }
    if (pending.type === "merge-into-base") {
      await runGitAction(workspaceId, "merge-into-base", () =>
        api.gitMergeCurrentIntoBase({ workspaceId, baseBranch: pending.baseBranch, rootPath }),
      );
      return;
    }
    const payload = { workspaceId, baseBranch: pending.baseBranch, stashDirty: pending.stashDirty, rootPath };
    await runGitAction(workspaceId, pending.type, () =>
      pending.type === "merge" ? api.gitMergeIntoCurrent(payload) : api.gitRebaseOnto(payload),
    );
  }

  function confirmDeleteLocalTag(workspaceId: string, tagName: string): void {
    setPendingDestructiveAction(
      workspaceId,
      buildDestructiveConfirm({
        action: "deleteLocalTag",
        severity: "warn",
        title: "Delete local tag",
        body: `Delete tag \`${tagName}\` locally?`,
        confirmLabel: "Delete",
        payload: { tagName },
      }),
    );
  }

  function confirmDeleteRemoteTag(workspaceId: string, tagName: string): void {
    setPendingDestructiveAction(
      workspaceId,
      buildDestructiveConfirm({
        action: "deleteRemoteTag",
        severity: "danger",
        title: "Delete remote tag",
        body: `Delete tag \`${tagName}\` on remote? This cannot be undone.`,
        confirmLabel: "Delete from remote",
        payload: { tagName },
      }),
    );
  }

  function confirmRemoveWorktree(
    workspaceId: string,
    { worktreePath, branch, branchMerged }: { worktreePath: string; branch: string; branchMerged: boolean },
    snapshot: GitSnapshot | null = null,
  ): void {
    const severity = branchMerged ? "warn" : "danger";
    const body = branchMerged
      ? `Remove worktree at \`${worktreePath}\`? Branch \`${branch}\` will be kept.`
      : `Remove worktree at \`${worktreePath}\`? Branch \`${branch}\` has unmerged commits and will be kept.`;
    setPendingDestructiveAction(
      workspaceId,
      buildDestructiveConfirm({
        action: "removeWorktree",
        severity,
        title: "Remove worktree",
        body,
        confirmLabel: "Remove",
        payload: { worktreePath },
      }),
      snapshot,
    );
  }

  function confirmRemoveWorktreeDeleteBranch(
    workspaceId: string,
    { worktreePath, branch, branchMerged }: { worktreePath: string; branch: string; branchMerged: boolean },
    snapshot: GitSnapshot | null = null,
  ): void {
    const severity = branchMerged ? "warn" : "danger";
    const body = branchMerged
      ? `Remove worktree and delete merged branch \`${branch}\`?`
      : `Branch \`${branch}\` has unmerged commits. Remove worktree and delete branch anyway?`;
    setPendingDestructiveAction(
      workspaceId,
      buildDestructiveConfirm({
        action: "removeWorktreeDeleteBranch",
        severity,
        title: "Remove worktree + delete branch",
        body,
        confirmLabel: severity === "danger" ? "Delete (unmerged)" : "Remove + delete",
        payload: { worktreePath },
      }),
      snapshot,
    );
  }

  function confirmForcePushWithLease(
    workspaceId: string,
    { branch, remote, behindCount }: { branch: string; remote: string; behindCount: number },
    snapshot: GitSnapshot | null = null,
  ): void {
    setPendingDestructiveAction(
      workspaceId,
      buildDestructiveConfirm({
        action: "forcePushWithLease",
        severity: "danger",
        title: "Force push (with lease)",
        body:
          `Force-push \`${branch}\` to \`${remote}/${branch}\`? Remote is ${behindCount} commit(s) ahead — those commits will be overwritten. ` +
          "`--force-with-lease` aborts if someone pushed since your last fetch, but users who already pulled will need to reset their local branch.",
        confirmLabel: "Force push",
        payload: { branch, remote },
      }),
      snapshot,
    );
  }

  async function gitContinue(workspaceId: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "continue", () =>
      (_api as Transport & { gitContinueOperation: (p: unknown) => Promise<unknown> }).gitContinueOperation!({
        workspaceId,
        rootPath,
      }),
    );
  }

  async function gitAbort(workspaceId: string): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    const snapshot = appStore.getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
    setPendingGitAction(workspaceId, { type: "abort", snapshot, baseBranch: "" });
  }

  async function gitMergeBase(workspaceId: string, baseBranch: string): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    const snapshot = appStore.getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
    if (!snapshot?.available) return;
    setPendingGitAction(workspaceId, { type: "merge", snapshot, baseBranch: baseBranch || snapshot.baseBranch });
  }

  async function gitRebaseBase(workspaceId: string, baseBranch: string): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    const snapshot = appStore.getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
    if (!snapshot?.available) return;
    setPendingGitAction(workspaceId, { type: "rebase", snapshot, baseBranch: baseBranch || snapshot.baseBranch });
  }

  async function gitMergeIntoBase(workspaceId: string, baseBranch: string): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    const snapshot = appStore.getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
    if (!snapshot?.available) return;
    setPendingGitAction(workspaceId, { type: "merge-into-base", snapshot, baseBranch });
  }

  async function gitRemoveWorktree(workspaceId: string, worktreePath: string, deleteBranch: boolean): Promise<void> {
    await runGitAction(workspaceId, "remove-worktree", () =>
      (_api as Transport & { gitRemoveWorktree: (p: unknown) => Promise<unknown> }).gitRemoveWorktree!({
        workspaceId,
        worktreePath,
        deleteBranch,
      }),
    );
  }

  async function gitCommitAll(workspaceId: string, message: string): Promise<void> {
    if (!message) return;
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "commit", () =>
      (_api as Transport & { gitCommitAll: (p: unknown) => Promise<unknown> }).gitCommitAll!({
        workspaceId,
        message,
        rootPath,
      }),
    );
  }

  async function gitSelectCommit(workspaceId: string, hash: string): Promise<void> {
    if (!hash) return;
    const ui = ensure(workspaceId);
    ui.selectedCommit = hash;
    ui.commitDiffPreview = { ok: true, hash, diff: "", summary: "Loading..." };
    try {
      ui.commitDiffPreview = await (_api as Transport & { gitCommitDiff: (p: unknown) => Promise<unknown> })
        .gitCommitDiff!({ workspaceId, hash });
    } catch (error) {
      ui.commitDiffPreview = {
        ok: false,
        hash,
        diff: "",
        summary: (error as Error)?.message || "Failed to load commit diff.",
      };
    }
  }

  async function gitSelectDiff(workspaceId: string, path: string, scope: string): Promise<void> {
    if (!path) return;
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    const snapshot = appStore.getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
    const ui = ensure(workspaceId);
    ui.selectedDiff = { path, scope };
    ui.diffPreview = { ok: true, path, scope, diff: "", summary: "Loading diff preview..." };
    try {
      ui.diffPreview = await (_api as Transport & { gitDiffPreview: (p: unknown) => Promise<unknown> }).gitDiffPreview!(
        {
          workspaceId,
          path,
          scope,
          baseBranch: snapshot?.baseBranch || snapshot?.compareWithBase?.baseBranch || "",
          rootPath,
        },
      );
    } catch (error) {
      ui.diffPreview = {
        ok: false,
        path,
        scope,
        diff: "",
        summary: (error as Error)?.message || "Diff preview failed to load.",
      };
    }
  }

  function gitSwitchTab(workspaceId: string, tab: string): void {
    ensure(workspaceId).activeTab = tab;
  }

  function gitClearResult(workspaceId: string): void {
    ensure(workspaceId).lastResult = null;
  }

  function gitClearSelectedDiff(workspaceId: string): void {
    const ui = ensure(workspaceId);
    ui.selectedDiff = null;
    ui.diffPreview = null;
  }

  async function gitStashPop(workspaceId: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "stash-pop", () =>
      (_api as Transport & { gitStashPop: (p: unknown) => Promise<unknown> }).gitStashPop!({ workspaceId, rootPath }),
    );
  }

  // --- Tag actions ---

  async function gitListTags(workspaceId: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    const ui = ensure(workspaceId);
    ui.tagsLoading = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (_api as any).gitListTags({ workspaceId, rootPath })) as any;
      ui.tags = result?.tags || [];
      ui.tagsError = result?.ok === false ? result.summary : "";
    } catch (error) {
      ui.tags = [];
      ui.tagsError = (error as Error)?.message || "Failed to load tags.";
    } finally {
      ui.tagsLoading = false;
    }
  }

  async function gitCreateTag(workspaceId: string, tagName: string, message: string, commit = ""): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "create-tag", () =>
      (_api as Transport & { gitCreateTag: (p: unknown) => Promise<unknown> }).gitCreateTag!({
        workspaceId,
        tagName,
        message: message || "",
        commit: commit || "",
        rootPath,
      }),
    );
    await gitListTags(workspaceId);
  }

  async function gitDeleteTag(workspaceId: string, tagName: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "delete-tag", () =>
      (_api as Transport & { gitDeleteTag: (p: unknown) => Promise<unknown> }).gitDeleteTag!({
        workspaceId,
        tagName,
        rootPath,
      }),
    );
    await gitListTags(workspaceId);
  }

  async function gitPushTag(workspaceId: string, tagName: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "push-tag", () =>
      (_api as Transport & { gitPushTag: (p: unknown) => Promise<unknown> }).gitPushTag!({
        workspaceId,
        tagName,
        rootPath,
      }),
    );
    await gitListTags(workspaceId);
  }

  async function gitPushAllTags(workspaceId: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "push-all-tags", () =>
      (_api as Transport & { gitPushAllTags: (p: unknown) => Promise<unknown> }).gitPushAllTags!({
        workspaceId,
        rootPath,
      }),
    );
    await gitListTags(workspaceId);
  }

  async function gitDeleteRemoteTag(workspaceId: string, tagName: string): Promise<void> {
    const rootPath = getActiveRoot(workspaceId);
    await runGitAction(workspaceId, "delete-remote-tag", () =>
      (_api as Transport & { gitDeleteRemoteTag: (p: unknown) => Promise<unknown> }).gitDeleteRemoteTag!({
        workspaceId,
        tagName,
        rootPath,
      }),
    );
    await gitListTags(workspaceId);
  }

  function gitSetBaseBranch(workspaceId: string, baseBranch: string): void {
    const ui = ensure(workspaceId);
    ui.overrideBaseBranch = baseBranch || "";
  }

  async function gitFetchBaseComparison(
    workspaceId: string,
    baseBranch: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const ui = ensure(workspaceId);
    if (!baseBranch) {
      ui.baseComparison = null;
      return;
    }
    const rootPath = getActiveRoot(workspaceId);
    const cacheKey = `${rootPath}::${baseBranch}`;
    const now = Date.now();
    // Skip when the same base was just compared (in-flight or fresh). The
    // watches in GitBranchesTab and GitBranchTab fire this whenever
    // compareBase/effectiveBaseBranch changes — without dedup we'd thrash on
    // re-renders.
    if (
      !opts.force &&
      ui.baseComparisonKey === cacheKey &&
      (ui.baseComparisonLoading ||
        (typeof ui.baseComparisonFetchedAt === "number" && now - (ui.baseComparisonFetchedAt as number) < FRESH_TTL_MS))
    ) {
      return;
    }
    ui.baseComparisonKey = cacheKey;
    ui.baseComparisonLoading = true;
    try {
      const result = (await (_api as Transport & { gitCompareBranch: (p: unknown) => Promise<unknown> })
        .gitCompareBranch!({ workspaceId, baseBranch, rootPath })) as {
        ok?: boolean;
        baseBranch?: string;
        aheadCount?: number;
        behindCount?: number;
        error?: string;
      } | null;
      if (!result || !result.ok) {
        ui.baseComparison = {
          baseBranch,
          aheadCount: 0,
          behindCount: 0,
          ok: false,
          error: (result?.error as string) || "Failed to compare",
        };
      } else {
        ui.baseComparison = {
          baseBranch: result.baseBranch || baseBranch,
          aheadCount: result.aheadCount || 0,
          behindCount: result.behindCount || 0,
          ok: true,
        };
      }
    } catch (error) {
      ui.baseComparison = {
        baseBranch,
        aheadCount: 0,
        behindCount: 0,
        ok: false,
        error: (error as Error)?.message || "Failed to compare",
      };
    } finally {
      ui.baseComparisonLoading = false;
      ui.baseComparisonFetchedAt = Date.now();
    }
  }

  async function azureCreatePullRequest(
    workspaceId: string,
    {
      title,
      description,
      sourceBranch,
      targetBranch,
      connectionId,
      isDraft = false,
    }: {
      title: string;
      description: string;
      sourceBranch: string;
      targetBranch: string;
      connectionId: string;
      isDraft?: boolean;
    },
  ): Promise<unknown> {
    const rootPath = getActiveRoot(workspaceId);
    return runGitAction(workspaceId, "create-pr", () =>
      (_api as Transport & { azureCreatePullRequest: (p: unknown) => Promise<unknown> }).azureCreatePullRequest!({
        workspaceId,
        title,
        description,
        sourceBranch,
        targetBranch,
        connectionId,
        isDraft,
        rootPath,
      }),
    );
  }

  async function azureListRemoteBranches(workspaceId: string): Promise<void> {
    const ui = ensure(workspaceId);
    ui.remoteBranchesLoading = true;
    try {
      const rootPath = getActiveRoot(workspaceId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (_api as any).azureListRemoteBranches({ workspaceId, rootPath })) as any;
      ui.remoteBranches = result?.branches || [];
    } catch {
      ui.remoteBranches = [];
    } finally {
      ui.remoteBranchesLoading = false;
    }
  }

  async function openLazygit(workspaceId: string): Promise<void> {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nextPayload = await (_api as any).openLazygitSession({ workspaceId, rootPath });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appStore.payload = nextPayload as any;
    appStore.activeViewId = `${workspaceId}:lazygit`;
  }

  // --- Azure review UI state ---
  function reviewSwitchTab(workspaceId: string, tab: string): void {
    ensure(workspaceId).activeReviewTab = tab || "summary";
  }

  function reviewSetCommentFilter(workspaceId: string, filter: string): void {
    ensure(workspaceId).commentFilter = filter || "all";
  }

  function reviewSetCommentSort(workspaceId: string, sort: string): void {
    const ws = ensure(workspaceId);
    if (ws.commentSort === sort) {
      // Toggle direction when clicking the same sort
      ws.commentSortDir = ws.commentSortDir === "asc" ? "desc" : "asc";
    } else {
      ws.commentSort = sort || "index";
      // Default direction: newest→desc, others→asc
      ws.commentSortDir = sort === "newest" ? "desc" : "asc";
    }
  }

  function reviewSetCommentSearch(workspaceId: string, search: string): void {
    ensure(workspaceId).commentSearch = search || "";
  }

  function reviewSetAgentSubtab(workspaceId: string, subtab: string): void {
    ensure(workspaceId).agentSubTab = subtab || "prompts";
  }

  async function reviewSelectFileDiff(workspaceId: string, filePath: string, baseBranch?: string): Promise<void> {
    if (!workspaceId || !filePath) return;
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const rootPath = getActiveRoot(workspaceId);
    const snapshot = appStore.getGitSnapshot(workspaceId, rootPath) as GitSnapshot | null;
    const resolvedBase = baseBranch || snapshot?.baseBranch || snapshot?.compareWithBase?.baseBranch || "";
    const ui = ensure(workspaceId);
    ui.reviewSelectedFile = filePath;
    ui.reviewFileDiffPreview = { ok: true, path: filePath, diff: "", summary: "Loading diff preview..." };
    try {
      ui.reviewFileDiffPreview = (await (_api as Transport & { gitDiffPreview: (p: unknown) => Promise<unknown> })
        .gitDiffPreview!({
        workspaceId,
        path: filePath,
        scope: "branch",
        baseBranch: resolvedBase.startsWith("origin/") ? resolvedBase : resolvedBase ? `origin/${resolvedBase}` : "",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as Record<string, any>;
    } catch (error) {
      ui.reviewFileDiffPreview = {
        ok: false,
        path: filePath,
        diff: "",
        summary: (error as Error)?.message || "Diff preview failed to load.",
      };
    }
  }

  // --- Conflict resolution dialog ---

  function openConflictDialog(workspaceId: string, rootPath: string): void {
    const ui = ensure(workspaceId);
    ui.conflictDialog = { open: true, workspaceId, rootPath, conflicts: [], loading: false, error: "" };
    void loadConflicts(workspaceId);
  }

  function closeConflictDialog(workspaceId: string): void {
    const ui = ensure(workspaceId);
    if (ui.conflictDialog) ui.conflictDialog = { ...ui.conflictDialog, open: false };
    // The Conflicts tab disappears with the conflict state — land on Overview.
    if (ui.activeTab === "conflicts") ui.activeTab = "branch";
  }

  async function loadConflicts(workspaceId: string): Promise<void> {
    const ui = ensure(workspaceId);
    const dlg = ui.conflictDialog;
    if (!dlg) return;
    dlg.loading = true;
    dlg.error = "";
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await (_api as any).gitListConflicts({
        workspaceId,
        rootPath: dlg.rootPath,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as Record<string, any>;
      // Backend (git-manager.listConflicts) returns the list under `entries`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending: Record<string, any>[] = result?.entries || result?.conflicts || [];
      const pendingPaths = new Set(pending.map((e) => e.path as string));
      // Merge: existing resolved files stay; pending files update/add
      const existingByPath = new Map(dlg.conflicts.map((c) => [c.path, c]));
      const merged: ConflictFileEntry[] = [];
      // Add/update all pending entries
      for (const p of pending) {
        merged.push({
          path: p.path as string,
          conflictType: (p.conflictType as string) || "both-modified",
          stages: (p.stages as number[]) || [],
          binary: (p.binary as boolean) || false,
          resolved: false,
        });
      }
      // Keep previously-known entries that are now resolved (no longer pending)
      for (const existing of existingByPath.values()) {
        if (!pendingPaths.has(existing.path)) {
          merged.push({ ...existing, resolved: true });
        }
      }
      // Sort: pending first, then resolved
      merged.sort((a, b) => {
        if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
        return a.path.localeCompare(b.path);
      });
      dlg.conflicts = merged;
    } catch (err) {
      dlg.error = (err as Error)?.message || "Failed to load conflicts.";
    } finally {
      dlg.loading = false;
    }
  }

  async function resolveConflictFile(
    workspaceId: string,
    filePath: string,
    mode: "ours" | "theirs" | "delete" | "manual",
    content?: string,
  ): Promise<void> {
    const ui = ensure(workspaceId);
    const dlg = ui.conflictDialog;
    if (!dlg) return;
    await runGitAction(workspaceId, `resolve:${filePath}`, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_api as any).gitResolveConflict({ workspaceId, rootPath: dlg.rootPath, filePath, mode, content }),
    );
    await loadConflicts(workspaceId);
  }

  async function unresolveConflictFile(workspaceId: string, filePath: string): Promise<void> {
    const ui = ensure(workspaceId);
    const dlg = ui.conflictDialog;
    if (!dlg) return;
    await runGitAction(workspaceId, `unresolve:${filePath}`, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_api as any).gitUnresolveConflict({ workspaceId, rootPath: dlg.rootPath, filePath }),
    );
    await loadConflicts(workspaceId);
  }

  async function skipConflictCommit(workspaceId: string): Promise<void> {
    const ui = ensure(workspaceId);
    const dlg = ui.conflictDialog;
    if (!dlg) return;
    await runGitAction(workspaceId, "skip", () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_api as any).gitSkipCommit({ workspaceId, rootPath: dlg.rootPath }),
    );
    // After skip, check if there are more conflicts (rebase may pause again)
    await refreshGit(workspaceId);
    // Re-load the conflicts for the current (possibly new) stopped commit
    await loadConflicts(workspaceId);
    // If no more conflicts, close the dialog
    const after = ensure(workspaceId).conflictDialog;
    if (after && !after.loading && !after.conflicts.length) closeConflictDialog(workspaceId);
  }

  async function continueAfterConflicts(workspaceId: string): Promise<void> {
    const ui = ensure(workspaceId);
    const dlg = ui.conflictDialog;
    if (!dlg) return;
    await runGitAction(workspaceId, "continue", () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_api as any).gitContinueOperation({ workspaceId, rootPath: dlg.rootPath }),
    );
    // After continue, operation may stop again (next conflicting commit in rebase)
    await refreshGit(workspaceId);
    await loadConflicts(workspaceId);
    const after = ensure(workspaceId).conflictDialog;
    if (after && !after.loading && !after.conflicts.length) closeConflictDialog(workspaceId);
  }

  async function abortFromConflictDialog(workspaceId: string): Promise<void> {
    const ui = ensure(workspaceId);
    const dlg = ui.conflictDialog;
    if (!dlg) return;
    await runGitAction(workspaceId, "abort", () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_api as any).gitAbortOperation({ workspaceId, rootPath: dlg.rootPath }),
    );
    closeConflictDialog(workspaceId);
  }

  async function refreshRoot(workspaceId: string, rootPath: string): Promise<void> {
    await runGitAction(workspaceId, `refresh:${rootPath}`, async () => {
      const payload = await (_api as Transport & { refreshGit: (id: string) => Promise<unknown> }).refreshGit!(
        workspaceId,
      );
      return { payload };
    });
  }

  async function pullRoot(workspaceId: string, rootPath: string): Promise<void> {
    await runGitAction(workspaceId, `pull:${rootPath}`, () =>
      (_api as Transport & { gitPull: (p: unknown) => Promise<unknown> }).gitPull!({ workspaceId, rootPath }),
    );
  }

  async function revealRoot(workspaceId: string, rootPath: string): Promise<void> {
    if (!rootPath) return;
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    await appStore.quickAddTab(rootPath);
  }

  return {
    // Read accessor
    get,
    cleanup,
    init,
    // Active root management
    setActiveRoot,
    getActiveRoot,
    // Git actions
    runGitAction,
    refreshGit,
    gitFetch,
    gitPull,
    gitPush,
    bulkFetch,
    bulkPull,
    refreshRoot,
    pullRoot,
    revealRoot,
    gitCheckoutBranch,
    gitCreateBranch,
    gitListBranches,
    gitDeleteBranch,
    gitDeleteRemoteBranch,
    gitRenameBranch,
    gitCheckoutRemoteBranch,
    gitLoadGraph,
    setPendingGitAction,
    setPendingDestructiveAction,
    clearPendingGitAction,
    dismissStalePending,
    gitConfirmAction,
    gitContinue,
    gitAbort,
    gitMergeBase,
    gitRebaseBase,
    gitMergeIntoBase,
    gitRemoveWorktree,
    confirmDeleteLocalTag,
    confirmDeleteRemoteTag,
    confirmRemoveWorktree,
    confirmRemoveWorktreeDeleteBranch,
    confirmForcePushWithLease,
    gitCommitAll,
    gitSelectCommit,
    gitSelectDiff,
    gitSwitchTab,
    gitClearResult,
    gitClearSelectedDiff,
    openLazygit,
    gitStashPop,
    gitSetBaseBranch,
    gitFetchBaseComparison,
    gitListTags,
    gitCreateTag,
    gitDeleteTag,
    gitPushTag,
    gitPushAllTags,
    gitDeleteRemoteTag,
    azureCreatePullRequest,
    azureListRemoteBranches,
    // Azure review UI actions
    reviewSwitchTab,
    reviewSetCommentFilter,
    reviewSetCommentSort,
    reviewSetCommentSearch,
    reviewSetAgentSubtab,
    reviewSelectFileDiff,
    // Conflict resolution dialog
    openConflictDialog,
    closeConflictDialog,
    loadConflicts,
    resolveConflictFile,
    unresolveConflictFile,
    skipConflictCommit,
    continueAfterConflicts,
    abortFromConflictDialog,
  };
});

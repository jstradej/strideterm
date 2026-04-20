import { defineStore } from "pinia";
import { ref } from "vue";

function buildConfirmMessage({ type, snapshot, baseBranch }) {
  const target = baseBranch || snapshot?.baseBranch || "base";
  const lines = [];

  if (type === "merge") {
    lines.push(`Merge ${target} into ${snapshot.branch}?`);
  } else if (type === "rebase") {
    lines.push(
      `Rebase ${snapshot.branch} onto ${target}? Your commits will be replayed on top of ${target} (commit hashes will change, content is preserved).`,
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

function computeSnapshotHash(snapshot) {
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

function buildDestructiveConfirm({ action, severity, title, body, confirmLabel, cancelLabel, payload }) {
  return {
    action,
    severity: severity || "info",
    title,
    body: body || "",
    confirmLabel: confirmLabel || "Confirm",
    cancelLabel: cancelLabel || "Cancel",
    payload: payload || {},
    isDestructive: true,
  };
}

export const useGitUiStore = defineStore("git-ui", () => {
  // Per-workspace UI state indexed by workspaceId
  const state = ref({});

  let _api = null;

  function init(api) {
    _api = api;
  }

  function ensure(workspaceId) {
    if (!workspaceId) return {};
    if (!state.value[workspaceId]) {
      // Assign via spread to guarantee Vue detects the new key
      state.value = { ...state.value, [workspaceId]: {} };
    }
    return state.value[workspaceId];
  }

  function get(workspaceId) {
    return state.value[workspaceId] || {};
  }

  function clearBusy(workspaceId) {
    const ui = ensure(workspaceId);
    ui.busyAction = "";
  }

  function cleanup(workspaceId) {
    const next = { ...state.value };
    delete next[workspaceId];
    state.value = next;
  }

  async function runGitAction(workspaceId, busyAction, runner) {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();

    const ui = ensure(workspaceId);
    ui.busyAction = busyAction;

    try {
      const response = await runner();
      if (response?.payload) {
        appStore.payload = response.payload;
      }
      ui.lastResult = response?.result ? { ...response.result, at: new Date().toISOString() } : null;

      if (ui.selectedDiff?.path) {
        const snapshot = appStore.getGitSnapshot(workspaceId);
        const preview = await _api
          .gitDiffPreview({
            workspaceId,
            path: ui.selectedDiff.path,
            scope: ui.selectedDiff.scope,
            baseBranch: snapshot?.baseBranch || snapshot?.compareWithBase?.baseBranch || "",
          })
          .catch(() => null);
        if (preview) ui.diffPreview = preview;
      }

      return response?.payload || null;
    } catch (error) {
      ui.lastResult = {
        ok: false,
        summary: error?.message || "Git action failed.",
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

  async function refreshGit(workspaceId) {
    await runGitAction(workspaceId, "refresh", async () => {
      const payload = await _api.refreshGit(workspaceId);
      return { payload };
    });
  }

  async function gitFetch(workspaceId) {
    await runGitAction(workspaceId, "fetch", () => _api.gitFetch({ workspaceId }));
  }

  async function gitPull(workspaceId) {
    await runGitAction(workspaceId, "pull", () => _api.gitPull({ workspaceId }));
  }

  async function gitPush(workspaceId) {
    await runGitAction(workspaceId, "push", () => _api.gitPush({ workspaceId }));
  }

  async function gitCheckoutBranch(workspaceId, branch) {
    await runGitAction(workspaceId, "checkout", () => _api.gitCheckoutBranch({ workspaceId, branch }));
  }

  async function gitCreateBranch(workspaceId, branch, startPoint) {
    await runGitAction(workspaceId, "create-branch", () => _api.gitCreateBranch({ workspaceId, branch, startPoint }));
  }

  function setPendingGitAction(workspaceId, { type, baseBranch, snapshot }) {
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

  function setPendingDestructiveAction(workspaceId, confirm, snapshot = null) {
    const ui = ensure(workspaceId);
    ui.pendingAction = { ...confirm, snapshotHash: computeSnapshotHash(snapshot) };
  }

  function dismissStalePending(workspaceId, currentSnapshot) {
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

  function clearPendingGitAction(workspaceId) {
    const ui = ensure(workspaceId);
    ui.pendingAction = null;
  }

  async function gitConfirmAction(workspaceId) {
    const ui = ensure(workspaceId);
    const pending = ui.pendingAction;
    if (!pending) return;
    ui.pendingAction = null;

    // Destructive actions dispatched by buildDestructiveConfirm
    if (pending.isDestructive) {
      const { action, payload: p } = pending;
      if (action === "deleteLocalTag") {
        await runGitAction(workspaceId, "delete-tag", () => _api.gitDeleteTag({ workspaceId, tagName: p.tagName }));
        await gitListTags(workspaceId);
      } else if (action === "deleteRemoteTag") {
        await runGitAction(workspaceId, "delete-remote-tag", () =>
          _api.gitDeleteRemoteTag({ workspaceId, tagName: p.tagName }),
        );
        await gitListTags(workspaceId);
      } else if (action === "removeWorktree") {
        await runGitAction(workspaceId, "remove-worktree", () =>
          _api.gitRemoveWorktree({ workspaceId, worktreePath: p.worktreePath, deleteBranch: false }),
        );
      } else if (action === "removeWorktreeDeleteBranch") {
        await runGitAction(workspaceId, "remove-worktree", () =>
          _api.gitRemoveWorktree({ workspaceId, worktreePath: p.worktreePath, deleteBranch: true }),
        );
      } else if (action === "forcePushWithLease") {
        await runGitAction(workspaceId, "force-push", () => _api.gitForcePushWithLease({ workspaceId }));
      }
      return;
    }

    if (pending.type === "abort") {
      await runGitAction(workspaceId, "abort", () => _api.gitAbortOperation({ workspaceId }));
      return;
    }
    if (pending.type === "merge-into-base") {
      await runGitAction(workspaceId, "merge-into-base", () =>
        _api.gitMergeCurrentIntoBase({ workspaceId, baseBranch: pending.baseBranch }),
      );
      return;
    }
    const payload = { workspaceId, baseBranch: pending.baseBranch, stashDirty: pending.stashDirty };
    await runGitAction(workspaceId, pending.type, () =>
      pending.type === "merge" ? _api.gitMergeIntoCurrent(payload) : _api.gitRebaseOnto(payload),
    );
  }

  function confirmDeleteLocalTag(workspaceId, tagName) {
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

  function confirmDeleteRemoteTag(workspaceId, tagName) {
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

  function confirmRemoveWorktree(workspaceId, { worktreePath, branch, branchMerged }, snapshot = null) {
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

  function confirmRemoveWorktreeDeleteBranch(workspaceId, { worktreePath, branch, branchMerged }, snapshot = null) {
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

  function confirmForcePushWithLease(workspaceId, { branch, remote, behindCount }, snapshot = null) {
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

  async function gitContinue(workspaceId) {
    await runGitAction(workspaceId, "continue", () => _api.gitContinueOperation({ workspaceId }));
  }

  async function gitAbort(workspaceId) {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const snapshot = appStore.getGitSnapshot(workspaceId);
    setPendingGitAction(workspaceId, { type: "abort", snapshot, baseBranch: "" });
  }

  async function gitMergeBase(workspaceId, baseBranch) {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const snapshot = appStore.getGitSnapshot(workspaceId);
    if (!snapshot?.available) return;
    setPendingGitAction(workspaceId, { type: "merge", snapshot, baseBranch: baseBranch || snapshot.baseBranch });
  }

  async function gitRebaseBase(workspaceId, baseBranch) {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const snapshot = appStore.getGitSnapshot(workspaceId);
    if (!snapshot?.available) return;
    setPendingGitAction(workspaceId, { type: "rebase", snapshot, baseBranch: baseBranch || snapshot.baseBranch });
  }

  async function gitMergeIntoBase(workspaceId, baseBranch) {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const snapshot = appStore.getGitSnapshot(workspaceId);
    if (!snapshot?.available) return;
    setPendingGitAction(workspaceId, { type: "merge-into-base", snapshot, baseBranch });
  }

  async function gitRemoveWorktree(workspaceId, worktreePath, deleteBranch) {
    await runGitAction(workspaceId, "remove-worktree", () =>
      _api.gitRemoveWorktree({ workspaceId, worktreePath, deleteBranch }),
    );
  }

  async function gitCommitAll(workspaceId, message) {
    if (!message) return;
    await runGitAction(workspaceId, "commit", () => _api.gitCommitAll({ workspaceId, message }));
  }

  async function gitSelectCommit(workspaceId, hash) {
    if (!hash) return;
    const ui = ensure(workspaceId);
    ui.selectedCommit = hash;
    ui.commitDiffPreview = { ok: true, hash, diff: "", summary: "Loading..." };
    try {
      ui.commitDiffPreview = await _api.gitCommitDiff({ workspaceId, hash });
    } catch (error) {
      ui.commitDiffPreview = { ok: false, hash, diff: "", summary: error?.message || "Failed to load commit diff." };
    }
  }

  async function gitSelectDiff(workspaceId, path, scope) {
    if (!path) return;
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const snapshot = appStore.getGitSnapshot(workspaceId);
    const ui = ensure(workspaceId);
    ui.selectedDiff = { path, scope };
    ui.diffPreview = { ok: true, path, scope, diff: "", summary: "Loading diff preview..." };
    try {
      ui.diffPreview = await _api.gitDiffPreview({
        workspaceId,
        path,
        scope,
        baseBranch: snapshot?.baseBranch || snapshot?.compareWithBase?.baseBranch || "",
      });
    } catch (error) {
      ui.diffPreview = { ok: false, path, scope, diff: "", summary: error?.message || "Diff preview failed to load." };
    }
  }

  function gitSwitchTab(workspaceId, tab) {
    ensure(workspaceId).activeTab = tab;
  }

  function gitClearResult(workspaceId) {
    ensure(workspaceId).lastResult = null;
  }

  async function gitStash(workspaceId, message) {
    await runGitAction(workspaceId, "stash", () => _api.gitStash({ workspaceId, message: message || "" }));
  }

  async function gitStashPop(workspaceId) {
    await runGitAction(workspaceId, "stash-pop", () => _api.gitStashPop({ workspaceId }));
  }

  // --- Tag actions ---

  async function gitListTags(workspaceId) {
    const ui = ensure(workspaceId);
    ui.tagsLoading = true;
    try {
      const result = await _api.gitListTags({ workspaceId });
      ui.tags = result?.tags || [];
      ui.tagsError = result?.ok === false ? result.summary : "";
    } catch (error) {
      ui.tags = [];
      ui.tagsError = error?.message || "Failed to load tags.";
    } finally {
      ui.tagsLoading = false;
    }
  }

  async function gitCreateTag(workspaceId, tagName, message) {
    await runGitAction(workspaceId, "create-tag", () =>
      _api.gitCreateTag({ workspaceId, tagName, message: message || "" }),
    );
    await gitListTags(workspaceId);
  }

  async function gitDeleteTag(workspaceId, tagName) {
    await runGitAction(workspaceId, "delete-tag", () => _api.gitDeleteTag({ workspaceId, tagName }));
    await gitListTags(workspaceId);
  }

  async function gitPushTag(workspaceId, tagName) {
    await runGitAction(workspaceId, "push-tag", () => _api.gitPushTag({ workspaceId, tagName }));
    await gitListTags(workspaceId);
  }

  async function gitPushAllTags(workspaceId) {
    await runGitAction(workspaceId, "push-all-tags", () => _api.gitPushAllTags({ workspaceId }));
    await gitListTags(workspaceId);
  }

  async function gitDeleteRemoteTag(workspaceId, tagName) {
    await runGitAction(workspaceId, "delete-remote-tag", () => _api.gitDeleteRemoteTag({ workspaceId, tagName }));
    await gitListTags(workspaceId);
  }

  async function gitSetBaseBranch(workspaceId, baseBranch) {
    const ui = ensure(workspaceId);
    ui.overrideBaseBranch = baseBranch || "";
  }

  async function azureCreatePullRequest(workspaceId, { title, description, sourceBranch, targetBranch, connectionId }) {
    return runGitAction(workspaceId, "create-pr", () =>
      _api.azureCreatePullRequest({
        workspaceId,
        title,
        description,
        sourceBranch,
        targetBranch,
        connectionId,
      }),
    );
  }

  async function azureListRemoteBranches(workspaceId) {
    const ui = ensure(workspaceId);
    ui.remoteBranchesLoading = true;
    try {
      const result = await _api.azureListRemoteBranches({ workspaceId });
      ui.remoteBranches = result?.branches || [];
    } catch {
      ui.remoteBranches = [];
    } finally {
      ui.remoteBranchesLoading = false;
    }
  }

  async function openLazygit(workspaceId) {
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const nextPayload = await _api.openLazygitSession({ workspaceId });
    appStore.payload = nextPayload;
    appStore.activeViewId = `${workspaceId}:lazygit`;
  }

  // --- Azure review UI state ---
  function reviewSwitchTab(workspaceId, tab) {
    ensure(workspaceId).activeReviewTab = tab || "summary";
  }

  function reviewSetCommentFilter(workspaceId, filter) {
    ensure(workspaceId).commentFilter = filter || "all";
  }

  function reviewSetCommentSort(workspaceId, sort) {
    const state = ensure(workspaceId);
    if (state.commentSort === sort) {
      // Toggle direction when clicking the same sort
      state.commentSortDir = state.commentSortDir === "asc" ? "desc" : "asc";
    } else {
      state.commentSort = sort || "index";
      // Default direction: newest→desc, others→asc
      state.commentSortDir = sort === "newest" ? "desc" : "asc";
    }
  }

  function reviewSetCommentSearch(workspaceId, search) {
    ensure(workspaceId).commentSearch = search || "";
  }

  function reviewSetAgentSubtab(workspaceId, subtab) {
    ensure(workspaceId).agentSubTab = subtab || "prompts";
  }

  async function reviewSelectFileDiff(workspaceId, filePath, baseBranch) {
    if (!workspaceId || !filePath) return;
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    const snapshot = appStore.getGitSnapshot(workspaceId);
    const resolvedBase = baseBranch || snapshot?.baseBranch || snapshot?.compareWithBase?.baseBranch || "";
    const ui = ensure(workspaceId);
    ui.reviewSelectedFile = filePath;
    ui.reviewFileDiffPreview = { ok: true, path: filePath, diff: "", summary: "Loading diff preview..." };
    try {
      ui.reviewFileDiffPreview = await _api.gitDiffPreview({
        workspaceId,
        path: filePath,
        scope: "branch",
        baseBranch: resolvedBase.startsWith("origin/") ? resolvedBase : resolvedBase ? `origin/${resolvedBase}` : "",
      });
    } catch (error) {
      ui.reviewFileDiffPreview = {
        ok: false,
        path: filePath,
        diff: "",
        summary: error?.message || "Diff preview failed to load.",
      };
    }
  }

  return {
    // Read accessor
    get,
    cleanup,
    init,
    // Git actions
    runGitAction,
    refreshGit,
    gitFetch,
    gitPull,
    gitPush,
    gitCheckoutBranch,
    gitCreateBranch,
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
    openLazygit,
    gitStash,
    gitStashPop,
    gitSetBaseBranch,
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
  };
});

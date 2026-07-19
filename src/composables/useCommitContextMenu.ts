import { ref, type Ref } from "vue";

/**
 * Minimal commit shape the context-menu logic needs. GitBranchesTab.vue's
 * `GraphCommit` satisfies this structurally (plus extra fields the menu
 * doesn't touch).
 */
export interface CommitContextMenuCommit {
  hash: string;
  shortHash: string;
  subject: string;
  parents: string[];
}

export interface CtxMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  title?: string;
  icon?: string;
  group?: string;
}

export interface CtxMenuState {
  hash: string;
  // Full selection the menu acts on, newest first (display order).
  hashes: string[];
  shortHash: string;
  subject: string;
  x: number;
  y: number;
  items: CtxMenuItem[];
}

export interface UseCommitContextMenuOptions<TCommit extends CommitContextMenuCommit> {
  workspaceId: Ref<string>;
  commits: Ref<TCommit[]>;
  /** Current HEAD hash (gitUi.graph.head) — used to check squash eligibility. */
  head: Ref<string>;
  /** Multi-selected hashes from Ctrl/Shift-click in the graph — read to detect
   *  a multi-target right-click, and cleared after a successful squash. */
  multiSelected: Ref<string[]>;
  /** snapshot prop — read for headCommit/headHash and the current branch name. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  snapshot: Ref<Record<string, any>>;
  hasAzureConnection: Ref<boolean>;
  /** branchList.value.current — fallback for the cherry-pick confirm message. */
  currentBranch: Ref<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gitUiStore: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appStore: Record<string, any>;
  shortHashOf: (hash: string) => string;
  copyToClipboard: (text: string) => Promise<void>;
  refreshAll: (force?: boolean) => void;
  onOpenCommitDialog: (hash: string) => void;
  openCreatePullRequestDialog: () => void;
}

/**
 * Right-click menu for commit rows in GitTreeGraph: single-commit actions
 * (details, copy, cherry-pick, checkout, new branch/tag, create PR) plus a
 * multi-selection menu (cherry-pick N, squash) when the right-clicked commit
 * is part of an active Ctrl/Shift-click selection. Subset of the JetBrains
 * menu — backend-missing actions (revert, reset, rebase-from-here) are
 * deferred until those handlers exist.
 */
export function useCommitContextMenu<TCommit extends CommitContextMenuCommit>(
  options: UseCommitContextMenuOptions<TCommit>,
) {
  const {
    workspaceId,
    commits,
    head,
    multiSelected,
    snapshot,
    hasAzureConnection,
    currentBranch,
    gitUiStore,
    appStore,
    shortHashOf,
    copyToClipboard,
    refreshAll,
    onOpenCommitDialog,
    openCreatePullRequestDialog,
  } = options;

  const ctxMenu = ref<CtxMenuState | null>(null);

  // Compose the menu per-row so context-sensitive items (Create PR) only show
  // when they make sense for THAT commit. PR creation needs:
  //  - an Azure connection mapped to this repo's remote
  //  - this commit to be the tip of the local branch (so push/PR has a defined
  //    source branch). Right-clicking an internal commit would force us to
  //    invent a branch — JetBrains punts on this case the same way.
  function buildMenuItemsFor(entry: TCommit): CtxMenuItem[] {
    const headHash = String(snapshot.value?.headCommit || snapshot.value?.headHash || "");
    const isHeadCommit = !!headHash && headHash === entry.hash;
    const isMerge = (entry.parents || []).length >= 2;
    const items: CtxMenuItem[] = [
      {
        id: "details",
        label: "Show commit details…",
        icon: "🔎",
        group: "inspect",
        title: "Open the full commit: message, author, and the files it changed.",
      },
      {
        id: "copyHash",
        label: "Copy commit hash",
        icon: "⧉",
        group: "copy",
        title: "Copy the full 40-character commit SHA to the clipboard.",
      },
      {
        id: "copyShort",
        label: "Copy short hash",
        icon: "⧉",
        group: "copy",
        title: "Copy the abbreviated commit SHA to the clipboard.",
      },
      {
        id: "copySubject",
        label: "Copy subject",
        icon: "⧉",
        group: "copy",
        title: "Copy the commit's subject line (first line of the message).",
      },
      {
        id: "cherryPick",
        label: "Cherry-pick this commit…",
        icon: "🍒",
        group: "apply",
        disabled: isMerge,
        title: isMerge ? "Cherry-pick of a merge commit is not supported." : "Apply this commit onto the current branch.",
      },
      {
        id: "checkout",
        label: "Checkout this commit",
        icon: "↪",
        group: "apply",
        title: "Check out this commit as a detached HEAD to inspect or build from it.",
      },
      {
        id: "newBranch",
        label: "New branch from here…",
        icon: "⎇",
        group: "create",
        title: "Create a new branch starting at this commit.",
      },
      {
        id: "newTag",
        label: "New tag here…",
        icon: "🏷",
        group: "create",
        title: "Create a tag pointing at this commit.",
      },
    ];
    if (hasAzureConnection.value && isHeadCommit) {
      items.push({
        id: "createPr",
        label: "Create pull request from this branch…",
        icon: "⤴",
        group: "create",
        title: "Push this branch and open a pull request from its tip.",
      });
    }
    return items;
  }

  // Multi-selection menu (Ctrl/Shift+click → right-click inside the selection).
  // Squash mirrors JetBrains: the item is visible but greyed out with a reason
  // when the selection can't be squashed.
  function buildMultiMenuItems(selection: TCommit[]): CtxMenuItem[] {
    const n = selection.length;
    const mergeCount = selection.filter((c) => (c.parents || []).length >= 2).length;
    const squash = squashEligibility(selection);
    return [
      {
        id: "cherryPick",
        label: `Cherry-pick ${n} commits…`,
        icon: "🍒",
        group: "apply",
        disabled: mergeCount > 0,
        title:
          mergeCount > 0
            ? "Selection contains merge commits — cherry-pick supports only non-merge commits."
            : `Apply the ${n} selected commits onto the current branch, oldest first.`,
      },
      {
        id: "squash",
        label: `Squash ${n} commits into one…`,
        icon: "🗜",
        group: "apply",
        disabled: !squash.ok,
        title: squash.ok ? "Combine the selected commits into a single commit." : squash.reason,
      },
    ];
  }

  // "Technically possible" check for squash, computed from the loaded graph.
  // The backend re-validates everything; this only drives the disabled state
  // so the menu can explain WHY a selection can't be squashed.
  function squashEligibility(selection: TCommit[]): { ok: boolean; reason: string } {
    if (selection.length < 2) return { ok: false, reason: "Select at least two commits to squash." };
    if (selection.some((c) => (c.parents || []).length >= 2)) {
      return { ok: false, reason: "Selection contains a merge commit." };
    }
    if (selection.some((c) => (c.parents || []).length === 0)) {
      return { ok: false, reason: "Selection contains the root commit." };
    }
    for (let i = 0; i < selection.length - 1; i++) {
      if (selection[i].parents?.[0] !== selection[i + 1].hash) {
        return { ok: false, reason: "Selected commits are not a contiguous range." };
      }
    }
    // The selection must sit on the current branch with no merge commits
    // between it and HEAD — rewriting below a merge would flatten the merge.
    const headHash = head.value;
    const byHash = new Map(commits.value.map((c) => [c.hash, c]));
    let cursor = byHash.get(headHash);
    if (!cursor) return { ok: false, reason: "Selected commits are not on the checked-out branch." };
    const newest = selection[0].hash;
    for (let steps = 0; cursor && steps <= commits.value.length; steps++) {
      if (cursor.hash === newest) return { ok: true, reason: "" };
      if ((cursor.parents || []).length >= 2) {
        return { ok: false, reason: "There are merge commits between the selection and HEAD." };
      }
      cursor = byHash.get(cursor.parents?.[0] || "");
    }
    return { ok: false, reason: "Selected commits are not on the checked-out branch." };
  }

  // Current multi-selection resolved to commit entries, newest first.
  function orderedSelection(hashes: string[]): TCommit[] {
    const wanted = new Set(hashes);
    return commits.value.filter((c) => wanted.has(c.hash));
  }

  function onCommitContextMenu(payload: { hash: string; x: number; y: number }): void {
    const entry = commits.value.find((c) => c.hash === payload.hash);
    if (!entry) return;
    const isMultiTarget = multiSelected.value.length > 1 && multiSelected.value.includes(payload.hash);
    if (isMultiTarget) {
      const selection = orderedSelection(multiSelected.value);
      ctxMenu.value = {
        hash: entry.hash,
        hashes: selection.map((c) => c.hash),
        shortHash: `${selection.length} commits`,
        subject: "",
        x: payload.x,
        y: payload.y,
        items: buildMultiMenuItems(selection),
      };
      return;
    }
    ctxMenu.value = {
      hash: entry.hash,
      hashes: [entry.hash],
      shortHash: entry.shortHash || shortHashOf(entry.hash),
      subject: entry.subject || "",
      x: payload.x,
      y: payload.y,
      items: buildMenuItemsFor(entry),
    };
  }

  async function onMenuPick(id: string): Promise<void> {
    const menu = ctxMenu.value;
    if (!menu) return;
    const entry = commits.value.find((c) => c.hash === menu.hash) || null;
    ctxMenu.value = null;
    if (!entry) return;
    switch (id) {
      case "details":
        onOpenCommitDialog(entry.hash);
        return;
      case "copyHash":
        await copyToClipboard(entry.hash);
        return;
      case "copyShort":
        await copyToClipboard(entry.shortHash || shortHashOf(entry.hash));
        return;
      case "copySubject":
        await copyToClipboard(entry.subject || "");
        return;
      case "cherryPick": {
        const hashes = menu.hashes?.length ? menu.hashes : [entry.hash];
        const n = hashes.length;
        const currentBranchName = String(snapshot.value?.branch || currentBranch.value || "the current branch");
        const what = n > 1 ? `${n} commits (oldest first)` : `commit ${entry.shortHash || shortHashOf(entry.hash)}`;
        appStore.openDialog("ConfirmDialog", {
          eyebrow: "Git",
          title: n > 1 ? `Cherry-pick ${n} commits?` : "Cherry-pick commit?",
          message: `Apply ${what} onto '${currentBranchName}'? Conflicts will pause the operation for manual resolution.`,
          confirmLabel: "Cherry-pick",
          onCancel: () => appStore.closeDialog(),
          onConfirm: async () => {
            appStore.closeDialog();
            await gitUiStore.gitCherryPick(workspaceId.value, hashes);
            refreshAll(true);
          },
        });
        return;
      }
      case "squash": {
        const hashes = menu.hashes || [];
        if (hashes.length < 2) return;
        const selection = orderedSelection(hashes);
        // Prefill with all subjects, oldest first — same as JetBrains' squash dialog.
        const prefill = [...selection]
          .reverse()
          .map((c) => c.subject || "")
          .filter(Boolean)
          .join("\n\n");
        appStore.openDialog("TextAreaDialog", {
          eyebrow: "Git",
          title: `Squash ${hashes.length} commits into one`,
          label: "Commit message for the squashed commit",
          value: prefill,
          submitLabel: "Squash",
          onCancel: () => appStore.closeDialog(),
          onSubmit: async (message: string) => {
            appStore.closeDialog();
            const trimmed = message.trim();
            if (!trimmed) return;
            await gitUiStore.gitSquashCommits(workspaceId.value, hashes, trimmed);
            multiSelected.value = [];
            refreshAll(true);
          },
        });
        return;
      }
      case "checkout":
        appStore.openDialog("ConfirmDialog", {
          eyebrow: "Git",
          title: "Checkout commit?",
          message: `Switch HEAD to ${entry.shortHash || shortHashOf(entry.hash)}? You'll be in detached-HEAD state until you check out a branch.`,
          confirmLabel: "Checkout",
          onCancel: () => appStore.closeDialog(),
          onConfirm: async () => {
            appStore.closeDialog();
            await gitUiStore.gitCheckoutBranch(workspaceId.value, entry.hash);
            refreshAll(true);
          },
        });
        return;
      case "newBranch":
        appStore.openDialog("TextInputDialog", {
          eyebrow: "Git",
          title: `New branch at ${entry.shortHash || shortHashOf(entry.hash)}`,
          label: "Branch name",
          value: "",
          placeholder: "feature/my-branch",
          submitLabel: "Create",
          onCancel: () => appStore.closeDialog(),
          onSubmit: async (name: string) => {
            appStore.closeDialog();
            const trimmed = name.trim();
            if (!trimmed) return;
            await gitUiStore.gitCreateBranch(workspaceId.value, trimmed, entry.hash);
            refreshAll(true);
          },
        });
        return;
      case "newTag":
        appStore.openDialog("TextInputDialog", {
          eyebrow: "Git",
          title: `New tag at ${entry.shortHash || shortHashOf(entry.hash)}`,
          label: "Tag name",
          value: "",
          placeholder: "v1.0.0",
          submitLabel: "Create",
          onCancel: () => appStore.closeDialog(),
          onSubmit: async (name: string) => {
            appStore.closeDialog();
            const trimmed = name.trim();
            if (!trimmed) return;
            await gitUiStore.gitCreateTag(workspaceId.value, trimmed, "", entry.hash);
            refreshAll(true);
          },
        });
        return;
      case "createPr":
        openCreatePullRequestDialog();
        return;
    }
  }

  return { ctxMenu, onCommitContextMenu, onMenuPick };
}

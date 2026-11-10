// Branch actions that need a dialog before they run (delete, delete on remote,
// rename, new branch from a ref). Shared by the Git tab's branch tree and the
// branch menu on the workspace header, so both ask the same questions.
import { useAppStore } from "../../../stores/app.js";
import { useGitUiStore } from "../../../stores/git-ui.js";

export interface DeletableLocalBranch {
  name: string;
  merged: boolean;
  worktreePath?: string;
}

export function useBranchActions(workspaceId: () => string, afterChange: () => void | Promise<void>) {
  const appStore = useAppStore();
  const gitUiStore = useGitUiStore();

  function deleteLocal(entry: DeletableLocalBranch): void {
    // A branch checked out in a worktree can't be deleted via `git branch -d`.
    // Route through the worktree-aware confirm so the user can wipe the
    // worktree directory and the branch ref in one step.
    if (entry.worktreePath) {
      gitUiStore.confirmRemoveWorktreeDeleteBranch(workspaceId(), {
        worktreePath: entry.worktreePath,
        branch: entry.name,
        branchMerged: entry.merged,
      });
      return;
    }
    const force = !entry.merged;
    const verb = force ? "Force delete" : "Delete";
    appStore.openDialog("ConfirmDialog", {
      eyebrow: "Git",
      title: `${verb} branch?`,
      message: force
        ? `Branch '${entry.name}' has unmerged commits — they will be lost.`
        : `Branch '${entry.name}' will be removed.`,
      confirmLabel: verb,
      danger: true,
      onCancel: () => appStore.closeDialog(),
      onConfirm: async () => {
        appStore.closeDialog();
        await gitUiStore.gitDeleteBranch(workspaceId(), entry.name, force);
        await afterChange();
      },
    });
  }

  function deleteRemote(remoteRef: string): void {
    const slash = remoteRef.indexOf("/");
    const remoteName = slash >= 0 ? remoteRef.slice(0, slash) : "origin";
    const shortName = slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
    appStore.openDialog("ConfirmDialog", {
      eyebrow: "Git",
      title: "Delete remote branch?",
      message: `Branch '${shortName}' on remote '${remoteName}' will be deleted via git push ${remoteName} :${shortName}. This cannot be undone server-side.`,
      confirmLabel: "Delete",
      danger: true,
      onCancel: () => appStore.closeDialog(),
      onConfirm: async () => {
        appStore.closeDialog();
        await gitUiStore.gitDeleteRemoteBranch(workspaceId(), shortName, remoteName);
        await afterChange();
      },
    });
  }

  function rename(ref: string): void {
    appStore.openDialog("TextInputDialog", {
      eyebrow: "Git",
      title: `Rename branch '${ref}'`,
      label: "New name",
      value: ref,
      placeholder: "feature/my-branch",
      submitLabel: "Rename",
      onCancel: () => appStore.closeDialog(),
      onSubmit: async (next: string) => {
        appStore.closeDialog();
        const trimmed = next.trim();
        if (!trimmed || trimmed === ref) return;
        await gitUiStore.gitRenameBranch(workspaceId(), ref, trimmed);
        await afterChange();
      },
    });
  }

  /** Create a branch and check it out. An empty `startPoint` starts it at HEAD. */
  function newBranchFrom(startPoint: string): void {
    appStore.openDialog("TextInputDialog", {
      eyebrow: "Git",
      title: startPoint ? `New branch from '${startPoint}'` : "New branch",
      label: "Branch name",
      placeholder: "feature/my-branch",
      submitLabel: "Create",
      onCancel: () => appStore.closeDialog(),
      onSubmit: async (name: string) => {
        appStore.closeDialog();
        const trimmed = name.trim();
        if (!trimmed) return;
        await gitUiStore.gitCreateBranch(workspaceId(), trimmed, startPoint);
        await afterChange();
      },
    });
  }

  return { deleteLocal, deleteRemote, rename, newBranchFrom };
}

import type { WorkspaceState } from "../shared/types/state.js";

function profileId(workspace: WorkspaceState): string {
  return workspace.profileId || "default";
}

function explicitParentId(workspace: WorkspaceState): string {
  if (workspace.review?.checkout?.mode === "managed-worktree") {
    return workspace.review.parentWorkspaceId || "";
  }
  return workspace.quickfix?.parentWorkspaceId || workspace.task?.parentWorkspaceId || "";
}

function resolveParentId(workspace: WorkspaceState, workspaces: WorkspaceState[]): string {
  const explicit = explicitParentId(workspace);
  if (explicit) return explicit;
  if (!(workspace.notes || "").startsWith("Worktree of ")) return "";

  const marker = `${workspace.name.split(" / ")[0]}`;
  const ownerProfileId = profileId(workspace);
  const normalizedCwd = (workspace.cwd || "").replace(/\\/g, "/");
  const treeMarker = "/.strideterm/tree/";
  const treeIndex = normalizedCwd.lastIndexOf(treeMarker);
  const parentCwd = treeIndex >= 0 ? normalizedCwd.slice(0, treeIndex).replace(/\/+$/, "") : "";

  const candidates = workspaces.filter(
    (candidate) =>
      candidate.id !== workspace.id &&
      profileId(candidate) === ownerProfileId &&
      !explicitParentId(candidate) &&
      !(candidate.notes || "").startsWith("Worktree of "),
  );
  return (
    candidates.find((candidate) => {
      const roots = [candidate.cwd, ...(candidate.gitRoots || [])]
        .filter(Boolean)
        .map((root) => String(root).replace(/\\/g, "/").replace(/\/+$/, ""));
      return parentCwd && roots.includes(parentCwd);
    })?.id ||
    candidates.find((candidate) => candidate.name === marker)?.id ||
    ""
  );
}

function isDescendantOf(workspace: WorkspaceState, ancestorId: string, workspaces: WorkspaceState[]): boolean {
  const byId = new Map(workspaces.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  let parentId = resolveParentId(workspace, workspaces);
  while (parentId && !seen.has(parentId)) {
    if (parentId === ancestorId) return true;
    seen.add(parentId);
    const parent = byId.get(parentId);
    parentId = parent ? resolveParentId(parent, workspaces) : "";
  }
  return false;
}

function rootWorkspaceId(workspace: WorkspaceState, workspaces: WorkspaceState[]): string {
  const byId = new Map(workspaces.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  let current = workspace;
  let parentId = resolveParentId(current, workspaces);
  while (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent || profileId(parent) !== profileId(workspace)) break;
    seen.add(parentId);
    current = parent;
    parentId = resolveParentId(current, workspaces);
  }
  return current.id;
}

export function insertWorkspace(workspaces: WorkspaceState[], workspace: WorkspaceState, activeWorkspaceId = ""): void {
  const ownerProfileId = profileId(workspace);
  const parentId = resolveParentId(workspace, workspaces);
  const parentIndex = parentId
    ? workspaces.findIndex((candidate) => candidate.id === parentId && profileId(candidate) === ownerProfileId)
    : -1;
  if (parentIndex >= 0) {
    workspaces.splice(parentIndex + 1, 0, workspace);
    return;
  }

  const activeWorkspace = activeWorkspaceId
    ? workspaces.find((candidate) => candidate.id === activeWorkspaceId && profileId(candidate) === ownerProfileId)
    : null;
  if (activeWorkspace) {
    const rootId = rootWorkspaceId(activeWorkspace, workspaces);
    const rootIndex = workspaces.findIndex((candidate) => candidate.id === rootId);
    let insertAt = rootIndex + 1;
    while (
      insertAt < workspaces.length &&
      profileId(workspaces[insertAt]) === ownerProfileId &&
      isDescendantOf(workspaces[insertAt], rootId, workspaces)
    ) {
      insertAt++;
    }
    workspaces.splice(insertAt, 0, workspace);
    return;
  }

  const firstProfileIndex = workspaces.findIndex((candidate) => profileId(candidate) === ownerProfileId);
  workspaces.splice(firstProfileIndex >= 0 ? firstProfileIndex : workspaces.length, 0, workspace);
}

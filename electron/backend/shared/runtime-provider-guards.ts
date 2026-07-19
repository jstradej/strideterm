import type { WorkspaceState } from "../../shared/types/state.js";

/**
 * Cross-provider runtime-handler helpers shared identically by the Azure
 * DevOps and GitHub handler factories (and, for `resolveRootPath`, the plain
 * git handlers). Extracted to kill duplicated copies — see
 * review-code-quality-2026-07.md §3.1 ("Azure ↔ GitHub provider parallelism",
 * layer 5).
 */

/**
 * Resolve a workspace-relative root path, validating it against the
 * workspace's known git roots. Throws when a non-empty `rawRootPath` was
 * supplied but does not resolve to a known root — protects against a caller
 * passing a stale/foreign path.
 */
export function resolveRootPath(
  resolveGitRootPath: (workspace: WorkspaceState, rawRootPath: string) => string | null,
  workspace: WorkspaceState,
  rawRootPath: string,
): string {
  const resolved = resolveGitRootPath(workspace, rawRootPath || "");
  if (rawRootPath && !resolved) {
    throw new Error(`Root path not found in workspace gitRoots: ${rawRootPath}`);
  }
  return resolved || "";
}

/**
 * Refuse a per-PR mutation (comment / thread-status / vote / mark-seen /
 * rerun-check / review) when the PR does not belong to the calling VIEWER's
 * profile. Without this, a remote client bound to profile B could act on a
 * profile-A PR that it can see in the global snapshot merely because the
 * desktop payload carries every profile's PRs. Desktop IPC passes no viewer
 * id (`getViewerProfileId` → null) and is unaffected; the guard runs before
 * any external side effect.
 *
 * `snapshotKey` selects which provider's slice of the payload to check
 * (`"azureDevops"` or `"github"`) — the only thing that varied between the
 * two providers' original copies of this guard.
 */
export function assertPrInViewerProfile(
  deps: {
    getPayload: () => unknown;
    getViewerProfileId: (viewerId?: string) => string | null;
  },
  snapshotKey: string,
  prKey: string,
  windowId?: string,
): void {
  const callerProfileId = deps.getViewerProfileId(windowId);
  if (!callerProfileId) return;
  const snapshot = (deps.getPayload() as Record<string, { pullRequests?: Record<string, { profileId?: string }> }>)?.[
    snapshotKey
  ];
  const pr = snapshot?.pullRequests?.[prKey];
  if (pr && String(pr.profileId || "default") !== callerProfileId) {
    throw new Error(`Cross-profile refused: pull request ${prKey} is not in profile ${callerProfileId}.`);
  }
}

/**
 * Mirror a just-activated workspace into the calling window's slot — but
 * ONLY when the workspace's profile matches the slot's profile. The review's
 * profile is decided by the connection it was opened against (see
 * openReviewWorkspace / openQuickFixWorkspace), so a remote client bound to
 * profile B that opens a profile-A PR must not have a profile-A workspace
 * silently swapped into its own (profile-B) slot — the frontend selector
 * prefers `slot.activeWorkspaceId`, so without this guard the user in
 * window/profile B would jump straight into profile A's review.
 *
 * Returns `null` when there is no windowId or no matching slot (nothing to
 * do — remote-viewer activation is handled separately by the caller via
 * `mirrorRemoteViewerWorkspace`). Otherwise returns whether the mirror
 * happened plus the two profile ids, so the caller can log a skip with its
 * own operation-specific message — this helper takes no logger dependency.
 *
 * `draft` is typed structurally (just the slot fields this function reads
 * and writes) rather than the full `WindowSlot` so callers can pass an
 * immer Draft<AppState> or a synthetic test shape without a cast.
 */
export function mirrorActivationIntoSlot(
  draft: { windowSlots?: Array<{ id: string; profileId: string; activeWorkspaceId: string }> },
  windowId: string | undefined,
  normalized: { id: string; profileId?: string },
): { mirrored: boolean; slotProfileId: string; workspaceProfileId: string } | null {
  if (!windowId) return null;
  const slot = (draft.windowSlots || []).find((s) => s.id === windowId);
  if (!slot) return null;
  const workspaceProfileId = normalized.profileId || "default";
  if (workspaceProfileId === slot.profileId) {
    slot.activeWorkspaceId = normalized.id;
    return { mirrored: true, slotProfileId: slot.profileId, workspaceProfileId };
  }
  return { mirrored: false, slotProfileId: slot.profileId, workspaceProfileId };
}

/**
 * Refuse to push a review workspace whose worktree has uncommitted changes —
 * pushing over them would silently discard the reviewer's in-progress edits
 * (the managed worktree has no stash of its own). Identical guard used by
 * both providers' `push*ReviewWorkspace` handlers right before the actual
 * push call.
 */
export async function assertWorktreeCleanForPush(
  git: { getCachedWorktreeDirtyState: (cwd: string) => Promise<{ dirty: boolean; dirtyCount: number }> },
  workspace: { cwd: string },
): Promise<void> {
  const dirtyState = await git.getCachedWorktreeDirtyState(workspace.cwd);
  if (dirtyState.dirty) {
    throw new Error(
      `Cannot push: ${dirtyState.dirtyCount} uncommitted change${dirtyState.dirtyCount !== 1 ? "s" : ""} in the worktree. ` +
        "Commit your changes first, then try again.",
    );
  }
}

/**
 * Filter a provider's full connection list down to connections owned by a
 * profile that is currently open in some window. Filtering by only
 * `windowSlots[0]` hid a connection the user just saved while working in a
 * non-primary window (e.g. saving on profile "asdf" while windowSlots[0] is
 * "default" left every window's snapshot reporting "no connections yet"
 * even though the connection had persisted to disk). Returns all
 * connections unfiltered when there are no open window slots at all.
 */
export function filterConnectionsByOpenProfiles<T extends { profileId?: string }>(
  connections: T[],
  windowSlots: Array<{ profileId?: string }> | undefined,
): T[] {
  const openProfileIds = new Set((windowSlots || []).map((s) => String(s?.profileId || "default")));
  if (openProfileIds.size === 0) return connections;
  return connections.filter((c) => openProfileIds.has(String(c.profileId || "default")));
}

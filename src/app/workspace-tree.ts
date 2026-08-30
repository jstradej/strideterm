/**
 * Workspace hierarchy utilities — parent resolution, ancestry and canonical
 * ordering.
 *
 * These used to live inside `workspace-sidebar-projection.ts`, the module that
 * owned the time-bucketed recent view, even though the star filter, the search
 * filter and other selectors already imported `resolveParentId` from it. The
 * hierarchy is a separate concern from any one projection of it, so it lives
 * here: one definition of "who is this workspace's parent", one cycle guard,
 * one tie-break, used by every consumer (V2 plan, Fáze 4).
 *
 * Dependency-free by design (no store, no Vue, no clock) so it can be unit
 * tested directly and reused from any selector.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WsLike = any;

/**
 * The subset of a workspace this module reads. Structurally typed (no index
 * signature) so a full `WorkspaceState` satisfies it directly.
 */
export interface WorkspaceTreeNode {
  id: string;
  name?: string;
  icon?: string;
  profileId?: string;
  notes?: string;
}

/**
 * Resolve the explicit parent workspace id of a review/quickfix/task child,
 * falling back to the legacy "Worktree of X" name-based link for worktrees
 * created before that metadata existed.
 *
 * `allWs` MUST already be scoped to a single profile — a missing, cyclical or
 * cross-profile parent simply resolves to no match, since a foreign-profile
 * workspace is never present in `allWs`.
 */
export function resolveParentId(ws: WsLike, allWs: WsLike[]): string | null {
  if (ws.review?.checkout?.mode === "managed-worktree" && ws.review?.parentWorkspaceId) {
    return ws.review.parentWorkspaceId;
  }
  if (ws.quickfix?.parentWorkspaceId) return ws.quickfix.parentWorkspaceId;
  if (ws.task?.parentWorkspaceId) return ws.task.parentWorkspaceId;
  if ((ws.notes || "").startsWith("Worktree of ")) {
    const parentName = String(ws.name || "").split(" / ")[0];
    const wsProfile = ws.profileId || "default";
    const parent =
      allWs.find((c) => c.name === parentName && c.id !== ws.id && (c.profileId || "default") === wsProfile) ||
      allWs.find((c) => c.name === parentName && c.id !== ws.id);
    return parent?.id || null;
  }
  return null;
}

/**
 * One workspace named with enough IDENTITY to be DRAWN the way the canonical
 * tree draws it — not just named.
 *
 * A flat `string[]` of ancestor names was enough for an inline breadcrumb but
 * not for a row that wears its own icon badge and accent colour. Both the
 * recent shortcuts and the RUNNING surface resolve their hierarchy through
 * this one shape, so the two sections cannot disagree about what a parent
 * looks like (V5 review, §"3. RUNNING použije stejnou activity-tree
 * projekci"). Derived per render from the profile's workspace model — nothing
 * here is persisted.
 */
export interface WorkspaceAncestorIdentity {
  id: string;
  name: string;
  icon: string;
  color: string;
  kind: string;
}

/**
 * Identity of every ancestor of `workspaceId`, ROOT FIRST. Empty for a root
 * workspace. `workspaces` must be the same list the index was built from, so
 * the chain and its identities come from one set of cycle / missing-parent /
 * cross-profile guards.
 */
export function ancestorIdentities(
  tree: WorkspaceTreeIndex,
  workspaces: readonly WorkspaceTreeNode[],
  workspaceId: string,
): WorkspaceAncestorIdentity[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace as WsLike]));
  return tree.ancestorsOf(workspaceId).map((ancestorId) => {
    const ancestor = byId.get(ancestorId);
    return {
      id: ancestorId,
      name: ancestor?.name || ancestorId,
      icon: ancestor?.icon || "",
      color: ancestor?.color || "",
      kind: ancestor?.kind || "",
    };
  });
}

export interface WorkspaceTreeIndex {
  /** Validated parent id, or null for a root / missing / cyclical / foreign parent. */
  parentOf(workspaceId: string): string | null;
  /** Ancestor ids, ROOT FIRST. Empty for a root workspace. */
  ancestorsOf(workspaceId: string): string[];
  /** Distance from the root. 0 for a root workspace. */
  depthOf(workspaceId: string): number;
  /** Position in the caller's canonical (manual) workspace order; -1 if unknown. */
  indexOf(workspaceId: string): number;
  /** Deterministic tie-break: canonical order first, then id. */
  compare(a: string, b: string): number;
}

/**
 * Index the hierarchy of one profile's workspaces.
 *
 * `workspaces` is the caller's canonical, manually ordered list — its order IS
 * the tie-break, so the same input always produces the same output.
 *
 * A parent link is honoured only when the parent
 *   - exists in this list (so a deleted or foreign-profile parent is a root),
 *   - is not the workspace itself,
 *   - is in the same profile, and
 *   - does not reach back to the child through its own ancestors (a cycle).
 *
 * Everything is memoised per index instance; build one per render pass.
 */
export function buildWorkspaceTree(workspaces: readonly WorkspaceTreeNode[]): WorkspaceTreeIndex {
  const list = workspaces || [];
  const byId = new Map<string, WsLike>(list.map((ws) => [ws.id, ws as WsLike]));
  const indexById = new Map<string, number>(list.map((ws, i) => [ws.id, i]));

  const rawParent = new Map<string, string | null>();
  function rawParentOf(id: string): string | null {
    const cached = rawParent.get(id);
    if (cached !== undefined) return cached;
    const ws = byId.get(id);
    let parentId: string | null = null;
    if (ws) {
      const candidate = resolveParentId(ws, list as WsLike[]);
      const parent = candidate ? byId.get(candidate) : null;
      // Same-profile only. `list` is normally pre-scoped to one profile, but a
      // caller that passes a wider list must not get a breadcrumb that leaks a
      // workspace name from another profile.
      if (parent && candidate !== id && (parent.profileId || "default") === (ws.profileId || "default")) {
        parentId = candidate;
      }
    }
    rawParent.set(id, parentId);
    return parentId;
  }

  // Cycle-safe parent: a link that can walk back to the child is dropped, so
  // the child becomes a root rather than making every ancestry walk diverge.
  const safeParent = new Map<string, string | null>();
  function parentOf(id: string): string | null {
    const cached = safeParent.get(id);
    if (cached !== undefined) return cached;
    const parentId = rawParentOf(id);
    let resolved: string | null = parentId;
    if (parentId) {
      const seen = new Set<string>([id]);
      let cursor: string | null = parentId;
      while (cursor) {
        if (seen.has(cursor)) {
          resolved = null;
          break;
        }
        seen.add(cursor);
        cursor = rawParentOf(cursor);
      }
    }
    safeParent.set(id, resolved);
    return resolved;
  }

  const ancestorsCache = new Map<string, string[]>();
  function ancestorsOf(id: string): string[] {
    const cached = ancestorsCache.get(id);
    if (cached) return cached;
    const chain: string[] = [];
    const seen = new Set<string>([id]);
    let cursor = parentOf(id);
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      cursor = parentOf(cursor);
    }
    chain.reverse(); // root first
    ancestorsCache.set(id, chain);
    return chain;
  }

  return {
    parentOf,
    ancestorsOf,
    depthOf(id: string): number {
      return ancestorsOf(id).length;
    },
    indexOf(id: string): number {
      return indexById.get(id) ?? -1;
    },
    compare(a: string, b: string): number {
      const ia = indexById.get(a) ?? Number.MAX_SAFE_INTEGER;
      const ib = indexById.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return a < b ? -1 : a > b ? 1 : 0;
    },
  };
}

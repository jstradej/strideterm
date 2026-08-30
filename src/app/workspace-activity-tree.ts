import { buildWorkspaceTree, type WorkspaceTreeNode } from "./workspace-tree.js";
import type { WorkspaceStatusCue } from "./workspace-status.js";

/**
 * The MINIMAL ACTIVITY FOREST — the one hierarchy projection behind both
 * dynamic sidebar surfaces, RUNNING and RECENTLY WORKED.
 *
 * V4 drew one closed box-in-box block per recent result. That fixed the
 * original bug (a nested result optically attaching itself to whatever
 * unrelated workspace happened to sit above it in a time-ordered list), but it
 * has a mirror image: when a PARENT and its CHILD are both recent, two
 * independent blocks repeat the same branch, and `Azure DevOps › mhub PR
 * #30746` shows up twice, reading as two different activities (V5 review,
 * §"P1 UX — per-result ancestry přímo vytváří duplicitní Azure větev").
 *
 * The fix is not a border tweak — the DATA contract has to change. The order
 * of operations is the whole design:
 *
 *   1. the caller picks at most N genuinely recent / running workspaces,
 *      globally ordered by their own metric;
 *   2. only THEN is the ancestor closure added, from the canonical
 *      profile-scoped tree;
 *   3. connected members are merged into minimal clusters;
 *   4. every workspace is drawn exactly once inside its cluster.
 *
 * So the limit still counts real activities, never the context rows added for
 * orientation, and a shared branch is drawn once no matter how many of its
 * members are active.
 *
 * Two node roles fall out of that:
 *
 *   - an ACTIVITY node was selected. It is a full row with its own metric
 *     (a timestamp, or a task state and elapsed).
 *   - a CONTEXT node was not selected but is needed to see where the activity
 *     lives. It is compact and carries no metric, because it has none — a
 *     parent that has not been worked in must not wear a recent time.
 *
 * An ancestor that is ITSELF selected is one activity node, never an activity
 * node plus a context copy of itself.
 *
 * Ordering deliberately abandons a strict global interleave of every row:
 * clusters sort by the newest activity anywhere in them, and inside a cluster
 * hierarchy wins (parent before child, sibling branches by their own newest
 * activity, then the canonical tie-break). Time stays visible on every
 * activity row; branch coherence is worth more than absolute flat order.
 *
 * Pure and dependency-free (no store, no Vue, no clock) — the metric is an
 * explicit input, so the same input always produces the same forest.
 */

export type ActivityNodeRole = "activity" | "context";

/** One workspace the caller selected as active, with the recency that ranked it. */
export interface ActivitySelection<T> {
  /**
   * Row identity — the Vue key and the interaction lock's freeze key. The
   * workspace id for a recent shortcut; the agent SESSION key for a running
   * agent, so two agents in one workspace stay two rows.
   */
  key: string;
  /** Where this activity lives in the tree. */
  workspaceId: string;
  /** Higher is newer. Ranks clusters, sibling branches and co-located rows. */
  metric: number;
  /** The caller's own row model, passed through untouched. */
  payload: T;
}

export interface ActivityNode<T> {
  /** Unique within the forest: the selection key, or the context chain's ids. */
  key: string;
  role: ActivityNodeRole;
  /**
   * The workspace this row navigates to. For a COMPRESSED context row that is
   * the LAST link of the chain — the nearest parent of the activity below it,
   * which is what the user means when they click the breadcrumb.
   */
  workspaceId: string;
  /** Identity of `workspaceId`, so the row can be drawn like its tree card. */
  name: string;
  icon: string;
  color: string;
  kind: string;
  /** Indentation INSIDE the cluster; 0 for the cluster's own first row. */
  depth: number;
  /**
   * Every workspace this single row stands for, root first. One entry for an
   * ordinary row; more only for a compressed context chain.
   */
  path: string[];
  /** Ids matching `path`, in the same order. */
  pathIds: string[];
  /**
   * The COMPLETE chain of names from the cluster's root down to this row's
   * target, root first. `path` is what the row can show; this is what it is
   * announced by, so two workspaces that happen to share a name are still
   * told apart by assistive technology and by the tooltip.
   */
  fullPath: string[];
  /** The caller's row model. Present on activity nodes only. */
  payload?: T;
}

export interface ActivityCluster<T> {
  /** The cluster's root workspace id — stable while the branch exists. */
  key: string;
  /** Newest metric anywhere in the cluster; the inter-cluster sort key. */
  metric: number;
  /** Pre-order: a parent always precedes its children. */
  nodes: ActivityNode<T>[];
}

/**
 * Build the forest.
 *
 * `selected` is already limited and ordered by the caller — this function
 * never drops an activity and never adds one. `workspaces` is the canonical,
 * profile-scoped list, and is the ONLY source of ancestry, so a missing,
 * cyclical or foreign-profile parent simply ends the chain (the guards live in
 * `buildWorkspaceTree`, shared with ALL WORKSPACES).
 */
export function buildActivityForest<T>({
  selected,
  workspaces,
}: {
  selected: readonly ActivitySelection<T>[];
  workspaces: readonly WorkspaceTreeNode[];
}): ActivityCluster<T>[] {
  const list = workspaces || [];
  const tree = buildWorkspaceTree(list);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byId = new Map<string, any>(list.map((workspace) => [workspace.id, workspace]));

  // Selections for a workspace that no longer exists have no place in the
  // tree; the caller's own live/frozen projection decides what to do with a
  // vanished workspace, this projection just cannot hang one anywhere.
  const selectionsById = new Map<string, ActivitySelection<T>[]>();
  for (const selection of selected) {
    if (!byId.has(selection.workspaceId)) continue;
    const bucket = selectionsById.get(selection.workspaceId);
    if (bucket) bucket.push(selection);
    else selectionsById.set(selection.workspaceId, [selection]);
  }

  // Ancestor closure — added AFTER the selection, so the caller's limit was
  // spent entirely on real activities.
  const closure = new Set<string>();
  for (const workspaceId of selectionsById.keys()) {
    closure.add(workspaceId);
    for (const ancestorId of tree.ancestorsOf(workspaceId)) closure.add(ancestorId);
  }

  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of closure) {
    const parentId = tree.parentOf(id);
    // `ancestorsOf` put the WHOLE chain in the closure, so a parent is absent
    // only when there genuinely is none.
    if (parentId && closure.has(parentId)) {
      const siblings = childrenOf.get(parentId);
      if (siblings) siblings.push(id);
      else childrenOf.set(parentId, [id]);
    } else {
      roots.push(id);
    }
  }

  const metricCache = new Map<string, number>();
  function subtreeMetric(id: string): number {
    const cached = metricCache.get(id);
    if (cached !== undefined) return cached;
    let best = Number.NEGATIVE_INFINITY;
    for (const selection of selectionsById.get(id) || []) best = Math.max(best, selection.metric);
    for (const childId of childrenOf.get(id) || []) best = Math.max(best, subtreeMetric(childId));
    metricCache.set(id, best);
    return best;
  }

  /** Newest subtree first, then the canonical order — deterministic either way. */
  function compareBranches(a: string, b: string): number {
    const left = subtreeMetric(a);
    const right = subtreeMetric(b);
    if (left !== right) return right - left;
    return tree.compare(a, b);
  }

  function childrenSorted(id: string): string[] {
    return [...(childrenOf.get(id) || [])].sort(compareBranches);
  }

  function identityOf(id: string): { name: string; icon: string; color: string; kind: string } {
    const workspace = byId.get(id);
    return {
      name: workspace?.name || id,
      icon: workspace?.icon || "",
      color: workspace?.color || "",
      kind: workspace?.kind || "",
    };
  }

  function walk(id: string, depth: number, trail: string[], into: ActivityNode<T>[]): void {
    const selections = selectionsById.get(id);
    if (!selections || selections.length === 0) {
      // A context row. An unbranched run of context-only nodes collapses into
      // ONE breadcrumb row, so adding orientation cannot quietly turn a limit
      // of seven activities into dozens of lines. An activity node and a
      // BRANCHING context node are never compressed — the first is the point
      // of the section, the second is where the shape of the tree lives.
      const chain = [id];
      let children = childrenSorted(id);
      while (children.length === 1) {
        const next = children[0];
        // An activity is the point of the section and a BRANCHING context node
        // is where the shape of the tree lives — neither is ever folded away.
        if (selectionsById.has(next)) break;
        const grandChildren = childrenSorted(next);
        if (grandChildren.length > 1) break;
        chain.push(next);
        children = grandChildren;
      }
      const tail = chain[chain.length - 1];
      const path = chain.map((chainId) => identityOf(chainId).name);
      into.push({
        key: `context:${chain.join(">")}`,
        role: "context",
        // The click target is the NEAREST parent of the activity below, not
        // the top of the breadcrumb — that is the workspace the user is
        // pointing at. ALL WORKSPACES stays the place to reach every step.
        workspaceId: tail,
        ...identityOf(tail),
        depth,
        path,
        pathIds: chain,
        fullPath: [...trail, ...path],
      });
      const childTrail = [...trail, ...path];
      for (const childId of children) walk(childId, depth + 1, childTrail, into);
      return;
    }

    // Two agents can run in one workspace, so a workspace may carry more than
    // one activity row; they sit side by side at the same depth.
    for (const selection of [...selections].sort(
      (a, b) => b.metric - a.metric || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )) {
      into.push({
        key: selection.key,
        role: "activity",
        workspaceId: id,
        ...identityOf(id),
        depth,
        path: [identityOf(id).name],
        pathIds: [id],
        fullPath: [...trail, identityOf(id).name],
        payload: selection.payload,
      });
    }
    const childTrail = [...trail, identityOf(id).name];
    for (const childId of childrenSorted(id)) walk(childId, depth + 1, childTrail, into);
  }

  return roots.sort(compareBranches).map((rootId) => {
    const nodes: ActivityNode<T>[] = [];
    walk(rootId, 0, [], nodes);
    return { key: rootId, metric: subtreeMetric(rootId), nodes };
  });
}

/** Every activity node in the forest, in render order. */
export function activityNodesOf<T>(clusters: readonly ActivityCluster<T>[]): ActivityNode<T>[] {
  return clusters.flatMap((cluster) => cluster.nodes.filter((node) => node.role === "activity"));
}

/**
 * How many levels of INDENT a row may spend, however deep it really is.
 *
 * The sidebar is 248 px by default and resizable down to 180. An Azure branch
 * can legitimately be six levels deep (`Azure DevOps › repo › PR › review ›
 * task › companion`), and at 12 px a level that is 72 px of a ~90 px text
 * budget: the name the row exists to show would be ellipsised down to nothing
 * (V6 review, §"P1 UX", oprava 5).
 *
 * So the INDENT saturates while the DATA does not. `depth`, `path`, `fullPath`
 * and the accessible name keep the true position — the row is still announced
 * by its complete chain, still carries the rail, and ALL WORKSPACES still draws
 * the real tree. Only the pixels stop growing.
 */
export const MAX_ACTIVITY_VISUAL_DEPTH = 3;

/** The indent level a row of this true depth is drawn at. */
export function visualDepthOf(depth: number): number {
  if (!Number.isFinite(depth) || depth <= 0) return 0;
  return Math.min(Math.floor(depth), MAX_ACTIVITY_VISUAL_DEPTH);
}

/**
 * One row as the shared cluster component draws it.
 *
 * The component owns the cluster box, the indent, the hit target, the focus
 * and disabled states and the accessible name; RECENT and RUNNING each map
 * their own forest into this shape, so they supply CONTENT (a relative time
 * versus a task state and elapsed) and never their own hierarchy algorithm
 * (V5 review, §"Doporučená sdílená vrstva").
 *
 * `meta` and `trailing` are the only values that keep changing while the list
 * is frozen, which is why they render in reserved, fixed-width slots: an
 * elapsed that ticks or a state that flips must not resize a row the user is
 * aiming at.
 */
export interface ActivityRowView {
  key: string;
  role: ActivityNodeRole;
  /** Workspace to activate. */
  workspaceId: string;
  /** View to activate inside it — a running agent's panel; empty otherwise. */
  viewId?: string;
  depth: number;
  icon: string;
  color: string;
  /** The visible label: a name, or `root › … › parent` for a compressed row. */
  label: string;
  /** The complete, never-ellipsised name for assistive technology. */
  ariaLabel: string;
  title: string;
  /** Second line of an activity row. */
  summary?: string;
  /** Fixed-width secondary value (a task state). */
  meta?: string;
  /** Fixed-width trailing value (a relative age, an elapsed). */
  trailing?: string;
  active?: boolean;
  inGrid?: boolean;
  slotIndex?: number;
  attentionCount?: number;
  /**
   * The canonical workspace status dot — the SAME `{ state, label, heartbeat }`
   * the tree card draws, resolved once by `resolveWorkspaceStatusCue` and
   * handed down here (V6 review, §"P2 UX"). Present on context rows too when
   * that parent has a state of its own; it is drawn as an absolute overlay, so
   * it is never a membership, ordering or geometry input.
   */
  statusCue?: WorkspaceStatusCue | null;
  /** The workspace is gone — hold the row's height, but never navigate. */
  missing?: boolean;
}

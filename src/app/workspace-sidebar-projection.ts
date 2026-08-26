import type { WorkspaceState } from "../../electron/shared/types/state.js";
import { formatRelativeAge } from "./relative-age.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export type RecentSectionKey = "last-hour" | "last-day" | "last-7-days" | "older";

const SECTIONS: Array<{ key: RecentSectionKey; label: string }> = [
  { key: "last-hour", label: "Last hour" },
  { key: "last-day", label: "Last day" },
  { key: "last-7-days", label: "Last 7 days" },
  { key: "older", label: "Older" },
];

export interface RecentSectionRenderItem {
  type: "section";
  key: string;
  sectionKey: RecentSectionKey;
  label: string;
  /** Count of REAL workspace cards in this section (context rows excluded). */
  count: number;
}

export interface RecentContextRenderItem {
  type: "context";
  key: string;
  sectionKey: RecentSectionKey;
  workspaceId: string;
  name: string;
  icon: string;
  depth: number;
}

/**
 * The subset of `buildWorkspaceCards`' output this module and `WorkspaceCard`
 * actually touch, plus an index signature so the many other card fields
 * (status, review, checks, …) ride along untyped — mirrors the equally loose
 * `WorkspaceCardData` shape SidebarPanel.vue already builds `buildWorkspaceCards`
 * results into.
 */
export interface WorkspaceCardLike {
  id: string;
  active: boolean;
  attentionCount: number;
  attentionFresh: boolean;
  depth: number;
  name: string;
  [key: string]: unknown;
}

export interface RecentWorkspaceRenderItem {
  type: "workspace";
  key: string;
  sectionKey: RecentSectionKey;
  workspaceId: string;
  depth: number;
  card: WorkspaceCardLike;
}

export type RecentRenderItem = RecentSectionRenderItem | RecentContextRenderItem | RecentWorkspaceRenderItem;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WsLike = any;

/**
 * Resolve the explicit parent workspace id of a review/quickfix/task child,
 * falling back to the legacy "Worktree of X" name-based link for worktrees
 * created before that metadata existed. `allWs` MUST already be scoped to a
 * single profile — a missing, cyclical, or cross-profile parent simply
 * resolves to no match, since a foreign-profile workspace is never present
 * in `allWs`. Shared by the sidebar's star/search ancestor-walk and the
 * recent-view projection below so both agree on what "parent" means.
 */
export function resolveParentId(ws: WsLike, allWs: WsLike[]): string | null {
  if (ws.review?.checkout?.mode === "managed-worktree" && ws.review?.parentWorkspaceId) {
    return ws.review.parentWorkspaceId;
  }
  if (ws.quickfix?.parentWorkspaceId) return ws.quickfix.parentWorkspaceId;
  if (ws.task?.parentWorkspaceId) return ws.task.parentWorkspaceId;
  if ((ws.notes || "").startsWith("Worktree of ")) {
    const parentName = ws.name.split(" / ")[0];
    const wsProfile = ws.profileId || "default";
    const parent =
      allWs.find((c) => c.name === parentName && c.id !== ws.id && (c.profileId || "default") === wsProfile) ||
      allWs.find((c) => c.name === parentName && c.id !== ws.id);
    return parent?.id || null;
  }
  return null;
}

function bucketOf(ws: WorkspaceState, activeWorkspaceId: string, now: number): RecentSectionKey {
  if (ws.id === activeWorkspaceId) return "last-hour";
  if (!ws.lastUsedAt) return "older";
  const parsed = Date.parse(ws.lastUsedAt);
  if (Number.isNaN(parsed)) return "older";
  const age = Math.max(0, now - parsed);
  if (age <= HOUR_MS) return "last-hour";
  if (age <= DAY_MS) return "last-day";
  if (age <= WEEK_MS) return "last-7-days";
  return "older";
}

/**
 * Build the "recent" sidebar render list: workspaces grouped into
 * Last hour / Last day / Last 7 days / Older by `lastUsedAt`, each section
 * carrying the minimal parent-path context needed to keep hierarchy legible
 * (a shared ancestor renders once per section, as a non-interactive context
 * row unless it also belongs to that section itself). Pure and
 * deterministic — `now` and `visibleIds` are explicit inputs so callers can
 * test bucket edges and filter composition without mocking the clock or
 * the store.
 *
 * `workspaces` must already be scoped to one profile (the caller's
 * `filteredWorkspaces`) — parent resolution never looks outside this list,
 * so a foreign-profile parent can never surface as context. `cards` is the
 * already-rendered card data (from `buildWorkspaceCards`) for the SAME
 * workspace set, keyed by id; `visibleIds` further narrows which of those
 * are eligible to render as a real card (e.g. after the star filter).
 */
export function buildRecentProjection({
  workspaces,
  cards,
  activeWorkspaceId,
  now,
  visibleIds,
}: {
  workspaces: WorkspaceState[];
  cards: WorkspaceCardLike[];
  activeWorkspaceId: string;
  now: number;
  visibleIds: Set<string>;
}): RecentRenderItem[] {
  const byId = new Map(workspaces.map((w) => [w.id, w as WsLike]));
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const indexOf = new Map(workspaces.map((w, i) => [w.id, i]));

  const parentCache = new Map<string, string | null>();
  function parentOf(id: string): string | null {
    const cached = parentCache.get(id);
    if (cached !== undefined) return cached;
    parentCache.set(id, null); // cycle guard placeholder
    const ws = byId.get(id);
    let parentId: string | null = null;
    if (ws) {
      const raw = resolveParentId(ws, workspaces as WsLike[]);
      if (raw && raw !== id && byId.has(raw)) parentId = raw;
    }
    parentCache.set(id, parentId);
    return parentId;
  }

  const depthCache = new Map<string, number>();
  function depthOf(id: string, seen: Set<string> = new Set()): number {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const parentId = parentOf(id);
    const depth = parentId ? depthOf(parentId, seen) + 1 : 0;
    depthCache.set(id, depth);
    return depth;
  }

  const buckets = new Map<RecentSectionKey, Set<string>>(SECTIONS.map((s) => [s.key, new Set<string>()]));
  for (const id of visibleIds) {
    const ws = byId.get(id);
    if (!ws) continue;
    buckets.get(bucketOf(ws, activeWorkspaceId, now))!.add(id);
  }

  const result: RecentRenderItem[] = [];

  for (const { key: sectionKey, label } of SECTIONS) {
    const realIds = buckets.get(sectionKey)!;
    if (realIds.size === 0) continue;

    // Every real workspace plus its full ancestor chain — the minimal set
    // of nodes this section's tree needs.
    const pathNodes = new Set<string>();
    for (const id of realIds) {
      let cur: string | null = id;
      const chainSeen = new Set<string>();
      while (cur && !chainSeen.has(cur)) {
        chainSeen.add(cur);
        pathNodes.add(cur);
        cur = parentOf(cur);
      }
    }

    const childrenOf = new Map<string, string[]>();
    const roots: string[] = [];
    for (const id of pathNodes) {
      const parentId = parentOf(id);
      if (parentId && pathNodes.has(parentId)) {
        if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
        childrenOf.get(parentId)!.push(id);
      } else {
        roots.push(id);
      }
    }

    // A parent cycle (A's resolved parent is B, B's is A) leaves every node
    // in the loop pointing at another pathNode, so the loop above finds no
    // root for it at all — without a fallback the whole component would
    // silently vanish from the section. Any pathNode unreachable from the
    // roots found above becomes an additional root, guaranteeing every real
    // workspace still renders even on this pathological input.
    const reachable = new Set<string>();
    const queue = [...roots];
    while (queue.length) {
      const next = queue.shift()!;
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(...(childrenOf.get(next) || []));
    }
    for (const id of pathNodes) {
      if (!reachable.has(id)) roots.push(id);
    }

    // Representative (timestamp, tie-break index) per node: a real
    // workspace uses its own lastUsedAt (Infinity for the renderer's active
    // workspace, so its branch always sorts first); a context-only node
    // uses the max over its children — "newest real workspace in its
    // visible subtree" per the spec.
    const repCache = new Map<string, { ts: number; idx: number }>();
    function repOf(id: string): { ts: number; idx: number } {
      const cached = repCache.get(id);
      if (cached) return cached;
      let rep: { ts: number; idx: number };
      if (realIds.has(id)) {
        const ws = byId.get(id);
        const idx = indexOf.get(id) ?? 0;
        if (id === activeWorkspaceId) {
          rep = { ts: Infinity, idx };
        } else {
          const parsed = ws?.lastUsedAt ? Date.parse(ws.lastUsedAt) : NaN;
          rep = { ts: Number.isNaN(parsed) ? -Infinity : parsed, idx };
        }
      } else {
        let bestTs = -Infinity;
        let bestIdx = indexOf.get(id) ?? 0;
        for (const kid of childrenOf.get(id) || []) {
          const kidRep = repOf(kid);
          if (kidRep.ts > bestTs || (kidRep.ts === bestTs && kidRep.idx < bestIdx)) {
            bestTs = kidRep.ts;
            bestIdx = kidRep.idx;
          }
        }
        rep = { ts: bestTs, idx: bestIdx };
      }
      repCache.set(id, rep);
      return rep;
    }

    function sortByRep(ids: string[]): string[] {
      return [...ids].sort((a, b) => {
        const ra = repOf(a);
        const rb = repOf(b);
        if (rb.ts !== ra.ts) return rb.ts - ra.ts;
        return ra.idx - rb.idx;
      });
    }

    result.push({ type: "section", key: sectionKey, sectionKey, label, count: realIds.size });

    // Guards against double-emitting a node reachable two ways — the only
    // way that happens is the cycle fallback above, which may add a node to
    // `roots` even though it is also (wrongly) listed as someone's child.
    const emitted = new Set<string>();
    function emit(id: string): void {
      if (emitted.has(id)) return;
      emitted.add(id);
      const depth = depthOf(id);
      if (realIds.has(id)) {
        const baseCard: WorkspaceCardLike = cardById.get(id) || {
          id,
          active: id === activeWorkspaceId,
          attentionCount: 0,
          attentionFresh: false,
          depth,
          name: byId.get(id)?.name || "",
        };
        const ws = byId.get(id);
        const isActiveMigrated = id === activeWorkspaceId && !ws?.lastUsedAt;
        const effectiveIso: string = ws?.lastUsedAt || (isActiveMigrated ? new Date(now).toISOString() : "");
        const lastUsedRelative = effectiveIso ? formatRelativeAge(effectiveIso, now) : "";
        let lastUsedTitle = "";
        if (effectiveIso) {
          try {
            lastUsedTitle = `Last opened: ${new Date(effectiveIso).toLocaleString()}`;
          } catch {
            lastUsedTitle = `Last opened: ${lastUsedRelative}`;
          }
        }
        result.push({
          type: "workspace",
          key: id,
          sectionKey,
          workspaceId: id,
          depth,
          card: { ...baseCard, depth, lastUsedRelative, lastUsedTitle },
        });
      } else {
        const ws = byId.get(id);
        result.push({
          type: "context",
          key: `${sectionKey}:${id}`,
          sectionKey,
          workspaceId: id,
          name: ws?.name || "",
          icon: ws?.icon || "",
          depth,
        });
      }
      for (const kid of sortByRep(childrenOf.get(id) || [])) emit(kid);
    }

    for (const rootId of sortByRep(roots)) emit(rootId);
  }

  return result;
}

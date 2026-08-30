import type { WorkspaceState } from "../../electron/shared/types/state.js";
import { ancestorIdentities, buildWorkspaceTree, type WorkspaceAncestorIdentity } from "./workspace-tree.js";

/**
 * "Recently worked" shortcuts for the sidebar — a flat, deduplicated list of
 * the workspaces the user actually worked in during the last 24 hours.
 *
 * This replaces the time-bucketed recent VIEW (Last hour / Last day / Last 7
 * days / Older, with synthetic context rows and a re-derived tree per bucket).
 * That projection split one workspace tree into four fragments, repeated a
 * shared parent in each of them, and reshuffled itself as items aged — so the
 * user lost both the single familiar tree and their spatial memory of it.
 *
 * The V2 sidebar renders THIS list above the untouched canonical tree, so the
 * two answer different questions: "where did I work" and "where does this
 * workspace live". Nothing about the tree itself is rebuilt (V2 plan, Fáze 4).
 *
 * This module SELECTS and ORDERS; it does not shape the section. The sidebar
 * takes the top N of this list and hands them to `buildActivityForest`, which
 * adds the ancestor closure and merges connected results into one deduplicated
 * cluster — the reason the limit still counts real workspaces and a shared
 * branch is drawn once (V5 review, §"1. Recent bude minimální activity
 * forest"). Each row still carries its own ancestor identity so a result can
 * be NAMED in full (its accessible name is the whole path) without the
 * component re-deriving the hierarchy.
 */

/** Rolling window. An item exactly this old has already fallen out. */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RecentWorkspaceShortcut {
  workspaceId: string;
  name: string;
  icon: string;
  /** The workspace's own `lastWorkedAt`, verbatim. */
  lastWorkedAt: string;
  /** Parsed epoch ms of the above — the sort key, exposed so the row can format it. */
  lastWorkedAtMs: number;
  /**
   * Ancestor identities, ROOT FIRST. Empty for a root workspace. Replaces the
   * flat `ancestorLabels`, which could name a parent but not render one
   * (V4 review, §"Datový model"). Shared verbatim with the RUNNING surface, so
   * both sections resolve one hierarchy the same way.
   */
  ancestors: WorkspaceAncestorIdentity[];
}

/**
 * Build the recent-shortcut list.
 *
 * Pure and deterministic: `now` is an explicit input so boundary behaviour is
 * testable without mocking the clock, and ordering falls back to the canonical
 * workspace order and then the id, so equal timestamps never render in a
 * different order between two renders.
 *
 * `workspaces` must already be scoped to one profile (the caller's
 * `filteredWorkspaces`) — ancestry never looks outside this list, so a
 * foreign-profile parent can never surface in a breadcrumb. `visibleIds`, when
 * given, further narrows which workspaces may appear as rows (the star
 * filter); ancestry still resolves against the full profile list, so a
 * filtered-out ancestor is still named.
 *
 * The result is NOT truncated. Any "show only the first N" behaviour is
 * presentational and belongs to the component, so counts, filtering and tests
 * all see the complete qualifying set.
 */
export function buildRecentWorkspaceShortcuts({
  workspaces,
  now,
  visibleIds,
}: {
  workspaces: readonly WorkspaceState[];
  now: number;
  visibleIds?: Set<string> | null;
}): RecentWorkspaceShortcut[] {
  const tree = buildWorkspaceTree(workspaces);
  const rows: RecentWorkspaceShortcut[] = [];

  for (const workspace of workspaces) {
    if (visibleIds && !visibleIds.has(workspace.id)) continue;
    const raw = workspace.lastWorkedAt;
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) continue;
    // Strictly inside the window: an item exactly 24h old drops out. A stamp
    // in the future (clock skew, a hand-edited state file) still counts as
    // recent rather than being silently discarded.
    if (now - parsed >= RECENT_WINDOW_MS) continue;
    rows.push({
      workspaceId: workspace.id,
      name: workspace.name || workspace.id,
      icon: workspace.icon || "",
      lastWorkedAt: raw,
      lastWorkedAtMs: parsed,
      // The SAME tree index the activity forest and ALL WORKSPACES use, so the
      // name a row is announced by and the shape it is drawn in can never
      // disagree about who the parent is.
      ancestors: ancestorIdentities(tree, workspaces, workspace.id),
    });
  }

  return rows.sort((a, b) => {
    if (b.lastWorkedAtMs !== a.lastWorkedAtMs) return b.lastWorkedAtMs - a.lastWorkedAtMs;
    return tree.compare(a.workspaceId, b.workspaceId);
  });
}

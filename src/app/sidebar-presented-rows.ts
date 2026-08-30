import type { ActivityCluster, ActivityNode } from "./workspace-activity-tree.js";

/**
 * Live → presented projection for the sidebar's two DYNAMIC surfaces
 * (RUNNING and RECENTLY WORKED).
 *
 * The invariant this exists to enforce (V3 review, §2): while the user is
 * interacting with the workspace list, no background update may change which
 * rows exist, in what order, or how tall the section is. A navigation target
 * must not move between the moment the user aims at it and the click.
 *
 * The mechanism is deliberately boring and dependency-free: the caller freezes
 * the rendered FOREST when interaction starts and hands it back on every
 * render. While frozen,
 *   - a node whose key is still live keeps its frozen structure and takes only
 *     the values that cannot move a target or resize a row, through the
 *     explicit per-surface merger it is given (see the two below);
 *   - a node whose key has gone (a finished task, an item that just crossed
 *     24h) keeps rendering from the frozen payload, so the row does not vanish
 *     under the pointer;
 *   - a node whose WORKSPACE was hard-deleted is marked `missing`, which the
 *     cluster draws as an equally tall, inert placeholder rather than a live
 *     link to a dead id;
 *   - a cluster or a node that is not in the frozen forest is not inserted.
 *
 * Holding the key and the order alone was not enough (V4 review, §"P2 — lock
 * drží key a pořadí, ale ne strukturální význam stejného řádku"): the same key
 * could be reparented, renamed, or re-hosted, and the row under the pointer
 * would change its shape or its navigation target without ever leaving its
 * slot. A blanket spread of the live object is not a safe contract, so the
 * merge is explicit and per-surface.
 *
 * Unfreezing is a single atomic step — the caller drops the frozen forest and
 * the whole pending set appears at once, both sections together. There is no
 * animation and no partial application, because an animated reflow is just as
 * bad for an accurate click as an instant jump.
 */

/**
 * The RUNNING row fields a lock may keep taking from live.
 *
 * Everything else — `key`, `hostWorkspaceId`, `viewId`, `workspaceName`,
 * `ancestry`, `label`, `source` — is STRUCTURE or the navigation TARGET, and
 * is held at its frozen value: a task that re-hosts itself (worker → attached
 * Primary) or gets renamed mid-gesture must not change what the row under the
 * pointer opens or how tall it is.
 */
export interface LockedRunningRowFields {
  state: string;
  startedAtMs: number;
  pausedAtMs: number;
  finishedAtMs: number;
  totalPausedMs: number;
  inGrid: boolean;
  gridSlotIndex?: number;
}

/**
 * The RECENT row fields a lock may keep taking from live.
 *
 * Only the timestamp: it renders in a fixed-width trailing slot and re-sorting
 * is what the frozen forest already prevents. Identity, ancestry and the
 * workspace id (which IS the navigation target) stay frozen, so a background
 * reparent cannot rebuild the cluster under the pointer.
 */
export interface LockedRecentRowFields {
  lastWorkedAt: string;
  lastWorkedAtMs: number;
}

/** `mergeWhileLocked` for the RUNNING surface. */
export function mergeRunningRowWhileLocked<T extends LockedRunningRowFields>(frozen: T, live: T): T {
  return {
    ...frozen,
    state: live.state,
    startedAtMs: live.startedAtMs,
    pausedAtMs: live.pausedAtMs,
    finishedAtMs: live.finishedAtMs,
    totalPausedMs: live.totalPausedMs,
    inGrid: live.inGrid,
    gridSlotIndex: live.gridSlotIndex,
  };
}

/** `mergeWhileLocked` for the RECENTLY WORKED surface. */
export function mergeRecentRowWhileLocked<T extends LockedRecentRowFields>(frozen: T, live: T): T {
  return { ...frozen, lastWorkedAt: live.lastWorkedAt, lastWorkedAtMs: live.lastWorkedAtMs };
}

/**
 * The same lock, one level up: over a whole ACTIVITY FOREST.
 *
 * A flat (order, snapshot) pair could hold a list of independent rows, but it
 * cannot hold a tree. Cluster membership, a node's ROLE, the parent-child
 * edges, the order of the branches and each row's navigation target are all
 * derived from the live workspace list, so a background reparent, rename or a
 * newly-arrived sibling would restructure the section under the pointer even
 * though every individual key survived (V5 review, §"2. Každý context/activity
 * řádek bude samostatný navigační cíl", last bullets).
 *
 * So the WHOLE forest is the frozen unit. While locked the presented forest is
 * the frozen one, node for node; only a node's payload keeps taking the live
 * values that render in reserved, dimension-stable slots. A node whose
 * workspace was hard-deleted is marked `missing` and drawn as an equally tall,
 * inert placeholder rather than a link to a dead id.
 */
export interface PresentedActivityNode<T> extends ActivityNode<T> {
  missing: boolean;
}

export interface PresentedActivityCluster<T> {
  key: string;
  nodes: PresentedActivityNode<T>[];
}

export function projectPresentedForest<T>({
  live,
  lockedForest,
  isAlive,
  mergePayloadWhileLocked,
}: {
  live: readonly ActivityCluster<T>[];
  lockedForest: readonly ActivityCluster<T>[] | null;
  isAlive: (node: ActivityNode<T>) => boolean;
  mergePayloadWhileLocked?: (frozen: T, live: T) => T;
}): PresentedActivityCluster<T>[] {
  if (!lockedForest) {
    return live.map((cluster) => ({
      key: cluster.key,
      nodes: cluster.nodes.map((node) => ({ ...node, missing: false })),
    }));
  }

  const livePayloads = new Map<string, T>();
  for (const cluster of live) {
    for (const node of cluster.nodes) {
      if (node.payload !== undefined) livePayloads.set(node.key, node.payload);
    }
  }

  return lockedForest.map((cluster) => ({
    key: cluster.key,
    nodes: cluster.nodes.map((node) => {
      const livePayload = livePayloads.get(node.key);
      const payload =
        node.payload !== undefined && livePayload !== undefined && mergePayloadWhileLocked
          ? mergePayloadWhileLocked(node.payload, livePayload)
          : node.payload;
      return { ...node, payload, missing: !isAlive(node) };
    }),
  }));
}

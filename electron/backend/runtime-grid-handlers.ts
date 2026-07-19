import { GRID_LAYOUT_SLOTS } from "./default-state.js";
import { parseRemoteViewerId } from "./viewer-id.js";
import type { RemoteClientRegistry } from "./remote-client-registry.js";
import type { AppState, WorkspaceGridState } from "../shared/types/state.js";

/**
 * Runtime context subset consumed by grid handlers.
 * The full runtime ctx is typed as a structural interface so new fields
 * can be added without breaking this module. Generic over `Payload` so the
 * handlers below keep getPayload()'s real (inferred) return type instead of
 * widening it to `unknown` — runtime.test.ts asserts on the payload shape.
 */
interface GridHandlerCtx<Payload> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any;
  getState: () => AppState;
  getPayload: () => Payload;
  broadcastState: () => void;
  /** Live accessor — the registry is set (via setRemoteClientRegistry) after createRuntime starts. */
  getRemoteClientRegistry: () => RemoteClientRegistry | null;
}

/**
 * Factory for the workspace-grid API handlers (enable/disable/set-layout/
 * set-cell/swap-cells) plus their shared plumbing. Extracted from
 * runtime.ts to reduce file size.
 */
export function createGridHandlers<Payload>(ctx: GridHandlerCtx<Payload>) {
  const { store, getState, getPayload, broadcastState, getRemoteClientRegistry } = ctx;

  function resolveWorkspaceGridProfile(draft: AppState, windowId?: string) {
    const remoteSessionId = parseRemoteViewerId(windowId);
    const profileId = remoteSessionId
      ? getRemoteClientRegistry()?.get(remoteSessionId)?.profileId || "default"
      : windowId
        ? (draft.windowSlots || []).find((s) => s.id === windowId)?.profileId
        : (draft.windowSlots || [])[0]?.profileId || "default";
    return profileId ? draft.profiles.find((p) => p.id === profileId) || null : null;
  }

  // The grid is viewer-owned: mutations target the calling window's slot so
  // two windows of the same profile keep independent layouts. Falls back to
  // the first slot only for legacy payloads that carry no windowId.
  function resolveWorkspaceGridSlot(draft: AppState, windowId?: string) {
    const slots = draft.windowSlots || [];
    if (windowId) return slots.find((s) => s.id === windowId) || null;
    return slots[0] || null;
  }

  // Remote viewers own their grid in the RemoteClientRegistry (runtime-only,
  // never persisted). Grid mutations from a remote client mutate that
  // context instead of any desktop window slot.
  function readRemoteViewerGrid(remoteSessionId: string): WorkspaceGridState | null {
    return getRemoteClientRegistry()?.get(remoteSessionId)?.workspaceGrid ?? null;
  }

  function writeRemoteViewerGrid(remoteSessionId: string, grid: WorkspaceGridState | null): void {
    getRemoteClientRegistry()?.setWorkspaceGrid(remoteSessionId, grid, getState());
  }

  // Read the authoritative grid for a slot. Slots normally carry their own
  // grid (normalize migrates the legacy profile grid in); the profile/global
  // fallbacks only cover pre-migration in-memory state.
  function readSlotGrid(
    draft: AppState,
    slot: { workspaceGrid?: WorkspaceGridState | null; profileId: string } | null,
  ) {
    if (!slot) return draft.workspaceGrid ?? null;
    if (slot.workspaceGrid !== undefined) return slot.workspaceGrid;
    const profile = draft.profiles.find((p) => p.id === slot.profileId);
    return profile && profile.workspaceGrid !== undefined ? profile.workspaceGrid : (draft.workspaceGrid ?? null);
  }

  // --- Pure grid transforms (no store/remote-registry access) ---
  // Each returns the next grid value, or undefined to signal "invalid input,
  // leave the grid untouched" (as opposed to null, which means "clear it").

  /** Build a fresh grid for `layout`, placing `workspaceIds` positionally. */
  function gridForLayout(layout: unknown, workspaceIds?: (string | null)[]): WorkspaceGridState | undefined {
    const slots = GRID_LAYOUT_SLOTS[String(layout)];
    if (!slots) return undefined;
    const ids: (string | null)[] = [];
    for (let i = 0; i < slots; i++) ids.push(workspaceIds?.[i] ?? null);
    return { layout: layout as WorkspaceGridState["layout"], cellWorkspaceIds: ids };
  }

  /** Re-layout an existing grid: repack its non-null ids in order into the new slot count. */
  function gridRelayout(existing: WorkspaceGridState, layout: unknown): WorkspaceGridState | undefined {
    const slots = GRID_LAYOUT_SLOTS[String(layout)];
    if (!slots) return undefined;
    const compact = existing.cellWorkspaceIds.filter((id) => id !== null);
    const ids: (string | null)[] = [];
    let taken = 0;
    for (let i = 0; i < slots; i++) ids.push(taken < compact.length ? (compact[taken++] ?? null) : null);
    return { layout: layout as WorkspaceGridState["layout"], cellWorkspaceIds: ids };
  }

  /**
   * Place `workspaceId` into `cellIndex`, clearing any other cell that
   * already held it. Returns null (clear the grid) if every cell ends up
   * empty, or undefined if `cellIndex` is out of range.
   */
  function gridSetCell(
    grid: WorkspaceGridState,
    cellIndex: number,
    workspaceId: string | null,
  ): WorkspaceGridState | null | undefined {
    const ids = grid.cellWorkspaceIds;
    if (cellIndex < 0 || cellIndex >= ids.length) return undefined;
    const next = [...ids];
    if (workspaceId) {
      const existingIndex = next.indexOf(workspaceId);
      if (existingIndex >= 0 && existingIndex !== cellIndex) next[existingIndex] = null;
    }
    next[cellIndex] = workspaceId;
    const allNull = next.every((id) => id === null);
    return allNull ? null : { ...grid, cellWorkspaceIds: next };
  }

  /** Swap two cells. Returns undefined (no-op) if either index is out of range or they're equal. */
  function gridSwap(grid: WorkspaceGridState, a: number, b: number): WorkspaceGridState | undefined {
    const ids = grid.cellWorkspaceIds;
    if (a < 0 || a >= ids.length || b < 0 || b >= ids.length || a === b) return undefined;
    const next = [...ids];
    const tmp = next[a];
    next[a] = next[b];
    next[b] = tmp;
    return { ...grid, cellWorkspaceIds: next };
  }

  /**
   * Route a grid mutation to whichever store the caller's window owns: a
   * remote viewer's runtime-only grid, or the desktop window slot persisted
   * in the app store. `transform` receives the current grid (or null) and
   * returns the next value — `undefined` means "leave untouched".
   *
   * The store path always broadcasts after `store.mutate` resolves (matching
   * this handler group's pre-extraction behavior of broadcasting
   * unconditionally once the mutate call completes); the remote path only
   * broadcasts when `transform` actually produced a value.
   */
  async function applyGridMutation(
    windowId: string | undefined,
    transform: (existing: WorkspaceGridState | null) => WorkspaceGridState | null | undefined,
  ): Promise<void> {
    const remoteGridSessionId = parseRemoteViewerId(windowId);
    if (remoteGridSessionId) {
      const existing = readRemoteViewerGrid(remoteGridSessionId);
      const next = transform(existing);
      if (next !== undefined) {
        writeRemoteViewerGrid(remoteGridSessionId, next);
        broadcastState();
      }
      return;
    }
    await store.mutate((draft: AppState) => {
      const slot = resolveWorkspaceGridSlot(draft, windowId);
      const existing = readSlotGrid(draft, slot);
      const next = transform(existing);
      if (next === undefined) return;
      if (slot) slot.workspaceGrid = next;
      draft.workspaceGrid = next;
    });
    broadcastState();
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async enableWorkspaceGrid(layout: any, workspaceIds?: (string | null)[], windowId?: string) {
      // Validate workspace ↔ grid-profile match BEFORE mutation, mirroring
      // setGridCell. Without this, a remote/mobile client can populate the
      // grid of profile B with workspace IDs from profile A on the initial
      // enable — setGridCell refuses individual placements, but enable
      // accepted the array wholesale.
      if (Array.isArray(workspaceIds) && workspaceIds.some(Boolean)) {
        const state = getState();
        const gridProfile = resolveWorkspaceGridProfile(state, windowId);
        const gridProfileId = gridProfile?.id || null;
        if (gridProfileId) {
          for (const id of workspaceIds) {
            if (!id) continue;
            const ws = state.workspaces.find((w) => w.id === id);
            if (ws && (ws.profileId || "default") !== gridProfileId) {
              throw new Error(
                `Cross-profile refused: workspace ${id} is in profile ${ws.profileId || "default"}, grid belongs to profile ${gridProfileId}.`,
              );
            }
          }
        }
      }
      await applyGridMutation(windowId, () => gridForLayout(layout, workspaceIds));
      return getPayload();
    },

    async disableWorkspaceGrid(windowId?: string) {
      await applyGridMutation(windowId, () => null);
      return getPayload();
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async setGridLayout(layout: any, windowId?: string) {
      await applyGridMutation(windowId, (existing) => (existing ? gridRelayout(existing, layout) : undefined));
      return getPayload();
    },

    async setGridCell(cellIndex: number, workspaceId: string | null, windowId?: string) {
      // Validate workspace ↔ profile match BEFORE mutation. The grid is
      // per-viewer, scoped to the slot's profile; a stale or crafted remote
      // payload could try to place a workspace from profile A into a window
      // showing profile B (different cards would then show up in B's window
      // with cwds the user didn't expect).
      if (workspaceId) {
        const state = getState();
        const gridProfile = resolveWorkspaceGridProfile(state, windowId);
        const gridProfileId = gridProfile?.id || null;
        const ws = state.workspaces.find((w) => w.id === workspaceId);
        if (ws && gridProfileId && (ws.profileId || "default") !== gridProfileId) {
          throw new Error(
            `Cross-profile refused: workspace ${workspaceId} is in profile ${ws.profileId || "default"}, grid belongs to profile ${gridProfileId}.`,
          );
        }
      }
      await applyGridMutation(windowId, (existing) =>
        existing ? gridSetCell(existing, cellIndex, workspaceId) : undefined,
      );
      return getPayload();
    },

    async swapGridCells(a: number, b: number, windowId?: string) {
      await applyGridMutation(windowId, (existing) => (existing ? gridSwap(existing, a, b) : undefined));
      return getPayload();
    },
  };
}

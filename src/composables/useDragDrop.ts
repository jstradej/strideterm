import { useAppStore } from "../stores/app.js";
import { getParentWorkspaceId } from "../workspace-state.js";
import type { Ref } from "vue";
import type { WorkspaceState } from "../../electron/shared/types/state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WsLike = WorkspaceState & { review?: any; quickfix?: any };

function isChildOf(child: WsLike, parentId: string): boolean {
  const explicitParent = getParentWorkspaceId(child);
  if (explicitParent) return explicitParent === parentId;
  return false;
}

/**
 * The workspaces that move together when `workspaceId` is dragged: its family root and every descendant. A member of a
 * group is the root of its OWN family — the group above it is not part of what it drags along; a group is the root of
 * its members' families, so dragging it moves the whole block.
 */
export function getWorktreeGroup(workspaceId: string, workspaces: WsLike[]): string[] {
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return [workspaceId];

  // Restrict the entire group lookup to workspaces in the same profile.
  // Without this filter, legacy-worktree matching (name prefix / notes
  // prefix) groups together workspaces from other profiles when names or
  // cwds collide — drag-reorder then drags hidden-from-this-window
  // entries along with the visible ones.
  const profileId = ws.profileId || "default";
  const sameProfile = workspaces.filter((w) => (w.profileId || "default") === profileId);

  // If this workspace is a child, find the parent and build group from there
  const explicitParentId = getParentWorkspaceId(ws);
  if (explicitParentId) {
    const parent = sameProfile.find((w) => w.id === explicitParentId);
    if (parent && parent.kind !== "group") return getWorktreeGroup(parent.id, sameProfile);
  }
  // Legacy worktree child — find parent by name within the same profile.
  if ((ws.notes || "").startsWith("Worktree of ")) {
    const parentName = ws.name.split(" / ")[0];
    const parent = sameProfile.find(
      (w) => w.kind !== "group" && w.name === parentName && !(w.notes || "").startsWith("Worktree of "),
    );
    if (parent) return getWorktreeGroup(parent.id, sameProfile);
  }

  // This is a root — collect all descendants recursively (same profile only).
  const groupIds = [ws.id];
  collectDescendants(ws.id, ws.name, ws.kind === "group", sameProfile, groupIds);
  return groupIds;
}

function collectDescendants(
  parentId: string,
  parentName: string,
  parentIsGroup: boolean,
  workspaces: WsLike[],
  result: string[],
): void {
  // `workspaces` is already pre-filtered to the parent's profile by the
  // caller (see getWorktreeGroup) — the legacy `notes/name` heuristic
  // therefore stays inside the parent's profile.
  const prefix = parentName + " / ";
  for (const w of workspaces) {
    if (result.includes(w.id)) continue;
    if (isChildOf(w, parentId)) {
      result.push(w.id);
      collectDescendants(w.id, w.name, false, workspaces, result);
    } else if (!parentIsGroup && w.name.startsWith(prefix) && (w.notes || "").startsWith("Worktree of ")) {
      result.push(w.id);
    }
  }
}

/** Where a dragged family lands: next to `anchorIds`, filed in `groupId` ("" = at root level). */
export interface WorkspaceDropPlacement {
  groupId: string;
  anchorIds: string[];
  before: boolean;
  /** The card the drop indicator is drawn on; null = the first / last visible card of the anchor. */
  indicatorId: string | null;
  /** The dragged family joins the group at its end: the group header is highlighted instead of a line. */
  into: boolean;
}

function filedGroupId(ws: WsLike, workspaces: WsLike[]): string {
  if (ws.kind === "group" || !ws.groupId) return "";
  const group = workspaces.find((w) => w.id === ws.groupId);
  return group?.kind === "group" && (group.profileId || "default") === (ws.profileId || "default") ? group.id : "";
}

/**
 * Decide what dropping `draggedId` on the `targetId` card means. `fraction` is the pointer's height inside the card, 0 at
 * the top. Dropping on a group header (below its top quarter) or on one of its members files the dragged family in that
 * group; dropping anywhere else puts it at root level, so a member is taken out of its group. A group itself is only
 * ever placed at root level.
 */
export function resolveDropPlacement(
  workspaces: WsLike[],
  draggedId: string,
  targetId: string,
  fraction: number,
): WorkspaceDropPlacement | null {
  const dragged = workspaces.find((w) => w.id === draggedId);
  const target = workspaces.find((w) => w.id === targetId);
  if (!dragged || !target || draggedId === targetId) return null;
  const dragIds = getWorktreeGroup(draggedId, workspaces);
  if (dragIds.includes(targetId)) return null;
  const draggedIsGroup = workspaces.find((w) => w.id === dragIds[0])?.kind === "group";
  const targetFamily = getWorktreeGroup(targetId, workspaces);
  const familyRoot = workspaces.find((w) => w.id === targetFamily[0]);
  if (!familyRoot) return null;

  if (familyRoot.kind === "group") {
    if (draggedIsGroup) {
      return { groupId: "", anchorIds: targetFamily, before: fraction < 0.5, indicatorId: null, into: false };
    }
    if (fraction < 0.25) {
      return { groupId: "", anchorIds: targetFamily, before: true, indicatorId: null, into: false };
    }
    return { groupId: familyRoot.id, anchorIds: targetFamily, before: false, indicatorId: familyRoot.id, into: true };
  }

  const groupId = filedGroupId(familyRoot, workspaces);
  const before = fraction < 0.5;
  if (groupId) {
    if (draggedIsGroup) {
      return {
        groupId: "",
        anchorIds: getWorktreeGroup(groupId, workspaces),
        before,
        indicatorId: null,
        into: false,
      };
    }
    return { groupId, anchorIds: targetFamily, before, indicatorId: null, into: false };
  }

  // Single workspace or the family root itself — the line goes on the card; a child snaps to the family's edge.
  return {
    groupId: "",
    anchorIds: targetFamily,
    before,
    indicatorId: targetFamily.length <= 1 || targetFamily[0] === targetId ? targetId : null,
    into: false,
  };
}

/** The persisted order after the drop, or null when nothing in the anchor is left to place the family next to. */
export function applyDropPlacement(
  workspaces: WsLike[],
  draggedId: string,
  placement: WorkspaceDropPlacement,
): string[] | null {
  const dragIds = getWorktreeGroup(draggedId, workspaces);
  const remaining = workspaces.map((w) => w.id).filter((id) => !dragIds.includes(id));
  const anchorIndexes = placement.anchorIds.map((id) => remaining.indexOf(id)).filter((index) => index >= 0);
  if (!anchorIndexes.length) return null;
  const at = placement.before ? Math.min(...anchorIndexes) : Math.max(...anchorIndexes) + 1;
  remaining.splice(at, 0, ...dragIds);
  return remaining;
}

/**
 * Workspace drag-drop for the sidebar workspace list.
 */
export function useWorkspaceDragDrop(workspaceListRef: Ref<HTMLElement | null | undefined>) {
  const store = useAppStore();
  // dataTransfer contents are not readable during dragover, so the id is remembered at dragstart.
  let draggedWorkspaceId = "";

  function clearDragIndicators() {
    workspaceListRef.value
      ?.querySelectorAll(
        ".workspace-card--drag-before, .workspace-card--drag-after, .workspace-card--dragging, .workspace-card--drop-into",
      )
      .forEach((el) => {
        el.classList.remove(
          "workspace-card--drag-before",
          "workspace-card--drag-after",
          "workspace-card--dragging",
          "workspace-card--drop-into",
        );
      });
  }

  function treeCards(): HTMLElement[] {
    return Array.from(workspaceListRef.value?.querySelectorAll<HTMLElement>(".workspace-card") || []).filter(
      (card) => !card.closest(".workspace-list__split-group"),
    );
  }

  function onDragstart(event: DragEvent) {
    const card = (event.target as Element | null)?.closest<HTMLElement>(".workspace-card");
    if (!card) return;
    event.dataTransfer!.effectAllowed = "move";
    const workspaceId = card.dataset.workspaceId!;
    draggedWorkspaceId = workspaceId;
    event.dataTransfer!.setData("text/plain", workspaceId);
    event.dataTransfer!.setData("workspace-id", workspaceId);
    const workspaces = (store.payload?.appState?.workspaces || []) as WsLike[];
    const groupIds = getWorktreeGroup(workspaceId, workspaces);
    requestAnimationFrame(() => {
      workspaceListRef.value?.querySelectorAll<HTMLElement>(".workspace-card").forEach((c) => {
        if (groupIds.includes(c.dataset.workspaceId!)) c.classList.add("workspace-card--dragging");
      });
    });
  }

  function placementFor(draggedId: string, targetCard: HTMLElement | null, clientY: number) {
    if (!draggedId || !targetCard || targetCard.classList.contains("workspace-card--dragging")) return null;
    const rect = targetCard.getBoundingClientRect();
    const fraction = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    const workspaces = (store.payload?.appState?.workspaces || []) as WsLike[];
    return resolveDropPlacement(workspaces, draggedId, targetCard.dataset.workspaceId!, fraction);
  }

  function indicate(placement: WorkspaceDropPlacement) {
    const cards = treeCards();
    if (placement.into) {
      cards.find((c) => c.dataset.workspaceId === placement.indicatorId)?.classList.add("workspace-card--drop-into");
      return;
    }
    const visible = cards.filter((c) => placement.anchorIds.includes(c.dataset.workspaceId!));
    const card = placement.indicatorId
      ? cards.find((c) => c.dataset.workspaceId === placement.indicatorId)
      : placement.before
        ? visible[0]
        : visible[visible.length - 1];
    card?.classList.add(placement.before ? "workspace-card--drag-before" : "workspace-card--drag-after");
  }

  function onDragover(event: DragEvent) {
    event.preventDefault();
    event.dataTransfer!.dropEffect = "move";
    clearDragIndicators();
    const targetCard = (event.target as Element | null)?.closest<HTMLElement>(".workspace-card") || null;
    const placement = placementFor(draggedWorkspaceId, targetCard, event.clientY);
    if (placement) indicate(placement);
  }

  function onDragleave(event: DragEvent) {
    if (!workspaceListRef.value?.contains(event.relatedTarget as Node | null)) clearDragIndicators();
  }

  async function onDrop(event: DragEvent) {
    event.preventDefault();
    const draggedId = event.dataTransfer!.getData("text/plain");
    clearDragIndicators();
    const targetCard = (event.target as Element | null)?.closest<HTMLElement>(".workspace-card") || null;
    const placement = placementFor(draggedId, targetCard, event.clientY);
    if (!placement) return;
    const workspaces = (store.payload?.appState?.workspaces || []) as WsLike[];
    const order = applyDropPlacement(workspaces, draggedId, placement);
    if (!order) return;
    // The family root carries the group: dragging a worktree child moves, and files, its whole family.
    const root = workspaces.find((w) => w.id === getWorktreeGroup(draggedId, workspaces)[0]);
    await store.reorderWorkspaces(order);
    if (root && root.kind !== "group" && filedGroupId(root, workspaces) !== placement.groupId) {
      await store.setWorkspaceGroup(root.id, placement.groupId);
    }
  }

  function onDragend() {
    draggedWorkspaceId = "";
    clearDragIndicators();
  }

  return { onDragstart, onDragover, onDragleave, onDrop, onDragend };
}

/**
 * Tab drag-drop for the tab strip.
 */
export function useTabDragDrop(tabStripRef: Ref<HTMLElement | null | undefined>) {
  const store = useAppStore();

  function clearTabDragIndicators() {
    tabStripRef.value?.querySelectorAll(".tab--drag-before, .tab--drag-after, .tab--dragging").forEach((el) => {
      el.classList.remove("tab--drag-before", "tab--drag-after", "tab--dragging");
    });
  }

  function onDragstart(event: DragEvent) {
    const tab = (event.target as Element | null)?.closest<HTMLElement>(".tab");
    if (!tab || tab.dataset.persistent !== "true") return;
    event.dataTransfer!.effectAllowed = "move";
    event.dataTransfer!.setData("text/plain", tab.dataset.viewId!);
    requestAnimationFrame(() => tab.classList.add("tab--dragging"));
  }

  function onDragover(event: DragEvent) {
    event.preventDefault();
    event.dataTransfer!.dropEffect = "move";
    clearTabDragIndicators();
    const tab = (event.target as Element | null)?.closest<HTMLElement>(".tab");
    if (tab && !tab.classList.contains("tab--dragging")) {
      const rect = tab.getBoundingClientRect();
      const before = event.clientX < rect.left + rect.width / 2;
      tab.classList.add(before ? "tab--drag-before" : "tab--drag-after");
    } else if (!tab) {
      const tabs = Array.from(tabStripRef.value?.querySelectorAll<HTMLElement>(".tab:not(.tab--dragging)") || []);
      if (tabs.length) tabs[tabs.length - 1].classList.add("tab--drag-after");
    }
  }

  function onDragleave(event: DragEvent) {
    if (!tabStripRef.value?.contains(event.relatedTarget as Node | null)) clearTabDragIndicators();
  }

  async function onDrop(event: DragEvent) {
    event.preventDefault();
    const draggedId = event.dataTransfer!.getData("text/plain");
    clearTabDragIndicators();
    const tab = (event.target as Element | null)?.closest<HTMLElement>(".tab");
    if (tab && tab.dataset.viewId !== draggedId && tab.dataset.persistent === "true") {
      const rect = tab.getBoundingClientRect();
      const insertBefore = event.clientX < rect.left + rect.width / 2;
      await store.reorderPanels(draggedId, tab.dataset.viewId!, insertBefore);
      return;
    }
    // Dropped on empty space — move to end
    const allTabs = Array.from(tabStripRef.value?.querySelectorAll<HTMLElement>(".tab[data-persistent='true']") || []);
    if (allTabs.length) {
      const lastTab = allTabs[allTabs.length - 1];
      if (lastTab.dataset.viewId !== draggedId) {
        await store.reorderPanels(draggedId, lastTab.dataset.viewId!, false);
      }
    }
  }

  function onDragend() {
    clearTabDragIndicators();
  }

  return { onDragstart, onDragover, onDragleave, onDrop, onDragend };
}

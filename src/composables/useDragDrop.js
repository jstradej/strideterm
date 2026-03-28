import { useAppStore } from "../stores/app.js";

function getParentWorkspaceId(ws) {
  // Azure review or quickfix children reference their parent explicitly
  if (ws.review?.checkout?.mode === "managed-worktree" && ws.review?.parentWorkspaceId)
    return ws.review.parentWorkspaceId;
  if (ws.quickfix?.parentWorkspaceId) return ws.quickfix.parentWorkspaceId;
  // Legacy worktree children use notes convention
  if ((ws.notes || "").startsWith("Worktree of ")) {
    return null; // handled by name-based lookup below
  }
  return null;
}

function isChildOf(child, parentId) {
  const explicitParent = getParentWorkspaceId(child);
  if (explicitParent) return explicitParent === parentId;
  return false;
}

function getWorktreeGroup(workspaceId, workspaces) {
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return [workspaceId];

  // If this workspace is a child, find the parent and build group from there
  const explicitParentId = getParentWorkspaceId(ws);
  if (explicitParentId) {
    const parent = workspaces.find((w) => w.id === explicitParentId);
    if (parent) return getWorktreeGroup(parent.id, workspaces);
  }
  // Legacy worktree child — find parent by name
  if ((ws.notes || "").startsWith("Worktree of ")) {
    const parentName = ws.name.split(" / ")[0];
    const parent = workspaces.find((w) => w.name === parentName && !(w.notes || "").startsWith("Worktree of "));
    if (parent) return getWorktreeGroup(parent.id, workspaces);
  }

  // This is a parent — collect all children
  const groupIds = [ws.id];
  const prefix = ws.name + " / ";
  for (const w of workspaces) {
    if (w.id === ws.id) continue;
    // Explicit parent reference (review/quickfix children)
    if (isChildOf(w, ws.id)) {
      groupIds.push(w.id);
      continue;
    }
    // Legacy worktree children by name convention
    if (w.name.startsWith(prefix) && (w.notes || "").startsWith("Worktree of ")) {
      groupIds.push(w.id);
    }
  }
  return groupIds;
}

/**
 * Workspace drag-drop for the sidebar workspace list.
 */
export function useWorkspaceDragDrop(workspaceListRef) {
  const store = useAppStore();

  function clearDragIndicators() {
    workspaceListRef.value
      ?.querySelectorAll(".workspace-card--drag-before, .workspace-card--drag-after, .workspace-card--dragging")
      .forEach((el) => {
        el.classList.remove("workspace-card--drag-before", "workspace-card--drag-after", "workspace-card--dragging");
      });
  }

  function onDragstart(event) {
    const card = event.target.closest(".workspace-card");
    if (!card) return;
    event.dataTransfer.effectAllowed = "move";
    const workspaceId = card.dataset.workspaceId;
    event.dataTransfer.setData("text/plain", workspaceId);
    const workspaces = store.payload?.appState?.workspaces || [];
    const groupIds = getWorktreeGroup(workspaceId, workspaces);
    requestAnimationFrame(() => {
      workspaceListRef.value?.querySelectorAll(".workspace-card").forEach((c) => {
        if (groupIds.includes(c.dataset.workspaceId)) c.classList.add("workspace-card--dragging");
      });
    });
  }

  /**
   * Find the group boundary card element for a drop target.
   * If the target is inside another group (not the dragged group), snap to group edge:
   *   - hovering top half → show indicator before the group's first card (parent)
   *   - hovering bottom half → show indicator after the group's last card
   * Returns { card, before } or null if drop is not allowed here.
   */
  function resolveDropTarget(targetCard, clientY) {
    if (!targetCard || targetCard.classList.contains("workspace-card--dragging")) return null;
    const targetId = targetCard.dataset.workspaceId;
    const workspaces = store.payload?.appState?.workspaces || [];
    const targetGroup = getWorktreeGroup(targetId, workspaces);

    // Single workspace or the parent itself — allow drop directly
    if (targetGroup.length <= 1 || targetGroup[0] === targetId) {
      const rect = targetCard.getBoundingClientRect();
      return { card: targetCard, before: clientY < rect.top + rect.height / 2 };
    }

    // Target is a child inside a group — snap to group boundary
    const cards = Array.from(workspaceListRef.value?.querySelectorAll(".workspace-card") || []);
    const rect = targetCard.getBoundingClientRect();
    const before = clientY < rect.top + rect.height / 2;

    if (before) {
      // Snap to before the parent (first card in group)
      const parentCard = cards.find((c) => c.dataset.workspaceId === targetGroup[0]);
      return parentCard ? { card: parentCard, before: true } : null;
    }
    // Snap to after the last child in group
    const lastId = targetGroup[targetGroup.length - 1];
    const lastCard = cards.find((c) => c.dataset.workspaceId === lastId);
    return lastCard ? { card: lastCard, before: false } : null;
  }

  function onDragover(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearDragIndicators();
    const targetCard = event.target.closest(".workspace-card");
    const resolved = resolveDropTarget(targetCard, event.clientY);
    if (resolved) {
      resolved.card.classList.add(resolved.before ? "workspace-card--drag-before" : "workspace-card--drag-after");
    }
  }

  function onDragleave(event) {
    if (!workspaceListRef.value?.contains(event.relatedTarget)) clearDragIndicators();
  }

  async function onDrop(event) {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData("text/plain");
    clearDragIndicators();
    const targetCard = event.target.closest(".workspace-card");
    const resolved = resolveDropTarget(targetCard, event.clientY);
    if (!resolved) return;
    const dropId = resolved.card.dataset.workspaceId;
    if (dropId === draggedId) return;
    const workspaces = store.payload?.appState?.workspaces || [];
    const allIds = workspaces.map((w) => w.id);
    const groupIds = getWorktreeGroup(draggedId, workspaces);
    const remaining = allIds.filter((id) => !groupIds.includes(id));
    let toIndex = remaining.indexOf(dropId);
    if (toIndex < 0) return;
    if (!resolved.before) toIndex++;
    remaining.splice(toIndex, 0, ...groupIds);
    await store.reorderWorkspaces(remaining);
  }

  function onDragend() {
    clearDragIndicators();
  }

  return { onDragstart, onDragover, onDragleave, onDrop, onDragend };
}

/**
 * Tab drag-drop for the tab strip.
 */
export function useTabDragDrop(tabStripRef) {
  const store = useAppStore();

  function clearTabDragIndicators() {
    tabStripRef.value?.querySelectorAll(".tab--drag-before, .tab--drag-after, .tab--dragging").forEach((el) => {
      el.classList.remove("tab--drag-before", "tab--drag-after", "tab--dragging");
    });
  }

  function onDragstart(event) {
    const tab = event.target.closest(".tab");
    if (!tab || tab.dataset.persistent !== "true") return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tab.dataset.viewId);
    requestAnimationFrame(() => tab.classList.add("tab--dragging"));
  }

  function onDragover(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearTabDragIndicators();
    const tab = event.target.closest(".tab");
    if (tab && !tab.classList.contains("tab--dragging")) {
      const rect = tab.getBoundingClientRect();
      const before = event.clientX < rect.left + rect.width / 2;
      tab.classList.add(before ? "tab--drag-before" : "tab--drag-after");
    } else if (!tab) {
      const tabs = Array.from(tabStripRef.value?.querySelectorAll(".tab:not(.tab--dragging)") || []);
      if (tabs.length) tabs[tabs.length - 1].classList.add("tab--drag-after");
    }
  }

  function onDragleave(event) {
    if (!tabStripRef.value?.contains(event.relatedTarget)) clearTabDragIndicators();
  }

  async function onDrop(event) {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData("text/plain");
    clearTabDragIndicators();
    const tab = event.target.closest(".tab");
    if (tab && tab.dataset.viewId !== draggedId && tab.dataset.persistent === "true") {
      const rect = tab.getBoundingClientRect();
      const insertBefore = event.clientX < rect.left + rect.width / 2;
      await store.reorderPanels(draggedId, tab.dataset.viewId, insertBefore);
      return;
    }
    // Dropped on empty space — move to end
    const allTabs = Array.from(tabStripRef.value?.querySelectorAll(".tab[data-persistent='true']") || []);
    if (allTabs.length) {
      const lastTab = allTabs[allTabs.length - 1];
      if (lastTab.dataset.viewId !== draggedId) {
        await store.reorderPanels(draggedId, lastTab.dataset.viewId, false);
      }
    }
  }

  function onDragend() {
    clearTabDragIndicators();
  }

  return { onDragstart, onDragover, onDragleave, onDrop, onDragend };
}

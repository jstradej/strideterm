import { getWorkspaceTabs, getWorkspacePanelByViewId } from "../app/selectors.js";
import { statusTone, cloneWorkspace } from "../workspace-state.js";
import {
  isContainerRunning,
  isGitViewId,
  isDockerViewId,
  isAzureViewId,
  isGitHubViewId,
  isReviewViewId,
  isFilesViewId,
  isBrowserViewId,
} from "../app/helpers.js";

const viewIdHelpers = {
  isGitViewId,
  isDockerViewId,
  isAzureViewId,
  isGitHubViewId,
  isReviewViewId,
  isFilesViewId,
  isBrowserViewId,
};
import { APP_CONFIG } from "../../config/app-config.js";

const LAYOUTS = {
  solo: { slots: 1 },
  cols: { slots: 2 },
  rows: { slots: 2 },
  "top-split": { slots: 3 },
  "left-split": { slots: 3 },
  grid: { slots: 4 },
};

/**
 * Factory for workspace-management actions (CRUD, tabs, layout, panels).
 *
 * @param {object} ctx  Shared refs and helpers injected by the app store.
 *   payload, activeViewId, activeSessionId, splitGroup, hiddenViewIds,
 *   workspaceTabs, getApi, withSuppressedBroadcast
 */
export function createWorkspaceActions(ctx) {
  // --- Workspace CRUD ----------------------------------------------------

  async function saveWorkspace(draft) {
    ctx.payload.value = await ctx.getApi().saveWorkspace(draft);
  }

  async function deleteWorkspace(workspaceId) {
    const ws = (ctx.payload.value?.appState?.workspaces || []).find((w) => w.id === workspaceId);
    if (!ws) return;
    if (!window.confirm(`Delete workspace "${ws.name}"?`)) return;

    const isWorktreeChild =
      (ws.notes || "").startsWith("Worktree of ") ||
      ws.review?.checkout?.mode === "managed-worktree" ||
      !!ws.quickfix?.parentWorkspaceId;
    const worktreePath =
      ws.review?.checkout?.mode === "managed-worktree" && ws.review?.checkout?.rootPath
        ? ws.review.checkout.rootPath
        : ws.quickfix?.rootPath || "";
    const diskPath = worktreePath || (isWorktreeChild && ws.cwd ? ws.cwd : "");

    let deleteFromDisk = false;
    if (diskPath) {
      deleteFromDisk = window.confirm(
        `Also delete the worktree files from disk?\n\n${diskPath}\n\nOK = delete files, Cancel = keep files`,
      );
    }

    if (deleteFromDisk) {
      ctx.overlay.value = "BusyOverlay";
      ctx.overlayProps.value = { message: `Deleting workspace "${ws.name}"…`, detail: diskPath };
    }
    try {
      const result = await ctx.getApi().deleteWorkspace(workspaceId, { deleteFromDisk, diskPath });
      if (result?.deleteWorkspaceError) {
        window.alert(
          `Workspace was deleted, but files could not be removed:\n\n${result.deleteWorkspaceError}\n\nYou can delete the directory manually.`,
        );
      }
      ctx.payload.value = result;
    } finally {
      if (deleteFromDisk) {
        ctx.overlay.value = null;
        ctx.overlayProps.value = {};
      }
    }
  }

  // --- Tab management ----------------------------------------------------

  function closeTab(viewId) {
    if (!viewId) return;
    if (isAzureViewId(viewId) || isGitHubViewId(viewId) || isReviewViewId(viewId)) return;

    if (ctx.splitGroup.value) {
      const next = ctx.splitGroup.value.viewIds.filter((id) => id !== viewId);
      ctx.splitGroup.value = next.length >= 2 ? { ...ctx.splitGroup.value, viewIds: next } : null;
    }

    const workspace = ctx.payload.value?.workspace;
    const activeWs = workspace?.workspace || workspace?.project;
    const sessionId = viewId;
    const panelId = sessionId.split(":").slice(1).join(":");
    const isWorkspacePanel = activeWs?.panels?.some((p) => p.id === panelId);

    if (isGitViewId(viewId) || isDockerViewId(viewId) || !isWorkspacePanel) {
      ctx.hiddenViewIds.value = new Set([...ctx.hiddenViewIds.value, viewId]);
      if (ctx.activeViewId.value === viewId) {
        const tabs = getWorkspaceTabs({
          workspace,
          payload: ctx.payload.value,
          hiddenViewIds: ctx.hiddenViewIds.value,
          statusTone,
          isContainerRunning,
        });
        ctx.activeViewId.value = tabs.find((t) => t.id !== viewId)?.id || null;
      }
      const _api = ctx.getApi();
      if (!isGitViewId(viewId) && !isDockerViewId(viewId) && _api.closeTerminal) {
        _api
          .closeTerminal(viewId)
          .then((p) => {
            ctx.payload.value = p;
          })
          .catch((err) => {
            console.warn("[closeTab] failed to close terminal:", err?.message || err);
          });
      }
      return;
    }

    if (!activeWs) return;
    if (activeWs.panels.length <= 1 && activeWs.kind !== "docker") return;

    const nextWorkspace = cloneWorkspace(activeWs);
    nextWorkspace.panels = nextWorkspace.panels.filter((p) => p.id !== panelId);
    if (nextWorkspace.activePanelId === panelId) {
      nextWorkspace.activePanelId = nextWorkspace.panels[0]?.id || "";
    }
    if (ctx.activeViewId.value === viewId) {
      const tabs = getWorkspaceTabs({
        workspace,
        payload: ctx.payload.value,
        hiddenViewIds: ctx.hiddenViewIds.value,
        statusTone,
        isContainerRunning,
      });
      ctx.activeViewId.value = ctx.splitGroup.value?.viewIds[0] || tabs[0]?.id || null;
    }
    ctx
      .getApi()
      .saveWorkspace(nextWorkspace)
      .then((p) => {
        ctx.payload.value = p;
      })
      .catch((err) => {
        console.warn("[closeTab] failed to save workspace after panel removal:", err?.message || err);
      });
  }

  async function quickAddTab() {
    const workspace = ctx.payload.value?.workspace;
    const activeWs = workspace?.workspace || workspace?.project;
    if (!activeWs || activeWs.kind === "docker" || activeWs.kind === "azure" || activeWs.kind === "github") return;

    const nextWorkspace = cloneWorkspace(activeWs);
    const panelId = `panel-${crypto.randomUUID()}`;
    nextWorkspace.panels.push({
      id: panelId,
      title: `${APP_CONFIG.ui.numberedPanelTitlePrefix} ${nextWorkspace.panels.length + 1}`,
      command: "",
      shell: true,
      startup: APP_CONFIG.ui.defaultPanelStartup,
    });
    nextWorkspace.activePanelId = panelId;
    await ctx.withSuppressedBroadcast(async () => {
      ctx.payload.value = await ctx.getApi().saveWorkspace(nextWorkspace);
    });
    ctx.activeViewId.value = `${nextWorkspace.id}:${panelId}`;
  }

  async function quickAddTemplateTab(command, title) {
    const workspace = ctx.payload.value?.workspace;
    const activeWs = workspace?.workspace || workspace?.project;
    if (!activeWs || activeWs.kind === "docker" || activeWs.kind === "azure" || activeWs.kind === "github") return;

    const nextWorkspace = cloneWorkspace(activeWs);
    const panelId = `panel-${crypto.randomUUID()}`;
    const isBrowser = /^https?:\/\//i.test(command || "");
    const isFiles = command === "__files__";
    nextWorkspace.panels.push({
      id: panelId,
      title: title || "Shell",
      command: command || "",
      shell: !isFiles,
      startup: isFiles ? "none" : APP_CONFIG.ui.defaultPanelStartup,
    });
    nextWorkspace.activePanelId = panelId;
    const nextViewId = isBrowser
      ? `browser:${panelId}`
      : isFiles
        ? `files:${panelId}`
        : `${nextWorkspace.id}:${panelId}`;
    await ctx.withSuppressedBroadcast(async () => {
      ctx.payload.value = await ctx.getApi().saveWorkspace(nextWorkspace);
    });
    ctx.activeViewId.value = nextViewId;
  }

  // --- Layout / split ----------------------------------------------------

  function pickLayout(layout) {
    const slots = LAYOUTS[layout]?.slots || 1;
    const tabs = ctx.workspaceTabs.value;
    const groupIds = [ctx.activeViewId.value];
    for (const tab of tabs) {
      if (groupIds.length >= slots) break;
      if (!groupIds.includes(tab.id)) groupIds.push(tab.id);
    }
    ctx.splitGroup.value = groupIds.length >= 2 ? { layout, viewIds: groupIds.slice(0, slots) } : null;
  }

  function disbandSplit() {
    ctx.splitGroup.value = null;
  }

  function ctxRemoveFromGroup(viewId) {
    if (!ctx.splitGroup.value) return;
    const next = ctx.splitGroup.value.viewIds.filter((id) => id !== viewId);
    ctx.splitGroup.value = next.length >= 2 ? { ...ctx.splitGroup.value, viewIds: next } : null;
  }

  function ctxAddToGroup(viewId) {
    if (!ctx.splitGroup.value) return;
    const slots = LAYOUTS[ctx.splitGroup.value.layout]?.slots || 2;
    if (ctx.splitGroup.value.viewIds.length < slots && !ctx.splitGroup.value.viewIds.includes(viewId)) {
      ctx.splitGroup.value = { ...ctx.splitGroup.value, viewIds: [...ctx.splitGroup.value.viewIds, viewId] };
    }
  }

  // --- Session / panel ---------------------------------------------------

  async function restartSession(sessionId) {
    if (!sessionId) return;
    ctx.payload.value = await ctx.getApi().restartTerminal(sessionId);
    ctx.activeViewId.value = sessionId;
  }

  async function reorderPanels(draggedViewId, dropViewId, insertBefore) {
    const workspace = ctx.payload.value?.workspace;
    const draggedTarget = getWorkspacePanelByViewId(draggedViewId, workspace, viewIdHelpers);
    const dropTarget = getWorkspacePanelByViewId(dropViewId, workspace, viewIdHelpers);
    if (!draggedTarget || !dropTarget || draggedTarget.workspace.id !== dropTarget.workspace.id) return;

    const nextWorkspace = cloneWorkspace(draggedTarget.workspace);
    const fromIndex = nextWorkspace.panels.findIndex((p) => p.id === draggedTarget.panel.id);
    const toIndex = nextWorkspace.panels.findIndex((p) => p.id === dropTarget.panel.id);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    const [movedPanel] = nextWorkspace.panels.splice(fromIndex, 1);
    const insertionIndex = insertBefore
      ? toIndex - (fromIndex < toIndex ? 1 : 0)
      : toIndex + (fromIndex < toIndex ? 0 : 1);
    nextWorkspace.panels.splice(Math.max(0, insertionIndex), 0, movedPanel);
    ctx.payload.value = await ctx.getApi().saveWorkspace(nextWorkspace);
  }

  async function renameTab(viewId, title) {
    const workspace = ctx.payload.value?.workspace;
    const target = getWorkspacePanelByViewId(viewId, workspace, viewIdHelpers);
    if (!target || !title?.trim() || title.trim() === target.panel.title) return;

    const nextWorkspace = cloneWorkspace(target.workspace);
    nextWorkspace.panels = nextWorkspace.panels.map((p) =>
      p.id === target.panel.id ? { ...p, title: title.trim() } : p,
    );
    ctx.payload.value = await ctx.getApi().saveWorkspace(nextWorkspace);
  }

  async function createWorktree(workspaceId, name) {
    if (!workspaceId || !name) return;
    ctx.payload.value = await ctx.getApi().createWorktree({ workspaceId, name });
    ctx.splitGroup.value = null;
    ctx.hiddenViewIds.value = new Set();
  }

  // --- Workspace reordering ----------------------------------------------

  async function reorderWorkspaces(orderedIds) {
    ctx.payload.value = await ctx.getApi().reorderWorkspaces(orderedIds);
  }

  return {
    saveWorkspace,
    deleteWorkspace,
    closeTab,
    quickAddTab,
    quickAddTemplateTab,
    pickLayout,
    disbandSplit,
    ctxRemoveFromGroup,
    ctxAddToGroup,
    restartSession,
    reorderPanels,
    renameTab,
    createWorktree,
    reorderWorkspaces,
  };
}

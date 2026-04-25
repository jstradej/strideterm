import { getWorkspaceTabs, getWorkspacePanelByViewId } from "../app/selectors.js";
import { cloneWorkspace } from "../workspace-state.js";
import {
  isContainerRunning,
  isGitViewId,
  isDockerViewId,
  isAzureViewId,
  isGitHubViewId,
  isReviewViewId,
  isFilesViewId,
  isBrowserViewId,
  isTaskDashboardViewId,
} from "../app/helpers.js";
import type { Ref, ShallowRef, ComputedRef } from "vue";
import type { StatePayload } from "../../electron/shared/types/state.js";
import type { Transport } from "../transport.js";
import { APP_CONFIG } from "../../config/app-config.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const viewIdHelpers = {
  isGitViewId,
  isDockerViewId,
  isAzureViewId,
  isGitHubViewId,
  isReviewViewId,
  isFilesViewId,
  isBrowserViewId,
  isTaskDashboardViewId,
};

const LAYOUTS: Record<string, { slots: number }> = {
  solo: { slots: 1 },
  cols: { slots: 2 },
  rows: { slots: 2 },
  "top-split": { slots: 3 },
  "left-split": { slots: 3 },
  grid: { slots: 4 },
};

interface SplitGroup {
  layout: string;
  viewIds: string[];
}

interface WorkspaceTab {
  id: string;
  type: string;
  title: string;
  status: string;
  tone: string;
}

interface WorkspaceActionsCtx {
  payload: ShallowRef<StatePayload | null>;
  activeViewId: Ref<string | null>;
  activeSessionId: Ref<string | null>;
  splitGroup: Ref<SplitGroup | null>;
  hiddenViewIds: Ref<Set<string>>;
  workspaceTabs: ComputedRef<WorkspaceTab[]>;
  overlay: Ref<string | null>;
  overlayProps: Ref<Record<string, unknown>>;
  getApi: () => Transport;
  withSuppressedBroadcast: (fn: () => Promise<void>) => Promise<void>;
}

/**
 * Factory for workspace-management actions (CRUD, tabs, layout, panels).
 *
 * @param ctx  Shared refs and helpers injected by the app store.
 *   payload, activeViewId, activeSessionId, splitGroup, hiddenViewIds,
 *   workspaceTabs, getApi, withSuppressedBroadcast
 */
export function createWorkspaceActions(ctx: WorkspaceActionsCtx) {
  // --- Workspace CRUD ----------------------------------------------------

  async function saveWorkspace(draft: AnyApi): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).saveWorkspace(draft)) as StatePayload;
  }

  async function deleteWorkspace(workspaceId: string): Promise<void> {
    const ws = (ctx.payload.value?.appState?.workspaces || []).find((w: AnyApi) => w.id === workspaceId);
    if (!ws) return;
    if (!window.confirm(`Delete workspace "${(ws as AnyApi).name}"?`)) return;

    const isWorktreeChild =
      ((ws as AnyApi).notes || "").startsWith("Worktree of ") ||
      (ws as AnyApi).review?.checkout?.mode === "managed-worktree" ||
      !!(ws as AnyApi).quickfix?.parentWorkspaceId ||
      !!(ws as AnyApi).task?.worktreeBase;
    const worktreePath =
      (ws as AnyApi).review?.checkout?.mode === "managed-worktree" && (ws as AnyApi).review?.checkout?.rootPath
        ? (ws as AnyApi).review.checkout.rootPath
        : (ws as AnyApi).quickfix?.rootPath || "";
    const diskPath = worktreePath || (isWorktreeChild && (ws as AnyApi).cwd ? (ws as AnyApi).cwd : "");

    let deleteFromDisk = false;
    if (diskPath) {
      deleteFromDisk = window.confirm(
        `Also delete the worktree files from disk?\n\n${diskPath}\n\nOK = delete files, Cancel = keep files`,
      );
    }

    if (deleteFromDisk) {
      ctx.overlay.value = "BusyOverlay";
      ctx.overlayProps.value = { message: `Deleting workspace "${(ws as AnyApi).name}"…`, detail: diskPath };
    }
    try {
      const result = (await (ctx.getApi() as AnyApi).deleteWorkspace(workspaceId, {
        deleteFromDisk,
        diskPath,
      })) as AnyApi;
      if (result?.deleteWorkspaceError) {
        window.alert(
          `Workspace was deleted, but files could not be removed:\n\n${result.deleteWorkspaceError}\n\nYou can delete the directory manually.`,
        );
      }
      ctx.payload.value = result as StatePayload;
    } finally {
      if (deleteFromDisk) {
        ctx.overlay.value = null;
        ctx.overlayProps.value = {};
      }
    }
  }

  // --- Tab management ----------------------------------------------------

  function closeTab(viewId: string): void {
    if (!viewId) return;
    if (isAzureViewId(viewId) || isGitHubViewId(viewId) || isReviewViewId(viewId)) return;

    if (ctx.splitGroup.value) {
      const next = ctx.splitGroup.value.viewIds.filter((id) => id !== viewId);
      ctx.splitGroup.value = next.length >= 2 ? { ...ctx.splitGroup.value, viewIds: next } : null;
    }

    const workspace = (ctx.payload.value as AnyApi)?.workspace;
    const activeWs = workspace?.workspace || workspace?.project;
    const sessionId = viewId;
    const panelId = sessionId.split(":").slice(1).join(":");
    const isWorkspacePanel = (activeWs as AnyApi)?.panels?.some((p: AnyApi) => p.id === panelId);

    if (isGitViewId(viewId) || isDockerViewId(viewId) || !isWorkspacePanel) {
      ctx.hiddenViewIds.value = new Set([...ctx.hiddenViewIds.value, viewId]);
      if (ctx.activeViewId.value === viewId) {
        const tabs = getWorkspaceTabs({
          workspace,
          payload: ctx.payload.value,
          hiddenViewIds: ctx.hiddenViewIds.value,
          isContainerRunning,
        });
        ctx.activeViewId.value = (tabs as WorkspaceTab[]).find((t) => t.id !== viewId)?.id || null;
      }
      const _api = ctx.getApi() as AnyApi;
      if (!isGitViewId(viewId) && !isDockerViewId(viewId) && _api.closeTerminal) {
        (_api.closeTerminal(viewId) as Promise<StatePayload>)
          .then((p) => {
            ctx.payload.value = p;
          })
          .catch((err: Error) => {
            console.warn("[closeTab] failed to close terminal:", err?.message || err);
          });
      }
      return;
    }

    if (!activeWs) return;
    if ((activeWs as AnyApi).panels.length <= 1 && (activeWs as AnyApi).kind !== "docker") return;

    const nextWorkspace = cloneWorkspace(activeWs as AnyApi);
    nextWorkspace.panels = nextWorkspace.panels.filter((p: AnyApi) => p.id !== panelId);
    if (nextWorkspace.activePanelId === panelId) {
      nextWorkspace.activePanelId = nextWorkspace.panels[0]?.id || "";
    }
    if (ctx.activeViewId.value === viewId) {
      const tabs = getWorkspaceTabs({
        workspace,
        payload: ctx.payload.value,
        hiddenViewIds: ctx.hiddenViewIds.value,
        isContainerRunning,
      });
      ctx.activeViewId.value = ctx.splitGroup.value?.viewIds[0] || (tabs as WorkspaceTab[])[0]?.id || null;
    }
    (ctx.getApi() as AnyApi)
      .saveWorkspace(nextWorkspace)
      .then((p: StatePayload) => {
        ctx.payload.value = p;
      })
      .catch((err: Error) => {
        console.warn("[closeTab] failed to save workspace after panel removal:", err?.message || err);
      });
  }

  async function quickAddTab(cwdOverride = ""): Promise<void> {
    const workspace = (ctx.payload.value as AnyApi)?.workspace;
    const activeWs = workspace?.workspace || workspace?.project;
    if (!activeWs || (activeWs as AnyApi).kind === "docker" || (activeWs as AnyApi).kind === "azure" || (activeWs as AnyApi).kind === "github") return;

    const nextWorkspace = cloneWorkspace(activeWs as AnyApi);
    const panelId = `panel-${crypto.randomUUID()}`;
    const panel: AnyApi = {
      id: panelId,
      title: `${APP_CONFIG.ui.numberedPanelTitlePrefix} ${nextWorkspace.panels.length + 1}`,
      command: "",
      shell: true,
      startup: APP_CONFIG.ui.defaultPanelStartup,
    };
    if (cwdOverride) panel.cwd = cwdOverride;
    nextWorkspace.panels.push(panel);
    nextWorkspace.activePanelId = panelId;
    await ctx.withSuppressedBroadcast(async () => {
      ctx.payload.value = (await (ctx.getApi() as AnyApi).saveWorkspace(nextWorkspace)) as StatePayload;
    });
    ctx.activeViewId.value = `${nextWorkspace.id}:${panelId}`;
  }

  async function quickAddTemplateTab(
    command: string,
    title: string,
    cwdOverride = "",
    options: Record<string, unknown> = {},
  ): Promise<void> {
    const workspace = (ctx.payload.value as AnyApi)?.workspace;
    const activeWs = workspace?.workspace || workspace?.project;
    if (!activeWs || (activeWs as AnyApi).kind === "docker" || (activeWs as AnyApi).kind === "azure" || (activeWs as AnyApi).kind === "github") return;

    const nextWorkspace = cloneWorkspace(activeWs as AnyApi);
    const panelId = `panel-${crypto.randomUUID()}`;
    const isBrowser = /^https?:\/\//i.test(command || "");
    const isFiles = command === "__files__";
    const isTaskDashboard = command === "__task-dashboard__";
    const isVirtual = isFiles || isTaskDashboard;
    const panel: AnyApi = {
      id: panelId,
      title: title || "Shell",
      command: command || "",
      shell: !isVirtual,
      startup: isVirtual ? "none" : APP_CONFIG.ui.defaultPanelStartup,
    };
    if (cwdOverride) panel.cwd = cwdOverride;
    if (options.kind === "ssh") {
      // Two valid shapes: saved host reference, or inline ad-hoc definition.
      // Preference is explicit — callers can only ever pass one.
      panel.launch = options.sshInline
        ? { kind: "ssh", sshInline: options.sshInline }
        : { kind: "ssh", sshHostId: options.sshHostId };
    }
    nextWorkspace.panels.push(panel);
    nextWorkspace.activePanelId = panelId;
    const nextViewId = isBrowser
      ? `browser:${panelId}`
      : isFiles
        ? `files:${panelId}`
        : isTaskDashboard
          ? `task-dashboard:${panelId}`
          : `${nextWorkspace.id}:${panelId}`;
    await ctx.withSuppressedBroadcast(async () => {
      ctx.payload.value = (await (ctx.getApi() as AnyApi).saveWorkspace(nextWorkspace)) as StatePayload;
    });
    ctx.activeViewId.value = nextViewId;
  }

  // --- Layout / split ----------------------------------------------------

  function pickLayout(layout: string): void {
    const slots = LAYOUTS[layout]?.slots || 1;
    const tabs = ctx.workspaceTabs.value;
    const groupIds: string[] = [ctx.activeViewId.value!];
    for (const tab of tabs) {
      if (groupIds.length >= slots) break;
      if (!groupIds.includes(tab.id)) groupIds.push(tab.id);
    }
    ctx.splitGroup.value = groupIds.length >= 2 ? { layout, viewIds: groupIds.slice(0, slots) } : null;
  }

  function disbandSplit(): void {
    ctx.splitGroup.value = null;
  }

  function ctxRemoveFromGroup(viewId: string): void {
    if (!ctx.splitGroup.value) return;
    const next = ctx.splitGroup.value.viewIds.filter((id) => id !== viewId);
    ctx.splitGroup.value = next.length >= 2 ? { ...ctx.splitGroup.value, viewIds: next } : null;
  }

  function ctxAddToGroup(viewId: string): void {
    if (!ctx.splitGroup.value) return;
    const slots = LAYOUTS[ctx.splitGroup.value.layout]?.slots || 2;
    if (
      ctx.splitGroup.value.viewIds.length < slots &&
      !ctx.splitGroup.value.viewIds.includes(viewId)
    ) {
      ctx.splitGroup.value = { ...ctx.splitGroup.value, viewIds: [...ctx.splitGroup.value.viewIds, viewId] };
    }
  }

  function swapInSplit(aViewId: string, bViewId: string): void {
    if (!ctx.splitGroup.value) return;
    if (!aViewId || !bViewId || aViewId === bViewId) return;
    const ids = ctx.splitGroup.value.viewIds;
    const iA = ids.indexOf(aViewId);
    const iB = ids.indexOf(bViewId);
    if (iA < 0 || iB < 0) return;
    const next = [...ids];
    next[iA] = bViewId;
    next[iB] = aViewId;
    ctx.splitGroup.value = { ...ctx.splitGroup.value, viewIds: next };
  }

  // --- Session / panel ---------------------------------------------------

  async function restartSession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    ctx.payload.value = (await ctx.getApi().restartTerminal(sessionId)) as StatePayload;
    ctx.activeViewId.value = sessionId;
  }

  async function reorderPanels(
    draggedViewId: string,
    dropViewId: string,
    insertBefore: boolean,
  ): Promise<void> {
    const workspace = (ctx.payload.value as AnyApi)?.workspace;
    const draggedTarget = getWorkspacePanelByViewId(draggedViewId, workspace, viewIdHelpers);
    const dropTarget = getWorkspacePanelByViewId(dropViewId, workspace, viewIdHelpers);
    if (
      !draggedTarget ||
      !dropTarget ||
      (draggedTarget as AnyApi).workspace.id !== (dropTarget as AnyApi).workspace.id
    )
      return;

    const nextWorkspace = cloneWorkspace((draggedTarget as AnyApi).workspace);
    const fromIndex = nextWorkspace.panels.findIndex((p: AnyApi) => p.id === (draggedTarget as AnyApi).panel.id);
    const toIndex = nextWorkspace.panels.findIndex((p: AnyApi) => p.id === (dropTarget as AnyApi).panel.id);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    const [movedPanel] = nextWorkspace.panels.splice(fromIndex, 1);
    const insertionIndex = insertBefore
      ? toIndex - (fromIndex < toIndex ? 1 : 0)
      : toIndex + (fromIndex < toIndex ? 0 : 1);
    nextWorkspace.panels.splice(Math.max(0, insertionIndex), 0, movedPanel);

    // Optimistic update — saveWorkspace on the backend also runs refreshGit
    // (~10 git subprocesses), which on a real repo adds hundreds of ms before
    // the new order becomes visible. Reflect the reorder locally right away
    // so the drop feels instant; the backend response overwrites it when ready.
    const prevPayload = ctx.payload.value;
    const wrapper = (prevPayload as AnyApi)?.workspace;
    if (wrapper?.workspace?.id === nextWorkspace.id) {
      const panelOrder = new Map(nextWorkspace.panels.map((p: AnyApi, i: number) => [p.id, i]));
      const reorderedSessions = [...(wrapper.sessions || [])].sort(
        (a: AnyApi, b: AnyApi) =>
          ((panelOrder.get(a.panelId) as number | undefined) ?? 999) -
          ((panelOrder.get(b.panelId) as number | undefined) ?? 999),
      );
      const prevWorkspaces = (prevPayload as AnyApi)?.appState?.workspaces || [];
      const nextWorkspaces = (prevWorkspaces as AnyApi[]).map((w: AnyApi) =>
        w.id === nextWorkspace.id ? nextWorkspace : w,
      );
      ctx.payload.value = {
        ...(prevPayload as AnyApi),
        workspace: { workspace: nextWorkspace, project: nextWorkspace, sessions: reorderedSessions },
        appState: { ...(prevPayload as AnyApi).appState, workspaces: nextWorkspaces },
      } as StatePayload;
    }

    try {
      ctx.payload.value = (await (ctx.getApi() as AnyApi).saveWorkspace(nextWorkspace)) as StatePayload;
    } catch (err) {
      if (prevPayload) ctx.payload.value = prevPayload;
      throw err;
    }
  }

  async function renameTab(viewId: string, title: string): Promise<void> {
    const workspace = (ctx.payload.value as AnyApi)?.workspace;
    const target = getWorkspacePanelByViewId(viewId, workspace, viewIdHelpers) as AnyApi;
    if (!target || !title?.trim() || title.trim() === target.panel.title) return;

    const nextWorkspace = cloneWorkspace(target.workspace);
    nextWorkspace.panels = nextWorkspace.panels.map((p: AnyApi) =>
      p.id === target.panel.id ? { ...p, title: title.trim() } : p,
    );
    ctx.payload.value = (await (ctx.getApi() as AnyApi).saveWorkspace(nextWorkspace)) as StatePayload;
  }

  async function createWorktree(workspaceId: string, name: string, rootPath = ""): Promise<void> {
    if (!workspaceId || !name) return;
    ctx.payload.value = (await (ctx.getApi() as AnyApi).createWorktree({
      workspaceId,
      name,
      rootPath,
    })) as StatePayload;
    ctx.splitGroup.value = null;
    ctx.hiddenViewIds.value = new Set();
  }

  // --- Workspace reordering ----------------------------------------------

  async function reorderWorkspaces(orderedIds: string[]): Promise<void> {
    // Optimistic update — the IPC round-trip (including JSON persist + broadcast)
    // otherwise leaves the sidebar stale for long enough that users think the
    // drop didn't register and retry.
    const prevPayload = ctx.payload.value;
    const currentWorkspaces = (prevPayload as AnyApi)?.appState?.workspaces || [];
    if ((currentWorkspaces as AnyApi[]).length) {
      const byId = new Map((currentWorkspaces as AnyApi[]).map((w: AnyApi) => [w.id, w]));
      const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
      for (const w of currentWorkspaces as AnyApi[]) {
        if (!reordered.includes(w)) reordered.push(w);
      }
      ctx.payload.value = {
        ...(prevPayload as AnyApi),
        appState: { ...(prevPayload as AnyApi).appState, workspaces: reordered },
      } as StatePayload;
    }
    try {
      ctx.payload.value = (await (ctx.getApi() as AnyApi).reorderWorkspaces(orderedIds)) as StatePayload;
    } catch (err) {
      if (prevPayload) ctx.payload.value = prevPayload;
      throw err;
    }
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
    swapInSplit,
    restartSession,
    reorderPanels,
    renameTab,
    createWorktree,
    reorderWorkspaces,
  };
}

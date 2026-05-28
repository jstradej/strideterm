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
  optimisticallyDeletedIds: Ref<Set<string>>;
  isGridVisible: ComputedRef<boolean>;
  /** Wrapper exposed by the store that pre-empts active-cell truncation
   *  before forwarding to the IPC. Use this rather than the raw transport
   *  setGridLayout — see store.setGridLayout for why. */
  setGridLayout: (layout: string) => Promise<void>;
  /** Wrapper that boots the workspace grid with the active workspace in
   *  slot 0 (or honours the supplied preset). Used by pickLayout when the
   *  picker was opened in `mode: "grid"` from a non-grid context. */
  enableWorkspaceGrid: (layout: string, preset?: { workspaceIds: (string | null)[] }) => Promise<void>;
  /** Which entry-point opened the layout picker. Drives pickLayout dispatch:
   *   "grid"  — always operate on the multi-workspace grid;
   *   "split" — always operate on the active workspace's tab-split;
   *   "auto"  — legacy: tab-split unless the grid is already visible. */
  layoutPickerMode: Ref<"grid" | "split" | "auto">;
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

  function confirmInApp({
    title,
    message,
    confirmLabel = "OK",
    cancelLabel = "Cancel",
    danger = false,
  }: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  }): Promise<boolean> {
    // Preserve the currently-open overlay (e.g. SettingsDialog) so calls from
    // inside a parent dialog don't lose its state on cancel/confirm.
    const prevOverlay = ctx.overlay.value;
    const prevOverlayProps = ctx.overlayProps.value;
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        if (prevOverlay && prevOverlay !== "ConfirmDialog") {
          ctx.overlay.value = prevOverlay;
          ctx.overlayProps.value = prevOverlayProps;
        } else {
          ctx.overlay.value = null;
          ctx.overlayProps.value = {};
        }
        resolve(value);
      };
      ctx.overlay.value = "ConfirmDialog";
      ctx.overlayProps.value = {
        eyebrow: "Confirm",
        title,
        message,
        confirmLabel,
        cancelLabel,
        danger,
        onCancel: () => finish(false),
        onConfirm: () => finish(true),
      };
    });
  }

  async function saveWorkspace(draft: AnyApi): Promise<void> {
    ctx.payload.value = (await (ctx.getApi() as AnyApi).saveWorkspace(draft)) as StatePayload;
  }

  /**
   * Clear the workspace.review marker so the workspace stops being treated as a
   * PR review checkout. Also strips the auto-set "{Provider} review workspace
   * for ..." notes prefix — the runtime's repair pass uses that prefix as a
   * re-attach hint, so leaving it would let the next poll restore the marker.
   * The PR data on the server is not touched.
   */
  async function detachWorkspaceReview(workspaceId: string): Promise<void> {
    const ws = (ctx.payload.value?.appState?.workspaces || []).find((w: AnyApi) => w.id === workspaceId);
    if (!ws) return;
    const next: AnyApi = { ...(ws as AnyApi), review: null };
    if (/^(Azure DevOps|GitHub) review workspace for /.test(String((ws as AnyApi).notes || ""))) {
      next.notes = "";
    }
    ctx.payload.value = (await (ctx.getApi() as AnyApi).saveWorkspace(next)) as StatePayload;
  }

  /**
   * Optimistic workspace delete.
   *
   * Deleting a worktree-backed workspace (regular worktree, review checkout,
   * quickfix sandbox, task workspace) used to block the UI for 5–20 s while
   * the backend recursively removed thousands of node_modules files. The
   * user couldn't switch tabs, scroll the sidebar, or do anything else
   * during that wait. So now we:
   *
   *   1. Remove the workspace from the local sidebar tree immediately,
   *      switching the active workspace if needed.
   *   2. Fire the delete request in the background. We don't await it.
   *   3. On success: silent — the sidebar already shows the deletion.
   *   4. On error: push a sticky toast with the path and a "Copy path"
   *      button so the user can finish the cleanup in Explorer or a shell.
   *      The toast persists until the user dismisses it; whatever they
   *      switched to in the meantime keeps their attention.
   *
   * Backend-side state is the source of truth: the next broadcast after
   * removal will line up with our optimistic mutation, so nothing sticks
   * around in a half-deleted form.
   */
  async function deleteWorkspace(workspaceId: string): Promise<void> {
    const ws = (ctx.payload.value?.appState?.workspaces || []).find((w: AnyApi) => w.id === workspaceId);
    if (!ws) return;
    const isTaskAgent = (ws as AnyApi).kind === "task";
    const hasOwnWorktree = isTaskAgent && !!(ws as AnyApi).task?.worktreeBase;
    const firstTitle = isTaskAgent ? "Delete task agent" : "Delete workspace";
    // For a task agent without its own worktree, spell out exactly what's
    // touched on disk — only the agent's .strideterm/tasks/{taskId} folder.
    // The base directory and project files are left alone. The previous
    // "Delete workspace 'mhub'?" wording made it sound like the entire
    // workspace directory was about to be removed.
    const firstMessage = isTaskAgent
      ? hasOwnWorktree
        ? `Delete task agent "${(ws as AnyApi).name}"?`
        : `Delete task agent "${(ws as AnyApi).name}"?\n\nOnly the agent's state under .strideterm/tasks is removed. Your project files in ${(ws as AnyApi).cwd || "the workspace directory"} are kept.`
      : `Delete workspace "${(ws as AnyApi).name}"?`;
    const confirmed = await confirmInApp({
      title: firstTitle,
      message: firstMessage,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;

    // Detect worktree-backed kinds — these own a directory on disk that we
    // need to offer to remove. This covers all four variants: plain
    // `git worktree`, review checkout, quickfix sandbox, task agent worktree.
    const isWorktreeChild =
      ((ws as AnyApi).notes || "").startsWith("Worktree of ") ||
      (ws as AnyApi).review?.checkout?.mode === "managed-worktree" ||
      !!(ws as AnyApi).quickfix?.parentWorkspaceId ||
      hasOwnWorktree;
    const worktreePath =
      (ws as AnyApi).review?.checkout?.mode === "managed-worktree" && (ws as AnyApi).review?.checkout?.rootPath
        ? (ws as AnyApi).review.checkout.rootPath
        : (ws as AnyApi).quickfix?.rootPath || "";
    const diskPath = worktreePath || (isWorktreeChild && (ws as AnyApi).cwd ? (ws as AnyApi).cwd : "");

    let deleteFromDisk = false;
    if (diskPath) {
      const secondTitle = isTaskAgent ? "Delete agent worktree files?" : "Delete worktree files?";
      const secondMessage = isTaskAgent
        ? `Also delete the agent's worktree from disk?\n\n${diskPath}`
        : `Also delete the worktree files from disk?\n\n${diskPath}`;
      deleteFromDisk = await confirmInApp({
        title: secondTitle,
        message: secondMessage,
        confirmLabel: "Delete files",
        cancelLabel: "Keep files",
        danger: true,
      });
    }

    // --- Optimistic UI removal ---------------------------------------------
    //
    // Build a payload with the workspace already gone. Use shallow object
    // copies so Vue's reactivity treats this as a fresh ref assignment.
    // We don't need to clone deeply — the components that consume this
    // payload only need the workspaces array to be a new reference for the
    // computed selectors to refresh.
    const wsName = (ws as AnyApi).name || "";
    const wasActive = ctx.payload.value?.appState?.activeWorkspaceId === workspaceId;
    const before = ctx.payload.value;
    const remainingWorkspaces = (before?.appState?.workspaces || []).filter((w: AnyApi) => w.id !== workspaceId);
    const nextActiveId = wasActive ? remainingWorkspaces[0]?.id || "" : before?.appState?.activeWorkspaceId || "";
    // Track the id so any broadcast arriving before the backend finishes the
    // delete (e.g. from a docker poll) doesn't put the workspace back into
    // the sidebar tree.
    ctx.optimisticallyDeletedIds.value = new Set([...ctx.optimisticallyDeletedIds.value, workspaceId]);
    if (before) {
      ctx.payload.value = {
        ...before,
        appState: {
          ...(before.appState as AnyApi),
          workspaces: remainingWorkspaces,
          activeWorkspaceId: nextActiveId,
        },
      } as StatePayload;
    }

    // --- Background deletion ------------------------------------------------
    //
    // Note: not awaited. The user is free to navigate away. Errors land in a
    // sticky toast keyed off the workspace name + path so two failures don't
    // collapse into a single ambiguous error.
    void (async () => {
      try {
        const result = (await (ctx.getApi() as AnyApi).deleteWorkspace(workspaceId, {
          deleteFromDisk,
          diskPath,
        })) as AnyApi;

        if (result?.deleteWorkspaceError) {
          // Backend deleted the workspace from state but couldn't remove
          // disk files. Surface the path + reason so the user can finish.
          // Lazy import keeps this file out of the notifications store's
          // dependency cycle.
          const { useNotificationStore } = await import("./notifications.js");
          useNotificationStore().pushPersistentToast({
            title: `Couldn't remove "${wsName}" from disk`,
            body: result.deleteWorkspaceError,
            kind: "error",
            copyPath: diskPath,
            // Scope to the deleted workspace's own profile — other profiles
            // never saw this workspace and shouldn't see its failure.
            profileId: (ws as AnyApi).profileId || "default",
          });
        }
        // Success path: ignore. The next broadcast will reconcile the payload
        // with what the backend now believes — which already matches our
        // optimistic state. Once the broadcast confirms the backend agrees
        // the workspace is gone, the suppression set self-clears in the
        // broadcast handler. Until then keep it suppressed.
      } catch (err: unknown) {
        const message = (err as { message?: string })?.message || String(err);
        // The IPC call failed outright (couldn't reach backend, schema
        // rejection, runtime threw). The workspace probably still exists
        // server-side, so unflag it and let the next broadcast restore it.
        const next = new Set(ctx.optimisticallyDeletedIds.value);
        next.delete(workspaceId);
        ctx.optimisticallyDeletedIds.value = next;
        const { useNotificationStore } = await import("./notifications.js");
        useNotificationStore().pushPersistentToast({
          title: `Failed to delete "${wsName}"`,
          body: message,
          kind: "error",
          copyPath: diskPath,
          profileId: (ws as AnyApi).profileId || "default",
        });
      }
    })();
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
    if (
      !activeWs ||
      (activeWs as AnyApi).kind === "docker" ||
      (activeWs as AnyApi).kind === "azure" ||
      (activeWs as AnyApi).kind === "github"
    )
      return;

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
    if (
      !activeWs ||
      (activeWs as AnyApi).kind === "docker" ||
      (activeWs as AnyApi).kind === "azure" ||
      (activeWs as AnyApi).kind === "github"
    )
      return;

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
    // The picker is shared between the terminal-toolbar Split button (which
    // operates on the active workspace's tabs) and the WorkspaceLayoutChip in
    // the hero strip (which operates on the multi-workspace grid). Dispatch
    // by the picker's opener mode — see WorkspaceActionsCtx.layoutPickerMode.
    const mode = ctx.layoutPickerMode.value;

    if (mode === "grid" || (mode === "auto" && ctx.isGridVisible.value)) {
      // When the grid is already visible, just re-shape it. Going through
      // the store wrapper pre-empts active-cell truncation before truncation
      // drops cells beyond the new slot count — without that guard a 4 → 2
      // cell shrink would evict the focused workspace and the entire grid
      // would vanish. When the grid is NOT visible yet (chip click in solo
      // mode), boot it with the current workspace in slot 0.
      const dispatch = ctx.isGridVisible.value ? ctx.setGridLayout(layout) : ctx.enableWorkspaceGrid(layout);
      dispatch.catch((err: unknown) => {
        console.error("[grid] picker dispatch failed:", err);
      });
      return;
    }

    // Tab-split path: build a split group from the active tab + siblings.
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
    if (ctx.splitGroup.value.viewIds.length < slots && !ctx.splitGroup.value.viewIds.includes(viewId)) {
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

  async function reorderPanels(draggedViewId: string, dropViewId: string, insertBefore: boolean): Promise<void> {
    const workspace = (ctx.payload.value as AnyApi)?.workspace;
    const draggedTarget = getWorkspacePanelByViewId(draggedViewId, workspace, viewIdHelpers);
    const dropTarget = getWorkspacePanelByViewId(dropViewId, workspace, viewIdHelpers);
    if (!draggedTarget || !dropTarget || (draggedTarget as AnyApi).workspace.id !== (dropTarget as AnyApi).workspace.id)
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

  /**
   * Remove the workspace from the sidebar without touching disk files.
   *
   * The escape hatch for orphan / leftover workspace entries: a previous
   * delete couldn't finish (locked files, partial worktree, manually
   * deleted directory) and the sidebar entry is now useless because the
   * workspace can't be activated. This skips the "delete from disk?"
   * second prompt the regular Delete flow asks, and forwards to the
   * backend with `deleteFromDisk: false` so any remaining files stay
   * exactly where they are. A persistent toast is still shown if the
   * backend reports a failure (e.g. IPC drops).
   *
   * NOTE: This does not persist a "do not re-add" marker. If the cwd
   * still exists and lives under a parent's `.strideterm/tree/`, the
   * worktree-discovery sweep in syncWorktrees will recreate the entry on
   * the next git poll. That case (dir exists but user wants it hidden)
   * is a separate feature; this action is built for the orphan case.
   */
  async function forceRemoveWorkspace(workspaceId: string): Promise<void> {
    const ws = (ctx.payload.value?.appState?.workspaces || []).find((w: AnyApi) => w.id === workspaceId);
    if (!ws) return;
    const wsName = (ws as AnyApi).name || "";
    const confirmed = await confirmInApp({
      title: "Remove workspace",
      message: `Remove "${wsName}" from the sidebar?\n\nFiles on disk are kept untouched.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!confirmed) return;

    const wasActive = ctx.payload.value?.appState?.activeWorkspaceId === workspaceId;
    const before = ctx.payload.value;
    const remainingWorkspaces = (before?.appState?.workspaces || []).filter((w: AnyApi) => w.id !== workspaceId);
    const nextActiveId = wasActive ? remainingWorkspaces[0]?.id || "" : before?.appState?.activeWorkspaceId || "";
    ctx.optimisticallyDeletedIds.value = new Set([...ctx.optimisticallyDeletedIds.value, workspaceId]);
    if (before) {
      ctx.payload.value = {
        ...before,
        appState: {
          ...(before.appState as AnyApi),
          workspaces: remainingWorkspaces,
          activeWorkspaceId: nextActiveId,
        },
      } as StatePayload;
    }

    void (async () => {
      try {
        await (ctx.getApi() as AnyApi).deleteWorkspace(workspaceId, { deleteFromDisk: false });
        // Success: next broadcast reconciles, optimistic suppression self-clears.
      } catch (err: unknown) {
        const message = (err as { message?: string })?.message || String(err);
        const next = new Set(ctx.optimisticallyDeletedIds.value);
        next.delete(workspaceId);
        ctx.optimisticallyDeletedIds.value = next;
        const { useNotificationStore } = await import("./notifications.js");
        useNotificationStore().pushPersistentToast({
          title: `Failed to remove "${wsName}"`,
          body: message,
          kind: "error",
          profileId: (ws as AnyApi).profileId || "default",
        });
      }
    })();
  }

  return {
    confirmInApp,
    saveWorkspace,
    detachWorkspaceReview,
    deleteWorkspace,
    forceRemoveWorkspace,
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

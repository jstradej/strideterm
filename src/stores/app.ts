import { defineStore } from "pinia";
import { ref, shallowRef, computed, watch } from "vue";
import {
  getWorkspaceTabs,
  getVisibleTabs,
  summarizeAttention,
  getWorkspacePanelByViewId,
  getWorkspaceAttention,
  getTabAttention,
} from "../app/selectors.js";
import { LAYOUTS } from "../app/layout-geometry.js";
import {
  readSidebarCollapsed,
  isContainerRunning,
  isGitViewId,
  isDockerViewId,
  isAzureViewId,
  isGitHubViewId,
  isReviewViewId,
  isBrowserViewId,
  isFilesViewId,
  isTaskDashboardViewId,
} from "../app/helpers.js";
import { createDialogActions } from "./app-dialog-actions.js";
import { createWorkspaceActions } from "./app-workspace-actions.js";
import { createApiActions } from "./app-api-actions.js";
import { isMobileViewport } from "../composables/useIsNarrow.js";
import { maybeApplyMockFromUrl } from "./dev-mocks.js";
import { useGitUiStore } from "./git-ui.js";
import { useRemoteDetailsStore } from "./remote-details.js";
import type { StatePayload, RecoveryCandidate } from "../../electron/shared/types/state.js";
import type { Transport } from "../transport.js";
import type { PerformanceSnapshot, CpuProfileCaptureResult, RevealResult } from "../../electron/shared/performance.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

interface SplitGroup {
  layout: string;
  viewIds: string[];
}

interface WorkspacePayloadCache {
  workspace: unknown;
  docker: unknown;
  attention: unknown;
  activeWorkspaceGit: unknown;
}

/**
 * Resolve which profile the CURRENT viewer (this desktop window, or this
 * remote client) is bound to. Single source of truth for "viewer profile"
 * resolution — dialog-actions and api-actions call this (via the
 * resolveViewerProfileId they're handed in their ctx) instead of keeping
 * their own slightly-different copies. Code review 2026-07 §5.4 found 4
 * divergent implementations of this same idea; this is the consolidated
 * one, adopted from this file's original resolveRemoteProfileId +
 * myActiveProfileId pairing (the most defensive of the four — filters out
 * malformed profile entries with no id, and prefers a desktop slot whose
 * profileId still resolves to a real profile over an arbitrary first slot).
 *
 * A pure function (not a store method) so dialog-actions/api-actions can
 * call it without importing from this module (avoiding a circular import,
 * since this module already imports createDialogActions/createApiActions
 * from them) and so it's directly unit-testable without Pinia setup.
 */
export function resolveViewerProfileId(
  sourcePayload: unknown,
  { isRemote, windowId }: { isRemote: boolean; windowId: string },
): string | null {
  const appState = (sourcePayload as AnyApi)?.appState || {};
  const profiles = ((appState.profiles || []) as AnyApi[]).filter((profile) => profile?.id);
  const slots = (appState.windowSlots || []) as AnyApi[];

  if (isRemote) {
    // The remote client is an independent viewer: ANY existing profile is a
    // valid binding — it does not need to be open in a desktop window.
    const remoteProfileId = (sourcePayload as AnyApi)?.remoteClient?.profileId || "";
    if (remoteProfileId && profiles.some((profile) => profile.id === remoteProfileId)) {
      return remoteProfileId;
    }
    // Fallback for stale payloads: prefer a profile open on the desktop,
    // else the first existing profile.
    const openProfileIds = slots.map((slot) => String(slot?.profileId || "")).filter(Boolean);
    return (
      openProfileIds.find((profileId) => profiles.some((profile) => profile.id === profileId)) ||
      profiles[0]?.id ||
      null
    );
  }

  const slot = windowId ? slots.find((s: AnyApi) => s.id === windowId) : null;
  return slot?.profileId || null;
}

export const useAppStore = defineStore("app", () => {
  // --- This window's identity (injected via additionalArguments in preload) ---
  const myWindowId = (window as AnyApi).strideterm?.startupFlags?.windowId || "";

  // Structured renderer logging — routes through the preload's `log:renderer`
  // channel into the main-process logger, where it appears in strideterm.log
  // tagged `[renderer]`. Inlined here so the activation flow (and related
  // multi-window/profile transitions) can be analysed from the dev log
  // without attaching DevTools.

  function rlog(level: "debug" | "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
    try {
      (window as AnyApi).strideterm?.logRenderer?.(level, msg, { windowId: myWindowId, ...(meta || {}) });
    } catch {
      // Logging must never break callers; swallow IPC teardown / preload-gone cases.
    }
  }

  // --- Server payload (shallowRef for performance — never deeply reactive) ---
  const payload = shallowRef<StatePayload | null>(null);

  // Bootstrap→WS handoff (remote slim core): apply a broadcast snapshot only when
  // its coreRevision is newer than the last one applied. The HTTP bootstrap sets
  // the baseline, so the post-bootstrap WS stream provably applies only newer
  // state and a snapshot that raced the bootstrap (or arrived out of order after
  // a reconnect) is dropped rather than stomping fresher state. Non-remote
  // payloads and legacy cores (no coreRevision) are never gated.
  let lastAppliedCoreRevision = -1;
  function acceptCoreRevision(next: unknown): boolean {
    if (!isRemoteTransport.value) return true;
    const rev = (next as AnyApi)?.coreRevision;
    if (typeof rev !== "number") return true;
    if (rev <= lastAppliedCoreRevision) return false;
    lastAppliedCoreRevision = rev;
    return true;
  }

  // --- UI state ---
  const activeViewId = ref<string | null>(null);
  const activeSessionId = ref<string | null>(null);
  const splitGroup = ref<SplitGroup | null>(null); // { layout, viewIds } | null
  const hiddenViewIds = ref(new Set<string>());
  const sidebarCollapsed = ref(readSidebarCollapsed());
  const overlay = ref<string | null>(null); // Vue component name string | null
  const overlayProps = ref<Record<string, unknown>>({});
  const bootstrapError = ref("");
  const remoteConnectionIssue = ref("");
  const remoteAccessMode = ref("lan"); // "lan" | "cloudflare" | "vps"
  const selectedLanUrl = ref("");
  const contextMenu = ref<{ x: number; y: number; viewId: string } | null>(null); // { x, y, viewId } | null
  const layoutPickerAnchor = ref<DOMRect | null>(null); // DOMRect | null (for positioning)
  // Which picker semantics to use when the user makes a selection:
  //   "grid"  — always operate on the multi-workspace grid (enable / change layout)
  //   "split" — always operate on the active workspace's tab-split group
  //   "auto"  — legacy behaviour: dispatch by current state (grid layout if the
  //             grid is visible, otherwise tab-split). Used by the
  //             terminal-toolbar Split button.
  // Set when the picker is opened, read by pickLayout.
  const layoutPickerMode = ref<"grid" | "split" | "auto">("auto");
  const starFilterActive = ref(false);

  // --- Task recovery ---
  const recoveryCandidates = ref<RecoveryCandidate[]>([]);

  // Deep-link request to focus a specific review connection inside its
  // provider inbox pane — set when the user clicks a "connection error"
  // notification so the pane can switch to its Connections tab and highlight
  // the offending connection. Consumed (cleared) by the matching pane. `ts`
  // guards against a stale request forcing the Connections tab much later
  // when the user opens that inbox for unrelated reasons.
  const inboxConnectionFocus = ref<{ provider: string; connectionId: string; ts: number } | null>(null);
  function requestInboxConnectionFocus(provider: string, connectionId: string): void {
    if (!connectionId) return;
    inboxConnectionFocus.value = { provider: provider || "", connectionId, ts: Date.now() };
  }

  // --- Race condition prevention ---
  const pendingWorkspaceActivationId = ref("");
  const pendingViewActivationId = ref("");
  const suppressBroadcast = ref(false);
  // Workspaces the UI removed optimistically, awaiting backend confirmation.
  // Until the backend completes the delete, unrelated broadcasts (git poll,
  // docker poll) still carry the deleted workspace and would otherwise
  // re-introduce it into the sidebar tree mid-deletion.
  const optimisticallyDeletedIds = ref(new Set<string>());

  // --- Workspace state cache (avoids tab-status flicker on switch) ---
  // Stores workspace-specific payload parts keyed by workspace ID.
  // On switch-back, cached data is restored instantly during the optimistic phase,
  // so tabs keep their real statuses ("running"/"idle") instead of flashing to "idle".
  const _workspacePayloadCache = new Map<string, WorkspacePayloadCache>();

  // --- Per-workspace split layout cache ---
  // Preserves split configuration when switching away from a workspace,
  // so the layout is restored when the user returns.
  const _splitGroupCache = new Map<string, SplitGroup>();

  // --- Internal api reference (set in init) ---
  let _api: Transport | null = null;
  const isRemoteTransport = ref(false);
  // True only when the transport exposes Electron process metrics — i.e. the
  // desktop transport. The Performance panel/tab is gated on this so the remote
  // client never shows a dead tab. Set once in init(); never changes after.
  const supportsPerformanceMetrics = ref(false);

  /** Getter so action modules can access _api after init(). */
  function getApi(): Transport {
    return _api!;
  }

  // --- Memoized computed ---
  // These computed properties return the same reference when the result is structurally
  // identical, preventing unnecessary downstream re-renders on every payload broadcast.

  // --- Memoized computed ---
  // These return the same reference when the result is structurally identical,
  // preventing unnecessary downstream re-renders on every payload broadcast.
  // Each fingerprint must include ALL fields that downstream consumers read.

  const activeWorkspace = computed(() => {
    const ws = (payload.value as AnyApi)?.workspace;
    return ws?.workspace || ws?.project || null;
  });

  /** The window slot for this renderer instance. */
  const myWindowSlot = computed(() => {
    const slots = (payload.value?.appState as AnyApi)?.windowSlots as AnyApi[] | undefined;
    if (!slots || !myWindowId) return null;
    return slots.find((s: AnyApi) => s.id === myWindowId) ?? null;
  });

  function resolveRemoteWorkspaceId(sourcePayload: StatePayload | null = payload.value): string {
    const remoteClient = (sourcePayload as AnyApi)?.remoteClient;
    const workspaces = ((sourcePayload as AnyApi)?.appState?.workspaces || []) as AnyApi[];
    const profileId = resolveViewerProfileId(sourcePayload, { isRemote: true, windowId: myWindowId });
    // A remote client must NEVER fall back to the global appState.activeWorkspaceId:
    // that value tracks the DESKTOP's selection, so falling back to it made the
    // mobile view snap to whatever workspace the desktop had open — and flip-flop
    // back and forth whenever both were active. When this client's own
    // activeWorkspaceId is absent, resolve to the first workspace of its profile
    // instead (the `workspaces.find(profile)` fallback at the end of this function).
    const activeWorkspaceId = remoteClient?.activeWorkspaceId || "";
    const activeWorkspace = activeWorkspaceId ? workspaces.find((ws: AnyApi) => ws.id === activeWorkspaceId) : null;
    if (activeWorkspace && (activeWorkspace.profileId || "default") === profileId) return activeWorkspaceId;
    return workspaces.find((ws: AnyApi) => (ws.profileId || "default") === profileId)?.id || "";
  }

  /** ActiveWorkspaceId scoped to this window or remote client context. */
  const myActiveWorkspaceId = computed<string>(() => {
    if (isRemoteTransport.value) {
      return resolveRemoteWorkspaceId();
    }
    return (
      myWindowSlot.value?.activeWorkspaceId || (payload.value?.appState?.activeWorkspaceId as string | undefined) || ""
    );
  });

  /** ActiveProfileId scoped to this window or remote client context. Null when no profile context is available. */
  const myActiveProfileId = computed<string | null>(() =>
    resolveViewerProfileId(payload.value, { isRemote: isRemoteTransport.value, windowId: myWindowId }),
  );

  let _prevFilteredWsKey = "";
  let _prevFilteredWs: AnyApi[] = [];
  const filteredWorkspaces = computed(() => {
    const workspaces = payload.value?.appState?.workspaces || [];
    if (isRemoteTransport.value && !myActiveProfileId.value) return [];
    const activeProfileId =
      myActiveProfileId.value ??
      ((payload.value?.appState?.profiles as AnyApi[] | undefined)?.[0] as AnyApi)?.id ??
      "default";
    const result = workspaces.filter((ws: AnyApi) => (ws.profileId || "default") === activeProfileId);
    // Include names, panel counts, and badge/accent — these change on
    // rename/add-tab/remove-tab and on editing the workspace icon/color.
    const key = result
      .map(
        (ws: AnyApi) =>
          `${ws.id}:${ws.name}:${(ws.panels || []).length}:${ws.connectionId || ""}:${ws.starred ? 1 : 0}:${ws.icon || ""}:${ws.color || ""}`,
      )
      .join(",");
    if (key === _prevFilteredWsKey) return _prevFilteredWs;
    _prevFilteredWsKey = key;
    _prevFilteredWs = result;
    return result;
  });

  let _prevProfileKey = "";
  let _prevProfile: AnyApi = null;
  const activeProfile = computed(() => {
    const profiles = payload.value?.appState?.profiles || [];
    const activeId = myActiveProfileId.value;
    const found = profiles.find((p: AnyApi) => p.id === activeId) ||
      profiles[0] || {
        id: "default",
        name: activeId || "Profile",
        color: "#ffa424",
      };
    const key = `${(found as AnyApi).id}:${(found as AnyApi).name}:${(found as AnyApi).color}`;
    if (key === _prevProfileKey && _prevProfile) return _prevProfile;
    _prevProfileKey = key;
    _prevProfile = found;
    return found;
  });

  // --- Workspace grid computed ---

  const workspaceGrid = computed(() => {
    // The grid is viewer-owned: each desktop window reads its own slot's
    // grid, a remote client reads the grid from its remoteClient context.
    // Two windows of the same profile therefore keep independent layouts.
    // The legacy per-profile grid (and the deprecated global) are only
    // fallbacks for pre-migration payloads where the viewer field is absent.
    if (isRemoteTransport.value) {
      const remoteGrid = (payload.value as AnyApi)?.remoteClient?.workspaceGrid;
      if (remoteGrid !== undefined) return remoteGrid;
    } else {
      const slot = myWindowSlot.value as AnyApi | null;
      if (slot && slot.workspaceGrid !== undefined) return slot.workspaceGrid;
    }
    const profile = (payload.value?.appState?.profiles as AnyApi[] | undefined)?.find(
      (p: AnyApi) => p.id === myActiveProfileId.value,
    );
    const profileGrid = (profile as AnyApi)?.workspaceGrid;
    if (profile && profileGrid !== undefined) return profileGrid;
    return (payload.value as AnyApi)?.appState?.workspaceGrid ?? null;
  });

  const isGridVisible = computed<boolean>(() => {
    const grid = workspaceGrid.value;
    if (!grid) return false;
    const activeWsId = myActiveWorkspaceId.value;
    return activeWsId ? (grid.cellWorkspaceIds as (string | null)[]).includes(activeWsId) : false;
  });

  const gridCellWorkspaces = computed<(AnyApi | null)[]>(() => {
    const grid = workspaceGrid.value;
    if (!grid) return [];
    const wsById = new Map(((payload.value as AnyApi)?.appState?.workspaces || []).map((ws: AnyApi) => [ws.id, ws]));
    return (grid.cellWorkspaceIds as (string | null)[]).map((id) => (id ? (wsById.get(id) ?? null) : null));
  });

  const focusedGridCellIndex = computed<number>(() => {
    const grid = workspaceGrid.value;
    if (!grid) return -1;
    const activeWsId = myActiveWorkspaceId.value;
    return activeWsId ? (grid.cellWorkspaceIds as (string | null)[]).indexOf(activeWsId) : -1;
  });

  // --- Grid actions ---

  async function enableWorkspaceGrid(layout: string, preset?: { workspaceIds: (string | null)[] }): Promise<void> {
    const activeWsId: string | null = myActiveWorkspaceId.value || null;
    const ids: (string | null)[] = preset?.workspaceIds ?? [activeWsId, null, null, null];
    if (preset?.workspaceIds) {
      const firstNonNull = ids.find((id) => id != null);
      if (firstNonNull) await activateWorkspace(firstNonNull);
    }
    await (_api as AnyApi)?.enableWorkspaceGrid?.(layout, ids);
  }

  async function disableWorkspaceGrid(): Promise<void> {
    await (_api as AnyApi)?.disableWorkspaceGrid?.();
  }

  async function setGridLayout(layout: string): Promise<void> {
    // Backend setGridLayout truncates cellWorkspaceIds to the new layout's
    // slot count, taking the first N non-null entries. If the active
    // workspace lives in a cell that won't survive truncation, the active
    // would end up not-in-grid → isGridVisible flips false → entire grid
    // vanishes. Pre-empt that by reassigning activeWorkspaceId to the first
    // kept workspace before the layout change is committed, so the grid
    // stays visible across the layout swap.
    const grid = workspaceGrid.value;
    const activeWsId = myActiveWorkspaceId.value;
    if (grid && activeWsId) {
      const newSlots = LAYOUTS[layout]?.slots;
      if (newSlots) {
        const nonNull = (grid.cellWorkspaceIds as (string | null)[]).filter((id): id is string => id !== null);
        const kept = nonNull.slice(0, newSlots);
        if (kept.length > 0 && !kept.includes(activeWsId)) {
          await activateWorkspace(kept[0]);
        }
      }
    }
    await (_api as AnyApi)?.setGridLayout?.(layout);
  }

  async function setGridCell(cellIndex: number, workspaceId: string | null): Promise<void> {
    await (_api as AnyApi)?.setGridCell?.(cellIndex, workspaceId);
  }

  async function swapGridCells(a: number, b: number): Promise<void> {
    await (_api as AnyApi)?.swapGridCells?.(a, b);
  }

  /**
   * Activate a workspace from a user-driven UI surface (sidebar click,
   * keyboard cycle). When the workspace grid is visible and the target is
   * not already in a cell, drop it into:
   *   1. the first empty cell (additive — no eviction), OR
   *   2. the currently focused cell (replace it, when grid is full).
   * This keeps the grid layout pinned. Without this wrapper, activation
   * would flip `isGridVisible` to false and the entire grid would vanish
   * into a single-pane PaneStage — surprising UX after the user spent
   * effort wiring up a split.
   *
   * Server-driven / bootstrap paths should keep calling
   * `activateWorkspace` directly so they don't reshuffle cells.
   */
  async function activateWorkspaceInGrid(workspaceId: string): Promise<void> {
    if (isGridVisible.value) {
      const ids = (workspaceGrid.value?.cellWorkspaceIds || []) as (string | null)[];
      if (!ids.includes(workspaceId)) {
        const emptyIdx = ids.indexOf(null);
        const targetIdx = emptyIdx >= 0 ? emptyIdx : Math.max(0, focusedGridCellIndex.value);
        await setGridCell(targetIdx, workspaceId);
      }
    }
    await activateWorkspace(workspaceId);
  }

  // --------------------------------

  let _prevAttention = { count: 0, waitingCount: 0 };
  const attentionSummary = computed(() => {
    // Scope to this window's active profile so the in-app badge / document
    // title don't include alerts the user can't see (workspaces in other
    // profiles). `otherProfileAttentionCount` separately exposes the
    // out-of-profile count for the ProfileBar indicator.
    const next = summarizeAttention(payload.value, myActiveProfileId.value || undefined);
    if (next.count === _prevAttention.count && next.waitingCount === _prevAttention.waitingCount) {
      return _prevAttention;
    }
    _prevAttention = next;
    return next;
  });

  // Count attention alerts whose workspace lives in a profile other than the
  // active one. Drives the small "work elsewhere" indicator on the ProfileBar
  // so background task agents in inactive profiles aren't invisible.
  const otherProfileAttentionCount = computed<number>(() => {
    const p = payload.value;
    if (!p) return 0;
    const activeId = myActiveProfileId.value;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-only attention shape
    const byWorkspace = (p.attention as any)?.byWorkspace as Record<string, { alerts?: unknown[] }> | undefined;
    if (!byWorkspace) return 0;
    const workspaces = (p.appState?.workspaces || []) as AnyApi[];
    const profileByWs = new Map<string, string>();
    for (const ws of workspaces) profileByWs.set(ws.id, ws.profileId || "default");
    let count = 0;
    for (const [wsId, entry] of Object.entries(byWorkspace)) {
      const profileId = profileByWs.get(wsId) || "default";
      if (profileId === activeId) continue;
      count += entry?.alerts?.length || 0;
    }
    return count;
  });

  let _prevTabsKey = "";
  let _prevTabs: AnyApi[] = [];
  const workspaceTabs = computed(() => {
    const workspace = (payload.value as AnyApi)?.workspace;
    if (!workspace) return [];
    const result = getWorkspaceTabs({
      workspace,
      payload: payload.value,
      hiddenViewIds: hiddenViewIds.value,
      isContainerRunning,
      // On the remote slim core the git/docker/provider tab data lives in
      // summaries + on-demand detail, not in `payload` — route through the
      // transport-aware accessors. On desktop these read the full payload.
      accessors: { gitSummary: getGitSummary, dockerCounts, providerInbox },
    });
    // Fingerprint includes all visible fields: id, title, status, tone
    const key = (result as AnyApi[]).map((t: AnyApi) => `${t.id}:${t.type}:${t.title}:${t.status}:${t.tone}`).join("|");
    if (key === _prevTabsKey) return _prevTabs;
    _prevTabsKey = key;
    _prevTabs = result as AnyApi[];
    return result;
  });

  const visibleTabs = computed<AnyApi[]>(() => {
    const result = getVisibleTabs({
      tabs: workspaceTabs.value,
      activeViewId: activeViewId.value,
      splitGroup: splitGroup.value,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isInSplitGroup: (viewId: string | null, sg: any) => (viewId ? sg?.viewIds?.includes(viewId) : false) || false,
      // On phone-width / short viewports we collapse splits to just the active
      // tab so the user does not have to manually unsplit (the 3-pane task
      // agent layout did not fit a phone). The splitGroup state itself stays
      // intact, so resizing back to desktop restores the full layout.
      forceSoloLayout: isMobileViewport.value,
    });
    return (result as AnyApi).visibleTabs;
  });

  // Auto-mark notifications as read when switching to the relevant tab
  watch(activeViewId, async (viewId) => {
    if (!viewId) return;
    try {
      const { useNotificationStore } = await import("./notifications.js");
      const notifStore = useNotificationStore();
      for (const item of notifStore.items) {
        if (!item.read && item.viewId && item.viewId === viewId) {
          notifStore.markRead(item.id);
        }
      }
    } catch {
      // Notification store may not be available during bootstrap
    }
  });

  // Keep per-workspace split cache in sync with current splitGroup
  watch(splitGroup, (next) => {
    const wsId = myActiveWorkspaceId.value;
    if (!wsId) return;
    if (next) {
      _splitGroupCache.set(wsId, next);
    } else {
      _splitGroupCache.delete(wsId);
    }
    // Persist to backend so the layout survives restarts (fire-and-forget).
    // Skip while a workspace activation is pending — the splitGroup update during
    // that window is just us restoring the persisted state, not a user change.
    if (pendingWorkspaceActivationId.value) return;
    if ((_api as AnyApi)?.setWorkspaceUIState) {
      (_api as AnyApi)
        .setWorkspaceUIState(wsId, {
          splitLayout: next?.layout || null,
          splitViewIds: next?.viewIds ? [...next.viewIds] : [],
        })
        .catch(() => {});
    }
  });

  // Normalize activeViewId and splitGroup when tabs change
  watch(workspaceTabs, (tabs: AnyApi[]) => {
    const validIds = new Set((tabs as AnyApi[]).map((t: AnyApi) => t.id));
    if (!activeViewId.value || !validIds.has(activeViewId.value)) {
      activeViewId.value = (tabs as AnyApi[])[0]?.id || null;
    }
    if (splitGroup.value) {
      const validSplitIds = splitGroup.value.viewIds.filter((id) => validIds.has(id));
      if (validSplitIds.length < 2) {
        splitGroup.value = null;
      } else if (validSplitIds.length !== splitGroup.value.viewIds.length) {
        splitGroup.value = { ...splitGroup.value, viewIds: validSplitIds };
      }
    }
  });

  // Sync document theme attribute when settings change
  let _lastAppliedTheme = "";
  watch(
    () => payload.value?.appState?.settings?.theme,
    (theme) => {
      const resolved =
        theme === "system"
          ? window.matchMedia?.("(prefers-color-scheme: light)").matches
            ? "light"
            : "dark"
          : theme || "dark";
      if (resolved === _lastAppliedTheme) return;
      _lastAppliedTheme = resolved;
      if (resolved === "light") {
        document.documentElement.setAttribute("data-theme", "light");
      } else {
        document.documentElement.removeAttribute("data-theme");
      }
      // Let terminal panes know the theme changed
      window.dispatchEvent(new CustomEvent("strideterm:theme-changed"));
    },
    { immediate: true },
  );

  // --- Helpers ---

  /** Save workspace-specific payload parts for the current workspace. */
  function _cacheCurrentWorkspace(): void {
    const p = payload.value as AnyApi;
    const wsId = myActiveWorkspaceId.value;
    if (!wsId || !p?.workspace) return;
    _workspacePayloadCache.set(wsId, {
      workspace: p.workspace,
      docker: p.docker,
      attention: p.attention,
      activeWorkspaceGit: p.git?.activeWorkspace,
    });
  }

  function buildWorkspacePayloadSnapshot(
    workspaceId: string,
    sourcePayload: StatePayload | null = payload.value,
  ): AnyApi {
    const appState = sourcePayload?.appState;
    if (!appState) return null;
    const workspace = (appState.workspaces || []).find((ws: AnyApi) => ws.id === workspaceId);
    if (!workspace) return null;

    // Strategy 2: return full cached workspace payload if available
    const cached = _workspacePayloadCache.get(workspaceId);
    if (cached?.workspace) return cached.workspace;

    // Strategy 1 fallback: build snapshot, no cache → status stays "idle"
    return {
      workspace,
      project: workspace,
      sessions: ((workspace as AnyApi).panels || [])
        .filter((panel: AnyApi) => !/^https?:\/\//i.test(panel.command || ""))
        .map((panel: AnyApi) => ({
          sessionId: `${(workspace as AnyApi).id}:${panel.id}`,
          panelId: panel.id,
          title: panel.title,
          command: panel.command,
          launch: panel.launch,
          startup: panel.startup,
          status: "idle",
        })),
    };
  }

  function getWindowWorkspaceIdFromPayload(sourcePayload: StatePayload | null): string {
    if (isRemoteTransport.value) {
      return resolveRemoteWorkspaceId(sourcePayload);
    }
    const appState = sourcePayload?.appState as AnyApi | undefined;
    const slots = appState?.windowSlots as AnyApi[] | undefined;
    const slot = myWindowId && slots ? slots.find((s: AnyApi) => s.id === myWindowId) : null;
    return slot?.activeWorkspaceId || appState?.activeWorkspaceId || "";
  }

  function scopePayloadToWindow(sourcePayload: StatePayload): StatePayload {
    const workspaceId = getWindowWorkspaceIdFromPayload(sourcePayload);
    if (!workspaceId) return sourcePayload;
    const currentWorkspaceId =
      ((sourcePayload as AnyApi).workspace?.workspace || (sourcePayload as AnyApi).workspace?.project)?.id || "";
    if (currentWorkspaceId === workspaceId) return sourcePayload;
    const cached = _workspacePayloadCache.get(workspaceId);
    return {
      ...(sourcePayload as AnyApi),
      workspace: cached?.workspace || buildWorkspacePayloadSnapshot(workspaceId, sourcePayload),
    } as StatePayload;
  }

  function isSessionViewIdFor(viewId: string, workspaceId: string): boolean {
    if (typeof viewId !== "string" || !viewId || !workspaceId) return false;
    if (isGitViewId(viewId) || isDockerViewId(viewId) || isAzureViewId(viewId) || isGitHubViewId(viewId)) return false;
    if (isReviewViewId(viewId) || isBrowserViewId(viewId) || isFilesViewId(viewId) || isTaskDashboardViewId(viewId))
      return false;
    return viewId.startsWith(`${workspaceId}:`);
  }

  function resolveSplitForWorkspace(workspaceEntry: AnyApi, workspaceId: string): SplitGroup | null {
    if (
      workspaceEntry?.splitLayout &&
      Array.isArray(workspaceEntry.splitViewIds) &&
      workspaceEntry.splitViewIds.length >= 2
    ) {
      return { layout: workspaceEntry.splitLayout, viewIds: [...workspaceEntry.splitViewIds] };
    }
    const cached = _splitGroupCache.get(workspaceId);
    if (cached) return cached;
    if (workspaceEntry?.kind === "task" && workspaceEntry.panels?.length >= 3) {
      const viewIds = workspaceEntry.panels.slice(0, 3).map((p: AnyApi) => {
        if (p.command === "__task-dashboard__") return `task-dashboard:${p.id}`;
        return `${workspaceId}:${p.id}`;
      });
      return { layout: "top-split", viewIds };
    }
    if (workspaceEntry?.kind === "task" && workspaceEntry.panels?.length >= 2) {
      const viewIds = workspaceEntry.panels.slice(0, 2).map((p: AnyApi) => {
        if (p.command === "__task-dashboard__") return `task-dashboard:${p.id}`;
        return `${workspaceId}:${p.id}`;
      });
      return { layout: "cols", viewIds };
    }
    return null;
  }

  function applyWorkspaceUIStateFromEntry(wsEntry: AnyApi, workspaceId: string, { optimisticOnly = false } = {}): void {
    if (!workspaceId) return;
    const nextSplit = resolveSplitForWorkspace(wsEntry, workspaceId);
    splitGroup.value = nextSplit;
    if (nextSplit) _splitGroupCache.set(workspaceId, nextSplit);

    if (pendingViewActivationId.value) return;
    const storedViewId = wsEntry?.activeViewId || "";
    const fallbackViewId = wsEntry?.activePanelId ? `${workspaceId}:${wsEntry.activePanelId}` : "";
    let nextViewId = storedViewId || fallbackViewId || null;

    // Azure / GitHub workspaces have exactly one virtual tab — `azure:<id>` or
    // `github:<id>` (see src/app/selectors.ts). The persisted `activePanelId`
    // is a terminal-panel reference that doesn't correspond to any real tab
    // in the strip; without this override the inbox renders blank until the
    // user manually clicks the only tab. Always force the canonical viewId.
    if (wsEntry?.kind === "azure") {
      nextViewId = `azure:${workspaceId}`;
    } else if (wsEntry?.kind === "github") {
      nextViewId = `github:${workspaceId}`;
    }

    // Mobile override: on a phone-width viewport, task workspaces always
    // open on the Dashboard tab regardless of the persisted active view.
    // The 3-pane split collapses to one pane (forceSoloLayout) and the
    // persisted view is often Worker/Judge terminal — Dashboard is the
    // useful entry point. Runtime-only, not pushed to setWorkspaceUIState,
    // so the desktop preference is preserved when the viewport widens.
    // Skipped during optimisticOnly because the task-dashboard tab is not
    // in the workspaceTabs list yet (selectors fill it in once the real
    // payload arrives).
    if (!optimisticOnly && isMobileViewport.value && wsEntry?.kind === "task") {
      const dashPanel = (wsEntry?.panels || []).find((p: AnyApi) => p?.command === "__task-dashboard__");
      if (dashPanel?.id) {
        nextViewId = `task-dashboard:${dashPanel.id}`;
      }
    }

    if (!nextViewId) return;
    // Optimistic phase: the workspace snapshot lacks git/docker/azure data, so
    // special-prefix tabs aren't yet in the tabs list and the workspaceTabs watcher
    // would stomp them. Restore only session IDs here; handleBroadcastPayload and
    // activateWorkspace's await path restore the rest once the real payload arrives.
    if (optimisticOnly && !isSessionViewIdFor(nextViewId, workspaceId)) {
      if (fallbackViewId) {
        activeViewId.value = fallbackViewId;
        activeSessionId.value = fallbackViewId;
      }
      return;
    }
    activeViewId.value = nextViewId;
    activeSessionId.value = isSessionViewIdFor(nextViewId, workspaceId) ? nextViewId : null;
  }

  function applyOptimisticWorkspaceActivation(workspaceId: string): boolean {
    const appState = payload.value?.appState;
    if (!appState || !(appState.workspaces || []).some((ws: AnyApi) => ws.id === workspaceId)) {
      rlog("debug", "ws-activate optimistic: workspace missing in payload, bailing", {
        workspaceId,
        knownWorkspaceCount: appState?.workspaces?.length || 0,
      });
      return false;
    }
    rlog("debug", "ws-activate optimistic: applying", {
      workspaceId,
      prevMyActiveWsId: myActiveWorkspaceId.value,
      prevPendingId: pendingWorkspaceActivationId.value,
      myProfileId: myActiveProfileId.value,
      slotProfileId: myWindowSlot.value?.profileId || null,
    });

    // Cache current workspace state before switching away
    _cacheCurrentWorkspace();

    pendingWorkspaceActivationId.value = workspaceId;

    const cached = _workspacePayloadCache.get(workspaceId);
    const prevGit = (payload.value as AnyApi).git;
    // In remote mode, update remoteClient context instead of windowSlots.
    // In Electron mode, optimistically update the per-window slot.
    let updatedWindowSlots = appState.windowSlots as AnyApi[] | undefined;
    let updatedRemoteClient = (payload.value as AnyApi).remoteClient;
    if (isRemoteTransport.value) {
      updatedRemoteClient = updatedRemoteClient
        ? { ...updatedRemoteClient, activeWorkspaceId: workspaceId }
        : undefined;
    } else if (myWindowId && Array.isArray(appState.windowSlots)) {
      updatedWindowSlots = (appState.windowSlots as AnyApi[]).map((s: AnyApi) =>
        s.id === myWindowId ? { ...s, activeWorkspaceId: workspaceId } : s,
      );
    }
    payload.value = {
      ...(payload.value as AnyApi),
      appState: {
        ...appState,
        activeWorkspaceId: workspaceId,
        activeProjectId: workspaceId,
        ...(updatedWindowSlots !== undefined ? { windowSlots: updatedWindowSlots } : {}),
      },
      ...(updatedRemoteClient !== undefined ? { remoteClient: updatedRemoteClient } : {}),
      workspace: buildWorkspacePayloadSnapshot(workspaceId),
      // Restore cached workspace-specific data (docker, attention, active git)
      ...(cached
        ? {
            docker: cached.docker ?? (payload.value as AnyApi).docker,
            attention: cached.attention ?? (payload.value as AnyApi).attention,
            git: {
              ...prevGit,
              activeWorkspace: cached.activeWorkspaceGit ?? prevGit?.activeWorkspace,
            },
          }
        : {}),
    } as StatePayload;

    const wsEntry = (appState.workspaces || []).find((ws: AnyApi) => ws.id === workspaceId);
    applyWorkspaceUIStateFromEntry(wsEntry, workspaceId, { optimisticOnly: true });
    return true;
  }

  // --- Broadcast handler ---
  function handleBroadcastPayload(nextPayload: StatePayload): void {
    // Drop a stale/out-of-order remote snapshot before any side effect — a
    // snapshot older than what we've already applied must not drive activation
    // completion or overwrite fresher state (bootstrap→WS handoff).
    if (!acceptCoreRevision(nextPayload)) return;
    const pendingWsId = pendingWorkspaceActivationId.value;
    const isBootstrap = Boolean((nextPayload as AnyApi)?.meta?.bootstrap);

    // Derive the workspace ID that is active in THIS window / remote client from the incoming payload.
    const incomingSlots = (nextPayload as AnyApi)?.appState?.windowSlots as AnyApi[] | undefined;
    const incomingSlot = myWindowId && incomingSlots ? incomingSlots.find((s: AnyApi) => s.id === myWindowId) : null;
    // Remote: derive the active workspace exactly like myActiveWorkspaceId does
    // (resolveRemoteWorkspaceId), so the broadcast handler and the computed view
    // agree. Critically this no longer falls back to the global
    // appState.activeWorkspaceId — see resolveRemoteWorkspaceId for why that
    // desktop-global fallback caused the mobile workspace to flip-flop.
    const incomingMyWsId: string = isRemoteTransport.value
      ? resolveRemoteWorkspaceId(nextPayload)
      : incomingSlot?.activeWorkspaceId || (nextPayload as AnyApi)?.appState?.activeWorkspaceId || "";

    if (pendingWsId && incomingMyWsId && incomingMyWsId !== pendingWsId) {
      rlog("debug", "ws-activate broadcast: skipped, mismatched pending", {
        pendingWsId,
        incomingMyWsId,
        incomingSlotProfileId: incomingSlot?.profileId || null,
        bootstrap: isBootstrap,
      });
      return;
    }
    const completingActivation = pendingWsId && incomingMyWsId === pendingWsId && !isBootstrap;
    if (completingActivation) {
      rlog("debug", "ws-activate broadcast: completing pending", {
        pendingWsId,
        incomingMyWsId,
        incomingSlotProfileId: incomingSlot?.profileId || null,
      });
      pendingWorkspaceActivationId.value = "";
    }

    bootstrapError.value = "";
    clearRemoteConnectionIssue();

    const workspaceChanged = incomingMyWsId !== myActiveWorkspaceId.value;
    if (workspaceChanged || completingActivation) {
      // activateWorkspace() already cached the outgoing workspace's split
      // BEFORE optimistic activation swapped splitGroup.value. Caching here
      // would overwrite that with the NEW workspace's split under the OLD
      // workspace id — the same bug that ate the layout on every switch.
      const nextWsId = incomingMyWsId;
      const nextWsEntry = nextWsId
        ? ((nextPayload as AnyApi)?.appState?.workspaces || []).find((ws: AnyApi) => ws.id === nextWsId)
        : null;
      applyWorkspaceUIStateFromEntry(nextWsEntry, nextWsId);
    }

    if (pendingViewActivationId.value) {
      const nextWorkspace = (scopePayloadToWindow(nextPayload) as AnyApi)?.workspace;
      const nextTabs = nextWorkspace
        ? getWorkspaceTabs({
            workspace: nextWorkspace,
            payload: nextPayload,
            hiddenViewIds: hiddenViewIds.value,
            isContainerRunning,
          })
        : [];
      if (!(nextTabs as AnyApi[]).some((tab: AnyApi) => tab.id === pendingViewActivationId.value)) return;
      activeViewId.value = pendingViewActivationId.value;
      activeSessionId.value = pendingViewActivationId.value;
      if (!isBootstrap) pendingViewActivationId.value = "";
    }

    if (suppressBroadcast.value) {
      rlog("debug", "ws-activate broadcast: payload write suppressed", {
        pendingWsId,
        incomingMyWsId,
        incomingSlotProfileId: incomingSlot?.profileId || null,
      });
      return;
    }
    // Strip out workspaces that the user just optimistically deleted but the
    // backend hasn't finished removing yet. Without this, every interim
    // broadcast would re-introduce the workspace into the sidebar until the
    // delete IPC call finally lands — visible as a "delete, flicker back,
    // then re-delete" cycle that defeats the whole optimistic UX.
    if (optimisticallyDeletedIds.value.size > 0 && (nextPayload as AnyApi)?.appState?.workspaces) {
      // Snapshot the workspace IDs the BACKEND reports BEFORE we strip,
      // because the "have I seen the delete land?" check below has to be
      // answered from the backend's view, not from our locally rewritten
      // payload. Earlier this read the stripped payload, so the very first
      // interim broadcast (where the backend was still mid-delete) would
      // clear the optimistic flag — and the next interim broadcast would
      // flicker the deleted workspace back into the sidebar. With the
      // longer backend pending window the same-cwd guard introduced, that
      // flicker became multi-frame visible.
      const incomingIds = ((nextPayload as AnyApi).appState.workspaces as AnyApi[]).map((w: AnyApi) => w.id);
      const stripped = ((nextPayload as AnyApi).appState.workspaces as AnyApi[]).filter(
        (w: AnyApi) => !optimisticallyDeletedIds.value.has(w.id),
      );
      if (stripped.length !== ((nextPayload as AnyApi).appState.workspaces as AnyApi[]).length) {
        const incomingActive = incomingMyWsId;
        const nextActiveId = optimisticallyDeletedIds.value.has(incomingActive)
          ? stripped[0]?.id || ""
          : incomingActive;
        nextPayload = {
          ...(nextPayload as AnyApi),
          appState: {
            ...((nextPayload as AnyApi).appState as AnyApi),
            workspaces: stripped,
            activeWorkspaceId: nextActiveId,
          },
        } as StatePayload;
      }
      // Once the BACKEND broadcast itself has the workspace gone, the
      // deletion has landed in the source-of-truth store and we can stop
      // suppressing. Use the pre-strip snapshot — the rewritten payload
      // above is our local optimistic view, not the backend's report.
      let mutated = false;
      for (const pendingId of Array.from(optimisticallyDeletedIds.value)) {
        if (!incomingIds.includes(pendingId)) {
          optimisticallyDeletedIds.value.delete(pendingId);
          mutated = true;
        }
      }
      if (mutated) optimisticallyDeletedIds.value = new Set(optimisticallyDeletedIds.value);
    }
    payload.value = maybeApplyMockFromUrl(scopePayloadToWindow(nextPayload) as AnyApi) as StatePayload;
    // Keep workspace cache fresh on every broadcast for the active workspace
    _cacheCurrentWorkspace();

    // Recovery decisions are GLOBAL per task: when another window resolves a
    // candidate, the backend drops it from meta.recoveryCandidates and
    // broadcasts — reconcile our local list so this window's dialog doesn't
    // offer an already-decided task again.
    const incomingCandidates = (nextPayload as AnyApi)?.meta?.recoveryCandidates as
      Array<{ workspaceId: string }> | undefined;
    if (Array.isArray(incomingCandidates) && recoveryCandidates.value.length > 0) {
      const liveIds = new Set(incomingCandidates.map((c) => c.workspaceId));
      const reconciled = recoveryCandidates.value.filter((c) => liveIds.has(c.workspaceId));
      if (reconciled.length !== recoveryCandidates.value.length) {
        recoveryCandidates.value = reconciled;
      }
    }
  }

  // --- Actions ---
  async function withSuppressedBroadcast(fn: () => Promise<void>): Promise<void> {
    suppressBroadcast.value = true;
    try {
      return await fn();
    } finally {
      setTimeout(() => {
        suppressBroadcast.value = false;
      }, 200);
    }
  }

  async function activateWorkspace(workspaceId: string): Promise<void> {
    const prevWsId = myActiveWorkspaceId.value;
    rlog("debug", "ws-activate: entry", {
      workspaceId,
      prevWsId,
      myProfileId: myActiveProfileId.value,
      slotProfileId: myWindowSlot.value?.profileId || null,
      isGridVisible: isGridVisible.value,
    });
    if (prevWsId && splitGroup.value) {
      _splitGroupCache.set(prevWsId, splitGroup.value);
    }
    applyOptimisticWorkspaceActivation(workspaceId);
    try {
      const nextPayload = (await _api!.activateWorkspace(workspaceId)) as StatePayload;
      const nextSlots = (nextPayload as AnyApi)?.appState?.windowSlots as AnyApi[] | undefined;
      const nextMySlot = myWindowId && nextSlots ? nextSlots.find((s: AnyApi) => s.id === myWindowId) : null;
      const responseMyWsId = getWindowWorkspaceIdFromPayload(nextPayload);
      rlog("debug", "ws-activate: ipc response", {
        workspaceId,
        pendingId: pendingWorkspaceActivationId.value,
        globalActiveWsId: (nextPayload as AnyApi)?.appState?.activeWorkspaceId || null,
        responseMyWsId,
        slotActiveWsId: nextMySlot?.activeWorkspaceId || null,
        slotProfileId: nextMySlot?.profileId || null,
      });
      if (!pendingWorkspaceActivationId.value || responseMyWsId === pendingWorkspaceActivationId.value) {
        payload.value = maybeApplyMockFromUrl(scopePayloadToWindow(nextPayload) as AnyApi) as StatePayload;
        // Update cache with fresh server data for the newly activated workspace
        _cacheCurrentWorkspace();
        if (!(nextPayload as AnyApi)?.meta?.bootstrap) pendingWorkspaceActivationId.value = "";
        // Full restore (including special-prefix activeViewId) now that the real
        // payload is available — broadcastPayload may have already handled this, but
        // if the broadcast arrives after this await returns, the optimistic fallback
        // would otherwise stick.
        const wsEntry = ((nextPayload as AnyApi)?.appState?.workspaces || []).find(
          (ws: AnyApi) => ws.id === workspaceId,
        );
        applyWorkspaceUIStateFromEntry(wsEntry, workspaceId);
      } else {
        rlog("debug", "ws-activate: ipc response not adopted (global activeWsId !== pending)", {
          workspaceId,
          pendingId: pendingWorkspaceActivationId.value,
          globalActiveWsId: (nextPayload as AnyApi)?.appState?.activeWorkspaceId || null,
          responseMyWsId,
          note: "relies on broadcast (which is slot-aware) to update payload",
        });
      }
    } catch (err) {
      rlog("warn", "ws-activate: ipc threw", {
        workspaceId,
        err: (err as Error)?.message || String(err),
      });
      pendingWorkspaceActivationId.value = "";
    }
  }

  async function activateView(viewId: string, { focus: _focus = true } = {}): Promise<void> {
    if (!viewId || viewId === activeViewId.value) return;

    activeViewId.value = viewId;
    const selectedTab = (workspaceTabs.value as AnyApi[]).find((tab: AnyApi) => tab.id === viewId) || null;
    if (
      (selectedTab && (selectedTab as AnyApi).type !== "terminal") ||
      isGitViewId(viewId) ||
      isDockerViewId(viewId) ||
      isAzureViewId(viewId) ||
      isGitHubViewId(viewId) ||
      isReviewViewId(viewId) ||
      isBrowserViewId(viewId) ||
      isFilesViewId(viewId) ||
      isTaskDashboardViewId(viewId)
    ) {
      pendingViewActivationId.value = "";
      activeSessionId.value = null;
      // Persist the non-session active view so it's restored on workspace switch/restart.
      // Sessions already persist via api.activateSession below.
      const wsId = myActiveWorkspaceId.value;
      if (wsId && (_api as AnyApi)?.setWorkspaceUIState) {
        (_api as AnyApi).setWorkspaceUIState(wsId, { activeViewId: viewId }).catch(() => {});
      }
      // Refresh git data on-demand when the Git tab is activated
      if (isGitViewId(viewId) && _api) {
        if (wsId) {
          (_api as AnyApi)
            .refreshGit(wsId)
            .then((nextPayload: StatePayload) => {
              if (nextPayload && !pendingWorkspaceActivationId.value) {
                payload.value = maybeApplyMockFromUrl(nextPayload as AnyApi) as StatePayload;
                _cacheCurrentWorkspace();
              }
            })
            .catch((err: unknown) => {
              rlog("warn", "git tab activate: refreshGit failed, showing stale git data", {
                workspaceId: wsId,
                err: (err as Error)?.message || String(err),
              });
            });
        }
      }
      return;
    }

    pendingViewActivationId.value = viewId;
    activeSessionId.value = viewId;

    try {
      const nextPayload = (await (_api as AnyApi).activateSession(viewId)) as StatePayload;
      if (pendingViewActivationId.value === viewId && !(nextPayload as AnyApi)?.meta?.bootstrap) {
        pendingViewActivationId.value = "";
      }
      payload.value = maybeApplyMockFromUrl(scopePayloadToWindow(nextPayload) as AnyApi) as StatePayload;
    } catch {
      if (pendingViewActivationId.value === viewId) {
        pendingViewActivationId.value = "";
      }
    }
  }

  function setRemoteConnectionIssue(message: string): void {
    remoteConnectionIssue.value = String(message || "").trim();
  }

  function clearRemoteConnectionIssue(): void {
    remoteConnectionIssue.value = "";
  }

  // --- Selectors exposed for components ---

  /**
   * Raw git entry (with multi-root `roots`) for a workspace. Desktop reads the
   * full snapshot straight off the IPC payload; a remote client reads the
   * on-demand detail cache (`git:<id>`, fetched when a Git/Review pane declares
   * interest). Missing on remote until fetched = a loading state, never a
   * partial object — summaries live separately in `gitSummaries`.
   */
  function getGitWorkspaceEntry(workspaceId: string): AnyApi {
    if (isRemoteTransport.value) {
      return (useRemoteDetailsStore().get(`git:${workspaceId}`) as AnyApi) || null;
    }
    return (
      (payload.value as AnyApi)?.git?.workspaces?.[workspaceId] ||
      (payload.value as AnyApi)?.git?.projects?.[workspaceId] ||
      null
    );
  }

  function getGitSnapshot(workspaceId: string, rootPath: string | null = null): unknown {
    const entry = getGitWorkspaceEntry(workspaceId);
    if (!entry) return null;
    if (!entry.roots) return entry; // legacy single-root payload
    const key = rootPath || entry.primaryRoot;
    return entry.roots?.[key] || entry.roots?.[entry.primaryRoot] || null;
  }

  function getActiveGitSnapshot(workspaceId: string): unknown {
    // Prefer in-memory active root from git-ui store (updates immediately on root selection).
    // Fall back to persisted activeRootPath from payload so the correct root shows on reload.
    const gitUiActiveRoot = useGitUiStore().getActiveRoot(workspaceId);
    if (gitUiActiveRoot) {
      // Validate that the active root still exists; reset to primary if stale
      const entry = getGitWorkspaceEntry(workspaceId);
      if (!entry?.roots || entry.roots[gitUiActiveRoot]) {
        return getGitSnapshot(workspaceId, gitUiActiveRoot);
      }
    }
    const ws =
      filteredWorkspaces.value?.find((w: AnyApi) => w.id === workspaceId) ||
      (payload.value?.appState?.workspaces as AnyApi[] | undefined)?.find?.((w: AnyApi) => w.id === workspaceId) ||
      null;
    return getGitSnapshot(workspaceId, (ws as AnyApi)?.activeRootPath || null);
  }

  /**
   * Six light git fields the always-on UI (sidebar cards, tab bar, hero) reads.
   * Remote: straight from the slim core's `gitSummaries` (present for every
   * profile workspace, no fetch needed). Desktop: derived from the full
   * snapshot's primary root — same values, so the one renderer is agnostic.
   */
  function getGitSummary(workspaceId: string): AnyApi {
    if (isRemoteTransport.value) {
      return (payload.value as AnyApi)?.gitSummaries?.[workspaceId] || null;
    }
    const snap = getGitSnapshot(workspaceId) as AnyApi;
    if (!snap) return null;
    return {
      available: snap.available,
      branch: snap.branch,
      dirty: snap.dirty,
      dirtyCount: snap.dirtyCount,
      branchMerged: snap.branchMerged,
      lastChangeAt: snap.lastChangeAt,
    };
  }

  /** Container counts for the Docker tab badge + hero. Remote reads the core
   *  summary's `counts`; desktop computes from the full container list. */
  function dockerCounts(): { available: boolean; total: number; running: number } {
    const d = (payload.value as AnyApi)?.docker;
    if (isRemoteTransport.value && d?.counts) {
      return {
        available: !!d.available,
        total: Number(d.counts.containers || 0),
        running: Number(d.counts.running || 0),
      };
    }
    const containers = (d?.containers || []) as AnyApi[];
    return {
      available: !!d?.available,
      total: containers.length,
      running: containers.filter(isContainerRunning).length,
    };
  }

  /** Full Docker snapshot for the Docker pane. Remote: on-demand `docker`
   *  detail cache, falling back to the core summary (empty lists) while
   *  loading. Desktop: the full IPC payload. */
  function dockerState(): AnyApi {
    if (isRemoteTransport.value) {
      return (useRemoteDetailsStore().get("docker") as AnyApi) || (payload.value as AnyApi)?.docker || null;
    }
    return (payload.value as AnyApi)?.docker || null;
  }

  /** Provider snapshot for the inbox pane: core badges/connections merged with
   *  the on-demand inbox detail (lists + profile-scoped connections). Desktop
   *  returns the full payload provider state unchanged. */
  function providerState(provider: "azure" | "github"): AnyApi {
    const core = (payload.value as AnyApi)?.[provider === "azure" ? "azureDevops" : "github"] || {};
    if (!isRemoteTransport.value) return core;
    const detail = useRemoteDetailsStore().get(`${provider}-inbox`) as AnyApi;
    if (!detail) return core;
    return { ...core, inbox: detail.inbox, connections: detail.connections || core.connections };
  }

  /** {inbox, connections} slice the tab-strip selector needs. */
  function providerInbox(provider: "azure" | "github"): AnyApi {
    const s = providerState(provider);
    return { inbox: s?.inbox, connections: s?.connections };
  }

  /** Full per-PR provider detail for the review pane. Remote: on-demand
   *  `<provider>-pr:<prKey>` cache; desktop: the full payload PR entry. */
  function providerPrDetail(provider: "azure" | "github", prKey: string): AnyApi {
    if (isRemoteTransport.value) {
      return (useRemoteDetailsStore().get(`${provider}-pr:${prKey}`) as AnyApi) || null;
    }
    const key = provider === "azure" ? "azureDevops" : "github";
    return (payload.value as AnyApi)?.[key]?.pullRequests?.[prKey] || null;
  }

  /** Full per-PR review-bridge context for the review pane's Comments tab.
   *  Remote: on-demand `review-bridge:<prKey>` cache; desktop: the full payload
   *  context. */
  function reviewBridgePr(prKey: string): AnyApi {
    if (isRemoteTransport.value) {
      const cached = useRemoteDetailsStore().get(`review-bridge:${prKey}`) as AnyApi;
      if (cached) return cached;
      return null;
    }
    return (payload.value as AnyApi)?.reviewBridge?.pullRequests?.[prKey] || null;
  }

  /** Agent prompts for the review pane's Agent tab. NOT in the slim core (only a
   *  mounted review pane renders them). Remote: the global `agent-prompts` detail
   *  resource, fetched when a review pane declares interest in `agent-prompts`;
   *  its own revision bumps on reset/edit, so a reset repaints fresh prompts.
   *  Desktop: the global `reviewBridge.agentPrompts`. The prKey is unused on
   *  remote (prompts are install-global) but kept so callers stay transport-agnostic. */
  function reviewAgentPrompts(_prKey: string): AnyApi {
    if (isRemoteTransport.value) {
      const cached = useRemoteDetailsStore().get("agent-prompts") as AnyApi;
      return cached?.agentPrompts || [];
    }
    return (payload.value as AnyApi)?.reviewBridge?.agentPrompts || [];
  }

  function getWorkspaceAttentionForId(workspaceId: string): unknown {
    return getWorkspaceAttention(payload.value, workspaceId);
  }

  function getTabAttentionForView(workspaceId: string, viewId: string): unknown {
    return getTabAttention(payload.value, workspaceId, viewId, { isGitViewId, isDockerViewId });
  }

  function getPanelByViewId(viewId: string, workspace = (payload.value as AnyApi)?.workspace): unknown {
    return getWorkspacePanelByViewId(viewId, workspace, {
      isGitViewId,
      isDockerViewId,
      isAzureViewId,
      isGitHubViewId,
      isReviewViewId,
    });
  }

  // --- Delegated action groups ---
  const workspaceActions = createWorkspaceActions({
    payload,
    activeViewId,
    activeSessionId,
    myActiveWorkspaceId,
    splitGroup,
    hiddenViewIds,
    workspaceTabs: workspaceTabs as AnyApi,
    overlay,
    overlayProps,
    optimisticallyDeletedIds,
    isGridVisible,
    setGridLayout,
    enableWorkspaceGrid,
    layoutPickerMode,
    getApi,
    withSuppressedBroadcast,
  });

  const dialogActions = createDialogActions({
    overlay,
    overlayProps,
    contextMenu,
    layoutPickerAnchor,
    layoutPickerMode,
    payload,
    activeViewId,
    activeSessionId,
    splitGroup,
    suppressBroadcast,
    hiddenViewIds,
    getApi,
    withSuppressedBroadcast,
    getPanelByViewId,
    createWorktree: workspaceActions.createWorktree,
    quickAddTemplateTab: workspaceActions.quickAddTemplateTab,
    resolveViewerProfileId,
  });

  // --- Init ---
  function init(api: Transport): void {
    _api = api;
    isRemoteTransport.value = !!api.isRemote;
    supportsPerformanceMetrics.value = typeof (api as AnyApi).getPerformanceSnapshot === "function";
    // Wire the slim-core detail cache (remote-only; a no-op on desktop). Must
    // run before any pane mounts so interest declarations reach the transport.
    useRemoteDetailsStore().init(api);

    // The transport hands us either a full StatePayload (desktop / legacy) or a
    // slim RemoteStateV2 core; the store adapts both through its transport-aware
    // accessors, so this single boundary cast is where the two shapes converge.
    api.onStateUpdated((nextPayload) => handleBroadcastPayload(nextPayload as StatePayload));

    api.onConnectionState?.((connection) => {
      if ((connection as AnyApi)?.connected) {
        clearRemoteConnectionIssue();
        return;
      }
      // Connection dropped → forget the revision baseline. The server's
      // coreRevision counter resets to 0 on restart, so the post-reconnect
      // bootstrap/stream can carry a LOWER revision than what we last applied;
      // without this reset the gate would wrongly drop every fresh snapshot and
      // wedge the client on stale state. A fresh connection starts a new baseline.
      lastAppliedCoreRevision = -1;
      if ((connection as AnyApi)?.message) setRemoteConnectionIssue((connection as AnyApi).message);
    });

    window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
      const error = event.reason as AnyApi;
      if (!error?.isRemoteTransport) return;
      if (error.message) setRemoteConnectionIssue(error.message);
      event.preventDefault();
    });

    api
      .getState()
      .then((nextPayload) => {
        const p = nextPayload as AnyApi;
        const pendingWsId = pendingWorkspaceActivationId.value;
        const incomingWsId = getWindowWorkspaceIdFromPayload(p as StatePayload);
        const isBootstrap = Boolean(p?.meta?.bootstrap);

        if (pendingWsId && incomingWsId && incomingWsId !== pendingWsId) return;
        if (pendingWsId && incomingWsId === pendingWsId && !isBootstrap) {
          pendingWorkspaceActivationId.value = "";
        }

        bootstrapError.value = "";
        clearRemoteConnectionIssue();

        if (pendingViewActivationId.value) {
          const nextWorkspace = p?.workspace;
          const nextTabs = nextWorkspace
            ? getWorkspaceTabs({
                workspace: nextWorkspace,
                payload: p as StatePayload,
                hiddenViewIds: hiddenViewIds.value,
                isContainerRunning,
              })
            : [];
          if ((nextTabs as AnyApi[]).some((tab: AnyApi) => tab.id === pendingViewActivationId.value)) {
            activeViewId.value = pendingViewActivationId.value;
            activeSessionId.value = pendingViewActivationId.value;
            if (!isBootstrap) pendingViewActivationId.value = "";
          }
        }

        // Apply the bootstrap snapshot only if a WS frame hasn't already applied
        // newer state (records the baseline revision for the handoff gate).
        if (acceptCoreRevision(p)) {
          payload.value = maybeApplyMockFromUrl(scopePayloadToWindow(p as StatePayload) as AnyApi) as StatePayload;
          // Seed cache with the initial workspace state on bootstrap
          _cacheCurrentWorkspace();
        }
        // Show recovery dialog if there are crash-recovery candidates.
        // The dialog is the only resume path — silent auto-resume was unreliable.
        const candidates: RecoveryCandidate[] = (p?.meta?.recoveryCandidates as RecoveryCandidate[]) ?? [];
        if (candidates.length > 0) {
          recoveryCandidates.value = candidates;
          dialogActions.openDialog("TaskRecoveryDialog", { onClose: () => dialogActions.closeDialog() });
        }
      })
      .catch((error: AnyApi) => {
        const message = error?.message?.includes("401")
          ? "Remote token is missing or invalid. Use the token from the desktop strIDEterm state file."
          : error?.message || "Unknown startup error.";
        bootstrapError.value = message;
      });
  }

  // --- Domain API actions (azure, review, docker, remote, profile) ---
  const apiActions = createApiActions({
    payload,
    activeViewId,
    activeSessionId,
    splitGroup,
    remoteAccessMode,
    selectedLanUrl,
    getApi,
    adoptPayload: (nextPayload: StatePayload) => {
      payload.value = maybeApplyMockFromUrl(scopePayloadToWindow(nextPayload) as AnyApi) as StatePayload;
      _cacheCurrentWorkspace();
    },
    withSuppressedBroadcast,
    confirmInApp: workspaceActions.confirmInApp,
    resolveViewerProfileId,
  });

  /** Fetch a process-metrics snapshot. Returns null on transports that don't
   *  support it (remote), so callers can no-op gracefully. */
  async function getPerformanceSnapshot(): Promise<PerformanceSnapshot | null> {
    const api = getApi() as AnyApi;
    if (typeof api?.getPerformanceSnapshot !== "function") return null;
    return api.getPerformanceSnapshot();
  }

  /** Trigger a renderer CPU-profile capture (Ctrl+Shift+F12 equivalent). */
  async function captureRendererCpuProfile(): Promise<CpuProfileCaptureResult | null> {
    const api = getApi() as AnyApi;
    if (typeof api?.captureRendererCpuProfile !== "function") return null;
    return api.captureRendererCpuProfile();
  }

  /** Reveal a captured .cpuprofile in the OS file manager. */
  async function revealCpuProfile(filePath: string): Promise<RevealResult | null> {
    const api = getApi() as AnyApi;
    if (typeof api?.revealCpuProfile !== "function") return null;
    return api.revealCpuProfile(filePath);
  }

  async function resolveTaskRecovery(decisions: Record<string, "continue" | "fresh" | "skip">): Promise<void> {
    const api = getApi();
    await api.resolveTaskRecovery?.({ decisions });
    // Drop the resolved candidates from the local list. The dialog uses this
    // both to decide when to close (list empty) and to know which candidate
    // to show next in sequential mode.
    const decided = new Set(Object.keys(decisions));
    recoveryCandidates.value = recoveryCandidates.value.filter((c) => !decided.has(c.workspaceId));
  }

  return {
    // State
    payload,
    activeViewId,
    activeSessionId,
    splitGroup,
    hiddenViewIds,
    sidebarCollapsed,
    overlay,
    overlayProps,
    bootstrapError,
    remoteConnectionIssue,
    remoteAccessMode,
    selectedLanUrl,
    contextMenu,
    layoutPickerAnchor,
    layoutPickerMode,
    starFilterActive,
    pendingWorkspaceActivationId,
    pendingViewActivationId,
    suppressBroadcast,
    recoveryCandidates,
    inboxConnectionFocus,
    requestInboxConnectionFocus,
    // Per-window identity
    myWindowId,
    myWindowSlot,
    myActiveWorkspaceId,
    myActiveProfileId,
    isRemoteTransport,
    supportsPerformanceMetrics,
    // Computed
    activeWorkspace,
    filteredWorkspaces,
    activeProfile,
    attentionSummary,
    otherProfileAttentionCount,
    workspaceTabs,
    visibleTabs,
    workspaceGrid,
    isGridVisible,
    gridCellWorkspaces,
    focusedGridCellIndex,
    // Core actions
    init,
    handleBroadcastPayload,
    withSuppressedBroadcast,
    activateWorkspace,
    activateView,
    setRemoteConnectionIssue,
    clearRemoteConnectionIssue,
    getApi,
    resolveTaskRecovery,
    getPerformanceSnapshot,
    captureRendererCpuProfile,
    revealCpuProfile,
    // Grid actions
    enableWorkspaceGrid,
    disableWorkspaceGrid,
    setGridLayout,
    setGridCell,
    swapGridCells,
    activateWorkspaceInGrid,
    // Delegated dialog actions
    ...dialogActions,
    // Delegated workspace actions
    ...workspaceActions,
    // Delegated API actions (azure, review, docker, remote, profile)
    ...apiActions,
    // Selectors
    getGitSnapshot,
    getActiveGitSnapshot,
    getGitWorkspaceEntry,
    getGitSummary,
    dockerCounts,
    dockerState,
    providerState,
    providerInbox,
    providerPrDetail,
    reviewBridgePr,
    reviewAgentPrompts,
    getWorkspaceAttentionForId,
    getTabAttentionForView,
    getPanelByViewId,
  };
});

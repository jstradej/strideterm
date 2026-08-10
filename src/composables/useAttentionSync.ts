import { watch, onScopeDispose } from "vue";
import { useAppStore } from "../stores/app.js";
import { classifyViewType } from "../app/helpers.js";
import { tabSessionId } from "../app/selectors.js";
import { isCompanionPrimaryViewId, resolveCompanionPrimaryBinding } from "../../electron/shared/companion-primary.js";
import { isMobileViewport } from "./useIsNarrow.js";
import type { Transport } from "../transport.js";

/**
 * Terminal sessions rendered by workspace-grid cells. The grid shows OTHER
 * workspaces than the active one (whose tabs are already in visibleTabs):
 * a non-focused cell renders its workspace's persisted activeViewId, the
 * focused cell renders the live activeViewId — same rules as
 * WorkspaceCell.vue. Classification goes through the shared classifyViewType
 * so grid panes are judged exactly as the cell renders them (a headless-judge
 * panel is NOT a streaming terminal). Without these, the remote subscription
 * would omit grid panes and the server's filtered routing would freeze them.
 *
 * On a narrow/mobile viewport the grid collapses to a solo layout:
 * WorkspaceGridStage `v-show`s only the focused cell, the rest are
 * `display:none`. Streaming those hidden cells would waste bandwidth and
 * renderer CPU, so `narrow` restricts the subscription to the focused cell —
 * mirroring how the attention scope already collapses via `forceSoloLayout`.
 */
export function deriveGridSessionIds(
  appStore: {
    isGridVisible: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gridCellWorkspaces: any[];
    activeViewId: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activeWorkspace: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload?: any;
  },
  narrow = false,
): string[] {
  if (!appStore.isGridVisible) return [];
  const ids: string[] = [];
  const focusedWorkspaceId = appStore.activeWorkspace?.id || "";
  for (const ws of appStore.gridCellWorkspaces) {
    if (!ws) continue;
    // Narrow viewport renders only the focused cell — the others are hidden and
    // must not stream.
    if (narrow && ws.id !== focusedWorkspaceId) continue;
    const viewId = ws.id === focusedWorkspaceId ? appStore.activeViewId : ws.activeViewId;
    if (typeof viewId !== "string" || classifyViewType(viewId, ws.id, appStore.payload) !== "terminal") continue;
    // A cell rendering a borrowed Companion Primary must subscribe to the
    // SOURCE session — the virtual view id is not a session the server knows.
    const sessionId = isCompanionPrimaryViewId(viewId)
      ? resolveCompanionPrimaryBinding(
          appStore.payload?.appState?.workspaces || [],
          appStore.payload?.taskRunner || null,
          ws.id,
        )?.sourceSessionId || ""
      : viewId;
    if (sessionId && !ids.includes(sessionId)) ids.push(sessionId);
  }
  return ids;
}

/**
 * Compute both session-id sets and the dedup key for one attention/stream sync.
 *
 * - `visibleSessionIds` drives `syncAttentionContext` (always the active
 *   workspace's terminal tabs — attention keeps its active-workspace scope).
 * - `subscriptionIds` drives the remote terminal-stream subscription: exactly
 *   what is on screen. In grid mode WorkspaceStage renders WorkspaceGridStage,
 *   NOT PaneStage — so the active workspace's hidden/split tabs are off-screen
 *   and must not stream or buffer; the rendered set is just the grid cells
 *   (which already include the focused cell's active view). Out of grid mode
 *   PaneStage renders the active workspace's visibleTabs, so the two sets match.
 *
 * The dedup key must react to BOTH sets. They diverge in grid mode, so keying
 * on only one would skip a sync when the OTHER changes — e.g. the active
 * workspace's visible tabs change (attention scope) while the rendered grid
 * cells stay put (subscription scope), leaving the backend with stale
 * visibility. Exported so the divergence is unit-testable without a live store.
 */
export function deriveAttentionSync(
  appStore: {
    isGridVisible: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gridCellWorkspaces: any[];
    activeViewId: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activeWorkspace: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload?: any;
    attentionSummary: { count: number; waitingCount: number };
    activeProfile: { id: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    visibleTabs: any[];
  },
  windowFocused: boolean,
  narrow = false,
): { visibleSessionIds: string[]; subscriptionIds: string[]; syncKey: string } {
  const { count, waitingCount } = appStore.attentionSummary;

  // Real session ids, never view ids: a borrowed Companion Primary is drawn
  // under a virtual id but streams and reports attention as its source session.
  const visibleSessionIds = (appStore.visibleTabs as any[]) // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: visibleTabs is open-ended server JSON
    .filter((tab) => tab.type === "terminal")
    .map((tab: any) => tabSessionId(tab)) // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: tab item is open-ended server JSON
    .filter((sessionId: string) => Boolean(sessionId));

  const subscriptionIds = appStore.isGridVisible ? deriveGridSessionIds(appStore, narrow) : visibleSessionIds;

  const syncKey = `${count}:${waitingCount}:${appStore.activeProfile.id}:${visibleSessionIds.join(
    ",",
  )}:${subscriptionIds.join(",")}:${windowFocused}`;

  return { visibleSessionIds, subscriptionIds, syncKey };
}

export function useAttentionSync(api: Transport) {
  const appStore = useAppStore();
  const documentTitleBase = document.title || "strIDEterm";
  let browserBadgeKey = "";
  let resyncTimer: ReturnType<typeof setTimeout> | undefined;
  let syncDebounce: ReturnType<typeof setTimeout> | undefined;
  let lastSyncKey = "";
  let disposed = false;
  let windowFocused = typeof document !== "undefined" ? document.hasFocus() : true;

  // Track browser/Electron window focus so the backend can treat "visible +
  // focused" as real user engagement (Phase 2 § 3.2.5).
  function onFocus() {
    windowFocused = true;
    lastSyncKey = "";
    sync();
  }
  function onBlur() {
    windowFocused = false;
    lastSyncKey = "";
    sync();
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
  }

  // The server dropped an id from this socket's live routing set (its panel was
  // removed). The recreated pane reuses the SAME id, so a remove+recreate leaves
  // the rendered set unchanged and the syncKey dedup would skip the resync,
  // freezing the recreated stream. We must force a resync — but DETERMINISTICALLY,
  // never on a timer.
  //
  // At this instant our payload may still list the removed id: the state:updated
  // that drops/recreates it can still be in flight, especially on a throttled
  // link. Syncing now — or on a fixed timeout that might fire before that update
  // arrives — would re-subscribe a stale id, the server would reject the whole
  // batch (its panel is gone), and the transport would still record the rejected
  // set as sent (transport.ts). A later same-id recreate then produces an
  // identical syncKey and never re-subscribes. Instead just ARM a pending resync
  // and let the next payload drive it (see the payload watch below): the server
  // emits terminal:removed only AFTER removing the panel and every payload is a
  // full snapshot, so the next payload the client applies is always consistent
  // with the server's current panel set — never the stale pre-removal one.
  let removalResyncPending = false;
  api.onTerminalRemoved?.(({ sessionId }) => {
    if (disposed || !sessionId) return;
    removalResyncPending = true;
  });

  // Fire an armed removal-resync off the NEXT payload the client receives.
  // `appStore.payload` is a shallowRef reassigned on every state:updated, so this
  // triggers exactly once fresh, server-consistent state has been applied — not
  // before, and not on a timer racing the network. Reset lastSyncKey so an
  // unchanged syncKey isn't deduped, then sync: the transport already forgot the
  // removed id, so subscribeTerminals re-sends the current set and the now-in-sync
  // server accepts it. Re-arming on each terminal:removed lets a mid-flight change
  // self-heal on the following payload.
  watch(
    () => appStore.payload,
    () => {
      if (disposed || !removalResyncPending) return;
      removalResyncPending = false;
      lastSyncKey = "";
      sync();
    },
  );

  function sync() {
    const { count, waitingCount } = appStore.attentionSummary;
    const profile = appStore.activeProfile;
    const profileLabel = profile.id !== "default" ? ` [${profile.name}]` : "";
    const base = documentTitleBase + profileLabel;
    document.title = count > 0 ? `(${count}) ${base}` : base;

    const { visibleSessionIds, subscriptionIds, syncKey } = deriveAttentionSync(
      appStore as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      windowFocused,
      isMobileViewport.value,
    );

    // Deduplicate: skip API call if nothing changed
    if (syncKey === lastSyncKey) return;
    lastSyncKey = syncKey;

    // Update browser badge
    const nextBadgeKey = `${count}:${waitingCount}:${profile.id}`;
    if (browserBadgeKey !== nextBadgeKey) {
      browserBadgeKey = nextBadgeKey;
      if (typeof navigator.setAppBadge === "function") {
        const action = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge?.();
        action?.catch?.(() => {});
      }
    }

    api.syncAttentionContext?.({ visibleSessionIds, windowFocused });

    // Drive the remote terminal-stream subscription off what is actually
    // rendered: the client streams (and replays) only those terminals —
    // visibleTabs out of grid mode, grid-cell terminals in it (subscriptionIds
    // above). No-op on the Electron transport, which streams everything over IPC.
    api.subscribeTerminals?.(subscriptionIds);

    // If any visible tab still has an attention alert, schedule a re-sync
    // so the backend clears it once ATTENTION_MIN_DISPLAY_MS (3s) elapses.
    clearTimeout(resyncTimer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasVisibleAlert = (appStore.visibleTabs as any[]).some((tab: any) =>
      appStore.getTabAttentionForView(
        (tab.ownerWorkspaceId as string) || appStore.activeWorkspace?.id || "",
        tabSessionId(tab),
      ),
    );
    if (hasVisibleAlert) {
      resyncTimer = setTimeout(() => {
        lastSyncKey = ""; // Force next sync
        sync();
      }, 3500);
    }
  }

  watch(
    () =>
      [
        appStore.attentionSummary,
        appStore.activeProfile.id,
        appStore.visibleTabs,
        // Grid inputs: cell add/remove/tab-switch changes the rendered
        // terminal set even when the active workspace's tabs are unchanged.
        appStore.isGridVisible,
        appStore.gridCellWorkspaces,
        // The focused grid cell renders activeViewId directly (deriveGridSessionIds
        // reads it), and narrow viewport collapses the grid subscription to that
        // cell — track both so switching the active view or crossing the mobile
        // breakpoint re-syncs even if visibleTabs' reference happens to be stable.
        appStore.activeViewId,
        isMobileViewport.value,
      ] as const,
    () => {
      // Debounce rapid payload updates (e.g., multiple broadcasts in quick succession)
      clearTimeout(syncDebounce);
      syncDebounce = setTimeout(sync, 50);
    },
  );

  onScopeDispose(() => {
    disposed = true;
    clearTimeout(resyncTimer);
    clearTimeout(syncDebounce);
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    }
  });
}

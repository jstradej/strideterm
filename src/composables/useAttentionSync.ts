import { watch, onScopeDispose } from "vue";
import { useAppStore } from "../stores/app.js";
import type { Transport } from "../transport.js";

export function useAttentionSync(api: Transport) {
  const appStore = useAppStore();
  const documentTitleBase = document.title || "strIDEterm";
  let browserBadgeKey = "";
  let resyncTimer: ReturnType<typeof setTimeout> | undefined;
  let syncDebounce: ReturnType<typeof setTimeout> | undefined;
  let lastSyncKey = "";
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

  function sync() {
    const { count, waitingCount } = appStore.attentionSummary;
    const profile = appStore.activeProfile;
    const profileLabel = profile.id !== "default" ? ` [${profile.name}]` : "";
    const base = documentTitleBase + profileLabel;
    document.title = count > 0 ? `(${count}) ${base}` : base;

    const visibleSessionIds = (appStore.visibleTabs as any[]) // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: visibleTabs is open-ended server JSON
      .filter((tab) => tab.type === "terminal")
      .map((tab: any) => tab.id as string); // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: tab item is open-ended server JSON

    // Deduplicate: skip API call if nothing changed
    const syncKey = `${count}:${waitingCount}:${profile.id}:${visibleSessionIds.join(",")}:${windowFocused}`;
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

    // If any visible tab still has an attention alert, schedule a re-sync
    // so the backend clears it once ATTENTION_MIN_DISPLAY_MS (3s) elapses.
    clearTimeout(resyncTimer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasVisibleAlert = (appStore.visibleTabs as any[]).some((tab: any) =>
      appStore.getTabAttentionForView(appStore.activeWorkspace?.id || "", tab.id as string),
    );
    if (hasVisibleAlert) {
      resyncTimer = setTimeout(() => {
        lastSyncKey = ""; // Force next sync
        sync();
      }, 3500);
    }
  }

  watch(
    () => [appStore.attentionSummary, appStore.activeProfile.id, appStore.visibleTabs],
    () => {
      // Debounce rapid payload updates (e.g., multiple broadcasts in quick succession)
      clearTimeout(syncDebounce);
      syncDebounce = setTimeout(sync, 50);
    },
  );

  onScopeDispose(() => {
    clearTimeout(resyncTimer);
    clearTimeout(syncDebounce);
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    }
  });
}

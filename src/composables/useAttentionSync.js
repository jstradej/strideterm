import { watch } from "vue";
import { useAppStore } from "../stores/app.js";

export function useAttentionSync(api) {
  const appStore = useAppStore();
  const documentTitleBase = document.title || "strIDEterm";
  let browserBadgeKey = "";
  let resyncTimer = null;

  function sync() {
    const { count, waitingCount } = appStore.attentionSummary;
    const profile = appStore.activeProfile;
    const profileLabel = profile.id !== "default" ? ` [${profile.name}]` : "";
    const base = documentTitleBase + profileLabel;
    document.title = count > 0 ? `(${count}) ${base}` : base;

    // Update browser badge (deduplicated to avoid redundant API calls)
    const nextKey = `${count}:${waitingCount}:${profile.id}`;
    if (browserBadgeKey !== nextKey) {
      browserBadgeKey = nextKey;
      if (typeof navigator.setAppBadge === "function") {
        const action = count > 0
          ? navigator.setAppBadge(count)
          : navigator.clearAppBadge?.();
        action?.catch?.(() => {});
      }
    }

    // Always sync visible sessions with backend (even if badge didn't change)
    const visibleSessionIds = appStore.visibleTabs
      .filter((tab) => tab.type === "terminal")
      .map((tab) => tab.id);
    api.syncAttentionContext?.({ visibleSessionIds });

    // If any visible tab still has an attention alert, schedule a re-sync
    // so the backend clears it once ATTENTION_MIN_DISPLAY_MS (3s) elapses.
    clearTimeout(resyncTimer);
    const hasVisibleAlert = appStore.visibleTabs.some((tab) =>
      appStore.getTabAttentionForView(appStore.activeWorkspace?.id || "", tab.id),
    );
    if (hasVisibleAlert) {
      resyncTimer = setTimeout(() => {
        const ids = appStore.visibleTabs
          .filter((tab) => tab.type === "terminal")
          .map((tab) => tab.id);
        api.syncAttentionContext?.({ visibleSessionIds: ids });
      }, 3500);
    }
  }

  watch(
    () => [appStore.attentionSummary, appStore.activeProfile.id, appStore.visibleTabs],
    () => sync(),
  );
}

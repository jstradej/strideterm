import { watch } from "vue";
import { useAppStore } from "../stores/app.js";

export function useAttentionSync(api) {
  const appStore = useAppStore();
  const documentTitleBase = document.title || "strIDEterm";
  let browserBadgeKey = "";

  function sync() {
    const { count, waitingCount } = appStore.attentionSummary;
    const profile = appStore.activeProfile;
    const profileLabel = profile.id !== "default" ? ` [${profile.name}]` : "";
    const base = documentTitleBase + profileLabel;
    document.title = count > 0 ? `(${count}) ${base}` : base;

    const nextKey = `${count}:${waitingCount}:${profile.id}`;
    if (browserBadgeKey === nextKey) return;
    browserBadgeKey = nextKey;

    if (typeof navigator.setAppBadge === "function") {
      const action = count > 0
        ? navigator.setAppBadge(count)
        : navigator.clearAppBadge?.();
      action?.catch?.(() => {});
    }

    const visibleSessionIds = appStore.visibleTabs
      .filter((tab) => tab.type === "terminal")
      .map((tab) => tab.id);
    api.syncAttentionContext?.(visibleSessionIds);
  }

  watch(
    () => [appStore.attentionSummary, appStore.activeProfile.id, appStore.visibleTabs],
    () => sync(),
  );
}

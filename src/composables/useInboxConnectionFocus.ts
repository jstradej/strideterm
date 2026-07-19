import { ref, nextTick, watch } from "vue";
import type { Ref } from "vue";
import { useAppStore } from "../stores/app.js";

/**
 * Deep-link handling shared by both providers in InboxPane.vue (formerly
 * AzureInboxPane/GitHubInboxPane): when the user clicks a "connection error"
 * notification, the store carries a focus request
 * (`appStore.inboxConnectionFocus`). If it targets one of this pane's
 * connections, switch to the Connections tab and highlight + scroll to it so
 * the failing connection is immediately obvious (red border + ❗ already mark
 * it; the highlight outline shows which one was clicked). Match on
 * connection id membership — ids are unique per provider, so the wrong pane
 * never reacts. This logic was byte-identical in both panes.
 */
export function useInboxConnectionFocus(myConnectionIds: Ref<Set<string>>, activeTab: Ref<string>) {
  const appStore = useAppStore();
  const connectionListRef = ref<HTMLElement | null>(null);
  const highlightedConnectionId = ref("");
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;

  watch(
    () => appStore.inboxConnectionFocus,
    (req) => {
      if (!req?.connectionId) return;
      if (Date.now() - req.ts > 15000) return; // stale request — don't hijack a later visit
      if (!myConnectionIds.value.has(req.connectionId)) return; // belongs to another pane
      appStore.inboxConnectionFocus = null; // consume so it fires once
      activeTab.value = "connections";
      highlightedConnectionId.value = req.connectionId;
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => (highlightedConnectionId.value = ""), 4000);
      nextTick(() => {
        connectionListRef.value
          ?.querySelector(`[data-connection-id="${req.connectionId}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    },
    { immediate: true },
  );

  return { connectionListRef, highlightedConnectionId };
}

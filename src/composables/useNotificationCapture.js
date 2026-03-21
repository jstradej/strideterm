import { watch, ref } from "vue";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";

/**
 * Watches the attention payload for new alerts and converts them into
 * persistent notifications + toast triggers.
 *
 * Returns `latestToast` ref — a notification entry that just appeared.
 * The consuming component can show it briefly and then clear it.
 */
export function useNotificationCapture() {
  const appStore = useAppStore();
  const notifStore = useNotificationStore();
  const latestToast = ref(null);

  // Track alert IDs we have already seen so we only fire once per alert.
  const seenAlertKeys = new Set();

  // Build a stable key for an alert to detect duplicates.
  function alertKey(workspaceId, alert) {
    return `${workspaceId}:${alert.panelId || alert.sessionId}:${alert.at}`;
  }

  // Seed seen keys from current payload so we don't fire on existing alerts.
  function seedSeen() {
    const attention = appStore.payload?.attention;
    const byWs = attention?.byWorkspace || attention?.byProject || {};
    for (const [wsId, entry] of Object.entries(byWs)) {
      for (const alert of entry?.alerts || []) {
        seenAlertKeys.add(alertKey(wsId, alert));
      }
    }
  }

  seedSeen();

  watch(
    () => appStore.payload?.attention,
    (attention) => {
      if (!attention) return;
      const byWs = attention.byWorkspace || attention.byProject || {};
      const workspaces = appStore.payload?.appState?.workspaces || [];
      const wsMap = new Map(workspaces.map((ws) => [ws.id, ws]));

      for (const [wsId, entry] of Object.entries(byWs)) {
        for (const alert of entry?.alerts || []) {
          const key = alertKey(wsId, alert);
          if (seenAlertKeys.has(key)) continue;
          seenAlertKeys.add(key);

          const ws = wsMap.get(wsId);
          const wsName = ws?.name || wsId;
          const tabName = alert.title || alert.panelId || "";

          let body;
          if (alert.kind === "waiting") {
            body = `${tabName} in ${wsName} is waiting for input.`;
          } else {
            const exitInfo = Number.isInteger(alert.exitCode) ? ` (exit ${alert.exitCode})` : "";
            body = `${tabName} in ${wsName} finished${exitInfo}.`;
          }

          const entry = notifStore.add({
            title: alert.kind === "waiting" ? "Waiting for input" : "Task completed",
            body,
            kind: alert.kind || "completed",
            workspaceId: wsId,
            workspaceName: wsName,
            tabName,
            viewId: alert.sessionId || "",
          });

          latestToast.value = entry;
        }
      }

      // Prune seen keys that are no longer in the attention payload to prevent unbounded growth
      if (seenAlertKeys.size > 500) {
        const currentKeys = new Set();
        for (const [wsId, wsEntry] of Object.entries(byWs)) {
          for (const alert of wsEntry?.alerts || []) {
            currentKeys.add(alertKey(wsId, alert));
          }
        }
        for (const key of seenAlertKeys) {
          if (!currentKeys.has(key)) seenAlertKeys.delete(key);
        }
      }
    },
  );

  return { latestToast };
}

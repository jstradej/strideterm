import { watch, ref } from "vue";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";

/**
 * Watches the attention payload for new alerts and converts them into
 * persistent notifications + toast triggers.
 *
 * Also watches for alerts that DISAPPEAR and auto-marks the corresponding
 * notifications as read, keeping the notification center in sync with the
 * live attention state.
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

  // Track viewIds that currently have active alerts (for auto-read on disappear).
  let activeAlertViewIds = new Set();

  // Build a stable key for an alert to detect duplicates.
  function alertKey(workspaceId, alert) {
    return `${workspaceId}:${alert.panelId || alert.sessionId}:${alert.at}`;
  }

  // Collect all viewIds that currently have active alerts.
  function collectActiveViewIds(byWs) {
    const ids = new Set();
    for (const entry of Object.values(byWs)) {
      for (const alert of entry?.alerts || []) {
        if (alert.sessionId) ids.add(alert.sessionId);
      }
    }
    return ids;
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
    activeAlertViewIds = collectActiveViewIds(byWs);
  }

  seedSeen();

  // On startup, mark notifications as read if their alert is no longer active.
  // This cleans up stale notifications from previous sessions.
  markStaleNotificationsRead();

  // Grace period after startup — ignore alerts during initial tab launch
  const startupAt = Date.now();
  const STARTUP_GRACE_MS = 15_000;

  watch(
    () => appStore.payload?.attention,
    (attention) => {
      if (!attention) return;
      const inStartupGrace = Date.now() - startupAt < STARTUP_GRACE_MS;
      const byWs = attention.byWorkspace || attention.byProject || {};
      const workspaces = appStore.payload?.appState?.workspaces || [];
      const wsMap = new Map(workspaces.map((ws) => [ws.id, ws]));

      // --- Phase 1: Detect NEW alerts and create notifications ---
      for (const [wsId, entry] of Object.entries(byWs)) {
        for (const alert of entry?.alerts || []) {
          const key = alertKey(wsId, alert);
          if (seenAlertKeys.has(key)) continue;
          seenAlertKeys.add(key);

          // During startup grace period, mark as seen but don't notify
          if (inStartupGrace) continue;

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

      // --- Phase 2: Detect DISAPPEARED alerts and auto-mark notifications read ---
      const nextActiveViewIds = collectActiveViewIds(byWs);
      for (const viewId of activeAlertViewIds) {
        if (!nextActiveViewIds.has(viewId)) {
          // Alert for this viewId disappeared — mark matching notifications as read
          for (const item of notifStore.items) {
            if (!item.read && item.viewId === viewId) {
              notifStore.markRead(item.id);
            }
          }
        }
      }
      activeAlertViewIds = nextActiveViewIds;

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

  /**
   * On startup, mark any unread notifications as read if their corresponding
   * attention alert no longer exists. This handles stale notifications from
   * previous sessions or alerts that were cleared while the client was offline.
   */
  function markStaleNotificationsRead() {
    let changed = false;
    for (const item of notifStore.items) {
      if (!item.read && item.viewId && !activeAlertViewIds.has(item.viewId)) {
        notifStore.markRead(item.id);
        changed = true;
      }
    }
    return changed;
  }

  return { latestToast };
}

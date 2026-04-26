import { watch } from "vue";
import { storeToRefs } from "pinia";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";
import { fireNotificationAlert } from "./useNotificationSound.js";

interface AttentionAlertEntry {
  panelId?: string;
  sessionId?: string;
  title?: string;
  detail?: string;
  kind?: string;
  exitCode?: number | null;
  tier?: number;
  urgency?: string;
}

interface AttentionAlertBucket {
  alerts?: AttentionAlertEntry[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AttentionByWs = Record<string, AttentionAlertBucket | any>;

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
  // Share the toast slot with the store so app-level errors (showError) and
  // other non-alert sources can push toasts through the same ref App.vue binds.
  // storeToRefs preserves the Ref wrapping (vs. a plain destructure that would
  // unwrap to a value and break `.value = …` writes in this composable).
  const { latestToast } = storeToRefs(notifStore);

  // Track alert IDs we have already seen so we only fire once per alert.
  const seenAlertKeys = new Set<string>();

  // Track viewIds that currently have active alerts (for auto-read on disappear).
  let activeAlertViewIds = new Set<string>();

  // Build a stable key for an alert to detect duplicates.
  // Uses panelId only (no timestamp) so repeated alerts for the same tab are suppressed.
  function alertKey(workspaceId: string, alert: AttentionAlertEntry): string {
    return `${workspaceId}:${alert.panelId || alert.sessionId}`;
  }

  // Collect all viewIds that currently have active alerts.
  function collectActiveViewIds(byWs: AttentionByWs): Set<string> {
    const ids = new Set<string>();
    for (const entry of Object.values(byWs)) {
      for (const alert of entry?.alerts || []) {
        if (alert.sessionId) ids.add(alert.sessionId);
      }
    }
    return ids;
  }

  // Seed seen keys from current payload so startup alerts don't fire notifications.
  function seedSeen() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attention = appStore.payload?.attention as any;
    const byWs: AttentionByWs = attention?.byWorkspace || attention?.byProject || {};
    for (const [wsId, entry] of Object.entries(byWs)) {
      for (const alert of entry?.alerts || []) {
        seenAlertKeys.add(alertKey(wsId, alert));
      }
    }
    activeAlertViewIds = collectActiveViewIds(byWs);
  }

  seedSeen();
  markStaleNotificationsRead();

  const startupAt = Date.now();
  const STARTUP_GRACE_MS = 15_000;

  watch(
    () => appStore.payload?.attention,
    (attention) => {
      if (!attention) return;
      const inStartupGrace = Date.now() - startupAt < STARTUP_GRACE_MS;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const byWs: AttentionByWs = (attention as any).byWorkspace || (attention as any).byProject || {};
      const workspaces = appStore.payload?.appState?.workspaces || [];
      const wsMap = new Map(workspaces.map((ws) => [ws.id, ws]));

      // --- Phase 1: Detect NEW alerts and create notifications ---
      for (const [wsId, entry] of Object.entries(byWs) as [string, AttentionAlertBucket][]) {
        for (const alert of entry?.alerts || []) {
          const key = alertKey(wsId, alert);
          if (seenAlertKeys.has(key)) continue;
          seenAlertKeys.add(key);

          // During startup grace period, mark as seen but don't notify
          if (inStartupGrace) continue;

          const ws = wsMap.get(wsId);
          const wsName = ws?.name || wsId;
          const tabName = alert.title || alert.panelId || "";

          // Skip if there's already an unread notification for this tab
          const alertViewId = alert.sessionId || "";
          const hasUnread = alertViewId && notifStore.items.some((n) => !n.read && n.viewId === alertViewId);
          if (hasUnread) continue;

          // Detect task-specific alerts (detail starts with "task-")
          const alertDetail = alert.detail as string | undefined;
          const isTaskAlert = typeof alertDetail === "string" && alertDetail.startsWith("task-");
          const taskDetail = isTaskAlert ? (alertDetail as string).replace(/^task-\w+:\s*/, "") : "";

          let title: string;
          let body: string;
          if (isTaskAlert && (alertDetail as string).startsWith("task-completed")) {
            title = "Task completed";
            body = taskDetail ? `${wsName}: ${taskDetail}` : `${wsName} task finished successfully.`;
          } else if (isTaskAlert && (alertDetail as string).startsWith("task-failed")) {
            title = "Task failed";
            body = taskDetail ? `${wsName}: ${taskDetail}` : `${wsName} task failed.`;
          } else if (alert.kind === "waiting") {
            title = "Waiting for input";
            body = `${tabName} in ${wsName} is waiting for input.`;
          } else {
            title = "Task completed";
            const exitInfo = Number.isInteger(alert.exitCode) ? ` (exit ${alert.exitCode})` : "";
            body = `${tabName} in ${wsName} finished${exitInfo}.`;
          }

          const category = isTaskAlert ? "task" : "terminal";
          const entry = notifStore.add({
            title,
            body,
            kind: alert.kind || "completed",
            tier: Number.isInteger(alert.tier) ? alert.tier : 1,
            urgency: alert.urgency === "urgent" ? "urgent" : "normal",
            workspaceId: wsId,
            workspaceName: wsName,
            tabName,
            viewId: alert.sessionId || "",
            category,
          });

          // Attach category on the toast payload so NotificationToast can pick
          // the right icon without reaching into the session store.
          // Skip toast assignment while the dock is pinned — the dock itself
          // shows the arrival, and leaving latestToast stale would surface it
          // as a toast the moment the user unpins.
          if (!notifStore.pinned) {
            latestToast.value = { ...entry, category };
          }
          fireNotificationAlert(entry.title, entry.body, {
            tier: entry.tier,
            urgency: entry.urgency,
            sessionKey: `${wsId}:${alertViewId}`,
          });
        }
      }

      // --- Phase 2: Detect DISAPPEARED alerts and resolve their sessions ---
      const nextActiveViewIds = collectActiveViewIds(byWs);
      for (const viewId of activeAlertViewIds) {
        if (!nextActiveViewIds.has(viewId)) {
          // Alert for this viewId disappeared on the backend — the live
          // waiting state is over. Transition the thread to resolved so
          // it drops out of "Needs input" but stays in history briefly.
          for (const s of [...notifStore.sessions]) {
            if (s.viewId === viewId && s.state === "waiting") {
              notifStore.setState(s.id, "resolved");
            }
          }
        }
      }
      activeAlertViewIds = nextActiveViewIds;

      // Prune seen keys that no longer have active alerts so they can re-trigger
      const currentKeys = new Set<string>();
      for (const [wsId, wsEntry] of Object.entries(byWs) as [string, AttentionAlertBucket][]) {
        for (const alert of wsEntry?.alerts || []) {
          currentKeys.add(alertKey(wsId, alert));
        }
      }
      for (const key of seenAlertKeys) {
        if (!currentKeys.has(key)) seenAlertKeys.delete(key);
      }
    },
  );

  /**
   * On startup, remove any notifications whose corresponding attention alert
   * no longer exists. Notifications mirror live alert state, not history.
   */
  function markStaleNotificationsRead() {
    // On startup, any session still in "waiting" but without a live
    // backend alert has been resolved while the app was closed.
    // Demote to "resolved" (keeps history) rather than dropping.
    let changed = false;
    for (const s of [...notifStore.sessions]) {
      if (s.viewId && s.state === "waiting" && !activeAlertViewIds.has(s.viewId)) {
        notifStore.setState(s.id, "resolved");
        changed = true;
      }
    }
    return changed;
  }

  return { latestToast };
}

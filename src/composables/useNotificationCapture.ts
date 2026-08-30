import { watch } from "vue";
import { storeToRefs } from "pinia";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";
import { fireNotificationAlert } from "./useNotificationSound.js";

interface AttentionAlertEntry {
  /** Stable backend identity — see AttentionAlert.alertId. */
  alertId?: string;
  panelId?: string;
  sessionId?: string;
  title?: string;
  detail?: string;
  kind?: string;
  exitCode?: number | null;
  tier?: number;
  urgency?: string;
  /** Backend event time; becomes the notification event's `occurredAt`. */
  at?: string;
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

  /**
   * Backend `alertId`s this renderer has already handled.
   *
   * Keyed on the alert's OWN identity, never on the presence edge of
   * `workspaceId:panelId`. The old key was pruned whenever the alert dropped
   * out of the payload, so anything that made an alert momentarily absent —
   * a stale cached `attention` replayed by an optimistic workspace
   * activation, a reconnect, an out-of-order broadcast — turned the same
   * backend alert into a brand new "arrival" and appended a duplicate event
   * (V2 plan, Fáze 2). Ids therefore accumulate for the life of the
   * renderer: an alert that disappears and comes back is the SAME alert, and
   * a genuinely new one always carries a new id. The store's
   * `addAlertEvent()` is the second, persistent line of defence for the
   * cases this in-memory set cannot cover (reload, a second window).
   */
  const seenAlertIds = new Set<string>();

  // Track viewIds that currently have active alerts (for auto-read on disappear).
  let activeAlertViewIds = new Set<string>();

  /**
   * Identity used for deduplication. A backend that predates `alertId`
   * (or a hand-built test payload) falls back to the legacy composite key so
   * the capture still fires exactly once per panel — the fallback is a
   * degraded mode, not a second identity for a modern alert.
   */
  function alertKey(workspaceId: string, alert: AttentionAlertEntry): string {
    return alert.alertId || `legacy:${workspaceId}:${alert.panelId || alert.sessionId}`;
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
        seenAlertIds.add(alertKey(wsId, alert));
      }
    }
    activeAlertViewIds = collectActiveViewIds(byWs);
  }

  /**
   * Structured capture diagnostic (V2 plan, Fáze 6). Identity and the
   * decision only — never the alert title, body or task detail, which can
   * carry the user's own prompt text.
   *
   * Only reached for an alert this renderer had not seen before, so the
   * steady state (the same live alert re-broadcast every few seconds) logs
   * nothing. An `inserted: false` line therefore means a real duplicate got
   * past the in-memory guard — a reload, a second window, a stale snapshot —
   * which is exactly the case worth being able to grep for.
   */
  function logAlertCapture(info: { alertId: string; workspaceId: string; panelId: string; inserted: boolean }): void {
    try {
      (
        window as unknown as { strideterm?: { logRenderer?: (l: string, m: string, x?: unknown) => void } }
      ).strideterm?.logRenderer?.("debug", "notification capture", {
        ...info,
        ...(info.inserted ? {} : { skipped: "duplicate-source-alert" }),
      });
    } catch {
      // logging never throws
    }
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

      // Scope notifications to THIS WINDOW's profile. In a multi-window
      // multi-profile setup, the renderer in profile B otherwise pops a
      // toast and writes a notifStore entry for every alert in profile A
      // (which the user in B can't see in their sidebar). Mark them as
      // seen so they don't fire later if the user switches profiles.
      const activeProfileId = appStore.activeProfile?.id || "default";

      // --- Phase 1: Detect NEW alerts and create notifications ---
      for (const [wsId, entry] of Object.entries(byWs) as [string, AttentionAlertBucket][]) {
        for (const alert of entry?.alerts || []) {
          const key = alertKey(wsId, alert);
          if (seenAlertIds.has(key)) continue;
          seenAlertIds.add(key);

          // During startup grace period, mark as seen but don't notify
          if (inStartupGrace) continue;

          const ws = wsMap.get(wsId);
          // Skip alerts whose workspace lives in another profile — the user
          // in this window can't see that workspace, a toast/notification
          // would just be noise. Unknown-workspace alerts (ws deleted)
          // still surface as legacy fallback.
          if (ws && (ws.profileId || "default") !== activeProfileId) continue;
          const wsName = ws?.name || wsId;
          const tabName = alert.title || alert.panelId || "";

          // An alert that carries a stable `alertId` is its own identity, so
          // exactly-once is already guaranteed by `addAlertEvent()` below.
          // Suppressing it because the panel happens to have an unread thread
          // dropped the SECOND real alert of that panel FOREVER: the id was
          // added to `seenAlertIds` a few lines up, so it could never be
          // reconsidered (V3 review, §4 P1). Thread grouping is the store's
          // job; a new source alert must always reach the history.
          //
          // The id-less legacy fallback keeps the old suppression — without a
          // per-alert identity it is the only guard against one panel's
          // re-broadcast piling up events.
          const alertViewId = alert.sessionId || "";
          if (!alert.alertId) {
            const hasUnread = alertViewId && notifStore.items.some((n) => !n.read && n.viewId === alertViewId);
            if (hasUnread) continue;
          }

          // Detect task-specific alerts (detail starts with "task-")
          const alertDetail = alert.detail as string | undefined;
          const isTaskAlert = typeof alertDetail === "string" && alertDetail.startsWith("task-");
          const taskDetail = isTaskAlert ? (alertDetail as string).replace(/^task-\w+:\s*/, "") : "";
          // Rate-limit alerts: backend emits detail like "rate-limited:claude, resumes 5:50am".
          // Surface them with an exclamation in the title so they stand out from regular
          // waiting alerts — the user wanted to be jolted when an agent gets blocked.
          const isRateLimitAlert = typeof alertDetail === "string" && alertDetail.startsWith("rate-limited");

          let title: string;
          let body: string;
          if (isRateLimitAlert) {
            title = "Rate limit hit!";
            const detailRest = (alertDetail as string).replace(/^rate-limited:\s*/, "");
            body = `${tabName} in ${wsName} — ${detailRest}`;
          } else if (isTaskAlert && (alertDetail as string).startsWith("task-completed")) {
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

          const category = isRateLimitAlert ? "rate-limit" : isTaskAlert ? "task" : "terminal";
          const wsProfileId = ws?.profileId || "default";
          // Exactly-once against the PERSISTED history: this renderer's
          // in-memory `seenAlertIds` cannot see what another window already
          // wrote, nor what this window wrote before a reload.
          const { event: entry, inserted } = notifStore.addAlertEvent({
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
            meta: { profileId: wsProfileId },
            sourceAlertId: key,
            occurredAt: alert.at || new Date().toISOString(),
          });
          logAlertCapture({ alertId: key, workspaceId: wsId, panelId: alert.panelId || "", inserted });
          // A duplicate is silent: no toast, no sound, no OS notification.
          if (!inserted) continue;

          // Attach category on the toast payload so NotificationToast can pick
          // the right icon without reaching into the session store.
          // Skip toast assignment while the dock is pinned — the dock itself
          // shows the arrival, and leaving latestToast stale would surface it
          // as a toast the moment the user unpins.
          if (!notifStore.pinned) {
            latestToast.value = { ...entry, category };
          }
          // Include profile name in system notification body so the OS-level
          // alert identifies which profile the event came from.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const wsProfile = (appStore.payload?.appState as any)?.profiles?.find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (p: any) => p.id === wsProfileId,
          );
          const profileLabel = wsProfile?.name && wsProfileId !== "default" ? wsProfile.name : null;
          const systemBody = profileLabel ? `[${profileLabel}] ${entry.body}` : entry.body;
          fireNotificationAlert(entry.title, systemBody, {
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
      // NOTE: `seenAlertIds` is deliberately NOT pruned here. Pruning on the
      // absence of an alert is precisely the bug this phase removes — see the
      // comment on the set itself.
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

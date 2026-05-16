import { watch } from "vue";
import type { Ref } from "vue";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";
import { fireNotificationAlert } from "./useNotificationSound.js";
import { resolveEventProfileId } from "./useNotificationProfileScope.js";

/**
 * Bridges backend `reviewActivity` deltas (emitted by Azure/GitHub sync) into
 * the notification store so the user gets a notification-center entry and a
 * toast when a PR gets a new comment, review, push, etc.
 *
 * Deduplication is by event id (stable, includes timestamp), so repeated
 * broadcasts of the same snapshot don't re-fire. Startup grace mirrors
 * useNotificationCapture: the first `STARTUP_GRACE_MS` after mount, events are
 * marked as seen without firing toasts — the backend's own seeding logic
 * should already prevent stale events from landing in this window, but this is
 * a belt-and-suspenders guard for the case where the renderer hot-reloads.
 */

const STARTUP_GRACE_MS = 5_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function displayWorkspaceName(event: any): string {
  const repo = event.repositoryName || "Pull request";
  const num = event.pullRequestNumber ? `#${event.pullRequestNumber}` : "";
  return `${repo} ${num}`.trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function eventAlertTitle(event: any): string {
  return event.title || "Pull request update";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function eventAlertBody(event: any): string {
  return event.body || event.pullRequestTitle || "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useReviewNotifications(latestToastRef: Ref<any> | null = null) {
  const appStore = useAppStore();
  const notifStore = useNotificationStore();

  const seenEventIds = new Set<string>();
  const startupAt = Date.now();

  function seedFromPayload() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const azure = (appStore.payload?.azureDevops as any)?.reviewActivity || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const github = (appStore.payload?.github as any)?.reviewActivity || [];
    for (const ev of [...azure, ...github]) {
      if (ev?.id) seenEventIds.add(ev.id);
    }
  }

  seedFromPayload();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function processEvents(events: any[], provider: string) {
    if (!Array.isArray(events) || events.length === 0) return;
    const inStartupGrace = Date.now() - startupAt < STARTUP_GRACE_MS;

    // Events arrive newest-first (manager prepends). Replay oldest-first so
    // a session that gets multiple new events in one poll keeps its latest on
    // top without bubbling mid-sequence.
    const ordered = [...events].reverse();

    const activeProfileId = appStore.activeProfile?.id || "default";

    for (const ev of ordered) {
      if (!ev?.id || seenEventIds.has(ev.id)) continue;
      seenEventIds.add(ev.id);
      if (inStartupGrace) continue;

      // Skip events that belong to a different profile. Review activity is
      // broadcast to every window, but the toast / sound / dock entry must
      // stay scoped — otherwise a window viewing profile B would surface
      // PR pings from profile A. When the owner can't be resolved at all
      // (no backend stamp + no workspace/connection lookup hit), drop the
      // event rather than fall back to the active profile, which would
      // route it into whichever window happens to be looking.
      const eventProfileId = resolveEventProfileId(ev, provider, appStore.payload);
      if (!eventProfileId) continue;
      if (eventProfileId !== activeProfileId) continue;

      const viewId = ev.prKey || ev.id;
      const workspaceId = ev.reviewWorkspaceId || ev.existingWorkspaceId || "";
      const title = eventAlertTitle(ev);
      const body = eventAlertBody(ev);

      const meta = {
        provider: provider || ev.provider || "",
        prKey: ev.prKey || "",
        webUrl: ev.webUrl || "",
        kind: ev.kind || "",
        actor: ev.actor || null,
        connectionId: ev.connectionId || "",
        reviewWorkspaceId: ev.reviewWorkspaceId || "",
        existingWorkspaceId: ev.existingWorkspaceId || "",
        profileId: eventProfileId,
      };
      const entry = notifStore.add({
        title,
        body,
        kind: "review",
        tier: 2,
        urgency: ev.urgency === "urgent" ? "urgent" : "normal",
        workspaceId,
        workspaceName: displayWorkspaceName(ev),
        tabName: ev.pullRequestTitle || "",
        viewId,
        category: "review",
        meta,
      });

      // Skip toast assignment while the dock is pinned — the dock already
      // shows the arrival, and a stale latestToast would pop as a toast the
      // moment the user unpins.
      if (latestToastRef && !notifStore.pinned) {
        // Enrich the toast entry so NotificationToast can render a provider-
        // specific accent. The session carries meta already; the returned
        // event entry doesn't, so attach it here for the toast consumer.
        latestToastRef.value = { ...entry, meta };
      }

      fireNotificationAlert(entry.title, entry.body, {
        tier: 2,
        urgency: entry.urgency,
        sessionKey: `review:${ev.prKey || ev.id}`,
      });
    }
  }

  watch(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (appStore.payload?.azureDevops as any)?.reviewActivity,
    (events) => processEvents(events || [], "azure-devops"),
    { deep: false },
  );

  watch(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (appStore.payload?.github as any)?.reviewActivity,
    (events) => processEvents(events || [], "github"),
    { deep: false },
  );
}

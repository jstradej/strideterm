import { watch } from "vue";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";
import { fireNotificationAlert } from "./useNotificationSound.js";

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

function displayWorkspaceName(event) {
  const repo = event.repositoryName || "Pull request";
  const num = event.pullRequestNumber ? `#${event.pullRequestNumber}` : "";
  return `${repo} ${num}`.trim();
}

function eventAlertTitle(event) {
  return event.title || "Pull request update";
}

function eventAlertBody(event) {
  return event.body || event.pullRequestTitle || "";
}

export function useReviewNotifications(latestToastRef = null) {
  const appStore = useAppStore();
  const notifStore = useNotificationStore();

  const seenEventIds = new Set();
  const startupAt = Date.now();

  function seedFromPayload() {
    const azure = appStore.payload?.azureDevops?.reviewActivity || [];
    const github = appStore.payload?.github?.reviewActivity || [];
    for (const ev of [...azure, ...github]) {
      if (ev?.id) seenEventIds.add(ev.id);
    }
  }

  seedFromPayload();

  function processEvents(events, provider) {
    if (!Array.isArray(events) || events.length === 0) return;
    const inStartupGrace = Date.now() - startupAt < STARTUP_GRACE_MS;

    // Events arrive newest-first (manager prepends). Replay oldest-first so
    // a session that gets multiple new events in one poll keeps its latest on
    // top without bubbling mid-sequence.
    const ordered = [...events].reverse();

    for (const ev of ordered) {
      if (!ev?.id || seenEventIds.has(ev.id)) continue;
      seenEventIds.add(ev.id);
      if (inStartupGrace) continue;

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

      if (latestToastRef) {
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
    () => appStore.payload?.azureDevops?.reviewActivity,
    (events) => processEvents(events, "azure-devops"),
    { deep: false },
  );

  watch(
    () => appStore.payload?.github?.reviewActivity,
    (events) => processEvents(events, "github"),
    { deep: false },
  );
}

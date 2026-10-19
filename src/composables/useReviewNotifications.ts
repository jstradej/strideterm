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
 * Deduplication is by event id (stable, includes timestamp), persisted in a
 * bounded client list so reloads and offline gaps do not replay the rolling
 * backend snapshot. New PR and ready-transition events found during startup
 * are added silently to history.
 */

const STARTUP_GRACE_MS = 5_000;
const SEEN_REVIEW_EVENTS_KEY = "strideterm-review-notified-activity-v1";
const SEEN_REVIEW_EVENTS_MAX = 500;

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

  const seenEventIds = new Set<string>(loadSeenEventIds());
  const startupAt = Date.now();

  function rememberEventId(id: string): void {
    seenEventIds.add(id);
    while (seenEventIds.size > SEEN_REVIEW_EVENTS_MAX) {
      const oldest = seenEventIds.values().next().value;
      if (oldest === undefined) break;
      seenEventIds.delete(oldest);
    }
    try {
      const stored = loadSeenEventIds();
      const next = [...stored.filter((entry) => entry !== id), id].slice(-SEEN_REVIEW_EVENTS_MAX);
      window.localStorage.setItem(SEEN_REVIEW_EVENTS_KEY, JSON.stringify(next));
    } catch {
      // In-memory dedupe still applies for this renderer lifetime.
    }
  }

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

      const kind = String(ev.kind || "");
      if (inStartupGrace && kind !== "pr-new" && kind !== "pr-ready") {
        rememberEventId(ev.id);
        continue;
      }
      rememberEventId(ev.id);

      const viewId = ev.prKey || ev.id;
      const workspaceId = ev.reviewWorkspaceId || ev.existingWorkspaceId || "";
      const existingThread = notifStore.sessions.find(
        (session) => session.workspaceId === workspaceId && session.viewId === viewId,
      );
      const isPrTransition = kind === "pr-new" || kind === "pr-ready";
      const title = eventAlertTitle(ev);
      const body = eventAlertBody(ev);

      const meta = {
        provider: provider || ev.provider || "",
        prKey: ev.prKey || "",
        webUrl: ev.webUrl || "",
        kind: ev.kind || "",
        commentTarget: kind === "pr-new-comment" && ev.commentTarget ? ev.commentTarget : null,
        actor: ev.actor || null,
        connectionId: ev.connectionId || "",
        reviewWorkspaceId: ev.reviewWorkspaceId || "",
        existingWorkspaceId: ev.existingWorkspaceId || "",
        profileId: eventProfileId,
        draftState:
          ev.draftState === "draft" || ev.draftState === "ready"
            ? ev.draftState
            : existingThread?.meta?.draftState || "",
        reviewActionKind: isPrTransition ? kind : existingThread?.meta?.reviewActionKind || "",
        pullRequestTitle: ev.pullRequestTitle || existingThread?.meta?.pullRequestTitle || "",
        pullRequestNumber: ev.pullRequestNumber || existingThread?.meta?.pullRequestNumber || "",
        repositoryName: ev.repositoryName || existingThread?.meta?.repositoryName || "",
        headSha: ev.headSha || existingThread?.meta?.headSha || "",
        sourceEventId: isPrTransition ? ev.id : existingThread?.meta?.sourceEventId || ev.id,
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
        // Goes through the store so an unanswered question keeps the slot and
        // this review notice queues behind it instead of erasing it.
        notifStore.pushToast({ ...entry, meta, category: "review" });
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
    () => [(appStore.payload?.azureDevops as any)?.reviewActivity, appStore.activeProfile?.id],
    ([events]) => processEvents(events || [], "azure-devops"),
    { deep: false, immediate: true },
  );

  watch(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => [(appStore.payload?.github as any)?.reviewActivity, appStore.activeProfile?.id],
    ([events]) => processEvents(events || [], "github"),
    { deep: false, immediate: true },
  );
}

function loadSeenEventIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SEEN_REVIEW_EVENTS_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string").slice(-SEEN_REVIEW_EVENTS_MAX)
      : [];
  } catch {
    return [];
  }
}

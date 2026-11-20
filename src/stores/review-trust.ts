import { defineStore } from "pinia";
import { reactive, ref, watch } from "vue";
import type { Transport } from "../transport.js";
import type { ReviewTrustWaitingEntry } from "../../electron/shared/pull-request-review.js";
import { fireNotificationAlert } from "../composables/useNotificationSound.js";
import { useAppStore } from "./app.js";
import { threadId, useNotificationStore } from "./notifications.js";

export type ReviewTrustOutcome = "pending" | "trusted" | "answered";

export const REVIEW_TRUST_OUTCOME_TEXT: Record<Exclude<ReviewTrustOutcome, "pending">, string> = {
  trusted: "Folder trusted — the review is running",
  answered: "No longer waiting — answered in the terminal or the agent exited",
};

export interface ReviewTrustRecord {
  sessionId: string;
  workspaceId: string;
  profileId: string;
  workspaceName: string;
  alertId: string;
  outcome: ReviewTrustOutcome;
  busy: boolean;
}

const MAX_RECORDS = 30;

export function reviewTrustViewId(sessionId: string): string {
  return `review-trust:${sessionId}`;
}

/**
 * A review the user started (button, notification, phone) runs its agent interactively in a fresh checkout, and the
 * agent first asks whether to trust that folder. The runtime lists such agents in `payload.reviewTrust`; each one
 * becomes an actionable Notification Center question here, answerable without opening the terminal.
 */
export const useReviewTrustStore = defineStore("review-trust", () => {
  const records = ref<ReviewTrustRecord[]>([]);
  let started = false;

  function finish(record: ReviewTrustRecord, outcome: Exclude<ReviewTrustOutcome, "pending">): void {
    if (record.outcome !== "pending") return;
    record.outcome = outcome;
    record.busy = false;
    const notifications = useNotificationStore();
    notifications.rewriteEventBySourceAlertId(record.alertId, {
      title: REVIEW_TRUST_OUTCOME_TEXT[outcome],
      body: record.workspaceName,
      kind: "info",
    });
    notifications.setState(threadId(record.workspaceId, reviewTrustViewId(record.sessionId)), "resolved");
  }

  function add(entry: ReviewTrustWaitingEntry): void {
    const app = useAppStore();
    const workspace = app.payload?.appState?.workspaces?.find((item) => item.id === entry.workspaceId);
    const workspaceName = workspace?.name || "Pull request review";
    const record = reactive<ReviewTrustRecord>({
      sessionId: entry.sessionId,
      workspaceId: entry.workspaceId,
      profileId: entry.profileId,
      workspaceName,
      alertId: `review-trust:${entry.sessionId}:${entry.since}`,
      outcome: "pending",
      busy: false,
    });
    const kept = records.value.filter((item) => item.sessionId !== entry.sessionId || item.outcome === "pending");
    kept.unshift(record);
    while (kept.length > MAX_RECORDS) {
      const oldest = kept.findLastIndex((item) => item.outcome !== "pending");
      if (oldest < 0) break;
      kept.splice(oldest, 1);
    }
    records.value = kept;

    const notifications = useNotificationStore();
    const viewId = reviewTrustViewId(entry.sessionId);
    const meta = { profileId: entry.profileId, threadId: threadId(entry.workspaceId, viewId) };
    const { event, inserted } = notifications.addAlertEvent({
      title: "Review waits for you to trust its folder",
      body: `The agent asks whether to trust the fresh checkout of ${workspaceName} before it starts the review.`,
      kind: "question",
      tier: 1,
      urgency: "normal",
      workspaceId: entry.workspaceId,
      workspaceName,
      tabName: "Folder trust",
      viewId,
      category: "review-trust",
      meta,
      sourceAlertId: record.alertId,
      occurredAt: entry.since,
    });
    if (!inserted) return;
    // No sourceAlertId on the toast: it would be dismissed at once, the backend's attention alerts do not list it.
    if (!notifications.pinned) {
      notifications.pushToast({ ...event, category: "review-trust", viewId, sourceAlertId: undefined, meta });
    }
    fireNotificationAlert(event.title, event.body, {
      tier: 1,
      urgency: "normal",
      kind: "question",
      sessionKey: `review-trust:${entry.workspaceId}`,
      dedupeKey: record.alertId,
    });
  }

  /** Like every live event, a question is raised only in a client showing its profile (the desktop payload is not scoped). */
  function visibleProfileId(): string {
    const app = useAppStore();
    return app.myActiveProfileId ?? app.activeProfile?.id ?? "default";
  }

  function reconcile(): void {
    const app = useAppStore();
    if (!app.payload) return;
    const list = app.payload.reviewTrust?.waiting ?? [];
    const profileId = visibleProfileId();
    for (const entry of list) {
      if (entry.profileId !== profileId) continue;
      if (!records.value.some((item) => item.sessionId === entry.sessionId && item.outcome === "pending")) add(entry);
    }
    for (const record of records.value) {
      if (record.outcome === "pending" && !record.busy && !list.some((item) => item.sessionId === record.sessionId)) {
        finish(record, "answered");
      }
    }
    // A question restored from storage after a reload has no record here; one the runtime no longer lists is over.
    const notifications = useNotificationStore();
    for (const session of notifications.sessions) {
      if (session.category !== "review-trust" || session.state === "resolved") continue;
      const sessionId = session.viewId.replace(/^review-trust:/u, "");
      const known = records.value.some((item) => item.sessionId === sessionId && item.outcome === "pending");
      if (!known && !list.some((item) => item.sessionId === sessionId)) notifications.setState(session.id, "resolved");
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    const app = useAppStore();
    watch(() => [app.payload?.reviewTrust?.waiting, app.myActiveProfileId, Boolean(app.payload)], reconcile, {
      immediate: true,
    });
  }

  async function trust(api: Transport | null, sessionId: string): Promise<void> {
    const record = records.value.find((item) => item.sessionId === sessionId && item.outcome === "pending");
    if (!record || record.busy) return;
    if (!api?.trustReviewFolder) {
      useNotificationStore().showError(
        "Could not trust the review folder",
        new Error("This client cannot answer it. Answer the question in the agent's terminal."),
      );
      return;
    }
    record.busy = true;
    try {
      await api.trustReviewFolder({ sessionId });
      finish(record, "trusted");
    } catch (error) {
      record.busy = false;
      useNotificationStore().showError("Could not trust the review folder", error, {
        workspaceId: record.workspaceId,
        workspaceName: record.workspaceName,
        profileId: record.profileId,
      });
      // The runtime no longer lists it: the question is gone, so is the button.
      if (!(useAppStore().payload?.reviewTrust?.waiting ?? []).some((item) => item.sessionId === sessionId)) {
        finish(record, "answered");
      }
    }
  }

  return { records, start, reconcile, trust };
});

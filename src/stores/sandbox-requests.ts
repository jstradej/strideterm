import { defineStore } from "pinia";
import { reactive, ref } from "vue";
import type { Transport } from "../transport.js";
import { normalizeSandboxDomain } from "../../electron/shared/sandbox.js";
import type { SandboxDeniedRequest } from "../../electron/shared/sandbox.js";
import { fireNotificationAlert } from "../composables/useNotificationSound.js";
import { describeRequestSource, sandboxDestination } from "../lib/sandbox-request-text.js";
import { useAppStore } from "./app.js";
import { threadId, useNotificationStore } from "./notifications.js";

export type SandboxRequestOutcome = "pending" | "allowed-workspace" | "allowed-once" | "refused" | "expired" | "added";
export type SandboxRequestChoice = "workspace" | "once" | "deny";

export const SANDBOX_OUTCOME_TEXT: Record<Exclude<SandboxRequestOutcome, "pending">, string> = {
  "allowed-workspace": "Allowed for this workspace",
  "allowed-once": "Allowed once",
  refused: "Refused",
  expired: "Refused — no answer in time",
  added: "Added to this workspace's allowed destinations",
};

export interface SandboxRequestRecord {
  key: string;
  /** Every sandbox request the same destination raised while this one was waiting; one answer covers them all. */
  ids: string[];
  expiredIds: string[];
  alertId: string;
  workspaceId: string;
  profileId: string;
  sessionId: string;
  host: string;
  destination: string;
  label: string;
  workspaceName: string;
  at: number;
  outcome: SandboxRequestOutcome;
  choice: SandboxRequestChoice | null;
  busy: boolean;
}

const MAX_RECORDS = 50;

export function sandboxThreadViewId(workspaceId: string): string {
  return `sandbox-network:${workspaceId}`;
}

/**
 * Destinations an isolated tab asked for that no rule decides. The sandbox is waiting on each one, so each is an
 * actionable Notification Center entry (one thread per workspace) and its outcome stays there as history. A
 * request nobody answers is refused by the sandbox on its own.
 */
export const useSandboxRequestsStore = defineStore("sandbox-requests", () => {
  const records = ref<SandboxRequestRecord[]>([]);
  let started = false;

  function finish(record: SandboxRequestRecord, outcome: Exclude<SandboxRequestOutcome, "pending">): void {
    record.outcome = outcome;
    record.busy = false;
    record.choice = null;
    const notifications = useNotificationStore();
    notifications.rewriteEventBySourceAlertId(record.alertId, {
      title: SANDBOX_OUTCOME_TEXT[outcome],
      body: `${record.label} · ${record.destination}`,
      kind: "info",
    });
    const waiting = records.value.some((item) => item.workspaceId === record.workspaceId && item.outcome === "pending");
    if (!waiting) {
      notifications.setState(
        threadId(record.workspaceId, sandboxThreadViewId(record.workspaceId)),
        outcome === "expired" ? "finished" : "resolved",
      );
    }
  }

  function upsert(request: SandboxDeniedRequest, silent = false): void {
    if (request.state !== "pending") {
      settle(request);
      return;
    }
    if (records.value.some((item) => item.ids.includes(request.id))) return;
    const destination = sandboxDestination(request);
    const key = `${request.workspaceId}|${destination}`;
    const waiting = records.value.find((item) => item.key === key && item.outcome === "pending");
    if (waiting) {
      waiting.ids.push(request.id);
      return;
    }

    const app = useAppStore();
    const workspaces = app.payload?.appState?.workspaces;
    const { label, workspaceName } = describeRequestSource(request.sessionId, request.workspaceId, workspaces);
    const workspace = workspaces?.find((item) => item.id === request.workspaceId);
    const profileId = workspace?.profileId || app.myActiveProfileId || "default";
    const record = reactive<SandboxRequestRecord>({
      key,
      ids: [request.id],
      expiredIds: [],
      alertId: `sandbox:${request.id}`,
      workspaceId: request.workspaceId,
      profileId,
      sessionId: request.sessionId,
      host: request.host,
      destination,
      label,
      workspaceName,
      at: request.at,
      outcome: "pending",
      choice: null,
      busy: false,
    });
    const kept = records.value.filter((item) => item.key !== key || item.outcome === "pending");
    kept.unshift(record);
    while (kept.length > MAX_RECORDS) {
      const oldest = kept.findLastIndex((item) => item.outcome !== "pending");
      if (oldest < 0) break;
      kept.splice(oldest, 1);
    }
    records.value = kept;

    const notifications = useNotificationStore();
    const viewId = sandboxThreadViewId(request.workspaceId);
    const meta = { profileId, threadId: threadId(request.workspaceId, viewId) };
    const { event, inserted } = notifications.addAlertEvent({
      title: "An isolated tab is waiting for your answer",
      body: `${label} wants to reach ${destination}. It is refused if you do not answer.`,
      kind: "question",
      tier: 1,
      urgency: "normal",
      workspaceId: request.workspaceId,
      workspaceName,
      tabName: "Network access",
      viewId,
      category: "sandbox",
      meta,
      sourceAlertId: record.alertId,
      occurredAt: Number.isFinite(request.at) ? new Date(request.at).toISOString() : new Date().toISOString(),
    });
    if (!inserted) return;
    // No sourceAlertId on the toast: a question toast with one is dismissed as soon as the backend's attention
    // alerts do not list it, and this request is not one of them. Without it the toast follows its thread instead.
    if (!silent && !notifications.pinned) {
      notifications.pushToast({ ...event, category: "sandbox", viewId, sourceAlertId: undefined, meta });
    }
    if (!silent)
      fireNotificationAlert(event.title, event.body, {
        tier: 1,
        urgency: "normal",
        kind: "question",
        sessionKey: `sandbox:${request.workspaceId}`,
        dedupeKey: record.alertId,
      });
  }

  function settle(request: Pick<SandboxDeniedRequest, "id" | "state">): void {
    const record = records.value.find((item) => item.ids.includes(request.id));
    if (!record || record.outcome !== "pending") return;
    if (request.state === "expired") {
      if (!record.expiredIds.includes(request.id)) record.expiredIds.push(request.id);
      if (record.expiredIds.length >= record.ids.length) finish(record, "expired");
      return;
    }
    if (request.state === "denied") {
      finish(record, "refused");
      return;
    }
    if (record.choice) {
      finish(record, record.choice === "workspace" ? "allowed-workspace" : "allowed-once");
      return;
    }
    const domain = normalizeSandboxDomain(record.destination);
    const workspace = useAppStore().payload?.appState?.workspaces?.find((item) => item.id === record.workspaceId);
    const remembered = Boolean(domain && workspace?.sandboxAllowedDomains?.includes(domain));
    finish(record, remembered ? "allowed-workspace" : "allowed-once");
  }

  async function start(api: Transport): Promise<void> {
    if (started || !api.onSandboxDenied || !api.onSandboxDeniedSettled) return;
    started = true;
    api.onSandboxDenied(upsert);
    api.onSandboxDeniedSettled(settle);
    try {
      for (const request of (await api.listSandboxRequests?.()) ?? []) {
        if (request.state === "expired" || request.state === "denied") {
          upsert({ ...request, state: "pending" }, true);
          settle(request);
        } else upsert(request);
      }
    } catch (error) {
      useNotificationStore().showError("Could not load the destinations isolated tabs are waiting on", error);
    }
  }

  async function decide(api: Transport, key: string, choice: SandboxRequestChoice): Promise<void> {
    const record = records.value.find((item) => item.key === key && item.outcome === "pending");
    if (!record || record.busy || !api.decideSandboxRequest) return;
    record.busy = true;
    record.choice = choice;
    let decided = 0;
    let failure: unknown;
    for (const requestId of [...record.ids]) {
      try {
        await api.decideSandboxRequest({ requestId, allow: choice !== "deny", remember: choice === "workspace" });
        decided += 1;
      } catch (error) {
        failure ??= error;
      }
    }
    if (decided > 0) {
      if (record.outcome === "pending") {
        finish(record, choice === "workspace" ? "allowed-workspace" : choice === "once" ? "allowed-once" : "refused");
      }
      return;
    }
    record.busy = false;
    record.choice = null;
    useNotificationStore().showError("Could not answer the isolated tab", failure, {
      workspaceId: record.workspaceId,
      workspaceName: record.workspaceName,
      profileId: record.profileId,
    });
    // The sandbox already gave up on it: leave an expired entry, not a button that can no longer work.
    if (/expired|gone/iu.test(failure instanceof Error ? failure.message : String(failure))) finish(record, "expired");
  }

  /**
   * After the fact: a refused or expired destination can no longer be answered, but the runtime still remembers it
   * for the workspace (validated and capped there), so the next attempt is not asked.
   */
  async function allowForWorkspace(api: Transport, key: string): Promise<void> {
    const record = records.value.find(
      (item) => item.key === key && (item.outcome === "refused" || item.outcome === "expired"),
    );
    if (!record || record.busy || !api.decideSandboxRequest) return;
    const decideSandboxRequest = api.decideSandboxRequest;
    record.busy = true;
    const done = await useNotificationStore().runWithToast(
      "Could not allow the destination",
      async () => {
        await decideSandboxRequest({ requestId: record.ids[0]!, allow: true, remember: true });
      },
      { workspaceId: record.workspaceId, workspaceName: record.workspaceName, profileId: record.profileId },
    );
    record.busy = false;
    if (done) finish(record, "added");
  }

  return { records, start, decide, allowForWorkspace, upsert, settle };
});

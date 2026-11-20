import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useAppStore } from "./app.js";
import { isAutomationDashboardViewId } from "../app/helpers.js";

/**
 * What the dock's Automations icon shows: runs in progress and finished runs
 * this client has not looked at yet. "Looked at" means the automation's
 * dashboard was on screen after the run finished, or the user cleared them.
 * Per client (localStorage), like the other notified-run lists: a run checked
 * on the phone is still new on the desktop.
 */
const STORAGE_KEY = "strideterm-automation-seen-runs";
const SEEN_MAX = 500;
const ACTIVE_STATES = new Set(["starting", "running", "awaiting-user"]);
const FAILED_STATES = new Set(["failed", "timed-out", "interrupted"]);

export interface AutomationActiveRun {
  workspaceId: string;
  name: string;
  state: string;
}

export interface AutomationUnseenRun {
  workspaceId: string;
  runId: string;
  state: string;
  finishedAt: string;
  failed: boolean;
}

interface Stored {
  since: string;
  seen: string[];
}

function readStored(): Stored {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null") as Partial<Stored> | null;
    if (parsed && typeof parsed.since === "string" && Array.isArray(parsed.seen)) {
      return { since: parsed.since, seen: parsed.seen.filter((id): id is string => typeof id === "string") };
    }
  } catch {
    // Unreadable or blocked storage: start a fresh baseline below.
  }
  // First run on this client: runs that finished before now are history, not news.
  const fresh = { since: new Date().toISOString(), seen: [] };
  writeStored(fresh);
  return fresh;
}

function writeStored(value: Stored): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Per-client convenience only; losing it re-shows a badge at worst.
  }
}

export const useAutomationActivityStore = defineStore("automation-activity", () => {
  const app = useAppStore();
  const stored = readStored();
  const since = Date.parse(stored.since) || 0;
  const seen = ref<string[]>(stored.seen);
  const seenSet = computed(() => new Set(seen.value));

  const profileAutomations = computed(() => {
    if (app.isRemoteTransport && !app.myActiveProfileId) return new Map<string, string>();
    const profileId = app.myActiveProfileId ?? app.activeProfile.id;
    return new Map(
      (app.payload?.appState?.workspaces || [])
        .filter(
          (workspace) =>
            workspace.kind === "automation" && workspace.automation && (workspace.profileId || "default") === profileId,
        )
        .map((workspace) => [workspace.id, workspace.name] as const),
    );
  });

  const activeRuns = computed<AutomationActiveRun[]>(() => {
    const summaries = new Map(Object.entries(app.payload?.automations?.byWorkspaceId || {}));
    const result: AutomationActiveRun[] = [];
    for (const [workspaceId, name] of profileAutomations.value) {
      const summary = summaries.get(workspaceId) as { currentRun?: { state?: string } | null } | undefined;
      const state = summary?.currentRun?.state;
      if (state && ACTIVE_STATES.has(state)) result.push({ workspaceId, name, state });
    }
    return result;
  });
  const runningCount = computed(() => activeRuns.value.filter((run) => run.state !== "awaiting-user").length);
  const awaitingCount = computed(() => activeRuns.value.filter((run) => run.state === "awaiting-user").length);

  const unseenRuns = computed<AutomationUnseenRun[]>(() => {
    const result: AutomationUnseenRun[] = [];
    for (const run of app.payload?.automations?.recentRuns || []) {
      const workspaceId = String(run.workspaceId || "");
      const runId = String(run.runId || "");
      const state = String(run.state || "");
      const finishedAt = String(run.finishedAt || "");
      // A run the user stopped themselves is not news to them.
      if (!runId || state === "stopped" || !profileAutomations.value.has(workspaceId)) continue;
      if (seenSet.value.has(runId) || !(Date.parse(finishedAt) >= since)) continue;
      result.push({ workspaceId, runId, state, finishedAt, failed: FAILED_STATES.has(state) });
    }
    return result;
  });
  const unseenCount = computed(() => unseenRuns.value.length);
  const unseenFailedCount = computed(() => unseenRuns.value.filter((run) => run.failed).length);

  function unseenCountFor(workspaceId: string): number {
    return unseenRuns.value.filter((run) => run.workspaceId === workspaceId).length;
  }

  /** Marks the finished runs of one automation (or all in this profile) as looked at. */
  function markSeen(workspaceId?: string): void {
    const ids = unseenRuns.value
      .filter((run) => !workspaceId || run.workspaceId === workspaceId)
      .map((run) => run.runId);
    if (!ids.length) return;
    seen.value = [...seen.value, ...ids].slice(-SEEN_MAX);
    writeStored({ since: stored.since, seen: seen.value });
  }

  // The dashboard on screen is the user looking at its runs, including one that finishes while it is open.
  watch(
    () => [app.activeViewId, app.myActiveWorkspaceId, unseenCount.value] as const,
    ([viewId, workspaceId]) => {
      if (workspaceId && isAutomationDashboardViewId(viewId)) markSeen(workspaceId);
    },
    { immediate: true },
  );

  return {
    activeRuns,
    runningCount,
    awaitingCount,
    unseenRuns,
    unseenCount,
    unseenFailedCount,
    unseenCountFor,
    markSeen,
  };
});

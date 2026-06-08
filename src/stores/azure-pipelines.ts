import { defineStore } from "pinia";
import { ref } from "vue";
import type { Transport } from "../transport.js";
import { useNotificationStore } from "./notifications.js";
import { fireNotificationAlert } from "../composables/useNotificationSound.js";
import type {
  AzurePipelineSummary,
  AzurePipelineRun,
  AzurePipelineRunSeed,
} from "../../electron/shared/types/azure-pipelines.js";

/** A run the user triggered from this client — watched until it finishes so we can notify. */
interface WatchedRun {
  connectionId: string;
  projectName: string;
  pipelineId: number | string;
  runId: number | string;
  pipelineName: string;
  connectionLabel: string;
  workspaceId: string;
  workspaceName: string;
  profileId: string;
}

const POLL_INTERVAL_MS = 30_000;

interface ConnectionPipelines {
  loading: boolean;
  error: string;
  pipelines: AzurePipelineSummary[];
  loaded: boolean;
}

interface PipelineRuns {
  loading: boolean;
  error: string;
  runs: AzurePipelineRun[];
}

interface RunPayload {
  connectionId: string;
  projectName: string;
  pipelineId: number | string;
  branch?: string;
  parameters?: Record<string, string>;
  variables?: Array<{ name: string; value: string; isSecret?: boolean }>;
}

type PipelinesApi = Transport & {
  listAzurePipelines: (p: { connectionId: string }) => Promise<unknown>;
  listAzurePipelineRuns: (p: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
  }) => Promise<unknown>;
  getAzurePipelineRunSeed: (p: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
    runId: number | string;
  }) => Promise<unknown>;
  runAzurePipeline: (p: RunPayload) => Promise<unknown>;
  getAzurePipelineRunStatus: (p: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
    runId: number | string;
  }) => Promise<unknown>;
  cancelAzureBuild: (p: { connectionId: string; projectName: string; buildId: number | string }) => Promise<unknown>;
  getAzureBuildLog: (p: { connectionId: string; projectName: string; buildId: number | string }) => Promise<unknown>;
};

/** A build/run status is terminal once Azure marks it "completed". */
function isCompleted(stateOrStatus: string | undefined): boolean {
  return String(stateOrStatus || "").toLowerCase() === "completed";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * On-demand state for the Azure DevOps "Pipelines" tab. Pipelines are NOT part
 * of the global broadcast payload — they are fetched per connection when the
 * tab is opened and cached here across tab switches until a manual refresh.
 */
export const useAzurePipelinesStore = defineStore("azure-pipelines", () => {
  const byConnection = ref<Record<string, ConnectionPipelines>>({});
  const runsByPipeline = ref<Record<string, PipelineRuns>>({});

  let _api: PipelinesApi | null = null;
  function init(api: Transport): void {
    _api = api as PipelinesApi;
  }

  function ensureConnection(connectionId: string): ConnectionPipelines {
    if (!byConnection.value[connectionId]) {
      byConnection.value[connectionId] = { loading: false, error: "", pipelines: [], loaded: false };
    }
    return byConnection.value[connectionId];
  }

  function runsKey(connectionId: string, pipelineId: number | string): string {
    return `${connectionId}:${pipelineId}`;
  }

  async function load(connectionId: string, { force = false } = {}): Promise<void> {
    if (!_api?.listAzurePipelines || !connectionId) return;
    const entry = ensureConnection(connectionId);
    if (entry.loading) return;
    if (entry.loaded && !force) return;
    entry.loading = true;
    entry.error = "";
    try {
      const result = (await _api.listAzurePipelines({ connectionId })) as AzurePipelineSummary[];
      entry.pipelines = Array.isArray(result) ? result : [];
      entry.loaded = true;
      // If anything is mid-flight, keep the list auto-refreshing in the background.
      if (entry.pipelines.some((p) => p.lastRun && !isCompleted(p.lastRun.status))) ensurePollTimer();
    } catch (err) {
      entry.error = errorMessage(err);
    } finally {
      entry.loading = false;
    }
  }

  async function loadRuns(
    connectionId: string,
    projectName: string,
    pipelineId: number | string,
    { force = false } = {},
  ): Promise<void> {
    if (!_api?.listAzurePipelineRuns) return;
    const key = runsKey(connectionId, pipelineId);
    const existing = runsByPipeline.value[key];
    if (existing?.loading) return;
    if (existing && existing.runs.length && !force) return;
    runsByPipeline.value[key] = { loading: true, error: "", runs: existing?.runs || [] };
    try {
      const result = (await _api.listAzurePipelineRuns({
        connectionId,
        projectName,
        pipelineId,
      })) as AzurePipelineRun[];
      runsByPipeline.value[key] = { loading: false, error: "", runs: Array.isArray(result) ? result : [] };
    } catch (err) {
      runsByPipeline.value[key] = { loading: false, error: errorMessage(err), runs: existing?.runs || [] };
    }
  }

  async function getRunSeed(
    connectionId: string,
    projectName: string,
    pipelineId: number | string,
    runId: number | string,
  ): Promise<AzurePipelineRunSeed> {
    if (!_api?.getAzurePipelineRunSeed) throw new Error("Transport unavailable.");
    return (await _api.getAzurePipelineRunSeed({
      connectionId,
      projectName,
      pipelineId,
      runId,
    })) as AzurePipelineRunSeed;
  }

  async function run(payload: RunPayload): Promise<{ id: number; state: string; result?: string; webUrl: string }> {
    if (!_api?.runAzurePipeline) throw new Error("Transport unavailable.");
    return (await _api.runAzurePipeline(payload)) as { id: number; state: string; result?: string; webUrl: string };
  }

  async function cancel(connectionId: string, projectName: string, buildId: number | string): Promise<void> {
    if (!_api?.cancelAzureBuild) throw new Error("Transport unavailable.");
    await _api.cancelAzureBuild({ connectionId, projectName, buildId });
    // Reflect the cancellation quickly.
    void load(connectionId, { force: true });
  }

  async function getBuildLog(connectionId: string, projectName: string, buildId: number | string): Promise<string> {
    if (!_api?.getAzureBuildLog) throw new Error("Transport unavailable.");
    return (await _api.getAzureBuildLog({ connectionId, projectName, buildId })) as string;
  }

  // --- Completion watcher (notify when a triggered run finishes) ---

  const watchedRuns = new Map<string, WatchedRun>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  function watchKey(connectionId: string, runId: number | string): string {
    return `${connectionId}:${runId}`;
  }

  /** Register a freshly-triggered run so we notify the user once it finishes. */
  function watchRun(run: WatchedRun): void {
    watchedRuns.set(watchKey(run.connectionId, run.runId), run);
    ensurePollTimer();
  }

  function ensurePollTimer(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      void pollTick();
    }, POLL_INTERVAL_MS);
  }

  function stopPollTimer(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function notifyCompletion(run: WatchedRun, status: { result?: string; webUrl: string }): void {
    const result = String(status.result || "").toLowerCase();
    const icon = result === "succeeded" ? "✅" : result === "canceled" ? "⊘" : "❌";
    const resultLabel =
      result === "succeeded"
        ? "succeeded"
        : result === "failed"
          ? "failed"
          : result === "canceled"
            ? "was canceled"
            : `finished (${result || "done"})`;
    const urgency = result === "succeeded" ? "normal" : "urgent";
    const title = `${icon} ${run.pipelineName}`;
    const body = `Run #${run.runId} ${resultLabel}${run.connectionLabel ? ` · ${run.connectionLabel}` : ""}`;

    const notify = useNotificationStore();
    // Dock/bell entry — clicking navigates to the Azure inbox (Pipelines tab).
    notify.add({
      title,
      body,
      kind: "completed",
      tier: 1,
      urgency,
      workspaceId: run.workspaceId,
      workspaceName: run.workspaceName,
      tabName: "Pipelines",
      viewId: "",
      category: "pipeline",
      meta: { profileId: run.profileId, webUrl: status.webUrl },
    });
    // Visible transient toast.
    notify.pushEphemeralToast({ title, body, kind: result === "succeeded" ? "success" : "error", durationMs: 8000 });
    // OS notification (when unfocused) + ding.
    fireNotificationAlert(title, body, {
      tier: 1,
      urgency,
      sessionKey: `pipeline-run:${run.connectionId}:${run.runId}`,
    });
  }

  async function pollTick(): Promise<void> {
    if (ticking || !_api?.getAzurePipelineRunStatus) return;
    ticking = true;
    try {
      // 1) Watched (user-triggered) runs → notify on completion.
      for (const [key, run] of [...watchedRuns.entries()]) {
        try {
          const status = (await _api.getAzurePipelineRunStatus({
            connectionId: run.connectionId,
            projectName: run.projectName,
            pipelineId: run.pipelineId,
            runId: run.runId,
          })) as { state: string; result?: string; webUrl: string };
          if (isCompleted(status.state)) {
            watchedRuns.delete(key);
            notifyCompletion(run, status);
            void load(run.connectionId, { force: true });
            void loadRuns(run.connectionId, run.projectName, run.pipelineId, { force: true });
          }
        } catch {
          // Transient poll error — keep watching, try again next tick.
        }
      }

      // 2) Auto-refresh connections that still have an in-flight latest run.
      const busyConnectionIds = new Set<string>();
      for (const [connectionId, entry] of Object.entries(byConnection.value)) {
        if (entry.pipelines.some((p) => p.lastRun && !isCompleted(p.lastRun.status))) {
          busyConnectionIds.add(connectionId);
        }
      }
      for (const connectionId of busyConnectionIds) {
        void load(connectionId, { force: true });
      }

      // 3) Nothing left to watch or refresh → stand down.
      if (!watchedRuns.size && !busyConnectionIds.size) stopPollTimer();
    } finally {
      ticking = false;
    }
  }

  async function getRunStatus(
    connectionId: string,
    projectName: string,
    pipelineId: number | string,
    runId: number | string,
  ): Promise<{ id: number; state: string; result?: string; webUrl: string }> {
    if (!_api?.getAzurePipelineRunStatus) throw new Error("Transport unavailable.");
    return (await _api.getAzurePipelineRunStatus({ connectionId, projectName, pipelineId, runId })) as {
      id: number;
      state: string;
      result?: string;
      webUrl: string;
    };
  }

  return {
    byConnection,
    runsByPipeline,
    init,
    load,
    loadRuns,
    getRunSeed,
    run,
    cancel,
    watchRun,
    getRunStatus,
    getBuildLog,
  };
});

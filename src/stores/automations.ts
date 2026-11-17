import { defineStore } from "pinia";
import { watch } from "vue";
import { useAppStore } from "./app.js";
import { useNotificationStore } from "./notifications.js";
import type { AutomationDefinitionInput, AutomationCreateInput } from "../../electron/shared/automation-api.js";
import {
  automationRunFinishedSchema,
  type AutomationRunFinished,
} from "../../electron/shared/automation-events-channel.js";
import type { WorkspaceState } from "../../electron/shared/types/state.js";
import {
  OPERATION_KIND_AUTOMATION_PROVISION,
  operationFinishedSchema,
  type OperationFinished,
} from "../../electron/shared/operation-events.js";

/** A confirmed failed operation can be corrected and submitted with a fresh request key. */
export class AutomationCreationFailed extends Error {}

interface EditorInput {
  name: string;
  definition: AutomationDefinitionInput;
  isolated: boolean;
  jiraMcpEnabled: boolean;
  sshMcpEnabled: boolean;
  checkout?: AutomationCreateInput["checkout"];
  idempotencyKey?: string;
  testRun?: boolean;
}

export const useAutomationsStore = defineStore("automations", () => {
  const app = useAppStore();
  const finished = new Map<string, AutomationRunFinished>();
  const waiters = new Map<string, Set<(run: AutomationRunFinished) => void>>();

  function acceptRun(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const { finishedAt: _finishedAt, ...event } = value as Record<string, unknown>;
    const parsed = automationRunFinishedSchema.safeParse(event);
    if (!parsed.success) return;
    const run = parsed.data;
    finished.delete(run.runId);
    finished.set(run.runId, run);
    while (finished.size > 100) finished.delete(finished.keys().next().value!);
    for (const resolve of waiters.get(run.runId) ?? []) resolve(run);
    waiters.delete(run.runId);
  }
  function reconcileRuns(runs: unknown): void {
    if (Array.isArray(runs)) for (const run of runs) acceptRun(run);
  }
  function waitForRun(runId: string, timeoutMs = 24 * 60 * 60_000): Promise<AutomationRunFinished> {
    const existing = finished.get(runId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const callbacks = waiters.get(runId) ?? new Set();
      const timer = setTimeout(() => {
        callbacks.delete(done);
        if (!callbacks.size) waiters.delete(runId);
        reject(new Error("Timed out waiting for automation completion"));
      }, timeoutMs);
      const done = (run: AutomationRunFinished) => {
        clearTimeout(timer);
        resolve(run);
      };
      callbacks.add(done);
      waiters.set(runId, callbacks);
    });
  }
  async function runNow(workspaceId: string): Promise<{ runId: string; completion: Promise<AutomationRunFinished> }> {
    const api = app.getApi();
    if (!api.runAutomationNow) throw new Error("Running automations is unavailable.");
    const result = (await api.runAutomationNow({ workspaceId, idempotencyKey: crypto.randomUUID() })) as {
      runId: string;
    };
    return { runId: result.runId, completion: waitForRun(result.runId) };
  }
  async function setEnabled(workspaceId: string, expectedUpdatedAt: string, enabled: boolean): Promise<unknown> {
    const api = app.getApi();
    if (!api.setAutomationEnabled) throw new Error("Automation editing is unavailable.");
    return api.setAutomationEnabled({ workspaceId, expectedUpdatedAt, enabled });
  }
  async function stopRun(workspaceId: string, runId: string): Promise<unknown> {
    const api = app.getApi();
    if (!api.stopAutomationRun) throw new Error("Stopping automations is unavailable.");
    return api.stopAutomationRun({ workspaceId, runId });
  }
  async function startTestRun(workspaceId: string): Promise<void> {
    const { runId, completion } = await runNow(workspaceId);
    void completion.catch(() => {});
    const getSummary = () =>
      app.payload?.automations?.byWorkspaceId[workspaceId] as
        | {
            currentRun?: { runId: string; state: string; taskWorkspaceId?: string; reviewWorkspaceId?: string };
            lastRun?: { runId: string };
          }
        | undefined;
    const stop = watch(() => [getSummary(), app.myActiveWorkspaceId], check, { deep: true });
    const timer = setTimeout(() => stop(), 30_000);
    function close() {
      clearTimeout(timer);
      stop();
    }
    function check() {
      if (app.myActiveWorkspaceId !== workspaceId) {
        close();
        return;
      }
      const summary = getSummary();
      const run = summary?.currentRun;
      if (!run || run.runId !== runId || !["running", "awaiting-user"].includes(run.state)) {
        if (summary?.lastRun?.runId === runId) close();
        return;
      }
      close();
      void useNotificationStore().runWithToast("Could not open test agent", async () => {
        if (run.taskWorkspaceId || run.reviewWorkspaceId) {
          await app.activateWorkspace(run.taskWorkspaceId || run.reviewWorkspaceId!);
          return;
        }
        const workspace = app.payload?.appState?.workspaces.find((item) => item.id === workspaceId);
        const panel = workspace?.panels.find((item) => item.command !== "__automation-dashboard__");
        if (panel) await app.activateView(`${workspaceId}:${panel.id}`);
      });
    }
    check();
  }
  async function createWorkspace(input: AutomationCreateInput): Promise<string> {
    const api = app.getApi();
    if (!api.createAutomation) throw new Error("Automation creation is unavailable.");
    let operationId: string | undefined;
    const received = new Map<string, OperationFinished>();
    let resolveOutcome!: (outcome: OperationFinished) => void;
    const outcomePromise = new Promise<OperationFinished>((resolve) => {
      resolveOutcome = resolve;
    });
    const receive = (value: unknown) => {
      const parsed = operationFinishedSchema.safeParse(value);
      if (!parsed.success || parsed.data.kind !== OPERATION_KIND_AUTOMATION_PROVISION) return;
      received.set(parsed.data.operationId, parsed.data);
      if (parsed.data.operationId === operationId) resolveOutcome(parsed.data);
    };
    // Subscribe before starting: a fast failure may arrive before the API response with its operation id.
    const unsubscribe = api.onOperationFinished?.(receive);
    const replay = () => {
      for (const outcome of app.payload?.operations?.lastResults ?? []) receive(outcome);
    };
    const stopWatching = watch(() => app.payload?.operations?.lastResults, replay, { deep: true });
    try {
      const result = (await api.createAutomation(input)) as { workspaceId?: string; operationId?: string };
      if (result.workspaceId) return result.workspaceId;
      if (!result.operationId) throw new Error("Automation creation did not return a workspace or operation.");
      operationId = result.operationId;
      replay();
      const outcome = received.get(operationId) ?? (await outcomePromise);
      if ("error" in outcome)
        throw new AutomationCreationFailed(outcome.error.message || "Could not create the automation worktree.");
      const workspaceId = outcome.workspaceId || outcome.result.workspaceId;
      if (typeof workspaceId !== "string" || !workspaceId)
        throw new Error("Automation creation did not return a workspace.");
      return workspaceId;
    } finally {
      unsubscribe?.();
      stopWatching();
    }
  }

  function openEditor(parent: WorkspaceState, workspace?: WorkspaceState): void {
    const onSubmit = async (value: EditorInput): Promise<void> => {
      const api = app.getApi();
      let savedWorkspaceId = workspace?.id;
      if (workspace?.automation) {
        if (!api.updateAutomation) throw new Error("Automation editing is unavailable.");
        const payload = await api.updateAutomation({
          workspaceId: workspace.id,
          expectedUpdatedAt: workspace.automation.updatedAt,
          name: value.name,
          isolated: value.isolated,
          definition: value.definition,
          jiraMcpEnabled: value.jiraMcpEnabled,
          sshMcpEnabled: value.sshMcpEnabled,
        });
        if (payload && typeof payload === "object" && "appState" in payload)
          app.handleBroadcastPayload(payload as never);
      } else {
        const input: AutomationCreateInput = {
          parentWorkspaceId: parent.id,
          name: value.name,
          definition: value.definition,
          isolated: value.isolated,
          jiraMcpEnabled: value.jiraMcpEnabled,
          sshMcpEnabled: value.sshMcpEnabled,
          checkout: value.checkout,
          idempotencyKey: value.idempotencyKey,
        };
        savedWorkspaceId = await createWorkspace(input);
        if (app.overlayProps?.onSubmit !== onSubmit) return;
        try {
          await app.activateWorkspace(savedWorkspaceId);
        } catch (error) {
          useNotificationStore().showError("Automation was created but could not be opened", error);
        }
      }
      if (app.overlayProps?.onSubmit !== onSubmit) return;
      app.closeDialog();
      if (value.testRun && savedWorkspaceId) {
        await useNotificationStore().runWithToast("Could not start test run", async () => {
          if (app.myActiveWorkspaceId !== savedWorkspaceId) await app.activateWorkspace(savedWorkspaceId!);
          await startTestRun(savedWorkspaceId!);
        });
      }
    };
    app.openDialog("AutomationDialog", {
      parent,
      workspace,
      onCancel: () => app.closeDialog(),
      onSubmit,
    });
  }
  return { openEditor, acceptRun, reconcileRuns, waitForRun, runNow, setEnabled, stopRun };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactive, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { AutomationCreationFailed, useAutomationsStore } from "./automations.js";
import type { OperationFinished } from "../../electron/shared/operation-events.js";

vi.mock("./app.js", () => ({ useAppStore: () => app }));
vi.mock("./notifications.js", () => ({
  useNotificationStore: () => ({
    runWithToast: async (_title: string, action: () => Promise<void>) => action(),
    showError: vi.fn(),
    pushEphemeralToast: vi.fn(),
  }),
}));

const runId = "d10a3220-1505-4c4c-a19a-92aa6726e911";
type RunSummary = {
  currentRun?: { runId: string; state: string; taskWorkspaceId?: string };
  lastRun?: { runId: string };
};
const listeners = new Set<(outcome: OperationFinished) => void>();
const api = {
  createAutomation: vi.fn(async (): Promise<{ workspaceId?: string; operationId?: string }> => ({
    workspaceId: "auto",
  })),
  onOperationFinished: vi.fn((listener: (outcome: OperationFinished) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }),
  runAutomationNow: vi.fn(async () => ({ runId })),
};
const app = reactive({
  myActiveWorkspaceId: "project",
  payload: {
    operations: { lastResults: [] as OperationFinished[] },
    appState: {
      workspaces: [
        {
          id: "auto",
          panels: [
            { id: "dash", command: "__automation-dashboard__" },
            { id: "agent", command: "claude" },
          ],
        },
      ],
    },
    automations: { byWorkspaceId: {} as Record<string, RunSummary> },
  },
  getApi: () => api,
  overlayProps: {} as { onSubmit?: unknown },
  openDialog: vi.fn((_name: string, props: { onSubmit: (_value: unknown) => Promise<void> }) => {
    app.overlayProps = props;
  }),
  closeDialog: vi.fn(() => {
    app.overlayProps = {};
  }),
  activateWorkspace: vi.fn(async (id: string) => {
    app.myActiveWorkspaceId = id;
  }),
  activateView: vi.fn(async (_id: string) => undefined),
});

async function saveAndTest() {
  const store = useAutomationsStore();
  store.openEditor({ id: "project" } as never);
  await app.openDialog.mock.calls[0]![1].onSubmit({ name: "Disk usage", definition: {}, testRun: true });
  return store;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setActivePinia(createPinia());
  app.myActiveWorkspaceId = "project";
  app.payload.automations.byWorkspaceId = {};
  app.payload.operations.lastResults = [];
  app.overlayProps = {};
  listeners.clear();
  api.createAutomation.mockResolvedValue({ workspaceId: "auto" });
});

describe("automation worktree creation", () => {
  const outcome: OperationFinished = {
    operationId: "create-1",
    kind: "automation.provision",
    profileId: "default",
    finishedAt: "2026-11-17T12:00:00Z",
    workspaceId: "auto",
    result: { workspaceId: "auto" },
  };
  function start() {
    useAutomationsStore().openEditor({ id: "project" } as never);
    return app.openDialog.mock.calls
      .at(-1)![1]
      .onSubmit({ name: "Job", definition: {}, checkout: { mode: "worktree", branch: "auto/job" } });
  }
  it("keeps the editor pending until the worktree actually exists", async () => {
    api.createAutomation.mockResolvedValue({ operationId: outcome.operationId });
    const saving = start();
    await nextTick();
    expect(app.closeDialog).not.toHaveBeenCalled();
    expect(app.activateWorkspace).not.toHaveBeenCalled();
    for (const listener of listeners) listener(outcome);
    await saving;
    expect(app.activateWorkspace).toHaveBeenCalledExactlyOnceWith("auto");
    expect(app.closeDialog).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
  it("returns a definitive failure to the open form without navigating", async () => {
    api.createAutomation.mockResolvedValue({ operationId: outcome.operationId });
    const saving = start();
    const rejected = expect(saving).rejects.toBeInstanceOf(AutomationCreationFailed);
    await nextTick();
    const { result: _result, ...base } = outcome;
    for (const listener of listeners)
      listener({ ...base, error: { code: "FAILED", message: "Branch already exists" } });
    await rejected;
    expect(app.closeDialog).not.toHaveBeenCalled();
    expect(app.activateWorkspace).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
  it("handles an outcome arriving before the API response", async () => {
    api.createAutomation.mockImplementationOnce(async () => {
      for (const listener of listeners) listener(outcome);
      return { operationId: outcome.operationId };
    });
    await start();
    expect(app.closeDialog).toHaveBeenCalledOnce();
  });
  it("recovers a missed event from a later state payload", async () => {
    api.createAutomation.mockResolvedValue({ operationId: outcome.operationId });
    const saving = start();
    await nextTick();
    app.payload.operations.lastResults = [outcome];
    await saving;
    expect(app.closeDialog).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
  it("does not close or steal focus from a replacement dialog", async () => {
    api.createAutomation.mockResolvedValue({ operationId: outcome.operationId });
    const saving = start();
    await nextTick();
    app.overlayProps = {};
    for (const listener of listeners) listener(outcome);
    await saving;
    expect(app.closeDialog).not.toHaveBeenCalled();
    expect(app.activateWorkspace).not.toHaveBeenCalled();
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("automation setup test run", () => {
  it("waits for launch before opening the agent, then accepts completion", async () => {
    const store = await saveAndTest();
    expect(api.createAutomation).toHaveBeenCalledOnce();
    expect(api.runAutomationNow).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "auto" }));
    app.payload.automations.byWorkspaceId.auto = { currentRun: { runId, state: "starting" } };
    await nextTick();
    expect(app.activateView).not.toHaveBeenCalled();
    app.payload.automations.byWorkspaceId.auto!.currentRun!.state = "awaiting-user";
    await nextTick();
    expect(app.activateView).toHaveBeenCalledExactlyOnceWith("auto:agent");
    store.acceptRun({ workspaceId: "auto", profileId: "default", runId, state: "succeeded" });
  });
  it("does not steal focus when the user navigates away during startup", async () => {
    const store = await saveAndTest();
    app.myActiveWorkspaceId = "another-project";
    await nextTick();
    app.payload.automations.byWorkspaceId.auto = { currentRun: { runId, state: "running" } };
    await nextTick();
    expect(app.activateView).not.toHaveBeenCalled();
    store.acceptRun({ workspaceId: "auto", profileId: "default", runId, state: "failed" });
  });
  it("opens the worker/judge workspace for a task executor", async () => {
    const store = await saveAndTest();
    app.payload.automations.byWorkspaceId.auto = { currentRun: { runId, state: "running", taskWorkspaceId: "task" } };
    await nextTick();
    expect(app.activateWorkspace).toHaveBeenLastCalledWith("task");
    expect(app.activateView).not.toHaveBeenCalled();
    store.acceptRun({ workspaceId: "auto", profileId: "default", runId, state: "succeeded" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAppStore } from "../../stores/app.js";
import AutomationDashboardPane from "./AutomationDashboardPane.vue";
import { useSandboxRequestsStore } from "../../stores/sandbox-requests.js";
import CustomSelect from "../common/CustomSelect.vue";

function setup(api: Record<string, unknown>) {
  const app = useAppStore();
  app.payload = {
    appState: {
      workspaces: ["first", "second"].map((id) => ({
        id,
        name: id,
        panels: [{ id: "dash", command: "__automation-dashboard__" }],
        automation: {
          enabled: true,
          trigger: { type: "schedule", kind: "interval", everyMinutes: 60 },
          executor: { type: "agent", agent: { providerId: "claude" } },
        },
      })),
    },
    automations: { byWorkspaceId: {} },
  } as never;
  vi.spyOn(app, "getApi").mockReturnValue(api as never);
  return mount(AutomationDashboardPane, { props: { workspaceId: "first" } });
}

function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => setActivePinia(createPinia()));
describe("AutomationDashboardPane", () => {
  it("filters the whole stored history by period, state and text, with pages", async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const older = new Date(today);
    older.setDate(older.getDate() - 8);
    const history = [
      ...Array.from({ length: 25 }, (_, index) => ({
        runId: `today-${index}`,
        state: "succeeded",
        startedAt: today.toISOString(),
      })),
      { runId: "yesterday", state: "failed", startedAt: yesterday.toISOString(), reason: "needle" },
      { runId: "older", state: "interrupted", startedAt: older.toISOString() },
    ];
    const wrapper = setup({ listAutomationRuns: vi.fn().mockResolvedValue({ runs: history, total: history.length }) });
    await flushPromises();
    expect(wrapper.findAll(".runs li")).toHaveLength(20);
    expect(wrapper.get(".history-summary").text()).toContain("27 matching");
    await wrapper
      .findAll(".history-periods button")
      .find((button) => button.text() === "Today")!
      .trigger("click");
    expect(wrapper.get(".history-summary").text()).toContain("25 matching");
    await wrapper
      .findAll(".history-pagination button")
      .find((button) => button.text() === "Next")!
      .trigger("click");
    expect(wrapper.findAll(".runs li")).toHaveLength(5);
    await wrapper
      .findAll(".history-periods button")
      .find((button) => button.text() === "Yesterday")!
      .trigger("click");
    expect(wrapper.findAll(".runs li")).toHaveLength(1);
    await wrapper
      .findAllComponents(CustomSelect)
      .find(
        (select) => (select.props() as unknown as { ariaLabel: string }).ariaLabel === "Filter run history by state",
      )!
      .setValue("failed");
    await wrapper.get('[aria-label="Search run history"]').setValue("needle");
    expect(wrapper.findAll(".runs li")).toHaveLength(1);
    await wrapper
      .findAll(".history-periods button")
      .find((button) => button.text() === "Today")!
      .trigger("click");
    expect(wrapper.get(".history-empty").text()).toContain("No runs match");
    await wrapper
      .findAll(".history-summary button")
      .find((button) => button.text() === "Clear filters")!
      .trigger("click");
    expect(wrapper.get(".history-summary").text()).toContain("27 matching");
    wrapper.unmount();
  });
  it("confirms deleting finished records, preserves active runs, and refreshes history", async () => {
    let history = [
      { runId: "done", state: "succeeded", startedAt: new Date().toISOString() },
      { runId: "active", state: "running", startedAt: new Date().toISOString() },
    ];
    const remove = vi.fn(async () => {
      history = history.filter((run) => run.runId !== "done");
      return { deleted: 1 };
    });
    const wrapper = setup({
      listAutomationRuns: vi.fn(async () => ({ runs: [...history] })),
      deleteAutomationRuns: remove,
    });
    const confirm = vi.spyOn(useAppStore(), "confirmInApp").mockResolvedValue(false);
    await flushPromises();
    const bulkDelete = () =>
      wrapper.findAll(".history-summary button").find((button) => button.text().startsWith("Delete finished"))!;
    await bulkDelete().trigger("click");
    await flushPromises();
    expect(remove).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    await bulkDelete().trigger("click");
    await flushPromises();
    expect(remove).toHaveBeenCalledExactlyOnceWith({ workspaceId: "first", runIds: ["done"] });
    expect(wrapper.findAll(".runs li")).toHaveLength(1);
    expect(wrapper.get(".runs li").text()).toContain("running");
    expect(wrapper.get(".runs li").findAll(".history-delete")).toHaveLength(0);
    wrapper.unmount();
  });
  it("keeps the loaded history on a state broadcast that does not change a run", async () => {
    const list = vi.fn().mockResolvedValue({ runs: [{ runId: "done", state: "succeeded" }] });
    const wrapper = setup({ listAutomationRuns: list });
    const app = useAppStore();
    const payload = structuredClone(app.payload!);
    payload.automations!.byWorkspaceId.first = { lastRun: { runId: "done", state: "succeeded" } };
    app.payload = payload;
    await flushPromises();
    list.mockClear();
    app.payload = structuredClone(app.payload!);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".runs").exists()).toBe(true);
    await flushPromises();
    expect(list).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("puts terminal confirmation and network requests in a prominent action section before the metrics", async () => {
    const wrapper = setup({ listAutomationRuns: vi.fn().mockResolvedValue({ runs: [] }) });
    const app = useAppStore();
    const payload = structuredClone(app.payload!);
    payload.automations!.byWorkspaceId.first = { currentRun: { runId: "waiting", state: "awaiting-user" } };
    payload.appState.workspaces[0]!.panels.push({ id: "agent", command: "claude" } as never);
    app.payload = payload;
    const activate = vi.spyOn(app, "activateView").mockResolvedValue(undefined);
    await flushPromises();
    const attention = wrapper.get(".dashboard-section--attention");
    expect(attention.text()).toContain("The agent is waiting for your answer");
    expect(
      attention.element.compareDocumentPosition(wrapper.get(".details").element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await attention.get("button").trigger("click");
    expect(activate).toHaveBeenCalledWith("first:agent");
    useSandboxRequestsStore().records = [{ workspaceId: "first", outcome: "pending" }] as never;
    await flushPromises();
    expect(wrapper.findAll(".dashboard-section--attention")).toHaveLength(1);
    expect(wrapper.get(".dashboard-section--attention").text()).toContain("Action required · Network access");
    wrapper.unmount();
  });
  it("shows status and starts a run through the transport", async () => {
    const app = useAppStore();
    app.payload = {
      appState: {
        workspaces: [
          { id: "parent", kind: "manual" },
          {
            id: "auto",
            name: "Daily",
            kind: "automation",
            panels: [{ id: "dash", command: "__automation-dashboard__" }],
            automation: {
              parentWorkspaceId: "parent",
              enabled: true,
              updatedAt: "2026-01-01T00:00:00Z",
              prompt: "Check status",
              trigger: { type: "schedule", kind: "interval", everyMinutes: 60 },
              executor: { type: "agent", agent: { providerId: "claude", model: "" } },
            },
          },
        ],
      },
      automations: { paused: false, byWorkspaceId: { auto: { state: "idle", pending: 0 } }, recentRuns: [] },
    } as never;
    const run = vi.fn().mockResolvedValue({ runId: "run" });
    const list = vi.fn().mockResolvedValue({ runs: [], total: 0 });
    vi.spyOn(app, "getApi").mockReturnValue({ runAutomationNow: run, listAutomationRuns: list } as never);
    const wrapper = mount(AutomationDashboardPane, { props: { workspaceId: "auto" } });
    await flushPromises();
    expect(wrapper.text()).toContain("Daily");
    expect(wrapper.text()).toContain("Every 60 minutes");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Run now")!
      .trigger("click");
    await flushPromises();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "auto", idempotencyKey: expect.any(String) }),
    );
  });
  it("ignores history from a workspace that is no longer open", async () => {
    const first = deferred<{ runs: Array<{ runId: string; state: string; reason: string }> }>();
    const list = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ runs: [{ runId: "second-run", state: "failed", reason: "Second history" }] });
    const wrapper = setup({ listAutomationRuns: list });
    await wrapper.setProps({ workspaceId: "second" } as never);
    await flushPromises();
    expect(wrapper.text()).toContain("Second history");
    first.resolve({ runs: [{ runId: "first-run", state: "failed", reason: "First history" }] });
    await flushPromises();
    expect(wrapper.text()).toContain("Second history");
    expect(wrapper.text()).not.toContain("First history");
  });
  it("shows a failed run's exit code and output and opens its agent after completion", async () => {
    const run = {
      runId: "failed-run",
      state: "failed",
      reason: "terminal-exit",
      exitCode: 17,
      sessionId: "first:agent",
    };
    const wrapper = setup({
      listAutomationRuns: vi.fn().mockResolvedValue({ runs: [run] }),
      getAutomationRunResult: vi
        .fn()
        .mockResolvedValue({ result: null, output: "Error: provider authentication failed", exitCode: 17 }),
    });
    const app = useAppStore();
    const payload = structuredClone(app.payload!);
    payload.appState.workspaces[0]!.panels.push({ id: "agent", title: "Agent", command: "claude" } as never);
    app.payload = payload;
    const activate = vi.spyOn(app, "activateView").mockResolvedValue(undefined);
    await flushPromises();
    expect(wrapper.text()).toContain("The agent exited with code 17");
    await wrapper
      .get(".runs")
      .findAll("button")
      .find((button) => button.text() === "Details")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get(".result").text()).toContain("Error: provider authentication failed");
    expect(wrapper.get(".runs li .result").text()).toContain("Error: provider authentication failed");
    const hideDetails = wrapper.get('.runs button[aria-expanded="true"]');
    expect(hideDetails.text()).toBe("Hide details");
    await hideDetails.trigger("click");
    expect(wrapper.find(".result").exists()).toBe(false);
    expect(wrapper.get('.runs button[aria-expanded="false"]').text()).toBe("Details");
    await wrapper
      .get(".dashboard-header")
      .findAll("button")
      .find((button) => button.text() === "Open agent")!
      .trigger("click");
    expect(activate).toHaveBeenCalledWith("first:agent");
    wrapper.unmount();
  });
  it("does not reopen run details when a response arrives after Close", async () => {
    const result = deferred<{ result: null; output: string }>();
    const wrapper = setup({
      listAutomationRuns: vi.fn().mockResolvedValue({ runs: [{ runId: "failed-run", state: "failed" }] }),
      getAutomationRunResult: vi.fn().mockReturnValue(result.promise),
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Details")!
      .trigger("click");
    await flushPromises();
    await wrapper
      .get(".result")
      .findAll("button")
      .find((button) => button.text() === "Close")!
      .trigger("click");
    result.resolve({ result: null, output: "Late output" });
    await flushPromises();
    expect(wrapper.find(".result").exists()).toBe(false);
    wrapper.unmount();
  });
  it("clears results and ignores a late result after changing workspace", async () => {
    const result = deferred<{ result: string }>();
    const wrapper = setup({
      listAutomationRuns: vi.fn().mockResolvedValue({ runs: [{ runId: "run", state: "succeeded" }] }),
      getAutomationRunResult: vi.fn().mockReturnValue(result.promise),
    });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Result")!
      .trigger("click");
    await wrapper.setProps({ workspaceId: "second" } as never);
    result.resolve({ result: "First workspace result" });
    await flushPromises();
    expect(wrapper.text()).not.toContain("First workspace result");
  });
  it("shows workspace activation failures in the dashboard", async () => {
    const wrapper = setup({
      listAutomationRuns: vi
        .fn()
        .mockResolvedValue({ runs: [{ runId: "run", state: "succeeded", taskWorkspaceId: "task" }] }),
    });
    vi.spyOn(useAppStore(), "activateWorkspace").mockRejectedValue(new Error("Workspace was removed"));
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Open workspace")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Workspace was removed");
  });
  it("keeps the most recently requested result when responses arrive out of order", async () => {
    const first = deferred<{ result: string }>();
    const second = deferred<{ result: string }>();
    const wrapper = setup({
      listAutomationRuns: vi.fn().mockResolvedValue({
        runs: [
          { runId: "first-run", state: "succeeded" },
          { runId: "second-run", state: "succeeded" },
        ],
      }),
      getAutomationRunResult: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    });
    await flushPromises();
    const buttons = wrapper.findAll("button").filter((button) => button.text() === "Result");
    await buttons[0]!.trigger("click");
    await buttons[1]!.trigger("click");
    second.resolve({ result: "Second result" });
    await flushPromises();
    first.resolve({ result: "First result" });
    await flushPromises();
    expect(wrapper.find(".result").text()).toContain("Second result");
    expect(wrapper.find(".result").text()).not.toContain("First result");
  });
});

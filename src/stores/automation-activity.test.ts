import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useAppStore } from "./app.js";
import { useAutomationActivityStore } from "./automation-activity.js";
import type { StatePayload } from "../../electron/shared/types/state.js";

const KEY = "strideterm-automation-seen-runs";
const SINCE = "2026-11-20T08:00:00.000Z";

function run(runId: string, state: string, workspaceId = "auto", finishedAt = "2026-11-20T09:00:00.000Z") {
  return { runId, state, workspaceId, profileId: workspaceId === "foreign" ? "p2" : "p1", finishedAt };
}

function makePayload(recentRuns: Array<Record<string, unknown>>, byWorkspaceId: Record<string, unknown> = {}) {
  const automation = { parentWorkspaceId: "repo", enabled: true, trigger: { type: "event" } };
  return {
    meta: {},
    appState: {
      activeWorkspaceId: "repo",
      profiles: [
        { id: "p1", name: "Personal" },
        { id: "p2", name: "Work" },
      ],
      windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "repo" }],
      workspaces: [
        { id: "repo", name: "Repository", kind: "terminal", profileId: "p1", panels: [] },
        {
          id: "auto",
          name: "Nightly",
          kind: "automation",
          profileId: "p1",
          panels: [{ id: "dash", command: "__automation-dashboard__" }],
          automation,
        },
        { id: "other", name: "Reviews", kind: "automation", profileId: "p1", panels: [], automation },
        { id: "foreign", name: "Work", kind: "automation", profileId: "p2", panels: [], automation },
      ],
      settings: {},
    },
    automations: { paused: false, byWorkspaceId, recentRuns },
    attention: { sessions: {}, alerts: [] },
    taskRunner: {},
  } as unknown as StatePayload;
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  window.localStorage.setItem(KEY, JSON.stringify({ since: SINCE, seen: [] }));
  vi.stubGlobal("strideterm", { startupFlags: { windowId: "slot1" } });
});
afterEach(() => vi.unstubAllGlobals());

describe("automation activity", () => {
  it("counts finished runs of this profile that were not checked, failures apart, and skips stopped ones", () => {
    const app = useAppStore();
    app.payload = makePayload([
      run("ok", "succeeded"),
      run("bad", "failed", "other"),
      run("late", "timed-out"),
      run("mine", "stopped"),
      run("old", "succeeded", "auto", "2026-11-20T07:00:00.000Z"),
      run("elsewhere", "failed", "foreign"),
    ]);
    const activity = useAutomationActivityStore();
    expect(activity.unseenRuns.map((item) => item.runId)).toEqual(["ok", "bad", "late"]);
    expect(activity.unseenFailedCount).toBe(2);
    expect(activity.unseenCountFor("auto")).toBe(2);
  });

  it("starts a fresh client with an empty baseline instead of every past run", () => {
    window.localStorage.clear();
    const app = useAppStore();
    app.payload = makePayload([run("ok", "succeeded")]);
    expect(useAutomationActivityStore().unseenCount).toBe(0);
    expect(JSON.parse(window.localStorage.getItem(KEY) || "{}").since).toEqual(expect.any(String));
  });

  it("marks one automation or all of them as checked and remembers it", () => {
    const app = useAppStore();
    app.payload = makePayload([run("ok", "succeeded"), run("bad", "failed", "other")]);
    const activity = useAutomationActivityStore();
    activity.markSeen("other");
    expect(activity.unseenRuns.map((item) => item.runId)).toEqual(["ok"]);
    activity.markSeen();
    expect(activity.unseenCount).toBe(0);

    setActivePinia(createPinia());
    useAppStore().payload = makePayload([run("ok", "succeeded"), run("bad", "failed", "other"), run("new", "failed")]);
    expect(useAutomationActivityStore().unseenRuns.map((item) => item.runId)).toEqual(["new"]);
  });

  it("treats the automation's dashboard on screen as checking its runs, including one finishing while open", async () => {
    const viewingAutomation = (runs: Array<Record<string, unknown>>) => {
      const payload = makePayload(runs);
      payload.appState.windowSlots[0]!.activeWorkspaceId = "auto";
      (payload as unknown as { workspace: unknown }).workspace = payload.appState.workspaces.find(
        (workspace) => workspace.id === "auto",
      );
      return payload;
    };
    const app = useAppStore();
    app.payload = viewingAutomation([run("ok", "succeeded"), run("bad", "failed", "other")]);
    const activity = useAutomationActivityStore();
    await nextTick();
    expect(activity.unseenCount).toBe(2);
    app.activeViewId = "automation-dashboard:dash";
    await nextTick();
    expect(activity.unseenRuns.map((item) => item.runId)).toEqual(["bad"]);

    app.payload = viewingAutomation([run("ok", "succeeded"), run("bad", "failed", "other"), run("fresh", "succeeded")]);
    await nextTick();
    expect(app.activeViewId).toBe("automation-dashboard:dash");
    expect(activity.unseenRuns.map((item) => item.runId)).toEqual(["bad"]);
  });

  it("reports running and waiting runs of this profile only", () => {
    const app = useAppStore();
    app.payload = makePayload([], {
      auto: { currentRun: { runId: "a", state: "running" } },
      other: { currentRun: { runId: "b", state: "awaiting-user" } },
      foreign: { currentRun: { runId: "c", state: "running" } },
    });
    const activity = useAutomationActivityStore();
    expect(activity.runningCount).toBe(1);
    expect(activity.awaitingCount).toBe(1);
    expect(activity.activeRuns.map((item) => item.name)).toEqual(["Nightly", "Reviews"]);
  });
});

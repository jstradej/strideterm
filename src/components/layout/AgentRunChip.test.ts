import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import AgentRunChip from "./AgentRunChip.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

/**
 * The chip counts SUPERVISED agents only — a task agent or an attached /
 * Companion task (V3 review, Fáze 1). A hand-opened Claude Code panel in a
 * normal workspace is not counted here, so the chip, the sidebar's RUNNING
 * section and the dock's Agents tab can never disagree.
 */
function taskWorkspace(id: string, name: string, state: string, startedAt: number, profileId = "default"): AnyApi {
  return {
    id,
    name,
    cwd: `/${id}`,
    kind: "task",
    profileId,
    panels: [
      { id: "worker", title: "Worker Claude" },
      { id: "judge", title: "Judge Codex" },
    ],
    task: {
      taskId: `t-${id}`,
      state,
      workerPanelId: "worker",
      judgePanelId: "judge",
      startedAt,
      totalPausedMs: 0,
      pausedAt: null,
      finishedAt: null,
    },
  };
}

/** A normal workspace with an agent-like panel but no task at all. */
function plainWorkspace(id: string, name: string, profileId = "default"): AnyApi {
  return { id, name, cwd: `/${id}`, kind: "terminal", profileId, panels: [{ id: "claude", title: "Claude" }] };
}

function makePayload(workspaces: AnyApi[], sessions: AnyApi = {}, taskRunner: AnyApi = {}): AnyApi {
  return {
    appState: {
      activeWorkspaceId: workspaces[0]?.id || "",
      activeProfileId: "default",
      profiles: [
        { id: "default", name: "Default" },
        { id: "other", name: "Other" },
      ],
      workspaces,
      workspaceGrid: null,
      windowSlots: [{ id: "win-test", profileId: "default", activeWorkspaceId: workspaces[0]?.id || "" }],
      settings: {},
    },
    attention: { sessions, alerts: [] },
    taskRunner,
  };
}

function runningSession(workspaceId: string, panelId: string, agoMs: number): AnyApi {
  return {
    workspaceId,
    panelId,
    activity: "running",
    agentLike: true,
    hasUserInput: true,
    activityStartedAt: Date.now() - agoMs,
  };
}

describe("AgentRunChip", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  it("renders nothing while no supervised agent runs, and the count once one does", async () => {
    const store = useAppStore();
    // The live runner snapshot is what moves a task in and out of RUNNING —
    // the same field every task surface prefers over the persisted state.
    const workspaces = [taskWorkspace("ws-a", "Alpha", "running", Date.now() - 60_000)];
    store.payload = makePayload(workspaces, {}, { "ws-a": { state: "paused" } });

    const wrapper = mount(AgentRunChip);
    expect(wrapper.find('[data-role="agent-run-chip"]').exists()).toBe(false);

    store.payload = makePayload(workspaces, {}, { "ws-a": { state: "running" } });
    await nextTick();
    expect(wrapper.get('[data-role="agent-run-chip"]').text()).toContain("1");
  });

  it("counts the whole active profile, not the active workspace — and never another profile", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = makePayload([
      taskWorkspace("ws-a", "Alpha", "running", now - 60_000),
      taskWorkspace("ws-b", "Beta", "judge-evaluating", now - 120_000),
      taskWorkspace("ws-x", "Foreign", "running", now - 60_000, "other"),
    ]);

    const wrapper = mount(AgentRunChip);
    expect(wrapper.get('[data-role="agent-run-chip"]').get("strong").text()).toBe("2");
  });

  it("does not count a plain agent-like terminal session", async () => {
    const store = useAppStore();
    const plain = plainWorkspace("ws-plain", "Plain");
    const session = { "ws-plain:claude": runningSession("ws-plain", "claude", 60_000) };
    store.payload = makePayload([plain], session);

    const wrapper = mount(AgentRunChip);
    expect(wrapper.find('[data-role="agent-run-chip"]').exists()).toBe(false);

    // …and it does not inflate the count when a real task IS running.
    store.payload = makePayload([plain, taskWorkspace("ws-task", "Task", "running", Date.now() - 60_000)], session);
    await nextTick();
    expect(wrapper.get('[data-role="agent-run-chip"]').get("strong").text()).toBe("1");
  });

  it("breaks the count down per workspace with elapsed in its tooltip", () => {
    const store = useAppStore();
    const now = Date.now();
    store.payload = makePayload([
      taskWorkspace("ws-a", "Alpha", "running", now - 3 * 60 * 60 * 1000),
      taskWorkspace("ws-b", "Beta", "running", now - 5 * 60 * 1000),
    ]);

    const title = mount(AgentRunChip).get('[data-role="agent-run-chip"]').attributes("title") || "";
    expect(title).toContain("2 agents running");
    expect(title).toContain("Alpha › Worker Claude — 3h 00m");
    expect(title).toContain("Beta › Worker Claude — 5m");
  });

  it("clicking it asks the dock to open on the Agents tab, without touching any thread", async () => {
    const store = useAppStore();
    const notifications = useNotificationStore();
    store.payload = makePayload([taskWorkspace("ws-a", "Alpha", "running", Date.now() - 60_000)]);
    const openPanelOnTab = vi.spyOn(notifications, "openPanelOnTab");

    const wrapper = mount(AgentRunChip);
    await wrapper.get('[data-role="agent-run-chip"]').trigger("click");

    expect(openPanelOnTab).toHaveBeenCalledWith("agents");
    expect(notifications.sessions).toEqual([]);
    expect(notifications.unreadCount).toBe(0);
  });

  it("stays rendered while the dock is pinned, unlike the bell", async () => {
    const store = useAppStore();
    const notifications = useNotificationStore();
    store.payload = makePayload([taskWorkspace("ws-a", "Alpha", "running", Date.now() - 60_000)]);

    const wrapper = mount(AgentRunChip);
    notifications.pinned = true;
    await nextTick();

    expect(wrapper.find('[data-role="agent-run-chip"]').exists()).toBe(true);
  });
});

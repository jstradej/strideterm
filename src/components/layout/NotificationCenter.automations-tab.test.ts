import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import NotificationCenter from "./NotificationCenter.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { apiKey } from "../../types/keys.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

function makePayload(): StatePayload {
  const automation = {
    parentWorkspaceId: "repo",
    enabled: true,
    trigger: { type: "schedule", kind: "interval", everyMinutes: 60, anchor: "2026-01-01T00:00:00Z" },
  };
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
          name: "Nightly check",
          kind: "automation",
          profileId: "p1",
          panels: [{ id: "dash", command: "__automation-dashboard__" }],
          automation,
        },
        { id: "foreign", name: "Work automation", kind: "automation", profileId: "p2", panels: [], automation },
      ],
      settings: {},
    },
    automations: {
      paused: false,
      byWorkspaceId: {
        auto: {
          state: "idle",
          nextRunAt: "2026-11-18T07:00:00Z",
          lastRun: { state: "succeeded", startedAt: "2026-11-17T07:00:00Z" },
        },
      },
      recentRuns: [],
    },
    attention: { sessions: {}, alerts: [] },
    taskRunner: {},
  } as unknown as StatePayload;
}

async function mountPanel(pinned = false) {
  const app = useAppStore();
  app.payload = makePayload();
  const notifications = useNotificationStore();
  notifications.panelOpen = true;
  notifications.pinned = pinned;
  const api = { setAutomationsPaused: vi.fn().mockResolvedValue(undefined) };
  const wrapper = mount(NotificationCenter, { global: { provide: { [apiKey as symbol]: api } } });
  notifications.openPanelOnTab("automations");
  await flushPromises();
  return { wrapper, app, notifications, api };
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  vi.stubGlobal("strideterm", { startupFlags: { windowId: "slot1" } });
});
afterEach(() => vi.unstubAllGlobals());

describe("NotificationCenter — Automations tab", () => {
  it("shows the profile's automations, schedule and last result, independently of the sidebar filter", async () => {
    const { wrapper, app } = await mountPanel();
    app.workspaceSearchQuery = "does not match";
    await flushPromises();

    expect(wrapper.get(".notification-center__tab--active .notification-center__tab-label").text()).toBe("Automations");
    expect(wrapper.findAll(".automation-overview")).toHaveLength(1);
    expect(wrapper.get(".automation-overview").text()).toContain("Nightly check");
    expect(wrapper.get(".automation-overview").text()).toContain("Repository");
    expect(wrapper.get(".automation-overview").text()).toContain("Every 60 minutes");
    expect(wrapper.get(".automation-overview").text()).toContain("Next:");
    expect(wrapper.get(".automation-overview").text()).toContain("Last: Succeeded");
    expect(wrapper.text()).not.toContain("Work automation");

    const otherProfile = makePayload();
    otherProfile.appState.windowSlots[0]!.profileId = "p2";
    app.payload = otherProfile;
    await flushPromises();
    expect(wrapper.findAll(".automation-overview")).toHaveLength(1);
    expect(wrapper.get(".automation-overview").text()).toContain("Work automation");
    expect(wrapper.text()).not.toContain("Nightly check");
    wrapper.unmount();
  });

  it("updates global pause, live run and disabled states from broadcasts", async () => {
    const { wrapper, app } = await mountPanel();
    const paused = makePayload();
    paused.automations!.paused = true;
    app.payload = paused;
    await flushPromises();
    expect(wrapper.get(".automations-panel__pause").text()).toBe("Resume all");
    expect(wrapper.get(".automation-overview__state").text()).toBe("Paused");
    expect(wrapper.get(".automation-overview").text()).not.toContain("Next:");
    expect(wrapper.find('[aria-label="All automations are paused"]').exists()).toBe(true);

    app.payload = {
      ...paused,
      automations: { ...paused.automations!, byWorkspaceId: { auto: { currentRun: { state: "running" } } } },
    };
    await flushPromises();
    expect(wrapper.get(".automation-overview__state").text()).toBe("Running");

    const updated = makePayload();
    updated.appState.workspaces.find((item) => item.id === "auto")!.automation!.enabled = false;
    app.payload = updated;
    await flushPromises();
    expect(wrapper.get(".automation-overview__state").text()).toBe("Disabled");
    wrapper.unmount();
  });
  it("combines project search, trigger and failure filters and can clear an empty result", async () => {
    const { wrapper, app } = await mountPanel();
    const payload = makePayload();
    const event = structuredClone(payload.appState.workspaces.find((item) => item.id === "auto")!);
    event.id = "event-auto";
    event.name = "Review incoming PRs";
    event.automation!.trigger = { type: "event", source: "github", kinds: ["pr-new"] };
    payload.appState.workspaces.push(event);
    payload.automations!.byWorkspaceId[event.id] = {
      state: "idle",
      lastRun: { state: "failed", startedAt: "2026-11-17T07:00:00Z" },
    };
    app.payload = payload;
    await flushPromises();
    await wrapper.get('[aria-label="Search automations"]').setValue("repository");
    expect(wrapper.findAll(".automation-overview")).toHaveLength(2);
    await wrapper.get('[aria-label="Filter automations by trigger"]').setValue("event");
    await wrapper.get('[aria-label="Filter automations by state"]').setValue("failed");
    expect(wrapper.findAll(".automation-overview")).toHaveLength(1);
    expect(wrapper.get(".automation-overview").text()).toContain("Review incoming PRs");
    expect(wrapper.get(".automation-overview__types").text()).toContain("Event");
    await wrapper.get('[aria-label="Search automations"]').setValue("nightly");
    expect(wrapper.findAll(".automation-overview")).toHaveLength(0);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Clear filters")!
      .trigger("click");
    expect(wrapper.findAll(".automation-overview")).toHaveLength(2);
    wrapper.unmount();
  });

  it("pauses and resumes all profiles using the returned state", async () => {
    const { wrapper, app, api } = await mountPanel();
    const apply = vi.spyOn(app, "handleBroadcastPayload").mockImplementation((payload) => {
      app.payload = payload;
    });
    api.setAutomationsPaused.mockImplementation(async ({ paused }: { paused: boolean }) => ({
      ...makePayload(),
      automations: { ...makePayload().automations!, paused },
    }));
    await wrapper.get(".automations-panel__pause").trigger("click");
    await flushPromises();
    expect(api.setAutomationsPaused).toHaveBeenLastCalledWith({ paused: true });
    expect(apply).toHaveBeenCalled();
    expect(wrapper.get(".automations-panel__pause").attributes("aria-pressed")).toBe("true");

    await wrapper.get(".automations-panel__pause").trigger("click");
    await flushPromises();
    expect(api.setAutomationsPaused).toHaveBeenLastCalledWith({ paused: false });
    expect(wrapper.get(".automations-panel__pause").text()).toBe("Pause all");
    wrapper.unmount();
  });

  it("blocks repeated pause clicks while saving and reports a failure without changing state", async () => {
    const { wrapper, notifications, api } = await mountPanel();
    let reject!: (_error: Error) => void;
    api.setAutomationsPaused.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    await wrapper.get(".automations-panel__pause").trigger("click");
    await wrapper.get(".automations-panel__pause").trigger("click");
    expect(api.setAutomationsPaused).toHaveBeenCalledTimes(1);
    expect(wrapper.get(".automations-panel__pause").attributes("disabled")).toBeDefined();

    reject(new Error("Connection lost"));
    await flushPromises();
    expect(wrapper.get(".automations-panel__pause").attributes("disabled")).toBeUndefined();
    expect(wrapper.get(".automations-panel__pause").text()).toBe("Pause all");
    expect(notifications.sessions[0]?.events[0]?.title).toBe("Could not change automation pause");
    wrapper.unmount();
  });

  it.each([false, true])("opens the dashboard through grid-aware navigation (pinned: %s)", async (pinned) => {
    const { wrapper, app, notifications } = await mountPanel(pinned);
    const activate = vi.spyOn(app, "activateWorkspaceInGrid").mockResolvedValue(undefined);
    const view = vi.spyOn(app, "activateView").mockResolvedValue(undefined);
    await wrapper.get(".automation-overview").trigger("click");
    await flushPromises();
    expect(activate).toHaveBeenCalledWith("auto");
    expect(view).toHaveBeenCalledWith("automation-dashboard:dash");
    expect(notifications.panelOpen).toBe(pinned);
    wrapper.unmount();
  });

  it("keeps the overview open when dashboard navigation fails", async () => {
    const { wrapper, app, notifications } = await mountPanel();
    vi.spyOn(app, "activateWorkspaceInGrid").mockRejectedValue(new Error("Workspace unavailable"));
    await wrapper.get(".automation-overview").trigger("click");
    await flushPromises();
    expect(notifications.panelOpen).toBe(true);
    expect(notifications.sessions[0]?.events[0]?.title).toBe("Open workspace failed");
    wrapper.unmount();
  });

  it("shows an empty state when the profile has no automations", async () => {
    const { wrapper, app } = await mountPanel();
    const empty = makePayload();
    empty.appState.workspaces = [];
    app.payload = empty;
    await flushPromises();
    expect(wrapper.findAll(".automation-overview")).toHaveLength(0);
    expect(wrapper.get(".automations-panel").text()).toContain("No automations in this profile");
    wrapper.unmount();
  });
});

/**
 * PaneStage rendering for the relocated Companion Primary: the borrowed tab
 * must mount the SOURCE session (never its virtual view id), and a source
 * workspace left with nothing to show must say where its Primary went instead
 * of rendering a bare "no active terminal".
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import PaneStage from "./PaneStage.vue";
import { useAppStore } from "../../stores/app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const TerminalPaneStub = {
  props: ["sessionId"],
  template: '<div class="terminal-pane-stub" :data-session-id="sessionId"></div>',
};

function taskWorkspace(state: string): AnyApi {
  return {
    id: "ws-task",
    name: "Reviewer: Live conversation",
    kind: "task",
    profileId: "default",
    panels: [
      { id: "panel-dashboard", title: "Dashboard", command: "__task-dashboard__" },
      { id: "panel-judge", title: "Reviewer", command: "codex" },
    ],
    task: {
      mode: "attached",
      state,
      workerWorkspaceId: "ws-source",
      workerPanelId: "panel-primary",
      judgePanelId: "panel-judge",
      companionRole: "reviewer",
    },
  };
}

function makePayload(state: string, activeWorkspaceId: string, sourcePanels: AnyApi[]): AnyApi {
  const source = {
    id: "ws-source",
    name: "Live conversation",
    kind: "terminal",
    profileId: "default",
    panels: sourcePanels,
  };
  const workspaces = [source, taskWorkspace(state)];
  const active = workspaces.find((w) => w.id === activeWorkspaceId)!;
  return {
    appState: { activeWorkspaceId, workspaces, profiles: [], windowSlots: [], settings: {} },
    workspace: {
      workspace: active,
      sessions: (active.panels || [])
        .filter((p: AnyApi) => p.command !== "__task-dashboard__")
        .map((p: AnyApi) => ({
          sessionId: `${active.id}:${p.id}`,
          panelId: p.id,
          title: p.title,
          status: "idle",
          activity: "idle",
          lastExitCode: null,
        })),
    },
    attention: { sessions: {}, byWorkspace: {} },
    taskRunner: {},
  };
}

function mountStage() {
  return mount(PaneStage, { global: { stubs: { TerminalPane: TerminalPaneStub } } });
}

describe("PaneStage — relocated Companion Primary", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "" } };
  });

  it("mounts the borrowed Primary against the source session id", () => {
    const store = useAppStore();
    store.payload = makePayload("running", "ws-task", [{ id: "panel-primary", title: "Claude", command: "claude" }]);
    store.activeViewId = "attached-primary:ws-task";
    store.activeSessionId = "ws-source:panel-primary";

    const wrapper = mountStage();
    const pane = wrapper.find(".terminal-pane-stub");
    expect(pane.exists()).toBe(true);
    expect(pane.attributes("data-session-id")).toBe("ws-source:panel-primary");
    // The pane is still located under the virtual view id.
    expect(wrapper.find("[data-view-id='attached-primary:ws-task']").exists()).toBe(true);
  });

  it("tells the source workspace where its Primary went", () => {
    const store = useAppStore();
    // Only panel is the relocated Primary → nothing left to draw here.
    store.payload = makePayload("running", "ws-source", [{ id: "panel-primary", title: "Claude", command: "claude" }]);
    store.activeViewId = null;

    const wrapper = mountStage();
    expect(wrapper.text()).toContain("Primary is currently shown in Reviewer: Live conversation");
    expect(wrapper.find("button").text()).toBe("Open companion task");
  });

  it("falls back to the ordinary empty state when nothing is relocated", () => {
    const store = useAppStore();
    store.payload = makePayload("completed", "ws-source", []);
    store.activeViewId = null;

    const wrapper = mountStage();
    expect(wrapper.text()).toContain("No active terminal");
  });
});

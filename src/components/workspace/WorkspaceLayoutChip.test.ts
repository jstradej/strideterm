import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import WorkspaceLayoutChip from "./WorkspaceLayoutChip.vue";
import { useAppStore } from "../../stores/app.js";
import { isMobileViewport } from "../../composables/useIsNarrow.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const BASE_WORKSPACE = {
  id: "ws-A",
  name: "Alpha",
  cwd: "/a",
  panels: [{ id: "ws-A:shell", title: "Shell", command: "" }],
  icon: "A",
  color: "#fff",
  profileId: "default",
};

function makePayload(appStateOverrides: AnyApi = {}): StatePayload {
  return {
    workspace: {
      workspace: BASE_WORKSPACE,
      sessions: [],
    },
    appState: {
      workspaces: [BASE_WORKSPACE],
      activeWorkspaceId: "ws-A",
      activeProfileId: "default",
      profiles: [{ id: "default", name: "Default" }],
      workspaceGrid: null,
      ...appStateOverrides,
    },
  } as AnyApi;
}

describe("WorkspaceLayoutChip — only reflects workspace grid, not tab-split", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    isMobileViewport.value = false;
  });

  it("shows 'Solo' and hides Unsplit when no grid is active", () => {
    const store = useAppStore();
    store.payload = makePayload({ workspaceGrid: null });

    const wrapper = mount(WorkspaceLayoutChip);
    expect(wrapper.find(".workspace-layout-chip__label").text()).toBe("Solo");
    expect(wrapper.find(".workspace-layout-chip--active").exists()).toBe(false);
    expect(wrapper.find(".workspace-layout-chip--unsplit").exists()).toBe(false);
  });

  it("shows the grid layout label and Unsplit when a grid is visible", () => {
    const store = useAppStore();
    store.payload = makePayload({
      workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-A", null] },
      activeWorkspaceId: "ws-A",
    });

    const wrapper = mount(WorkspaceLayoutChip);
    expect(wrapper.find(".workspace-layout-chip__label").text()).toBe("Side by side");
    expect(wrapper.find(".workspace-layout-chip--active").exists()).toBe(true);
    expect(wrapper.find(".workspace-layout-chip--unsplit").exists()).toBe(true);
  });

  it("ignores tab-split state — stays 'Solo' when only the active workspace's tabs are split", () => {
    // Regression: previously the chip read store.splitGroup and would
    // mirror tab-split layouts (e.g. "Side by side") in its own label and
    // even let the user "Unsplit" a tab-split through this control. The
    // chip is for multi-workspace grids; tab-split lives on the terminal
    // toolbar below.
    const store = useAppStore();
    store.payload = makePayload({ workspaceGrid: null });
    store.splitGroup = { layout: "cols", viewIds: ["ws-A:shell", "ws-A:other"] };
    store.activeViewId = "ws-A:shell";

    const wrapper = mount(WorkspaceLayoutChip);
    expect(wrapper.find(".workspace-layout-chip__label").text()).toBe("Solo");
    expect(wrapper.find(".workspace-layout-chip--active").exists()).toBe(false);
    expect(wrapper.find(".workspace-layout-chip--unsplit").exists()).toBe(false);
  });

  it("hides on mobile viewport", () => {
    const store = useAppStore();
    store.payload = makePayload();
    isMobileViewport.value = true;

    const wrapper = mount(WorkspaceLayoutChip);
    expect(wrapper.find(".workspace-layout-chip-group").exists()).toBe(false);
  });
});

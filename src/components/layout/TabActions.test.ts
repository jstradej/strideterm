import { describe, expect, test, beforeEach } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TabActions from "./TabActions.vue";
import { useAppStore } from "../../stores/app.js";
import { isMobileViewport } from "../../composables/useIsNarrow.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("TabActions", () => {
  test("shows + Tab button for terminal workspaces", () => {
    const wrapper = mount(TabActions);
    expect(wrapper.text()).toContain("+ Tab");
  });

  test("shortens + Tab to + on a mobile viewport and keeps the accessible name", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    })) as unknown as typeof window.matchMedia;
    try {
      const wrapper = mount(TabActions);
      await nextTick();
      const button = wrapper.get("button.button--ghost");
      expect(button.text()).toBe("+");
      expect(button.attributes("aria-label")).toBe("Add tab");
    } finally {
      window.matchMedia = original;
      isMobileViewport.value = false;
    }
  });

  test("hides + Tab button for azure workspaces", () => {
    const store = useAppStore();
    store.payload = {
      workspace: { workspace: { id: "az1", kind: "azure", panels: [] } },
      appState: { workspaces: [] },
    } as unknown as StatePayload;
    const wrapper = mount(TabActions);
    expect(wrapper.find('[class*="button"]').text()).not.toContain("+ Tab");
  });

  test("offers + Board for Jira and emits its board chooser action", async () => {
    const store = useAppStore();
    store.payload = {
      workspace: { workspace: { id: "jira-1", kind: "jira", panels: [] }, sessions: [] },
      appState: { workspaces: [{ id: "jira-1", kind: "jira", panels: [] }] },
    } as unknown as StatePayload;
    const wrapper = mount(TabActions);

    expect(wrapper.text()).toContain("+ Board");
    expect(wrapper.text()).not.toContain("+ Tab");
    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("open-jira-board-chooser")).toHaveLength(1);
    expect(store.jiraBoardChooserRequest).toMatchObject({ workspaceId: "jira-1", sequence: 1 });
  });

  test("does not offer terminal tabs from a pinned Jira board workspace", () => {
    const store = useAppStore();
    store.payload = {
      workspace: { workspace: { id: "jira-board-1", kind: "jira-board", panels: [] }, sessions: [] },
      appState: { workspaces: [{ id: "jira-board-1", kind: "jira-board", panels: [] }] },
    } as unknown as StatePayload;
    const wrapper = mount(TabActions);
    expect(wrapper.text()).not.toContain("+ Tab");
    expect(wrapper.text()).not.toContain("+ Board");
  });

  test("shows Unsplit button when split group exists", () => {
    const store = useAppStore();
    store.splitGroup = { layout: "cols", viewIds: ["a", "b"] };
    const wrapper = mount(TabActions);
    expect(wrapper.text()).toContain("Unsplit");
  });

  test("shows layout label in split button when active in split", () => {
    const store = useAppStore();
    store.splitGroup = { layout: "cols", viewIds: ["a", "b"] };
    store.activeViewId = "a";
    const wrapper = mount(TabActions);
    expect(wrapper.text()).toContain("Side by side");
  });
});

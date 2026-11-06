import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import App from "./App.vue";
import SidebarPanel from "./components/layout/SidebarPanel.vue";
import WorkspaceAttachments from "./components/workspace/WorkspaceAttachments.vue";
import WorkspaceStage from "./components/workspace/WorkspaceStage.vue";
import { useAppStore } from "./stores/app.js";
import { apiKey } from "./types/keys.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

/**
 * App.vue's half of the running-agent surface's activation chain: a row click
 * emits SidebarPanel's existing `activate`, and App.vue's handler on that emit
 * closes the mobile drawer so the freshly activated workspace isn't left
 * hidden underneath it. The row → emit → store half lives in
 * SidebarPanel.test.ts; together they cover the click end to end.
 */
describe("App — the sidebar activate chain closes the mobile drawer", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
    document.documentElement.classList.remove("native-keyboard-viewport");
    document.documentElement.style.removeProperty("--strideterm-keyboard-bottom");
  });

  /** Any `api.onX(cb)` subscription App.vue makes during setup is a no-op. */
  function stubApi(isRemote = false): AnyApi {
    const base: AnyApi = { isRemote };
    return new Proxy(base, {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target];
        return () => undefined;
      },
      has: () => true,
    });
  }

  function mountApp(isRemote = false, attachTo?: Element) {
    const store = useAppStore();
    store.payload = {
      appState: {
        workspaces: [
          { id: "ws-A", name: "Alpha", cwd: "/a", panels: [], icon: "A", color: "#fff", profileId: "default" },
        ],
        activeWorkspaceId: "ws-A",
        activeProfileId: "default",
        profiles: [{ id: "default", name: "Default" }],
        workspaceGrid: null,
        windowSlots: [{ id: "win-test", profileId: "default", activeWorkspaceId: "ws-A" }],
        settings: {},
      },
    } as AnyApi;
    return mount(App, {
      attachTo,
      shallow: true,
      global: { provide: { [apiKey as unknown as symbol]: stubApi(isRemote) } },
    });
  }

  it("an activate emit from the sidebar leaves the drawer closed", async () => {
    const wrapper = mountApp();

    // Open the drawer the way a mobile user does.
    await wrapper.get("button.mobile-hamburger").trigger("click");
    expect(wrapper.get("aside.sidebar").classes()).toContain("sidebar--open");

    wrapper.findComponent(SidebarPanel).vm.$emit("activate", "ws-A");
    await wrapper.vm.$nextTick();

    expect(wrapper.get("aside.sidebar").classes()).not.toContain("sidebar--open");
  });

  it("SidebarPanel is mounted with App's handler bound to its activate emit", () => {
    const wrapper = mountApp();
    const sidebar = wrapper.findComponent(SidebarPanel);
    expect(sidebar.exists()).toBe(true);
    expect(typeof (sidebar.vm.$attrs as AnyApi).onActivate).toBe("function");
  });

  it("keeps the terminal stage in the workspace main layout", () => {
    const wrapper = mountApp();

    expect(wrapper.findComponent(WorkspaceStage).exists()).toBe(true);
    expect(wrapper.findComponent(WorkspaceAttachments).exists()).toBe(false);
  });

  it("shows the current Jira view and keyboard-opens saved tab actions", async () => {
    const wrapper = mountApp(true, document.body);
    const store = useAppStore();
    store.payload = {
      workspace: {
        workspace: { id: "jira-A", kind: "jira", profileId: "default", panels: [] },
        sessions: [],
      },
      appState: {
        workspaces: [{ id: "jira-A", kind: "jira", profileId: "default", panels: [] }],
        activeWorkspaceId: "jira-A",
        activeProfileId: "default",
        profiles: [{ id: "default", name: "Default" }],
      },
      jiraWorkspaceViews: {
        "jira-A": {
          workspaceId: "jira-A",
          profileId: "default",
          views: [
            { viewId: "issues", kind: "issues", title: "Issues" },
            {
              viewId: "platform-board",
              kind: "board",
              connectionId: "jira-c1",
              boardId: 7,
              boardName: "Platform",
              title: "Platform team board",
              mode: "issues",
              sprintId: null,
              quickFilterIds: [],
              assignee: null,
              doneWithinDays: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          activeViewId: "platform-board",
          syncByViewId: {
            issues: { state: "syncing" },
            "platform-board": { state: "syncing" },
          },
        },
      },
    } as AnyApi;
    store.activeViewId = "jira:jira-A:view:platform-board";
    await wrapper.vm.$nextTick();

    expect(wrapper.get(".mobile-tab-picker__trigger").text()).toContain("Platform team board");
    expect(wrapper.find(".mobile-tab-picker__trigger .tab__spinner").exists()).toBe(true);
    await wrapper.get(".mobile-tab-picker__trigger").trigger("click");
    expect(wrapper.findAll(".mobile-tab-picker__item .tab__spinner")).toHaveLength(2);
    expect(wrapper.find('button.mobile-tab-picker__item[aria-label="Inbox, syncing"]').exists()).toBe(true);
    const actions = wrapper.get('button[aria-label="Actions for Platform team board"]');
    (actions.element as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(actions.element);
    await actions.trigger("keydown.enter");
    expect(store.contextMenu?.viewId).toBe("jira:jira-A:view:platform-board");
    wrapper.unmount();
  });

  it("toggles the remote keyboard and tracks native IME inset changes in its label", async () => {
    const wrapper = mountApp(true);
    const keyboardEvents: boolean[] = [];
    const onToggle = (event: Event) => keyboardEvents.push((event as CustomEvent<{ show: boolean }>).detail.show);
    window.addEventListener("strideterm:toggle-system-keyboard", onToggle);
    try {
      const button = wrapper.get(".mobile-keyboard-btn");
      expect(button.attributes("aria-label")).toBe("Show keyboard");
      await button.trigger("click");
      expect(keyboardEvents).toEqual([true]);

      document.documentElement.classList.add("native-keyboard-viewport");
      document.documentElement.style.setProperty("--strideterm-keyboard-bottom", "280px");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await wrapper.vm.$nextTick();
      expect(button.attributes("aria-label")).toBe("Hide keyboard");
      expect(button.attributes("title")).toContain("Hide the on-screen keyboard");

      await button.trigger("click");
      expect(keyboardEvents).toEqual([true, false]);
      document.documentElement.style.setProperty("--strideterm-keyboard-bottom", "0px");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await wrapper.vm.$nextTick();
      expect(button.attributes("aria-label")).toBe("Show keyboard");
    } finally {
      window.removeEventListener("strideterm:toggle-system-keyboard", onToggle);
      wrapper.unmount();
    }
  });

  it("keeps the remote keyboard toggle state when the toolbar button receives focus", async () => {
    const wrapper = mountApp(true, document.body);
    const keyboardEvents: boolean[] = [];
    const onToggle = (event: Event) => keyboardEvents.push((event as CustomEvent<{ show: boolean }>).detail.show);
    window.addEventListener("strideterm:toggle-system-keyboard", onToggle);
    const focusedComposer = document.createElement("input");
    focusedComposer.className = "mobile-input-bar__input";
    document.body.append(focusedComposer);
    try {
      const button = wrapper.get<HTMLButtonElement>(".mobile-keyboard-btn");
      focusedComposer.focus();
      button.element.focus();
      await wrapper.vm.$nextTick();
      expect(button.attributes("aria-label")).toBe("Hide keyboard");

      await button.trigger("click");
      expect(keyboardEvents).toEqual([false]);
      expect(button.attributes("aria-label")).toBe("Show keyboard");
    } finally {
      focusedComposer.remove();
      window.removeEventListener("strideterm:toggle-system-keyboard", onToggle);
      wrapper.unmount();
    }
  });
});

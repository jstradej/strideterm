import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import App from "./App.vue";
import SidebarPanel from "./components/layout/SidebarPanel.vue";
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
  });

  /** Any `api.onX(cb)` subscription App.vue makes during setup is a no-op. */
  function stubApi(): AnyApi {
    const base: AnyApi = { isRemote: false };
    return new Proxy(base, {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target];
        return () => undefined;
      },
      has: () => true,
    });
  }

  function mountApp() {
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
      shallow: true,
      global: { provide: { [apiKey as unknown as symbol]: stubApi() } },
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
});

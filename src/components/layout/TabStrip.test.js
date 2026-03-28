import { describe, expect, test, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TabStrip from "./TabStrip.vue";
import { useAppStore } from "../../stores/app.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

function makePayload(sessions) {
  return {
    workspace: {
      workspace: {
        id: "ws1",
        kind: "terminal",
        panels: sessions.map((s) => ({ id: s.panelId || s.id, title: s.title, command: "" })),
      },
      sessions: sessions.map((s) => ({
        sessionId: s.id,
        panelId: s.panelId || s.id,
        title: s.title,
        status: s.status || "idle",
        tone: s.tone || "ok",
        persistent: s.persistent || false,
        closable: s.closable !== false,
      })),
    },
    appState: {
      workspaces: [{ id: "ws1", kind: "terminal", panels: [], profileId: "default", activeProfileId: "default" }],
      activeProfileId: "default",
    },
  };
}

describe("TabStrip", () => {
  test("renders tab buttons with title and status", () => {
    const store = useAppStore();
    store.payload = makePayload([{ id: "ws1:shell", title: "Shell", status: "running" }]);
    const wrapper = mount(TabStrip);
    const tab = wrapper.find(".tab");
    expect(tab.exists()).toBe(true);
    expect(tab.find("span").text()).toBe("Shell");
    expect(tab.find("small").text()).toBe("running");
  });

  test("renders stable rename (✎) and close (×) icons without mojibake", () => {
    const store = useAppStore();
    store.payload = makePayload([{ id: "ws1:shell", title: "Shell", status: "", persistent: true, closable: true }]);
    const wrapper = mount(TabStrip);
    expect(wrapper.find(".tab__rename").text()).toBe("✎");
    expect(wrapper.find(".tab__close").text()).toBe("×");
  });

  test("marks active tab with tab--active class", () => {
    const store = useAppStore();
    store.payload = makePayload([
      { id: "ws1:shell", title: "Shell" },
      { id: "ws1:log", title: "Log" },
    ]);
    store.activeViewId = "ws1:shell";
    const wrapper = mount(TabStrip);
    const tabs = wrapper.findAll(".tab");
    expect(tabs[0].classes()).toContain("tab--active");
    expect(tabs[1].classes()).not.toContain("tab--active");
  });

  test("shows attention bell for tabs with tabAttention", () => {
    const store = useAppStore();
    const now = new Date().toISOString();
    store.payload = makePayload([{ id: "ws1:shell", title: "Shell" }]);
    // Override getTabAttentionForView to return attention for ws1:shell
    store.getTabAttentionForView = () => ({ count: 1, alerts: [{ title: "Build" }], latestAt: now });
    const wrapper = mount(TabStrip);
    expect(wrapper.find(".tab__attention").exists()).toBe(true);
  });
});

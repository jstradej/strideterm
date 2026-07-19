import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TabStrip from "./TabStrip.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { isMobileViewport } from "../../composables/useIsNarrow.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.removeItem("strideterm-notifications-v2");
  isMobileViewport.value = false;
});

interface SessionInput {
  id: string;
  panelId?: string;
  title: string;
  status?: string;
  tone?: string;
  activity?: string;
  lastExitCode?: number | null;
  lastCommandFinishedAt?: number;
  persistent?: boolean;
  closable?: boolean;
}

function makePayload(sessions: SessionInput[]): StatePayload {
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
        activity: s.activity || "idle",
        lastExitCode: s.lastExitCode ?? null,
        lastCommandFinishedAt: s.lastCommandFinishedAt || 0,
        persistent: s.persistent || false,
        closable: s.closable !== false,
      })),
    },
    appState: {
      workspaces: [{ id: "ws1", kind: "terminal", panels: [], profileId: "default", activeProfileId: "default" }],
      activeProfileId: "default",
    },
  } as unknown as StatePayload;
}

describe("TabStrip", () => {
  test("renders tab title and leaves status chip empty while session is idle", () => {
    const store = useAppStore();
    store.payload = makePayload([{ id: "ws1:shell", title: "Shell", status: "running" }]);
    const wrapper = mount(TabStrip);
    const tab = wrapper.find(".tab");
    expect(tab.exists()).toBe(true);
    expect(tab.find("span").text()).toBe("Shell");
    // A live PTY with no active command shows no chip text — the old always-on
    // "running" label was misleading. CSS preserves vertical space via ::before.
    expect(tab.find("small").text()).toBe("");
  });

  test("shows 'running' chip while a command is active", () => {
    const store = useAppStore();
    store.payload = makePayload([{ id: "ws1:shell", title: "Shell", activity: "running" }]);
    const wrapper = mount(TabStrip);
    expect(wrapper.find(".tab small").text()).toBe("running");
    expect(wrapper.find(".tab").classes()).toContain("tab--running");
  });

  test("shows '✓ done' chip after successful command finish", () => {
    const store = useAppStore();
    store.payload = makePayload([{ id: "ws1:shell", title: "Shell", activity: "done", lastExitCode: 0 }]);
    const wrapper = mount(TabStrip);
    expect(wrapper.find(".tab small").text()).toBe("✓ done");
    expect(wrapper.find(".tab").classes()).toContain("tab--running");
  });

  test("shows '✗ exit N' chip after non-zero exit", () => {
    const store = useAppStore();
    store.payload = makePayload([{ id: "ws1:shell", title: "Shell", activity: "done", lastExitCode: 2 }]);
    const wrapper = mount(TabStrip);
    expect(wrapper.find(".tab small").text()).toBe("✗ exit 2");
    expect(wrapper.find(".tab").classes()).toContain("tab--error");
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

  test("does not underline split siblings when the split is collapsed to one visible pane", () => {
    const store = useAppStore();
    store.payload = makePayload([
      { id: "ws1:shell", title: "Shell" },
      { id: "ws1:claude", title: "Claude Code" },
    ]);
    store.activeViewId = "ws1:shell";
    store.splitGroup = { layout: "cols", viewIds: ["ws1:shell", "ws1:claude"] };
    isMobileViewport.value = true;

    const wrapper = mount(TabStrip);
    const tabs = wrapper.findAll(".tab");

    expect(tabs[0].classes()).toContain("tab--active");
    expect(tabs[0].classes()).not.toContain("tab--grouped");
    expect(tabs[1].classes()).not.toContain("tab--active");
    expect(tabs[1].classes()).not.toContain("tab--grouped");
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

  test("clicking a tab that fails to activate surfaces an error toast instead of an unhandled rejection", async () => {
    const store = useAppStore();
    store.payload = makePayload([{ id: "ws1:shell", title: "Shell" }]);
    vi.spyOn(store, "activateView").mockRejectedValueOnce(new Error("session gone"));

    const wrapper = mount(TabStrip);
    await wrapper.find(".tab").trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Switch tab failed");
    expect(notifications.sessions[0].events[0].body).toBe("session gone");
  });
});

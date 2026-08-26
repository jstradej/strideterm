import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ProfileBar from "./ProfileBar.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makePayload(mode: "tree" | "recent" = "tree"): StatePayload {
  return {
    appState: {
      workspaces: [],
      activeWorkspaceId: "",
      profiles: [{ id: "default", name: "Default", color: "#ffa424", sidebarWorkspaceViewMode: mode }],
      windowSlots: [{ id: "win-test", profileId: "default", activeWorkspaceId: "" }],
    },
  } as AnyApi;
}

describe("ProfileBar — sidebar view toggle", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  it("shows the tree state by default: no accent class, tooltip offers switching to recent", () => {
    const store = useAppStore();
    store.payload = makePayload("tree");
    const wrapper = mount(ProfileBar);

    const button = wrapper.get(".profile-bar__view-toggle");
    expect(button.classes()).not.toContain("profile-bar__view-toggle--active");
    expect(button.attributes("title")).toContain("Click to switch to a view grouped by when you last opened");
    expect(button.attributes("aria-label")).toContain("recently opened view");
  });

  it("shows the active accent state and swapped copy when the profile's mode is recent", () => {
    const store = useAppStore();
    store.payload = makePayload("recent");
    const wrapper = mount(ProfileBar);

    const button = wrapper.get(".profile-bar__view-toggle");
    expect(button.classes()).toContain("profile-bar__view-toggle--active");
    expect(button.attributes("title")).toContain("Click to switch back to the manually ordered tree");
    expect(button.attributes("aria-label")).toContain("manually ordered workspace tree");
  });

  it("clicking calls store.saveSidebarWorkspaceViewMode with the opposite mode", async () => {
    const store = useAppStore();
    store.payload = makePayload("tree");
    const save = vi.spyOn(store, "saveSidebarWorkspaceViewMode").mockResolvedValue(undefined);
    const wrapper = mount(ProfileBar);

    await wrapper.get(".profile-bar__view-toggle").trigger("click");
    await flushPromises();

    expect(save).toHaveBeenCalledWith("recent");
  });

  it("clicking again from recent switches back to tree", async () => {
    const store = useAppStore();
    store.payload = makePayload("recent");
    const save = vi.spyOn(store, "saveSidebarWorkspaceViewMode").mockResolvedValue(undefined);
    const wrapper = mount(ProfileBar);

    await wrapper.get(".profile-bar__view-toggle").trigger("click");
    await flushPromises();

    expect(save).toHaveBeenCalledWith("tree");
  });

  it("surfaces an error toast when the save fails", async () => {
    const store = useAppStore();
    store.payload = makePayload("tree");
    vi.spyOn(store, "saveSidebarWorkspaceViewMode").mockRejectedValueOnce(new Error("profile save failed"));
    const wrapper = mount(ProfileBar);

    await wrapper.get(".profile-bar__view-toggle").trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Switch workspace view failed");
    expect(notifications.sessions[0].events[0].body).toBe("profile save failed");
  });
});

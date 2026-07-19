import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DockerHeader from "./DockerHeader.vue";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";

describe("DockerHeader — refresh failure surfaces a toast instead of an unhandled rejection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
  });

  it("shows an error toast and resets the busy state when refreshDocker rejects", async () => {
    const store = useAppStore();
    vi.spyOn(store, "refreshDocker").mockRejectedValueOnce(new Error("docker daemon unreachable"));

    const wrapper = mount(DockerHeader, { props: { summary: "" } });
    const refreshBtn = wrapper.find("button");
    await refreshBtn.trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Refresh Docker failed");
    expect(notifications.sessions[0].events[0].body).toBe("docker daemon unreachable");

    // Busy state must reset after the failure.
    expect(wrapper.find("button").classes()).not.toContain("button--busy");
    expect(wrapper.find("button").attributes("disabled")).toBeUndefined();
  });

  it("resolves normally and resets busy state on success", async () => {
    const store = useAppStore();
    vi.spyOn(store, "refreshDocker").mockResolvedValueOnce(undefined);

    const wrapper = mount(DockerHeader, { props: { summary: "" } });
    const refreshBtn = wrapper.find("button");
    await refreshBtn.trigger("click");
    await flushPromises();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(0);
    expect(wrapper.find("button").classes()).not.toContain("button--busy");
  });
});

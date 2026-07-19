/**
 * Regression coverage: RemoteAccessDialog's browseCloudflared used to call
 * api.browseFile directly inside a click handler with no try/catch. A
 * rejected picker promise was an unhandled rejection with no user feedback.
 * It now goes through pickPath(), which surfaces an error toast.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import RemoteAccessDialog from "./RemoteAccessDialog.vue";
import { useNotificationStore } from "../../stores/notifications.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("RemoteAccessDialog — browseCloudflared", () => {
  test("a rejecting browseFile shows an error notification instead of throwing", async () => {
    const browseFile = vi.fn().mockRejectedValueOnce(new Error("picker crashed"));
    const wrapper = mount(RemoteAccessDialog, {
      global: { provide: { api: { browseFile } } },
    });

    const browseBtn = wrapper.findAll("button").find((b) => b.text() === "Browse")!;
    await browseBtn.trigger("click");
    await flushPromises();

    expect(browseFile).toHaveBeenCalled();
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Failed to open picker");
  });
});

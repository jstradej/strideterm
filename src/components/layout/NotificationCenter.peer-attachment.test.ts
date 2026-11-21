import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import NotificationCenter from "./NotificationCenter.vue";
import { useNotificationStore } from "../../stores/notifications.js";
import { useAppStore } from "../../stores/app.js";
import { apiKey } from "../../types/keys.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
});

describe("NotificationCenter — a copied host attachment", () => {
  it("offers Copy path and puts the absolute local path on the clipboard", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = {
      meta: { appVersion: "0.0.0", platform: "test", repositoryUrl: "", versionCheck: {}, recoveryCandidates: [] },
      appState: {
        activeWorkspaceId: "ws-a",
        profiles: [{ id: "p1", name: "Profile", color: "#fff", workspaceIds: ["ws-a"] }],
        workspaces: [{ id: "ws-a", name: "WsA", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp/a" }],
        windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-a", activeSessionId: "" }],
        settings: {},
        tabTemplates: [],
      },
      attention: { sessions: {}, alerts: [] },
    } as AnyApi;
    notifStore.pinned = true;
    notifStore.addAlertEvent({
      title: "Copied photo.png from macmini.local",
      body: "/tmp/a/.strideterm/attachments/x/photo.png",
      kind: "completed",
      tier: 2,
      urgency: "normal",
      workspaceId: "ws-a",
      workspaceName: "",
      category: "peer-attachment",
      meta: { profileId: "p1", copyId: "c-1", path: "/tmp/a/.strideterm/attachments/x/photo.png" },
      sourceAlertId: "peer-attachment:c-1",
      occurredAt: new Date().toISOString(),
    } as AnyApi);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const wrapper = mount(NotificationCenter, {
      global: { provide: { [apiKey as unknown as symbol]: { isRemote: false } } },
    });
    await flushPromises();
    await wrapper.get('[data-testid="peer-attachment-copy-path"]').trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("/tmp/a/.strideterm/attachments/x/photo.png");
    expect(wrapper.get('[data-testid="peer-attachment-copy-path"]').text()).toBe("Copied");
  });

  it("shows an error toast, and does not claim Copied, when the clipboard refuses", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = {
      meta: { appVersion: "0.0.0", platform: "test", repositoryUrl: "", versionCheck: {}, recoveryCandidates: [] },
      appState: {
        activeWorkspaceId: "ws-a",
        profiles: [{ id: "p1", name: "Profile", color: "#fff", workspaceIds: ["ws-a"] }],
        workspaces: [{ id: "ws-a", name: "WsA", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp/a" }],
        windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-a", activeSessionId: "" }],
        settings: {},
        tabTemplates: [],
      },
      attention: { sessions: {}, alerts: [] },
    } as AnyApi;
    notifStore.pinned = true;
    notifStore.addAlertEvent({
      title: "Copied photo.png from macmini.local",
      body: "/tmp/a/.strideterm/attachments/x/photo.png",
      kind: "completed",
      tier: 2,
      urgency: "normal",
      workspaceId: "ws-a",
      workspaceName: "",
      category: "peer-attachment",
      meta: { profileId: "p1", copyId: "c-1", path: "/tmp/a/.strideterm/attachments/x/photo.png" },
      sourceAlertId: "peer-attachment:c-1",
      threadKey: "c-1",
      occurredAt: new Date().toISOString(),
    } as AnyApi);
    const showError = vi.spyOn(notifStore, "showError");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("Clipboard permission denied")) },
    });
    const wrapper = mount(NotificationCenter, {
      global: { provide: { [apiKey as unknown as symbol]: { isRemote: false } } },
    });
    await flushPromises();
    await wrapper.get('[data-testid="peer-attachment-copy-path"]').trigger("click");
    await flushPromises();
    expect(showError).toHaveBeenCalledWith("Could not copy the path", expect.any(Error));
    expect(wrapper.get('[data-testid="peer-attachment-copy-path"]').text()).toBe("Copy path");
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import NotificationCenter from "./NotificationCenter.vue";
import { useNotificationStore } from "../../stores/notifications.js";
import { useAppStore } from "../../stores/app.js";
import { apiKey } from "../../types/keys.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function mountDock(api: AnyApi, entry: { kind: "error" | "completed"; workspaceId: string }) {
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
    title: "Task agents could not be started",
    body: "boom",
    kind: entry.kind,
    tier: 2,
    urgency: "urgent",
    workspaceId: entry.workspaceId,
    workspaceName: "strIDEterm",
    category: "operation",
    meta: { profileId: "p1", operationId: "op-1" },
    sourceAlertId: "operation:op-1",
  } as AnyApi);
  const wrapper = mount(NotificationCenter, { global: { provide: { [apiKey as unknown as symbol]: api } } });
  return { wrapper, notifStore };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
});

describe("NotificationCenter — discarding a failed operation", () => {
  it("offers Discard on a failed operation without a workspace and calls the transport", async () => {
    const discardOperation = vi.fn().mockResolvedValue(true);
    const { wrapper, notifStore } = mountDock(
      { isRemote: false, discardOperation },
      { kind: "error", workspaceId: "" },
    );
    await flushPromises();
    await wrapper.get('[data-testid="discard-operation"]').trigger("click");
    await flushPromises();
    expect(discardOperation).toHaveBeenCalledWith("op-1");
    expect(notifStore.sessions.some((s) => s.meta?.operationId === "op-1")).toBe(false);
  });

  it("keeps the entry and shows an error when the discard is refused", async () => {
    const discardOperation = vi.fn().mockRejectedValue(new Error("Cross-profile refused"));
    const { wrapper, notifStore } = mountDock(
      { isRemote: false, discardOperation },
      { kind: "error", workspaceId: "" },
    );
    await flushPromises();
    await wrapper.get('[data-testid="discard-operation"]').trigger("click");
    await flushPromises();
    expect(notifStore.sessions.some((s) => s.meta?.operationId === "op-1")).toBe(true);
  });

  it("is not offered without a discard transport method (remote client)", async () => {
    const { wrapper } = mountDock({ isRemote: true }, { kind: "error", workspaceId: "" });
    await flushPromises();
    expect(wrapper.find('[data-testid="discard-operation"]').exists()).toBe(false);
  });

  it("is not offered for a successful operation", async () => {
    const { wrapper } = mountDock(
      { isRemote: false, discardOperation: vi.fn() },
      { kind: "completed", workspaceId: "" },
    );
    await flushPromises();
    expect(wrapper.find('[data-testid="discard-operation"]').exists()).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useNotificationCapture } from "./useNotificationCapture.js";

vi.mock("./useNotificationSound.js", () => ({
  fireNotificationAlert: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const WORKSPACES = [
  { id: "ws-a", name: "Alpha", profileId: "profile-a", panels: [] },
  { id: "ws-b", name: "Beta", profileId: "profile-b", panels: [] },
];

const PROFILES = [
  { id: "profile-a", name: "A", color: "#fff", workspaceIds: ["ws-a"] },
  { id: "profile-b", name: "B", color: "#fff", workspaceIds: ["ws-b"] },
];

function makePayload(byWorkspace: Record<string, AnyApi>): AnyApi {
  return {
    appState: {
      workspaces: WORKSPACES,
      profiles: PROFILES,
      activeWorkspaceId: "ws-a",
      windowSlots: [{ id: "win-1", profileId: "profile-a", activeWorkspaceId: "ws-a", activeSessionId: "" }],
    },
    attention: { byWorkspace },
  };
}

describe("useNotificationCapture — per-window profile scoping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    window.localStorage.removeItem("strideterm-notifications-pinned");
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-1" } };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and toasts an alert from this window's profile", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload({});
    useNotificationCapture();
    // Skip past the startup grace period (15s) so alerts actually fire.
    vi.advanceTimersByTime(16_000);

    appStore.payload = makePayload({
      "ws-a": { alerts: [{ panelId: "shell", sessionId: "ws-a:shell", kind: "waiting", tier: 1 }] },
    });
    await nextTick();

    expect(notifStore.sessions).toHaveLength(1);
    expect(notifStore.sessions[0].workspaceId).toBe("ws-a");
    expect(notifStore.sessions[0].meta?.profileId).toBe("profile-a");
    // Toast fires in this window — arrival is per-window, never deduped globally.
    expect(notifStore.latestToast).not.toBeNull();
  });

  it("does NOT store an alert from another profile as this window's notification", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload({});
    useNotificationCapture();
    vi.advanceTimersByTime(16_000);

    // Alert belongs to ws-b (profile-b) while this window shows profile-a.
    appStore.payload = makePayload({
      "ws-b": { alerts: [{ panelId: "shell", sessionId: "ws-b:shell", kind: "waiting", tier: 1 }] },
    });
    await nextTick();

    expect(notifStore.sessions).toHaveLength(0);
    expect(notifStore.latestToast).toBeNull();
  });

  it("two windows of the same profile each capture the same alert (toast in both)", async () => {
    // Window 1 (profile-a)
    const piniaA = createPinia();
    setActivePinia(piniaA);
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-1" } };
    const appA = useAppStore();
    const notifA = useNotificationStore();
    appA.payload = makePayload({});
    useNotificationCapture();

    // Window 2 (same profile, different slot)
    const piniaB = createPinia();
    setActivePinia(piniaB);
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-2" } };
    const appB = useAppStore();
    const notifB = useNotificationStore();
    const payloadB = makePayload({});
    payloadB.appState.windowSlots = [
      { id: "win-1", profileId: "profile-a", activeWorkspaceId: "ws-a", activeSessionId: "" },
      { id: "win-2", profileId: "profile-a", activeWorkspaceId: "ws-a", activeSessionId: "" },
    ];
    appB.payload = payloadB;
    useNotificationCapture();

    vi.advanceTimersByTime(16_000);

    const alert = { "ws-a": { alerts: [{ panelId: "shell", sessionId: "ws-a:shell", kind: "waiting", tier: 1 }] } };
    appA.payload = makePayload(alert);
    const nextB = makePayload(alert);
    nextB.appState.windowSlots = payloadB.appState.windowSlots;
    appB.payload = nextB;
    await nextTick();

    expect(notifA.sessions).toHaveLength(1);
    expect(notifB.sessions).toHaveLength(1);
    expect(notifA.latestToast).not.toBeNull();
    expect(notifB.latestToast).not.toBeNull();
  });
});

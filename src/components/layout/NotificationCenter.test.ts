/**
 * Component test for NotificationCenter — verifies that the profile label
 * element renders when a notification session has a known meta.profileId.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import NotificationCenter from "./NotificationCenter.vue";
import { useNotificationStore } from "../../stores/notifications.js";
import { useAppStore } from "../../stores/app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makePayload(overrides: AnyApi = {}): AnyApi {
  return {
    meta: {
      appVersion: "0.0.0",
      platform: "test",
      repositoryUrl: "",
      versionCheck: {},
      recoveryCandidates: [],
    },
    appState: {
      activeWorkspaceId: "ws-a",
      profiles: [{ id: "p1", name: "Profile Alpha", color: "#fff", workspaceIds: ["ws-a"] }],
      workspaces: [
        {
          id: "ws-a",
          name: "WsA",
          profileId: "p1",
          panels: [{ id: "sh", title: "Shell", command: "" }],
          kind: "terminal",
          cwd: "/tmp/a",
        },
      ],
      windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-a", activeSessionId: "" }],
      settings: {},
      tabTemplates: [],
      ssh: {
        hosts: [],
        keys: [],
        certificates: [],
        knownHosts: {},
        settings: { defaultAgentMode: "inherit", importedSshConfig: false },
      },
      ...overrides.appState,
    },
    workspace: null,
    attention: { sessions: {}, alerts: [] },
    docker: {
      available: false,
      backend: null,
      contexts: [],
      containers: [],
      lazydocker: { available: false, backend: null, error: "" },
      error: "",
      lastUpdatedAt: null,
    },
    git: { workspaces: {}, activeWorkspace: null, connections: [] },
    azureDevops: { inboxItems: [], connections: [], lastUpdatedAt: null, error: "" },
    github: { inboxItems: [], connections: [], lastUpdatedAt: null, error: "" },
    reviewBridge: { sessions: {}, enabled: false },
    plugins: [],
    environment: {},
    remoteAccess: { enabled: false, host: "", port: 0, tunnel: { active: false, url: null, error: null } },
    taskRunner: {},
    ...overrides,
  };
}

describe("NotificationCenter — sessionProfileLabel render", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
  });

  it("renders profile label span when session has a known meta.profileId", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();

    // Seed app store with a profile
    appStore.payload = makePayload() as AnyApi;

    // Open the panel so the aside renders
    notifStore.panelOpen = true;

    // Add a session stamped with the active profile id so it passes sessionInActiveProfile
    notifStore.add({
      title: "Task done",
      kind: "completed",
      workspaceId: "ws-a",
      viewId: "ws-a:sh",
      meta: { profileId: "p1" },
    });

    const wrapper = mount(NotificationCenter);
    await nextTick();
    await nextTick();

    const label = wrapper.find(".notification-item__profile-label");
    expect(label.exists()).toBe(true);
    expect(label.text()).toBe("Profile Alpha");
    expect(label.attributes("title")).toBe("Profile: Profile Alpha");
  });

  it("does not render profile label when meta.profileId is absent", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();

    appStore.payload = makePayload() as AnyApi;
    notifStore.panelOpen = true;

    // Session with no profileId — sessionProfileLabel returns ""
    notifStore.add({
      title: "Task done",
      kind: "completed",
      workspaceId: "ws-a",
      viewId: "ws-a:sh2",
    });

    const wrapper = mount(NotificationCenter);
    await nextTick();
    await nextTick();

    expect(wrapper.find(".notification-item__profile-label").exists()).toBe(false);
  });

  it("does not render profile label when profileId references a deleted/unknown profile", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();

    appStore.payload = makePayload() as AnyApi;
    notifStore.panelOpen = true;

    // Session has profileId that is not in appStore.payload.appState.profiles
    notifStore.add({
      title: "Old task",
      kind: "completed",
      workspaceId: "ws-a",
      viewId: "ws-a:sh3",
      meta: { profileId: "p1" }, // passes sessionInActiveProfile
    });

    // Mutate the payload to have an EMPTY profiles list (simulates deleted profile)
    appStore.payload = makePayload({ appState: { profiles: [] } }) as AnyApi;

    const wrapper = mount(NotificationCenter);
    await nextTick();
    await nextTick();

    // sessionProfileLabel returns "" when profile is not found
    expect(wrapper.find(".notification-item__profile-label").exists()).toBe(false);
  });

  it("does not clear or resolve a cross-profile notification when switch confirmation is cancelled", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();

    appStore.payload = makePayload({
      appState: {
        activeWorkspaceId: "ws-a",
        profiles: [
          { id: "p1", name: "Profile Alpha", color: "#fff", workspaceIds: ["ws-a"] },
          { id: "p2", name: "Profile Beta", color: "#fff", workspaceIds: ["ws-b"] },
        ],
        workspaces: [
          {
            id: "ws-a",
            name: "WsA",
            profileId: "p1",
            panels: [{ id: "sh", title: "Shell", command: "" }],
            kind: "terminal",
            cwd: "/tmp/a",
          },
          {
            id: "ws-b",
            name: "WsB",
            profileId: "p2",
            panels: [{ id: "sh", title: "Shell", command: "" }],
            kind: "terminal",
            cwd: "/tmp/b",
          },
        ],
        windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-a", activeSessionId: "" }],
      },
    }) as AnyApi;
    notifStore.panelOpen = true;

    notifStore.add({
      title: "Needs input",
      kind: "waiting",
      workspaceId: "ws-b",
      viewId: "ws-b:sh",
      // Deliberately stale profile stamp so the row is visible in p1 while
      // the target workspace resolves to p2. This exercises the cancel path
      // without changing NotificationCenter's active-profile list filter.
      meta: { profileId: "p1" },
    });

    (appStore as AnyApi).confirmInApp = vi.fn(() => Promise.resolve(false));
    (appStore as AnyApi).activateProfile = vi.fn(() => Promise.resolve());
    const clearSpy = vi.spyOn(notifStore, "clearOnBackend");

    const wrapper = mount(NotificationCenter);
    await nextTick();
    await nextTick();

    await wrapper.find(".quick-action").trigger("click");
    await nextTick();
    await Promise.resolve();

    expect((appStore as AnyApi).confirmInApp).toHaveBeenCalled();
    expect((appStore as AnyApi).activateProfile).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(notifStore.sessions[0].state).toBe("waiting");
  });

  it("jump: surfaces a toast and leaves the session unresolved when activateWorkspaceInGrid rejects", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();

    appStore.payload = makePayload({
      appState: {
        activeWorkspaceId: "ws-a",
        profiles: [{ id: "p1", name: "Profile Alpha", color: "#fff", workspaceIds: ["ws-a"] }],
        windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-a", activeSessionId: "" }],
        workspaces: [
          {
            id: "ws-a",
            name: "WsA",
            profileId: "p1",
            panels: [{ id: "sh", title: "Shell", command: "" }],
            kind: "terminal",
            cwd: "/tmp/a",
          },
          {
            id: "ws-b",
            name: "WsB",
            profileId: "p1",
            panels: [{ id: "sh", title: "Shell", command: "" }],
            kind: "terminal",
            cwd: "/tmp/b",
          },
        ],
      },
    }) as AnyApi;
    notifStore.panelOpen = true;

    notifStore.add({
      title: "Needs input",
      kind: "waiting",
      workspaceId: "ws-b",
      viewId: "ws-b:sh",
      meta: { profileId: "p1" },
    });

    (appStore as AnyApi).activateWorkspaceInGrid = vi.fn(() => Promise.reject(new Error("grid busy")));
    const clearSpy = vi.spyOn(notifStore, "clearOnBackend");

    const wrapper = mount(NotificationCenter);
    await nextTick();
    await nextTick();

    await wrapper.find(".quick-action").trigger("click"); // Jump is the first quick action
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();

    expect((appStore as AnyApi).activateWorkspaceInGrid).toHaveBeenCalledWith("ws-b");
    // A failed navigation must not be treated as "cleared" — session stays waiting.
    expect(clearSpy).not.toHaveBeenCalled();
    expect(notifStore.sessions[0].state).toBe("waiting");
    expect(notifStore.sessions.find((s) => s.category === "error")).toBeTruthy();
    const errorSession = notifStore.sessions.find((s) => s.category === "error")!;
    expect(errorSession.events[0].title).toBe("Open workspace failed");
    expect(errorSession.events[0].body).toBe("grid busy");
  });

  it("jump: surfaces a toast and leaves the session unresolved when activateView (open tab) rejects", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();

    appStore.payload = makePayload({
      appState: {
        activeWorkspaceId: "ws-a",
        profiles: [{ id: "p1", name: "Profile Alpha", color: "#fff", workspaceIds: ["ws-a"] }],
        windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-a", activeSessionId: "" }],
        workspaces: [
          {
            id: "ws-a",
            name: "WsA",
            profileId: "p1",
            panels: [{ id: "sh", title: "Shell", command: "" }],
            kind: "terminal",
            cwd: "/tmp/a",
          },
        ],
      },
    }) as AnyApi;
    notifStore.panelOpen = true;

    // Target the already-active workspace so the jump skips workspace activation
    // and goes straight to opening the tab (activateView).
    notifStore.add({
      title: "Needs input",
      kind: "waiting",
      workspaceId: "ws-a",
      viewId: "ws-a:sh",
      meta: { profileId: "p1" },
    });

    (appStore as AnyApi).activateView = vi.fn(() => Promise.reject(new Error("tab boom")));
    const clearSpy = vi.spyOn(notifStore, "clearOnBackend");

    const wrapper = mount(NotificationCenter);
    await nextTick();
    await nextTick();

    await wrapper.find(".quick-action").trigger("click"); // Jump is the first quick action
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();

    expect((appStore as AnyApi).activateView).toHaveBeenCalledWith("ws-a:sh");
    // A failed tab open must not be treated as "cleared" — session stays waiting.
    expect(clearSpy).not.toHaveBeenCalled();
    expect(notifStore.sessions[0].state).toBe("waiting");
    const errorSession = notifStore.sessions.find((s) => s.category === "error")!;
    expect(errorSession.events[0].title).toBe("Open tab failed");
    expect(errorSession.events[0].body).toBe("tab boom");
  });

  it("dismiss: surfaces a toast when clearOnBackend rejects but still resolves the session (best-effort)", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();

    appStore.payload = makePayload() as AnyApi;
    notifStore.panelOpen = true;

    notifStore.add({
      title: "Needs input",
      kind: "waiting",
      workspaceId: "ws-a",
      viewId: "ws-a:sh",
      meta: { profileId: "p1" },
    });

    vi.spyOn(notifStore, "clearOnBackend").mockRejectedValueOnce(new Error("backend unreachable"));

    const wrapper = mount(NotificationCenter);
    await nextTick();
    await nextTick();

    const dismissBtn = wrapper.findAll(".quick-action")[1];
    expect(dismissBtn.text()).toBe("Dismiss");
    await dismissBtn.trigger("click");
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();

    // Best-effort: the session still resolves locally even though the
    // backend call failed, but the user is told about the failure.
    const resolvedSession = notifStore.sessions.find((s) => s.viewId === "ws-a:sh");
    expect(resolvedSession?.state).toBe("resolved");
    const errorSession = notifStore.sessions.find((s) => s.category === "error");
    expect(errorSession).toBeTruthy();
    expect(errorSession!.events[0].title).toBe("Clear notification failed");
    expect(errorSession!.events[0].body).toBe("backend unreachable");
  });
});

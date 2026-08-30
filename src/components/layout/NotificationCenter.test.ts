/**
 * Component test for NotificationCenter — verifies that the profile label
 * element renders when a notification session has a known meta.profileId.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import NotificationCenter from "./NotificationCenter.vue";
import RunningAgentsPanel from "./RunningAgentsPanel.vue";
import { collectSupervisedAgents } from "../../app/selectors.js";
import { buildActivityForest } from "../../app/workspace-activity-tree.js";
import { projectPresentedForest } from "../../app/sidebar-presented-rows.js";
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

  it("does not render a profile label for the ACTIVE profile — the only one the dock shows", async () => {
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

    // The card renders…
    expect(wrapper.find(".notification-item").exists()).toBe(true);
    // …but naming the profile the user is already in tells them nothing, so
    // the tag is gone. NotificationCenter.profile-label.test.ts covers the
    // foreign-profile case, which is the only one the tag is for.
    expect(wrapper.find(".notification-item__profile-label").exists()).toBe(false);
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

describe("NotificationCenter — Agents tab", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
  });

  /**
   * A supervised (task) workspace — the only thing the Agents tab lists now
   * (V3 review, Fáze 1). A hand-opened Claude Code panel stays a local session
   * state on its tab and card, so the tab, the sidebar and the chip agree.
   */
  function taskWorkspace(id: string, name: string, state: string, startedAt: number): AnyApi {
    return {
      id,
      name,
      profileId: "p1",
      kind: "task",
      cwd: `/tmp/${id}`,
      panels: [
        { id: "worker", title: "Worker Claude" },
        { id: "judge", title: "Judge Codex" },
      ],
      task: {
        taskId: `t-${id}`,
        state,
        workerPanelId: "worker",
        judgePanelId: "judge",
        startedAt,
        totalPausedMs: 0,
        pausedAt: null,
        finishedAt: null,
      },
    };
  }

  /** A live agent-like session in a plain workspace — never an Agents row. */
  const PLAIN_SESSIONS = {
    "ws-a:sh": {
      workspaceId: "ws-a",
      panelId: "sh",
      activity: "running",
      agentLike: true,
      hasUserInput: true,
      activityStartedAt: Date.now() - 2 * 60 * 60 * 1000,
    },
  };

  const BUSY_TASK = taskWorkspace("ws-task", "Task One", "running", Date.now() - 2 * 60 * 60 * 1000);

  function busyPayload(): AnyApi {
    const payload = makePayload({ attention: { sessions: PLAIN_SESSIONS, alerts: [] } });
    payload.appState.workspaces = [...payload.appState.workspaces, BUSY_TASK];
    return payload;
  }

  it("adds an Agents tab that switches, and lists it in the narrow hamburger fallback too", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = busyPayload();
    notifStore.panelOpen = true;

    const wrapper = mount(NotificationCenter);
    await nextTick();

    const tabs = wrapper.findAll(".notification-center__tab").map((t) => t.text());
    expect(tabs.some((t) => t.includes("Agents"))).toBe(true);

    const agentsTab = wrapper.findAll(".notification-center__tab").find((t) => t.text().includes("Agents"))!;
    await agentsTab.trigger("click");
    expect(wrapper.find(".agent-run-list").exists()).toBe(true);

    // Hamburger fallback (rendered alongside; CSS decides which is visible).
    await wrapper.get(".notification-center__tabmenu-toggle").trigger("click");
    const menuItems = wrapper.findAll(".notification-center__tabmenu-item").map((i) => i.text());
    expect(menuItems.some((t) => t.includes("Agents"))).toBe(true);
  });

  it("keeps the tab in the bar when nothing runs and says so", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload();
    notifStore.panelOpen = true;

    const wrapper = mount(NotificationCenter);
    await nextTick();
    const agentsTab = wrapper.findAll(".notification-center__tab").find((t) => t.text().includes("Agents"))!;
    expect(agentsTab).toBeTruthy();
    await agentsTab.trigger("click");

    expect(wrapper.find(".agent-run-list").exists()).toBe(false);
    expect(wrapper.get(".notification-center__empty").text()).toBe("No agents running.");
  });

  it("renders the very same rows the sidebar surface renders over the same input", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = busyPayload();
    notifStore.panelOpen = true;

    const wrapper = mount(NotificationCenter);
    await nextTick();
    await wrapper
      .findAll(".notification-center__tab")
      .find((t) => t.text().includes("Agents"))!
      .trigger("click");

    const tabKeys = wrapper.findAll(".agent-run-item").map((r) => r.attributes("data-agent-key"));

    // The surface, over the identical input. It draws its hierarchy through
    // the activity forest now, so the rows arrive as clusters — but the AGENT
    // rows in them must still be exactly the tab's.
    const rows = collectSupervisedAgents({
      workspaces: appStore.filteredWorkspaces as AnyApi,
      workspaceGrid: appStore.workspaceGrid,
    });
    const surface = mount(RunningAgentsPanel, {
      props: {
        clusters: projectPresentedForest({
          live: buildActivityForest({
            selected: rows.map((row) => ({
              key: row.key,
              workspaceId: row.hostWorkspaceId,
              metric: row.startedAtMs ? -row.startedAtMs : Number.NEGATIVE_INFINITY,
              payload: row,
            })),
            workspaces: appStore.filteredWorkspaces as AnyApi,
          }),
          lockedForest: null,
          isAlive: () => true,
        }),
        now: Date.now(),
      },
    });
    const surfaceKeys = surface.findAll('[data-role="activity-node-row"]').map((r) => r.attributes("data-row-key"));

    // The plain `ws-a:sh` agent session is in the payload and in neither list.
    expect(tabKeys).toEqual(["ws-task:worker"]);
    expect(tabKeys).toEqual(surfaceKeys);
  });

  it("a plain agent-like session is neither listed nor counted", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    // Only the plain session runs — no task anywhere.
    appStore.payload = makePayload({ attention: { sessions: PLAIN_SESSIONS, alerts: [] } });
    notifStore.panelOpen = true;

    const wrapper = mount(NotificationCenter);
    await nextTick();
    await wrapper
      .findAll(".notification-center__tab")
      .find((t) => t.text().includes("Agents"))!
      .trigger("click");

    expect(wrapper.find(".agent-run-list").exists()).toBe(false);
    expect(wrapper.get(".notification-center__empty").text()).toBe("No agents running.");
    // …and the tab badge stays away too.
    expect(wrapper.find(".notification-center__tab-badge").exists()).toBe(false);
  });

  it("clicking a row navigates and resolves no notification thread", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    // The agent runs in a DIFFERENT workspace than the active one, so the
    // workspace activation is exercised too.
    const base = makePayload();
    base.appState.workspaces = [
      ...base.appState.workspaces,
      taskWorkspace("ws-b", "WsB", "running", Date.now() - 60_000),
    ];
    appStore.payload = base;
    notifStore.panelOpen = true;
    notifStore.add({ title: "Task done", kind: "completed", workspaceId: "ws-a", viewId: "ws-a:sh" });

    const inGrid = vi.fn().mockResolvedValue(undefined);
    const view = vi.fn().mockResolvedValue(undefined);
    (appStore as AnyApi).activateWorkspaceInGrid = inGrid;
    (appStore as AnyApi).activateView = view;
    const setState = vi.spyOn(notifStore, "setState");
    const clearOnBackend = vi.spyOn(notifStore, "clearOnBackend");

    const wrapper = mount(NotificationCenter);
    await nextTick();
    await wrapper
      .findAll(".notification-center__tab")
      .find((t) => t.text().includes("Agents"))!
      .trigger("click");
    await wrapper.get(".agent-run-item").trigger("click");
    await flushPromises();

    expect(inGrid).toHaveBeenCalledWith("ws-b");
    expect(view).toHaveBeenCalledWith("ws-b:worker");
    expect(setState).not.toHaveBeenCalled();
    expect(clearOnBackend).not.toHaveBeenCalled();
    expect(notifStore.sessions[0].state).toBe("finished");
  });

  it("switches to the Agents tab when the chip asks the store to open it", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = busyPayload();
    notifStore.panelOpen = true;

    const wrapper = mount(NotificationCenter);
    await nextTick();
    expect(wrapper.find(".agent-run-list").exists()).toBe(false);

    notifStore.openPanelOnTab("agents");
    await nextTick();
    await nextTick();

    expect(wrapper.find(".agent-run-list").exists()).toBe(true);
    // Purely a UI seam — no thread state, no badge.
    expect(notifStore.sessions).toEqual([]);
    expect(notifStore.unreadCount).toBe(0);
  });
});

describe("NotificationCenter — alert card density", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
  });

  it("the card is two rows: a head with the meta inline, and a single-line body", async () => {
    const appStore = useAppStore();
    const notifStore = useNotificationStore();
    appStore.payload = makePayload();
    notifStore.panelOpen = true;
    notifStore.add({
      title: "WsA › Shell",
      body: "Claude Code in WsA finished.",
      kind: "completed",
      workspaceId: "ws-a",
      viewId: "ws-a:sh",
      meta: { profileId: "p1" },
    });

    const wrapper = mount(NotificationCenter);
    await nextTick();
    await nextTick();

    const content = wrapper.get(".notification-item__content");
    // Exactly two block children: the head row and the body row.
    const rows = content.element.children;
    expect(rows.length).toBe(2);
    expect(rows[0].className).toContain("notification-item__head");
    expect(rows[1].className).toContain("notification-item__body");
    // The profile tag no longer owns a row of its own.
    expect(content.find(".notification-item__body .notification-item__profile-label").exists()).toBe(false);
  });
});

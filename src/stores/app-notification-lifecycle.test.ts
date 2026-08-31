import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAppStore } from "./app.js";
import { useNotificationStore } from "./notifications.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

/**
 * Transport stub that exposes the two push channels this wiring depends on:
 * the state broadcast (which drives reconnect reconciliation) and the
 * authoritative notification-lifecycle event.
 */
function makeTransport(initialPayload: AnyApi, { isRemote = false } = {}) {
  let stateHandler: ((payload: AnyApi) => void) | null = null;
  let removalHandler: ((event: AnyApi) => void) | null = null;
  return {
    isRemote,
    getState: vi.fn(() => Promise.resolve(initialPayload)),
    onStateUpdated: (fn: (payload: AnyApi) => void) => {
      stateHandler = fn;
    },
    onConnectionState: vi.fn(),
    onNotificationTargetRemoved: (fn: (event: AnyApi) => void) => {
      removalHandler = fn;
    },
    activateWorkspace: vi.fn(() => Promise.resolve(initialPayload)),
    activateProfile: vi.fn(() => Promise.resolve(initialPayload)),
    activateSession: vi.fn(() => Promise.resolve(initialPayload)),
    _push: (p: AnyApi) => stateHandler?.(p),
    _removed: (event: AnyApi) => removalHandler?.(event),
    _hasRemovalHandler: () => removalHandler !== null,
  };
}

function makePayload(workspaceIds: string[], overrides: AnyApi = {}): AnyApi {
  return {
    meta: { appVersion: "0.0.0", platform: "test", repositoryUrl: "", versionCheck: {}, recoveryCandidates: [] },
    appState: {
      activeWorkspaceId: workspaceIds[0] || "",
      profiles: [
        { id: "p1", name: "P1", color: "#fff", workspaceIds: [] },
        { id: "p2", name: "P2", color: "#fff", workspaceIds: [] },
      ],
      workspaces: workspaceIds.map((id) => ({
        id,
        name: id,
        profileId: "p1",
        panels: [],
        kind: "terminal",
        cwd: "/tmp",
      })),
      windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: workspaceIds[0] || "", activeSessionId: "" }],
      settings: {},
      tabTemplates: [],
      ssh: {
        hosts: [],
        keys: [],
        certificates: [],
        knownHosts: {},
        settings: { defaultAgentMode: "inherit", importedSshConfig: false },
      },
    },
    workspace: null,
    attention: { sessions: {}, alerts: [] },
    docker: { available: false, containers: [], error: "", lastUpdatedAt: null },
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seed(store: any, workspaceId: string, viewId: string, profileId = "p1"): void {
  store.add({ title: "t", body: "b", kind: "waiting", workspaceId, viewId, meta: { profileId } });
}

describe("app store — notification lifecycle events", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
  });

  it("a workspace removal event drops that workspace's history and nothing else", async () => {
    const transport = makeTransport(makePayload(["ws1", "ws2"]));
    const store = useAppStore();
    const notifications = useNotificationStore();
    seed(notifications, "ws1", "ws1:a");
    seed(notifications, "ws2", "ws2:a");

    store.init(transport as AnyApi);
    expect(transport._hasRemovalHandler()).toBe(true);

    transport._removed({ target: "workspace", workspaceId: "ws1", profileId: "p1" });

    expect(notifications.sessions.map((s) => s.workspaceId)).toEqual(["ws2"]);
  });

  it("a view removal event drops only that view's history", async () => {
    const transport = makeTransport(makePayload(["ws1"]));
    const store = useAppStore();
    const notifications = useNotificationStore();
    seed(notifications, "ws1", "ws1:a");
    seed(notifications, "ws1", "ws1:b");

    store.init(transport as AnyApi);
    expect(transport._hasRemovalHandler()).toBe(true);

    transport._removed({ target: "view", workspaceId: "ws1", viewId: "ws1:a", profileId: "p1" });

    expect(notifications.sessions.map((s) => s.viewId)).toEqual(["ws1:b"]);
  });

  it("duplicate events are idempotent", async () => {
    const transport = makeTransport(makePayload(["ws1", "ws2"]));
    const store = useAppStore();
    const notifications = useNotificationStore();
    seed(notifications, "ws1", "ws1:a");
    seed(notifications, "ws2", "ws2:a");

    store.init(transport as AnyApi);
    expect(transport._hasRemovalHandler()).toBe(true);

    transport._removed({ target: "workspace", workspaceId: "ws1", profileId: "p1" });
    transport._removed({ target: "workspace", workspaceId: "ws1", profileId: "p1" });
    transport._removed({ target: "view", workspaceId: "ws1", viewId: "ws1:a", profileId: "p1" });

    expect(notifications.sessions.map((s) => s.workspaceId)).toEqual(["ws2"]);
  });
});

describe("app store — reconnect reconciliation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
    vi.spyOn(window, "confirm").mockImplementation(() => true);
  });

  it("the bootstrap payload sweeps history for workspaces that vanished while disconnected", async () => {
    const transport = makeTransport(makePayload(["ws1"]));
    const store = useAppStore();
    const notifications = useNotificationStore();
    seed(notifications, "ws1", "ws1:a");
    seed(notifications, "ws-vanished", "ws-vanished:a");

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    expect(notifications.sessions.map((s) => s.workspaceId)).toEqual(["ws1"]);
  });

  // The optimistic delete strips the workspace from a LOCALLY composed payload
  // and can still be rolled back. Reconciling against that view would purge
  // history for a workspace that comes back — and nothing could restore it.
  it("an in-flight optimistic delete does not purge history while the backend still reports the workspace", async () => {
    const initial = makePayload(["ws1", "ws2"]);
    const transport = makeTransport(initial);
    (transport as AnyApi).deleteWorkspace = vi.fn(() => new Promise(() => {}));
    const store = useAppStore();
    const notifications = useNotificationStore();
    seed(notifications, "ws2", "ws2:a");

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    void store.deleteWorkspace("ws2");
    await Promise.resolve();
    expect(store.overlay).toBe("ConfirmDialog");
    (store.overlayProps as AnyApi).onConfirm();
    await Promise.resolve();

    // Sidebar already hides it; the backend has not committed anything yet.
    expect((store.payload as AnyApi).appState.workspaces.find((w: AnyApi) => w.id === "ws2")).toBeUndefined();

    // An interim broadcast that STILL carries ws2 must leave the history alone.
    transport._push(initial);
    await Promise.resolve();
    expect(notifications.sessions.map((s) => s.workspaceId)).toEqual(["ws2"]);
  });

  it("once the backend broadcast drops the workspace, its history is swept", async () => {
    const transport = makeTransport(makePayload(["ws1", "ws2"]));
    const store = useAppStore();
    const notifications = useNotificationStore();
    seed(notifications, "ws2", "ws2:a");

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();
    expect(notifications.sessions).toHaveLength(1);

    transport._push(makePayload(["ws1"]));
    await Promise.resolve();

    expect(notifications.sessions).toHaveLength(0);
  });

  // A remote protocol-v2 core carries only the viewer's own profile, so absence
  // from it is not proof that another profile's workspace was deleted.
  it("a remote payload never sweeps a foreign-profile or unstamped session", async () => {
    const remotePayload = makePayload(["ws1"], { remoteClient: { profileId: "p1", activeWorkspaceId: "ws1" } });
    const transport = makeTransport(remotePayload, { isRemote: true });
    const store = useAppStore();
    const notifications = useNotificationStore();
    seed(notifications, "ws-gone-mine", "ws-gone-mine:a", "p1");
    seed(notifications, "ws-gone-foreign", "ws-gone-foreign:a", "p2");
    notifications.add({ title: "t", body: "b", kind: "waiting", workspaceId: "ws-gone-legacy", viewId: "x" });

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    expect(notifications.sessions.map((s) => s.workspaceId).sort()).toEqual(["ws-gone-foreign", "ws-gone-legacy"]);
  });
});

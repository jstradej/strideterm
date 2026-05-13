import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAppStore } from "./app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

/**
 * Minimal remote transport mock. `isRemote = true` causes the store to read
 * profile / workspace identity from `payload.remoteClient` instead of
 * `payload.appState.windowSlots`.
 */
function makeRemoteTransport(initialPayload: AnyApi) {
  let stateHandler: ((payload: AnyApi) => void) | null = null;
  return {
    isRemote: true,
    getState: vi.fn(() => Promise.resolve(initialPayload)),
    onStateUpdated: (fn: (payload: AnyApi) => void) => {
      stateHandler = fn;
    },
    onConnectionState: vi.fn(),
    activateWorkspace: vi.fn(() => Promise.resolve(initialPayload)),
    activateProfile: vi.fn(() => Promise.resolve(initialPayload)),
    activateSession: vi.fn(() => Promise.resolve(initialPayload)),
    // expose for tests that need to push a new payload
    _push: (p: AnyApi) => stateHandler?.(p),
  };
}

function makeElectronTransport(initialPayload: AnyApi) {
  return {
    isRemote: false,
    getState: vi.fn(() => Promise.resolve(initialPayload)),
    onStateUpdated: vi.fn(),
    onConnectionState: vi.fn(),
    activateWorkspace: vi.fn(() => Promise.resolve(initialPayload)),
    activateProfile: vi.fn(() => Promise.resolve(initialPayload)),
    activateSession: vi.fn(() => Promise.resolve(initialPayload)),
  };
}

function makeBasePayload(overrides: AnyApi = {}): AnyApi {
  return {
    meta: { appVersion: "0.0.0", platform: "test", repositoryUrl: "", versionCheck: {}, recoveryCandidates: [] },
    appState: {
      activeWorkspaceId: "",
      profiles: [
        { id: "p1", name: "P1", color: "#fff", workspaceIds: [] },
        { id: "p2", name: "P2", color: "#fff", workspaceIds: [] },
      ],
      workspaces: [
        { id: "ws1", name: "Workspace 1", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
        { id: "ws2", name: "Workspace 2", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
      ],
      windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "" }],
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
    themeSource: "light",
    remoteAccess: { enabled: false, host: "", port: 0, tunnel: { active: false, url: null, error: null } },
    agentNotifyHook: { enabled: false, port: 0 },
    taskRunner: {},
    ...overrides,
  };
}

describe("useAppStore — remote mode identity", () => {
  beforeEach(() => {
    // Each test gets a fresh Pinia so store state doesn't leak.
    setActivePinia(createPinia());
    // Provide a minimal window.strideterm stub (store reads windowId from it).

    (window as AnyApi).strideterm = { startupFlags: { windowId: "" } };
  });

  it("myActiveProfileId reads remoteClient.profileId in remote mode", async () => {
    const payload = makeBasePayload({
      remoteClient: { id: "sess1", profileId: "p2", activeWorkspaceId: "ws1", activeSessionId: "" },
    });
    const transport = makeRemoteTransport(payload);
    const store = useAppStore();

    store.init(transport as AnyApi);
    // Wait for getState() promise to resolve and update payload
    await Promise.resolve();
    await Promise.resolve();

    expect(store.myActiveProfileId).toBe("p2");
  });

  it("keeps remote profile identity reactive when read before init", async () => {
    const payload = makeBasePayload({
      remoteClient: { id: "sess1", profileId: "p2", activeWorkspaceId: "ws3", activeSessionId: "" },
      appState: {
        activeWorkspaceId: "ws1",
        profiles: [
          { id: "p1", name: "P1", color: "#fff", workspaceIds: [] },
          { id: "p2", name: "P2", color: "#fff", workspaceIds: [] },
        ],
        workspaces: [
          { id: "ws1", name: "Workspace 1", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
          { id: "ws3", name: "Workspace 3", profileId: "p2", panels: [], kind: "terminal", cwd: "/tmp" },
        ],
        windowSlots: [],
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
    });
    const transport = makeRemoteTransport(payload);
    const store = useAppStore();

    expect(store.myActiveProfileId).toBeNull();

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    expect(store.myActiveProfileId).toBe("p2");
    expect(store.filteredWorkspaces.map((ws: AnyApi) => ws.id)).toEqual(["ws3"]);
  });

  it("myActiveProfileId falls back to the first real profile when remoteClient is absent", async () => {
    const payload = makeBasePayload(); // no remoteClient
    const transport = makeRemoteTransport(payload);
    const store = useAppStore();

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    expect(store.myActiveProfileId).toBe("p1");
    expect(store.myActiveWorkspaceId).toBe("ws1");
    expect(store.filteredWorkspaces.map((ws: AnyApi) => ws.id)).toEqual(["ws1", "ws2"]);
  });

  it("myActiveWorkspaceId ignores stale remote workspace ids from another profile", async () => {
    const payload = makeBasePayload({
      remoteClient: { id: "sess1", profileId: "p2", activeWorkspaceId: "ws1", activeSessionId: "" },
      appState: {
        activeWorkspaceId: "",
        profiles: [
          { id: "p1", name: "P1", color: "#fff", workspaceIds: [] },
          { id: "p2", name: "P2", color: "#fff", workspaceIds: [] },
        ],
        workspaces: [
          { id: "ws1", name: "Workspace 1", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
          { id: "ws3", name: "Workspace 3", profileId: "p2", panels: [], kind: "terminal", cwd: "/tmp" },
        ],
        windowSlots: [],
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
    });
    const transport = makeRemoteTransport(payload);
    const store = useAppStore();

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    expect(store.myActiveProfileId).toBe("p2");
    expect(store.myActiveWorkspaceId).toBe("ws3");
    expect(store.filteredWorkspaces.map((ws: AnyApi) => ws.id)).toEqual(["ws3"]);
  });

  it("myActiveProfileId ignores stale remote profile ids that no longer exist", async () => {
    const payload = makeBasePayload({
      remoteClient: { id: "sess1", profileId: "deleted-profile", activeWorkspaceId: "", activeSessionId: "" },
    });
    const transport = makeRemoteTransport(payload);
    const store = useAppStore();

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    expect(store.activeProfile.name).toBe("P1");
    expect(store.myActiveProfileId).toBe("p1");
    expect(store.filteredWorkspaces.map((ws: AnyApi) => ws.id)).toEqual(["ws1", "ws2"]);
  });

  it("optimistic workspace activation in remote mode updates remoteClient but not windowSlots", async () => {
    const originalSlots = [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "" }];
    const payload = makeBasePayload({
      remoteClient: { id: "sess1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "" },
      appState: {
        activeWorkspaceId: "ws1",
        profiles: [{ id: "p1", name: "P1", color: "#fff", workspaceIds: [] }],
        workspaces: [
          { id: "ws1", name: "WS1", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
          { id: "ws2", name: "WS2", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
        ],
        windowSlots: originalSlots,
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
    });

    // activateWorkspace will hang until we resolve it — leave it pending so
    // we can inspect the optimistic state before the response arrives.
    let resolveActivate!: (v: AnyApi) => void;
    const activatePromise = new Promise<AnyApi>((res) => {
      resolveActivate = res;
    });
    const transport = makeRemoteTransport(payload);
    transport.activateWorkspace = vi.fn(() => activatePromise);

    const store = useAppStore();
    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    // Now trigger the workspace switch — this should optimistically update
    const activateTask = store.activateWorkspace("ws2");

    // Give the optimistic update a tick to apply
    await Promise.resolve();

    // The remoteClient activeWorkspaceId should reflect ws2
    const rc = (store as AnyApi).payload?.remoteClient as AnyApi;
    expect(rc?.activeWorkspaceId).toBe("ws2");

    // windowSlots must NOT have been mutated
    const slots = (store as AnyApi).payload?.appState?.windowSlots as AnyApi[];
    expect(slots?.[0]?.activeWorkspaceId).toBe("ws1"); // unchanged

    // Clean up pending promise
    resolveActivate(payload);
    await activateTask;
  });

  it("adopts remote activation HTTP responses scoped by remoteClient without waiting for WS", async () => {
    const initialPayload = makeBasePayload({
      remoteClient: { id: "sess1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "" },
      appState: {
        activeWorkspaceId: "ws1",
        profiles: [{ id: "p1", name: "P1", color: "#fff", workspaceIds: [] }],
        workspaces: [
          { id: "ws1", name: "WS1", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
          { id: "ws2", name: "WS2", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
        ],
        windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "" }],
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
    });
    const responsePayload = {
      ...initialPayload,
      remoteClient: { id: "sess1", profileId: "p1", activeWorkspaceId: "ws2", activeSessionId: "" },
      workspace: { workspace: { id: "ws1", name: "WS1", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" } },
    };
    const transport = makeRemoteTransport(initialPayload);
    transport.activateWorkspace = vi.fn(() => Promise.resolve(responsePayload));
    const store = useAppStore();

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();
    await store.activateWorkspace("ws2");

    expect(store.myActiveWorkspaceId).toBe("ws2");
    expect(store.pendingWorkspaceActivationId).toBe("");
    expect(store.activeWorkspace.id).toBe("ws2");
    expect((store as AnyApi).payload.remoteClient.activeWorkspaceId).toBe("ws2");
    expect((store as AnyApi).payload.appState.activeWorkspaceId).toBe("ws1");
  });
});

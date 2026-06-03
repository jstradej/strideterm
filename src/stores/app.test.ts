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
  let stateHandler: ((payload: AnyApi) => void) | null = null;
  return {
    isRemote: false,
    getState: vi.fn(() => Promise.resolve(initialPayload)),
    onStateUpdated: (fn: (payload: AnyApi) => void) => {
      stateHandler = fn;
    },
    onConnectionState: vi.fn(),
    activateWorkspace: vi.fn(() => Promise.resolve(initialPayload)),
    activateProfile: vi.fn(() => Promise.resolve(initialPayload)),
    activateSession: vi.fn(() => Promise.resolve(initialPayload)),
    // expose so tests can push interim payloads through the store's broadcast handler
    _push: (p: AnyApi) => stateHandler?.(p),
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
      remoteClient: { id: "sess1", profileId: "p2", activeWorkspaceId: "ws3", activeSessionId: "" },
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
        windowSlots: [{ id: "slot2", profileId: "p2", activeWorkspaceId: "ws3", activeSessionId: "" }],
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
        windowSlots: [{ id: "slot2", profileId: "p2", activeWorkspaceId: "ws3", activeSessionId: "" }],
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

  it("myActiveProfileId falls back to the first open desktop profile when remoteClient is absent", async () => {
    const payload = makeBasePayload({
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
        windowSlots: [{ id: "slot2", profileId: "p2", activeWorkspaceId: "ws3", activeSessionId: "" }],
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
        windowSlots: [{ id: "slot2", profileId: "p2", activeWorkspaceId: "ws3", activeSessionId: "" }],
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

  it("myActiveProfileId keeps the remote profile even when it has no desktop window (independent viewer)", async () => {
    // p1 has no desktop window — the remote client is an independent viewer
    // and its binding to p1 stays valid as long as the profile exists.
    const payload = makeBasePayload({
      remoteClient: { id: "sess1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "" },
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
        windowSlots: [{ id: "slot2", profileId: "p2", activeWorkspaceId: "ws3", activeSessionId: "" }],
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

    expect(store.activeProfile.name).toBe("P1");
    expect(store.myActiveProfileId).toBe("p1");
    expect(store.filteredWorkspaces.map((ws: AnyApi) => ws.id)).toEqual(["ws1"]);
  });

  it("myActiveProfileId falls back when the remote profile id no longer exists", async () => {
    // The bound profile was deleted — fall back to a profile open on the
    // desktop (else the first existing profile).
    const payload = makeBasePayload({
      remoteClient: { id: "sess1", profileId: "p-deleted", activeWorkspaceId: "", activeSessionId: "" },
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
        windowSlots: [{ id: "slot2", profileId: "p2", activeWorkspaceId: "ws3", activeSessionId: "" }],
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

    expect(store.activeProfile.name).toBe("P2");
    expect(store.myActiveProfileId).toBe("p2");
    expect(store.filteredWorkspaces.map((ws: AnyApi) => ws.id)).toEqual(["ws3"]);
  });

  it("remote profile context works even when no desktop window is open at all", async () => {
    const payload = makeBasePayload({
      remoteClient: { id: "sess1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "" },
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

    expect(store.myActiveProfileId).toBe("p1");
    expect(store.myActiveWorkspaceId).toBe("ws1");
    expect(store.filteredWorkspaces.map((ws: AnyApi) => ws.id)).toEqual(["ws1"]);
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

describe("handleBroadcastPayload — optimistic-delete suppression", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
    vi.spyOn(window, "confirm").mockImplementation(() => true);
  });

  // deleteWorkspace gates on an in-app ConfirmDialog overlay (see confirmInApp
  // in app-workspace-actions). The store exposes overlay state on
  // store.overlay / store.overlayProps; flushing the confirm here lets the
  // optimistic strip proceed in tests.
  async function answerConfirm(store: AnyApi, accept = true): Promise<void> {
    await Promise.resolve();
    expect(store.overlay).toBe("ConfirmDialog");
    const props = store.overlayProps as AnyApi;
    if (accept) props.onConfirm();
    else props.onCancel();
    await Promise.resolve();
  }

  function buildInitialPayload(): AnyApi {
    return makeBasePayload({
      appState: {
        activeWorkspaceId: "ws1",
        profiles: [{ id: "p1", name: "P1", color: "#fff", workspaceIds: [] }],
        workspaces: [
          { id: "ws1", name: "WS 1", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
          { id: "ws2", name: "WS 2", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
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
  }

  it("interim broadcast that still has the workspace keeps the optimistic flag (no UI flicker)", async () => {
    // Regression: the broadcast handler used to compute `stillPresent` from
    // the ALREADY-STRIPPED payload, so the first interim broadcast — the one
    // where the backend hadn't finished the delete yet — would clear the
    // optimistic flag prematurely. The NEXT interim broadcast (still carrying
    // ws-A) would then no longer strip and the deleted workspace would
    // flicker back into the sidebar. With the longer backend pending window
    // introduced by the same-cwd guard, that flicker became visible for
    // multiple frames.
    const initial = buildInitialPayload();
    const transport = makeElectronTransport(initial);
    // Hang the delete IPC indefinitely so the backend "stays" mid-delete and
    // the suppression flag has to do its job.
    (transport as AnyApi).deleteWorkspace = vi.fn(() => new Promise(() => {}));

    const store = useAppStore();
    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    // Fire optimistic delete — UI hides ws2 immediately, IPC is still in flight.
    void store.deleteWorkspace("ws2");
    await answerConfirm(store, true);
    await Promise.resolve();
    expect(((store as AnyApi).payload.appState.workspaces as AnyApi[]).find((w) => w.id === "ws2")).toBeUndefined();

    // First interim broadcast: backend still reports ws2 (delete not yet committed).
    transport._push(initial);
    await Promise.resolve();
    expect(((store as AnyApi).payload.appState.workspaces as AnyApi[]).find((w) => w.id === "ws2")).toBeUndefined();

    // SECOND interim broadcast: same — still strips. This is the assertion
    // that catches the original bug. Pre-fix, the first broadcast cleared
    // the flag and this second broadcast would let ws2 re-surface.
    transport._push(initial);
    await Promise.resolve();
    expect(((store as AnyApi).payload.appState.workspaces as AnyApi[]).find((w) => w.id === "ws2")).toBeUndefined();
  });

  it("broadcast without the workspace clears the optimistic flag (subsequent payloads are not stripped)", async () => {
    // Symmetric to the test above: once the BACKEND broadcast no longer
    // carries the workspace, the deletion has landed and the flag must
    // release — otherwise a freshly-created workspace with the same id (or
    // a re-arrived one after a profile switch) would be invisibly hidden.
    const initial = buildInitialPayload();
    const transport = makeElectronTransport(initial);
    (transport as AnyApi).deleteWorkspace = vi.fn(() => new Promise(() => {}));

    const store = useAppStore();
    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    void store.deleteWorkspace("ws2");
    await answerConfirm(store, true);
    await Promise.resolve();

    // Backend confirms the delete by broadcasting a payload without ws2.
    const backendDone = makeBasePayload({
      appState: {
        ...(initial as AnyApi).appState,
        workspaces: ((initial as AnyApi).appState.workspaces as AnyApi[]).filter((w) => w.id !== "ws2"),
      },
    });
    transport._push(backendDone);
    await Promise.resolve();
    expect(((store as AnyApi).payload.appState.workspaces as AnyApi[]).find((w) => w.id === "ws2")).toBeUndefined();

    // Now a fresh workspace with id "ws2" gets created (or re-emerges from a
    // profile switch). The flag must have been cleared so it shows up.
    const reborn = makeBasePayload({
      appState: {
        ...(initial as AnyApi).appState,
        workspaces: [
          { id: "ws1", name: "WS 1", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
          { id: "ws2", name: "Reborn WS 2", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
        ],
      },
    });
    transport._push(reborn);
    await Promise.resolve();
    const rebornEntry = ((store as AnyApi).payload.appState.workspaces as AnyApi[]).find((w) => w.id === "ws2");
    expect(rebornEntry).toBeDefined();
    expect(rebornEntry?.name).toBe("Reborn WS 2");
  });
});

describe("useAppStore — activateProfile adopts restored session from payload", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
  });

  it("sets activeSessionId from slot when backend returns restored session", async () => {
    const initial = makeBasePayload();
    const restoredPayload = makeBasePayload({
      appState: {
        activeWorkspaceId: "ws2",
        profiles: [
          { id: "p1", name: "P1", color: "#fff", workspaceIds: ["ws1"] },
          { id: "p2", name: "P2", color: "#fff", workspaceIds: ["ws2"] },
        ],
        workspaces: [
          {
            id: "ws1",
            name: "W1",
            profileId: "p1",
            panels: [{ id: "sh", title: "S", command: "" }],
            kind: "terminal",
            cwd: "/tmp",
          },
          {
            id: "ws2",
            name: "W2",
            profileId: "p2",
            panels: [{ id: "sh", title: "S", command: "" }],
            kind: "terminal",
            cwd: "/tmp",
          },
        ],
        windowSlots: [{ id: "slot1", profileId: "p2", activeWorkspaceId: "ws2", activeSessionId: "ws2:sh" }],
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
    const transport = makeElectronTransport(initial);
    (transport as AnyApi).activateProfile = vi.fn(() => Promise.resolve(restoredPayload));
    const store = useAppStore();
    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    await (store as AnyApi).activateProfile("p2");

    expect((store as AnyApi).activeSessionId).toBe("ws2:sh");
  });

  it("clears activeSessionId when backend slot has no restored session", async () => {
    const initial = makeBasePayload();
    const restoredPayload = makeBasePayload({
      appState: {
        activeWorkspaceId: "ws2",
        profiles: [
          { id: "p1", name: "P1", color: "#fff", workspaceIds: ["ws1"] },
          { id: "p2", name: "P2", color: "#fff", workspaceIds: ["ws2"] },
        ],
        workspaces: [
          { id: "ws1", name: "W1", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
          { id: "ws2", name: "W2", profileId: "p2", panels: [], kind: "terminal", cwd: "/tmp" },
        ],
        windowSlots: [{ id: "slot1", profileId: "p2", activeWorkspaceId: "ws2", activeSessionId: "" }],
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
    const transport = makeElectronTransport(initial);
    (transport as AnyApi).activateProfile = vi.fn(() => Promise.resolve(restoredPayload));
    const store = useAppStore();
    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    // Set a non-null activeSessionId before activating
    (store as AnyApi).activeSessionId = "ws1:sh";
    await (store as AnyApi).activateProfile("p2");

    expect((store as AnyApi).activeSessionId).toBeNull();
  });
});

describe("useAppStore — cross-profile notification jump confirmation logic", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
  });

  /**
   * Extract the cross-profile jump logic for unit testing without mounting
   * the full NotificationCenter Vue component. This mirrors the jump() function's
   * profile-check path.
   */
  async function simulateCrossProfileJump(
    store: AnyApi,
    targetWorkspaceId: string,
    shouldConfirm: boolean,
  ): Promise<{ confirmed: boolean; activateProfileCalled: boolean; activateWorkspaceCalled: boolean }> {
    const workspaces = (store.payload?.appState?.workspaces || []) as AnyApi[];
    const targetWs = workspaces.find((w: AnyApi) => w.id === targetWorkspaceId);
    const targetProfileId = targetWs ? targetWs.profileId || "default" : null;
    const currentProfileId = store.myActiveProfileId || "default";

    let activateProfileCalled = false;

    if (targetProfileId && targetProfileId !== currentProfileId) {
      const confirmed = await store.confirmInApp({
        title: "Switch profile?",
        message: `Switch to activate this session?`,
        confirmLabel: "Switch",
        cancelLabel: "Cancel",
      });
      if (!confirmed) return { confirmed: false, activateProfileCalled: false, activateWorkspaceCalled: false };
      activateProfileCalled = true;
      await store.activateProfile(targetProfileId);
    }
    await store.activateWorkspace(targetWorkspaceId);
    return { confirmed: shouldConfirm, activateProfileCalled, activateWorkspaceCalled: true };
  }

  it("same-profile jump does not call activateProfile", async () => {
    const payload = makeBasePayload({
      appState: {
        activeWorkspaceId: "ws1",
        profiles: [{ id: "p1", name: "P1", color: "#fff", workspaceIds: ["ws1", "ws2"] }],
        workspaces: [
          { id: "ws1", name: "W1", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
          { id: "ws2", name: "W2", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
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
    const transport = makeElectronTransport(payload);
    (transport as AnyApi).activateWorkspace = vi.fn(() => Promise.resolve(payload));
    (transport as AnyApi).activateProfile = vi.fn(() => Promise.resolve(payload));
    const store = useAppStore();
    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    // Set confirmInApp to always confirm (shouldn't be called for same-profile)
    let confirmCalled = false;
    (store as AnyApi).confirmInApp = vi.fn(() => {
      confirmCalled = true;
      return Promise.resolve(true);
    });

    const result = await simulateCrossProfileJump(store, "ws2", true);
    expect(confirmCalled).toBe(false);
    expect(result.activateProfileCalled).toBe(false);
    expect(result.activateWorkspaceCalled).toBe(true);
  });

  it("cross-profile jump calls confirmInApp and activateProfile on confirm", async () => {
    // Initial payload has ws1 (p1) and ws2 (p2) in separate profiles.
    const crossProfilePayload = makeBasePayload({
      appState: {
        activeWorkspaceId: "ws1",
        profiles: [
          { id: "p1", name: "P1", color: "#fff", workspaceIds: ["ws1"] },
          { id: "p2", name: "P2", color: "#fff", workspaceIds: ["ws2"] },
        ],
        workspaces: [
          { id: "ws1", name: "W1", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
          { id: "ws2", name: "W2", profileId: "p2", panels: [], kind: "terminal", cwd: "/tmp" },
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
    const transport = makeElectronTransport(crossProfilePayload);
    (transport as AnyApi).activateWorkspace = vi.fn(() => Promise.resolve(crossProfilePayload));
    (transport as AnyApi).activateProfile = vi.fn(() => Promise.resolve(crossProfilePayload));
    const store = useAppStore();
    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    let confirmCalled = false;
    (store as AnyApi).confirmInApp = vi.fn(() => {
      confirmCalled = true;
      return Promise.resolve(true);
    });

    const result = await simulateCrossProfileJump(store, "ws2", true);
    expect(confirmCalled).toBe(true);
    expect(result.activateProfileCalled).toBe(true);
    expect(result.activateWorkspaceCalled).toBe(true);
  });

  it("cross-profile jump does not switch on cancel", async () => {
    // Same cross-profile setup: p1 is active, ws2 is in p2.
    const crossProfilePayload = makeBasePayload({
      appState: {
        activeWorkspaceId: "ws1",
        profiles: [
          { id: "p1", name: "P1", color: "#fff", workspaceIds: ["ws1"] },
          { id: "p2", name: "P2", color: "#fff", workspaceIds: ["ws2"] },
        ],
        workspaces: [
          { id: "ws1", name: "W1", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" },
          { id: "ws2", name: "W2", profileId: "p2", panels: [], kind: "terminal", cwd: "/tmp" },
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
    const transport = makeElectronTransport(crossProfilePayload);
    (transport as AnyApi).activateProfile = vi.fn(() => Promise.resolve(crossProfilePayload));
    (transport as AnyApi).activateWorkspace = vi.fn(() => Promise.resolve(crossProfilePayload));
    const store = useAppStore();
    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    // Reject the confirmation
    (store as AnyApi).confirmInApp = vi.fn(() => Promise.resolve(false));

    const result = await simulateCrossProfileJump(store, "ws2", false);
    expect(result.confirmed).toBe(false);
    expect(result.activateProfileCalled).toBe(false);
    expect(result.activateWorkspaceCalled).toBe(false);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import { useAppStore, resolveViewerProfileId } from "./app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

/**
 * Minimal remote transport mock. `isRemote = true` causes the store to read
 * profile / workspace identity from `payload.remoteClient` instead of
 * `payload.appState.windowSlots`.
 */
function makeRemoteTransport(initialPayload: AnyApi) {
  let stateHandler: ((payload: AnyApi) => void) | null = null;
  let connHandler: ((c: AnyApi) => void) | null = null;
  return {
    isRemote: true,
    getState: vi.fn(() => Promise.resolve(initialPayload)),
    onStateUpdated: (fn: (payload: AnyApi) => void) => {
      stateHandler = fn;
    },
    onConnectionState: (fn: (c: AnyApi) => void) => {
      connHandler = fn;
    },
    activateWorkspace: vi.fn(() => Promise.resolve(initialPayload)),
    activateProfile: vi.fn(() => Promise.resolve(initialPayload)),
    activateSession: vi.fn(() => Promise.resolve(initialPayload)),
    // expose for tests that need to push a new payload
    _push: (p: AnyApi) => stateHandler?.(p),
    _connectionState: (c: AnyApi) => connHandler?.(c),
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
    remoteAccess: { enabled: false, host: "", port: 0, tunnel: { active: false, url: null, error: null } },
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

  it("adopts remote session activation responses scoped by remoteClient workspace", async () => {
    const ws1 = {
      id: "ws1",
      name: "WS1",
      profileId: "p1",
      panels: [{ id: "sh", title: "Shell", command: "" }],
      kind: "terminal",
      cwd: "/tmp",
    };
    const ws2 = {
      id: "ws2",
      name: "WS2",
      profileId: "p1",
      panels: [{ id: "sh", title: "Shell", command: "" }],
      kind: "terminal",
      cwd: "/tmp",
    };
    const ws1Payload = {
      workspace: ws1,
      project: ws1,
      sessions: [{ sessionId: "ws1:sh", panelId: "sh", title: "Shell", command: "", status: "idle" }],
    };
    const initialPayload = makeBasePayload({
      remoteClient: { id: "sess1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "ws1:sh" },
      appState: {
        activeWorkspaceId: "ws1",
        profiles: [{ id: "p1", name: "P1", color: "#fff", workspaceIds: [] }],
        workspaces: [ws1, ws2],
        windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "ws1:sh" }],
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
      workspace: ws1Payload,
    });
    const responsePayload = {
      ...initialPayload,
      remoteClient: { id: "sess1", profileId: "p1", activeWorkspaceId: "ws2", activeSessionId: "ws2:sh" },
      // Simulates the remote server response before the renderer scopes it:
      // appState.activeWorkspaceId / payload.workspace still reflect desktop.
      appState: { ...initialPayload.appState, activeWorkspaceId: "ws1" },
      workspace: ws1Payload,
    };
    const transport = makeRemoteTransport(initialPayload);
    transport.activateSession = vi.fn(() => Promise.resolve(responsePayload));
    const store = useAppStore();

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();
    await store.activateView("ws2:sh");

    expect(store.myActiveWorkspaceId).toBe("ws2");
    expect(store.activeWorkspace.id).toBe("ws2");
    expect((store as AnyApi).payload.remoteClient.activeSessionId).toBe("ws2:sh");
    expect((store as AnyApi).payload.appState.activeWorkspaceId).toBe("ws1");
  });

  it("adds a tab on its OWN workspace when saveWorkspace returns a desktop-scoped payload", async () => {
    // Repro of the mobile "+ Tab" bug: the phone is on ws-mine, the desktop is
    // on ws-desktop. saveWorkspace answers with getPayload(), whose `workspace`
    // is ALWAYS the desktop's active workspace — adopting it raw jumped the
    // phone's tab strip to ws-desktop and left the new tab nowhere to be seen.
    const wsMine = {
      id: "ws-mine",
      name: "Mine",
      profileId: "p1",
      panels: [{ id: "shell", title: "Shell", command: "" }],
      activePanelId: "shell",
      kind: "terminal",
      cwd: "/tmp",
    };
    const wsDesktop = {
      id: "ws-desktop",
      name: "Desktop",
      profileId: "p1",
      panels: [{ id: "other", title: "Other", command: "" }],
      activePanelId: "other",
      kind: "terminal",
      cwd: "/tmp",
    };
    const desktopWorkspacePayload = {
      workspace: wsDesktop,
      project: wsDesktop,
      sessions: [{ sessionId: "ws-desktop:other", panelId: "other", title: "Other", command: "", status: "running" }],
    };
    const initialPayload = makeBasePayload({
      remoteClient: { id: "sess1", profileId: "p1", activeWorkspaceId: "ws-mine", activeSessionId: "ws-mine:shell" },
      appState: {
        activeWorkspaceId: "ws-desktop",
        profiles: [{ id: "p1", name: "P1", color: "#fff", workspaceIds: [] }],
        workspaces: [wsMine, wsDesktop],
        windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-desktop", activeSessionId: "" }],
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
      workspace: desktopWorkspacePayload,
    });
    const transport = makeRemoteTransport(initialPayload);
    // The backend persists the workspace it was handed and answers with a
    // payload whose `workspace` is still the DESKTOP's.
    (transport as AnyApi).saveWorkspace = vi.fn((saved: AnyApi) =>
      Promise.resolve({
        ...initialPayload,
        appState: {
          ...initialPayload.appState,
          workspaces: (initialPayload.appState.workspaces as AnyApi[]).map((w: AnyApi) =>
            w.id === saved.id ? saved : w,
          ),
        },
        workspace: desktopWorkspacePayload,
      }),
    );
    const store = useAppStore();

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();
    await store.quickAddTemplateTab("claude", "Claude Code");

    const saved = ((transport as AnyApi).saveWorkspace as AnyApi).mock.calls[0][0] as AnyApi;
    const newPanel = saved.panels.at(-1);
    // The tab was added to the phone's workspace, not the desktop's.
    expect(saved.id).toBe("ws-mine");
    expect(newPanel.command).toBe("claude");
    // The view stays on the phone's workspace...
    expect(store.activeWorkspace.id).toBe("ws-mine");
    // ...and the new tab is both visible and active.
    expect((store.workspaceTabs as AnyApi[]).map((t: AnyApi) => t.id)).toContain(`ws-mine:${newPanel.id}`);
    expect(store.activeViewId).toBe(`ws-mine:${newPanel.id}`);
  });

  it("keeps remote review tab active when Azure seen returns a desktop-scoped payload", async () => {
    const desktopWs = {
      id: "ws-desktop",
      name: "Desktop WS",
      profileId: "p1",
      panels: [{ id: "shell", title: "Shell", command: "" }],
      activePanelId: "shell",
      kind: "terminal",
      cwd: "/tmp/desktop",
    };
    const reviewWs = {
      id: "ws-review",
      name: "Review WS",
      profileId: "p1",
      panels: [{ id: "agent", title: "Agent", command: "" }],
      activePanelId: "agent",
      kind: "terminal",
      cwd: "/tmp/review",
      activeViewId: "review:ws-review",
      review: {
        provider: "azure-devops",
        prKey: "ado:repo:42",
        parentWorkspaceId: "ws-desktop",
        pullRequest: { title: "Fix flicker" },
      },
    };
    const desktopWorkspacePayload = {
      workspace: desktopWs,
      project: desktopWs,
      sessions: [{ sessionId: "ws-desktop:shell", panelId: "shell", title: "Shell", command: "", status: "idle" }],
    };
    const initialPayload = makeBasePayload({
      remoteClient: { id: "sess1", profileId: "p1", activeWorkspaceId: "ws-review", activeSessionId: "" },
      appState: {
        activeWorkspaceId: "ws-desktop",
        profiles: [{ id: "p1", name: "P1", color: "#fff", workspaceIds: [] }],
        workspaces: [desktopWs, reviewWs],
        windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "ws-desktop", activeSessionId: "" }],
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
      workspace: desktopWorkspacePayload,
    });
    const transport = makeRemoteTransport(initialPayload);
    (transport as AnyApi).markAzurePullRequestSeen = vi.fn(() =>
      Promise.resolve({
        ...initialPayload,
        workspace: desktopWorkspacePayload,
      }),
    );
    const store = useAppStore();

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();

    expect(store.activeWorkspace.id).toBe("ws-review");
    expect(store.activeViewId).toBe("review:ws-review");

    await store.markAzurePrSeen("ado:repo:42");
    await nextTick();

    expect(store.activeWorkspace.id).toBe("ws-review");
    expect(store.activeViewId).toBe("review:ws-review");
    expect(store.activeSessionId).toBeNull();
    expect((store as AnyApi).payload.workspace.workspace.id).toBe("ws-review");
  });
});

// Category D (code-review batch, 2026-07): the Git-tab-activation refreshGit
// call used to swallow a rejection with a bare `.catch(() => {})`, leaving
// stale git data on screen with no trace in the logs.
describe("useAppStore — Git tab activation surfaces a failed refreshGit", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("a rejected refreshGit logs a warning instead of failing silently", async () => {
    const payload = makeBasePayload({
      appState: {
        activeWorkspaceId: "ws1",
        profiles: [{ id: "p1", name: "P1", color: "#fff", workspaceIds: [] }],
        workspaces: [{ id: "ws1", name: "Workspace 1", profileId: "p1", panels: [], kind: "terminal", cwd: "/tmp" }],
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
    const transport = makeElectronTransport(payload);
    const logRenderer = vi.fn();
    (window as AnyApi).strideterm = { startupFlags: { windowId: "" }, logRenderer };
    (transport as AnyApi).refreshGit = vi.fn(() => Promise.reject(new Error("git backend unavailable")));
    (transport as AnyApi).setWorkspaceUIState = vi.fn(() => Promise.resolve());
    const store = useAppStore();

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();

    await store.activateView("git:ws1");
    // refreshGit's rejection isn't awaited by activateView (fire-and-forget) —
    // flush a couple of microtasks so its .catch handler runs.
    await Promise.resolve();
    await Promise.resolve();

    expect((transport as AnyApi).refreshGit).toHaveBeenCalledWith("ws1");
    const warnCalls = logRenderer.mock.calls.filter((c) => c[0] === "warn");
    expect(warnCalls.some((c) => String(c[1]).includes("refreshGit failed"))).toBe(true);
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

describe("handleBroadcastPayload — remote revision gate (bootstrap→WS handoff)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // No Electron global — the remote transport drives isRemoteTransport.
    (window as AnyApi).strideterm = undefined;
  });

  function remotePayload(coreRevision: number, appVersion: string): AnyApi {
    return makeBasePayload({
      meta: { appVersion, platform: "test", repositoryUrl: "", versionCheck: {}, recoveryCandidates: [] },
      coreRevision,
      remoteClient: { id: "c1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId: "" },
    });
  }

  it("applies only strictly-newer coreRevisions; drops stale/out-of-order snapshots", async () => {
    const initial = remotePayload(5, "v5");
    const transport = makeRemoteTransport(initial);
    const store = useAppStore();
    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();
    // Bootstrap applied revision 5.
    expect(((store as AnyApi).payload.meta as AnyApi).appVersion).toBe("v5");

    // A stale broadcast (rev 4, e.g. one that raced the bootstrap) is dropped.
    transport._push(remotePayload(4, "v4"));
    await Promise.resolve();
    expect(((store as AnyApi).payload.meta as AnyApi).appVersion).toBe("v5");

    // A broadcast at the same revision is also dropped (idempotent).
    transport._push(remotePayload(5, "v5-dupe"));
    await Promise.resolve();
    expect(((store as AnyApi).payload.meta as AnyApi).appVersion).toBe("v5");

    // A strictly-newer broadcast (rev 6) is applied.
    transport._push(remotePayload(6, "v6"));
    await Promise.resolve();
    expect(((store as AnyApi).payload.meta as AnyApi).appVersion).toBe("v6");
  });

  it("resets the baseline on disconnect so a restarted server's low revision is accepted", async () => {
    const initial = remotePayload(9, "v9");
    const transport = makeRemoteTransport(initial);
    const store = useAppStore();
    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();
    expect(((store as AnyApi).payload.meta as AnyApi).appVersion).toBe("v9");

    // Connection drops (server about to restart) → the gate baseline resets.
    transport._connectionState({ connected: false, reconnecting: true });

    // The server restarted: its coreRevision counter is back near 0. Without the
    // reset this rev-1 snapshot would be dropped as "older" and wedge the client.
    transport._push(remotePayload(1, "v-after-restart"));
    await Promise.resolve();
    expect(((store as AnyApi).payload.meta as AnyApi).appVersion).toBe("v-after-restart");
  });
});

// Pins the consolidated fallback order (code review 2026-07 §5.4): app.ts's
// resolveRemoteProfileId + myActiveProfileId pairing was picked as the
// authoritative implementation over 3 divergent copies previously living in
// app-dialog-actions.ts (x2) and app-api-actions.ts. All 4 call sites now
// delegate here — this is the ONE place that fallback order is decided.
describe("resolveViewerProfileId — pinned fallback order", () => {
  function payload(overrides: AnyApi = {}): AnyApi {
    return {
      appState: {
        profiles: [{ id: "profile-a" }, { id: "profile-b" }],
        windowSlots: [{ id: "win-a", profileId: "profile-a" }],
      },
      ...overrides,
    };
  }

  describe("desktop (isRemote: false)", () => {
    it("returns this window's slot profileId when the slot exists", () => {
      const p = payload();
      expect(resolveViewerProfileId(p, { isRemote: false, windowId: "win-a" })).toBe("profile-a");
    });

    it("returns null (no profiles[0]/'default' fallback) when this window has no matching slot", () => {
      // Every open window always has its own slot in real usage; this is the
      // hyper-edge-case tail of the fallback chain. app.ts's version stops
      // here rather than guessing profiles[0] like the old dialog-actions
      // copy did — callers that need a non-null value apply their own
      // `|| "default"` at the point of use (see currentProfileId()).
      const p = payload();
      expect(resolveViewerProfileId(p, { isRemote: false, windowId: "win-missing" })).toBeNull();
    });

    it("returns null when no windowId is available at all", () => {
      const p = payload();
      expect(resolveViewerProfileId(p, { isRemote: false, windowId: "" })).toBeNull();
    });

    it("returns null when the matching slot has no profileId", () => {
      const p = payload({
        appState: {
          profiles: [{ id: "profile-a" }],
          windowSlots: [{ id: "win-a" }],
        },
      });
      expect(resolveViewerProfileId(p, { isRemote: false, windowId: "win-a" })).toBeNull();
    });
  });

  describe("remote (isRemote: true)", () => {
    it("returns remoteClient.profileId when it names a real profile", () => {
      const p = payload({ remoteClient: { profileId: "profile-b" } });
      expect(resolveViewerProfileId(p, { isRemote: true, windowId: "" })).toBe("profile-b");
    });

    it("falls back past a stale remoteClient.profileId (deleted profile) to a slot with a valid profile", () => {
      const p = payload({
        appState: {
          profiles: [{ id: "profile-a" }, { id: "profile-b" }],
          windowSlots: [{ id: "win-a", profileId: "profile-a" }],
        },
        remoteClient: { profileId: "profile-deleted" },
      });
      expect(resolveViewerProfileId(p, { isRemote: true, windowId: "" })).toBe("profile-a");
    });

    it("skips a slot whose profileId no longer names a real profile, preferring one that does", () => {
      const p = payload({
        appState: {
          profiles: [{ id: "profile-b" }],
          windowSlots: [
            { id: "win-a", profileId: "profile-deleted" },
            { id: "win-b", profileId: "profile-b" },
          ],
        },
      });
      expect(resolveViewerProfileId(p, { isRemote: true, windowId: "" })).toBe("profile-b");
    });

    it("falls back to the first (id-bearing) profile when no slot names a valid profile", () => {
      const p = payload({
        appState: {
          profiles: [{ id: "profile-a" }, { id: "profile-b" }],
          windowSlots: [{ id: "win-a", profileId: "profile-deleted" }],
        },
      });
      expect(resolveViewerProfileId(p, { isRemote: true, windowId: "" })).toBe("profile-a");
    });

    it("filters out malformed profile entries (no id) before taking the profiles[0] fallback", () => {
      // This is the concrete difference vs. the 3 non-authoritative copies:
      // they used the raw (unfiltered) profiles array for their own
      // `profiles[0]?.id` fallback, so a malformed leading entry would have
      // resolved to undefined instead of skipping to the next real profile.
      const p = payload({
        appState: {
          profiles: [{ name: "malformed, no id" }, { id: "profile-b" }],
          windowSlots: [],
        },
      });
      expect(resolveViewerProfileId(p, { isRemote: true, windowId: "" })).toBe("profile-b");
    });

    it("returns null when there is truly no profile information available", () => {
      const p = payload({ appState: { profiles: [], windowSlots: [] } });
      expect(resolveViewerProfileId(p, { isRemote: true, windowId: "" })).toBeNull();
    });
  });
});

// The sidebar's "recent" view buckets workspaces by `lastUsedAt`, which the
// backend stamps on every activation. `filteredWorkspaces` memoizes its result
// behind a per-workspace fingerprint — if that fingerprint omits `lastUsedAt`,
// a freshly activated workspace keeps the pre-activation object and stays
// stuck in the "Older" section for the rest of the session.
describe("useAppStore — filteredWorkspaces reflects a lastUsedAt stamp", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
  });

  it("a broadcast that only changes lastUsedAt invalidates the memo", async () => {
    const initial = makeBasePayload();
    const transport = makeElectronTransport(initial);
    const store = useAppStore();

    store.init(transport as AnyApi);
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();

    // Prime the memo.
    expect(store.filteredWorkspaces.map((ws: AnyApi) => ws.id)).toEqual(["ws1", "ws2"]);
    expect(store.filteredWorkspaces[0].lastUsedAt).toBeUndefined();

    const stampedAt = "2026-08-27T09:06:53.965Z";
    const next = makeBasePayload();
    next.appState.workspaces[0] = { ...next.appState.workspaces[0], lastUsedAt: stampedAt };
    (transport as AnyApi)._push(next);
    await nextTick();

    expect(store.filteredWorkspaces[0].lastUsedAt).toBe(stampedAt);
  });
});

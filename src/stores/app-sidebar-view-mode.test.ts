import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAppStore } from "./app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makeBasePayload(overrides: AnyApi = {}): AnyApi {
  return {
    meta: { appVersion: "0.0.0", platform: "test", repositoryUrl: "", versionCheck: {}, recoveryCandidates: [] },
    appState: {
      activeWorkspaceId: "",
      profiles: [
        { id: "p1", name: "P1", color: "#fff", workspaceIds: [], sidebarWorkspaceViewMode: "tree" },
        { id: "p2", name: "P2", color: "#fff", workspaceIds: [], sidebarWorkspaceViewMode: "recent" },
      ],
      workspaces: [],
      windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "", activeSessionId: "" }],
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

function makeTransport(initialPayload: AnyApi, isRemote = false) {
  let stateHandler: ((payload: AnyApi) => void) | null = null;
  return {
    isRemote,
    getState: vi.fn(() => Promise.resolve(initialPayload)),
    onStateUpdated: (fn: (payload: AnyApi) => void) => {
      stateHandler = fn;
    },
    onConnectionState: vi.fn(),
    activateWorkspace: vi.fn(() => Promise.resolve(initialPayload)),
    activateProfile: vi.fn(() => Promise.resolve(initialPayload)),
    activateSession: vi.fn(() => Promise.resolve(initialPayload)),
    saveProfile: vi.fn(),
    _push: (p: AnyApi) => stateHandler?.(p),
  };
}

async function initStore(transport: AnyApi): Promise<AnyApi> {
  const store = useAppStore();
  store.init(transport);
  await Promise.resolve();
  await Promise.resolve();
  return store;
}

describe("useAppStore — saveSidebarWorkspaceViewMode", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
  });

  it("saves a copy of the active profile with the new mode via transport.saveProfile", async () => {
    const payload = makeBasePayload();
    const transport = makeTransport(payload);
    transport.saveProfile.mockResolvedValue(
      makeBasePayload({
        appState: {
          ...payload.appState,
          profiles: [
            { ...payload.appState.profiles[0], sidebarWorkspaceViewMode: "recent" },
            payload.appState.profiles[1],
          ],
        },
      }),
    );
    const store = await initStore(transport);

    await store.saveSidebarWorkspaceViewMode("recent");

    expect(transport.saveProfile).toHaveBeenCalledTimes(1);
    expect(transport.saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1", name: "P1", sidebarWorkspaceViewMode: "recent" }),
    );
    // p2 (not the active profile) is never touched by this call.
    expect(transport.saveProfile.mock.calls[0][0].id).not.toBe("p2");
    expect(store.activeProfile.sidebarWorkspaceViewMode).toBe("recent");
  });

  it("switching profile restores that profile's own saved mode", async () => {
    const payload = makeBasePayload();
    const transport = makeTransport(payload);
    const store = await initStore(transport);

    expect(store.activeProfile.sidebarWorkspaceViewMode).toBe("tree");

    const afterSwitch = makeBasePayload({
      appState: {
        ...payload.appState,
        windowSlots: [{ id: "slot1", profileId: "p2", activeWorkspaceId: "", activeSessionId: "" }],
      },
    });
    transport.activateProfile.mockResolvedValue(afterSwitch);

    await store.activateProfile("p2");

    expect(store.activeProfile.sidebarWorkspaceViewMode).toBe("recent");
  });

  it("a failed save leaves the previous mode in place and rejects", async () => {
    const payload = makeBasePayload();
    const transport = makeTransport(payload);
    transport.saveProfile.mockRejectedValue(new Error("save failed"));
    const store = await initStore(transport);

    await expect(store.saveSidebarWorkspaceViewMode("recent")).rejects.toThrow("save failed");
    expect(store.activeProfile.sidebarWorkspaceViewMode).toBe("tree");
  });

  it("desktop and remote transports go through the same saveProfile call shape", async () => {
    const desktopPayload = makeBasePayload();
    const desktopTransport = makeTransport(desktopPayload, false);
    desktopTransport.saveProfile.mockResolvedValue(desktopPayload);
    const desktopStore = await initStore(desktopTransport);
    await desktopStore.saveSidebarWorkspaceViewMode("recent");

    setActivePinia(createPinia());
    const remotePayload = makeBasePayload();
    (remotePayload as AnyApi).remoteClient = { id: "r1", profileId: "p1", activeWorkspaceId: "", activeSessionId: "" };
    const remoteTransport = makeTransport(remotePayload, true);
    remoteTransport.saveProfile.mockResolvedValue(remotePayload);
    const remoteStore = await initStore(remoteTransport);
    await remoteStore.saveSidebarWorkspaceViewMode("recent");

    expect(desktopTransport.saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1", sidebarWorkspaceViewMode: "recent" }),
    );
    expect(remoteTransport.saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1", sidebarWorkspaceViewMode: "recent" }),
    );
  });
});

describe("useAppStore — sidebar view mode in a mobile session", () => {
  const KEY = "strideterm:sidebarWorkspaceViewMode:p1";

  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
    window.localStorage.clear();
    (window as AnyApi).StridetermHost = { postMessage: vi.fn() };
  });

  afterEach(() => {
    delete (window as AnyApi).StridetermHost;
    vi.restoreAllMocks();
  });

  async function mobileStore() {
    const payload = makeBasePayload();
    (payload as AnyApi).remoteClient = { id: "r1", profileId: "p1", activeWorkspaceId: "", activeSessionId: "" };
    const transport = makeTransport(payload, true);
    return { transport, store: await initStore(transport) };
  }

  it("stores the mode locally without calling saveProfile", async () => {
    const { transport, store } = await mobileStore();
    expect(store.sidebarWorkspaceViewMode).toBe("tree");

    await store.saveSidebarWorkspaceViewMode("recent");

    expect(transport.saveProfile).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(KEY)).toBe("recent");
    expect(store.sidebarWorkspaceViewMode).toBe("recent");
  });

  it("survives a reload of the store", async () => {
    const first = await mobileStore();
    await first.store.saveSidebarWorkspaceViewMode("recent");

    setActivePinia(createPinia());
    const second = await mobileStore();
    expect(second.store.sidebarWorkspaceViewMode).toBe("recent");
  });

  it("falls back to the profile value when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { transport, store } = await mobileStore();
    expect(store.sidebarWorkspaceViewMode).toBe("tree");

    await expect(store.saveSidebarWorkspaceViewMode("recent")).resolves.toBeUndefined();

    expect(transport.saveProfile).not.toHaveBeenCalled();
    expect(store.sidebarWorkspaceViewMode).toBe("recent");
  });

  it("a non-mobile remote session still saves the profile and ignores local storage", async () => {
    delete (window as AnyApi).StridetermHost;
    window.localStorage.setItem(KEY, "recent");
    const payload = makeBasePayload();
    (payload as AnyApi).remoteClient = { id: "r1", profileId: "p1", activeWorkspaceId: "", activeSessionId: "" };
    const transport = makeTransport(payload, true);
    transport.saveProfile.mockResolvedValue(payload);
    const store = await initStore(transport);

    expect(store.sidebarWorkspaceViewMode).toBe("tree");
    await store.saveSidebarWorkspaceViewMode("recent");
    expect(transport.saveProfile).toHaveBeenCalledTimes(1);
  });
});

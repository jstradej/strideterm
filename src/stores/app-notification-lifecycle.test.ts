import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAppStore } from "./app.js";
import { useNotificationStore } from "./notifications.js";
import { buildRemoteCore } from "../../electron/backend/remote-core.js";
import { fireNotificationAlert } from "../composables/useNotificationSound.js";
import {
  azureClosedPrCleanupFinishedSchema,
  type AzureClosedPrCleanupFinished,
} from "../../electron/shared/azure-closed-pr-cleanup-events.js";

// The OS popup / ding a Notification Center arrival fires — observed, not played.
vi.mock("../composables/useNotificationSound.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../composables/useNotificationSound.js")>()),
  fireNotificationAlert: vi.fn(),
}));

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
  let cleanupFinishedHandler: ((event: AzureClosedPrCleanupFinished) => void) | null = null;
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
    onAzureClosedPrCleanupFinished: (fn: (event: AzureClosedPrCleanupFinished) => void) => {
      cleanupFinishedHandler = fn;
    },
    activateWorkspace: vi.fn(() => Promise.resolve(initialPayload)),
    activateProfile: vi.fn(() => Promise.resolve(initialPayload)),
    activateSession: vi.fn(() => Promise.resolve(initialPayload)),
    _push: (p: AnyApi) => stateHandler?.(p),
    _removed: (event: AnyApi) => removalHandler?.(event),
    _hasRemovalHandler: () => removalHandler !== null,
    // What both transports hand a handler: the event after the schema parse.
    _cleanupFinished: (event: unknown) => cleanupFinishedHandler?.(azureClosedPrCleanupFinishedSchema.parse(event)),
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

describe("app store — background Azure closed PR cleanup in the Notification Center", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
    vi.mocked(fireNotificationAlert).mockClear();
  });

  // Shapes: `azureClosedPrCleanup` is the field runtime.ts getPayload()
  // broadcasts, and each run is what cleanupAzureClosedPullRequests emits on
  // `azure:closed-pr-cleanup:finished` and keeps in `lastRuns` — held to the
  // schema both transports validate with. Skip/error texts are the runtime's.
  // An Azure parent in each profile.
  function azurePayload(running: string[], lastRuns: unknown[] = []): AnyApi {
    const payload = makePayload(["azure-root"], {
      azureClosedPrCleanup: { parentWorkspaceIds: running, lastRuns },
    });
    payload.appState.workspaces[0].kind = "azure";
    payload.appState.workspaces[0].name = "Azure DevOps";
    payload.appState.workspaces.push({
      id: "azure-p2",
      name: "Azure DevOps",
      profileId: "p2",
      panels: [],
      kind: "azure",
      cwd: "/tmp",
    });
    return payload;
  }

  function run(fields: AnyApi): AzureClosedPrCleanupFinished {
    return azureClosedPrCleanupFinishedSchema.parse({
      runId: "run-1",
      parentWorkspaceId: "azure-root",
      profileId: "p1",
      finishedAt: "2026-10-14T10:00:00.000Z",
      ...fields,
    });
  }

  const succeeded = run({
    result: {
      deleted: 2,
      skipped: [
        { workspaceId: "pr-1", name: "PR 1", reason: "PR is still active." },
        { workspaceId: "pr-2", name: "PR 2", reason: "Checkout has uncommitted changes." },
      ],
      errors: [],
    },
  });

  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function cleanupEntries(notifications: ReturnType<typeof useNotificationStore>) {
    return notifications.sessions
      .filter((s) => s.category === "azure-cleanup")
      .flatMap((s) => s.events.map((e) => ({ ...e, workspaceId: s.workspaceId, meta: s.meta })));
  }

  it("desktop: the spinner follows the payload; the finished event becomes a normal entry with its toast and alert", async () => {
    const transport = makeTransport(azurePayload([]));
    const store = useAppStore();
    const notifications = useNotificationStore();
    store.init(transport as AnyApi);
    await settle();
    expect(store.isAzureClosedPrCleanupBusy("azure-root")).toBe(false);

    // Started elsewhere (a phone): this window learns it only from the broadcast.
    transport._push(azurePayload(["azure-root"]));
    await settle();
    expect(store.isAzureClosedPrCleanupBusy("azure-root")).toBe(true);

    transport._cleanupFinished(succeeded);
    transport._push(azurePayload([], [succeeded]));
    await settle();

    expect(store.isAzureClosedPrCleanupBusy("azure-root")).toBe(false);
    const body = "Deleted 2 closed PR workspaces.\nSkipped 2 workspaces: 1 active PRs, 1 checkouts with local work.";
    // Live event + the same run in the payload: one entry.
    expect(cleanupEntries(notifications)).toEqual([
      expect.objectContaining({
        title: "Closed PR cleanup finished",
        body,
        kind: "completed",
        urgency: "normal",
        at: succeeded.finishedAt,
        sourceAlertId: "azure-closed-pr-cleanup:run-1",
        workspaceId: "azure-root",
        meta: { profileId: "p1", runId: "run-1" },
      }),
    ]);
    expect(notifications.latestToast).toMatchObject({ title: "Closed PR cleanup finished", body });
    expect(notifications.persistentToasts).toEqual([]);
    expect(fireNotificationAlert).toHaveBeenCalledTimes(1);
    expect(fireNotificationAlert).toHaveBeenCalledWith("Closed PR cleanup finished", body, {
      tier: 2,
      urgency: "normal",
      sessionKey: "azure-closed-pr-cleanup:azure-root",
      dedupeKey: "azure-closed-pr-cleanup:run-1",
    });
  });

  it("per-PR errors are an urgent entry carrying the details", async () => {
    const transport = makeTransport(azurePayload([]));
    const store = useAppStore();
    const notifications = useNotificationStore();
    store.init(transport as AnyApi);
    await settle();

    transport._cleanupFinished(
      run({
        result: {
          deleted: 0,
          skipped: [],
          errors: [{ workspaceId: "pr-3", name: "PR 3", error: "Could not verify PR status: Azure unavailable" }],
        },
      }),
    );

    expect(cleanupEntries(notifications)).toEqual([
      expect.objectContaining({
        title: "Closed PR cleanup finished with errors",
        body: "Deleted 0 closed PR workspaces.\nSkipped 0 workspaces.\nErrors (1):\n• PR 3: Could not verify PR status: Azure unavailable",
        kind: "error",
        urgency: "urgent",
      }),
    ]);
    expect(fireNotificationAlert).toHaveBeenCalledWith(
      "Closed PR cleanup finished with errors",
      expect.any(String),
      expect.objectContaining({ urgency: "urgent" }),
    );
  });

  it("an unexpected failure is an urgent entry that says what is left behind", async () => {
    const transport = makeTransport(azurePayload([]));
    const store = useAppStore();
    const notifications = useNotificationStore();
    store.init(transport as AnyApi);
    await settle();

    transport._cleanupFinished(run({ error: "malformed PR status" }));

    expect(cleanupEntries(notifications)).toEqual([
      expect.objectContaining({
        title: "Closed PR cleanup stopped unexpectedly",
        body: "malformed PR status\nWorkspaces deleted before it stopped stay deleted; run the cleanup again to process the rest.",
        kind: "error",
        urgency: "urgent",
      }),
    ]);
  });

  it("a client that missed the event gets exactly one entry from the payload, and a reload adds none", async () => {
    const transport = makeTransport(azurePayload([], [succeeded]));
    const store = useAppStore();
    const notifications = useNotificationStore();
    store.init(transport as AnyApi);
    await settle();
    transport._push(azurePayload([], [succeeded]));
    await settle();

    expect(cleanupEntries(notifications)).toHaveLength(1);
    expect(fireNotificationAlert).toHaveBeenCalledTimes(1);

    // A reload: a fresh renderer over the same persisted history and the same payload.
    vi.mocked(fireNotificationAlert).mockClear();
    setActivePinia(createPinia());
    const reloaded = useAppStore();
    const reloadedNotifications = useNotificationStore();
    reloaded.init(makeTransport(azurePayload([], [succeeded])) as AnyApi);
    await settle();

    expect(cleanupEntries(reloadedNotifications)).toHaveLength(1);
    expect(fireNotificationAlert).not.toHaveBeenCalled();
  });

  /** A reload, a new window or a reloaded phone page: a fresh renderer over this client's storage. */
  async function reloadWith(payload: AnyApi) {
    setActivePinia(createPinia());
    const store = useAppStore();
    const notifications = useNotificationStore();
    store.init(makeTransport(payload) as AnyApi);
    await settle();
    return { store, notifications };
  }

  // The desktop keeps the last run in the payload until it restarts, so every
  // later page load is handed the same run again.
  it("a run whose entry the user removed does not come back after a reload", async () => {
    const transport = makeTransport(azurePayload(["azure-root"]));
    const store = useAppStore();
    const notifications = useNotificationStore();
    store.init(transport as AnyApi);
    await settle();
    transport._cleanupFinished(succeeded);
    transport._push(azurePayload([], [succeeded]));
    await settle();
    const [session] = notifications.sessions.filter((s) => s.category === "azure-cleanup");
    notifications.remove(session.id);
    expect(cleanupEntries(notifications)).toEqual([]);

    vi.mocked(fireNotificationAlert).mockClear();
    const reloaded = await reloadWith(azurePayload([], [succeeded]));

    expect(cleanupEntries(reloaded.notifications)).toEqual([]);
    expect(reloaded.notifications.latestToast).toBeNull();
    expect(fireNotificationAlert).not.toHaveBeenCalled();
  });

  it("a run delivered late and then cleared with Clear all does not come back after a reload", async () => {
    const { notifications } = await reloadWith(azurePayload([], [succeeded]));
    expect(cleanupEntries(notifications)).toHaveLength(1);
    notifications.clearAll();
    expect(cleanupEntries(notifications)).toEqual([]);

    vi.mocked(fireNotificationAlert).mockClear();
    const reloaded = await reloadWith(azurePayload([], [succeeded]));

    expect(cleanupEntries(reloaded.notifications)).toEqual([]);
    expect(fireNotificationAlert).not.toHaveBeenCalled();
  });

  it("without usable storage a renderer still reports each run once", async () => {
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    const key = "strideterm-azure-closed-pr-cleanup-notified-runs";
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, name) {
      if (name === key) throw new Error("storage disabled");
      return originalGet.call(this, name);
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name, value) {
      if (name === key) throw new Error("storage disabled");
      originalSet.call(this, name, value);
    });
    try {
      const transport = makeTransport(azurePayload([], [succeeded]));
      const store = useAppStore();
      const notifications = useNotificationStore();
      store.init(transport as AnyApi);
      await settle();
      transport._cleanupFinished(succeeded);
      transport._push(azurePayload([], [succeeded]));
      await settle();

      expect(cleanupEntries(notifications)).toHaveLength(1);
      expect(fireNotificationAlert).toHaveBeenCalledTimes(1);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it("remote: the core built for the client's profile drives the spinner and the entries; another profile's run never shows", async () => {
    const otherProfileRun = run({ runId: "run-p2", parentWorkspaceId: "azure-p2", profileId: "p2", error: "boom" });
    // Exactly what remote-server.ts sends a protocol-2 client bound to p1.
    const coreFor = (running: string[], lastRuns: unknown[], coreRevision: number) =>
      buildRemoteCore(
        {
          ...azurePayload(running, lastRuns),
          remoteClient: { id: "c1", profileId: "p1", activeWorkspaceId: "azure-root", activeSessionId: "" },
        },
        { coreRevision },
      );
    const transport = makeTransport(coreFor([], [], 1), { isRemote: true });
    const store = useAppStore();
    const notifications = useNotificationStore();
    store.init(transport as AnyApi);
    await settle();

    transport._push(coreFor(["azure-root", "azure-p2"], [otherProfileRun], 2));
    await settle();
    expect(store.isAzureClosedPrCleanupBusy("azure-root")).toBe(true);
    expect(store.isAzureClosedPrCleanupBusy("azure-p2")).toBe(false);
    transport._cleanupFinished(otherProfileRun);
    expect(cleanupEntries(notifications)).toEqual([]);

    transport._push(coreFor([], [succeeded, otherProfileRun], 3));
    await settle();
    expect(cleanupEntries(notifications).map((entry) => entry.sourceAlertId)).toEqual([
      "azure-closed-pr-cleanup:run-1",
    ]);
  });
});

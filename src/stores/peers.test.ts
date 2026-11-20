import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { parsePeerAddress, peersBridgeAvailable, usePeersStore } from "./peers.js";
import { useNotificationStore } from "./notifications.js";
import {
  PEER_DEFAULT_PORT,
  peerConnectSchema,
  type PeerAttachedHost,
  type PeerPairingResult,
} from "../../electron/shared/peers.js";

const HOST_ID = "host-0001";

function makeHost(overrides: Partial<PeerAttachedHost> = {}): PeerAttachedHost {
  return {
    id: HOST_ID,
    label: "Office",
    address: "192.168.1.5",
    port: PEER_DEFAULT_PORT,
    hostPublicKey: "k",
    pairedAt: 1,
    state: "online",
    hostAppVersion: "1.0.0",
    localAppVersion: "1.0.0",
    profiles: [{ id: "default", name: "Default", color: "#fff", workspaceCount: 2 }],
    checkedAt: 1,
    ...overrides,
  };
}

type Handler<T> = (payload: T) => void;

function installBridge(overrides: Record<string, unknown> = {}) {
  const updated: Handler<unknown>[] = [];
  const results: Handler<PeerPairingResult>[] = [];
  const offUpdated = vi.fn();
  const offResult = vi.fn();
  const bridge = {
    listPeerHosts: vi.fn().mockResolvedValue([makeHost()]),
    refreshPeerHost: vi.fn().mockResolvedValue(makeHost({ state: "offline" })),
    startPeerPairing: vi.fn().mockResolvedValue({
      attemptId: "attempt-0001",
      code: "1234 5678",
      hostId: HOST_ID,
      hostName: "Office",
      hostAppVersion: "1.0.0",
    }),
    cancelPeerPairing: vi.fn().mockResolvedValue(undefined),
    removePeerHost: vi.fn().mockResolvedValue(true),
    updatePeerHostAddress: vi.fn().mockResolvedValue(true),
    openPeerWindow: vi.fn().mockResolvedValue({ windowId: "w" }),
    activatePeerProfile: vi.fn().mockResolvedValue({ reloaded: true }),
    activateLocalProfile: vi.fn().mockResolvedValue({ reloaded: true }),
    getLocalProfilesOverview: vi
      .fn()
      .mockResolvedValue([{ id: "default", name: "Default", color: "#fff", workspaceCount: 1, openWindows: 0 }]),
    onPeersUpdated: vi.fn((handler: Handler<unknown>) => {
      updated.push(handler);
      return offUpdated;
    }),
    onPeerPairingResult: vi.fn((handler: Handler<PeerPairingResult>) => {
      results.push(handler);
      return offResult;
    }),
    ...overrides,
  };
  (window as unknown as { strideterm: unknown }).strideterm = bridge;
  return { bridge, updated, results, offUpdated, offResult };
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
});

afterEach(() => {
  delete (window as unknown as { strideterm?: unknown }).strideterm;
});

describe("peers store", () => {
  test("is unavailable without the desktop bridge and does nothing", async () => {
    const store = usePeersStore();
    expect(store.available).toBe(false);
    expect(peersBridgeAvailable()).toBe(false);
    await store.open();
    expect(store.hosts).toEqual([]);
    expect(await store.refresh(HOST_ID, true)).toBe(false);
    expect(await store.removeHost(HOST_ID)).toBe(false);
    expect(store.watch()).toBeTypeOf("function");
  });

  test("load fills the hosts and open refreshes each host once, not forced", async () => {
    const { bridge } = installBridge();
    const store = usePeersStore();
    await store.open();
    expect(store.available).toBe(true);
    expect(store.hosts.map((host) => host.id)).toEqual([HOST_ID]);
    expect(bridge.refreshPeerHost).toHaveBeenCalledTimes(1);
    expect(bridge.refreshPeerHost).toHaveBeenCalledWith(HOST_ID, {});
    expect(store.hosts[0].state).toBe("offline");
  });

  test("refresh with force sends force: true", async () => {
    const { bridge } = installBridge();
    const store = usePeersStore();
    await store.load();
    await store.refresh(HOST_ID, true);
    expect(bridge.refreshPeerHost).toHaveBeenCalledWith(HOST_ID, { force: true });
  });

  test("a failed load raises an error toast", async () => {
    installBridge({ listPeerHosts: vi.fn().mockRejectedValue(new Error("boom")) });
    const store = usePeersStore();
    const notifications = useNotificationStore();
    const showError = vi.spyOn(notifications, "showError");
    await store.load();
    expect(showError).toHaveBeenCalledWith("Could not load attached desktops", expect.any(Error));
    expect(store.loadError).toBe("boom");
  });

  test("watch subscribes once for any number of watchers and tears down with the last one", async () => {
    const { bridge, updated, offUpdated } = installBridge();
    const store = usePeersStore();
    const releaseA = store.watch();
    const releaseB = store.watch();
    expect(bridge.onPeersUpdated).toHaveBeenCalledTimes(1);
    updated[0]({});
    await vi.waitFor(() => expect(bridge.listPeerHosts).toHaveBeenCalledTimes(1));
    releaseA();
    releaseA();
    expect(offUpdated).not.toHaveBeenCalled();
    releaseB();
    expect(offUpdated).toHaveBeenCalledTimes(1);
  });

  test("collapsed state persists and survives a throwing localStorage", () => {
    installBridge();
    const store = usePeersStore();
    store.setCollapsed(HOST_ID, true);
    expect(JSON.parse(window.localStorage.getItem("strideterm-peer-host-collapsed") || "{}")).toEqual({
      [HOST_ID]: true,
    });
    setActivePinia(createPinia());
    expect(usePeersStore().isCollapsed(HOST_ID)).toBe(true);

    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    setActivePinia(createPinia());
    const blocked = usePeersStore();
    expect(blocked.isCollapsed(HOST_ID)).toBe(false);
    expect(() => blocked.setCollapsed(HOST_ID, true)).not.toThrow();
    expect(blocked.isCollapsed(HOST_ID)).toBe(true);
    getItem.mockRestore();
    setItem.mockRestore();
  });

  test("removeHost clears the collapsed flag and reloads", async () => {
    const { bridge } = installBridge();
    const store = usePeersStore();
    store.setCollapsed(HOST_ID, true);
    expect(await store.removeHost(HOST_ID)).toBe(true);
    expect(bridge.removePeerHost).toHaveBeenCalledWith(HOST_ID);
    expect(store.isCollapsed(HOST_ID)).toBe(false);
    expect(bridge.listPeerHosts).toHaveBeenCalled();
  });

  test("an action that fails raises an error toast and reports false", async () => {
    installBridge({ removePeerHost: vi.fn().mockRejectedValue(new Error("nope")) });
    const store = usePeersStore();
    const runWithToast = vi.spyOn(useNotificationStore(), "runWithToast");
    expect(await store.removeHost(HOST_ID)).toBe(false);
    expect(runWithToast).toHaveBeenCalledWith("Could not disconnect the desktop", expect.any(Function));
    expect(useNotificationStore().sessions.length).toBeGreaterThan(0);
  });

  test("activateProfile returns the main process result, null when it refused", async () => {
    const { bridge } = installBridge();
    const store = usePeersStore();
    expect(await store.activateProfile(HOST_ID, "p1")).toEqual({ reloaded: true });
    expect(bridge.activatePeerProfile).toHaveBeenCalledWith({ hostId: HOST_ID, profileId: "p1" });
    bridge.activatePeerProfile.mockRejectedValueOnce(new Error("offline"));
    expect(await store.activateProfile(HOST_ID, "p1")).toBeNull();
  });

  test("pairing: starts with exactly address and port, then settles on the result of its own attempt", async () => {
    const { bridge, results, offResult } = installBridge();
    const store = usePeersStore();
    await store.startPairing("office.local", 43124);
    expect(bridge.startPeerPairing).toHaveBeenCalledWith({ address: "office.local", port: 43124 });
    expect(store.pairing?.started.code).toBe("1234 5678");

    results[0]({ attemptId: "other-attempt", state: "rejected" });
    expect(store.pairing?.end).toBeNull();

    results[0]({ attemptId: "attempt-0001", state: "approved", hostId: HOST_ID });
    expect(store.pairing?.end?.state).toBe("approved");
    expect(offResult).toHaveBeenCalled();
    expect(store.isCollapsed(HOST_ID)).toBe(false);
  });

  test("pairing: a result that arrives before the start call returns is not lost", async () => {
    let resolveStart: (value: unknown) => void = () => {};
    const { results } = installBridge({
      startPeerPairing: vi.fn(() => new Promise((resolve) => (resolveStart = resolve))),
    });
    const store = usePeersStore();
    const started = store.startPairing("office.local", 43124);
    results[0]({ attemptId: "attempt-0001", state: "failed", error: "boom" });
    resolveStart({ attemptId: "attempt-0001", code: "1", hostId: HOST_ID, hostName: "Office", hostAppVersion: "1" });
    await started;
    expect(store.pairing?.end).toEqual({ attemptId: "attempt-0001", state: "failed", error: "boom" });
  });

  test("pairing: a start that is refused rethrows for the dialog and leaves no attempt", async () => {
    const { offResult } = installBridge({ startPeerPairing: vi.fn().mockRejectedValue(new Error("not reachable")) });
    const store = usePeersStore();
    await expect(store.startPairing("office.local", 43124)).rejects.toThrow("not reachable");
    expect(store.pairing).toBeNull();
    expect(store.starting).toBe(false);
    expect(offResult).toHaveBeenCalled();
  });

  test("resetPairing cancels a waiting attempt but not a finished one", async () => {
    const { bridge, results } = installBridge();
    const store = usePeersStore();
    await store.startPairing("office.local", 43124);
    await store.resetPairing();
    expect(bridge.cancelPeerPairing).toHaveBeenCalledWith("attempt-0001");
    expect(store.pairing).toBeNull();

    await store.startPairing("office.local", 43124);
    results[1]({ attemptId: "attempt-0001", state: "expired" });
    await store.resetPairing();
    expect(bridge.cancelPeerPairing).toHaveBeenCalledTimes(1);
  });
});

describe("parsePeerAddress", () => {
  test("accepts what peerConnectSchema accepts and sends exactly address and port", () => {
    const result = parsePeerAddress(" office.local ", "43124");
    expect(result).toEqual({ ok: true, value: { address: "office.local", port: 43124 } });
    expect(peerConnectSchema.safeParse((result as { value: unknown }).value).success).toBe(true);
  });

  test("names the field that is wrong", () => {
    expect(parsePeerAddress("", "43124")).toEqual({ ok: false, error: "Enter a host name or an IP address." });
    expect(parsePeerAddress("bad host", "43124")).toMatchObject({ ok: false });
    expect(parsePeerAddress("office", "0")).toEqual({ ok: false, error: "Enter a port between 1 and 65535." });
    expect(parsePeerAddress("office", "70000")).toEqual({ ok: false, error: "Enter a port between 1 and 65535." });
    expect(parsePeerAddress("office", "abc")).toEqual({ ok: false, error: "Enter a port between 1 and 65535." });
  });
});

describe("peers store — busy flags", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    delete (window as unknown as { strideterm?: unknown }).strideterm;
  });

  test.each([["resolves"], ["rejects"]])(
    "a host is checking from the call until it %s, even with two overlapping",
    async (how) => {
      let first!: { resolve: (_value: unknown) => void; reject: (_reason: unknown) => void };
      const calls: Array<Promise<unknown>> = [];
      installBridge({
        refreshPeerHost: vi.fn(() => {
          const promise = new Promise((resolve, reject) => {
            if (!calls.length) first = { resolve, reject };
            else resolve(makeHost());
          });
          calls.push(promise);
          return promise;
        }),
      });
      const store = usePeersStore();
      store.hosts = [makeHost()];
      const one = store.refresh(HOST_ID);
      const two = store.refresh(HOST_ID, true);
      expect(store.checking[HOST_ID]).toBe(2);
      await two;
      expect(store.checking[HOST_ID]).toBe(1);

      if (how === "resolves") first.resolve(makeHost());
      else first.reject(new Error("asleep"));
      await one;
      expect(store.checking[HOST_ID]).toBeUndefined();
      if (how === "rejects") expect(useNotificationStore().sessions.length).toBeGreaterThan(0);
    },
  );

  test.each([["resolves"], ["rejects"]])("local profiles are loading until the call %s", async (how) => {
    let resolve!: (_value: unknown) => void;
    let reject!: (_reason: unknown) => void;
    installBridge({
      getLocalProfilesOverview: vi.fn().mockReturnValue(
        new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        }),
      ),
    });
    const store = usePeersStore();
    const loading = store.loadLocalProfiles();
    expect(store.localProfilesLoading).toBe(true);
    if (how === "resolves") resolve([]);
    else reject(new Error("ipc closed"));
    await loading;
    expect(store.localProfilesLoading).toBe(false);
    if (how === "rejects") expect(useNotificationStore().sessions.length).toBeGreaterThan(0);
  });
});

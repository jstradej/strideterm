import { afterEach, describe, expect, test } from "vitest";
import { defaultPeerSettings, type PeerHello, type PeerIntegrationSettings } from "../shared/peers.js";
import type { AppState } from "../shared/types/state.js";
import type { RemoteClientRegistry } from "./remote-client-registry.js";
import { startRemoteServer } from "./remote-server.js";
import { createPeerHost } from "./peers/peer-host.js";
import { createRuntimePeers, peerWindowClientId } from "./runtime-peers.js";

// A real host (peer listener + remote server) and the device side of the runtime. What the "window" sends is
// whatever a renderer could put in the request; the host must only ever see the id derived from the window.

const FORGED = "forged-client-0000";

function makeHostRuntime() {
  const payload = {
    appState: {
      settings: { remoteAccess: { enabled: false, host: "127.0.0.1", port: 1, token: "never-valid-here" } },
      profiles: [
        { id: "home", name: "Home", color: "#fff", workspaceIds: ["ws-home"] },
        { id: "work", name: "Work", color: "#000", workspaceIds: ["ws-work"] },
      ],
      workspaces: [
        { id: "ws-home", name: "Home repo", profileId: "home", cwd: "/home-root", panels: [{ id: "a" }] },
        { id: "ws-work", name: "Work repo", profileId: "work", cwd: "/work-root", panels: [{ id: "b" }] },
      ],
      windowSlots: [{ id: "win-home", profileId: "home", activeWorkspaceId: "ws-home" }],
    },
  };
  const registries: RemoteClientRegistry[] = [];
  const base: Record<string, unknown> = {
    getPayload: () => payload,
    getInitialState: async () => payload,
    setRemoteInfo: () => undefined,
    setRemoteClientRegistry: () => undefined,
    addRemoteClientRegistry: (registry: RemoteClientRegistry) => {
      registries.push(registry);
      return () => registries.splice(registries.indexOf(registry), 1);
    },
    listRemoteUrls: () => [],
    on: () => () => undefined,
    isSshTestSessionId: () => false,
    isPrivateSshOperationSessionId: () => false,
    isReviewAgentPreparationSessionId: () => false,
    activateProfileForRemoteClient: (sessionId: string, profileId: string, registry: RemoteClientRegistry) =>
      registry.activateProfile(sessionId, profileId, payload.appState),
  };
  const runtime = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      return prop in target ? target[prop] : () => payload;
    },
  });
  return { runtime, registries };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function startPair() {
  const hostSettings = defaultPeerSettings();
  hostSettings.hosting.enabled = true;
  const hostSecrets = new Map<string, string>();
  const peerHost = createPeerHost({
    getSettings: () => hostSettings,
    updateSettings: async (_reason, update) => {
      await Promise.resolve();
      update(hostSettings);
    },
    credentials: {
      getSecret: (ref) => hostSecrets.get(ref) ?? "",
      setSecret: async (ref, secret) => {
        hostSecrets.set(ref, secret);
      },
      isEncryptionAvailable: () => true,
    },
    appVersion: "1.0.0",
    hostName: () => "Host PC",
    emit: () => undefined,
  });
  const { instanceId: hostId } = await peerHost.ensureIdentity();
  const helloOverride = { appVersion: "1.0.0", hostInstanceId: hostId };
  const hello = (): PeerHello => ({
    protocolVersion: 1,
    hostInstanceId: helloOverride.hostInstanceId,
    hostName: "Host PC",
    appVersion: helloOverride.appVersion,
    profiles: [{ id: "home", name: "Home", color: "#fff", workspaceCount: 1 }],
  });
  const host = makeHostRuntime();
  const server = await startRemoteServer({
    runtime: host.runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
    staticRoot: process.cwd(),
    peerOrigin: {
      host: "127.0.0.1",
      port: 0,
      peerHost,
      hello,
      listDirectories: async () => {
        throw new Error("unused");
      },
      attention: () => ({ total: 0, profiles: [] }),
    },
  });

  const peers: PeerIntegrationSettings = defaultPeerSettings();
  const state = {
    settings: { terminalFontSizeLocal: 15, integrations: { peers } },
    peerWindows: [],
    windowSlots: [{ id: "local-1", profileId: "default", bounds: { x: 0, y: 0, width: 1, height: 1 } }],
    profiles: [],
    workspaces: [],
  } as unknown as AppState;
  const secrets = new Map<string, string>();
  const events: Array<{ event: string; payload: unknown }> = [];
  const device = createRuntimePeers({
    getState: () => state,
    mutate: async (_reason, mutator) => {
      await Promise.resolve();
      mutator(state);
    },
    credentials: {
      getSecret: (ref) => secrets.get(ref) ?? "",
      setSecret: async (ref, secret) => {
        secrets.set(ref, secret);
      },
      deleteSecret: async (ref) => {
        secrets.delete(ref);
      },
      isEncryptionAvailable: () => true,
    },
    appVersion: "1.0.0",
    emit: (event, payload) => events.push({ event, payload }),
  });
  open.push(async () => {
    device.dispose();
    await server.close();
  });

  const started = await device.startPairing({ address: "127.0.0.1", port: server.address!.port });
  const pending = peerHost.listPending();
  expect(await peerHost.approvePairing(pending[0]!.pairingId, started.code)).toBe("approved");
  await waitFor(() => peers.hosts.length === 1, "paired host");
  return { device, host, peers, state, hostId, events, peerHost, helloOverride };
}

describe("windows attached to another desktop reach the host as the window, not as the renderer says", () => {
  test("an HTTP request carries the window's derived client id whatever the renderer sent", async () => {
    const { device, host, peers, hostId } = await startPair();
    const slot = await device.createPeerWindowSlot({ hostId, profileId: "home" });
    const clientId = peerWindowClientId(peers.instanceId, slot.id);
    expect(clientId).toMatch(/^[a-zA-Z0-9_-]{8,80}$/);

    for (const header of ["X-Strideterm-Client-Id", "x-strideterm-client-id"]) {
      const response = await device.peerWindowRequest(slot.id, {
        method: "GET",
        pathname: "/api/state",
        headers: { [header]: FORGED },
      });
      expect(response.status).toBe(200);
    }
    expect(host.registries[0]!.get(`peer:${peers.instanceId}:${clientId}`)).toBeDefined();
    expect(host.registries[0]!.get(`peer:${peers.instanceId}:${FORGED}`)).toBeUndefined();
    expect(device.getWindowBackend(slot.id)).toEqual({
      kind: "peer",
      hostId,
      hostLabel: "Host PC",
      remoteProfileId: "home",
      clientId,
      terminalFontSize: 15,
    });
  });

  test("a WebSocket carries the window's derived client id whatever the renderer sent", async () => {
    const { device, host, peers, hostId } = await startPair();
    const slot = await device.createPeerWindowSlot({ hostId, profileId: "home" });
    const clientId = peerWindowClientId(peers.instanceId, slot.id);

    const socket = device.peerWindowOpenSocket(slot.id, { clientId: FORGED, ClientID: FORGED, rev: "999" });
    const frames: string[] = [];
    socket.on("message", (data) => frames.push(data));
    await waitFor(() => frames.some((frame) => frame.includes('"stateProtocol":2')), "first state frame");
    expect(host.registries[0]!.get(`peer:${peers.instanceId}:${clientId}`)).toBeDefined();
    expect(host.registries[0]!.get(`peer:${peers.instanceId}:${FORGED}`)).toBeUndefined();
    socket.close();
  });

  test("a window that is not attached cannot use the link, and removing the host closes its windows' route", async () => {
    const { device, state, hostId, events } = await startPair();
    await expect(
      device.peerWindowRequest("local-1", { method: "GET", pathname: "/api/state", headers: {} }),
    ).rejects.toThrow("This window is not attached to another desktop.");
    expect(() => device.peerWindowOpenSocket("local-1", {})).toThrow("This window is not attached to another desktop.");

    const slot = await device.createPeerWindowSlot({ hostId, profileId: "home" });
    expect(state.peerWindows).toHaveLength(1);
    expect(await device.removeHost(hostId)).toBe(true);
    expect(events).toContainEqual({ event: "peers:host-removed", payload: { hostId, windowIds: [slot.id] } });
    await expect(
      device.peerWindowRequest(slot.id, { method: "GET", pathname: "/api/state", headers: {} }),
    ).rejects.toThrow();
  });
});

describe("the first contact already names the profile the window is bound to", () => {
  const contextOf = (host: { registries: RemoteClientRegistry[] }, instanceId: string, windowId: string) =>
    host.registries[0]!.get(`peer:${instanceId}:${peerWindowClientId(instanceId, windowId)}`);

  test("a new window bound to a non-fallback profile starts there, and a forged profileId is replaced", async () => {
    const { device, host, peers, hostId } = await startPair();
    const slot = await device.createPeerWindowSlot({ hostId, profileId: "work" });

    const response = await device.peerWindowRequest(slot.id, {
      method: "GET",
      pathname: "/api/state?profileId=home&x=1",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(contextOf(host, peers.instanceId, slot.id)?.profileId).toBe("work");
    const payload = JSON.parse(String(response.body)) as {
      appState: { workspaces: Array<{ id: string }> };
      remoteClient: { profileId: string };
    };
    expect(payload.remoteClient.profileId).toBe("work");
    expect(payload.appState.workspaces.map((workspace) => workspace.id)).toEqual(["ws-work"]);
  });

  test("a new socket starts on the bound profile whatever the renderer sent", async () => {
    const { device, host, peers, hostId } = await startPair();
    const slot = await device.createPeerWindowSlot({ hostId, profileId: "work" });
    const socket = device.peerWindowOpenSocket(slot.id, { profileId: "home", PROFILEID: "home", rev: "999" });
    const frames: string[] = [];
    socket.on("message", (data) => frames.push(data));
    await waitFor(() => frames.some((frame) => frame.includes('"stateProtocol":2')), "first state frame");
    expect(contextOf(host, peers.instanceId, slot.id)?.profileId).toBe("work");
    socket.close();
  });

  test("a bound profile the host no longer has falls back without an error", async () => {
    const { device, host, peers, hostId } = await startPair();
    const slot = await device.createPeerWindowSlot({ hostId, profileId: "gone" });
    const response = await device.peerWindowRequest(slot.id, { method: "GET", pathname: "/api/state", headers: {} });
    expect(response.status).toBe(200);
    expect(contextOf(host, peers.instanceId, slot.id)?.profileId).toBe("home");
  });

  test("a later request with a stale profile does not move a context the user switched", async () => {
    const { device, host, peers, hostId } = await startPair();
    const slot = await device.createPeerWindowSlot({ hostId, profileId: "home" });
    await device.peerWindowRequest(slot.id, { method: "GET", pathname: "/api/state", headers: {} });
    const activate = await device.peerWindowRequest(slot.id, {
      method: "POST",
      pathname: "/api/remote-client/profile/activate",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "work" }),
    });
    expect(activate.status).toBe(200);
    expect(contextOf(host, peers.instanceId, slot.id)?.profileId).toBe("work");

    await device.peerWindowRequest(slot.id, { method: "GET", pathname: "/api/state", headers: {} });
    expect(contextOf(host, peers.instanceId, slot.id)?.profileId).toBe("work");
  });
});

describe("a window may only be opened or switched to a host that is reachable, current and paired", () => {
  test("an online host passes, and the other four states are refused with their reason", async () => {
    const { device, hostId, peerHost, helloOverride } = await startPair();
    await expect(device.requireHostOnline(hostId)).resolves.toMatchObject({ state: "online" });

    helloOverride.appVersion = "2.0.0";
    await expect(device.requireHostOnline(hostId)).rejects.toThrow(
      "Host PC runs strIDEterm 2.0.0, this desktop runs 1.0.0. Both must run the same version.",
    );
    helloOverride.appVersion = "1.0.0";

    helloOverride.hostInstanceId = "another-instance-id";
    await expect(device.requireHostOnline(hostId)).rejects.toThrow(
      "The address of Host PC now answers as another strIDEterm.",
    );
    helloOverride.hostInstanceId = hostId;
    await expect(device.requireHostOnline(hostId)).resolves.toMatchObject({ state: "online" });

    await peerHost.removeDevice(peerHost.listDevices()[0]!.id);
    await device.refreshHost(hostId, { force: true });
    await expect(device.requireHostOnline(hostId)).rejects.toThrow(
      "Host PC no longer accepts this desktop. Pair it again.",
    );
  });

  test("a host that does not answer is reported as unreachable, an unknown one as not attached", async () => {
    const { device, hostId, peers } = await startPair();
    peers.hosts[0]!.port = 1;
    await expect(device.requireHostOnline(hostId)).rejects.toThrow("Host PC cannot be reached.");
    await expect(device.requireHostOnline("host-unknown1")).rejects.toThrow("This desktop is not attached.");
  });
});

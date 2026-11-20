import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { PEER_DENIED_ROUTES } from "./peer-session-route-policy.js";
import { startRemoteServer } from "./remote-server.js";
import type { RemoteClientRegistry } from "./remote-client-registry.js";
import {
  defaultPeerSettings,
  type PeerAttentionSummary,
  type PeerDirectoryListing,
  type PeerHello,
  type PeerIntegrationSettings,
} from "../shared/peers.js";
import { PeerDirectoryError } from "./peers/peer-directories.js";
import { PEER_PAIRING_IDENTITY, PEER_TLS_OPTIONS } from "./peers/peer-crypto.js";
import { createPeerClient, type PeerClient } from "./peers/peer-client.js";
import { createPeerHost, type PeerHost } from "./peers/peer-host.js";

const MASTER_UNUSED = "primary-master-token-never-valid-on-the-peer-listener";

interface Call {
  name: string;
  args: unknown[];
}

function makeRuntime() {
  const payload = {
    appState: {
      settings: {
        remoteAccess: { enabled: false, host: "127.0.0.1", port: 1, token: MASTER_UNUSED },
      },
      profiles: [
        { id: "home", name: "Home", color: "#fff", workspaceIds: ["ws-home"] },
        { id: "work", name: "Work Profile", color: "#000", workspaceIds: ["ws-work"] },
      ],
      workspaces: [
        { id: "ws-home", name: "Home repo", profileId: "home", cwd: "/home-root", panels: [{ id: "a" }] },
        { id: "ws-work", name: "Work repo", profileId: "work", cwd: "/work-root", panels: [{ id: "a" }] },
      ],
      windowSlots: [{ id: "win-home", profileId: "home", activeWorkspaceId: "ws-home" }],
    },
  };
  const calls: Call[] = [];
  const registries: RemoteClientRegistry[] = [];
  const base: Record<string, unknown> = {
    getPayload: () => payload,
    getInitialState: async () => payload,
    setRemoteInfo: () => {
      calls.push({ name: "setRemoteInfo", args: [] });
    },
    setRemoteClientRegistry: () => {
      calls.push({ name: "setRemoteClientRegistry", args: [] });
    },
    addRemoteClientRegistry: (registry: RemoteClientRegistry) => {
      registries.push(registry);
      return () => {
        registries.splice(registries.indexOf(registry), 1);
      };
    },
    listRemoteUrls: () => [`http://lan.example:43123/?token=${MASTER_UNUSED}`],
    on: () => () => undefined,
    isSshTestSessionId: () => false,
    isPrivateSshOperationSessionId: () => false,
    isReviewAgentPreparationSessionId: () => false,
    activateProfileForRemoteClient: (sessionId: string, profileId: string, registry: RemoteClientRegistry) => {
      calls.push({ name: "activateProfileForRemoteClient", args: [sessionId, profileId] });
      registry.activateProfile(sessionId, profileId, payload.appState);
    },
  };
  const runtime = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        return payload;
      };
    },
  });
  const called = (name: string) => calls.filter((call) => call.name === name);
  return { runtime, calls, called, registries };
}

const helloFor = (hostInstanceId: string) => (): PeerHello => ({
  protocolVersion: 1,
  hostInstanceId,
  hostName: "Host PC",
  appVersion: "1.0.0",
  profiles: [{ id: "home", name: "Home", color: "#fff", workspaceCount: 1 }],
});

interface Fixture {
  port: number;
  peerHost: PeerHost;
  hostSettings: PeerIntegrationSettings;
  runtime: ReturnType<typeof makeRuntime>;
  hooks: {
    listDirectories(requested: string): Promise<PeerDirectoryListing>;
    attention(): PeerAttentionSummary;
  };
  server: Awaited<ReturnType<typeof startRemoteServer>>;
  device: PeerClient;
  deviceId: string;
  hostId: string;
  rawAgents: https.Agent[];
  rawAgent(identity: string, psk: Buffer): https.Agent;
  raw(
    identity: string,
    psk: Buffer,
    options: { method?: string; path: string; headers?: Record<string, string>; body?: unknown; agent?: https.Agent },
  ): Promise<{ status: number; headers: IncomingHttpHeaders; body: string; reused: boolean }>;
  pair(): Promise<void>;
  api(
    pathname: string,
    options?: { method?: string; clientId?: string | null; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  stop(): Promise<void>;
}

const open: Fixture[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.stop();
});

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const emptyListing: PeerDirectoryListing = {
  path: "/",
  parent: null,
  separator: "/",
  entries: [],
  roots: ["/"],
  truncated: false,
};

async function startFixture(options: { startHosting?: boolean } = {}): Promise<Fixture> {
  const hostSettings = defaultPeerSettings();
  hostSettings.hosting.enabled = options.startHosting ?? true;
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

  const hooks = {
    listDirectories: async (_requested: string): Promise<PeerDirectoryListing> => emptyListing,
    attention: (): PeerAttentionSummary => ({ total: 0, profiles: [] }),
  };
  const runtime = makeRuntime();
  const server = await startRemoteServer({
    runtime: runtime.runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
    staticRoot: process.cwd(),
    peerOrigin: {
      host: "127.0.0.1",
      port: 0,
      peerHost,
      hello: helloFor(hostId),
      listDirectories: (requested) => hooks.listDirectories(requested),
      attention: () => hooks.attention(),
    },
  });
  const port = server.address!.port;

  const deviceSettings = defaultPeerSettings();
  const deviceSecrets = new Map<string, string>();
  const device = createPeerClient({
    getSettings: () => deviceSettings,
    updateSettings: async (_reason, update) => {
      await Promise.resolve();
      update(deviceSettings);
    },
    credentials: {
      getSecret: (ref) => deviceSecrets.get(ref) ?? "",
      setSecret: async (ref, secret) => {
        deviceSecrets.set(ref, secret);
      },
      deleteSecret: async (ref) => {
        deviceSecrets.delete(ref);
      },
      isEncryptionAvailable: () => true,
    },
    appVersion: "1.0.0",
    deviceName: () => "Laptop",
    platform: "win32",
    emit: () => undefined,
    pollIntervalMs: 20,
  });

  const rawAgents: https.Agent[] = [];
  const fixture: Fixture = {
    port,
    peerHost,
    hostSettings,
    runtime,
    hooks,
    server,
    device,
    get deviceId() {
      return deviceSettings.instanceId;
    },
    hostId,
    rawAgents,
    rawAgent(identity, psk) {
      const agent = new https.Agent({
        keepAlive: false,
        ...PEER_TLS_OPTIONS,
        pskCallback: () => ({ psk, identity }),
        checkServerIdentity: () => undefined,
      });
      rawAgents.push(agent);
      return agent;
    },
    raw(identity, psk, { method = "GET", path, headers = {}, body, agent }) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        let reused = false;
        const request = https.request(
          {
            host: "127.0.0.1",
            port,
            method,
            path,
            agent: agent ?? fixture.rawAgent(identity, psk),
            headers: {
              ...(payload !== undefined
                ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }
                : {}),
              ...headers,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks).toString("utf8"),
                reused,
              }),
            );
          },
        );
        request.on("socket", (socket) => {
          socket.once("secureConnect", () => {
            reused = (socket as import("node:tls").TLSSocket).isSessionReused();
          });
        });
        request.on("error", reject);
        request.end(payload);
      });
    },
    async pair() {
      const started = await device.startPairing({ address: "127.0.0.1", port });
      const pending = peerHost.listPending();
      expect(pending).toHaveLength(1);
      expect(await peerHost.approvePairing(pending[0]!.pairingId, started.code)).toBe("approved");
      await waitFor(() => deviceSettings.hosts.length === 1, "host record");
    },
    api(pathname, { method = "POST", clientId = "client-aaaa-1111", body, headers = {} } = {}) {
      return device.request(hostId, {
        method,
        pathname,
        headers: { ...(clientId ? { "X-Strideterm-Client-Id": clientId } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    async stop() {
      device.dispose();
      for (const agent of rawAgents) agent.destroy();
      await server.close();
    },
  };
  open.push(fixture);
  return fixture;
}

const parse = <T>(response: { body: string }) => JSON.parse(response.body) as T;

type Core = { stateProtocol: number; appState: { workspaces: Array<{ id: string }> } };

describe("peer origin: a paired desktop is an ordinary remote client", () => {
  test("pairs, says hello, and gets the v2 core even when it asks for protocol 1", async () => {
    const f = await startFixture();
    await f.pair();
    expect((await f.device.hello(f.hostId)).hostName).toBe("Host PC");

    const res = await f.api("/api/state?sp=1", {
      method: "GET",
      headers: { "X-Strideterm-State-Protocol": "1", "X-Strideterm-Capabilities": "resource-details-v1" },
    });
    expect(res.status).toBe(200);
    const core = parse<Core>(res);
    expect(core.stateProtocol).toBe(2);
    expect(core.appState.workspaces.map((w) => w.id)).toEqual(["ws-home"]);
    expect(res.body).not.toContain("Work repo");
    expect(res.body).not.toContain(MASTER_UNUSED);
  });

  test("its session is peer:<device>:<client>, non-mobile, and the runtime sees that viewer id", async () => {
    const f = await startFixture();
    await f.pair();
    const saved = await f.api("/api/workspace/save", {
      body: { workspace: { id: "ws-home" } },
      clientId: "client-bbbb-2222",
    });
    expect(saved.status).toBe(200);
    expect(f.runtime.called("saveWorkspace")[0]!.args[1]).toBe(`remote:peer:${f.deviceId}:client-bbbb-2222`);

    // A route a mobile session may never reach answers a paired desktop like a remote browser.
    const restart = await f.api("/api/terminal/restart", { body: { sessionId: "ws-home:a" } });
    expect(restart.status).toBe(200);
    expect(f.runtime.called("restartSession")).toHaveLength(1);
  });

  test("a request without a client id is refused", async () => {
    const f = await startFixture();
    await f.pair();
    const res = await f.api("/api/state", { method: "GET", clientId: null });
    expect(res.status).toBe(400);
    expect((await f.api("/api/state", { method: "GET", clientId: "short" })).status).toBe(400);
  });

  test("every policy-denied route is refused without reaching the runtime, and others are served", async () => {
    const f = await startFixture();
    await f.pair();
    for (const route of PEER_DENIED_ROUTES) {
      const res = await f.api(route, { body: {} });
      expect(res.status, route).toBe(403);
    }
    expect(f.runtime.calls).toEqual([]);
    const allowed = await f.api("/api/claude-hook/status", { body: {} });
    expect(allowed.status).toBe(200);
    expect(f.runtime.called("getClaudeHookStatus")).toHaveLength(1);
  });

  test("no other credential works, and nothing but /api and /ws is served", async () => {
    const f = await startFixture();
    await f.pair();
    const route = await f.api("/api/mobile/session/bootstrap", { body: {} });
    expect(route.status).toBe(404);
    expect((await f.api("/api/mobile/attachments", { body: {} })).status).toBe(404);
    expect((await f.api("/api/peer/pair/begin", { body: {} })).status).toBe(403);
    const devicePskForRoot = f.peerHost.pskForIdentity(f.deviceId)!;
    expect((await f.raw(f.deviceId, devicePskForRoot, { path: "/" })).status).toBe(404);
    expect((await f.raw(f.deviceId, devicePskForRoot, { path: "/index.html" })).status).toBe(404);

    const pairingPsk = f.peerHost.pskForIdentity(PEER_PAIRING_IDENTITY)!;
    const asPairing = (path: string, method = "GET", headers: Record<string, string> = {}) =>
      f.raw(PEER_PAIRING_IDENTITY, pairingPsk, { method, path, headers });
    expect((await asPairing("/api/state", "GET", { Authorization: `Bearer ${MASTER_UNUSED}` })).status).toBe(403);
    expect((await asPairing("/api/state?token=" + MASTER_UNUSED)).status).toBe(403);
    expect((await asPairing("/")).status).toBe(404);
    expect((await asPairing("/index.html")).status).toBe(404);
    const cookie = await asPairing(`/?token=${MASTER_UNUSED}`);
    expect(cookie.status).toBe(404);
    expect(cookie.headers["set-cookie"]).toBeUndefined();
    expect((await asPairing("/api/mobile/session/bootstrap", "POST")).status).toBe(403);

    // The device identity is not helped by a master token or a cookie either: they are dropped.
    const devicePsk = f.peerHost.pskForIdentity(f.deviceId)!;
    const noClient = await f.raw(f.deviceId, devicePsk, {
      path: "/api/state",
      headers: { Authorization: `Bearer ${MASTER_UNUSED}`, Cookie: "strideterm_session=peer:x:y" },
    });
    expect(noClient.status).toBe(400);
    const forged = await f.raw(f.deviceId, devicePsk, {
      path: "/api/state",
      headers: {
        "X-Strideterm-Client-Id": "client-cccc-3333",
        "X-Strideterm-Peer-Session": "peer:someoneelse:client-cccc-3333",
        Cookie: "strideterm_session=token-client:client-cccc-3333",
      },
    });
    expect(forged.status).toBe(200);
    expect(f.runtime.registries[0]!.get(`peer:${f.deviceId}:client-cccc-3333`)).toBeDefined();
    expect(f.runtime.registries[0]!.get("peer:someoneelse:client-cccc-3333")).toBeUndefined();
  });

  test("the server publishes nothing of its own and owns a separate registry", async () => {
    const f = await startFixture();
    expect(f.runtime.called("setRemoteInfo")).toEqual([]);
    expect(f.runtime.called("setRemoteClientRegistry")).toEqual([]);
    expect(f.runtime.registries).toHaveLength(1);
    await f.server.close();
    expect(f.runtime.registries).toHaveLength(0);
    open.pop();
    f.device.dispose();
  });

  test("two client ids of one device have independent views", async () => {
    const f = await startFixture();
    await f.pair();
    await f.api("/api/state", { method: "GET", clientId: "client-one-1111" });
    await f.api("/api/state", { method: "GET", clientId: "client-two-2222" });
    expect(
      (await f.api("/api/remote-client/profile/activate", { clientId: "client-two-2222", body: { profileId: "work" } }))
        .status,
    ).toBe(200);
    const one = parse<Core>(await f.api("/api/state", { method: "GET", clientId: "client-one-1111" }));
    const two = parse<Core>(await f.api("/api/state", { method: "GET", clientId: "client-two-2222" }));
    expect(one.appState.workspaces.map((w) => w.id)).toEqual(["ws-home"]);
    expect(two.appState.workspaces.map((w) => w.id)).toEqual(["ws-work"]);
  });
});

describe("peer origin: the pairing identity", () => {
  test("reaches only the pairing routes", async () => {
    const f = await startFixture();
    const psk = f.peerHost.pskForIdentity(PEER_PAIRING_IDENTITY)!;
    const status = await f.raw(PEER_PAIRING_IDENTITY, psk, {
      method: "POST",
      path: "/api/peer/pair/status",
      body: { pairingId: "abcdefgh12" },
    });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toEqual({ state: "expired" });
    const bad = await f.raw(PEER_PAIRING_IDENTITY, psk, {
      method: "POST",
      path: "/api/peer/pair/begin",
      body: { x: 1 },
    });
    expect(bad.status).toBe(400);
    const missing = await f.raw(PEER_PAIRING_IDENTITY, psk, {
      method: "POST",
      path: "/api/peer/pair/reveal",
      body: { pairingId: "abcdefgh12", publicKey: "A".repeat(43) + "=", nonce: "A".repeat(43) + "=" },
    });
    expect(missing.status).toBe(404);
    for (const path of [
      "/api/peer/hello",
      "/api/peer/attention",
      "/api/peer/fs/list",
      "/api/state",
      "/api/remote-client/profile/activate",
    ]) {
      expect((await f.raw(PEER_PAIRING_IDENTITY, psk, { method: "POST", path, body: {} })).status, path).toBe(403);
    }
    expect(f.runtime.calls).toEqual([]);
  });

  test("a WebSocket upgrade under the pairing identity is refused", async () => {
    const f = await startFixture();
    const psk = f.peerHost.pskForIdentity(PEER_PAIRING_IDENTITY)!;
    const ws = new WebSocket(`wss://127.0.0.1:${f.port}/ws?clientId=client-dddd-4444`, {
      agent: f.rawAgent(PEER_PAIRING_IDENTITY, psk),
    });
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("unexpected-response", (_request, response) => resolve(`status ${response.statusCode}`));
      ws.on("error", () => resolve("error"));
    });
    expect(outcome).toBe("status 403");
  });

  test("is rate limited per address", async () => {
    const f = await startFixture();
    const psk = f.peerHost.pskForIdentity(PEER_PAIRING_IDENTITY)!;
    const agent = f.rawAgent(PEER_PAIRING_IDENTITY, psk);
    const statuses: number[] = [];
    for (let index = 0; index < 22; index++) {
      statuses.push(
        (
          await f.raw(PEER_PAIRING_IDENTITY, psk, {
            method: "POST",
            path: "/api/peer/pair/status",
            body: { pairingId: "abcdefgh12" },
            agent,
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });

  test("a device identity cannot use the pairing routes", async () => {
    const f = await startFixture();
    await f.pair();
    const psk = f.peerHost.pskForIdentity(f.deviceId)!;
    const res = await f.raw(f.deviceId, psk, {
      method: "POST",
      path: "/api/peer/pair/status",
      body: { pairingId: "abcdefgh12" },
    });
    expect(res.status).toBe(403);
  });

  test("turning hosting off fails the handshake for both identities", async () => {
    const f = await startFixture();
    await f.pair();
    const devicePsk = f.peerHost.pskForIdentity(f.deviceId)!;
    const pairingPsk = f.peerHost.pskForIdentity(PEER_PAIRING_IDENTITY)!;
    f.hostSettings.hosting.enabled = false;
    await expect(f.raw(f.deviceId, devicePsk, { path: "/api/peer/hello" })).rejects.toThrow();
    await expect(
      f.raw(PEER_PAIRING_IDENTITY, pairingPsk, {
        method: "POST",
        path: "/api/peer/pair/status",
        body: { pairingId: "abcdefgh12" },
      }),
    ).rejects.toThrow();
  });

  test("repeated handshake failures lock the address out", async () => {
    const f = await startFixture();
    const wrong = Buffer.alloc(32, 7);
    for (let index = 0; index < 11; index++) {
      await expect(f.raw("not-a-device-12345", wrong, { path: "/api/peer/hello" })).rejects.toThrow();
    }
    const psk = f.peerHost.pskForIdentity(PEER_PAIRING_IDENTITY)!;
    await expect(
      f.raw(PEER_PAIRING_IDENTITY, psk, {
        method: "POST",
        path: "/api/peer/pair/status",
        body: { pairingId: "abcdefgh12" },
      }),
    ).rejects.toThrow();
  });
});

describe("peer origin: connections of a removed device", () => {
  test("a WebSocket gets the first frames and is closed with 1008 when the device is revoked", async () => {
    const f = await startFixture();
    await f.pair();
    const socket = f.device.openSocket(f.hostId, { clientId: "client-ws-55555", rev: "999" });
    const frames: string[] = [];
    socket.on("message", (data) => frames.push(data));
    const closed = new Promise<{ code: number }>((resolve) => socket.on("close", resolve));
    await waitFor(() => frames.some((frame) => frame.includes('"stateProtocol":2')), "first state frame");
    expect(frames.join("\n")).not.toContain("Work repo");

    await f.peerHost.removeDevice(f.deviceId);
    f.server.revokePeerDevice!(f.deviceId);
    expect((await closed).code).toBe(1008);
    expect(f.runtime.registries[0]!.get(`peer:${f.deviceId}:client-ws-55555`)).toBeUndefined();
    await expect(f.device.hello(f.hostId)).rejects.toMatchObject({ code: "not-paired" });
  });

  test("a client that caches TLS sessions cannot come back after the device was removed", async () => {
    const f = await startFixture();
    await f.pair();
    const psk = f.peerHost.pskForIdentity(f.deviceId)!;
    const caching = new https.Agent({
      keepAlive: false,
      ...PEER_TLS_OPTIONS,
      pskCallback: () => ({ psk, identity: f.deviceId }),
      checkServerIdentity: () => undefined,
    });
    f.rawAgents.push(caching);
    for (let index = 0; index < 3; index++) {
      const ok = await f.raw(f.deviceId, psk, { path: "/api/peer/hello", agent: caching });
      expect(ok.status).toBe(200);
      expect(ok.reused, "a new connection must not resume a TLS session").toBe(false);
    }

    await f.peerHost.removeDevice(f.deviceId);
    f.server.revokePeerDevice!(f.deviceId);
    await expect(f.raw(f.deviceId, psk, { path: "/api/peer/hello", agent: caching })).rejects.toThrow();
    await expect(f.device.hello(f.hostId)).rejects.toMatchObject({ code: "not-paired" });
  });

  test("a removed device is refused on a connection that is still open", async () => {
    const f = await startFixture();
    await f.pair();
    const psk = f.peerHost.pskForIdentity(f.deviceId)!;
    const agent = new https.Agent({
      keepAlive: true,
      ...PEER_TLS_OPTIONS,
      pskCallback: () => ({ psk, identity: f.deviceId }),
      checkServerIdentity: () => undefined,
    });
    f.rawAgents.push(agent);
    expect((await f.raw(f.deviceId, psk, { path: "/api/peer/hello", agent })).status).toBe(200);
    await f.peerHost.removeDevice(f.deviceId);
    await expect(f.raw(f.deviceId, psk, { path: "/api/peer/hello", agent })).rejects.toThrow();
  });
});

describe("peer origin: options", () => {
  test("loopbackOrigin and peerOrigin are mutually exclusive", async () => {
    const f = await startFixture();
    await expect(
      startRemoteServer({
        runtime: f.runtime.runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
        staticRoot: process.cwd(),
        loopbackOrigin: { host: "127.0.0.1", port: 0, guardToken: "g", publicOrigin: "https://relay.example" },
        peerOrigin: {
          host: "127.0.0.1",
          port: 0,
          peerHost: f.peerHost,
          hello: helloFor(f.hostId),
          listDirectories: async () => emptyListing,
          attention: () => ({ total: 0, profiles: [] }),
        },
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });
});

describe("peer origin: folder listing for a paired desktop", () => {
  const listing: PeerDirectoryListing = {
    path: "/srv/code",
    parent: "/srv",
    separator: "/",
    entries: [{ name: "app" }],
    roots: ["/home/host", "/"],
    truncated: false,
  };

  test("answers a device from listDirectories with the exact path the device sent", async () => {
    const f = await startFixture();
    await f.pair();
    const seen: string[] = [];
    f.hooks.listDirectories = async (requested) => {
      seen.push(requested);
      return listing;
    };
    const res = await f.api("/api/peer/fs/list", { body: { path: "/srv/code" }, clientId: null });
    expect(res.status).toBe(200);
    expect(parse<PeerDirectoryListing>(res)).toEqual(listing);
    expect((await f.api("/api/peer/fs/list", { body: { path: "" } })).status).toBe(200);
    expect(seen).toEqual(["/srv/code", ""]);
    expect(f.runtime.calls).toEqual([]);
  });

  test("the pairing identity is refused and never reaches the listing", async () => {
    const f = await startFixture();
    let called = 0;
    f.hooks.listDirectories = async () => {
      called += 1;
      return listing;
    };
    const psk = f.peerHost.pskForIdentity(PEER_PAIRING_IDENTITY)!;
    const res = await f.raw(PEER_PAIRING_IDENTITY, psk, {
      method: "POST",
      path: "/api/peer/fs/list",
      body: { path: "" },
    });
    expect(res.status).toBe(403);
    expect(called).toBe(0);
  });

  test("another method is 404, a bad body is 400", async () => {
    const f = await startFixture();
    await f.pair();
    expect((await f.api("/api/peer/fs/list", { method: "GET" })).status).toBe(404);
    for (const body of [{}, { path: 5 }, { path: "/", extra: 1 }, { path: "x".repeat(4097) }]) {
      const res = await f.api("/api/peer/fs/list", { body });
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(parse<{ error: string }>(res).error).toBe("The folder request is not valid.");
    }
  });

  test("each refusal reaches the device as a 4xx sentence, and an unexpected failure leaks nothing", async () => {
    const f = await startFixture();
    await f.pair();
    const cases: Array<[number, string]> = [
      [400, "The folder path must be absolute."],
      [400, "The folder path is not valid."],
      [404, "That folder was not found."],
      [400, "That path is not a folder."],
      [403, "That folder cannot be read."],
    ];
    for (const [status, sentence] of cases) {
      f.hooks.listDirectories = async () => {
        throw new PeerDirectoryError(status as 400 | 403 | 404, sentence);
      };
      const res = await f.api("/api/peer/fs/list", { body: { path: "x" } });
      expect(res.status).toBe(status);
      expect(parse<{ error: string }>(res).error).toBe(sentence);
    }
    f.hooks.listDirectories = async () => {
      throw new Error("EIO: secret errno detail at C:\\private");
    };
    const failed = await f.api("/api/peer/fs/list", { body: { path: "x" } });
    expect(failed.status).toBe(500);
    expect(failed.body).not.toContain("EIO");
    expect(failed.body).not.toContain("private");
  });
});

describe("peer origin: attention counts for a paired desktop", () => {
  test("a device gets exactly what attention() returns; no workspace or alert text from the runtime leaks", async () => {
    const f = await startFixture();
    await f.pair();
    f.hooks.attention = () => ({ total: 3, profiles: [{ profileId: "work", count: 3 }] });
    const res = await f.api("/api/peer/attention", { method: "GET" });
    expect(res.status).toBe(200);
    expect(parse<PeerAttentionSummary>(res)).toEqual({ total: 3, profiles: [{ profileId: "work", count: 3 }] });
    for (const text of ["Work repo", "Home repo", "/work-root", MASTER_UNUSED]) expect(res.body).not.toContain(text);
    expect(f.runtime.calls).toEqual([]);
  });

  test("the pairing identity gets 403, and POST is 404 for a device", async () => {
    const f = await startFixture();
    await f.pair();
    const psk = f.peerHost.pskForIdentity(PEER_PAIRING_IDENTITY)!;
    expect((await f.raw(PEER_PAIRING_IDENTITY, psk, { path: "/api/peer/attention" })).status).toBe(403);
    expect((await f.api("/api/peer/attention", { method: "POST", body: {} })).status).toBe(404);
  });
});

import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import {
  PEER_PAIRING_TTL_MS,
  defaultPeerSettings,
  peerPairBeginSchema,
  peerPairRevealSchema,
  peerPairStatusSchema,
  type PeerIntegrationSettings,
} from "../../shared/peers.js";
import { PEER_PAIRING_IDENTITY, PEER_TLS_OPTIONS } from "./peer-crypto.js";
import {
  PeerClientError,
  createPeerClient,
  peerLinkKeyRef,
  type PeerClient,
  type PeerClientErrorCode,
  type PeerSocketClose,
} from "./peer-client.js";
import { PeerPairingError, createPeerHost, type PeerHost } from "./peer-host.js";

const HOST_VERSION = "1.0.0";

interface SeenRequest {
  identity: string;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface HostFixture {
  host: PeerHost;
  settings: PeerIntegrationSettings;
  instanceId: string;
  port: number;
  requests: SeenRequest[];
  upgradeUrls: string[];
  secureConnections: { count: number; refused: number };
  helloOverride: { hostInstanceId?: string };
  removeDevice(deviceId: string): Promise<void>;
  moveTo(): Promise<number>;
  stop(): Promise<void>;
}

const fixtures: HostFixture[] = [];
const clients: PeerClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

async function waitFor(condition: () => boolean, label = "condition", timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] });
  res.end(JSON.stringify(body));
}

async function createHostFixture(): Promise<HostFixture> {
  const settings = defaultPeerSettings();
  settings.hosting.enabled = true;
  const secrets = new Map<string, string>();
  const host = createPeerHost({
    getSettings: () => settings,
    updateSettings: async (_reason, update) => {
      await Promise.resolve();
      update(settings);
    },
    credentials: {
      getSecret: (ref) => secrets.get(ref) ?? "",
      setSecret: async (ref, secret) => {
        secrets.set(ref, secret);
      },
      isEncryptionAvailable: () => true,
    },
    appVersion: HOST_VERSION,
    hostName: () => "Host PC",
    emit: () => undefined,
  });
  const { instanceId } = await host.ensureIdentity();
  const identities = new WeakMap<object, string>();
  const requests: SeenRequest[] = [];
  const upgradeUrls: string[] = [];
  const secureConnections = { count: 0, refused: 0 };
  const helloOverride: HostFixture["helloOverride"] = {};
  const liveSockets = new Set<TLSSocket>();

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const identity = identities.get(req.socket) ?? "";
    const body = await readBody(req);
    const url = req.url ?? "";
    requests.push({ identity, method: req.method ?? "", url, headers: { ...req.headers }, body });
    const isPairingRoute = url.startsWith("/api/peer/pair/");
    if (isPairingRoute !== (identity === PEER_PAIRING_IDENTITY)) {
      send(res, 403, { error: "Not allowed for this connection." });
      return;
    }
    try {
      if (url === "/api/peer/pair/begin") {
        const remote = req.socket.remoteAddress ?? "";
        send(res, 200, await host.beginPairing(peerPairBeginSchema.parse(JSON.parse(body)), remote));
      } else if (url === "/api/peer/pair/reveal") {
        send(res, 200, host.revealPairing(peerPairRevealSchema.parse(JSON.parse(body))));
      } else if (url === "/api/peer/pair/status") {
        send(res, 200, host.pairingStatus(peerPairStatusSchema.parse(JSON.parse(body)).pairingId));
      } else if (url === "/api/peer/hello") {
        send(res, 200, {
          protocolVersion: 1,
          hostInstanceId: helloOverride.hostInstanceId ?? instanceId,
          hostName: "Host PC",
          appVersion: HOST_VERSION,
          profiles: [{ id: "p1", name: "Work", color: "#fff", workspaceCount: 2 }],
        });
      } else if (url.startsWith("/api/status/")) {
        send(res, Number(url.slice("/api/status/".length)), { error: "teapot" });
      } else if (url === "/api/slow") {
        return;
      } else if (url.startsWith("/api/echo")) {
        send(res, 200, { method: req.method, url, headers: req.headers, body });
      } else {
        send(res, 404, { error: "no route" });
      }
    } catch (error) {
      send(res, error instanceof PeerPairingError ? 400 : 500, {
        error: error instanceof Error ? error.message : "failed",
      });
    }
  };

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const text = data.toString("utf8");
      if (text === "close-me") socket.close(4001, "bye");
      else socket.send(`echo:${text}`);
    });
  });

  let server: https.Server;
  const listen = async (): Promise<number> => {
    server = https.createServer(
      {
        ...PEER_TLS_OPTIONS,
        pskCallback: (socket: TLSSocket, identity: string) => {
          identities.set(socket, identity);
          return host.pskForIdentity(identity);
        },
      },
      (req, res) => void handler(req, res),
    );
    server.on("secureConnection", (socket) => {
      secureConnections.count += 1;
      liveSockets.add(socket);
      socket.on("close", () => liveSockets.delete(socket));
    });
    server.on("tlsClientError", () => {
      secureConnections.refused += 1;
    });
    server.on("upgrade", (req, socket, head) => {
      const identity = identities.get(req.socket) ?? "";
      if (!identity || identity === PEER_PAIRING_IDENTITY) {
        socket.destroy();
        return;
      }
      upgradeUrls.push(req.url ?? "");
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  };
  const close = async () => {
    for (const socket of liveSockets) socket.destroy();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => {
      if (!server.listening) resolve();
      else server.close(() => resolve());
    });
  };

  const fixture: HostFixture = {
    host,
    settings,
    instanceId,
    port: await listen(),
    requests,
    upgradeUrls,
    secureConnections,
    helloOverride,
    async removeDevice(deviceId) {
      await host.removeDevice(deviceId);
      for (const socket of liveSockets) {
        if (identities.get(socket) === deviceId) socket.destroy();
      }
      for (const ws of wss.clients) ws.terminate();
    },
    async moveTo() {
      await close();
      fixture.port = await listen();
      return fixture.port;
    },
    stop: close,
  };
  fixtures.push(fixture);
  return fixture;
}

interface DeviceHarness {
  client: PeerClient;
  settings: PeerIntegrationSettings;
  secrets: Map<string, string>;
  events: Array<{ event: string; payload: Record<string, unknown> }>;
  clock: { value: number };
  encryption: { available: boolean };
  updateCalls: { count: number };
}

function createDevice(
  options: {
    appVersion?: string;
    limits?: { requestTimeoutMs?: number; maxResponseBytes?: number; idleSocketMs?: number };
  } = {},
): DeviceHarness {
  const settings = defaultPeerSettings();
  const secrets = new Map<string, string>();
  const events: DeviceHarness["events"] = [];
  const clock = { value: 1_000_000 };
  const encryption = { available: true };
  const updateCalls = { count: 0 };
  const client = createPeerClient({
    getSettings: () => settings,
    updateSettings: async (_reason, update) => {
      updateCalls.count += 1;
      await Promise.resolve();
      update(settings);
    },
    credentials: {
      getSecret: (ref) => secrets.get(ref) ?? "",
      setSecret: async (ref, secret) => {
        secrets.set(ref, secret);
      },
      deleteSecret: async (ref) => {
        secrets.delete(ref);
      },
      isEncryptionAvailable: () => encryption.available,
    },
    appVersion: options.appVersion ?? HOST_VERSION,
    deviceName: () => "Laptop",
    platform: "win32",
    emit: (event, payload) => events.push({ event, payload: payload as Record<string, unknown> }),
    now: () => clock.value,
    pollIntervalMs: 20,
    limits: options.limits,
  });
  clients.push(client);
  return { client, settings, secrets, events, clock, encryption, updateCalls };
}

const pairingResults = (device: DeviceHarness) =>
  device.events.filter((entry) => entry.event === "peers:pairing-result").map((entry) => entry.payload);

async function pairDevice(fixture: HostFixture, device: DeviceHarness): Promise<string> {
  const started = await device.client.startPairing({ address: "127.0.0.1", port: fixture.port });
  const pending = fixture.host.listPending();
  expect(pending).toHaveLength(1);
  expect(await fixture.host.approvePairing(pending[0]!.pairingId, started.code)).toBe("approved");
  await waitFor(() => device.settings.hosts.length === 1, "host record");
  return started.hostId;
}

async function codeOf(promise: Promise<unknown>): Promise<PeerClientErrorCode | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof PeerClientError ? error.code : undefined;
  }
  return undefined;
}

describe("peer client pairing", () => {
  test("pairs, stores the key and the host, and then talks over the device identity", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const started = await device.client.startPairing({ address: "127.0.0.1", port: fixture.port });
    expect(started.code).toMatch(/^\d{4} \d{4}$/);
    expect(started).toMatchObject({ hostId: fixture.instanceId, hostName: "Host PC", hostAppVersion: HOST_VERSION });
    expect(device.settings.instanceId).not.toBe("");

    const pending = fixture.host.listPending();
    expect(pending[0]).toMatchObject({ deviceId: device.settings.instanceId, name: "Laptop", platform: "win32" });
    expect(await fixture.host.approvePairing(pending[0]!.pairingId, started.code)).toBe("approved");

    await waitFor(() => pairingResults(device).length === 1, "pairing result");
    expect(pairingResults(device)[0]).toEqual({
      attemptId: started.attemptId,
      state: "approved",
      hostId: fixture.instanceId,
    });
    expect(device.client.listHosts()).toEqual([
      expect.objectContaining({
        id: fixture.instanceId,
        label: "Host PC",
        address: "127.0.0.1",
        port: fixture.port,
      }),
    ]);
    expect(device.client.listHosts()[0]!.hostPublicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(device.secrets.get(peerLinkKeyRef(fixture.instanceId))).toContain("PRIVATE KEY");
    expect(device.events.some((entry) => entry.event === "peers:updated")).toBe(true);

    const hello = await device.client.hello(fixture.instanceId);
    expect(hello).toMatchObject({ hostInstanceId: fixture.instanceId, appVersion: HOST_VERSION });
    const echoed = await device.client.request(fixture.instanceId, {
      method: "POST",
      pathname: "/api/echo",
      body: "hi",
    });
    expect(echoed.status).toBe(200);
    expect(JSON.parse(echoed.body)).toMatchObject({ method: "POST", body: "hi" });
    expect(fixture.requests.at(-1)!.identity).toBe(device.settings.instanceId);
  });

  test("a wrong code ends the attempt as rejected and stores nothing", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const started = await device.client.startPairing({ address: "127.0.0.1", port: fixture.port });
    const wrong = started.code === "0000 0000" ? "1111 1111" : "0000 0000";
    expect(await fixture.host.approvePairing(fixture.host.listPending()[0]!.pairingId, wrong)).toBe("sas-mismatch");
    await waitFor(() => pairingResults(device).length === 1, "pairing result");
    expect(pairingResults(device)[0]).toEqual({ attemptId: started.attemptId, state: "rejected" });
    expect(device.settings.hosts).toEqual([]);
    expect(device.secrets.size).toBe(0);
  });

  test("a host that rejects the request ends the attempt as rejected", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const started = await device.client.startPairing({ address: "127.0.0.1", port: fixture.port });
    fixture.host.rejectPairing(fixture.host.listPending()[0]!.pairingId);
    await waitFor(() => pairingResults(device).length === 1, "pairing result");
    expect(pairingResults(device)[0]).toMatchObject({ attemptId: started.attemptId, state: "rejected" });
    expect(device.secrets.size).toBe(0);
  });

  test("cancel ends the attempt and nothing is stored even if the host approves later", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const started = await device.client.startPairing({ address: "127.0.0.1", port: fixture.port });
    device.client.cancelPairing(started.attemptId);
    expect(pairingResults(device)).toEqual([{ attemptId: started.attemptId, state: "cancelled" }]);
    await fixture.host.approvePairing(fixture.host.listPending()[0]!.pairingId, started.code);
    await pause(120);
    expect(device.settings.hosts).toEqual([]);
    expect(device.secrets.size).toBe(0);
    expect(pairingResults(device)).toHaveLength(1);
  });

  test("an attempt nobody approves expires after the pairing lifetime", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const started = await device.client.startPairing({ address: "127.0.0.1", port: fixture.port });
    device.clock.value += PEER_PAIRING_TTL_MS + 1;
    await waitFor(() => pairingResults(device).length === 1, "pairing result");
    expect(pairingResults(device)[0]).toEqual({ attemptId: started.attemptId, state: "expired" });
    expect(device.settings.hosts).toEqual([]);
    expect(device.secrets.size).toBe(0);
  });

  test("a second attempt cancels the first", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const first = await device.client.startPairing({ address: "127.0.0.1", port: fixture.port });
    const second = await device.client.startPairing({ address: "127.0.0.1", port: fixture.port });
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(pairingResults(device)).toEqual([{ attemptId: first.attemptId, state: "cancelled" }]);

    const pending = fixture.host.listPending();
    expect(pending).toHaveLength(1);
    expect(await fixture.host.approvePairing(pending[0]!.pairingId, second.code)).toBe("approved");
    await waitFor(() => pairingResults(device).length === 2, "second result");
    expect(pairingResults(device)[1]).toMatchObject({ attemptId: second.attemptId, state: "approved" });
    expect(device.settings.hosts).toHaveLength(1);
  });

  test("a re-pair of the same host replaces its record and key", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    await pairDevice(fixture, device);
    const firstKey = device.secrets.get(peerLinkKeyRef(fixture.instanceId));
    await device.client.hello(fixture.instanceId);

    const started = await device.client.startPairing({ address: "127.0.0.1", port: fixture.port });
    await fixture.host.approvePairing(fixture.host.listPending()[0]!.pairingId, started.code);
    await waitFor(() => pairingResults(device).length === 2, "second result");
    expect(device.settings.hosts).toHaveLength(1);
    expect(device.secrets.get(peerLinkKeyRef(fixture.instanceId))).not.toBe(firstKey);
    await expect(device.client.hello(fixture.instanceId)).resolves.toMatchObject({
      hostInstanceId: fixture.instanceId,
    });
  });

  test("refuses up front when secure storage is unavailable", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    device.encryption.available = false;
    expect(await codeOf(device.client.startPairing({ address: "127.0.0.1", port: fixture.port }))).toBe(
      "storage-unavailable",
    );
    expect(fixture.requests).toEqual([]);
    expect(fixture.secureConnections.count).toBe(0);
  });

  test("refuses to attach this desktop to itself", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    device.settings.instanceId = fixture.instanceId;
    await expect(device.client.startPairing({ address: "127.0.0.1", port: fixture.port })).rejects.toThrow(/itself/);
    expect(device.settings.hosts).toEqual([]);
    expect(pairingResults(device)).toEqual([]);
  });

  test("explains a refused connection and a non-strIDEterm listener", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const port = fixture.port;
    await fixture.stop();
    const refused = await device.client.startPairing({ address: "127.0.0.1", port }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PeerClientError);
    expect((refused as PeerClientError).code).toBe("unreachable");
    expect((refused as PeerClientError).message).toMatch(/Nothing is listening at 127\.0\.0\.1/);

    const plain = await import("node:http").then(
      ({ createServer }) =>
        new Promise<import("node:http").Server>((resolve) => {
          const server = createServer((_req, res) => res.end("hi"));
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    );
    try {
      const failure = await device.client
        .startPairing({ address: "127.0.0.1", port: (plain.address() as AddressInfo).port })
        .catch((error: unknown) => error);
      expect((failure as Error).message).toBe("This address does not answer as a strIDEterm that accepts desktops.");
    } finally {
      plain.closeAllConnections();
      await new Promise((resolve) => plain.close(resolve));
    }
  });

  test("concurrent callers share one minted instance id", async () => {
    const device = createDevice();
    const ids = await Promise.all([device.client.ensureInstanceId(), device.client.ensureInstanceId()]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(device.settings.instanceId);
    expect(device.updateCalls.count).toBe(1);
  });
});

describe("peer client link", () => {
  test("a non-2xx status resolves with its status, body and joined headers", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    const response = await device.client.request(hostId, { method: "GET", pathname: "/api/status/418" });
    expect(response.status).toBe(418);
    expect(JSON.parse(response.body)).toEqual({ error: "teapot" });
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["set-cookie"]).toBe("a=1, b=2");
  });

  test.each([
    "/apix",
    "//evil/api/x",
    "/api/../x",
    "/api/%2e%2e/x",
    "/api/x#y",
    "http://other/api/x",
    "/api/a\\b",
    "/api/x\ny",
    "/api/a b",
  ])("refuses the path %j before anything is sent", async (pathname) => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    const requests = fixture.requests.length;
    const connections = fixture.secureConnections.count;
    expect(await codeOf(device.client.request(hostId, { method: "GET", pathname }))).toBe("invalid-request");
    expect(fixture.requests.length).toBe(requests);
    expect(fixture.secureConnections.count).toBe(connections);
  });

  test("a query string is allowed", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    const response = await device.client.request(hostId, { method: "GET", pathname: "/api/echo?root=C://x&a=../b" });
    expect(JSON.parse(response.body).url).toBe("/api/echo?root=C://x&a=../b");
  });

  test("hop-by-hop and auth headers never reach the host, the client id does", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    const response = await device.client.request(hostId, {
      method: "POST",
      pathname: "/api/echo",
      body: "héllo",
      headers: {
        Host: "evil.example",
        Connection: "close",
        "Content-Length": "999",
        "Transfer-Encoding": "chunked",
        Authorization: "Bearer secret",
        Cookie: "session=1",
        "X-Custom": "kept",
        "X-Strideterm-Client-Id": "client-123",
      },
    });
    const seen = JSON.parse(response.body).headers as Record<string, string>;
    expect(seen.host).toBe(`127.0.0.1:${fixture.port}`);
    expect(seen.connection).not.toBe("close");
    expect(seen["content-length"]).toBe(String(Buffer.byteLength("héllo")));
    expect(seen["transfer-encoding"]).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
    expect(seen["x-custom"]).toBe("kept");
    expect(seen["x-strideterm-client-id"]).toBe("client-123");
    expect(JSON.parse(response.body).body).toBe("héllo");
  });

  test("two sequential requests reuse one TLS connection", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    const before = fixture.secureConnections.count;
    await device.client.request(hostId, { method: "GET", pathname: "/api/echo" });
    await device.client.request(hostId, { method: "GET", pathname: "/api/echo" });
    expect(fixture.secureConnections.count).toBe(before + 1);
  });

  test("an unknown host and a host whose key is gone are unknown-host", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    expect(await codeOf(device.client.hello("nobody-here"))).toBe("unknown-host");
    const hostId = await pairDevice(fixture, device);
    device.secrets.clear();
    expect(await codeOf(device.client.request(hostId, { method: "GET", pathname: "/api/echo" }))).toBe("unknown-host");
  });

  test("a device the host removed is not-paired", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    await device.client.hello(hostId);
    await fixture.removeDevice(device.settings.instanceId);
    await pause(50);
    expect(await codeOf(device.client.request(hostId, { method: "GET", pathname: "/api/echo" }))).toBe("not-paired");
    expect(await codeOf(device.client.hello(hostId))).toBe("not-paired");
    expect((await device.client.refreshHost(hostId)).state).toBe("not-paired");
  });

  test("a not-paired host is latched: no further connection until re-pair, a new address or a forced refresh", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    await device.client.hello(hostId);
    await fixture.removeDevice(device.settings.instanceId);
    await pause(50);
    expect(await codeOf(device.client.request(hostId, { method: "GET", pathname: "/api/echo" }))).toBe("not-paired");

    const attempts = () => fixture.secureConnections.count + fixture.secureConnections.refused;
    const connections = attempts();
    const requests = fixture.requests.length;
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await codeOf(device.client.request(hostId, { method: "GET", pathname: "/api/echo" }))).toBe("not-paired");
      expect(await codeOf(device.client.hello(hostId))).toBe("not-paired");
    }
    expect((await device.client.refreshHost(hostId)).state).toBe("not-paired");
    const closes: PeerSocketClose[] = [];
    const socket = device.client.openSocket(hostId, { clientId: "client-1" });
    socket.on("close", (info) => closes.push(info));
    await waitFor(() => closes.length === 1, "latched socket close");
    await pause(30);
    expect(closes).toEqual([{ code: 1008, reason: "not-paired" }]);
    expect(attempts()).toBe(connections);
    expect(fixture.requests.length).toBe(requests);

    // The host takes the device back; only a forced refresh goes to the network again.
    await fixture.host.removeDevice(device.settings.instanceId);
    expect((await device.client.refreshHost(hostId)).state).toBe("not-paired");
    expect(attempts()).toBe(connections);
    expect((await device.client.refreshHost(hostId, { force: true })).state).toBe("not-paired");
    expect(attempts()).toBeGreaterThan(connections);
  });

  test("a new address lifts the latch", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    await fixture.removeDevice(device.settings.instanceId);
    await pause(50);
    expect(await codeOf(device.client.hello(hostId))).toBe("not-paired");
    const attempts = () => fixture.secureConnections.count + fixture.secureConnections.refused;
    const connections = attempts();
    expect(await device.client.updateHostAddress(hostId, { address: "127.0.0.1", port: fixture.port })).toBe(true);
    expect(await codeOf(device.client.hello(hostId))).toBe("not-paired");
    expect(attempts()).toBeGreaterThan(connections);
  });

  test("a re-pair lifts the latch", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    await fixture.removeDevice(device.settings.instanceId);
    await pause(50);
    expect(await codeOf(device.client.hello(hostId))).toBe("not-paired");
    const started = await device.client.startPairing({ address: "127.0.0.1", port: fixture.port });
    const pending = fixture.host.listPending();
    expect(await fixture.host.approvePairing(pending[0]!.pairingId, started.code)).toBe("approved");
    await waitFor(() => pairingResults(device).filter((result) => result.state === "approved").length === 2, "re-pair");
    await expect(device.client.hello(hostId)).resolves.toMatchObject({ hostInstanceId: fixture.instanceId });
  });

  test("a pooled connection idle for longer than the idle limit is dropped, not reused", async () => {
    const fixture = await createHostFixture();
    const device = createDevice({ limits: { idleSocketMs: 120 } });
    const hostId = await pairDevice(fixture, device);
    await device.client.request(hostId, { method: "GET", pathname: "/api/echo" });
    const afterFirst = fixture.secureConnections.count;
    await device.client.request(hostId, { method: "GET", pathname: "/api/echo" });
    expect(fixture.secureConnections.count).toBe(afterFirst);
    await pause(450);
    await device.client.request(hostId, { method: "GET", pathname: "/api/echo" });
    expect(fixture.secureConnections.count).toBe(afterFirst + 1);
  });

  test("a request in flight longer than the idle limit is not cut off by it", async () => {
    const fixture = await createHostFixture();
    const device = createDevice({ limits: { idleSocketMs: 60, requestTimeoutMs: 300 } });
    const hostId = await pairDevice(fixture, device);
    expect(await codeOf(device.client.request(hostId, { method: "GET", pathname: "/api/slow" }))).toBe("unreachable");
  });

  test("a host that is down is unreachable and offline", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    await fixture.stop();
    expect(await codeOf(device.client.request(hostId, { method: "GET", pathname: "/api/echo" }))).toBe("unreachable");
    expect((await device.client.refreshHost(hostId)).state).toBe("offline");
  });

  test("a request that is not answered in time is unreachable", async () => {
    const fixture = await createHostFixture();
    const device = createDevice({ limits: { requestTimeoutMs: 150 } });
    const hostId = await pairDevice(fixture, device);
    expect(await codeOf(device.client.request(hostId, { method: "GET", pathname: "/api/slow" }))).toBe("unreachable");
  });

  test("a response over the size cap is refused", async () => {
    const fixture = await createHostFixture();
    const device = createDevice({ limits: { maxResponseBytes: 64 } });
    const hostId = await pairDevice(fixture, device);
    const response = await device.client.request(hostId, { method: "GET", pathname: "/api/status/204" });
    expect(response.status).toBe(204);
    expect(
      await codeOf(device.client.request(hostId, { method: "POST", pathname: "/api/echo", body: "x".repeat(500) })),
    ).toBe("host-error");
  });

  test("a different app version is version-mismatch, and the status change is announced", async () => {
    const fixture = await createHostFixture();
    const device = createDevice({ appVersion: "9.9.9" });
    const hostId = await pairDevice(fixture, device);
    expect(device.client.getHostStatus(hostId).state).toBe("unknown");
    const updates = () => device.events.filter((entry) => entry.event === "peers:updated").length;
    const before = updates();
    const status = await device.client.refreshHost(hostId);
    expect(status).toMatchObject({
      state: "version-mismatch",
      hostAppVersion: HOST_VERSION,
      profiles: [{ id: "p1", name: "Work", color: "#fff", workspaceCount: 2 }],
    });
    expect(status.checkedAt).toBe(device.clock.value);
    expect(updates()).toBe(before + 1);
    await device.client.refreshHost(hostId);
    expect(updates()).toBe(before + 1);
  });

  test("a host that answers as another installation is wrong-host", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    expect((await device.client.refreshHost(hostId)).state).toBe("online");
    fixture.helloOverride.hostInstanceId = "another-installation";
    expect(await codeOf(device.client.hello(hostId))).toBe("wrong-host");
    expect((await device.client.refreshHost(hostId)).state).toBe("wrong-host");
  });
});

describe("peer client sockets", () => {
  function track(socket: ReturnType<PeerClient["openSocket"]>) {
    const seen = { opened: false, messages: [] as string[], closes: [] as PeerSocketClose[] };
    socket.on("open", () => {
      seen.opened = true;
    });
    socket.on("message", (data) => seen.messages.push(data));
    socket.on("close", (info) => seen.closes.push(info));
    return seen;
  }

  test("opens, echoes, reports the server's close code, and keeps secrets out of the URL", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    const socket = device.client.openSocket(hostId, { clientId: "client-1", extra: "a b&c=d" });
    const seen = track(socket);
    await waitFor(() => seen.opened, "open");
    socket.send("ping");
    await waitFor(() => seen.messages.length === 1, "echo");
    expect(seen.messages).toEqual(["echo:ping"]);
    socket.send("close-me");
    await waitFor(() => seen.closes.length === 1, "close");
    expect(seen.closes[0]).toEqual({ code: 4001, reason: "bye" });
    await pause(50);
    expect(seen.closes).toHaveLength(1);

    expect(fixture.upgradeUrls).toHaveLength(1);
    const url = fixture.upgradeUrls[0]!;
    expect(url.startsWith("/ws?")).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(url.slice(4)))).toEqual({ clientId: "client-1", extra: "a b&c=d" });
    expect(url.toLowerCase()).not.toContain("token");
    expect(url).not.toContain(device.settings.instanceId);
  });

  test("a failed connect fires close once with 1006", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    await fixture.stop();
    const seen = track(device.client.openSocket(hostId, { clientId: "client-1" }));
    await waitFor(() => seen.closes.length === 1, "close");
    await pause(50);
    expect(seen.opened).toBe(false);
    expect(seen.closes).toHaveLength(1);
    expect(seen.closes[0]!.code).toBe(1006);
  });

  test("a socket for an unknown host closes with 1006", async () => {
    const device = createDevice();
    const seen = track(device.client.openSocket("nobody-here", {}));
    await waitFor(() => seen.closes.length === 1, "close");
    expect(seen.closes[0]!.code).toBe(1006);
  });

  test("removeHost deletes the record and key and closes open sockets", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    const seen = track(device.client.openSocket(hostId, { clientId: "client-1" }));
    await waitFor(() => seen.opened, "open");
    expect(await device.client.removeHost(hostId)).toBe(true);
    await waitFor(() => seen.closes.length === 1, "close");
    expect(seen.closes).toHaveLength(1);
    expect(device.client.listHosts()).toEqual([]);
    expect(device.secrets.has(peerLinkKeyRef(hostId))).toBe(false);
    expect(await device.client.removeHost(hostId)).toBe(false);
    expect(await codeOf(device.client.hello(hostId))).toBe("unknown-host");
  });

  test("updateHostAddress sends the next request to the new port", async () => {
    const fixture = await createHostFixture();
    const device = createDevice();
    const hostId = await pairDevice(fixture, device);
    const oldPort = fixture.port;
    await device.client.hello(hostId);
    const newPort = await fixture.moveTo();
    expect(newPort).not.toBe(oldPort);
    expect(await codeOf(device.client.hello(hostId))).toBe("unreachable");
    expect(await device.client.updateHostAddress(hostId, { address: "127.0.0.1", port: newPort })).toBe(true);
    expect(device.client.listHosts()[0]).toMatchObject({ port: newPort });
    await expect(device.client.hello(hostId)).resolves.toMatchObject({ hostInstanceId: fixture.instanceId });
    expect(await device.client.updateHostAddress("nobody-here", { address: "127.0.0.1", port: newPort })).toBe(false);
  });
});

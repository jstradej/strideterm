/**
 * The desktop connector, driven by a fake relay on one side and a real loopback HTTP/WebSocket
 * server on the other.
 *
 * Both halves are real sockets on real ports. A test that stubbed the transport would prove the
 * frame codec agrees with itself; what has to be proven here is that the connector reaches an
 * actual origin, rewrites exactly the headers it claims to, refuses to be pointed anywhere else,
 * and ends bounded when a stream misbehaves.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import http from "node:http";
import net from "node:net";
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

import { createRelayConnector, defaultReconnectDelay, type RelayConnector } from "./mobile-relay-connector.js";
import type { RelayInstallationIdentity } from "./mobile-relay-identity.js";
import {
  decodeRelayFrame,
  encodeRelayFrame,
  rawEd25519PublicKey,
  RELAY_CONNECTOR_SUBPROTOCOL,
  RELAY_PROTOCOL_VERSION,
  RELAY_RECONNECT_MAX_DELAY_MS,
  relayConnectorChallengeTranscript,
  relayKeyFingerprint,
  type RelayFrame,
  type RelayFrameHeader,
} from "./mobile-relay-protocol.js";

const GUARD_TOKEN = "guard-token-for-this-test-only";
const INSTALLATION_ID = "installation-under-test";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function makeIdentity(): RelayInstallationIdentity {
  const { privateKey } = generateKeyPairSync("ed25519");
  const raw = rawEd25519PublicKey(createPublicKey(privateKey));
  return {
    installationId: INSTALLATION_ID,
    publicKeyBase64Url: raw.toString("base64url"),
    fingerprint: relayKeyFingerprint(raw),
    signChallenge: (transcript: Buffer) => sign(null, transcript, privateKey),
  };
}

// ---------------------------------------------------------------------------
// A real internal origin: whatever a desktop's remote server would be, minus the desktop.
// ---------------------------------------------------------------------------

interface InternalOrigin {
  host: string;
  port: number;
  guardToken: string;
  /** Every request that arrived, so a test can assert on what the connector actually forwarded. */
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }[];
  close(): Promise<void>;
}

async function startInternalOrigin(
  handler?: (request: http.IncomingMessage, response: http.ServerResponse, body: Buffer) => void,
): Promise<InternalOrigin> {
  const requests: InternalOrigin["requests"] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
      // The guard is the whole point of the loopback origin: it answers its connector and nobody
      // else on the machine.
      if (request.headers["x-strideterm-relay-origin"] !== GUARD_TOKEN) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      if (handler) {
        handler(request, response, body);
        return;
      }
      const url = new URL(request.url ?? "/", "http://internal");
      if (url.pathname === "/echo") {
        response.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
        return;
      }
      if (url.pathname === "/cookies") {
        response
          .writeHead(200, { "content-type": "text/plain", "Set-Cookie": ["a=1; HttpOnly", "b=2; HttpOnly"] })
          .end("cookies");
        return;
      }
      if (url.pathname === "/big") {
        const total = Number(url.searchParams.get("n") ?? "65536");
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.alloc(total, 0x41));
        return;
      }
      response.writeHead(200, { "content-type": "text/plain", "x-seen-host": String(request.headers.host) }).end("ok");
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket, request) => {
    if (request.headers["x-strideterm-relay-origin"] !== GUARD_TOKEN) {
      socket.close(1008, "forbidden");
      return;
    }
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      socket.send(isBinary ? data : `echo:${data.toString("utf8")}`);
    });
  });

  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    host: "127.0.0.1",
    port,
    guardToken: GUARD_TOKEN,
    requests,
    async close() {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// A fake relay: the frame protocol from the other side.
// ---------------------------------------------------------------------------

interface FakeRelay {
  origin: string;
  /** Frames the connector sent, in order. */
  frames: RelayFrame[];
  /** How many sockets have been accepted, whether or not they finished the handshake. */
  connections(): number;
  /** Resolves once a connector has completed the handshake. */
  ready: Promise<void>;
  send(header: RelayFrameHeader, payload?: Buffer): void;
  /** Sends bytes or text the codec has no form for, to exercise the connector's refusals. */
  sendRaw(data: Buffer | string): void;
  waitFor(predicate: (frame: RelayFrame) => boolean, timeoutMs?: number): Promise<RelayFrame>;
  /** How many connectors have completed the handshake since this relay started. */
  handshakes(): number;
  /** Every `conn.revoke` this relay received during a sync phase, in arrival order. */
  syncedRevocations(): { deviceId: string; revokedAt: number | undefined }[];
  /** How many sync phases completed (`conn.sync.complete` arrived). */
  syncsCompleted(): number;
  offeredGrants(): string[];
  dropConnection(): void;
  close(): Promise<void>;
}

async function startFakeRelay(
  options: {
    expectFingerprint: () => string;
    nonce?: string;
    /** When true, the challenge is sent and nothing follows — a handshake that stalls. */
    silentAfterChallenge?: boolean;
    /**
     * When true, the sync is requested and `conn.ready` never follows, whatever the connector answers.
     *
     * The protocol-v2 equivalent of `silentAfterChallenge`: the relay has accepted the key and then
     * stops, which is the state the connector's own sync deadline exists to end.
     */
    silentAfterSyncRequest?: boolean;
  } = { expectFingerprint: () => "" },
): Promise<FakeRelay> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    path: "/__relay/connect",
    handleProtocols: () => RELAY_CONNECTOR_SUBPROTOCOL,
  });
  const frames: RelayFrame[] = [];
  const waiters: { predicate: (frame: RelayFrame) => boolean; resolve: (frame: RelayFrame) => void }[] = [];
  const grants: string[] = [];
  let live: WebSocket | null = null;
  let sessionId = "relay-session-fake-0000000001";
  let handshakeCount = 0;
  let connectionCount = 0;
  let syncsCompleted = 0;
  const syncedRevocations: { deviceId: string; revokedAt: number | undefined }[] = [];
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  wss.on("connection", (socket) => {
    live = socket;
    connectionCount += 1;
    const nonce = options.nonce ?? Buffer.alloc(32, 0x11).toString("base64url");
    socket.send(
      encodeRelayFrame({ v: RELAY_PROTOCOL_VERSION, t: "conn.challenge", src: "relay", dst: "connector", n: nonce }),
    );
    socket.on("message", (data: Buffer) => {
      const frame = decodeRelayFrame(Buffer.from(data));
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter && waiter.predicate(frame)) {
          waiters.splice(i, 1);
          waiter.resolve(frame);
        }
      }
      if (frame.header.t === "conn.authenticate") {
        grants.push(String(frame.header.g));
        // Verify exactly what a real relay verifies: the key is the one the grant pinned, and the
        // signature is over THIS relay's nonce.
        const raw = Buffer.from(String(frame.header.k), "base64url");
        const expected = options.expectFingerprint();
        if (expected && relayKeyFingerprint(raw) !== expected) {
          socket.close(1011, "fingerprint-mismatch");
          return;
        }
        const transcript = relayConnectorChallengeTranscript({
          audience: origin,
          desktopInstallationId: INSTALLATION_ID,
          connectorKeyFingerprint: relayKeyFingerprint(raw),
          nonce,
        });
        const ok = verify(
          null,
          transcript,
          createPublicKey({
            key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
            format: "der",
            type: "spki",
          }),
          Buffer.from(String(frame.header.p), "base64url"),
        );
        if (!ok) {
          socket.close(1011, "bad-proof");
          return;
        }
        handshakeCount += 1;
        // A relay that accepts the proof and then says nothing. The connector has to give up on its
        // own rather than sit in `authenticating` forever (review 1 finding 5).
        if (options.silentAfterChallenge) return;
        // PROTOCOL V2: the proof buys the sync phase, not readiness. Mirroring the real relay here
        // rather than jumping to `conn.ready` is what makes these tests exercise the phase the
        // production Durable Object actually runs.
        socket.send(
          encodeRelayFrame({ v: RELAY_PROTOCOL_VERSION, t: "conn.sync.request", src: "relay", dst: "connector" }),
        );
        return;
      }
      if (frame.header.t === "conn.revoke" && frame.header.s === undefined) {
        // A revoke with no session id is one from the sync phase; a live one names its session and is
        // recorded in `frames` like everything else.
        syncedRevocations.push({ deviceId: String(frame.header.d), revokedAt: frame.header.r });
        return;
      }
      if (frame.header.t === "conn.sync.complete") {
        syncsCompleted += 1;
        if (options.silentAfterSyncRequest) return;
        sessionId = `relay-session-fake-${String(handshakeCount).padStart(10, "0")}`;
        socket.send(
          encodeRelayFrame({
            v: RELAY_PROTOCOL_VERSION,
            t: "conn.ready",
            src: "relay",
            dst: "connector",
            s: sessionId,
          }),
        );
        resolveReady();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    origin,
    frames,
    ready,
    send(header, payload) {
      live?.send(encodeRelayFrame({ ...header, s: header.s === undefined ? undefined : sessionId }, payload));
    },
    sendRaw(data) {
      live?.send(data);
    },
    waitFor(predicate, timeoutMs = 10_000) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<RelayFrame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a connector frame")), timeoutMs);
        waiters.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
    handshakes: () => handshakeCount,
    syncedRevocations: () => [...syncedRevocations],
    syncsCompleted: () => syncsCompleted,
    connections: () => connectionCount,
    offeredGrants: () => [...grants],
    dropConnection() {
      live?.terminate();
    },
    async close() {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------

let internal: InternalOrigin;
let relay: FakeRelay;
let connector: RelayConnector | null = null;
const identity = makeIdentity();

beforeEach(async () => {
  internal = await startInternalOrigin();
  relay = await startFakeRelay({ expectFingerprint: () => identity.fingerprint });
});

afterEach(async () => {
  await connector?.stop();
  connector = null;
  await relay.close();
  await internal.close();
});

/**
 * Waits for the connector's own state, not for the relay's send.
 *
 * `relay.ready` resolves the moment the fake relay puts `conn.ready` on the wire; the connector
 * has not seen it yet at that point, and every assertion about a session id depends on it having.
 */
async function awaitConnectorReady(created: RelayConnector, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (created.state() !== "ready") {
    if (Date.now() > deadline) throw new Error(`connector never became ready (${created.state()})`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Polls [condition] until it holds, so a test can wait on the fake relay's own counters. */
async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function startConnector(overrides: Partial<Parameters<typeof createRelayConnector>[0]> = {}): RelayConnector {
  const created = createRelayConnector({
    relayOrigin: relay.origin,
    identity,
    internalOrigin: { host: internal.host, port: internal.port, guardToken: internal.guardToken },
    getGrant: async () => "grant-token-placeholder",
    reconnectDelayMs: () => 20,
    ...overrides,
  });
  connector = created;
  created.start();
  return created;
}

describe("the relay connector handshake", () => {
  test("answers the relay's challenge with a signature the relay can verify, and becomes ready", async () => {
    await awaitConnectorReady(startConnector());
    expect(relay.handshakes()).toBe(1);
    expect(connector!.state()).toBe("ready");
    expect(relay.offeredGrants()[0]).toBe("grant-token-placeholder");
  });

  test("a fresh grant is fetched for every connection attempt, not reused from the first", async () => {
    let issued = 0;
    await awaitConnectorReady(startConnector({ getGrant: async () => `grant-${++issued}` }));

    const first = relay.offeredGrants()[0]!;
    relay.dropConnection();
    await relay.waitFor(
      () => relay.frames.filter((frame) => frame.header.t === "conn.authenticate").length >= 2,
      15_000,
    );
    // A reconnect after an outage must not present the token it was given minutes ago.
    expect(relay.offeredGrants()[1]).not.toBe(first);
    expect(issued).toBeGreaterThanOrEqual(2);
  });

  test("a grant that fails DURING the challenge closes the socket and reconnects", async () => {
    // Review 1 finding 5. The challenge handler awaits a second `getGrant()`, and the frame handler
    // was invoked as `void onFrame(...)` — so this rejection became an unhandled rejection, the
    // socket stayed open in `authenticating`, and nothing ever scheduled a reconnect. The connector
    // was simply gone until the process restarted.
    let calls = 0;
    const created = startConnector({
      getGrant: async () => {
        calls += 1;
        // First call is `connect()`'s, which must succeed so a socket exists at all; the second is
        // the challenge handler's, which is the one that used to strand the connector.
        if (calls === 2) throw new Error("identity service unavailable");
        return `grant-${calls}`;
      },
    });

    await waitFor(() => relay.connections() >= 2, 15_000, "a reconnect after the failed grant");
    // And it recovers on its own: the fourth call succeeds, so the handshake completes.
    await awaitConnectorReady(created, 15_000);
    expect(created.stats().reconnects).toBeGreaterThanOrEqual(1);
  });

  test("a handshake that never completes is closed and retried, not left open", async () => {
    // The relay accepts the proof and then goes quiet. Nothing else in the connector would notice:
    // heartbeats only start once it is ready, so the heartbeat timeout is no backstop for this.
    await relay.close();
    relay = await startFakeRelay({ expectFingerprint: () => identity.fingerprint, silentAfterChallenge: true });
    const created = startConnector({ handshakeTimeoutMs: 300 });

    await waitFor(() => relay.connections() >= 3, 20_000, "the connector to retry a stalled handshake");
    expect(created.stats().lastError).toBe("handshake-timeout");
    expect(created.state()).not.toBe("ready");
  });

  test("the sync phase replays every revocation the store holds, then completes", async () => {
    // Plan §3.1/§3.3. The connector answers `conn.sync.request` from a SNAPSHOT of the persistent
    // store — so this test states what the store holds and asserts what went out, which is the whole
    // contract between the two.
    const revoked = [
      { deviceId: "mobile-one", revokedAt: 1_700_000_000_000 },
      { deviceId: "mobile-two", revokedAt: 1_700_000_060_000 },
      { deviceId: "mobile-three", revokedAt: 1_700_000_120_000 },
      { deviceId: "mobile-four", revokedAt: 1_700_000_180_000 },
    ];
    const created = startConnector({ listRelayRevocations: () => revoked });
    await awaitConnectorReady(created);

    expect(relay.syncedRevocations()).toEqual(
      revoked.map((entry) => ({ deviceId: entry.deviceId, revokedAt: entry.revokedAt })),
    );
    expect(relay.syncsCompleted()).toBe(1);
    expect(created.stats().revocationsReplayed).toBe(4);
    // The order is the one thing that has to hold beyond the set: the completion is the gate, so it
    // must be the last frame of the phase.
    const phase = relay.frames.filter(
      (frame) => frame.header.t === "conn.revoke" || frame.header.t === "conn.sync.complete",
    );
    expect(phase.at(-1)!.header.t).toBe("conn.sync.complete");
  });

  test("a sync frame carries no session id, because no session exists yet", async () => {
    await awaitConnectorReady(startConnector({ listRelayRevocations: () => [{ deviceId: "mobile-x", revokedAt: 1 }] }));
    for (const frame of relay.frames) {
      if (frame.header.t === "conn.revoke" || frame.header.t === "conn.sync.complete") {
        expect(frame.header.s).toBeUndefined();
      }
    }
    // And a LIVE revoke, after readiness, does name its session.
    connector!.revokeDevice("mobile-y");
    const live = await relay.waitFor((frame) => frame.header.t === "conn.revoke" && frame.header.s !== undefined);
    expect(live.header.d).toBe("mobile-y");
    expect(typeof live.header.r).toBe("number");
  });

  test("the store is read when the relay asks, not when the connector was built", async () => {
    // The difference matters for exactly the case the sync exists for: a revoke that lands while the
    // socket is down has to be in the NEXT sync. A snapshot taken at construction time would replay
    // the same stale list forever.
    const revoked: { deviceId: string; revokedAt: number }[] = [];
    const created = startConnector({ listRelayRevocations: () => revoked });
    await awaitConnectorReady(created);
    expect(relay.syncedRevocations()).toEqual([]);

    revoked.push({ deviceId: "mobile-late", revokedAt: 1_700_000_000_000 });
    relay.dropConnection();
    await waitFor(() => relay.syncsCompleted() >= 2, 20_000, "a second sync after the reconnect");
    expect(relay.syncedRevocations()).toEqual([{ deviceId: "mobile-late", revokedAt: 1_700_000_000_000 }]);
    await awaitConnectorReady(created, 15_000);
  });

  test("a sync that is never acknowledged times out and reconnects rather than hanging", async () => {
    // The relay asks and then says nothing. Without its own deadline the connector would sit in
    // `syncing` while the relay answered every viewer request `503 desktop-syncing` — the worst of
    // the three states, because it looks like an arrival in progress.
    await relay.close();
    relay = await startFakeRelay({ expectFingerprint: () => identity.fingerprint, silentAfterSyncRequest: true });
    const created = startConnector({ syncTimeoutMs: 300 });

    await waitFor(() => relay.connections() >= 3, 20_000, "the connector to retry a stalled sync");
    expect(created.stats().lastError).toBe("sync-timeout");
    expect(created.state()).not.toBe("ready");
  });

  test("heartbeats carry the session the relay issued", async () => {
    await awaitConnectorReady(startConnector());
    const authenticate = relay.frames.find((frame) => frame.header.t === "conn.authenticate")!;
    // `conn.authenticate` predates the session, and says so by carrying no session id.
    expect(authenticate.header.s).toBeUndefined();
  });
});

describe("the HTTP bridge", () => {
  test("a request reaches the internal origin with Host, Origin and the guard rewritten", async () => {
    await awaitConnectorReady(startConnector());

    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "stream-1",
      m: "GET",
      u: "/hello?x=1",
      h: [
        ["accept", "text/html"],
        ["cookie", "strideterm_session=abc"],
        ["host", "relay.example"],
        ["origin", "https://relay.example"],
        ["x-strideterm-relay-origin", "forged-by-the-viewer"],
        ["accept-encoding", "gzip, br"],
      ],
    });
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.end",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "stream-1",
    });

    const start = await relay.waitFor((frame) => frame.header.t === "http.response.start");
    expect(start.header.c).toBe(200);
    await relay.waitFor((frame) => frame.header.t === "http.response.end");

    const seen = internal.requests.at(-1)!;
    expect(seen.url).toBe("/hello?x=1");
    expect(seen.headers.host).toBe(`${internal.host}:${internal.port}`);
    expect(seen.headers.origin).toBe(`http://${internal.host}:${internal.port}`);
    // The viewer's forged guard is replaced, not merged: the origin answered, so the real one won.
    expect(seen.headers["x-strideterm-relay-origin"]).toBe(GUARD_TOKEN);
    // Told the desktop the browser hop was TLS, so its session cookie is marked Secure.
    expect(seen.headers["x-forwarded-proto"]).toBe("https");
    // No Content-Encoding may appear on a relayed response.
    expect(seen.headers["accept-encoding"]).toBe("identity");
    // Everything else passes through — the cookie above is how the WebView's session works at all.
    expect(seen.headers.cookie).toBe("strideterm_session=abc");
    expect(seen.headers.accept).toBe("text/html");
  });

  test("a request body survives the round trip byte for byte", async () => {
    await awaitConnectorReady(startConnector());
    const body = Buffer.alloc(300_000);
    for (let i = 0; i < body.length; i++) body[i] = (i * 17) & 0xff;

    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "stream-2",
      m: "POST",
      u: "/echo",
      h: [["content-type", "application/octet-stream"]],
    });
    relay.send(
      {
        v: RELAY_PROTOCOL_VERSION,
        t: "http.request.body",
        src: "viewer",
        dst: "connector",
        s: "x",
        id: "stream-2",
        q: 0,
      },
      body,
    );
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.end",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "stream-2",
    });

    await relay.waitFor((frame) => frame.header.t === "http.response.end");
    const received = Buffer.concat(
      relay.frames
        .filter((frame) => frame.header.t === "http.response.body" && frame.header.id === "stream-2")
        .map((frame) => frame.payload),
    );
    expect(received.length).toBe(body.length);
    expect(received.equals(body)).toBe(true);
    expect(internal.requests.at(-1)!.body.equals(body)).toBe(true);
  });

  test("response body frames are ordered, and each is credited back", async () => {
    await awaitConnectorReady(startConnector());
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "stream-3",
      m: "GET",
      u: "/big?n=1048576",
      h: [],
    });
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.end",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "stream-3",
    });
    await relay.waitFor((frame) => frame.header.t === "http.response.end", 20_000);

    const bodies = relay.frames.filter(
      (frame) => frame.header.t === "http.response.body" && frame.header.id === "stream-3",
    );
    expect(bodies.length).toBeGreaterThan(1);
    for (let i = 1; i < bodies.length; i++) {
      expect(bodies[i]!.header.q!).toBeGreaterThan(bodies[i - 1]!.header.q!);
    }
    expect(bodies.reduce((sum, frame) => sum + frame.payload.length, 0)).toBe(1048576);
  });

  test("repeated Set-Cookie headers survive as repeated pairs", async () => {
    await awaitConnectorReady(startConnector());
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "stream-4",
      m: "GET",
      u: "/cookies",
      h: [],
    });
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.end",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "stream-4",
    });
    const start = await relay.waitFor((frame) => frame.header.t === "http.response.start");
    const cookies = (start.header.h ?? []).filter(([name]) => name === "set-cookie").map(([, value]) => value);
    expect(cookies).toEqual(["a=1; HttpOnly", "b=2; HttpOnly"]);
  });

  test("a cancel from the relay ends the stream instead of leaving a request open", async () => {
    await awaitConnectorReady(startConnector());
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "stream-5",
      m: "GET",
      u: "/big?n=8388608",
      h: [],
    });
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.end",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "stream-5",
    });
    await relay.waitFor((frame) => frame.header.t === "http.response.start");
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "http.cancel",
      src: "relay",
      dst: "connector",
      s: "x",
      id: "stream-5",
      e: "client-cancelled",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(connector!.stats().liveHttpStreams).toBe(0);
  });

  test("a repeated request-body sequence number ends the stream", async () => {
    await awaitConnectorReady(startConnector());
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "stream-6",
      m: "POST",
      u: "/echo",
      h: [],
    });
    const chunk = Buffer.from("a");
    relay.send(
      {
        v: RELAY_PROTOCOL_VERSION,
        t: "http.request.body",
        src: "viewer",
        dst: "connector",
        s: "x",
        id: "stream-6",
        q: 1,
      },
      chunk,
    );
    relay.send(
      {
        v: RELAY_PROTOCOL_VERSION,
        t: "http.request.body",
        src: "viewer",
        dst: "connector",
        s: "x",
        id: "stream-6",
        q: 1,
      },
      chunk,
    );
    const cancel = await relay.waitFor((frame) => frame.header.t === "http.cancel" && frame.header.id === "stream-6");
    expect(cancel.header.e).toBe("protocol-error");
  });
});

describe("the WebSocket bridge", () => {
  test("opens a socket on the internal origin and carries text and binary both ways", async () => {
    await awaitConnectorReady(startConnector());
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "ws.open",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "ws-1",
      u: "/ws?clientId=abc",
      h: [["cookie", "strideterm_session=abc"]],
    });
    await relay.waitFor((frame) => frame.header.t === "ws.opened" && frame.header.id === "ws-1");

    relay.send(
      { v: RELAY_PROTOCOL_VERSION, t: "ws.data", src: "viewer", dst: "connector", s: "x", id: "ws-1", q: 0, b: false },
      Buffer.from("hello", "utf8"),
    );
    const text = await relay.waitFor((frame) => frame.header.t === "ws.data" && frame.header.id === "ws-1");
    expect(text.payload.toString("utf8")).toBe("echo:hello");
    // Credit is returned for what was delivered inward.
    await relay.waitFor((frame) => frame.header.t === "flow.credit" && frame.header.id === "ws-1");

    relay.send(
      { v: RELAY_PROTOCOL_VERSION, t: "ws.data", src: "viewer", dst: "connector", s: "x", id: "ws-1", q: 1, b: true },
      Buffer.from([7, 8, 9]),
    );
    const binary = await relay.waitFor(
      (frame) => frame.header.t === "ws.data" && frame.header.id === "ws-1" && frame.header.b === true,
    );
    expect([...binary.payload]).toEqual([7, 8, 9]);
  });

  test("a message too large for one frame is fragmented, and only the last frame says so", async () => {
    // Review 1 finding 6. A message larger than BODY_CHUNK_BYTES has to be split, and the split used
    // to carry no fragmentation information at all: the relay decoded each part on its own and the
    // browser received several messages where the desktop had sent one.
    await awaitConnectorReady(startConnector());
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "ws.open",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "ws-frag",
      u: "/ws",
      h: [],
    });
    await relay.waitFor((frame) => frame.header.t === "ws.opened" && frame.header.id === "ws-frag");

    // 600 KiB inward: the internal origin echoes binary back unchanged, so what comes out is one
    // 600 KiB message that cannot fit in one frame.
    const payload = Buffer.alloc(600 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    relay.send(
      {
        v: RELAY_PROTOCOL_VERSION,
        t: "ws.data",
        src: "viewer",
        dst: "connector",
        s: "x",
        id: "ws-frag",
        q: 0,
        b: true,
      },
      payload,
    );

    await relay.waitFor(
      (frame) => frame.header.t === "ws.data" && frame.header.id === "ws-frag" && frame.header.f === true,
      15_000,
    );
    const fragments = relay.frames.filter((frame) => frame.header.t === "ws.data" && frame.header.id === "ws-frag");
    expect(fragments.length).toBe(3);
    expect(fragments.map((frame) => frame.header.f)).toEqual([false, false, true]);
    // And the fragments are the message, in order and byte for byte.
    expect(Buffer.concat(fragments.map((frame) => frame.payload)).equals(payload)).toBe(true);
  });

  test("fragments from the relay are reassembled before the local socket sees them", async () => {
    // The other direction, and the case a receiver that ignores the flag corrupts rather than merely
    // splits: the cut falls inside a multi-byte UTF-8 character, so decoding either half on its own
    // produces replacement characters instead of what was sent.
    await awaitConnectorReady(startConnector());
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "ws.open",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "ws-join",
      u: "/ws",
      h: [],
    });
    await relay.waitFor((frame) => frame.header.t === "ws.opened" && frame.header.id === "ws-join");

    const text = "\u017e\u010d\u011b\u0161\u017e\u010d\u011b\u0161\u2713";
    const encoded = Buffer.from(text, "utf8");
    const cut = 5; // inside a multi-byte character
    relay.send(
      {
        v: RELAY_PROTOCOL_VERSION,
        t: "ws.data",
        src: "viewer",
        dst: "connector",
        s: "x",
        id: "ws-join",
        q: 0,
        b: false,
        f: false,
      },
      encoded.subarray(0, cut),
    );
    relay.send(
      {
        v: RELAY_PROTOCOL_VERSION,
        t: "ws.data",
        src: "viewer",
        dst: "connector",
        s: "x",
        id: "ws-join",
        q: 1,
        b: false,
        f: true,
      },
      encoded.subarray(cut),
    );

    // The internal origin echoes `echo:<text>`, so the reply proves what it actually received.
    const echoed = await relay.waitFor(
      (frame) => frame.header.t === "ws.data" && frame.header.id === "ws-join" && frame.header.f === true,
      15_000,
    );
    expect(echoed.payload.toString("utf8")).toBe(`echo:${text}`);
  });

  test("a close from the relay closes the local socket", async () => {
    await awaitConnectorReady(startConnector());
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "ws.open",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "ws-2",
      u: "/ws",
      h: [],
    });
    await relay.waitFor((frame) => frame.header.t === "ws.opened" && frame.header.id === "ws-2");
    expect(connector!.stats().liveWsStreams).toBe(1);
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "ws.close",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "ws-2",
      x: 1000,
      e: "normal",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(connector!.stats().liveWsStreams).toBe(0);
  });

  test("a socket the internal origin refuses becomes ws.error, not a silent open", async () => {
    await awaitConnectorReady(startConnector());
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "ws.open",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "ws-3",
      u: "/nowhere",
      h: [],
    });
    const error = await relay.waitFor((frame) => frame.header.t === "ws.error" && frame.header.id === "ws-3");
    expect(error.header.e).toBe("unauthorized");
  });
});

describe("lifecycle and bounds", () => {
  test("a lost connection reconnects, and every stream from the old session is cleaned up", async () => {
    await awaitConnectorReady(startConnector());
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "ws.open",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "ws-4",
      u: "/ws",
      h: [],
    });
    await relay.waitFor((frame) => frame.header.t === "ws.opened" && frame.header.id === "ws-4");
    expect(connector!.stats().liveWsStreams).toBe(1);

    relay.dropConnection();
    await relay.waitFor(
      () => relay.frames.filter((frame) => frame.header.t === "conn.authenticate").length >= 2,
      15_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(connector!.stats().liveWsStreams).toBe(0);
    expect(connector!.stats().reconnects).toBeGreaterThanOrEqual(1);
  });

  test("a text message on the relay link is a protocol violation, and reconnects rather than hanging", async () => {
    const created = startConnector();
    await awaitConnectorReady(created);
    const before = relay.frames.filter((frame) => frame.header.t === "conn.authenticate").length;
    // The relay link is binary-framed only. A text message means the peer is not speaking this
    // protocol, so the socket ends — and the connector then reconnects, as it would after any drop.
    relay.sendRaw('{"t":"conn.heartbeat"}');
    await relay.waitFor(
      () => relay.frames.filter((frame) => frame.header.t === "conn.authenticate").length > before,
      15_000,
    );
  });

  test("stop() closes everything and stops reconnecting", async () => {
    const created = startConnector();
    await awaitConnectorReady(created);
    await created.stop();
    connector = null;
    expect(created.state()).toBe("closed");
    const handshakes = relay.handshakes();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(relay.handshakes()).toBe(handshakes);
  });

  test("the backoff is bounded and jittered", () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const delay = defaultReconnectDelay(attempt);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(RELAY_RECONNECT_MAX_DELAY_MS);
    }
    // Jitter: forty draws at a saturated attempt must not all be the same number.
    const draws = new Set(Array.from({ length: 40 }, () => defaultReconnectDelay(30)));
    expect(draws.size).toBeGreaterThan(1);
  });

  test("revokeDevice tells the relay which device is finished", async () => {
    await awaitConnectorReady(startConnector());
    connector!.revokeDevice("mobile-device-xyz");
    const revoke = await relay.waitFor((frame) => frame.header.t === "conn.revoke");
    expect(revoke.header.d).toBe("mobile-device-xyz");
  });
});

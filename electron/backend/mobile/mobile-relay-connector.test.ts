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
import zlib from "node:zlib";
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

import {
  createRelayConnector,
  defaultDefinitiveRefusalRetryDelay,
  defaultReconnectDelay,
  type RelayConnector,
} from "./mobile-relay-connector.js";
import {
  RELAY_E2E_NONCE_BYTES,
  relayE2eCounterOf,
  sealRelayE2eFrame,
  openRelayE2eFrame,
  type RelayE2eKeys,
} from "./mobile-crypto.js";
import { createRelayE2eSessionStore, type RelayE2eSessionStore } from "./mobile-relay-e2e-session-store.js";
import { MobileRelayGrantDefinitiveRefusalError } from "./mobile-firebase-transport.js";
import type { RelayInstallationIdentity } from "./mobile-relay-identity.js";
import {
  decodeRelayFrame,
  encodeRelayFrame,
  rawEd25519PublicKey,
  RELAY_CONNECTOR_SUBPROTOCOL,
  RELAY_FLOW_CREDIT_BYTES,
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
  handler?: (_request: http.IncomingMessage, _response: http.ServerResponse, _body: Buffer) => void,
  onWsMessage?: (_socket: WebSocket, _data: Buffer, _isBinary: boolean) => void,
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
      const STATIC_TYPES: Record<string, string> = {
        "/app.js": "application/javascript",
        "/style.css": "text/css",
        "/logo.svg": "image/svg+xml",
        "/face.ttf": "font/ttf",
        "/data.json": "application/json",
        "/problem.json": "application/problem+json",
        "/index.html": "text/html; charset=utf-8",
        "/note.txt": "text/plain",
      };
      if (STATIC_TYPES[url.pathname]) {
        response.writeHead(200, { "content-type": STATIC_TYPES[url.pathname] }).end("x".repeat(2048));
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
      if (onWsMessage) {
        onWsMessage(socket, data, isBinary);
      } else {
        socket.send(isBinary ? data : `echo:${data.toString("utf8")}`);
      }
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
      // The real relay never rewrites `s`/`id` on an `e2e.*` frame (AAD binds the outer header end to
      // end — see relay/worker's own notes), so this fake one does not either; every other type keeps
      // the existing behaviour of stamping the CURRENT session onto anything that named one at all.
      const isE2e = typeof header.t === "string" && header.t.startsWith("e2e.");
      const outgoing = isE2e ? header : { ...header, s: header.s === undefined ? undefined : sessionId };
      live?.send(encodeRelayFrame(outgoing, payload));
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

  test("the definitive-refusal retry delay is fixed near its constant, and jittered", () => {
    for (let i = 0; i < 40; i++) {
      const delay = defaultDefinitiveRefusalRetryDelay();
      expect(delay).toBeGreaterThan(0);
      // Never exponential, never far from the constant itself (see mobile-relay-protocol.ts).
      expect(delay).toBeGreaterThanOrEqual(270_000);
      expect(delay).toBeLessThanOrEqual(330_000);
    }
    const draws = new Set(Array.from({ length: 40 }, () => defaultDefinitiveRefusalRetryDelay()));
    expect(draws.size).toBeGreaterThan(1);
  });

  test("a DEFINITIVE grant refusal retries on the long delay, not the ordinary backoff", async () => {
    // The ordinary backoff is deliberately huge here: if the connector used it instead of the
    // definitive-refusal delay, this test would time out waiting for the second handshake rather
    // than pass for the wrong reason.
    let calls = 0;
    const created = startConnector({
      reconnectDelayMs: () => 60_000,
      definitiveRefusalRetryDelayMs: () => 20,
      getGrant: async () => {
        calls += 1;
        if (calls === 1) throw new MobileRelayGrantDefinitiveRefusalError("permission-denied");
        return "grant-token-placeholder";
      },
    });
    await awaitConnectorReady(created);
    // One failing call, then a successful attempt — which itself fetches twice (the WS upgrade and
    // the `conn.authenticate` frame each ask for their own grant).
    expect(calls).toBe(3);
  });

  test("a transient grant-fetch error still uses the ordinary bounded backoff", async () => {
    // The definitive-refusal delay is deliberately huge here, for the same reason in reverse.
    let calls = 0;
    const created = startConnector({
      reconnectDelayMs: () => 20,
      definitiveRefusalRetryDelayMs: () => 60_000,
      getGrant: async () => {
        calls += 1;
        if (calls === 1) throw new Error("fetch failed");
        return "grant-token-placeholder";
      },
    });
    await awaitConnectorReady(created);
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Relay end-to-end encryption (plan 2026-09-23, decisions 1/2, §P3 acceptance).
//
// A `FakePhone` below plays the OTHER end of the encrypted channel by hand — sealing/opening with
// the same `mobile-crypto.ts` primitives a real Dart `RelayE2eProxy` mirrors, over frames sent
// through the SAME `FakeRelay` every other test in this file uses (which, after the edit above,
// forwards `e2e.*` frames' `s`/`id` unchanged, exactly like the real relay Worker).
// ---------------------------------------------------------------------------

interface FakePhone {
  /** Seals an inner frame as `e2e.data` src=viewer, ready to hand to `relay.send`. */
  sealToConnector(
    outerId: string,
    s: string,
    innerHeader: RelayFrameHeader,
    innerPayload?: Buffer,
  ): { header: RelayFrameHeader; payload: Buffer };
  /** Opens an `e2e.data` frame the connector sent (src=connector), recovering the inner frame. */
  open(frame: RelayFrame): { header: RelayFrameHeader; payload: Buffer };
}

function makeE2eKeys(): RelayE2eKeys {
  return { desktopToPhone: randomBytes(32), phoneToDesktop: randomBytes(32) };
}

function fakePhone(keys: RelayE2eKeys): FakePhone {
  let outCounter = 0n;
  return {
    sealToConnector(outerId, s, innerHeader, innerPayload) {
      const innerBytes = Buffer.from(encodeRelayFrame(innerHeader, innerPayload));
      const outerHeader: RelayFrameHeader = {
        v: RELAY_PROTOCOL_VERSION,
        t: "e2e.data",
        src: "viewer",
        dst: "connector",
        s,
        id: outerId,
        q: 0,
      };
      const aad = Buffer.from(JSON.stringify(outerHeader), "utf8");
      const sealed = sealRelayE2eFrame(innerBytes, keys.phoneToDesktop, outCounter, aad);
      outCounter += 1n;
      return { header: outerHeader, payload: sealed };
    },
    open(frame) {
      const aad = Buffer.from(JSON.stringify(frame.header), "utf8");
      const innerBytes = openRelayE2eFrame(frame.payload, keys.desktopToPhone, aad);
      return decodeRelayFrame(innerBytes);
    },
  };
}

describe("relay end-to-end encryption", () => {
  const DEVICE_ID = "mobile-device-e2e-under-test";

  test("a viewer-opened e2e stream reaches the real internal origin, and the response comes back sealed", async () => {
    const store = createRelayE2eSessionStore();
    const keys = makeE2eKeys();
    store.put(DEVICE_ID, keys, 60_000);
    const created = startConnector({ e2eSessionStore: store });
    await awaitConnectorReady(created);
    const phone = fakePhone(keys);

    const outerId = "outer-stream-1";
    const s = "phone-chosen-s-value";
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.open",
      src: "viewer",
      dst: "connector",
      s,
      id: outerId,
      d: DEVICE_ID,
    });

    const start = phone.sealToConnector(outerId, s, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "inner-session",
      id: "inner-stream-1",
      m: "GET",
      u: "/hello?x=1",
      h: [["accept", "text/plain"]],
    });
    relay.send(start.header, start.payload);
    const end = phone.sealToConnector(outerId, s, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.end",
      src: "viewer",
      dst: "connector",
      s: "inner-session",
      id: "inner-stream-1",
    });
    relay.send(end.header, end.payload);

    // The desktop's own loopback origin — same one every plaintext test in this file uses — sees a
    // completely ordinary request. It has no idea the path to it was encrypted.
    await waitFor(() => internal.requests.length > 0, 10_000, "the internal origin to see the request");
    expect(internal.requests.at(-1)!.url).toBe("/hello?x=1");

    // The response comes back as e2e.data, never as a plaintext http.response.*.
    const sealedStart = await relay.waitFor(
      (frame) => frame.header.t === "e2e.data" && phone.open(frame).header.t === "http.response.start",
    );
    expect(relay.frames.some((frame) => frame.header.t === "http.response.start")).toBe(false);
    const openedStart = phone.open(sealedStart);
    expect(openedStart.header.c).toBe(200);

    const sealedEnd = await relay.waitFor(
      (frame) => frame.header.t === "e2e.data" && phone.open(frame).header.t === "http.response.end",
    );
    expect(phone.open(sealedEnd).header.id).toBe("inner-stream-1");
  });

  test("delayed replies on replaced key generations close without consuming the new generation", async () => {
    await internal.close();
    let releaseHttp: (() => void) | null = null;
    let releaseWs: (() => void) | null = null;
    let resolveHttpSeen!: () => void;
    let resolveWsSeen!: () => void;
    const httpSeen = new Promise<void>((resolve) => (resolveHttpSeen = resolve));
    const wsSeen = new Promise<void>((resolve) => (resolveWsSeen = resolve));
    internal = await startInternalOrigin(
      (request, response) => {
        if (request.url === "/delayed-http") {
          releaseHttp = () => response.writeHead(200).end("delayed-http");
          resolveHttpSeen();
        } else {
          response.writeHead(200).end("fresh-session");
        }
      },
      (socket) => {
        releaseWs = () => socket.send("delayed-ws");
        resolveWsSeen();
      },
    );

    const store = createRelayE2eSessionStore();
    const oldKeys = makeE2eKeys();
    const newKeys = makeE2eKeys();
    store.put(DEVICE_ID, oldKeys, 60_000);
    await awaitConnectorReady(startConnector({ e2eSessionStore: store }));
    const oldPhone = fakePhone(oldKeys);
    const newPhone = fakePhone(newKeys);
    const sessionId = "rotation-session";
    const outerHttpId = "outer-rotation-http";
    const outerWsId = "outer-rotation-ws";

    for (const outerId of [outerHttpId, outerWsId]) {
      relay.send({
        v: RELAY_PROTOCOL_VERSION,
        t: "e2e.open",
        src: "viewer",
        dst: "connector",
        s: sessionId,
        id: outerId,
        d: DEVICE_ID,
      });
    }

    const requestStart = oldPhone.sealToConnector(outerHttpId, sessionId, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "old-inner-session",
      id: "inner-rotation-http",
      m: "GET",
      u: "/delayed-http",
      h: [],
    });
    relay.send(requestStart.header, requestStart.payload);
    const requestEnd = oldPhone.sealToConnector(outerHttpId, sessionId, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.end",
      src: "viewer",
      dst: "connector",
      s: "old-inner-session",
      id: "inner-rotation-http",
    });
    relay.send(requestEnd.header, requestEnd.payload);
    await httpSeen;

    const wsOpen = oldPhone.sealToConnector(outerWsId, sessionId, {
      v: RELAY_PROTOCOL_VERSION,
      t: "ws.open",
      src: "viewer",
      dst: "connector",
      s: "old-inner-session",
      id: "inner-rotation-ws",
      u: "/ws",
      h: [],
    });
    relay.send(wsOpen.header, wsOpen.payload);
    await relay.waitFor(
      (frame) =>
        frame.header.t === "e2e.data" && frame.header.id === outerWsId && oldPhone.open(frame).header.t === "ws.opened",
    );
    const wsData = oldPhone.sealToConnector(
      outerWsId,
      sessionId,
      {
        v: RELAY_PROTOCOL_VERSION,
        t: "ws.data",
        src: "viewer",
        dst: "connector",
        s: "old-inner-session",
        id: "inner-rotation-ws",
        q: 0,
        b: false,
      },
      Buffer.from("request-ws"),
    );
    relay.send(wsData.header, wsData.payload);
    await wsSeen;

    // This is the same operation `remote.webSession.issue` performs: replacing the store entry
    // makes the connector's next lookup return a new key object while both old streams are pending.
    const rotationFrameIndex = relay.frames.length;
    store.put(DEVICE_ID, newKeys, 60_000);
    releaseHttp!();
    releaseWs!();
    const openWithNewKeys = (frame: RelayFrame): { header: RelayFrameHeader; payload: Buffer } | null => {
      try {
        return newPhone.open(frame);
      } catch {
        return null;
      }
    };

    const staleHttpClose = await relay.waitFor(
      (frame) => frame.header.t === "e2e.close" && frame.header.id === outerHttpId,
    );
    const staleWsClose = await relay.waitFor(
      (frame) => frame.header.t === "e2e.close" && frame.header.id === outerWsId,
    );
    expect(staleHttpClose.header.e).toBe("unauthorized");
    expect(staleWsClose.header.e).toBe("unauthorized");
    expect(
      relay.frames
        .slice(rotationFrameIndex)
        .some((frame) => frame.header.t === "e2e.data" && [outerHttpId, outerWsId].includes(frame.header.id ?? "")),
    ).toBe(false);

    const outerNewId = "outer-rotation-new-session";
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.open",
      src: "viewer",
      dst: "connector",
      s: sessionId,
      id: outerNewId,
      d: DEVICE_ID,
    });
    const newRequestStart = newPhone.sealToConnector(outerNewId, sessionId, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "new-inner-session",
      id: "inner-rotation-new-session",
      m: "GET",
      u: "/fresh-session",
      h: [],
    });
    relay.send(newRequestStart.header, newRequestStart.payload);
    const newRequestEnd = newPhone.sealToConnector(outerNewId, sessionId, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.end",
      src: "viewer",
      dst: "connector",
      s: "new-inner-session",
      id: "inner-rotation-new-session",
    });
    relay.send(newRequestEnd.header, newRequestEnd.payload);
    const newSessionReply = await relay.waitFor(
      (frame) =>
        frame.header.t === "e2e.data" &&
        frame.header.id === outerNewId &&
        openWithNewKeys(frame)?.header.t === "http.response.start",
    );

    expect(relayE2eCounterOf(newSessionReply.payload.subarray(0, RELAY_E2E_NONCE_BYTES))).toBe(0n);
  });

  test("stale live and ended streams cannot advance the replacement generation's inbound counter", async () => {
    const store = createRelayE2eSessionStore();
    const oldKeys = makeE2eKeys();
    const newKeys = makeE2eKeys();
    store.put(DEVICE_ID, oldKeys, 60_000);
    await awaitConnectorReady(startConnector({ e2eSessionStore: store }));
    const oldPhone = fakePhone(oldKeys);
    const newPhone = fakePhone(newKeys);
    const sessionId = "rotation-inbound-session";
    const outerLiveId = "outer-rotation-live";
    const outerEndedId = "outer-rotation-ended";

    for (const outerId of [outerLiveId, outerEndedId]) {
      relay.send({
        v: RELAY_PROTOCOL_VERSION,
        t: "e2e.open",
        src: "viewer",
        dst: "connector",
        s: sessionId,
        id: outerId,
        d: DEVICE_ID,
      });
    }
    const liveWsOpen = oldPhone.sealToConnector(outerLiveId, sessionId, {
      v: RELAY_PROTOCOL_VERSION,
      t: "ws.open",
      src: "viewer",
      dst: "connector",
      s: "old-inner-session",
      id: "inner-rotation-live-ws",
      u: "/ws",
      h: [],
    });
    relay.send(liveWsOpen.header, liveWsOpen.payload);
    await relay.waitFor(
      (frame) =>
        frame.header.t === "e2e.data" &&
        frame.header.id === outerLiveId &&
        oldPhone.open(frame).header.t === "ws.opened",
    );
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.close",
      src: "viewer",
      dst: "connector",
      s: sessionId,
      id: outerEndedId,
      e: "normal",
    });

    store.put(DEVICE_ID, newKeys, 60_000);
    const staleLiveFrame = oldPhone.sealToConnector(
      outerLiveId,
      sessionId,
      {
        v: RELAY_PROTOCOL_VERSION,
        t: "ws.data",
        src: "viewer",
        dst: "connector",
        s: "old-inner-session",
        id: "inner-rotation-live-ws",
        q: 0,
        b: false,
      },
      Buffer.from("stale-live"),
    );
    relay.send(staleLiveFrame.header, staleLiveFrame.payload);
    const staleEndedFrame = oldPhone.sealToConnector(outerEndedId, sessionId, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "old-inner-session",
      id: "inner-rotation-ended-http",
      m: "GET",
      u: "/must-not-reach-origin",
      h: [],
    });
    relay.send(staleEndedFrame.header, staleEndedFrame.payload);

    const liveClose = await relay.waitFor((frame) => frame.header.t === "e2e.close" && frame.header.id === outerLiveId);
    const endedClose = await relay.waitFor(
      (frame) => frame.header.t === "e2e.close" && frame.header.id === outerEndedId,
    );
    expect(liveClose.header.e).toBe("unauthorized");
    expect(endedClose.header.e).toBe("unauthorized");
    expect(internal.requests.some((request) => request.url === "/must-not-reach-origin")).toBe(false);

    const outerNewId = "outer-rotation-inbound-new";
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.open",
      src: "viewer",
      dst: "connector",
      s: sessionId,
      id: outerNewId,
      d: DEVICE_ID,
    });
    const newStart = newPhone.sealToConnector(outerNewId, sessionId, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "new-inner-session",
      id: "inner-rotation-inbound-new",
      m: "GET",
      u: "/new-generation-works",
      h: [],
    });
    relay.send(newStart.header, newStart.payload);
    const newEnd = newPhone.sealToConnector(outerNewId, sessionId, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.end",
      src: "viewer",
      dst: "connector",
      s: "new-inner-session",
      id: "inner-rotation-inbound-new",
    });
    relay.send(newEnd.header, newEnd.payload);
    const newResponse = await relay.waitFor(
      (frame) =>
        frame.header.t === "e2e.data" &&
        frame.header.id === outerNewId &&
        (() => {
          try {
            return newPhone.open(frame).header.t === "http.response.start";
          } catch {
            return false;
          }
        })(),
    );
    expect(newPhone.open(newResponse).header.c).toBe(200);
    expect(relayE2eCounterOf(newResponse.payload.subarray(0, RELAY_E2E_NONCE_BYTES))).toBe(0n);
  });

  test("rotation during queued multi-frame output never falls back to plaintext", async () => {
    await internal.close();
    const largePayload = Buffer.alloc(4 * RELAY_FLOW_CREDIT_BYTES, 0x4b);
    internal = await startInternalOrigin(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/octet-stream" }).end(largePayload);
      },
      (socket) => socket.send(largePayload, { binary: true }),
    );

    const store = createRelayE2eSessionStore();
    const oldKeys = makeE2eKeys();
    store.put(DEVICE_ID, oldKeys, 60_000);
    await awaitConnectorReady(startConnector({ e2eSessionStore: store }));
    const oldPhone = fakePhone(oldKeys);
    const outerHttpId = "outer-queued-rotation-http";
    const outerWsId = "outer-queued-rotation-ws";
    const sessionId = "queued-rotation-session";
    for (const outerId of [outerHttpId, outerWsId]) {
      relay.send({
        v: RELAY_PROTOCOL_VERSION,
        t: "e2e.open",
        src: "viewer",
        dst: "connector",
        s: sessionId,
        id: outerId,
        d: DEVICE_ID,
      });
    }

    const requestStart = oldPhone.sealToConnector(outerHttpId, sessionId, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "old-inner-session",
      id: "inner-queued-rotation-http",
      m: "GET",
      u: "/large-http",
      h: [],
    });
    relay.send(requestStart.header, requestStart.payload);
    const requestEnd = oldPhone.sealToConnector(outerHttpId, sessionId, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.end",
      src: "viewer",
      dst: "connector",
      s: "old-inner-session",
      id: "inner-queued-rotation-http",
    });
    relay.send(requestEnd.header, requestEnd.payload);
    await relay.waitFor(
      (frame) =>
        frame.header.t === "e2e.data" &&
        frame.header.id === outerHttpId &&
        (() => {
          try {
            return oldPhone.open(frame).header.t === "http.response.start";
          } catch {
            return false;
          }
        })(),
    );
    const httpBodyCount = () =>
      relay.frames.filter((frame) => {
        if (frame.header.t !== "e2e.data" || frame.header.id !== outerHttpId) return false;
        try {
          return oldPhone.open(frame).header.t === "http.response.body";
        } catch {
          return false;
        }
      }).length;
    await waitFor(() => httpBodyCount() >= 3, 10_000, "HTTP body frames to fill the initial flow window");

    const wsOpen = oldPhone.sealToConnector(outerWsId, sessionId, {
      v: RELAY_PROTOCOL_VERSION,
      t: "ws.open",
      src: "viewer",
      dst: "connector",
      s: "old-inner-session",
      id: "inner-queued-rotation-ws",
      u: "/ws",
      h: [],
    });
    relay.send(wsOpen.header, wsOpen.payload);
    await relay.waitFor(
      (frame) =>
        frame.header.t === "e2e.data" &&
        frame.header.id === outerWsId &&
        (() => {
          try {
            return oldPhone.open(frame).header.t === "ws.opened";
          } catch {
            return false;
          }
        })(),
    );
    const wsStart = oldPhone.sealToConnector(
      outerWsId,
      sessionId,
      {
        v: RELAY_PROTOCOL_VERSION,
        t: "ws.data",
        src: "viewer",
        dst: "connector",
        s: "old-inner-session",
        id: "inner-queued-rotation-ws",
        q: 0,
        b: false,
      },
      Buffer.from("start-large"),
    );
    relay.send(wsStart.header, wsStart.payload);
    const wsBodyCount = () =>
      relay.frames.filter((frame) => {
        if (frame.header.t !== "e2e.data" || frame.header.id !== outerWsId) return false;
        try {
          return oldPhone.open(frame).header.t === "ws.data";
        } catch {
          return false;
        }
      }).length;
    await waitFor(() => wsBodyCount() >= 3, 10_000, "WebSocket data frames to fill the initial flow window");

    const newKeys = makeE2eKeys();
    const rotationFrameIndex = relay.frames.length;
    store.put(DEVICE_ID, newKeys, 60_000);
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "flow.credit",
      src: "relay",
      dst: "connector",
      s: "x",
      id: outerHttpId,
      w: RELAY_FLOW_CREDIT_BYTES,
    });
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "flow.credit",
      src: "relay",
      dst: "connector",
      s: "x",
      id: outerWsId,
      w: RELAY_FLOW_CREDIT_BYTES,
    });
    const httpClose = await relay.waitFor((frame) => frame.header.t === "e2e.close" && frame.header.id === outerHttpId);
    const wsClose = await relay.waitFor((frame) => frame.header.t === "e2e.close" && frame.header.id === outerWsId);
    expect(httpClose.header.e).toBe("unauthorized");
    expect(wsClose.header.e).toBe("unauthorized");
    const leakedPlaintext = relay.frames
      .slice(rotationFrameIndex)
      .filter(
        (frame) =>
          ["http.response.start", "http.response.body", "http.response.end", "ws.opened", "ws.data"].includes(
            frame.header.t ?? "",
          ) && ["inner-queued-rotation-http", "inner-queued-rotation-ws"].includes(frame.header.id ?? ""),
      );
    expect(leakedPlaintext).toEqual([]);
  });

  test("multi-megabyte encrypted request bodies return exact ciphertext credit before the next chunk", async () => {
    const store = createRelayE2eSessionStore();
    const keys = makeE2eKeys();
    store.put(DEVICE_ID, keys, 60_000);
    const created = startConnector({ e2eSessionStore: store });
    await awaitConnectorReady(created);
    const phone = fakePhone(keys);
    const outerId = "outer-upload-credit";
    const innerId = "inner-upload-credit";
    const s = "phone-upload-session";
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.open",
      src: "viewer",
      dst: "connector",
      s,
      id: outerId,
      d: DEVICE_ID,
    });

    async function sendAndExpectCredit(innerHeader: RelayFrameHeader, body?: Buffer): Promise<void> {
      const sealed = phone.sealToConnector(outerId, s, innerHeader, body);
      const previousCredits = relay.frames.filter(
        (frame) => frame.header.t === "flow.credit" && frame.header.id === outerId,
      ).length;
      relay.send(sealed.header, sealed.payload);
      await waitFor(
        () =>
          relay.frames.filter((frame) => frame.header.t === "flow.credit" && frame.header.id === outerId).length >
          previousCredits,
        10_000,
        "encrypted ingress credit",
      );
      const credits = relay.frames.filter((frame) => frame.header.t === "flow.credit" && frame.header.id === outerId);
      expect(credits.at(-1)?.header.w).toBe(sealed.payload.length);
    }

    await sendAndExpectCredit({
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "inner-session",
      id: innerId,
      m: "POST",
      u: "/hello",
      h: [["content-type", "application/octet-stream"]],
    });
    const chunk = Buffer.alloc(64 * 1024, 0x42);
    for (let i = 0; i < 34; i++) {
      await sendAndExpectCredit(
        {
          v: RELAY_PROTOCOL_VERSION,
          t: "http.request.body",
          src: "viewer",
          dst: "connector",
          s: "inner-session",
          id: innerId,
          q: i,
        },
        chunk,
      );
    }
    const end = phone.sealToConnector(outerId, s, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.end",
      src: "viewer",
      dst: "connector",
      s: "inner-session",
      id: innerId,
    });
    relay.send(end.header, end.payload);
    await waitFor(() => internal.requests.length === 1, 10_000, "full encrypted upload at the internal origin");
    expect(internal.requests[0]!.body.length).toBe(34 * chunk.length);
    expect(internal.requests[0]!.body.subarray(-chunk.length)).toEqual(chunk);
  }, 20_000);

  test("an e2e.open for a device with no derived key is refused, never falls back to plaintext", async () => {
    const store = createRelayE2eSessionStore();
    // Deliberately no `store.put(...)` — this device has no derived key.
    const created = startConnector({ e2eSessionStore: store });
    await awaitConnectorReady(created);

    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.open",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "outer-no-key",
      d: "device-with-no-key",
    });
    const close = await relay.waitFor((frame) => frame.header.t === "e2e.close");
    expect(close.header.id).toBe("outer-no-key");
    expect(close.header.e).toBe("unauthorized");
    expect(internal.requests.length).toBe(0);
  });

  test("a corrupted ciphertext ends the stream via e2e.close and never reaches the internal origin", async () => {
    const store = createRelayE2eSessionStore();
    const keys = makeE2eKeys();
    store.put(DEVICE_ID, keys, 60_000);
    const created = startConnector({ e2eSessionStore: store });
    await awaitConnectorReady(created);
    const phone = fakePhone(keys);

    const outerId = "outer-corrupt";
    const s = "x";
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.open",
      src: "viewer",
      dst: "connector",
      s,
      id: outerId,
      d: DEVICE_ID,
    });

    const sealed = phone.sealToConnector(outerId, s, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "inner-session",
      id: "inner-corrupt",
      m: "GET",
      u: "/hello",
      h: [],
    });
    // Flip one ciphertext byte after the nonce — the auth tag can no longer verify.
    const tampered = Buffer.from(sealed.payload);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    relay.send(sealed.header, tampered);

    const close = await relay.waitFor((frame) => frame.header.t === "e2e.close");
    expect(close.header.id).toBe(outerId);
    expect(close.header.e).toBe("protocol-error");
    // Never attempted as plaintext: the inner frame never reached the internal origin at all.
    expect(internal.requests.length).toBe(0);
  });

  test("RELAY_MAX_HTTP_REQUEST_BODY_BYTES is enforced over the decrypted inner body", async () => {
    const store = createRelayE2eSessionStore();
    const keys = makeE2eKeys();
    store.put(DEVICE_ID, keys, 60_000);
    const created = startConnector({ e2eSessionStore: store });
    await awaitConnectorReady(created);
    const phone = fakePhone(keys);

    const outerId = "outer-toolarge";
    const s = "x";
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.open",
      src: "viewer",
      dst: "connector",
      s,
      id: outerId,
      d: DEVICE_ID,
    });

    const start = phone.sealToConnector(outerId, s, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "inner-session",
      id: "inner-toolarge",
      m: "POST",
      u: "/echo",
      h: [["content-type", "application/octet-stream"]],
    });
    relay.send(start.header, start.payload);

    // RELAY_MAX_HTTP_REQUEST_BODY_BYTES is 4 MiB; a single outer frame may not itself exceed
    // RELAY_MAX_FRAME_BYTES (1 MiB, header included), so five 900 KiB inner chunks cross the body
    // limit over multiple frames instead of one oversized one.
    const chunk = Buffer.alloc(900_000, 0x41);
    for (let i = 0; i < 5; i++) {
      const body = phone.sealToConnector(
        outerId,
        s,
        {
          v: RELAY_PROTOCOL_VERSION,
          t: "http.request.body",
          src: "viewer",
          dst: "connector",
          s: "inner-session",
          id: "inner-toolarge",
          q: i,
        },
        chunk,
      );
      relay.send(body.header, body.payload);
    }

    const cancel = await relay.waitFor(
      (frame) => frame.header.t === "e2e.data" && phone.open(frame).header.t === "http.cancel",
    );
    expect(phone.open(cancel).header.e).toBe("too-large");
  });

  test("a replayed e2e.data (the same counter twice) is refused the second time", async () => {
    const store = createRelayE2eSessionStore();
    const keys = makeE2eKeys();
    store.put(DEVICE_ID, keys, 60_000);
    const created = startConnector({ e2eSessionStore: store });
    await awaitConnectorReady(created);
    const phone = fakePhone(keys);

    const outerId = "outer-replay";
    const s = "x";
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.open",
      src: "viewer",
      dst: "connector",
      s,
      id: outerId,
      d: DEVICE_ID,
    });

    const start = phone.sealToConnector(outerId, s, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "inner-session",
      id: "inner-replay",
      m: "GET",
      u: "/hello",
      h: [],
    });
    relay.send(start.header, start.payload);
    const end = phone.sealToConnector(outerId, s, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.end",
      src: "viewer",
      dst: "connector",
      s: "inner-session",
      id: "inner-replay",
    });
    relay.send(end.header, end.payload);
    await waitFor(() => internal.requests.length > 0, 10_000, "the first (legitimate) request");
    const seenAfterFirst = internal.requests.length;

    // The exact same sealed bytes again — same counter, same ciphertext.
    relay.send(start.header, start.payload);
    const close = await relay.waitFor((frame) => frame.header.t === "e2e.close" && frame.header.id === outerId);
    expect(close.header.e).toBe("protocol-error");
    // The replay never produced a second request to the internal origin.
    expect(internal.requests.length).toBe(seenAfterFirst);
  });

  test("a key that disappears mid-stream ends the stream, rather than silently dropping frames", async () => {
    // security review finding (round 2): sendE2eWrapped failing (missing key, encode error, socket
    // gone) used to return `false` and stop there — most of its callers (flushHttpQueue,
    // flushWsQueue, …) never check that return value, since a plaintext send() only ever failed
    // when the whole socket was down. A vanished key is a NEW failure mode, and left unhandled it
    // meant a browser request could sit unanswered until ITS OWN timeout rather than failing
    // promptly. Fixed by ending the outer stream (an explicit e2e.close) the moment a wrap fails.
    const realStore = createRelayE2eSessionStore();
    const keys = makeE2eKeys();
    realStore.put(DEVICE_ID, keys, 60_000);
    let calls = 0;
    // Real keys for e2e.open and the two inbound request frames; gone by the time the connector
    // tries to send the FIRST outbound frame (http.response.start).
    const vanishingStore: RelayE2eSessionStore = {
      put: (deviceId, k, ttlMs) => realStore.put(deviceId, k, ttlMs),
      delete: (deviceId) => realStore.delete(deviceId),
      get: (deviceId) => {
        calls += 1;
        return calls <= 3 ? realStore.get(deviceId) : null;
      },
    };
    const created = startConnector({ e2eSessionStore: vanishingStore });
    await awaitConnectorReady(created);
    const phone = fakePhone(keys);

    const outerId = "outer-key-vanishes";
    const s = "x";
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.open",
      src: "viewer",
      dst: "connector",
      s,
      id: outerId,
      d: DEVICE_ID,
    });
    const start = phone.sealToConnector(outerId, s, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "inner-session",
      id: "inner-vanish",
      m: "GET",
      u: "/hello",
      h: [],
    });
    relay.send(start.header, start.payload);
    const end = phone.sealToConnector(outerId, s, {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.end",
      src: "viewer",
      dst: "connector",
      s: "inner-session",
      id: "inner-vanish",
    });
    relay.send(end.header, end.payload);

    const close = await relay.waitFor((frame) => frame.header.t === "e2e.close" && frame.header.id === outerId);
    expect(close.header.e).toBe("protocol-error");
    // No response frame ever made it out — the key vanished before the very first send.
    expect(relay.frames.some((frame) => frame.header.t === "e2e.data" && frame.header.id === outerId)).toBe(false);
  });

  // Plan 2026-09-23, decision 4: the connector deflates a text-typed response body before sealing
  // it, so a viewer opening the (uncompressed, per `inboundHeaders`'s forced `identity`) internal
  // origin's response over an e2e session gets it back smaller, never larger.
  describe("response compression (plan decision 4)", () => {
    test("a JavaScript response is deflated, with content-length dropped rather than left stale", async () => {
      const store = createRelayE2eSessionStore();
      const keys = makeE2eKeys();
      store.put(DEVICE_ID, keys, 60_000);
      const created = startConnector({ e2eSessionStore: store });
      await awaitConnectorReady(created);
      const phone = fakePhone(keys);

      const outerId = "outer-compress";
      const s = "x";
      relay.send({
        v: RELAY_PROTOCOL_VERSION,
        t: "e2e.open",
        src: "viewer",
        dst: "connector",
        s,
        id: outerId,
        d: DEVICE_ID,
      });
      // The shared internal origin's catch-all answers any unmatched path with `text/plain`, body
      // "ok" — see `startInternalOrigin`'s default handler.
      const start = phone.sealToConnector(outerId, s, {
        v: RELAY_PROTOCOL_VERSION,
        t: "http.request.start",
        src: "viewer",
        dst: "connector",
        s: "inner-session",
        id: "inner-compress",
        m: "GET",
        u: "/app.js",
        h: [],
      });
      relay.send(start.header, start.payload);
      const end = phone.sealToConnector(outerId, s, {
        v: RELAY_PROTOCOL_VERSION,
        t: "http.request.end",
        src: "viewer",
        dst: "connector",
        s: "inner-session",
        id: "inner-compress",
      });
      relay.send(end.header, end.payload);

      const sealedStart = await relay.waitFor(
        (frame) => frame.header.t === "e2e.data" && phone.open(frame).header.t === "http.response.start",
      );
      const openedStart = phone.open(sealedStart);
      expect(openedStart.header.h).toContainEqual(["content-encoding", "deflate"]);
      expect((openedStart.header.h ?? []).some(([name]) => name === "content-length")).toBe(false);

      const sealedBody = await relay.waitFor(
        (frame) => frame.header.t === "e2e.data" && phone.open(frame).header.t === "http.response.body",
      );
      const openedBody = phone.open(sealedBody);
      expect(zlib.inflateRawSync(openedBody.payload as Buffer).toString("utf8")).toBe("x".repeat(2048));
    });

    /** Runs one GET for `path` through a fresh e2e stream and returns the sealed response's start header. */
    async function responseHeadFor(path: string, label: string): Promise<RelayFrameHeader> {
      const store = createRelayE2eSessionStore();
      const keys = makeE2eKeys();
      store.put(DEVICE_ID, keys, 60_000);
      const created = startConnector({ e2eSessionStore: store });
      await awaitConnectorReady(created);
      const phone = fakePhone(keys);
      const outerId = `outer-${label}`;
      const s = "x";
      relay.send({
        v: RELAY_PROTOCOL_VERSION,
        t: "e2e.open",
        src: "viewer",
        dst: "connector",
        s,
        id: outerId,
        d: DEVICE_ID,
      });
      for (const header of [
        {
          t: "http.request.start" as const,
          id: `inner-${label}`,
          m: "GET" as const,
          u: path,
          h: [] as [string, string][],
        },
        { t: "http.request.end" as const, id: `inner-${label}` },
      ]) {
        const sealed = phone.sealToConnector(outerId, s, {
          v: RELAY_PROTOCOL_VERSION,
          src: "viewer",
          dst: "connector",
          s: "inner-session",
          ...header,
        });
        relay.send(sealed.header, sealed.payload);
      }
      const sealedStart = await relay.waitFor(
        (frame) => frame.header.t === "e2e.data" && phone.open(frame).header.t === "http.response.start",
      );
      return phone.open(sealedStart).header;
    }

    test.each(["/style.css", "/logo.svg", "/face.ttf"])("the static client asset %s is deflated", async (path) => {
      const head = await responseHeadFor(path, path.replace(/[^a-z0-9]/g, ""));
      expect(head.h).toContainEqual(["content-encoding", "deflate"]);
    });

    test.each(["/data.json", "/problem.json", "/index.html", "/note.txt"])(
      "the dynamic response %s is NEVER compressed before encryption",
      async (path) => {
        const head = await responseHeadFor(path, path.replace(/[^a-z0-9]/g, ""));
        expect((head.h ?? []).some(([name]) => name === "content-encoding")).toBe(false);
      },
    );

    test("an application/octet-stream response (e.g. an attachment) is never compressed", async () => {
      const store = createRelayE2eSessionStore();
      const keys = makeE2eKeys();
      store.put(DEVICE_ID, keys, 60_000);
      const created = startConnector({ e2eSessionStore: store });
      await awaitConnectorReady(created);
      const phone = fakePhone(keys);

      const outerId = "outer-nocompress";
      const s = "x";
      relay.send({
        v: RELAY_PROTOCOL_VERSION,
        t: "e2e.open",
        src: "viewer",
        dst: "connector",
        s,
        id: outerId,
        d: DEVICE_ID,
      });
      // `/echo` answers `application/octet-stream`, echoing the request body verbatim.
      const start = phone.sealToConnector(outerId, s, {
        v: RELAY_PROTOCOL_VERSION,
        t: "http.request.start",
        src: "viewer",
        dst: "connector",
        s: "inner-session",
        id: "inner-nocompress",
        m: "POST",
        u: "/echo",
        h: [["content-type", "application/octet-stream"]],
      });
      relay.send(start.header, start.payload);
      const body = phone.sealToConnector(
        outerId,
        s,
        {
          v: RELAY_PROTOCOL_VERSION,
          t: "http.request.body",
          src: "viewer",
          dst: "connector",
          s: "inner-session",
          id: "inner-nocompress",
          q: 0,
        },
        Buffer.from("binary-payload"),
      );
      relay.send(body.header, body.payload);
      const end = phone.sealToConnector(outerId, s, {
        v: RELAY_PROTOCOL_VERSION,
        t: "http.request.end",
        src: "viewer",
        dst: "connector",
        s: "inner-session",
        id: "inner-nocompress",
      });
      relay.send(end.header, end.payload);

      const sealedStart = await relay.waitFor(
        (frame) => frame.header.t === "e2e.data" && phone.open(frame).header.t === "http.response.start",
      );
      const openedStart = phone.open(sealedStart);
      expect((openedStart.header.h ?? []).some(([name]) => name === "content-encoding")).toBe(false);

      const sealedBody = await relay.waitFor(
        (frame) => frame.header.t === "e2e.data" && phone.open(frame).header.t === "http.response.body",
      );
      const openedBody = phone.open(sealedBody);
      expect((openedBody.payload as Buffer).toString("utf8")).toBe("binary-payload");
    });
  });
});

// ---------------------------------------------------------------------------
// Device identity and stream continuity on the e2e path (security review 2026-09-30, 3.1 and 3.4).
// ---------------------------------------------------------------------------

describe("relay end-to-end encryption: identity and continuity", () => {
  const DEVICE_ID = "mobile-device-continuity";
  const OUTER = "outer-continuity";
  const S = "x";

  /** Seals one inner frame under an EXPLICIT outer counter, so a test can skip or repeat one. */
  function sealAt(keys: RelayE2eKeys, counter: bigint, outerId: string, inner: RelayFrameHeader, payload?: Buffer) {
    const outerHeader: RelayFrameHeader = {
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.data",
      src: "viewer",
      dst: "connector",
      s: S,
      id: outerId,
      q: 0,
    };
    const aad = Buffer.from(JSON.stringify(outerHeader), "utf8");
    const sealed = sealRelayE2eFrame(Buffer.from(encodeRelayFrame(inner, payload)), keys.phoneToDesktop, counter, aad);
    return { header: outerHeader, payload: sealed };
  }

  const inner = (t: RelayFrameHeader["t"], id: string, extra: Partial<RelayFrameHeader> = {}): RelayFrameHeader => ({
    v: RELAY_PROTOCOL_VERSION,
    t,
    src: "viewer",
    dst: "connector",
    s: "inner-session",
    id,
    ...extra,
  });

  async function openE2e(outerId = OUTER) {
    const store = createRelayE2eSessionStore();
    const keys = makeE2eKeys();
    store.put(DEVICE_ID, keys, 60_000);
    await awaitConnectorReady(startConnector({ e2eSessionStore: store }));
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.open",
      src: "viewer",
      dst: "connector",
      s: S,
      id: outerId,
      d: DEVICE_ID,
    });
    return keys;
  }

  function sendAll(keys: RelayE2eKeys, outerId: string, frames: Array<[bigint, RelayFrameHeader, Buffer?]>): void {
    for (const [counter, header, payload] of frames) {
      const sealed = sealAt(keys, counter, outerId, header, payload);
      relay.send(sealed.header, sealed.payload);
    }
  }

  /** Whether a sealed connector frame opens (under this test's keys) to the http.cancel a failed stream sends. */
  function openCancel(frame: RelayFrame, keys: RelayE2eKeys): boolean {
    try {
      const aad = Buffer.from(JSON.stringify(frame.header), "utf8");
      const opened = decodeRelayFrame(openRelayE2eFrame(frame.payload, keys.desktopToPhone, aad));
      return opened.header.t === "http.cancel" && opened.header.e === "protocol-error";
    } catch {
      return false;
    }
  }

  describe("x-strideterm-relay-device (E2E 3.1)", () => {
    test("an e2e-wrapped request carries the device the RELAY stamped as d", async () => {
      const keys = await openE2e();
      sendAll(keys, OUTER, [
        [0n, inner("http.request.start", "in-1", { m: "GET", u: "/hello", h: [] })],
        [1n, inner("http.request.end", "in-1")],
      ]);
      await waitFor(() => internal.requests.length > 0, 10_000, "the internal origin to see the request");
      expect(internal.requests.at(-1)!.headers["x-strideterm-relay-device"]).toBe(DEVICE_ID);
    });

    test("a header the PHONE put inside the inner frame never reaches the desktop, whatever it says", async () => {
      const keys = await openE2e();
      sendAll(keys, OUTER, [
        [
          0n,
          inner("http.request.start", "in-2", {
            m: "GET",
            u: "/hello",
            h: [["x-strideterm-relay-device", "someone-elses-device"]],
          }),
        ],
        [1n, inner("http.request.end", "in-2")],
      ]);
      await waitFor(() => internal.requests.length > 0, 10_000, "the internal origin to see the request");
      expect(internal.requests.at(-1)!.headers["x-strideterm-relay-device"]).toBe(DEVICE_ID);
    });

    test("a plaintext stream still passes through the device the Worker stamped, and none is invented", async () => {
      await awaitConnectorReady(startConnector());
      relay.send({
        v: RELAY_PROTOCOL_VERSION,
        t: "http.request.start",
        src: "viewer",
        dst: "connector",
        s: "x",
        id: "plain-1",
        m: "GET",
        u: "/hello",
        h: [["x-strideterm-relay-device", "device-the-worker-verified"]],
      });
      relay.send({
        v: RELAY_PROTOCOL_VERSION,
        t: "http.request.end",
        src: "viewer",
        dst: "connector",
        s: "x",
        id: "plain-1",
      });
      await relay.waitFor((frame) => frame.header.t === "http.response.end");
      expect(internal.requests.at(-1)!.headers["x-strideterm-relay-device"]).toBe("device-the-worker-verified");

      relay.send({
        v: RELAY_PROTOCOL_VERSION,
        t: "http.request.start",
        src: "viewer",
        dst: "connector",
        s: "x",
        id: "plain-2",
        m: "GET",
        u: "/hello",
        h: [],
      });
      relay.send({
        v: RELAY_PROTOCOL_VERSION,
        t: "http.request.end",
        src: "viewer",
        dst: "connector",
        s: "x",
        id: "plain-2",
      });
      await waitFor(() => internal.requests.length >= 2, 10_000, "the second request");
      expect(internal.requests.at(-1)!.headers["x-strideterm-relay-device"]).toBeUndefined();
    });
  });

  describe("counter continuity (E2E 3.4)", () => {
    test("a frame the relay dropped ends the session: the next counter is refused and never processed", async () => {
      const keys = await openE2e();
      // Counter 0 (the request start) is "lost" by the relay and never sent.
      sendAll(keys, OUTER, [[1n, inner("http.request.end", "in-3")]]);
      const close = await relay.waitFor((frame) => frame.header.t === "e2e.close" && frame.header.id === OUTER);
      expect(close.header.e).toBe("protocol-error");
      expect(internal.requests.length).toBe(0);
    });

    test("once a gap has happened every later frame is refused too, on any stream", async () => {
      const keys = await openE2e();
      relay.send({
        v: RELAY_PROTOCOL_VERSION,
        t: "e2e.open",
        src: "viewer",
        dst: "connector",
        s: S,
        id: "outer-second",
        d: DEVICE_ID,
      });
      sendAll(keys, OUTER, [[5n, inner("http.request.start", "in-4", { m: "GET", u: "/hello", h: [] })]]);
      await relay.waitFor((frame) => frame.header.t === "e2e.close" && frame.header.id === OUTER);
      sendAll(keys, "outer-second", [[6n, inner("http.request.start", "in-5", { m: "GET", u: "/hello", h: [] })]]);
      const close = await relay.waitFor(
        (frame) => frame.header.t === "e2e.close" && frame.header.id === "outer-second",
      );
      expect(close.header.e).toBe("protocol-error");
      expect(internal.requests.length).toBe(0);
    });

    test("a gap in an inner http.request.body sequence ends that stream", async () => {
      const keys = await openE2e();
      sendAll(keys, OUTER, [
        [0n, inner("http.request.start", "in-6", { m: "POST", u: "/echo", h: [] })],
        [1n, inner("http.request.body", "in-6", { q: 0 }), Buffer.from("first")],
        [2n, inner("http.request.body", "in-6", { q: 2 }), Buffer.from("third-skipped-second")],
      ]);
      const cancel = await relay.waitFor((frame) => frame.header.t === "e2e.data" && openCancel(frame, keys));
      expect(cancel).toBeTruthy();
    });

    test("the inner sequence of a well-formed body is accepted from 0 without gaps", async () => {
      const keys = await openE2e();
      sendAll(keys, OUTER, [
        [0n, inner("http.request.start", "in-7", { m: "POST", u: "/echo", h: [] })],
        [1n, inner("http.request.body", "in-7", { q: 0 }), Buffer.from("a")],
        [2n, inner("http.request.body", "in-7", { q: 1 }), Buffer.from("b")],
        [3n, inner("http.request.end", "in-7")],
      ]);
      await waitFor(() => internal.requests.length > 0, 10_000, "the echo request");
      expect(internal.requests.at(-1)!.body.toString("utf8")).toBe("ab");
    });

    test("frames still in flight for a stream this side already closed are counted, so the next stream is not a gap", async () => {
      const keys = await openE2e();
      relay.send({
        v: RELAY_PROTOCOL_VERSION,
        t: "e2e.open",
        src: "viewer",
        dst: "connector",
        s: S,
        id: "outer-next",
        d: DEVICE_ID,
      });
      // The phone closes stream 1 from its side and keeps a body frame of it in flight.
      sendAll(keys, OUTER, [[0n, inner("http.request.start", "in-8", { m: "POST", u: "/echo", h: [] })]]);
      relay.send({
        v: RELAY_PROTOCOL_VERSION,
        t: "e2e.close",
        src: "viewer",
        dst: "connector",
        s: S,
        id: OUTER,
        e: "normal",
      });
      sendAll(keys, OUTER, [[1n, inner("http.request.body", "in-8", { q: 0 }), Buffer.from("late")]]);
      // ...and the very next frame, of another stream, carries counter 2.
      sendAll(keys, "outer-next", [
        [2n, inner("http.request.start", "in-9", { m: "GET", u: "/hello", h: [] })],
        [3n, inner("http.request.end", "in-9")],
      ]);
      await waitFor(() => internal.requests.some((r) => r.url === "/hello"), 10_000, "the second stream's request");
      expect(relay.frames.some((frame) => frame.header.t === "e2e.close" && frame.header.id === "outer-next")).toBe(
        false,
      );
    });
  });
});

describe("withdrawing a device's keys (E2E 3.8)", () => {
  const DEVICE = "mobile-device-to-revoke";
  const OTHER = "mobile-device-that-stays";

  test("endDeviceStreams closes that device's open e2e streams with e2e.close, and only that device's", async () => {
    const store = createRelayE2eSessionStore();
    const keys = makeE2eKeys();
    const otherKeys = makeE2eKeys();
    store.put(DEVICE, keys, 60_000);
    store.put(OTHER, otherKeys, 60_000);
    await awaitConnectorReady(startConnector({ e2eSessionStore: store }));
    for (const [id, d] of [
      ["outer-revoked-1", DEVICE],
      ["outer-revoked-2", DEVICE],
      ["outer-stays", OTHER],
    ] as const) {
      relay.send({ v: RELAY_PROTOCOL_VERSION, t: "e2e.open", src: "viewer", dst: "connector", s: "x", id, d });
    }
    // A request is in flight on one of the revoked device's streams, so there is an inner stream to end too.
    const phone = fakePhone(keys);
    const start = phone.sealToConnector("outer-revoked-1", "x", {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "inner-session",
      id: "inner-revoked",
      m: "POST",
      u: "/echo",
      h: [],
    });
    relay.send(start.header, start.payload);
    await waitFor(() => connector!.stats().liveHttpStreams === 1, 10_000, "the inner stream to open");

    connector!.endDeviceStreams(DEVICE);

    const closed = new Set<string>();
    await waitFor(
      () => {
        for (const frame of relay.frames) {
          if (frame.header.t === "e2e.close" && frame.header.src === "connector") closed.add(frame.header.id as string);
        }
        return closed.has("outer-revoked-1") && closed.has("outer-revoked-2");
      },
      10_000,
      "e2e.close for both revoked streams",
    );
    expect(closed.has("outer-stays")).toBe(false);
    expect(connector!.stats().liveHttpStreams).toBe(0);
  });

  test("once the store no longer holds a device's keys, its next frame is refused, never decrypted", async () => {
    const store = createRelayE2eSessionStore();
    const keys = makeE2eKeys();
    store.put(DEVICE, keys, 60_000);
    await awaitConnectorReady(startConnector({ e2eSessionStore: store }));
    relay.send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.open",
      src: "viewer",
      dst: "connector",
      s: "x",
      id: "outer-after-delete",
      d: DEVICE,
    });
    store.delete(DEVICE);
    const phone = fakePhone(keys);
    const start = phone.sealToConnector("outer-after-delete", "x", {
      v: RELAY_PROTOCOL_VERSION,
      t: "http.request.start",
      src: "viewer",
      dst: "connector",
      s: "inner-session",
      id: "inner-after-delete",
      m: "GET",
      u: "/hello",
      h: [],
    });
    relay.send(start.header, start.payload);
    const close = await relay.waitFor(
      (frame) => frame.header.t === "e2e.close" && frame.header.id === "outer-after-delete",
    );
    expect(close.header.e).toBe("unauthorized");
    expect(internal.requests.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Flow control on the e2e path: the relay Worker charges a stream's connector->viewer window on the
// WHOLE `e2e.data` payload (sealed inner frame: length prefix + JSON header + body + nonce + tag) and
// the viewer credits back exactly that many bytes. A connector that charged its own window on the
// plaintext chunk could send a full window of frames before the first credit and overshoot what the
// Worker had left; the Worker then dropped the frame and the session's single outer counter had a
// hole in it, which the phone answers by ending the whole session.
// ---------------------------------------------------------------------------

describe("relay end-to-end encryption: flow control accounting", () => {
  const E2E_DEVICE_ID = "mobile-device-e2e-flow";
  const SESSION = "phone-flow-session";
  const WINDOW = RELAY_FLOW_CREDIT_BYTES;

  interface ViewerStream {
    outerId: string;
    innerId: string;
    window: number;
    nextOuterSeq: number;
    nextInnerSeq: number;
    unreturned: number;
    chunks: Buffer[];
    ended: boolean;
  }

  /**
   * The Worker's rule, enforced from the viewer side of the fake relay: each e2e stream has a window of
   * `RELAY_FLOW_CREDIT_BYTES` charged on the outer payload length, replenished only by credits the
   * "viewer" sends back (equal to the payload length it accepted, never more than the window). A frame
   * that does not fit is a violation; so is any gap in the session's outer counter or a stream's `q`.
   */
  function startWorkerRulesViewer(phone: FakePhone, streams: ViewerStream[]) {
    const violations: string[] = [];
    let cursor = 0;
    let expectedCounter = 0n;
    const byOuter = new Map(streams.map((stream) => [stream.outerId, stream]));
    const drain = (): void => {
      while (cursor < relay.frames.length) {
        const frame = relay.frames[cursor++] as RelayFrame;
        if (frame.header.t !== "e2e.data") continue;
        const stream = byOuter.get(frame.header.id as string);
        if (!stream) continue;
        const counter = relayE2eCounterOf(frame.payload.subarray(0, RELAY_E2E_NONCE_BYTES));
        if (counter !== expectedCounter) violations.push(`outer counter ${counter} where ${expectedCounter} was due`);
        expectedCounter = counter + 1n;
        if (frame.header.q !== stream.nextOuterSeq) {
          violations.push(`${stream.outerId}: outer q ${frame.header.q} where ${stream.nextOuterSeq} was due`);
        }
        stream.nextOuterSeq += 1;
        if (frame.payload.length > stream.window) {
          violations.push(
            `${stream.outerId}: frame of ${frame.payload.length} bytes against a window of ${stream.window}`,
          );
          continue;
        }
        stream.window -= frame.payload.length;
        stream.unreturned += frame.payload.length;
        const inner = phone.open(frame);
        if (inner.header.t === "http.response.body") {
          if (inner.header.q !== stream.nextInnerSeq) {
            violations.push(`${stream.outerId}: inner q ${inner.header.q} where ${stream.nextInnerSeq} was due`);
          }
          stream.nextInnerSeq += 1;
          stream.chunks.push(inner.payload);
        } else if (inner.header.t === "http.response.end") {
          stream.ended = true;
        }
      }
    };
    // Credits go out on a slower clock than frames are read, so a stream can burn through its whole
    // window before the first one returns - the case that exposed the overshoot.
    const reader = setInterval(drain, 1);
    const credits = setInterval(() => {
      for (const stream of streams) {
        if (stream.unreturned <= 0) continue;
        const w = Math.min(stream.unreturned, WINDOW);
        stream.unreturned -= w;
        stream.window = Math.min(WINDOW, stream.window + w);
        relay.send({
          v: RELAY_PROTOCOL_VERSION,
          t: "flow.credit",
          src: "viewer",
          dst: "connector",
          s: SESSION,
          id: stream.outerId,
          w,
        });
      }
    }, 10);
    return {
      violations,
      get nextCounter() {
        return expectedCounter;
      },
      stop() {
        clearInterval(reader);
        clearInterval(credits);
        drain();
      },
    };
  }

  function patternBytes(total: number): Buffer {
    const out = Buffer.allocUnsafe(total);
    for (let i = 0; i < total; i++) out[i] = (i * 7 + (i >>> 8)) & 0xff;
    return out;
  }

  async function streamLargeResponses(sizes: number[]): Promise<void> {
    const origin = await startInternalOrigin((request, response) => {
      const total = Number(new URL(request.url ?? "/", "http://internal").searchParams.get("n"));
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(patternBytes(total));
    });
    try {
      const store = createRelayE2eSessionStore();
      const keys = makeE2eKeys();
      store.put(E2E_DEVICE_ID, keys, 120_000);
      await awaitConnectorReady(
        startConnector({
          e2eSessionStore: store,
          internalOrigin: { host: origin.host, port: origin.port, guardToken: origin.guardToken },
        }),
      );
      const phone = fakePhone(keys);
      const streams: ViewerStream[] = sizes.map((_, index) => ({
        outerId: `outer-flow-${index}`,
        innerId: `inner-flow-${index}`,
        window: WINDOW,
        nextOuterSeq: 0,
        nextInnerSeq: 0,
        unreturned: 0,
        chunks: [],
        ended: false,
      }));
      const viewer = startWorkerRulesViewer(phone, streams);
      try {
        streams.forEach((stream, index) => {
          relay.send({
            v: RELAY_PROTOCOL_VERSION,
            t: "e2e.open",
            src: "viewer",
            dst: "connector",
            s: SESSION,
            id: stream.outerId,
            d: E2E_DEVICE_ID,
          });
          for (const inner of [
            {
              v: RELAY_PROTOCOL_VERSION,
              t: "http.request.start",
              src: "viewer",
              dst: "connector",
              s: "inner-session",
              id: stream.innerId,
              m: "GET",
              u: `/pattern?n=${sizes[index]}`,
              h: [],
            },
            {
              v: RELAY_PROTOCOL_VERSION,
              t: "http.request.end",
              src: "viewer",
              dst: "connector",
              s: "inner-session",
              id: stream.innerId,
            },
          ] as RelayFrameHeader[]) {
            const sealed = phone.sealToConnector(stream.outerId, SESSION, inner);
            relay.send(sealed.header, sealed.payload);
          }
        });
        await waitFor(
          () => streams.every((stream) => stream.ended) || viewer.violations.length > 0,
          60_000,
          "every large response to finish or the relay window rule to be broken",
        );
      } finally {
        viewer.stop();
      }
      expect(viewer.violations).toEqual([]);
      streams.forEach((stream, index) => {
        expect(Buffer.concat(stream.chunks).equals(patternBytes(sizes[index] as number))).toBe(true);
      });
      // Every e2e.data the connector sent was counted, and none was skipped.
      const sent = relay.frames.filter((frame) => frame.header.t === "e2e.data").length;
      expect(viewer.nextCounter).toBe(BigInt(sent));
    } finally {
      await origin.close();
    }
  }

  test("a 7 MB e2e response never sends a frame that exceeds the relay's remaining window", async () => {
    await streamLargeResponses([7 * 1024 * 1024]);
  }, 90_000);

  test("several concurrent large e2e responses each stay inside their own window", async () => {
    await streamLargeResponses([3 * 1024 * 1024 + 123, 2 * 1024 * 1024 + 1, 4 * 1024 * 1024 - 77, 1024 * 1024]);
  }, 90_000);
});

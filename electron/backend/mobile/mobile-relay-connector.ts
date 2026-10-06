/// <reference types="node" />
/**
 * The desktop half of the managed relay: one outbound WebSocket to the relay, and a bridge from the
 * frames it carries to this installation's own remote server.
 *
 * A PLAIN MODULE, NOT A PROCESS (plan §5.3). It runs inside the Electron backend in packaged and
 * dev mode alike — no sidecar binary, nothing to install, nothing extra to keep alive or kill.
 *
 * THE ONE PLACE IT COULD HAVE GONE WRONG. A bridge that takes a target from the network is an open
 * proxy into loopback and the LAN. This one cannot: `validateRequestTarget` (in the shared frame
 * codec) refuses anything that is not origin-form before the frame is even accepted, and this file
 * then resolves what survives against exactly one origin — `internalOrigin`, which the relay manager
 * supplies and no frame can influence. There is no code path here that builds a URL from a relay
 * message.
 *
 * WHAT ELSE IT REWRITES, AND WHY THAT LIST IS SHORT. `Host` and `Origin` become the internal
 * origin's, because the desktop's own CSRF check compares them and would otherwise refuse every
 * relayed upgrade. `X-Forwarded-Proto: https` is added so the desktop marks its session cookie
 * `Secure` — the browser reached the relay over TLS even though this hop did not. `Accept-Encoding`
 * is forced to `identity` so no response ever carries a `Content-Encoding` the relay would have to
 * preserve byte-perfectly across two hops. Everything else — cookies included, which is how the
 * WebView's session actually works — passes through untouched.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import zlib from "node:zlib";
import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";

import { getLogger } from "../logger.js";
import {
  decodeRelayFrame,
  encodeRelayFrame,
  RELAY_CONNECTOR_HANDSHAKE_TIMEOUT_MS,
  RELAY_CONNECTOR_HEARTBEAT_MS,
  RELAY_CONNECTOR_HEARTBEAT_TIMEOUT_MS,
  RELAY_CONNECTOR_SYNC_TIMEOUT_MS,
  RELAY_CONNECTOR_SUBPROTOCOL,
  RELAY_FLOW_CREDIT_BYTES,
  RELAY_GRANT_DEFINITIVE_REFUSAL_RETRY_DELAY_MS,
  RELAY_HTTP_REQUEST_TIMEOUT_MS,
  RELAY_MAX_HTTP_REQUEST_BODY_BYTES,
  RELAY_MAX_HTTP_RESPONSE_BODY_BYTES,
  RELAY_MAX_WS_MESSAGE_BYTES,
  RELAY_PROTOCOL_VERSION,
  RELAY_RECONNECT_BASE_DELAY_MS,
  RELAY_RECONNECT_MAX_DELAY_MS,
  RELAY_STREAM_QUEUE_BYTES,
  RelayFrameError,
  relayConnectorChallengeTranscript,
  type RelayFrameHeader,
  type RelayHeaderList,
  type RelayReason,
} from "./mobile-relay-protocol.js";
import { MobileRelayGrantDefinitiveRefusalError } from "./mobile-firebase-transport.js";
import type { RelayInstallationIdentity } from "./mobile-relay-identity.js";
import {
  RELAY_E2E_NONCE_BYTES,
  openRelayE2eFrame,
  relayE2eCounterOf,
  sealRelayE2eFrame,
  type RelayE2eKeys,
} from "./mobile-crypto.js";
import type { RelayE2eSessionStore } from "./mobile-relay-e2e-session-store.js";
import type { SystemChannelConnection } from "./mobile-system-channel.js";

const log = getLogger("mobile-relay-connector");

/**
 * The AEAD counters of one derived-key object, shared by EVERY connector instance in this process.
 *
 * WHY THEY LIVE HERE AND NOT IN THE CONNECTOR. The keys live in the process-wide session store for the
 * ticket's whole TTL, but the counters used to live in each connector instance. Pausing and re-enabling
 * the relay builds a new connector over the same store: its counters restarted at 0 under the SAME
 * `desktopToPhone` key, so the desktop sealed a second, different frame under nonce 0 — AES-GCM nonce
 * reuse, which leaks the XOR of the plaintexts and the GHASH key. (The same hole opened whenever
 * `endDeviceStreams` dropped the connector's entry while the store still held the keys.) Keyed by the
 * key object itself, in a WeakMap, the counters are exactly as long-lived as the key they belong to: a
 * new connector continues them, a replaced key starts fresh ones, and nothing outlives the key.
 * The inbound side is shared for the same reason: the phone keeps counting across our restart, and a
 * restarted -1 would refuse its next frame as a gap.
 */
interface E2eKeyCounters {
  /** Next counter used to seal a desktop→phone frame under the key. */
  out: bigint;
  /** Highest counter accepted from the phone under the key; -1 (none yet). */
  in: bigint;
}
const e2eCountersByKeys = new WeakMap<RelayE2eKeys, E2eKeyCounters>();
function e2eCountersFor(keys: RelayE2eKeys): E2eKeyCounters {
  let counters = e2eCountersByKeys.get(keys);
  if (!counters) {
    counters = { out: 0n, in: -1n };
    e2eCountersByKeys.set(keys, counters);
  }
  return counters;
}
const E2E_OUT_COUNTER_LIMIT = 1n << 64n;

/**
 * The relay's own short reference for an identifier (`relay/worker/src/log.ts` `relayRef`, FNV-1a, 8 hex
 * digits), mirrored byte for byte so a desktop log line and a relay log line about the same session can
 * be matched without either side writing the raw session id (production 2026-10-05: ten reconnects a day
 * could not be lined up with the relay's `do.connector.closed`).
 */
function relayRef(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** A relay-supplied close reason is logged only when it is a short closed-vocabulary token, never free text. */
function sanitizeCloseReason(reason: Buffer | string | undefined): string | undefined {
  const text = typeof reason === "string" ? reason : reason?.toString("utf8");
  return text && /^[a-z][a-z0-9-]{0,39}$/.test(text) ? text : undefined;
}

/**
 * The reason an OUTER `e2e.close` from this side may carry. The phone treats `unauthorized` and
 * `protocol-error` from the connector as "the whole session is refused" and re-keys (relay_e2e_proxy.dart),
 * which is right for a counter gap and wrong for one stream that merely ended badly here (an upload past
 * its bound, an early reply, a queue overflow). Those map to `normal`: the phone still fails that one
 * stream on ANY `e2e.close`, and the real cause is in this side's log.
 */
function streamScopedCloseReason(reason: RelayReason): RelayReason {
  return reason === "protocol-error" || reason === "unauthorized" ? "normal" : reason;
}

/** The largest slice of a body this connector puts in one frame. */
const BODY_CHUNK_BYTES = 256 * 1024;

/** AES-GCM authentication tag appended by `sealRelayE2eFrame` (the nonce is `RELAY_E2E_NONCE_BYTES`). */
const E2E_AEAD_TAG_BYTES = 16;

/**
 * Whether an HTTP response's body is worth deflating before it crosses the e2e boundary (plan
 * 2026-09-23, decision 4): the static client bundle — JavaScript, CSS, SVG and fonts — which is where
 * the bytes are and which the browser will otherwise receive uncompressed, since the request into this
 * connector's own internal origin already asks for `identity` (`inboundHeaders`) and nothing upstream
 * of it compresses on the connector's behalf.
 *
 * NOT dynamic responses (`application/json`, `text/html`, `text/plain`, `+json`): compressing before
 * encrypting makes the ciphertext length depend on the content, which leaks it to anyone who can vary
 * part of a response that sits next to a secret (CRIME/BREACH). `/api/state` carries names and paths
 * a terminal user can choose. The gain on those is kilobytes against a megabyte bundle, so the trade
 * is all risk. Never a `Content-Encoding` this response already carries — this connector does not
 * re-encode an encoding it does not understand.
 */
const COMPRESSIBLE_ESSENCES = new Set([
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
  "text/css",
  "image/svg+xml",
  "application/vnd.ms-fontobject",
  "application/x-font-ttf",
  "application/x-font-opentype",
  "application/x-font-truetype",
  "application/font-sfnt",
]);

function isCompressibleResponse(response: IncomingMessage): boolean {
  if (response.headers["content-encoding"]) return false;
  const contentType = response.headers["content-type"];
  const essence = (Array.isArray(contentType) ? contentType[0] : contentType)?.split(";")[0]?.trim().toLowerCase();
  if (!essence) return false;
  // Every `font/*` subtype: listing them one by one is how one gets missed.
  return essence.startsWith("font/") || COMPRESSIBLE_ESSENCES.has(essence);
}

/**
 * The header the desktop's loopback remote-server reads as the relay's statement of WHICH device is
 * presenting a request (ticket binding, per-device bootstrap rate limit). Only the connector may set
 * it: from `d` on an e2e-wrapped stream, from the Worker's own stamp on a plaintext one.
 */
const RELAY_DEVICE_HEADER = "x-strideterm-relay-device";

/**
 * Request headers the connector never forwards inward.
 *
 * Hop-by-hop headers describe the browser↔relay hop and mean nothing on this one. `host` and
 * `origin` are replaced rather than dropped. `x-strideterm-relay-origin` is dropped so a viewer
 * cannot supply its own guard value — the connector sets the real one afterwards. `x-strideterm-relay-device`
 * is dropped for the same reason: on an e2e-wrapped stream the inner frame is composed by the phone, so
 * whatever it carries is the phone's claim — the connector sets the relay's own (`d`) afterwards.
 * `content-length`
 * is dropped because this connector re-frames the body and Node recomputes it.
 */
const DROPPED_INBOUND_HEADERS = new Set([
  "host",
  "origin",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
  "x-strideterm-relay-origin",
  RELAY_DEVICE_HEADER,
  "x-forwarded-proto",
  "x-forwarded-for",
  "x-forwarded-host",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
]);

export type RelayConnectorState =
  | "idle"
  | "connecting"
  | "authenticating"
  /**
   * The key is proven and the relay has asked for this desktop's revocations (protocol v2, plan §3).
   *
   * A state of its own rather than a longer `authenticating`, because the two fail for different
   * reasons and a diagnostic that cannot tell them apart is a diagnostic that sends someone looking
   * at the wrong half: `authenticating` means the relay has not accepted the key, `syncing` means it
   * has and this side has not finished answering.
   */
  | "syncing"
  | "ready"
  | "draining"
  | "closed";

export interface RelayInternalOrigin {
  host: string;
  port: number;
  guardToken: string;
}

/** One device this desktop has cut off, as the relay needs to hear about it. */
export interface RelayRevocationRecord {
  deviceId: string;
  /** When this desktop recorded the revocation. Epoch milliseconds. */
  revokedAt: number;
}

export interface RelayConnectorOptions {
  /** Exact relay origin, e.g. `https://relay.strideterm.dev` or `http://127.0.0.1:8787`. */
  relayOrigin: string;
  identity: RelayInstallationIdentity;
  internalOrigin: RelayInternalOrigin;
  /** Fetches a FRESH connector grant. Called on every connection attempt — grants are short-lived. */
  getGrant: () => Promise<string>;
  /**
   * Every revocation this desktop still considers relevant, read at the moment the relay asks.
   *
   * SYNCHRONOUS AND A SNAPSHOT, on purpose (plan §3.3). Synchronous because the relay is waiting and
   * an await here would be a window; a snapshot because the answer has to be "what the persistent
   * device store says right now", not "what this connector happens to have been told since it
   * started". The runtime wires it to `MobileDeviceStore`, which is the state file — so a revoke that
   * happened while this process was not running is in the answer, which is the entire point.
   *
   * Absent in a test that does not care, in which case nothing is replayed and the sync completes
   * immediately. Production always passes it.
   */
  listRelayRevocations?: () => RelayRevocationRecord[];
  onStateChange?: (state: RelayConnectorState) => void;
  /** Injectable so a test can drive reconnection without waiting real seconds. */
  reconnectDelayMs?: (attempt: number) => number;
  /**
   * How long to wait before asking for another grant after a DEFINITIVE refusal — the entitlement
   * itself, not the network (plan §6, package 2). Injectable for the same reason `reconnectDelayMs`
   * is. Defaults to the shared `RELAY_GRANT_DEFINITIVE_REFUSAL_RETRY_DELAY_MS`, deliberately fixed
   * rather than exponential: a lapsed entitlement does not become less lapsed by waiting longer, and
   * this is what lets a resubscribe be picked up automatically without restarting the app.
   */
  definitiveRefusalRetryDelayMs?: () => number;
  /**
   * How long an open socket may stay un-ready before it is closed and retried.
   *
   * Defaults to the shared `RELAY_CONNECTOR_HANDSHAKE_TIMEOUT_MS`, which is also the deadline the
   * relay stamps on its own pending attachment, so both ends give up together. Injectable for the
   * same reason `reconnectDelayMs` is: a test must be able to reach the timeout in milliseconds.
   */
  handshakeTimeoutMs?: number;
  /**
   * How long the revocation-sync phase may take before the socket is closed and retried.
   *
   * Defaults to the shared `RELAY_CONNECTOR_SYNC_TIMEOUT_MS`, which is also what the relay stamps on
   * its own pending attachment. Injectable for the same reason the handshake one is.
   */
  syncTimeoutMs?: number;
  /** Injectable purely so tests can observe the socket; production always builds a real one. */
  createSocket?: (url: string, protocols: string[], options?: { headers: Record<string, string> }) => WebSocket;
  /**
   * Where the derived relay end-to-end encryption keys live, keyed by `mobileDeviceId` (plan
   * 2026-09-23, decisions 1/2). Absent on an older build with no e2e support wired at all — every
   * `e2e.*` frame is then refused (`e2e.open` gets `unauthorized`), never treated as a reason to fall
   * back to plaintext for a stream that was never plaintext to begin with.
   */
  e2eSessionStore?: RelayE2eSessionStore;
  /** Authenticated native system-channel streams; kept separate from the loopback WebView proxy. */
  systemChannel?: {
    open(input: {
      connectionId: string;
      deviceId: string;
      send: (sequence: number, ciphertext: Buffer) => boolean;
      close: (reason: RelayReason) => void;
    }): SystemChannelConnection | null;
    revokeDevice?: (deviceId: string) => void;
  };
  /**
   * How long an HTTP request may make no progress before it is failed with `timeout`. Defaults to the
   * shared `RELAY_HTTP_REQUEST_TIMEOUT_MS`. Injectable so a test can show that a slow upload outlives
   * it without waiting 30 real seconds.
   */
  httpRequestTimeoutMs?: number;
}

interface HttpStream {
  request: http.ClientRequest;
  /** Flow-control window towards the relay, in bytes. */
  window: number;
  /** Bytes queued because the window is exhausted. */
  queue: Buffer[];
  queuedBytes: number;
  /** Next sequence number for an outbound `http.response.body`. */
  outSeq: number;
  /** Highest sequence accepted from the relay on this stream. */
  inSeq: number;
  response: IncomingMessage | null;
  bytesOut: number;
  /**
   * Cumulative request-body bytes accepted so far. The plaintext path is already bounded by the
   * Worker before a byte reaches this connector; an e2e-wrapped one is not — the Worker cannot see
   * an inner frame at all (plan 2026-09-23, §P3 acceptance) — so this is the ONLY enforcement of
   * `RELAY_MAX_HTTP_REQUEST_BODY_BYTES` for that path, and it costs the plaintext path nothing to
   * share it.
   */
  bytesIn: number;
  ended: boolean;
  timer: NodeJS.Timeout | null;
  /**
   * Non-null while this response's body is being accumulated for deflate (plan 2026-09-23,
   * decision 4) rather than relayed as it arrives — set once, at `http.response.start` time, for an
   * e2e-wrapped stream whose response is text-typed and carries no `Content-Encoding` of its own.
   * Null for every other stream: the ordinary flow-controlled pass-through this connector already
   * did before decision 4 existed, byte for byte.
   */
  pendingRawChunks: Buffer[] | null;
}

interface WsStream {
  socket: WebSocket;
  window: number;
  /** `final` is false on every fragment but the last of one browser message. */
  queue: { data: Buffer; binary: boolean; final: boolean }[];
  queuedBytes: number;
  outSeq: number;
  inSeq: number;
  opened: boolean;
  /**
   * An e2e stream's own end (local socket closed or errored), held until the data queued before it
   * has gone out and the window can take it: sealed without that check, the relay may drop the frame
   * and the phone's single per-session counter is left with a hole.
   */
  pendingClose: RelayFrameHeader | null;
}

export interface RelayConnector {
  start(): void;
  stop(): Promise<void>;
  state(): RelayConnectorState;
  /** Tells the relay a device is revoked, so a grant minted seconds ago cannot still open a session. */
  revokeDevice(mobileDeviceId: string, revokedAt?: number): void;
  /**
   * Ends every e2e stream of `mobileDeviceId` now — each inner stream is torn down and the phone is
   * told with an `e2e.close` — and forgets the connector's counters for the device. Used when the
   * device's keys are withdrawn (revocation): without it a stream that is already open would keep
   * running until its next frame happened to fail, which for an idle WebSocket can be never.
   */
  endDeviceStreams(mobileDeviceId: string): void;
  /** Diagnostics for the local harness and the debug UI — counts and states only, never payload. */
  stats(): {
    state: RelayConnectorState;
    connects: number;
    httpStreams: number;
    wsStreams: number;
    liveHttpStreams: number;
    liveWsStreams: number;
    liveSystemStreams?: number;
    bytesIn: number;
    bytesOut: number;
    overflows: number;
    reconnects: number;
    revocationsReplayed: number;
    lastError: string;
  };
}

/** An errno-style code (ECONNRESET, ETIMEDOUT, WS_ERR_...) or else the error class name; never the message. */
function sanitizeSocketError(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return code;
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name) ? error.name : "Error";
}

export function createRelayConnector(options: RelayConnectorOptions): RelayConnector {
  const reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelay;
  const definitiveRefusalRetryDelayMs = options.definitiveRefusalRetryDelayMs ?? defaultDefinitiveRefusalRetryDelay;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? RELAY_CONNECTOR_HANDSHAKE_TIMEOUT_MS;
  const syncTimeoutMs = options.syncTimeoutMs ?? RELAY_CONNECTOR_SYNC_TIMEOUT_MS;
  const httpRequestTimeoutMs = options.httpRequestTimeoutMs ?? RELAY_HTTP_REQUEST_TIMEOUT_MS;
  const createSocket =
    options.createSocket ??
    ((url: string, protocols: string[], socketOptions?: { headers: Record<string, string> }) =>
      new WebSocket(url, protocols, socketOptions));

  /**
   * One keep-alive agent for every request into the internal origin, owned by this connector.
   *
   * Node's global agent has kept connections alive by default since v19, and a pooled socket into a
   * server that is being shut down is a server that never finishes shutting down — observed for
   * real: turning the relay off left `server.close()` waiting on an idle pooled socket, so the
   * loopback listener stayed bound and the relay could not be turned back on. Owning the agent
   * means `stop()` can end those sockets, which is the only way this connector can promise that
   * "off" means gone.
   */
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });

  let socket: WebSocket | null = null;
  let sessionId = "";
  let state: RelayConnectorState = "idle";
  let stopped = true;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  /**
   * Inbound-silence watchdog state (production 2026-10-05: the TCP path died silently about ten times a
   * day and the desktop noticed only when a heartbeat WRITE failed, which can take minutes because a
   * write into a dead path succeeds locally). `lastInboundAt` is the arrival of ANY frame from the relay;
   * `heartbeatEchoSeen` is feature detection — only a relay that has echoed a `conn.heartbeat` on THIS
   * connection can be held to the silence deadline, so an older relay that never echoes does not put
   * the connector in a reconnect loop.
   */
  let lastInboundAt = 0;
  let heartbeatEchoSeen = false;
  /** Set when OUR side ends the socket (watchdog), so the close log can say who ended it. */
  let localCloseCause: string | null = null;
  /**
   * Fires if `conn.ready` never arrives (review 1 finding 5).
   *
   * Without it, a socket that opened and then stopped progressing sat in `authenticating` forever:
   * nothing on this side re-checked, and the relay's own handshake deadline was only consulted when
   * a frame arrived, which is exactly the frame that never came. The heartbeat timeout was not a
   * backstop either — heartbeats only start once the connector IS ready.
   */
  let handshakeTimer: NodeJS.Timeout | null = null;

  const httpStreams = new Map<string, HttpStream>();
  const wsStreams = new Map<string, WsStream>();
  const systemStreams = new Map<string, SystemChannelConnection>();
  const systemClosingFromRelay = new Set<string>();

  // ---------------------------------------------------------------------------
  // Relay end-to-end encryption state (plan 2026-09-23, decisions 1/2). Every map here is emptied on
  // reconnect (`onDisconnected`) EXCEPT `e2eDeviceSessions` — the derived key is tied to the ticket's
  // own TTL (`mobile-relay-e2e-session-store.ts`), not to this socket, and its counters (kept per key
  // object in `e2eCountersByKeys`, so they survive even a new connector instance) must keep
  // advancing rather than resetting, or the same key could seal two different frames under one nonce.
  // ---------------------------------------------------------------------------

  interface E2eDeviceSession {
    keys: RelayE2eKeys;
    /** Local, non-secret identity for this derived-key generation. Never reset on counter wrap. */
    generation: bigint;
    /** Counters of `keys`, shared with every other connector instance in this process. */
    counters: E2eKeyCounters;
  }
  const e2eDeviceSessions = new Map<string, E2eDeviceSession>();
  interface E2eStreamOwner {
    deviceId: string;
    generation: bigint;
  }
  /** The outer e2e stream id → device and key generation from its relay-stamped `e2e.open`. */
  const e2eOuterDeviceId = new Map<string, E2eStreamOwner>();
  /**
   * Outer streams that ended here, with their non-secret owner generation, most recent last. Under
   * the same generation, frames already in flight still have to be authenticated and counted so the
   * next stream does not see a counter gap. A replacement key invalidates the tombstone immediately.
   * Bounded: old entries fall out, and a frame for an id never seen here is refused.
   */
  const e2eEndedOuterDevice = new Map<string, E2eStreamOwner>();
  const MAX_ENDED_OUTER_STREAMS = 512;
  /** The outer e2e stream id → the INNER frame id it carries, learned from the first `e2e.data`. */
  const e2eOuterToInner = new Map<string, string>();
  const e2eExhaustedDevices = new Set<string>();
  /** The inner frame id → its outer wrapping, so `send()` can intercept and re-wrap a plain reply. */
  const e2eInnerToOuter = new Map<string, E2eStreamOwner & { outerId: string }>();
  /** Per-outer-stream outgoing sequence for `e2e.data`'s `q` — bookkeeping only; the Worker does not
   *  enforce ordering on it (the AEAD nonce counter is what actually protects the channel). */
  const e2eOuterSeq = new Map<string, number>();

  /**
   * The device's current derived-key session, or null if none is on offer (an unpaired build, an
   * expired ticket, or a device this connector has never derived a key for). The counters here are
   * start at zero ONLY for a `RelayE2eKeys` object that has never been used (`e2eCountersFor`) —
   * `put()` in `mobile-relay-e2e-session-store.ts` replaces the whole entry on a fresh
   * `remote.webSession.issue`, so a new object reference is a new key, and only a new key may start its
   * nonce counter over. The local `generation` is per connector instance and says nothing about nonces.
   */
  let nextE2eGeneration = 1n;
  function e2eSessionFor(deviceId: string): E2eDeviceSession | null {
    const keys = options.e2eSessionStore?.get(deviceId) ?? null;
    if (!keys) {
      e2eDeviceSessions.delete(deviceId);
      return null;
    }
    const existing = e2eDeviceSessions.get(deviceId);
    if (existing && existing.keys === keys) {
      return e2eExhaustedDevices.has(deviceId) ? null : existing;
    }
    e2eExhaustedDevices.delete(deviceId);
    const fresh: E2eDeviceSession = { keys, generation: nextE2eGeneration++, counters: e2eCountersFor(keys) };
    e2eDeviceSessions.set(deviceId, fresh);
    // A key whose counter space ran out under an earlier instance stays unusable for sealing.
    if (fresh.counters.out >= E2E_OUT_COUNTER_LIMIT) {
      e2eExhaustedDevices.add(deviceId);
      return null;
    }
    return fresh;
  }

  function nextE2eOuterSeq(outerId: string): number {
    const next = e2eOuterSeq.get(outerId) ?? 0;
    e2eOuterSeq.set(outerId, next + 1);
    return next;
  }

  /** Ends one multiplexed e2e stream: forgets its wiring and, if an inner stream ever existed, ends it. */
  function endE2eOuterStream(outerId: string, reason: RelayReason): void {
    const innerId = e2eOuterToInner.get(outerId);
    e2eOuterToInner.delete(outerId);
    const endedOwner = e2eOuterDeviceId.get(outerId);
    if (endedOwner) {
      e2eEndedOuterDevice.delete(outerId);
      e2eEndedOuterDevice.set(outerId, endedOwner);
      if (e2eEndedOuterDevice.size > MAX_ENDED_OUTER_STREAMS) {
        e2eEndedOuterDevice.delete(e2eEndedOuterDevice.keys().next().value as string);
      }
    }
    e2eOuterDeviceId.delete(outerId);
    e2eOuterSeq.delete(outerId);
    if (innerId) {
      e2eInnerToOuter.delete(innerId);
      endHttpStream(innerId, reason);
      endWsStream(innerId, 1011, reason);
    }
  }

  /**
   * Same local cleanup as {@link endE2eOuterStream}, PLUS an outer `e2e.close` sent to the relay —
   * the two are separate functions because `endE2eBadFrame` (a frame that failed to authenticate)
   * has no key it could seal a WRAPPED reply under either, so it already sends its own unwrapped
   * `e2e.close` before calling the local-only cleanup. This is the sibling for the OTHER place a
   * stream can die from this side: `sendE2eWrapped` failing to deliver an outgoing frame at all.
   */
  function endE2eOuterStreamAndNotify(outerId: string, reason: RelayReason): void {
    send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.close",
      src: "connector",
      dst: "viewer",
      s: sessionId,
      id: outerId,
      e: reason,
    });
    endE2eOuterStream(outerId, reason);
  }

  /**
   * Ends ONE e2e inner stream from this side and tells the phone with a stream-scoped outer
   * `e2e.close` (see {@link streamScopedCloseReason}). Returns false for a plaintext stream, which the
   * caller ends the way it always did.
   *
   * WHY NOT A SEALED `http.cancel` / `ws.close` / `flow.overflow`. Those are `e2e.data` the relay charges
   * against the stream's window; sealed while the window is spent they can be dropped, and every dropped
   * sealed frame is a counter gap that makes the phone refuse the whole session. The outer close is
   * unsealed (it consumes no counter) and costs no window. The phone ignored the inner `http.cancel`
   * anyway, so the stream used to just hang until its own timeout.
   */
  function endE2eInnerStream(streamId: string, reason: RelayReason): boolean {
    const wrapping = e2eInnerToOuter.get(streamId);
    if (!wrapping) return false;
    log.warn("relay e2e stream ended by the connector", { stream: wrapping.outerId.slice(-8), cause: reason });
    send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.close",
      src: "connector",
      dst: "viewer",
      s: sessionId,
      id: wrapping.outerId,
      e: streamScopedCloseReason(reason),
    });
    endE2eOuterStream(wrapping.outerId, reason);
    return true;
  }

  /**
   * A frame that failed to authenticate, decode, or arrived out of order under its key.
   *
   * NEVER A PLAINTEXT FALLBACK (plan §P3 acceptance) — the only two things this does are tell the
   * phone the stream is over and end whatever inner stream it had reached. Nothing here inspects
   * `payload` as anything other than opaque bytes that failed to open.
   */
  function endE2eBadFrame(
    outerId: string,
    code: "protocol-error" | "unauthorized" = "protocol-error",
    cause = "relay-e2e-auth-failed",
  ): void {
    // `cause` is the REAL reason (counter gap, bad tag, malformed frame...). It used to be a hard-coded
    // "auth-failed", so a relay that dropped a frame was logged as an authentication failure right
    // after its own `relay-e2e-counter-gap` line, which sent the diagnosis the wrong way.
    stats.lastError = cause;
    log.warn("relay e2e frame refused", { code: cause });
    send({
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.close",
      src: "connector",
      dst: "viewer",
      s: sessionId,
      id: outerId,
      e: code,
    });
    endE2eOuterStream(outerId, code);
  }

  function onE2eOpen(header: RelayFrameHeader): void {
    const outerId = header.id as string;
    const deviceId = header.d as string | undefined;
    const session = deviceId ? e2eSessionFor(deviceId) : null;
    if (!deviceId || !session) {
      log.warn("relay e2e open refused: no session key for the relay-stamped device", {
        code: deviceId ? "relay-e2e-no-session-key" : "relay-e2e-device-missing",
        stream: outerId.slice(-8),
      });
      endE2eBadFrame(outerId, "unauthorized", deviceId ? "relay-e2e-no-session-key" : "relay-e2e-device-missing");
      return;
    }
    if (e2eOuterDeviceId.has(outerId)) {
      // A repeated `e2e.open` on the same outer id is either a bug or a replay; both are refused.
      log.warn("relay e2e open refused: outer stream id already open", {
        code: "relay-e2e-open-refused",
        stream: outerId.slice(-8),
      });
      endE2eBadFrame(outerId, "protocol-error", "relay-e2e-open-refused");
      return;
    }
    e2eOuterDeviceId.set(outerId, { deviceId, generation: session.generation });
  }

  function onE2eData(header: RelayFrameHeader, payload: Buffer): void {
    const outerId = header.id as string;
    const liveOwner = e2eOuterDeviceId.get(outerId);
    const owner = liveOwner ?? e2eEndedOuterDevice.get(outerId);
    if (!owner) {
      log.warn("relay e2e frame for an unknown stream", {
        code: "relay-e2e-unknown-stream",
        stream: outerId.slice(-8),
      });
      endE2eBadFrame(outerId, "protocol-error", "relay-e2e-unknown-stream");
      return;
    }
    const session = e2eSessionFor(owner.deviceId);
    if (!session) {
      log.warn("relay e2e frame refused: no session key for the stream's device", {
        code: "relay-e2e-no-session-key",
        stream: outerId.slice(-8),
      });
      endE2eBadFrame(outerId, "unauthorized", "relay-e2e-no-session-key");
      return;
    }
    if (session.generation !== owner.generation) {
      log.warn("relay e2e frame belongs to a replaced key session", {
        code: "relay-e2e-session-replaced",
      });
      endE2eOuterStreamAndNotify(outerId, "unauthorized");
      return;
    }
    if (payload.length < RELAY_E2E_NONCE_BYTES) {
      log.warn("relay e2e frame too short to carry a nonce", {
        code: "relay-e2e-malformed-frame",
        stream: outerId.slice(-8),
        length: payload.length,
      });
      endE2eBadFrame(outerId, "protocol-error", "relay-e2e-malformed-frame");
      return;
    }
    let counter: bigint;
    try {
      counter = relayE2eCounterOf(payload.subarray(0, RELAY_E2E_NONCE_BYTES));
    } catch {
      log.warn("relay e2e frame nonce is not a valid counter", {
        code: "relay-e2e-malformed-frame",
        stream: outerId.slice(-8),
      });
      endE2eBadFrame(outerId, "protocol-error", "relay-e2e-malformed-frame");
      return;
    }
    // The counter must be EXACTLY the next one. The channel is FIFO end to end, so a gap is never
    // legitimate: it means a frame was dropped (a relay that edits the stream, or a transport that
    // lost one), and every later frame is then a gap too — the session is refused from here on and
    // the phone re-issues. A repeated or reordered counter is refused the same way, BEFORE decryption
    // is even attempted, whether or not the ciphertext happens to still authenticate.
    if (counter !== session.counters.in + 1n) {
      log.warn("relay e2e frame out of sequence", {
        code: "relay-e2e-counter-gap",
        stream: outerId.slice(-8),
        expected: String(session.counters.in + 1n),
        received: String(counter),
      });
      endE2eBadFrame(outerId, "protocol-error", "relay-e2e-counter-gap");
      return;
    }
    // AAD = the canonical outer header bytes, exactly as received — never reconstructed, so this
    // reproduces precisely what the sender authenticated (plan decision 2; see
    // `relay/worker`'s own note on why the relay must never rewrite `s`/`id` on this frame).
    const aad = Buffer.from(JSON.stringify(header), "utf8");
    let innerBytes: Buffer;
    try {
      innerBytes = openRelayE2eFrame(payload, session.keys.phoneToDesktop, aad);
    } catch {
      // A bad AEAD tag ends the stream. Never a plaintext fallback.
      log.warn("relay e2e frame failed to authenticate", {
        code: "relay-e2e-aead-failed",
        stream: outerId.slice(-8),
        counter: String(counter),
      });
      endE2eBadFrame(outerId, "protocol-error", "relay-e2e-aead-failed");
      return;
    }
    session.counters.in = counter;
    // A frame for a stream that already ended here is authentic and counted, and nothing else.
    if (!liveOwner) return;

    let innerFrame: { header: RelayFrameHeader; payload: Buffer };
    try {
      const decoded = decodeRelayFrame(innerBytes);
      innerFrame = { header: decoded.header, payload: Buffer.from(decoded.payload) };
    } catch {
      log.warn("relay e2e inner frame could not be decoded", {
        code: "relay-e2e-malformed-frame",
        stream: outerId.slice(-8),
      });
      endE2eBadFrame(outerId, "protocol-error", "relay-e2e-malformed-frame");
      return;
    }

    const innerId = innerFrame.header.id;
    const innerKnownBefore = e2eOuterToInner.has(outerId);
    if (innerId) {
      const knownInnerId = e2eOuterToInner.get(outerId);
      if (!knownInnerId) {
        e2eOuterToInner.set(outerId, innerId);
        e2eInnerToOuter.set(innerId, { ...owner, outerId });
      } else if (knownInnerId !== innerId) {
        // A stream may not change which inner id it multiplexes mid-flight.
        log.warn("relay e2e stream changed its inner id", {
          code: "relay-e2e-inner-id-changed",
          stream: outerId.slice(-8),
          type: innerFrame.header.t,
        });
        endE2eBadFrame(outerId, "protocol-error", "relay-e2e-inner-id-changed");
        return;
      }
    }
    // Credit the opaque ciphertext only after the inner frame has been accepted. HTTP request
    // bodies can remain in Node's writable buffer, so wait for its write callback before returning
    // that part of the relay's bounded per-stream window.
    const ingressSocket = socket;
    const ingressHttpStream = innerFrame.header.t === "http.request.body" ? httpStreams.get(innerId as string) : null;
    // A body chunk for an inner stream that already ended HERE (the server answered early, the request
    // timed out, it was too large) is not a violation: the phone cannot know yet and its chunks are
    // already in flight. It is authentic, counted above, credited and dropped. Refusing it used to end
    // the whole session (`e2e.close protocol-error`, which the phone treats as session-fatal). Only a
    // body for a stream that never had a start is still refused.
    const endedHere = innerFrame.header.t === "http.request.body" && !ingressHttpStream && innerKnownBefore;
    if (innerFrame.header.t === "http.request.body" && !ingressHttpStream && !endedHere) {
      log.warn("relay e2e request body for an unknown inner http stream", {
        code: "relay-e2e-unknown-inner-stream",
        stream: outerId.slice(-8),
        type: innerFrame.header.t,
      });
      endE2eOuterStreamAndNotify(outerId, "protocol-error");
      return;
    }
    const creditIngress = (): void => {
      if (
        e2eOuterDeviceId.get(outerId)?.generation !== owner.generation ||
        (ingressHttpStream && httpStreams.get(innerId as string) !== ingressHttpStream) ||
        socket !== ingressSocket ||
        !socket ||
        socket.readyState !== WebSocket.OPEN
      )
        return;
      try {
        socket.send(
          encodeRelayFrame({
            v: RELAY_PROTOCOL_VERSION,
            t: "flow.credit",
            src: "connector",
            dst: "viewer",
            s: sessionId,
            id: outerId,
            w: payload.length,
          }),
        );
      } catch {
        log.warn("relay e2e flow credit could not be sent", {
          code: "relay-e2e-credit-send-failed",
          stream: outerId.slice(-8),
        });
        endE2eOuterStreamAndNotify(outerId, "protocol-error");
      }
    };
    if (endedHere) {
      creditIngress();
    } else if (innerFrame.header.t === "http.request.body") {
      writeHttpBody(innerFrame.header, innerFrame.payload, creditIngress);
    } else {
      dispatchViewerFrame(innerFrame.header, innerFrame.payload);
      creditIngress();
    }
  }

  function onE2eClose(header: RelayFrameHeader): void {
    endE2eOuterStream(header.id as string, header.e ?? "normal");
  }

  /** The inner frame exactly as `sendE2eWrapped` encodes it before sealing. */
  function e2eInnerHeader(header: RelayFrameHeader): RelayFrameHeader {
    return { ...header, ...(header.s === undefined ? {} : { s: sessionId }) };
  }

  /**
   * What sending [header] with a [payloadLength]-byte payload takes out of the stream's flow window.
   * The relay charges a plaintext stream on the payload alone, but charges an e2e stream on the whole
   * `e2e.data` payload — the sealed inner frame: its length prefix, its JSON header, the body, the
   * nonce and the AEAD tag — and the viewer credits back that same number. Charging the plaintext
   * length here let a full window of sealed frames overshoot what the relay had left; the relay then
   * dropped the frame and the single per-session counter was left with a hole.
   */
  function flowCost(streamId: string, header: RelayFrameHeader, payloadLength: number): number {
    if (!e2eInnerToOuter.has(streamId)) return payloadLength;
    return (
      4 +
      Buffer.byteLength(JSON.stringify(e2eInnerHeader(header)), "utf8") +
      payloadLength +
      RELAY_E2E_NONCE_BYTES +
      E2E_AEAD_TAG_BYTES
    );
  }

  /**
   * Wraps [header]/[payload] — an otherwise-plaintext viewer-bound frame `send()` is about to emit
   * for an e2e-multiplexed inner stream — as `e2e.data`, sealed under the key generation that opened
   * the outer stream. Called from `send()` alone, so every existing caller (the HTTP and WS bridges, `flow.credit`,
   * `http.cancel`, …) is wrapped identically without having to know it is happening.
   */
  function sendE2eWrapped(
    wrapping: E2eStreamOwner & { outerId: string },
    header: RelayFrameHeader,
    payload?: Buffer,
  ): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const session = e2eSessionFor(wrapping.deviceId);
    if (!session) {
      stats.lastError = "relay-e2e-key-missing";
      log.warn("relay e2e session key vanished before a reply could be sealed", {
        code: "relay-e2e-key-missing",
        stream: wrapping.outerId.slice(-8),
        type: header.t,
      });
      // The caller (`send()`) is used from many sites (`flushHttpQueue`, `flushWsQueue`, …) that do
      // not all check its boolean result — most existing ones never had a reason to, since plaintext
      // `send()` only ever failed when the whole socket was down. A vanished key is a NEW failure
      // mode with no such excuse to leave silent: without ending the local stream here, a browser
      // request could sit unanswered until its own timeout instead of failing promptly.
      endE2eOuterStreamAndNotify(wrapping.outerId, "protocol-error");
      return false;
    }
    if (session.generation !== wrapping.generation) {
      // Once per stream: a body flusher retries on every credit and used to repeat this line per frame.
      if (e2eOuterDeviceId.has(wrapping.outerId)) {
        log.warn("relay e2e reply belongs to a replaced key session", {
          code: "relay-e2e-session-replaced",
          stream: wrapping.outerId.slice(-8),
        });
      }
      endE2eOuterStreamAndNotify(wrapping.outerId, "unauthorized");
      return false;
    }
    if (header.t === "flow.credit") {
      // Flow control is outer transport metadata. The relay must see credits so it can replenish
      // the ciphertext window without learning or parsing the encrypted inner frame.
      try {
        socket.send(
          encodeRelayFrame({
            v: RELAY_PROTOCOL_VERSION,
            t: "flow.credit",
            src: "connector",
            dst: "viewer",
            s: sessionId,
            id: wrapping.outerId,
            w: header.w ?? 0,
          }),
        );
        return true;
      } catch {
        log.warn("relay e2e outer flow credit could not be sent", {
          code: "relay-e2e-credit-send-failed",
          stream: wrapping.outerId.slice(-8),
        });
        endE2eOuterStreamAndNotify(wrapping.outerId, "protocol-error");
        return false;
      }
    }
    if (session.counters.out >= E2E_OUT_COUNTER_LIMIT) {
      log.warn("relay e2e outgoing counter exhausted; ending the device's streams", {
        code: "relay-e2e-counter-exhausted",
        stream: wrapping.outerId.slice(-8),
      });
      e2eExhaustedDevices.add(wrapping.deviceId);
      for (const [outerId, owner] of e2eOuterDeviceId) {
        if (owner.deviceId === wrapping.deviceId) endE2eOuterStreamAndNotify(outerId, "protocol-error");
      }
      return false;
    }
    const innerHeader = e2eInnerHeader(header);
    let innerBytes: Buffer;
    try {
      innerBytes = Buffer.from(encodeRelayFrame(innerHeader, payload));
    } catch (error) {
      stats.lastError = error instanceof RelayFrameError ? error.code : "encode-failed";
      log.warn("relay e2e inner frame could not be encoded", {
        code: stats.lastError,
        stream: wrapping.outerId.slice(-8),
        type: header.t,
      });
      endE2eOuterStreamAndNotify(wrapping.outerId, "protocol-error");
      return false;
    }
    const counter = session.counters.out;
    session.counters.out += 1n;
    const outerHeader: RelayFrameHeader = {
      v: RELAY_PROTOCOL_VERSION,
      t: "e2e.data",
      src: "connector",
      dst: "viewer",
      s: sessionId,
      id: wrapping.outerId,
      q: nextE2eOuterSeq(wrapping.outerId),
    };
    const aad = Buffer.from(JSON.stringify(outerHeader), "utf8");
    const sealed = sealRelayE2eFrame(innerBytes, session.keys.desktopToPhone, counter, aad);
    // The relay charges its connector->viewer window for this stream on exactly `sealed.length` and the
    // viewer hands the same number back as a credit, so the local window is charged on it too. The
    // body flushers already checked that this size fits (`flowCost`); a control frame (start, end,
    // cancel, `ws.opened`) is charged here as well rather than skipped, or its credit would come back
    // for bytes that were never taken out and inflate the window past what the relay has left.
    const owner = httpStreams.get(header.id as string) ?? wsStreams.get(header.id as string);
    if (owner) owner.window -= sealed.length;
    try {
      socket.send(encodeRelayFrame(outerHeader, sealed));
      return true;
    } catch (error) {
      stats.lastError = error instanceof RelayFrameError ? error.code : "send-failed";
      log.warn("relay e2e sealed frame could not be sent", {
        code: stats.lastError,
        stream: wrapping.outerId.slice(-8),
        type: header.t,
      });
      // The socket itself is what just failed to send, so a follow-up e2e.close attempt below is a
      // best-effort courtesy, not something to depend on — the local cleanup half of
      // `endE2eOuterStreamAndNotify` is what actually matters here, and always runs regardless.
      endE2eOuterStreamAndNotify(wrapping.outerId, "protocol-error");
      return false;
    }
  }

  const stats = {
    connects: 0,
    httpStreams: 0,
    wsStreams: 0,
    bytesIn: 0,
    bytesOut: 0,
    overflows: 0,
    reconnects: 0,
    /** How many revocations the most recent sync phase replayed. Diagnostics only — a count. */
    revocationsReplayed: 0,
    lastError: "",
  };

  function setState(next: RelayConnectorState): void {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  }

  function send(header: RelayFrameHeader, payload?: Buffer): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    // Every viewer-bound frame this connector ever sends passes through here — the ONE place that
    // needs to know whether `header.id` names an e2e-multiplexed inner stream, rather than every call
    // site (the HTTP and WS bridges, `flow.credit`, `http.cancel`, …) having to know it separately.
    // An `e2e.*` frame IS the outer envelope and is never wrapped. The phone gives an inner frame the
    // same id as its outer stream, so an outer `e2e.close` matched the inner-id lookup below: a refusal
    // was sealed as an inner frame the phone could not read as one, and a stale reply's close re-entered
    // `sendE2eWrapped` → `endE2eOuterStreamAndNotify` → here until the stack overflowed (2026-10-05).
    const wrapping =
      typeof header.id === "string" && !header.t.startsWith("e2e.") ? e2eInnerToOuter.get(header.id) : undefined;
    if (wrapping) return sendE2eWrapped(wrapping, header, payload);
    try {
      // `s` is rewritten to the session this socket actually holds when the caller asked for one, and
      // left absent when it did not — which is what lets the sync phase, where no session exists yet,
      // use the same sender as everything after it. A frame that named `s: ""` before `conn.ready`
      // would be refused by the relay as a frame from the wrong phase.
      const preserveSystemConnectionId = header.t.startsWith("sys.");
      socket.send(
        encodeRelayFrame(
          {
            ...header,
            ...(header.s === undefined || preserveSystemConnectionId ? {} : { s: sessionId }),
          },
          payload,
        ),
      );
      return true;
    } catch (error) {
      stats.lastError = error instanceof RelayFrameError ? error.code : "send-failed";
      log.warn("relay frame not sent", { code: stats.lastError });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  function connect(): void {
    if (stopped) return;
    setState("connecting");
    // A previous socket must not outlive this attempt. `socket` used to be overwritten and the old
    // one left open, so a reconnect gave the relay TWO authenticated connectors for one installation
    // — and the relay, quite correctly, hands the object to the newest and drains the other. Closing
    // it here means this side and the relay agree on which socket is current, rather than one of them
    // routing to a socket the other has given up on.
    const previous = socket;
    socket = null;
    if (previous) {
      try {
        // `onDisconnected` is guarded by `socket === next`, and `socket` is already null, so this
        // close does not schedule a second reconnect on top of the one in progress.
        previous.close(1000, "reconnecting");
      } catch {
        // Already closing.
      }
    }
    void options
      .getGrant()
      .then((grant) => {
        if (stopped) return;
        const url = `${options.relayOrigin.replace(/^http/, "ws")}/__relay/connect`;
        const socketHeaders = options.systemChannel?.open ? { "X-Strideterm-System-Channel": "1" } : undefined;
        const next = createSocket(
          url,
          [RELAY_CONNECTOR_SUBPROTOCOL, grant],
          socketHeaders ? { headers: socketHeaders } : undefined,
        );
        socket = next;
        localCloseCause = null;
        // The last socket error, as a sanitized token. `ws` reports 1006 when TCP ends without a close
        // frame and the reason is only in the preceding 'error' event, which used to be dropped.
        let socketErrorCode: string | undefined;
        setState("authenticating");
        startHandshakeTimeout();

        next.on("message", (data: Buffer, isBinary: boolean) => {
          lastInboundAt = Date.now();
          if (!isBinary) {
            // The relay link is binary-framed only; a text message means the peer is not the relay.
            closeSocket(1002, "protocol-error");
            return;
          }
          let frame;
          try {
            frame = decodeRelayFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
          } catch (error) {
            stats.lastError = error instanceof RelayFrameError ? error.code : "decode-failed";
            log.warn("relay frame refused", { code: stats.lastError });
            closeSocket(1002, "protocol-error");
            return;
          }
          // `onFrame` is async and the handshake awaits a grant inside it, so a rejection here is a
          // rejection nothing else would ever see: it used to escape as an unhandled rejection and
          // leave this socket open in `authenticating` with no reconnect scheduled (review 1
          // finding 5). Closing the socket is what puts the connector back on its backoff path.
          void onFrame(frame.header, frame.payload).catch((error: unknown) => {
            stats.lastError = error instanceof Error ? error.message : "frame-failed";
            log.warn("relay frame handling failed", { code: "frame-failed" });
            closeSocket(1011, "frame-failed");
          });
        });
        next.on("close", (code: number, reason: Buffer) => {
          if (socket === next) onDisconnected(code, socketErrorCode, sanitizeCloseReason(reason));
        });
        next.on("error", (error: Error) => {
          stats.lastError = error.message;
          socketErrorCode = sanitizeSocketError(error);
        });
      })
      .catch((error: Error) => {
        stats.lastError = error.message;
        if (error instanceof MobileRelayGrantDefinitiveRefusalError) {
          // The entitlement, not the network (plan §6). Retrying on the ordinary bounded backoff
          // would still be a paid callable invoked roughly every 30 seconds for as long as the
          // subscription stays lapsed — this is the "opakovat placené požadavky v rychlé smyčce" the
          // plan refuses, at a much smaller multiple.
          log.warn("relay grant definitively refused", { status: error.status });
          scheduleDefinitiveRefusalRetry();
          return;
        }
        // An error code only: the message of a failed callable can carry a URL or an account detail.
        log.warn("relay grant unavailable", { code: sanitizeSocketError(error) });
        scheduleReconnect();
      });
  }

  function onDisconnected(code: number, errorCode?: string, closeReason?: string): void {
    const closedBy = localCloseCause;
    localCloseCause = null;
    const closedSession = sessionId ? relayRef(sessionId) : undefined;
    socket = null;
    sessionId = "";
    stopHeartbeat();
    stopHandshakeTimeout();
    // Session cleanup: every stream belonged to the socket that just went away. Ending them here is
    // what keeps a reconnect from resuming into half-open local requests and orphaned PTY sockets.
    for (const streamId of [...httpStreams.keys()]) endHttpStream(streamId, "connector-gone");
    for (const streamId of [...wsStreams.keys()]) endWsStream(streamId, 1012, "connector-gone");
    for (const connectionId of [...systemStreams.keys()]) closeSystemStream(connectionId, "connector-gone", false);
    // The e2e routing maps are scoped to THIS socket's outer stream ids, which mean nothing to a
    // reconnect's fresh session — but NOT `e2eDeviceSessions`: the derived key and its nonce counters
    // are tied to the ticket's own TTL, not to this socket, and must keep advancing rather than
    // resetting (a reset would let the same key seal two different frames under the same nonce).
    e2eOuterDeviceId.clear();
    e2eEndedOuterDevice.clear();
    e2eOuterToInner.clear();
    e2eInnerToOuter.clear();
    e2eOuterSeq.clear();
    if (stopped) {
      setState("closed");
      return;
    }
    // `error` and `closedBy` are fixed tokens (an errno-style code, an error class name, our own
    // watchdog cause) — never an error message, which can carry the relay URL.
    log.info("relay connection closed", {
      code,
      ...(closeReason ? { reason: closeReason } : {}),
      ...(closedSession ? { session: closedSession } : {}),
      ...(errorCode ? { error: errorCode } : {}),
      closedBy: closedBy ?? "peer-or-network",
    });
    stats.reconnects += 1;
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = reconnectDelayMs(attempt++);
    setState("connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  /**
   * Same shape as {@link scheduleReconnect}, on the same timer slot (so the two can never double up),
   * but with the fixed, much longer delay a definitive refusal calls for. Deliberately does not touch
   * `attempt`: the exponential counter is for the network-error path, and a spell of definitive
   * refusals must neither inflate it nor be inflated by whatever it already was.
   */
  function scheduleDefinitiveRefusalRetry(): void {
    if (stopped || reconnectTimer) return;
    setState("connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, definitiveRefusalRetryDelayMs());
    reconnectTimer.unref?.();
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    lastInboundAt = Date.now();
    heartbeatEchoSeen = false;
    heartbeat = setInterval(() => {
      // Checked on the tick rather than on a timer of its own: one timer, and the deadline is honoured
      // to within one heartbeat period, which is plenty against a 60 s limit.
      if (heartbeatEchoSeen && Date.now() - lastInboundAt >= RELAY_CONNECTOR_HEARTBEAT_TIMEOUT_MS) {
        terminateStalledSocket(Date.now() - lastInboundAt);
        return;
      }
      send({ v: RELAY_PROTOCOL_VERSION, t: "conn.heartbeat", src: "connector", dst: "relay", s: sessionId });
    }, RELAY_CONNECTOR_HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  /**
   * The relay has echoed heartbeats on this connection and has now been silent for the full timeout:
   * the TCP path is dead even though nothing has said so. `terminate()`, not `close()` — the close
   * handshake needs the very path that is gone and would wait out its own timeout.
   */
  function terminateStalledSocket(silentMs: number): void {
    stats.lastError = "relay-inbound-silence";
    localCloseCause = "relay-inbound-silence";
    log.warn("relay connection stalled", { code: "relay-inbound-silence", silentMs });
    try {
      socket?.terminate();
    } catch {
      // Already gone.
    }
  }

  function stopHeartbeat(): void {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  /**
   * Bounds the time this connector may spend not-yet-ready on an open socket.
   *
   * The deadline is the shared `RELAY_CONNECTOR_HANDSHAKE_TIMEOUT_MS`, the same number the relay
   * stamps on its own pending attachment, so both ends give up at the same point rather than one
   * waiting on the other. Expiry closes the socket, which routes into `onDisconnected` and therefore
   * into the ordinary bounded backoff — a stuck handshake is a reconnect, not a dead connector.
   */
  function startHandshakeTimeout(): void {
    stopHandshakeTimeout();
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (state !== "authenticating") return;
      stats.lastError = "handshake-timeout";
      log.warn("relay handshake timed out", { code: "handshake-timeout" });
      closeSocket(1002, "handshake-timeout");
    }, handshakeTimeoutMs);
    handshakeTimer.unref?.();
  }

  function stopHandshakeTimeout(): void {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
  }

  /**
   * Bounds the sync phase, for the same reason `startHandshakeTimeout` bounds the one before it.
   *
   * A socket stuck in `syncing` is worse than one stuck in `authenticating`: the relay has accepted
   * the key, so this desktop looks like it is arriving, and every viewer request is answered `503
   * desktop-syncing` for as long as it lasts. Reusing the same timer handle keeps "there is at most
   * one pre-ready deadline in flight" true without a second field to keep in step.
   */
  function startSyncTimeout(): void {
    stopHandshakeTimeout();
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (state !== "syncing") return;
      stats.lastError = "sync-timeout";
      log.warn("relay revocation sync timed out", { code: "sync-timeout" });
      closeSocket(1002, "sync-timeout");
    }, syncTimeoutMs);
    handshakeTimer.unref?.();
  }

  function closeSocket(code: number, reason: string): void {
    try {
      socket?.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  // -------------------------------------------------------------------------
  // Frame dispatch
  // -------------------------------------------------------------------------

  async function onFrame(header: RelayFrameHeader, payload: Buffer): Promise<void> {
    switch (header.t) {
      case "conn.challenge": {
        const transcript = relayConnectorChallengeTranscript({
          audience: options.relayOrigin,
          desktopInstallationId: options.identity.installationId,
          connectorKeyFingerprint: options.identity.fingerprint,
          nonce: header.n as string,
        });
        const grant = await options.getGrant();
        send({
          v: RELAY_PROTOCOL_VERSION,
          t: "conn.authenticate",
          src: "connector",
          dst: "relay",
          g: grant,
          p: options.identity.signChallenge(transcript).toString("base64url"),
          k: options.identity.publicKeyBase64Url,
        });
        return;
      }
      case "conn.sync.request": {
        // The relay will not route anything to this desktop until `conn.sync.complete` lands, so this
        // is a fast path by construction: one frame per revocation, read from the store in one
        // synchronous call, and then the completion. No await, no I/O, nothing that could wedge the
        // phase halfway.
        setState("syncing");
        // The handshake deadline is replaced by the sync one rather than left running: the two phases
        // have different budgets, and the relay stamps the same second deadline on its own side.
        startSyncTimeout();
        let replayed = 0;
        for (const revocation of options.listRelayRevocations?.() ?? []) {
          const sent = send({
            v: RELAY_PROTOCOL_VERSION,
            t: "conn.revoke",
            src: "connector",
            dst: "relay",
            d: revocation.deviceId,
            r: revocation.revokedAt,
          });
          if (!sent) return;
          replayed += 1;
        }
        stats.revocationsReplayed = replayed;
        send({ v: RELAY_PROTOCOL_VERSION, t: "conn.sync.complete", src: "connector", dst: "relay" });
        log.info("relay revocation sync sent", { count: replayed });
        return;
      }
      case "conn.ready":
        sessionId = header.s as string;
        attempt = 0;
        stats.connects += 1;
        stopHandshakeTimeout();
        setState("ready");
        startHeartbeat();
        log.info("relay connector ready", { session: relayRef(sessionId) });
        return;
      case "conn.heartbeat":
        // The relay echoes our heartbeat (src relay, dst connector). Only a heartbeat seen while ready
        // arms the silence watchdog.
        if (state === "ready") heartbeatEchoSeen = true;
        return;
      case "conn.drain":
        // The relay is handing this installation to another connector (a restart taking over) or
        // shutting down. Stop taking new work; the socket close that follows does the cleanup.
        setState("draining");
        return;
      case "conn.close":
        closeSocket(1000, header.e ?? "normal");
        return;
      case "e2e.open":
        onE2eOpen(header);
        return;
      case "e2e.data":
        onE2eData(header, payload);
        return;
      case "e2e.close":
        onE2eClose(header);
        return;
      case "sys.open":
        openSystemStream(header);
        return;
      case "sys.data": {
        const stream = systemStreams.get(header.s as string);
        if (stream && header.src === "system" && header.dst === "connector")
          stream.receive(header.q as number, payload);
        else if (stream) closeSystemStream(header.s as string, "protocol-error");
        return;
      }
      case "sys.close":
        closeSystemStream(header.s as string, header.e ?? "normal", false);
        return;
      case "flow.credit": {
        const outerId = header.id ?? "";
        // A plaintext (legacy relay) stream has no outer wrapper: the relay credits it by its own id.
        // Ignoring that stalled such a stream once 1 MiB had been sent. An id that names an e2e outer
        // stream never falls through to this, so the two namespaces stay apart.
        const innerId = e2eOuterToInner.get(outerId) ?? (e2eOuterDeviceId.has(outerId) ? undefined : outerId);
        if (innerId) creditStream(innerId, header.w ?? 0);
        return;
      }
      case "http.request.start":
      case "http.request.body":
      case "http.request.end":
      case "http.cancel":
      case "ws.open":
      case "ws.data":
      case "ws.close":
      case "ws.error":
      case "flow.overflow":
      case "flow.timeout":
        dispatchViewerFrame(header, payload);
        return;
      default:
        // A connector→relay frame arriving FROM the relay is a protocol violation, not noise.
        stats.lastError = "unexpected-frame";
        closeSocket(1002, "protocol-error");
    }
  }

  /**
   * The viewer-bound/viewer-originated frame types, dispatched identically whether [header] arrived
   * plaintext on the connector's own socket or was just recovered by `onE2eData` from an `e2e.data`
   * payload (plan §P3 acceptance: "dispatch the recovered inner frame through the SAME onFrame switch
   * that handles plaintext frames today"). Nothing here can tell which path a call came from, which
   * is the point — the inner frame format is unchanged by wrapping (plan decision 2).
   */
  function dispatchViewerFrame(header: RelayFrameHeader, payload: Buffer): void {
    switch (header.t) {
      case "http.request.start":
        startHttpStream(header);
        return;
      case "http.request.body":
        writeHttpBody(header, payload);
        return;
      case "http.request.end":
        endHttpRequestBody(header);
        return;
      case "http.cancel":
        endHttpStream(header.id as string, header.e ?? "client-cancelled");
        return;
      case "ws.open":
        openWsStream(header);
        return;
      case "ws.data":
        writeWsData(header, payload);
        return;
      case "ws.close":
        endWsStream(header.id as string, header.x ?? 1000, header.e ?? "normal");
        return;
      case "ws.error":
        endWsStream(header.id as string, 1011, header.e ?? "protocol-error");
        return;
      case "flow.credit":
        creditStream(header.id as string, header.w ?? 0);
        return;
      case "flow.overflow":
      case "flow.timeout":
        endHttpStream(header.id as string, header.e ?? "protocol-error");
        endWsStream(header.id as string, 1011, header.e ?? "protocol-error");
        return;
      default:
        // An inner frame of any other type is a peer bug, not an attack (the AEAD tag already
        // authenticated it when it arrived via `onE2eData`) — logged, and otherwise ignored, rather
        // than escalated into closing the whole connector socket the way an outer protocol violation
        // in `onFrame` does.
        stats.lastError = "unexpected-inner-frame";
        log.warn("unexpected inner frame type", { code: "unexpected-inner-frame" });
    }
  }

  // -------------------------------------------------------------------------
  // HTTP bridge
  // -------------------------------------------------------------------------

  function startHttpStream(header: RelayFrameHeader): void {
    const streamId = header.id as string;
    if (httpStreams.has(streamId)) {
      // A repeated stream id on one session is a replay, not a retry.
      failStream(streamId, "protocol-error");
      return;
    }
    const request = http.request({
      agent,
      host: options.internalOrigin.host,
      port: options.internalOrigin.port,
      method: header.m,
      // `header.u` has already been proven origin-form by the frame decoder, and it is joined to
      // nothing: `host`/`port` come from `internalOrigin` alone.
      path: header.u,
      headers: inboundHeaders(header.h ?? [], e2eInnerToOuter.get(streamId)?.deviceId),
    });

    const stream: HttpStream = {
      request,
      window: RELAY_FLOW_CREDIT_BYTES,
      queue: [],
      queuedBytes: 0,
      outSeq: 0,
      inSeq: -1,
      response: null,
      bytesOut: 0,
      bytesIn: 0,
      ended: false,
      timer: null,
      pendingRawChunks: null,
    };
    httpStreams.set(streamId, stream);
    stats.httpStreams += 1;

    armRequestTimer(streamId, stream);

    request.on("response", (response) => {
      if (httpStreams.get(streamId) !== stream) {
        response.destroy();
        return;
      }
      stream.response = response;
      if (stream.timer) {
        clearTimeout(stream.timer);
        stream.timer = null;
      }
      // Compression only ever applies to an e2e-wrapped stream: the plaintext path is relayed to a
      // Worker that would otherwise have to preserve `Content-Encoding` byte-perfectly across two
      // hops for no gain on a loopback hop (see `inboundHeaders`), and this connector has no way to
      // ask the phone-side proxy to inflate on a build that predates decision 4.
      const compress = e2eInnerToOuter.has(streamId) && isCompressibleResponse(response);
      if (compress) stream.pendingRawChunks = [];
      const headers = outboundHeaders(response);
      let responseStartSent: boolean;
      if (compress) {
        // The compressed length is not known until the whole body has arrived (deflated as one
        // block below); a stale `Content-Length` would corrupt how the phone-side proxy — and, past
        // it, the WebView — parses the body, so it is dropped rather than corrected. Its absence is
        // exactly what tells `http.HttpServer` on the proxy's side to chunk the response instead.
        const withoutLength = headers.filter(([name]) => name !== "content-length");
        withoutLength.push(["content-encoding", "deflate"]);
        responseStartSent = send({
          v: RELAY_PROTOCOL_VERSION,
          t: "http.response.start",
          src: "connector",
          dst: "viewer",
          s: sessionId,
          id: streamId,
          c: response.statusCode ?? 502,
          h: withoutLength,
        });
      } else {
        responseStartSent = send({
          v: RELAY_PROTOCOL_VERSION,
          t: "http.response.start",
          src: "connector",
          dst: "viewer",
          s: sessionId,
          id: streamId,
          c: response.statusCode ?? 502,
          h: headers,
        });
      }
      if (!responseStartSent || httpStreams.get(streamId) !== stream) {
        response.destroy();
        return;
      }
      response.on("data", (chunk: Buffer) => {
        if (httpStreams.get(streamId) !== stream) return;
        stream.bytesOut += chunk.length;
        if (stream.bytesOut > RELAY_MAX_HTTP_RESPONSE_BODY_BYTES) {
          failStream(streamId, "too-large");
          return;
        }
        if (stream.pendingRawChunks) {
          stream.pendingRawChunks.push(chunk);
          return;
        }
        for (const slice of sliceBody(chunk)) enqueueResponseBody(streamId, stream, slice);
      });
      response.on("end", () => {
        if (httpStreams.get(streamId) !== stream) return;
        if (stream.pendingRawChunks) {
          const raw = stream.pendingRawChunks;
          stream.pendingRawChunks = null;
          let deflated: Buffer;
          try {
            deflated = zlib.deflateRawSync(Buffer.concat(raw));
          } catch (error) {
            // Already committed to `content-encoding: deflate` in the header frame sent above —
            // there is no correct plaintext fallback left to send, only a clean failure.
            stats.lastError = error instanceof Error ? error.message : "deflate-failed";
            failStream(streamId, "protocol-error");
            return;
          }
          for (const slice of sliceBody(deflated)) enqueueResponseBody(streamId, stream, slice);
        }
        stream.ended = true;
        flushHttpQueue(streamId, stream);
      });
      response.on("error", () => failStream(streamId, "protocol-error"));
    });
    request.on("error", (error: Error) => {
      stats.lastError = error.message;
      failStream(streamId, "protocol-error");
    });
  }

  /**
   * Whether an INNER frame's `q` is the next one of its stream. Inside an e2e-wrapped stream the
   * phone numbers its own frames from 0 and the relay cannot see them, so a gap is a frame that was
   * dropped: refused, not tolerated. A plaintext stream is numbered by the Worker, which keeps its
   * own (strictly increasing) contract — unchanged.
   */
  function isNextInnerSequence(streamId: string, sequence: number, lastSequence: number): boolean {
    return e2eInnerToOuter.has(streamId) ? sequence === lastSequence + 1 : sequence > lastSequence;
  }

  /**
   * The request's idle bound: no progress for `httpRequestTimeoutMs` before the desktop has started
   * answering. Re-armed on every received body chunk and again at the request's end, and cleared when the
   * response starts. It used to be armed once at request start, so any upload longer than 30 s was
   * killed mid-body (and, via the stream's in-flight chunks, the session with it).
   */
  function armRequestTimer(streamId: string, stream: HttpStream): void {
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = setTimeout(() => {
      if (httpStreams.get(streamId) === stream) failStream(streamId, "timeout");
    }, httpRequestTimeoutMs);
    stream.timer.unref?.();
  }

  function writeHttpBody(header: RelayFrameHeader, payload: Buffer, onConsumed?: () => void): void {
    const streamId = header.id as string;
    const stream = httpStreams.get(streamId);
    if (!stream) return;
    const sequence = header.q ?? 0;
    if (!isNextInnerSequence(streamId, sequence, stream.inSeq)) {
      failStream(streamId, "protocol-error");
      return;
    }
    stream.inSeq = sequence;
    if (!stream.response) armRequestTimer(streamId, stream);
    stream.bytesIn += payload.length;
    // The plaintext path is already bounded by the Worker before a byte reaches this connector; an
    // e2e-wrapped one is not, since the Worker never sees the inner frame at all — this is that
    // enforcement, over the INNER (decrypted) body (plan 2026-09-23, §P3 acceptance).
    if (stream.bytesIn > RELAY_MAX_HTTP_REQUEST_BODY_BYTES) {
      failStream(streamId, "too-large");
      return;
    }
    stats.bytesIn += payload.length;
    if (onConsumed) {
      stream.request.write(payload, (error?: Error | null) => {
        if (!error) onConsumed();
      });
    } else {
      stream.request.write(payload);
    }
  }

  function endHttpRequestBody(header: RelayFrameHeader): void {
    const stream = httpStreams.get(header.id as string);
    if (!stream) return;
    if (!stream.response) armRequestTimer(header.id as string, stream);
    stream.request.end();
  }

  function enqueueResponseBody(streamId: string, stream: HttpStream, chunk: Buffer): void {
    if (httpStreams.get(streamId) !== stream) return;
    stream.queue.push(chunk);
    stream.queuedBytes += chunk.length;
    if (stream.queuedBytes > RELAY_STREAM_QUEUE_BYTES) {
      // A viewer that cannot keep up. Ending the stream is the only bounded answer: the alternative
      // is holding an unbounded amount of somebody's terminal output in this process.
      stats.overflows += 1;
      // An e2e stream is ended by `failStream` with an outer close instead of a sealed `flow.overflow`,
      // which would be charged to the very window that is exhausted.
      if (!e2eInnerToOuter.has(streamId)) {
        send({
          v: RELAY_PROTOCOL_VERSION,
          t: "flow.overflow",
          src: "connector",
          dst: "viewer",
          s: sessionId,
          id: streamId,
          e: "queue-overflow",
        });
      }
      failStream(streamId, "queue-overflow");
      return;
    }
    flushHttpQueue(streamId, stream);
    // Pausing the local response is what makes the bound real rather than decorative: without it
    // the desktop keeps producing into a queue that is already over its watermark.
    if (stream.queuedBytes > RELAY_STREAM_QUEUE_BYTES / 2) stream.response?.pause();
  }

  function flushHttpQueue(streamId: string, stream: HttpStream): void {
    const wrapped = e2eInnerToOuter.has(streamId);
    while (stream.queue.length > 0 && stream.window > 0) {
      if (httpStreams.get(streamId) !== stream || (wrapped && !e2eInnerToOuter.has(streamId))) return;
      const chunk = stream.queue[0] as Buffer;
      const header: RelayFrameHeader = {
        v: RELAY_PROTOCOL_VERSION,
        t: "http.response.body",
        src: "connector",
        dst: "viewer",
        s: sessionId,
        id: streamId,
        q: stream.outSeq,
      };
      const cost = flowCost(streamId, header, chunk.length);
      if (cost > stream.window) break;
      stream.queue.shift();
      stream.queuedBytes -= chunk.length;
      // An e2e frame is charged by `sendE2eWrapped`, on the size it really seals to.
      if (!wrapped) stream.window -= cost;
      stats.bytesOut += chunk.length;
      stream.outSeq += 1;
      if (!send(header, chunk) || httpStreams.get(streamId) !== stream) return;
    }
    if (httpStreams.get(streamId) !== stream) return;
    if (stream.queuedBytes <= RELAY_STREAM_QUEUE_BYTES / 2) stream.response?.resume();
    if (stream.ended && stream.queue.length === 0) {
      const endHeader: RelayFrameHeader = {
        v: RELAY_PROTOCOL_VERSION,
        t: "http.response.end",
        src: "connector",
        dst: "viewer",
        s: sessionId,
        id: streamId,
      };
      // The end frame is an `e2e.data` too and the relay charges it; when the body left too little
      // room, the next credit re-enters here.
      if (wrapped && flowCost(streamId, endHeader, 0) > stream.window) return;
      if (!send(endHeader) || httpStreams.get(streamId) !== stream) return;
      endHttpStream(streamId, "normal");
    }
  }

  function failStream(streamId: string, reason: RelayReason): void {
    if (httpStreams.has(streamId)) {
      if (endE2eInnerStream(streamId, reason)) return;
      log.warn("relay stream ended by the connector", { stream: streamId.slice(-8), cause: reason });
      send({
        v: RELAY_PROTOCOL_VERSION,
        t: "http.cancel",
        src: "connector",
        dst: "viewer",
        s: sessionId,
        id: streamId,
        e: reason,
      });
      endHttpStream(streamId, reason);
    }
  }

  function endHttpStream(streamId: string, reason: RelayReason): void {
    const stream = httpStreams.get(streamId);
    if (!stream) return;
    httpStreams.delete(streamId);
    if (stream.timer) clearTimeout(stream.timer);
    if (reason !== "normal") {
      stream.request.destroy();
      stream.response?.destroy();
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket bridge
  // -------------------------------------------------------------------------

  function openWsStream(header: RelayFrameHeader): void {
    const streamId = header.id as string;
    if (wsStreams.has(streamId)) {
      if (!endE2eInnerStream(streamId, "protocol-error")) {
        send({
          v: RELAY_PROTOCOL_VERSION,
          t: "ws.error",
          src: "connector",
          dst: "viewer",
          s: sessionId,
          id: streamId,
          e: "protocol-error",
        });
      }
      return;
    }
    const headers = inboundHeaders(header.h ?? [], e2eInnerToOuter.get(streamId)?.deviceId);
    const target = `ws://${options.internalOrigin.host}:${options.internalOrigin.port}${header.u}`;
    const socketToLocal = new WebSocket(target, { headers });
    const stream: WsStream = {
      socket: socketToLocal,
      window: RELAY_FLOW_CREDIT_BYTES,
      queue: [],
      queuedBytes: 0,
      outSeq: 0,
      inSeq: -1,
      opened: false,
      pendingClose: null,
    };
    wsStreams.set(streamId, stream);
    stats.wsStreams += 1;

    socketToLocal.on("open", () => {
      if (wsStreams.get(streamId) !== stream) return;
      stream.opened = true;
      send({
        v: RELAY_PROTOCOL_VERSION,
        t: "ws.opened",
        src: "connector",
        dst: "viewer",
        s: sessionId,
        id: streamId,
      });
    });
    socketToLocal.on("message", (data: Buffer, isBinary: boolean) => {
      if (wsStreams.get(streamId) !== stream) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      // ONE MESSAGE STAYS ONE MESSAGE (review 1 finding 6). A message larger than a frame has to be
      // split, but splitting it silently changed what it was: the browser received several messages
      // instead of one, and a text split inside a multi-byte UTF-8 character arrived as two damaged
      // halves because each fragment was decoded on its own. Each fragment now says whether it is the
      // last, and the relay reassembles before it delivers anything.
      const slices = [...sliceBody(chunk)];
      slices.forEach((slice, index) => {
        if (wsStreams.get(streamId) === stream)
          enqueueWsData(streamId, stream, slice, isBinary, index === slices.length - 1);
      });
    });
    socketToLocal.on("close", (code: number) => {
      if (wsStreams.get(streamId) !== stream) return;
      endLocalWsStream(streamId, stream, {
        v: RELAY_PROTOCOL_VERSION,
        t: "ws.close",
        src: "connector",
        dst: "viewer",
        s: sessionId,
        id: streamId,
        x: normalizeCloseCode(code),
        e: "normal",
      });
    });
    socketToLocal.on("error", (error: Error) => {
      stats.lastError = error.message;
      if (wsStreams.get(streamId) !== stream) return;
      endLocalWsStream(streamId, stream, {
        v: RELAY_PROTOCOL_VERSION,
        t: "ws.error",
        src: "connector",
        dst: "viewer",
        s: sessionId,
        id: streamId,
        e: stream.opened ? "protocol-error" : "unauthorized",
      });
    });
  }

  /**
   * The desktop-side socket of a stream ended. A plaintext stream is told at once, as it always was. An
   * e2e stream's `ws.close` / `ws.error` is a sealed frame like any other, so it waits behind the data
   * already queued and for window room (`flushWsQueue`); the old code sealed it immediately, and a relay
   * that dropped it left the phone with a counter gap.
   */
  function endLocalWsStream(streamId: string, stream: WsStream, closeHeader: RelayFrameHeader): void {
    if (!e2eInnerToOuter.has(streamId)) {
      wsStreams.delete(streamId);
      send(closeHeader);
      return;
    }
    stream.pendingClose = closeHeader;
    flushWsQueue(streamId, stream);
  }

  function openSystemStream(header: RelayFrameHeader): void {
    const connectionId = header.s as string;
    if (systemStreams.has(connectionId)) {
      closeSystemStream(connectionId, "protocol-error");
      return;
    }
    let stream: SystemChannelConnection | null = null;
    stream =
      options.systemChannel?.open({
        connectionId,
        deviceId: header.d as string,
        send: (sequence, ciphertext) =>
          send(
            {
              v: RELAY_PROTOCOL_VERSION,
              t: "sys.data",
              src: "connector",
              dst: "system",
              s: connectionId,
              q: sequence,
            },
            ciphertext,
          ),
        close: (reason) => {
          if (systemClosingFromRelay.delete(connectionId)) return;
          if (systemStreams.get(connectionId) === stream) systemStreams.delete(connectionId);
          send({
            v: RELAY_PROTOCOL_VERSION,
            t: "sys.close",
            src: "connector",
            dst: "system",
            s: connectionId,
            e: reason,
          });
        },
      }) ?? null;
    if (!stream) {
      send({
        v: RELAY_PROTOCOL_VERSION,
        t: "sys.close",
        src: "connector",
        dst: "system",
        s: connectionId,
        e: "unauthorized",
      });
      return;
    }
    systemStreams.set(connectionId, stream);
  }

  function closeSystemStream(connectionId: string, reason: RelayReason, notify = true): void {
    const stream = systemStreams.get(connectionId);
    if (!stream) return;
    systemStreams.delete(connectionId);
    if (notify) systemClosingFromRelay.delete(connectionId);
    else systemClosingFromRelay.add(connectionId);
    stream.close(reason);
  }

  /**
   * Ends a ws stream from THIS side and, on an e2e stream, tells the phone (see `endE2eInnerStream`).
   * `endWsStream` alone sends nothing, which left a dead terminal that looked live on the phone.
   */
  function endWsStreamNotifying(streamId: string, code: number, reason: RelayReason): void {
    if (!endE2eInnerStream(streamId, reason)) endWsStream(streamId, code, reason);
  }

  /**
   * Partial browser messages arriving from the relay, per stream.
   *
   * The relay sends a viewer's message whole today, but the frame protocol permits fragments in both
   * directions and a receiver that ignored the flag would deliver halves — the very failure this
   * flag exists to remove. Reassembly is therefore symmetric, and bounded the same way.
   */
  const wsInbound = new Map<string, { parts: Buffer[]; bytes: number; binary: boolean }>();

  function writeWsData(header: RelayFrameHeader, payload: Buffer): void {
    const streamId = header.id as string;
    const stream = wsStreams.get(streamId);
    if (!stream) return;
    const sequence = header.q ?? 0;
    if (!isNextInnerSequence(streamId, sequence, stream.inSeq)) {
      endWsStreamNotifying(streamId, 1011, "protocol-error");
      return;
    }
    stream.inSeq = sequence;
    stats.bytesIn += payload.length;
    if (stream.socket.readyState !== WebSocket.OPEN) return;

    // Reassemble before delivering. `f: undefined` means "one whole message", which is what every
    // unfragmented frame looks like, so the common path is unchanged.
    const final = header.f !== false;
    const partial = wsInbound.get(streamId);
    if (!final || partial) {
      const held = partial ?? { parts: [], bytes: 0, binary: header.b === true };
      held.parts.push(payload);
      held.bytes += payload.length;
      if (held.bytes > RELAY_MAX_WS_MESSAGE_BYTES) {
        // A sender that never sets the final flag is an unbounded buffer with extra steps.
        wsInbound.delete(streamId);
        stats.overflows += 1;
        endWsStreamNotifying(streamId, 1009, "too-large");
        return;
      }
      if (!final) {
        wsInbound.set(streamId, held);
        // Credit is still returned per fragment: the bytes are held by this connector, and the relay
        // needs its window back to send the rest of the same message.
        if (!e2eInnerToOuter.has(streamId))
          send({
            v: RELAY_PROTOCOL_VERSION,
            t: "flow.credit",
            src: "connector",
            dst: "viewer",
            s: sessionId,
            id: streamId,
            w: Math.max(1, payload.length),
          });
        return;
      }
      wsInbound.delete(streamId);
      const whole = Buffer.concat(held.parts);
      stream.socket.send(held.binary ? whole : whole.toString("utf8"));
    } else {
      stream.socket.send(header.b ? payload : payload.toString("utf8"));
    }
    // Credit is returned only after the bytes reached the local socket.
    if (!e2eInnerToOuter.has(streamId))
      send({
        v: RELAY_PROTOCOL_VERSION,
        t: "flow.credit",
        src: "connector",
        dst: "viewer",
        s: sessionId,
        id: streamId,
        w: Math.max(1, payload.length),
      });
  }

  function enqueueWsData(streamId: string, stream: WsStream, data: Buffer, binary: boolean, final: boolean): void {
    if (wsStreams.get(streamId) !== stream) return;
    stream.queue.push({ data, binary, final });
    stream.queuedBytes += data.length;
    if (stream.queuedBytes > RELAY_STREAM_QUEUE_BYTES) {
      stats.overflows += 1;
      if (!e2eInnerToOuter.has(streamId)) {
        send({
          v: RELAY_PROTOCOL_VERSION,
          t: "flow.overflow",
          src: "connector",
          dst: "viewer",
          s: sessionId,
          id: streamId,
          e: "queue-overflow",
        });
      }
      endWsStreamNotifying(streamId, 1013, "queue-overflow");
      return;
    }
    flushWsQueue(streamId, stream);
  }

  function flushWsQueue(streamId: string, stream: WsStream): void {
    const wrapped = e2eInnerToOuter.has(streamId);
    while (stream.queue.length > 0 && stream.window > 0) {
      if (wsStreams.get(streamId) !== stream || (wrapped && !e2eInnerToOuter.has(streamId))) return;
      const entry = stream.queue[0] as { data: Buffer; binary: boolean; final: boolean };
      const header: RelayFrameHeader = {
        v: RELAY_PROTOCOL_VERSION,
        t: "ws.data",
        src: "connector",
        dst: "viewer",
        s: sessionId,
        id: streamId,
        q: stream.outSeq,
        b: entry.binary,
        f: entry.final,
      };
      const cost = flowCost(streamId, header, entry.data.length);
      if (cost > stream.window) break;
      stream.queue.shift();
      stream.queuedBytes -= entry.data.length;
      // An e2e frame is charged by `sendE2eWrapped`, on the size it really seals to.
      if (!wrapped) stream.window -= cost;
      stats.bytesOut += entry.data.length;
      stream.outSeq += 1;
      if (!send(header, entry.data) || wsStreams.get(streamId) !== stream) return;
    }
    // The stream's own end goes out only once everything before it has, and only when the window can
    // take it; the next credit re-enters here.
    if (stream.pendingClose && stream.queue.length === 0) {
      if (flowCost(streamId, stream.pendingClose, 0) > stream.window) return;
      const closeHeader = stream.pendingClose;
      stream.pendingClose = null;
      wsStreams.delete(streamId);
      send(closeHeader);
    }
  }

  function endWsStream(streamId: string, code: number, reason: RelayReason): void {
    const stream = wsStreams.get(streamId);
    if (!stream) return;
    wsStreams.delete(streamId);
    try {
      stream.socket.close(normalizeCloseCode(code), reason);
    } catch {
      // Already closing.
    }
  }

  function creditStream(streamId: string, credit: number): void {
    const httpStream = httpStreams.get(streamId);
    if (httpStream) {
      httpStream.window = Math.min(RELAY_FLOW_CREDIT_BYTES, httpStream.window + credit);
      flushHttpQueue(streamId, httpStream);
      return;
    }
    const wsStream = wsStreams.get(streamId);
    if (wsStream) {
      wsStream.window = Math.min(RELAY_FLOW_CREDIT_BYTES, wsStream.window + credit);
      flushWsQueue(streamId, wsStream);
    }
  }

  // -------------------------------------------------------------------------
  // Header rewriting
  // -------------------------------------------------------------------------

  /**
   * `e2eDeviceId` is the device the relay stamped as `d` on the outer `e2e.open` of an e2e-wrapped
   * stream; it is the ONLY source of `x-strideterm-relay-device` there, since the inner frame's headers
   * are the phone's. A plaintext stream has no outer frame: the Worker composed that `h` list itself
   * (and strips any such header a browser sent), so its value is the relay's and is passed through.
   */
  function inboundHeaders(list: RelayHeaderList, e2eDeviceId?: string): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    let plaintextRelayDevice = "";
    for (const [name, value] of list) {
      if (name === RELAY_DEVICE_HEADER) {
        plaintextRelayDevice = value;
        continue;
      }
      if (DROPPED_INBOUND_HEADERS.has(name)) continue;
      const existing = out[name];
      if (existing === undefined) out[name] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else out[name] = [existing, value];
    }
    const authority = `${options.internalOrigin.host}:${options.internalOrigin.port}`;
    out.host = authority;
    // The desktop's WebSocket upgrade compares `Origin` against `Host`; the browser's own Origin is
    // the relay's, which would fail that comparison for every relayed socket.
    out.origin = `http://${authority}`;
    // The browser↔relay hop IS TLS in production, and the desktop only marks its session cookie
    // `Secure` when it is told so.
    out["x-forwarded-proto"] = "https";
    // No `Content-Encoding` may appear on a relayed response: the relay would have to preserve it
    // byte-perfectly across two hops, and there is nothing to gain on a loopback hop.
    out["accept-encoding"] = "identity";
    out["x-strideterm-relay-origin"] = options.internalOrigin.guardToken;
    const relayDevice = e2eDeviceId ?? plaintextRelayDevice;
    if (relayDevice) out[RELAY_DEVICE_HEADER] = relayDevice;
    return out;
  }

  function outboundHeaders(response: IncomingMessage): RelayHeaderList {
    const out: [string, string][] = [];
    for (const [name, value] of Object.entries(response.headers)) {
      const lower = name.toLowerCase();
      if (lower === "connection" || lower === "keep-alive" || lower === "transfer-encoding") continue;
      if (value === undefined) continue;
      // `set-cookie` is the reason the wire format carries ordered pairs rather than an object: a
      // response that sets two cookies must still set two.
      if (Array.isArray(value)) for (const entry of value) out.push([lower, entry]);
      else out.push([lower, String(value)]);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      connect();
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      stopHeartbeat();
      stopHandshakeTimeout();
      for (const streamId of [...httpStreams.keys()]) endHttpStream(streamId, "shutting-down");
      for (const streamId of [...wsStreams.keys()]) endWsStream(streamId, 1001, "shutting-down");
      for (const connectionId of [...systemStreams.keys()]) closeSystemStream(connectionId, "shutting-down", false);
      if (socket) {
        send({
          v: RELAY_PROTOCOL_VERSION,
          t: "conn.close",
          src: "connector",
          dst: "relay",
          s: sessionId,
          e: "shutting-down",
        });
        closeSocket(1000, "shutting-down");
      }
      socket = null;
      // Ends every pooled connection into the internal origin, so the origin's own `close()` can
      // actually finish. Without it, "the relay is off" and "the loopback listener is gone" are two
      // different things.
      agent.destroy();
      setState("closed");
    },
    state: () => state,
    endDeviceStreams(mobileDeviceId: string) {
      options.systemChannel?.revokeDevice?.(mobileDeviceId);
      for (const [outerId, owner] of [...e2eOuterDeviceId]) {
        if (owner.deviceId === mobileDeviceId) endE2eOuterStreamAndNotify(outerId, "unauthorized");
      }
      e2eDeviceSessions.delete(mobileDeviceId);
      e2eExhaustedDevices.delete(mobileDeviceId);
    },
    revokeDevice(mobileDeviceId: string, revokedAt = Date.now()) {
      // The RESULT IS DELIBERATELY NOT REPORTED (plan §3.4). A live revoke goes out immediately
      // because it is the fastest path, but nothing here has to succeed for the revocation to hold:
      // the record is already in the persistent device store, and the next sync — after this socket
      // reconnects, or after the whole process restarts — replays it. Believing a `false` from `send`
      // and building a retry queue on top of it would be a second, weaker copy of a mechanism that
      // already converges.
      send({
        v: RELAY_PROTOCOL_VERSION,
        t: "conn.revoke",
        src: "connector",
        dst: "relay",
        s: sessionId,
        d: mobileDeviceId,
        r: revokedAt,
      });
    },
    stats: () => ({
      state,
      connects: stats.connects,
      httpStreams: stats.httpStreams,
      wsStreams: stats.wsStreams,
      liveHttpStreams: httpStreams.size,
      liveWsStreams: wsStreams.size,
      liveSystemStreams: systemStreams.size,
      bytesIn: stats.bytesIn,
      bytesOut: stats.bytesOut,
      overflows: stats.overflows,
      reconnects: stats.reconnects,
      revocationsReplayed: stats.revocationsReplayed,
      lastError: stats.lastError,
    }),
  };
}

/**
 * Bounded exponential backoff with jitter.
 *
 * Bounded because an unbounded one turns a relay outage into a client that has effectively given up,
 * and jittered because every desktop of every user reconnects at the same moment otherwise —
 * a thundering herd against the thing that just came back.
 */
export function defaultReconnectDelay(attempt: number): number {
  const exponential = Math.min(
    RELAY_RECONNECT_MAX_DELAY_MS,
    RELAY_RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempt, 10),
  );
  const jitter = (randomBytes(1)[0] as number) / 255;
  return Math.round(exponential * (0.5 + 0.5 * jitter));
}

/**
 * Fixed (not exponential — see {@link RelayConnectorOptions.definitiveRefusalRetryDelayMs}), with the
 * same light jitter as {@link defaultReconnectDelay} and for the same thundering-herd reason: every
 * desktop whose entitlement lapsed at once must not all ask again at the same instant.
 */
export function defaultDefinitiveRefusalRetryDelay(): number {
  const jitter = (randomBytes(1)[0] as number) / 255;
  return Math.round(RELAY_GRANT_DEFINITIVE_REFUSAL_RETRY_DELAY_MS * (0.9 + 0.2 * jitter));
}

function* sliceBody(chunk: Buffer): Generator<Buffer> {
  if (chunk.length <= BODY_CHUNK_BYTES) {
    yield chunk;
    return;
  }
  for (let offset = 0; offset < chunk.length; offset += BODY_CHUNK_BYTES) {
    yield chunk.subarray(offset, Math.min(offset + BODY_CHUNK_BYTES, chunk.length));
  }
}

/** WebSocket close codes 1005/1006/1015 may not be sent on the wire; map them to a legal one. */
function normalizeCloseCode(code: number): number {
  if (!Number.isInteger(code) || code < 1000 || code > 4999) return 1011;
  if (code === 1005 || code === 1006 || code === 1015) return 1011;
  return code;
}

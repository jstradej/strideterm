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
import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";

import { getLogger } from "../logger.js";
import {
  decodeRelayFrame,
  encodeRelayFrame,
  RELAY_CONNECTOR_HANDSHAKE_TIMEOUT_MS,
  RELAY_CONNECTOR_HEARTBEAT_MS,
  RELAY_CONNECTOR_SYNC_TIMEOUT_MS,
  RELAY_CONNECTOR_SUBPROTOCOL,
  RELAY_FLOW_CREDIT_BYTES,
  RELAY_GRANT_DEFINITIVE_REFUSAL_RETRY_DELAY_MS,
  RELAY_HTTP_REQUEST_TIMEOUT_MS,
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

const log = getLogger("mobile-relay-connector");

/** The largest slice of a body this connector puts in one frame. */
const BODY_CHUNK_BYTES = 256 * 1024;

/**
 * Request headers the connector never forwards inward.
 *
 * Hop-by-hop headers describe the browser↔relay hop and mean nothing on this one. `host` and
 * `origin` are replaced rather than dropped. `x-strideterm-relay-origin` is dropped so a viewer
 * cannot supply its own guard value — the connector sets the real one afterwards. `content-length`
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
  createSocket?: (url: string, protocols: string[]) => WebSocket;
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
  ended: boolean;
  timer: NodeJS.Timeout | null;
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
}

export interface RelayConnector {
  start(): void;
  stop(): Promise<void>;
  state(): RelayConnectorState;
  /** Tells the relay a device is revoked, so a grant minted seconds ago cannot still open a session. */
  revokeDevice(mobileDeviceId: string, revokedAt?: number): void;
  /** Diagnostics for the local harness and the debug UI — counts and states only, never payload. */
  stats(): {
    state: RelayConnectorState;
    connects: number;
    httpStreams: number;
    wsStreams: number;
    liveHttpStreams: number;
    liveWsStreams: number;
    bytesIn: number;
    bytesOut: number;
    overflows: number;
    reconnects: number;
    revocationsReplayed: number;
    lastError: string;
  };
}

export function createRelayConnector(options: RelayConnectorOptions): RelayConnector {
  const reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelay;
  const definitiveRefusalRetryDelayMs = options.definitiveRefusalRetryDelayMs ?? defaultDefinitiveRefusalRetryDelay;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? RELAY_CONNECTOR_HANDSHAKE_TIMEOUT_MS;
  const syncTimeoutMs = options.syncTimeoutMs ?? RELAY_CONNECTOR_SYNC_TIMEOUT_MS;
  const createSocket = options.createSocket ?? ((url: string, protocols: string[]) => new WebSocket(url, protocols));

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
    try {
      // `s` is rewritten to the session this socket actually holds when the caller asked for one, and
      // left absent when it did not — which is what lets the sync phase, where no session exists yet,
      // use the same sender as everything after it. A frame that named `s: ""` before `conn.ready`
      // would be refused by the relay as a frame from the wrong phase.
      socket.send(encodeRelayFrame({ ...header, ...(header.s === undefined ? {} : { s: sessionId }) }, payload));
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
        const next = createSocket(url, [RELAY_CONNECTOR_SUBPROTOCOL, grant]);
        socket = next;
        setState("authenticating");
        startHandshakeTimeout();

        next.on("message", (data: Buffer, isBinary: boolean) => {
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
        next.on("close", (code: number) => {
          if (socket === next) onDisconnected(code);
        });
        next.on("error", (error: Error) => {
          stats.lastError = error.message;
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
        log.warn("relay grant unavailable", { err: error.message });
        scheduleReconnect();
      });
  }

  function onDisconnected(code: number): void {
    socket = null;
    sessionId = "";
    stopHeartbeat();
    stopHandshakeTimeout();
    // Session cleanup: every stream belonged to the socket that just went away. Ending them here is
    // what keeps a reconnect from resuming into half-open local requests and orphaned PTY sockets.
    for (const streamId of [...httpStreams.keys()]) endHttpStream(streamId, "connector-gone");
    for (const streamId of [...wsStreams.keys()]) endWsStream(streamId, 1012, "connector-gone");
    if (stopped) {
      setState("closed");
      return;
    }
    log.info("relay connection closed", { code });
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
    heartbeat = setInterval(() => {
      send({ v: RELAY_PROTOCOL_VERSION, t: "conn.heartbeat", src: "connector", dst: "relay", s: sessionId });
    }, RELAY_CONNECTOR_HEARTBEAT_MS);
    heartbeat.unref?.();
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
        log.info("relay connector ready");
        return;
      case "conn.heartbeat":
        return;
      case "conn.drain":
        // The relay is handing this installation to another connector (a restart taking over) or
        // shutting down. Stop taking new work; the socket close that follows does the cleanup.
        setState("draining");
        return;
      case "conn.close":
        closeSocket(1000, header.e ?? "normal");
        return;
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
        // A connector→relay frame arriving FROM the relay is a protocol violation, not noise.
        stats.lastError = "unexpected-frame";
        closeSocket(1002, "protocol-error");
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
      headers: inboundHeaders(header.h ?? []),
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
      ended: false,
      timer: null,
    };
    httpStreams.set(streamId, stream);
    stats.httpStreams += 1;

    stream.timer = setTimeout(() => failStream(streamId, "timeout"), RELAY_HTTP_REQUEST_TIMEOUT_MS);
    stream.timer.unref?.();

    request.on("response", (response) => {
      stream.response = response;
      if (stream.timer) {
        clearTimeout(stream.timer);
        stream.timer = null;
      }
      send({
        v: RELAY_PROTOCOL_VERSION,
        t: "http.response.start",
        src: "connector",
        dst: "viewer",
        s: sessionId,
        id: streamId,
        c: response.statusCode ?? 502,
        h: outboundHeaders(response),
      });
      response.on("data", (chunk: Buffer) => {
        stream.bytesOut += chunk.length;
        if (stream.bytesOut > RELAY_MAX_HTTP_RESPONSE_BODY_BYTES) {
          failStream(streamId, "too-large");
          return;
        }
        for (const slice of sliceBody(chunk)) enqueueResponseBody(streamId, stream, slice);
      });
      response.on("end", () => {
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

  function writeHttpBody(header: RelayFrameHeader, payload: Buffer): void {
    const streamId = header.id as string;
    const stream = httpStreams.get(streamId);
    if (!stream) return;
    const sequence = header.q ?? 0;
    if (sequence <= stream.inSeq) {
      failStream(streamId, "protocol-error");
      return;
    }
    stream.inSeq = sequence;
    stats.bytesIn += payload.length;
    stream.request.write(payload);
  }

  function endHttpRequestBody(header: RelayFrameHeader): void {
    const stream = httpStreams.get(header.id as string);
    if (!stream) return;
    stream.request.end();
  }

  function enqueueResponseBody(streamId: string, stream: HttpStream, chunk: Buffer): void {
    stream.queue.push(chunk);
    stream.queuedBytes += chunk.length;
    if (stream.queuedBytes > RELAY_STREAM_QUEUE_BYTES) {
      // A viewer that cannot keep up. Ending the stream is the only bounded answer: the alternative
      // is holding an unbounded amount of somebody's terminal output in this process.
      stats.overflows += 1;
      send({
        v: RELAY_PROTOCOL_VERSION,
        t: "flow.overflow",
        src: "connector",
        dst: "viewer",
        s: sessionId,
        id: streamId,
        e: "queue-overflow",
      });
      failStream(streamId, "queue-overflow");
      return;
    }
    flushHttpQueue(streamId, stream);
    // Pausing the local response is what makes the bound real rather than decorative: without it
    // the desktop keeps producing into a queue that is already over its watermark.
    if (stream.queuedBytes > RELAY_STREAM_QUEUE_BYTES / 2) stream.response?.pause();
  }

  function flushHttpQueue(streamId: string, stream: HttpStream): void {
    while (stream.queue.length > 0 && stream.window > 0) {
      const chunk = stream.queue[0] as Buffer;
      if (chunk.length > stream.window) break;
      stream.queue.shift();
      stream.queuedBytes -= chunk.length;
      stream.window -= chunk.length;
      stats.bytesOut += chunk.length;
      send(
        {
          v: RELAY_PROTOCOL_VERSION,
          t: "http.response.body",
          src: "connector",
          dst: "viewer",
          s: sessionId,
          id: streamId,
          q: stream.outSeq++,
        },
        chunk,
      );
    }
    if (stream.queuedBytes <= RELAY_STREAM_QUEUE_BYTES / 2) stream.response?.resume();
    if (stream.ended && stream.queue.length === 0) {
      send({
        v: RELAY_PROTOCOL_VERSION,
        t: "http.response.end",
        src: "connector",
        dst: "viewer",
        s: sessionId,
        id: streamId,
      });
      endHttpStream(streamId, "normal");
    }
  }

  function failStream(streamId: string, reason: RelayReason): void {
    if (httpStreams.has(streamId)) {
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
      send({
        v: RELAY_PROTOCOL_VERSION,
        t: "ws.error",
        src: "connector",
        dst: "viewer",
        s: sessionId,
        id: streamId,
        e: "protocol-error",
      });
      return;
    }
    const headers = inboundHeaders(header.h ?? []);
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
    };
    wsStreams.set(streamId, stream);
    stats.wsStreams += 1;

    socketToLocal.on("open", () => {
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
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      // ONE MESSAGE STAYS ONE MESSAGE (review 1 finding 6). A message larger than a frame has to be
      // split, but splitting it silently changed what it was: the browser received several messages
      // instead of one, and a text split inside a multi-byte UTF-8 character arrived as two damaged
      // halves because each fragment was decoded on its own. Each fragment now says whether it is the
      // last, and the relay reassembles before it delivers anything.
      const slices = [...sliceBody(chunk)];
      slices.forEach((slice, index) => {
        enqueueWsData(streamId, stream, slice, isBinary, index === slices.length - 1);
      });
    });
    socketToLocal.on("close", (code: number) => {
      if (!wsStreams.has(streamId)) return;
      wsStreams.delete(streamId);
      send({
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
      if (!wsStreams.has(streamId)) return;
      wsStreams.delete(streamId);
      send({
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
    if (sequence <= stream.inSeq) {
      endWsStream(streamId, 1011, "protocol-error");
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
        endWsStream(streamId, 1009, "too-large");
        return;
      }
      if (!final) {
        wsInbound.set(streamId, held);
        // Credit is still returned per fragment: the bytes are held by this connector, and the relay
        // needs its window back to send the rest of the same message.
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
    stream.queue.push({ data, binary, final });
    stream.queuedBytes += data.length;
    if (stream.queuedBytes > RELAY_STREAM_QUEUE_BYTES) {
      stats.overflows += 1;
      send({
        v: RELAY_PROTOCOL_VERSION,
        t: "flow.overflow",
        src: "connector",
        dst: "viewer",
        s: sessionId,
        id: streamId,
        e: "queue-overflow",
      });
      endWsStream(streamId, 1013, "queue-overflow");
      return;
    }
    flushWsQueue(streamId, stream);
  }

  function flushWsQueue(streamId: string, stream: WsStream): void {
    while (stream.queue.length > 0 && stream.window > 0) {
      const entry = stream.queue[0] as { data: Buffer; binary: boolean; final: boolean };
      if (entry.data.length > stream.window) break;
      stream.queue.shift();
      stream.queuedBytes -= entry.data.length;
      stream.window -= entry.data.length;
      stats.bytesOut += entry.data.length;
      send(
        {
          v: RELAY_PROTOCOL_VERSION,
          t: "ws.data",
          src: "connector",
          dst: "viewer",
          s: sessionId,
          id: streamId,
          q: stream.outSeq++,
          b: entry.binary,
          f: entry.final,
        },
        entry.data,
      );
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

  function inboundHeaders(list: RelayHeaderList): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of list) {
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

/// <reference types="node" />
/**
 * Hand-authored mirror of `@strideterm/mobile-protocol`'s relay modules — the frame codec, the
 * connector-challenge transcript, the key fingerprint and the transport limits.
 *
 * WHY A MIRROR AND NOT AN IMPORT. Same reason `mobile-schemas.ts` is one: this repository cannot
 * import the sibling `strideterm-mobile` checkout across two working trees, and no published
 * `@strideterm/mobile-protocol` registry package exists yet. `npm run check:mobile-schema-drift`
 * compares this file's rule table, role/method/reason sets and limit constants against the
 * generated originals and fails on any divergence, and `mobile-relay-vectors.json` is a copy of the
 * shared test vectors that the same check keeps in step. That is the interim safety net, not a
 * substitute for the real dependency.
 *
 * WHAT THE DECODER GUARANTEES ITS CALLER. A decoded frame has this protocol version, a known type,
 * exactly the fields that type defines, canonical ids, roles that type permits, a payload only
 * where a payload is meaningful, and a size inside the limits. Anything else throws before the
 * caller sees a field. The single most important one is `validateRequestTarget`: it is what keeps a
 * relay message from choosing where the connector connects, and therefore what keeps the connector
 * from being an open proxy into loopback and the LAN.
 */
import { createHash, createPublicKey, type KeyObject } from "node:crypto";

// ---------------------------------------------------------------------------
// Mirror of protocol/schemas/relay-limits.json
// ---------------------------------------------------------------------------

export const RELAY_PROTOCOL_VERSION = 2;
export const RELAY_GRANT_VERSION = 2;
export const RELAY_MAX_GRANT_TOKEN_BYTES = 4096;
export const RELAY_MAX_CLOCK_SKEW_MS = 120000;
export const RELAY_CONNECTOR_GRANT_TTL_MS = 900000;
export const RELAY_VIEWER_GRANT_TTL_MS = 300000;
export const RELAY_RENEWAL_GRANT_TTL_MS = 28800000;
export const RELAY_MAX_FRAME_BYTES = 1048576;
export const RELAY_MAX_FRAME_HEADER_BYTES = 8192;
export const RELAY_MAX_HTTP_HEADER_COUNT = 64;
export const RELAY_MAX_HTTP_HEADER_BYTES = 8192;
export const RELAY_MAX_HTTP_PATH_BYTES = 2048;
export const RELAY_MAX_HTTP_REQUEST_BODY_BYTES = 4194304;
export const RELAY_MAX_HTTP_RESPONSE_BODY_BYTES = 67108864;
export const RELAY_MAX_WS_MESSAGE_BYTES = 4194304;
export const RELAY_MAX_VIEWER_SESSIONS_PER_DESKTOP = 8;
export const RELAY_MAX_HTTP_STREAMS_PER_VIEWER = 32;
export const RELAY_MAX_WS_STREAMS_PER_VIEWER = 4;
export const RELAY_STREAM_QUEUE_BYTES = 4194304;
export const RELAY_MAX_TOTAL_STREAM_QUEUE_BYTES = 16777216;
export const RELAY_FLOW_CREDIT_BYTES = 1048576;
export const RELAY_HTTP_REQUEST_TIMEOUT_MS = 30000;
export const RELAY_CONNECTOR_HANDSHAKE_TIMEOUT_MS = 10000;
export const RELAY_CONNECTOR_SYNC_TIMEOUT_MS = 15000;
export const RELAY_CONNECTOR_HEARTBEAT_MS = 20000;
export const RELAY_CONNECTOR_HEARTBEAT_TIMEOUT_MS = 60000;
export const RELAY_CONNECTOR_LEASE_MS = 28800000;
export const RELAY_VIEWER_SESSION_TTL_MS = 3600000;
export const RELAY_MOBILE_SESSION_ABSOLUTE_TTL_MS = 28800000;
export const RELAY_MOBILE_SESSION_IDLE_TTL_MS = 1800000;
export const RELAY_REVOCATION_TOMBSTONE_TTL_MS = 36000000;
export const RELAY_RECONNECT_BASE_DELAY_MS = 500;
export const RELAY_RECONNECT_MAX_DELAY_MS = 30000;
export const RELAY_GRANT_DEFINITIVE_REFUSAL_RETRY_DELAY_MS = 300000;
export const RELAY_MAX_BOOTSTRAPS_PER_INSTALLATION_PER_MINUTE = 20;
export const RELAY_MAX_SESSIONS_PER_INSTALLATION_PER_MINUTE = 30;
export const RELAY_MAX_REQUESTS_PER_SESSION_PER_MINUTE = 600;

/** Every mirrored limit by name, so the drift check can compare the whole set rather than a list it maintains. */
export const RELAY_LIMITS: Readonly<Record<string, number>> = {
  RELAY_PROTOCOL_VERSION,
  RELAY_GRANT_VERSION,
  RELAY_MAX_GRANT_TOKEN_BYTES,
  RELAY_MAX_CLOCK_SKEW_MS,
  RELAY_CONNECTOR_GRANT_TTL_MS,
  RELAY_VIEWER_GRANT_TTL_MS,
  RELAY_RENEWAL_GRANT_TTL_MS,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_FRAME_HEADER_BYTES,
  RELAY_MAX_HTTP_HEADER_COUNT,
  RELAY_MAX_HTTP_HEADER_BYTES,
  RELAY_MAX_HTTP_PATH_BYTES,
  RELAY_MAX_HTTP_REQUEST_BODY_BYTES,
  RELAY_MAX_HTTP_RESPONSE_BODY_BYTES,
  RELAY_MAX_WS_MESSAGE_BYTES,
  RELAY_MAX_VIEWER_SESSIONS_PER_DESKTOP,
  RELAY_MAX_HTTP_STREAMS_PER_VIEWER,
  RELAY_MAX_WS_STREAMS_PER_VIEWER,
  RELAY_STREAM_QUEUE_BYTES,
  RELAY_MAX_TOTAL_STREAM_QUEUE_BYTES,
  RELAY_FLOW_CREDIT_BYTES,
  RELAY_HTTP_REQUEST_TIMEOUT_MS,
  RELAY_CONNECTOR_HANDSHAKE_TIMEOUT_MS,
  RELAY_CONNECTOR_SYNC_TIMEOUT_MS,
  RELAY_CONNECTOR_HEARTBEAT_MS,
  RELAY_CONNECTOR_HEARTBEAT_TIMEOUT_MS,
  RELAY_CONNECTOR_LEASE_MS,
  RELAY_VIEWER_SESSION_TTL_MS,
  RELAY_MOBILE_SESSION_ABSOLUTE_TTL_MS,
  RELAY_MOBILE_SESSION_IDLE_TTL_MS,
  RELAY_REVOCATION_TOMBSTONE_TTL_MS,
  RELAY_RECONNECT_BASE_DELAY_MS,
  RELAY_RECONNECT_MAX_DELAY_MS,
  RELAY_GRANT_DEFINITIVE_REFUSAL_RETRY_DELAY_MS,
  RELAY_MAX_BOOTSTRAPS_PER_INSTALLATION_PER_MINUTE,
  RELAY_MAX_SESSIONS_PER_INSTALLATION_PER_MINUTE,
  RELAY_MAX_REQUESTS_PER_SESSION_PER_MINUTE,
};

/** The subprotocol a connector offers: `strideterm-relay.v1, <grant>`. */
export const RELAY_CONNECTOR_SUBPROTOCOL = "strideterm-relay.v1";

// ---------------------------------------------------------------------------
// Mirror of protocol/typescript/src/relay/frames.ts
// ---------------------------------------------------------------------------

export type RelayRole = "relay" | "connector" | "viewer";
export const RELAY_ROLES: readonly RelayRole[] = ["relay", "connector", "viewer"];

export type RelayFrameType =
  | "conn.challenge"
  | "conn.authenticate"
  | "conn.sync.request"
  | "conn.sync.complete"
  | "conn.ready"
  | "conn.heartbeat"
  | "conn.drain"
  | "conn.close"
  | "conn.revoke"
  | "http.request.start"
  | "http.request.body"
  | "http.request.end"
  | "http.response.start"
  | "http.response.body"
  | "http.response.end"
  | "http.cancel"
  | "ws.open"
  | "ws.opened"
  | "ws.data"
  | "ws.close"
  | "ws.error"
  | "flow.credit"
  | "flow.overflow"
  | "flow.timeout"
  | "e2e.open"
  | "e2e.data"
  | "e2e.close";

export type RelayHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
export const RELAY_HTTP_METHODS: readonly RelayHttpMethod[] = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

export type RelayReason =
  | "client-cancelled"
  | "connector-gone"
  | "viewer-gone"
  | "queue-overflow"
  | "timeout"
  | "protocol-error"
  | "too-large"
  | "unauthorized"
  | "revoked"
  | "session-expired"
  /** The CONNECTOR's own final lease ended (plan 2026-09-14 D4) — mirrors the generated original. */
  | "lease-expired"
  | "shutting-down"
  | "normal";

export const RELAY_REASONS: readonly RelayReason[] = [
  "client-cancelled",
  "connector-gone",
  "viewer-gone",
  "queue-overflow",
  "timeout",
  "protocol-error",
  "too-large",
  "unauthorized",
  "revoked",
  "session-expired",
  "lease-expired",
  "shutting-down",
  "normal",
];

export type RelayHeaderList = ReadonlyArray<readonly [string, string]>;

export interface RelayFrameHeader {
  v: number;
  t: RelayFrameType;
  src: RelayRole;
  dst: RelayRole;
  s?: string;
  id?: string;
  q?: number;
  n?: string;
  g?: string;
  p?: string;
  k?: string;
  m?: RelayHttpMethod;
  u?: string;
  h?: RelayHeaderList;
  c?: number;
  b?: boolean;
  /** `ws.data` only: true when this frame completes the browser message. Absent means the same. */
  f?: boolean;
  /** `conn.revoke` only: when this desktop recorded the revocation, epoch milliseconds. */
  r?: number;
  w?: number;
  e?: RelayReason;
  x?: number;
  d?: string;
}

export interface RelayFrame {
  header: RelayFrameHeader;
  payload: Buffer;
}

export const RELAY_FRAME_ALWAYS_FIELDS: readonly string[] = ["v", "t", "src", "dst"];

interface FrameRule {
  required: readonly string[];
  optional: readonly string[];
  src: RelayRole | "any";
  dst: RelayRole | "any";
}

export const RELAY_FRAME_RULES: Readonly<Record<RelayFrameType, FrameRule>> = {
  "conn.challenge": { required: ["n"], optional: [], src: "relay", dst: "connector" },
  "conn.authenticate": { required: ["g", "p", "k"], optional: [], src: "connector", dst: "relay" },
  // The revocation-sync phase (plan §3). Neither frame carries a session id: the id is issued at
  // `conn.ready`, which the relay sends only after this phase has been applied.
  "conn.sync.request": { required: [], optional: [], src: "relay", dst: "connector" },
  "conn.sync.complete": { required: [], optional: [], src: "connector", dst: "relay" },
  "conn.ready": { required: ["s"], optional: [], src: "relay", dst: "connector" },
  "conn.heartbeat": { required: ["s"], optional: [], src: "any", dst: "any" },
  "conn.drain": { required: ["s", "e"], optional: [], src: "relay", dst: "connector" },
  "conn.close": { required: ["s", "e"], optional: [], src: "any", dst: "any" },
  // `s` is optional because the same frame serves both cases: a live revoke names the session, and
  // one replayed during `conn.sync` cannot. `r` is the instant this desktop recorded, so a replay
  // does not renew the relay's tombstone.
  "conn.revoke": { required: ["d"], optional: ["s", "r"], src: "connector", dst: "relay" },
  "http.request.start": { required: ["s", "id", "m", "u", "h"], optional: [], src: "viewer", dst: "connector" },
  "http.request.body": { required: ["s", "id", "q"], optional: [], src: "viewer", dst: "connector" },
  "http.request.end": { required: ["s", "id"], optional: [], src: "viewer", dst: "connector" },
  "http.response.start": { required: ["s", "id", "c", "h"], optional: [], src: "connector", dst: "viewer" },
  "http.response.body": { required: ["s", "id", "q"], optional: [], src: "connector", dst: "viewer" },
  "http.response.end": { required: ["s", "id"], optional: [], src: "connector", dst: "viewer" },
  "http.cancel": { required: ["s", "id", "e"], optional: [], src: "any", dst: "any" },
  "ws.open": { required: ["s", "id", "u", "h"], optional: [], src: "viewer", dst: "connector" },
  "ws.opened": { required: ["s", "id"], optional: ["h"], src: "connector", dst: "viewer" },
  "ws.data": { required: ["s", "id", "q", "b"], optional: ["f"], src: "any", dst: "any" },
  "ws.close": { required: ["s", "id", "x", "e"], optional: [], src: "any", dst: "any" },
  "ws.error": { required: ["s", "id", "e"], optional: [], src: "any", dst: "any" },
  "flow.credit": { required: ["s", "id", "w"], optional: [], src: "any", dst: "any" },
  "flow.overflow": { required: ["s", "id", "e"], optional: [], src: "any", dst: "any" },
  "flow.timeout": { required: ["s", "id", "e"], optional: [], src: "any", dst: "any" },
  // Relay end-to-end encryption (plan 2026-09-23, decision 2). The payload is an opaque
  // AEAD-encrypted inner relay frame; none of `m`/`u`/`h` is declared here, so the generic
  // allow-list below refuses them on these types like any other undeclared field.
  // `d`, when present, is the relay stamping the viewer-grant-verified device id onto the frame it
  // forwards to the connector — the connector's only way to find the right derived session key for
  // a newly opened stream.
  "e2e.open": { required: ["s", "id"], optional: ["d"], src: "any", dst: "any" },
  "e2e.data": { required: ["s", "id", "q"], optional: [], src: "any", dst: "any" },
  "e2e.close": { required: ["s", "id", "e"], optional: [], src: "any", dst: "any" },
};

export const RELAY_FRAME_TYPES = Object.keys(RELAY_FRAME_RULES) as RelayFrameType[];

export function relayFrameCarriesPayload(type: RelayFrameType): boolean {
  return RELAY_FRAME_RULES[type].required.includes("q");
}

export class RelayFrameError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`relay-frame: ${code}`);
    this.name = "RelayFrameError";
    this.code = code;
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+._|~^-]{1,128}$/;

export function encodeRelayFrame(header: RelayFrameHeader, payload: Buffer = Buffer.alloc(0)): Buffer {
  validateRelayFrameHeader(header);
  if (payload.length > 0 && !relayFrameCarriesPayload(header.t)) {
    throw new RelayFrameError("payload-not-allowed");
  }
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.length > RELAY_MAX_FRAME_HEADER_BYTES) throw new RelayFrameError("header-too-large");
  const total = 4 + headerBytes.length + payload.length;
  if (total > RELAY_MAX_FRAME_BYTES) throw new RelayFrameError("frame-too-large");

  const out = Buffer.allocUnsafe(total);
  out.writeUInt32BE(headerBytes.length, 0);
  headerBytes.copy(out, 4);
  payload.copy(out, 4 + headerBytes.length);
  return out;
}

export function decodeRelayFrame(bytes: Buffer): RelayFrame {
  if (!Buffer.isBuffer(bytes)) throw new RelayFrameError("not-bytes");
  if (bytes.length > RELAY_MAX_FRAME_BYTES) throw new RelayFrameError("frame-too-large");
  if (bytes.length < 4) throw new RelayFrameError("truncated");

  const headerLength = bytes.readUInt32BE(0);
  if (headerLength === 0) throw new RelayFrameError("empty-header");
  if (headerLength > RELAY_MAX_FRAME_HEADER_BYTES) throw new RelayFrameError("header-too-large");
  if (4 + headerLength > bytes.length) throw new RelayFrameError("truncated");

  const headerSlice = bytes.subarray(4, 4 + headerLength);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(headerSlice);
  } catch {
    throw new RelayFrameError("header-not-utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RelayFrameError("header-not-json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RelayFrameError("header-not-an-object");
  }
  const header = parsed as RelayFrameHeader;
  validateRelayFrameHeader(header);

  const payload = bytes.subarray(4 + headerLength);
  if (payload.length > 0 && !relayFrameCarriesPayload(header.t)) {
    throw new RelayFrameError("payload-not-allowed");
  }
  // A fresh copy, not a view: `ws` hands out slices of a pooled buffer that is reused for the next
  // message, so a retained subarray would silently mutate under a queued frame.
  return { header, payload: Buffer.from(payload) };
}

export function validateRelayFrameHeader(header: unknown): asserts header is RelayFrameHeader {
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new RelayFrameError("header-not-an-object");
  }
  const record = header as Record<string, unknown>;

  if (record.v !== RELAY_PROTOCOL_VERSION) throw new RelayFrameError("unsupported-version");

  const type = record.t;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(RELAY_FRAME_RULES, type)) {
    throw new RelayFrameError("unknown-type");
  }
  const rule = RELAY_FRAME_RULES[type as RelayFrameType];

  const allowed = new Set<string>([...RELAY_FRAME_ALWAYS_FIELDS, ...rule.required, ...rule.optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new RelayFrameError("unknown-field");
  }
  for (const key of rule.required) {
    if (record[key] === undefined) throw new RelayFrameError("missing-field");
  }

  const src = record.src;
  const dst = record.dst;
  if (typeof src !== "string" || !RELAY_ROLES.includes(src as RelayRole)) throw new RelayFrameError("unknown-src-role");
  if (typeof dst !== "string" || !RELAY_ROLES.includes(dst as RelayRole)) throw new RelayFrameError("unknown-dst-role");
  if (src === dst) throw new RelayFrameError("src-equals-dst");
  if (rule.src !== "any" && src !== rule.src) throw new RelayFrameError("src-role-not-allowed");
  if (rule.dst !== "any" && dst !== rule.dst) throw new RelayFrameError("dst-role-not-allowed");

  if (record.s !== undefined && !isRelayId(record.s)) throw new RelayFrameError("session-id-not-canonical");
  if (record.id !== undefined && !isRelayId(record.id)) throw new RelayFrameError("stream-id-not-canonical");
  if (record.d !== undefined && !isRelayId(record.d)) throw new RelayFrameError("device-id-not-canonical");

  if (record.q !== undefined && (!Number.isInteger(record.q) || (record.q as number) < 0)) {
    throw new RelayFrameError("sequence-invalid");
  }
  if (record.n !== undefined && !(typeof record.n === "string" && NONCE_PATTERN.test(record.n))) {
    throw new RelayFrameError("nonce-not-canonical");
  }
  if (record.g !== undefined && !(typeof record.g === "string" && record.g.length > 0 && record.g.length <= 4096)) {
    throw new RelayFrameError("grant-invalid");
  }
  if (record.p !== undefined && !(typeof record.p === "string" && SIGNATURE_PATTERN.test(record.p))) {
    throw new RelayFrameError("proof-not-canonical");
  }
  if (record.k !== undefined && !(typeof record.k === "string" && PUBLIC_KEY_PATTERN.test(record.k))) {
    throw new RelayFrameError("public-key-not-canonical");
  }
  if (record.m !== undefined && !RELAY_HTTP_METHODS.includes(record.m as RelayHttpMethod)) {
    throw new RelayFrameError("unknown-method");
  }
  if (record.u !== undefined) validateRequestTarget(record.u);
  if (record.h !== undefined) validateHeaderList(record.h);
  if (
    record.c !== undefined &&
    (!Number.isInteger(record.c) || (record.c as number) < 100 || (record.c as number) > 599)
  ) {
    throw new RelayFrameError("status-invalid");
  }
  if (record.b !== undefined && typeof record.b !== "boolean") throw new RelayFrameError("binary-flag-invalid");
  if (record.f !== undefined && typeof record.f !== "boolean") throw new RelayFrameError("final-flag-invalid");
  if (record.r !== undefined && (!Number.isInteger(record.r) || (record.r as number) < 0)) {
    throw new RelayFrameError("revoked-at-invalid");
  }
  if (
    record.w !== undefined &&
    (!Number.isInteger(record.w) || (record.w as number) < 1 || (record.w as number) > 67108864)
  ) {
    throw new RelayFrameError("credit-invalid");
  }
  if (record.e !== undefined && !RELAY_REASONS.includes(record.e as RelayReason)) {
    throw new RelayFrameError("unknown-reason");
  }
  if (
    record.x !== undefined &&
    (!Number.isInteger(record.x) || (record.x as number) < 1000 || (record.x as number) > 4999)
  ) {
    throw new RelayFrameError("close-code-invalid");
  }
}

/**
 * A request target must be origin-form: a path, optionally with a query.
 *
 * This is the single check that keeps the connector from becoming an open proxy. An absolute URL,
 * a scheme-relative `//host/path`, a backslash (which some URL parsers fold to `/`), a `..` segment
 * or a raw control character would each let a relay message choose where the connector connects.
 * What survives here is resolved against the connector's ONE internal origin and nothing else.
 */
export function validateRequestTarget(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new RelayFrameError("target-not-a-string");
  if (value.length === 0) throw new RelayFrameError("target-empty");
  if (value.length > RELAY_MAX_HTTP_PATH_BYTES) throw new RelayFrameError("target-too-long");
  if (!value.startsWith("/")) throw new RelayFrameError("target-not-origin-form");
  if (value.startsWith("//")) throw new RelayFrameError("target-not-origin-form");
  if (value.includes("\\")) throw new RelayFrameError("target-has-backslash");

  if (/[\u0000-\u001f\u007f]/.test(value)) throw new RelayFrameError("target-has-control-characters");
  const pathPart = value.split("?", 1)[0] as string;
  for (const segment of pathPart.split("/")) {
    if (segment === "..") throw new RelayFrameError("target-has-dot-dot");
  }
}

export function validateHeaderList(value: unknown): asserts value is RelayHeaderList {
  if (!Array.isArray(value)) throw new RelayFrameError("headers-not-an-array");
  if (value.length > RELAY_MAX_HTTP_HEADER_COUNT) throw new RelayFrameError("too-many-headers");
  let total = 0;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new RelayFrameError("header-not-a-pair");
    const [name, headerValue] = entry as [unknown, unknown];
    if (typeof name !== "string" || !HEADER_NAME_PATTERN.test(name)) throw new RelayFrameError("header-name-invalid");
    if (name !== name.toLowerCase()) throw new RelayFrameError("header-name-not-lowercase");
    if (typeof headerValue !== "string") throw new RelayFrameError("header-value-not-a-string");

    if (/[\u0000-\u001f\u007f]/.test(headerValue)) throw new RelayFrameError("header-value-has-control-characters");
    total += name.length + headerValue.length;
    if (total > RELAY_MAX_HTTP_HEADER_BYTES) throw new RelayFrameError("headers-too-large");
  }
}

export function isRelayId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Mirror of the grant-side helpers the connector needs
// ---------------------------------------------------------------------------

/**
 * Canonical unpadded base64url, decoded strictly.
 *
 * Node's decoder is permissive: it accepts padding, the standard alphabet's `+`/`/`, and trailing
 * junk. A relay identifier compared for equality on both sides of a wire must have exactly one
 * spelling, so this re-encodes and compares.
 */
export function decodeCanonicalBase64Url(value: string, field: string): Buffer {
  if (typeof value !== "string" || value.length === 0) throw new RelayFrameError(`${field}-empty`);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new RelayFrameError(`${field}-illegal-characters`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new RelayFrameError(`${field}-not-canonical`);
  return decoded;
}

/** Unpadded base64url SHA-256 of a raw 32-byte Ed25519 public key — the value a connector grant pins. */
export function relayKeyFingerprint(rawPublicKey: Buffer): string {
  if (rawPublicKey.length !== 32) throw new RelayFrameError("public-key-wrong-length");
  return createHash("sha256").update(rawPublicKey).digest("base64url");
}

/**
 * The bytes a connector signs to answer the relay's challenge.
 *
 * Everything that identifies the attempt is inside: the audience the relay serves, the installation
 * the grant names, the fingerprint of the key signing, and the relay's one-time nonce. A signature
 * captured from installation A's handshake therefore cannot be replayed into installation B's, into
 * another relay, or into a second handshake of A's own.
 */
export function relayConnectorChallengeTranscript(args: {
  audience: string;
  desktopInstallationId: string;
  connectorKeyFingerprint: string;
  nonce: string;
}): Buffer {
  return Buffer.from(
    [
      "strideterm-relay-connector-challenge",
      `v=${RELAY_GRANT_VERSION}`,
      `aud=${args.audience}`,
      `installation=${args.desktopInstallationId}`,
      `key=${args.connectorKeyFingerprint}`,
      `nonce=${args.nonce}`,
    ].join("\n"),
    "utf8",
  );
}

/** Raw 32-byte Ed25519 public key out of a Node `KeyObject` (the tail of its SPKI encoding). */
export function rawEd25519PublicKey(publicKey: KeyObject): Buffer {
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return Buffer.from(spki.subarray(spki.length - 32));
}

/** Re-imports a raw 32-byte Ed25519 public key, for verifying a peer's signature. */
export function ed25519PublicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new RelayFrameError("public-key-wrong-length");
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: "der", type: "spki" });
}

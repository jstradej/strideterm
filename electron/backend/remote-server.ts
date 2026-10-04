/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import * as fm from "./file-manager.js";
import * as attachments from "./attachments.js";
import { AttachmentPolicyError } from "./attachment-file-policy.js";
import { deriveSessionKey, openEnvelope, publicKeyFromRaw, sealEnvelope } from "./mobile/mobile-crypto.js";
import { decodeCanonicalPublicKey } from "./mobile/mobile-crypto.js";
import {
  dockerActionSchema,
  dockerComposeActionSchema,
  dockerInspectSchema,
  dockerLogsCloseSchema,
  dockerLogsOpenSchema,
  dockerLogsUpdateSchema,
  dockerPruneSchema,
  dockerRemoveSchema,
  dockerResourceRefSchema,
  dockerShellCloseSchema,
  dockerShellOpenSchema,
  dockerStatsSchema,
  dockerSystemDfSchema,
  dockerTopSchema,
  dockerVolumeBrowseSchema,
  gitBranchDeleteSchema,
  gitBranchListSchema,
  gitBranchRenameSchema,
  gitCheckoutRemoteSchema,
  gitCherryPickSchema,
  gitCommitSchema,
  gitLogGraphSchema,
  gitPayloadSchema,
  gitRemoteBranchDeleteSchema,
  gitStashApplySchema,
  gitStashBranchSchema,
  gitStashDropSchema,
  gitStashExportSchema,
  gitStashFileDiffSchema,
  gitStashFilesSchema,
  gitStashImportSchema,
  gitStashListSchema,
  gitSquashSchema,
  mobileSessionBootstrapSchema,
  mobileAttachmentEnvelopeSchema,
  mobileAttachmentOperationSchema,
  taskUpdateDescriptionSchema,
  taskCompanionCreateSchema,
  taskCompanionAnswerSchema,
  terminalSessionSchema,
  validateIpc,
  workspaceDeleteOptionsSchema,
  workspaceIdSchema,
  workspaceGridEnableSchema,
  workspaceGridSetCellSchema,
  workspaceGridSetLayoutSchema,
  workspaceGridSwapCellsSchema,
  nativeWorkspaceDirectoryListSchema,
  nativeWorkspaceDirectoryCreateSchema,
  nativeWorkspaceCreateSchema,
  nativeWorkspaceProfileSchema,
  nativeScratchpadKeepSchema,
  nativeScratchpadDiscardSchema,
  wsDockerShellResizeSchema,
  wsDockerShellWriteSchema,
  wsResourceInterestSchema,
  wsTerminalInputSchema,
  wsTerminalResizeSchema,
  wsTerminalSubscribeSchema,
} from "./ipc-schemas.js";
import { isLoopbackBindHost, resolveRemoteAccessPort, resolveRemoteBindHost } from "../../config/app-config.js";
import { getLogger, createAuditLogger } from "./logger.js";
import { RemoteClientRegistry } from "./remote-client-registry.js";
import {
  RELAY_MOBILE_SESSION_ABSOLUTE_TTL_MS,
  RELAY_MOBILE_SESSION_IDLE_TTL_MS,
} from "./mobile/mobile-relay-protocol.js";
import { parseRemoteViewerId, remoteViewerId } from "./viewer-id.js";
import { ClientRequestError } from "./shared/client-request-error.js";
import { classifyMobileRoute, evaluateMobileRoute } from "./mobile-session-route-policy.js";
import { NOTIFICATION_TARGET_REMOVED_CHANNEL } from "../shared/notification-lifecycle.js";
import { APPROVAL_RECORDED_CHANNEL } from "../shared/approval-events.js";
import {
  buildRemoteCore,
  buildResourceDetail,
  isKnownResourceKey,
  looksLikeStatePayload,
  resourceProfileAuthorized,
  resourceRevision,
  REMOTE_STATE_PROTOCOL,
  selectCapabilities,
  servesRemoteCore,
  strayStatePayloadKeys,
} from "./remote-core.js";

/**
 * Cookie carrying a per-session ID. Once the user has bootstrapped via the
 * token-bearing share URL, the cookie is what every subsequent request
 * authenticates with — the master token is never sent again from a normal
 * browser session, so it stops appearing in URL bars, browser history,
 * proxy logs, screen shares, or accidental "copy this link" leaks.
 *
 * The cookie value is a fresh 256-bit random per session, *not* the
 * master token, so even if the cookie store is somehow exfiltrated we
 * don't lose the long-lived token. It survives only in this process —
 * regenerating the token (or restarting the server, which happens on
 * any settings change) tears down all sessions.
 *
 * Attributes:
 *   - HttpOnly: JS can't read it (mitigates XSS-driven session theft).
 *   - SameSite=Strict: browser only sends it on first-party requests,
 *     so even if a leaked URL is opened in another tab the cookie won't
 *     ride a cross-origin form post.
 *   - Path=/: applies to every endpoint on this origin.
 *   - Secure: appended only when `X-Forwarded-Proto: https` indicates the
 *     browser ↔ proxy hop was TLS (Cloudflare tunnel, reverse proxy). For
 *     bare HTTP LAN we omit it — `Secure` would forbid the browser from
 *     ever sending the cookie back, breaking the LAN bootstrap. See
 *     `buildSessionCookieAttrs` below.
 */
/**
 * Header the managed relay's connector presents on every request and upgrade it forwards into the
 * loopback origin. See `startRemoteServer`'s `loopbackOrigin.guardToken` for what it does and — just
 * as importantly — what it does not: it says "this is the connector", never "this caller is
 * authorized", which is still the WebView ticket's and the session cookie's job.
 */
const RELAY_ORIGIN_GUARD_HEADER = "x-strideterm-relay-origin";

const SESSION_COOKIE_NAME = "strideterm_session";
const SESSION_COOKIE_ATTRS_BASE = "HttpOnly; SameSite=Strict; Path=/";

/**
 * Decide whether the cookie should carry the `Secure` attribute. When the
 * client reaches us through Cloudflare tunnel (or any other HTTPS reverse
 * proxy) the request socket is plain HTTP from the proxy → us, but the
 * browser ↔ proxy hop is TLS. The proxy advertises that via
 * `X-Forwarded-Proto: https`, and the browser will only consent to send a
 * `Secure` cookie back over the same scheme. Skipping `Secure` for the bare
 * LAN-HTTP case (no proxy) keeps the LAN bootstrap working — browsers scope
 * cookies by origin so an HTTP and HTTPS deployment never see each other's
 * cookies anyway, but adding `Secure` to an HTTPS-fronted deployment closes
 * the door on accidental insecure-channel echoes (e.g. tooling that strips
 * TLS for debugging).
 */
export function buildSessionCookieAttrs(headers: IncomingMessage["headers"]): string {
  const proto = String(headers["x-forwarded-proto"] || "")
    .toLowerCase()
    .split(",")[0]
    .trim();
  if (proto === "https") return `${SESSION_COOKIE_ATTRS_BASE}; Secure`;
  return SESSION_COOKIE_ATTRS_BASE;
}

const log = getLogger("remote-server");

/**
 * Heartbeat interval for remote WebSocket clients. Each tick we send a
 * ping; we only terminate a client after WS_HEARTBEAT_MAX_MISSED consecutive
 * ticks with no pong, not on the first miss.
 *
 * 20s is short enough to keep most NAT mappings (typical home-router UDP/TCP
 * keepalive is 30–60s) and long enough to be a rounding error on traffic.
 * The previous 30s "one strike and you're out" config evicted mobile clients
 * on a single sub-second network blip — a phone briefly losing 4G on a
 * subway stop reliably tripped a termination, then the client reconnected,
 * which spammed `WebSocket heartbeat timeout` warnings every few minutes
 * and silently lost any in-flight push notifications during the gap.
 *
 * MAX_MISSED=3 means a client must be unreachable for ~60s before we drop
 * it — still bounded so leaked tokens / kernel-dead sockets clean up, but
 * forgiving enough that flaky mobile networks don't get into reconnect
 * loops.
 */
const WS_HEARTBEAT_INTERVAL_MS = 20_000;
const WS_HEARTBEAT_MAX_MISSED = 3;

// Live-backlog watermark above which a filtered socket is considered
// "backlogged" and the stall clock starts. This is deliberately NOT a hard cap
// on any single frame: a one-shot frame (the bootstrap state, a replay burst)
// on an empty/draining socket is always allowed to queue. Only a backlog that
// FAILS TO DRAIN past this line for SOCKET_STALL_GRACE_MS trips a close — the
// 2.4.11 regression was caused by treating one large frame as proof of
// congestion. See socketStallDecision.
const SOCKET_STALL_THRESHOLD_BYTES = 2 * 1024 * 1024;
// A backlogged socket that makes no drain progress for this long is a genuinely
// stalled consumer and is closed (1013) so it can reconnect and recover via
// bounded replay. Any shrinking of the backlog resets the clock. Injectable so
// tests don't wait the full window.
const SOCKET_STALL_GRACE_MS = 15_000;
// How often the stall sweep samples each filtered socket's live backlog.
const SOCKET_STALL_SWEEP_MS = 1_000;
// Last-resort absolute memory ceiling. An already-queued live backlog above
// this is closed immediately, independent of drain timing — pure memory safety
// if a socket wedges hard between stall samples. Sized far above any legitimate
// frame (bootstrap state, replay) so it can never recreate the single-frame
// disconnect loop.
const SOCKET_HARD_CEILING_BYTES = 48 * 1024 * 1024;
// Grace period after a 1013 close handshake before we terminate() the socket to
// release its queued memory even if the client never completes the close.
const CONGESTION_CLOSE_GRACE_MS = 5_000;
// Upper bound on the session ids one subscribe request may carry — a defence
// against a buggy/hostile client, sized well above any real visible grid.
const MAX_SUBSCRIBED_SESSIONS = 64;

/**
 * Last-resort memory-safety decision for a filtered socket, exported for unit
 * tests (kernel socket buffers on loopback absorb multi-MB queues, so the
 * accounting can't be exercised deterministically over real TCP).
 *
 * The decision is made on the EXISTING live backlog only — never on the size of
 * the frame about to be sent. A large one-shot frame on an empty/draining
 * socket must pass (that was the 2.4.11 regression). `trip` means the
 * already-queued live backlog alone exceeds `limit`, i.e. the socket has wedged
 * hard; normal slow-consumer detection is the time-based socketStallDecision,
 * this is only the absolute ceiling.
 *
 * `exemptBytes` is the count of replay bytes STILL queued on the socket. It is
 * maintained precisely by the caller: incremented when a replay is enqueued and
 * decremented by that replay's send-drain callback when it actually flushes — so
 * it can never credit already-drained replay (or any live/state byte) as exempt.
 * The live backlog is `bufferedAmount - exemptBytes` (clamped at 0 to absorb
 * transient skew between the drain callback and the OS socket buffer).
 */
export function terminalBackpressureDecision(
  exemptBytes: number,
  bufferedAmount: number,
  limit: number,
): { trip: boolean } {
  const liveBacklog = Math.max(0, bufferedAmount - exemptBytes);
  return { trip: liveBacklog > limit };
}

/**
 * Time-based stall decision for a filtered socket, exported for unit tests.
 * Replaces "one big frame closes the socket" with "a backlog that never drains
 * closes the socket". A socket below the watermark is healthy and clears its
 * stall clock; a backlogged socket that keeps shrinking is making progress and
 * also resets the clock; only a backlog that sits above the watermark WITHOUT
 * progress for `graceMs` trips.
 */
export function socketStallDecision(args: {
  liveBacklog: number;
  prevLiveBacklog: number;
  backlogSince: number | null;
  now: number;
  thresholdBytes: number;
  graceMs: number;
}): { backlogSince: number | null; trip: boolean } {
  const { liveBacklog, prevLiveBacklog, backlogSince, now, thresholdBytes, graceMs } = args;
  if (liveBacklog <= thresholdBytes) return { backlogSince: null, trip: false };
  // Backlogged: start the clock on first entry, and restart it whenever the
  // backlog shrinks (the consumer IS draining, just slowly).
  if (backlogSince === null || liveBacklog < prevLiveBacklog) return { backlogSince: now, trip: false };
  return { backlogSince, trip: now - backlogSince >= graceMs };
}

/**
 * Total time-to-drain accounting for the stall sweep, exported for unit tests.
 * DISTINCT from the stall-grace clock (socketStallDecision.backlogSince, which
 * must reset on every shrink so a slowly-but-steadily draining socket is never
 * closed): `backlogEnteredAt` is stamped ONCE on the first crossing above the
 * watermark and NOT reset when the backlog merely shrinks, so a backlog that
 * drains in steps reports the full first-crossing→cleared span rather than only
 * its final step. Returns the next `backlogEnteredAt` and, on the tick the
 * backlog clears, the total drain duration to record (else null).
 */
export function drainTelemetryTransition(args: {
  backlogEnteredAt: number | null;
  backloggedNow: boolean;
  now: number;
}): { backlogEnteredAt: number | null; drainMs: number | null } {
  const { backlogEnteredAt, backloggedNow, now } = args;
  if (backlogEnteredAt === null && backloggedNow) return { backlogEnteredAt: now, drainMs: null };
  if (backlogEnteredAt !== null && !backloggedNow) return { backlogEnteredAt: null, drainMs: now - backlogEnteredAt };
  return { backlogEnteredAt, drainMs: null };
}

/**
 * Latest-wins state-send coalescer for one socket. At most one state frame is
 * in flight; a state produced while a send is in flight replaces the single
 * pending frame, so a burst of mutations delivers only the newest follow-up
 * rather than N queued historical snapshots. `send` must invoke its callback
 * once the frame has drained to the OS. Terminal / docker / ssh streams do NOT
 * use this — they keep strict ordering via checkedSend.
 *
 * `enqueue` returns what happened so the caller can drive telemetry:
 *   "dispatched" — sent immediately (nothing was in flight);
 *   "queued"     — held as the single pending frame (a send is in flight);
 *   "coalesced"  — replaced a previously-pending frame that was never sent.
 */
export function makeStateCoalescer(send: (data: string, onDrain: () => void) => void): {
  enqueue: (data: string) => "dispatched" | "queued" | "coalesced";
  hasPending: () => boolean;
} {
  let sending = false;
  let pending: string | null = null;
  function dispatch(data: string): void {
    sending = true;
    send(data, onDrain);
  }
  function onDrain(): void {
    sending = false;
    if (pending !== null) {
      const next = pending;
      pending = null;
      dispatch(next);
    }
  }
  function enqueue(data: string): "dispatched" | "queued" | "coalesced" {
    if (sending) {
      const replaced = pending !== null;
      pending = data;
      return replaced ? "coalesced" : "queued";
    }
    dispatch(data);
    return "dispatched";
  }
  return { enqueue, hasPending: () => pending !== null };
}

/**
 * Diagnostic aggregator for remote state delivery. Everything here is
 * telemetry — never a hard pass/fail limit. Tracks serialized frame sizes
 * (p50/p95), state broadcasts produced vs actually sent vs coalesced away, the
 * high-water live backlog and backlog drain times. Exported for unit tests.
 */
export function createRemoteTelemetry(now: () => number = () => Date.now()) {
  const startedAt = now();
  let stateProduced = 0;
  let stateSent = 0;
  let stateCoalesced = 0;
  let maxBacklog = 0;
  const frameSizes: number[] = [];
  const drainMs: number[] = [];
  const MAX_SAMPLES = 512;
  function sample(arr: number[], v: number): void {
    arr.push(v);
    if (arr.length > MAX_SAMPLES) arr.shift();
  }
  function pct(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  }
  // Frames actually delivered (post-coalescing) per minute since start — the
  // rate the plan asks for. Cumulative so it never mutates on read; the periodic
  // logger emits it every minute, exposing the delivery-frequency trend that the
  // raw cumulative counts alone hide (a burst vs a steady trickle look the same
  // in `stateSent`, but not in the rate between two log lines).
  function sendRatePerMin(): number {
    const elapsedMs = Math.max(1, now() - startedAt);
    return Number(((stateSent * 60000) / elapsedMs).toFixed(2));
  }
  return {
    recordStateProduced: (): void => {
      stateProduced++;
    },
    recordStateSent: (): void => {
      stateSent++;
    },
    recordStateCoalesced: (): void => {
      stateCoalesced++;
    },
    recordFrame: (bytes: number): void => sample(frameSizes, bytes),
    recordBacklog: (bytes: number): void => {
      if (bytes > maxBacklog) maxBacklog = bytes;
    },
    recordDrainMs: (ms: number): void => sample(drainMs, ms),
    hasActivity: (): boolean => stateProduced > 0 || frameSizes.length > 0,
    snapshot: () => ({
      stateProduced,
      stateSent,
      stateCoalesced,
      sendRatePerMin: sendRatePerMin(),
      frameP50: pct(frameSizes, 50),
      frameP95: pct(frameSizes, 95),
      maxBacklog,
      drainP95Ms: pct(drainMs, 95),
      frameSamples: frameSizes.length,
    }),
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

/**
 * Minimal Runtime interface covering the methods used in the remote server.
 * The actual runtime object returned by createRuntime() satisfies this shape.
 */
interface Runtime {
  isPrivateSshOperationSessionId?: (sessionId: unknown) => boolean;
  isSshTestSessionId?: (sessionId: unknown) => boolean;
  listWorkspaceDirectories?: (
    profileId: string,
    requestedPath?: string,
    options?: { query?: string; sort?: "nameAsc" | "nameDesc" },
  ) => Promise<unknown>;
  createWorkspaceDirectory?: (profileId: string, parentPath: string, name: string) => Promise<unknown>;
  createWorkspaceFromDirectory?: (profileId: string, cwd: string, name?: string, viewerId?: string) => Promise<unknown>;
  listScratchpadWorkspaces?: (profileId: string) => Promise<unknown>;
  createScratchpadWorkspace?: (profileId: string, viewerId?: string) => Promise<unknown>;
  keepScratchpadWorkspace?: (
    profileId: string,
    workspaceId: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  discardScratchpadWorkspace?: (profileId: string, workspaceId: string, confirmed: boolean) => Promise<unknown>;
  getPayload(): {
    appState: {
      settings: {
        remoteAccess: { enabled: boolean; paused?: boolean; host: string; port: number; token: string };
      };
    };
  };
  getInitialState(): Promise<unknown>;
  setRemoteInfo(info: { enabled: boolean; urls?: string[]; port?: number; host?: string; error?: string }): void;
  listRemoteUrls(): string[];
  /**
   * Every origin a mobile WebView ticket may currently be redeemed at on the LEGACY server.
   *
   * The runtime owns it because the runtime is the only party that sees all three sources at once —
   * the bound LAN URLs, the live quick-tunnel URL and the operator's custom public URL — and because
   * "which origins is this desktop reachable at right now" changes while the server runs. A ticket
   * naming an origin that has dropped off this list is no longer redeemable, which is what stops one
   * minted for a dead quick tunnel from working against its replacement (production hardening §5
   * "Ticket" 4).
   */
  listMobileTicketOrigins?(): string[];
  on(channel: string, handler: AnyFn): () => void;
  /** Wires this server's session-revoke function back into the runtime (see MobileManager.revokeDevice). */
  setMobileRemoteSessionRevoker?(fn: (deviceId: string) => void): void;
  /** Single-use WebView session ticket exchange (plan §9.2) — null on any failure, reason undisclosed. */
  consumeMobileWebSessionTicket?(
    ticketId: string,
    secret: string,
    context: { transport: "relay" | "legacy"; origins: readonly string[] },
  ): {
    deviceId: string;
    pairId: string;
    profileId: string;
    allowedOrigin: string;
    transport: "relay" | "legacy";
    requiredCapability: "remote.webSession";
    expiresAt: number;
  } | null;
  /**
   * Whether [deviceId] may still hold a mobile session on [profileId], right now.
   *
   * Asked on every request a mobile session makes, because the two things that can change under a
   * live session are not revokes and so nothing pushes them: the device's capability list and its
   * profile allowlist (production hardening §5 "Session" 2/4). The runtime answers from the same
   * device store every other authorization reads.
   */
  isMobileSessionStillAuthorized?(deviceId: string, profileId: string): boolean;
  /**
   * Appends a `session.*` row to the local mobile audit log (and its `mobile-audit.log` mirror) for
   * a session minted from a mobile ticket. Metadata only — callers never pass typed bytes or file
   * contents. Sessions with no device (browser, master token, Telegram) are not recorded.
   */
  recordMobileSessionAudit?(entry: {
    deviceId: string;
    pairId: string;
    action: string;
    status: "success" | "failure";
    detail?: string;
  }): void;
  /**
   * The CURRENT set of live mobile sessions, pushed every time it changes (a session minted, ended,
   * revoked, or the server stopping — then the list is empty). The desktop shows it as "a phone is
   * connected now". Deliberately carries no `sessionId` (the bearer credential) and no `pairId`.
   *
   * `source` names which server reports, because the direct and the relay-origin servers each hold
   * their own sessions: the receiver merges per source rather than letting one overwrite the other.
   */
  onMobileSessionsChanged?(
    sessions: ReadonlyArray<{ deviceId: string; profileId: string; startedAt: number }>,
    source?: string,
  ): void;
  getMobileAttachmentContext?(deviceId: string): {
    desktopDeviceId: string;
    privateKey: import("node:crypto").KeyObject;
    device: {
      publicKey: string;
      pairId: string;
      sessionKeyVersion: number;
      capabilities: string[];
      profileAllowlist: string[];
      revoked?: boolean;
      state?: string;
    } | null;
  };
  writeToSession(sessionId: string, data: string, viewerId?: string, originWorkspaceId?: string): unknown;
  resizeSession(sessionId: string, size: { cols: number; rows: number }): void;
  // getTerminalReplaySnapshot / getTerminalReplay and all other methods are
  // accessed dynamically via the string index signature below.
  // All other methods accessed dynamically via string keys
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

function isDesktopPrivateSshSession(runtime: Runtime, sessionId: unknown): boolean {
  if (runtime.isPrivateSshOperationSessionId?.(sessionId)) return true;
  if (runtime.isSshTestSessionId?.(sessionId)) return true;
  return typeof sessionId === "string" && /^(ssh-test:|ssh-transfer:)/.test(sessionId);
}

/**
 * Defence-in-depth response headers applied to every HTTP response.
 *
 *  - `Content-Security-Policy` — restricts what the browser may load or
 *    execute. `default-src 'none'` blocks everything not explicitly listed.
 *    `script-src 'self'` allows only same-origin JS bundles (Vite output).
 *    `style-src 'self' 'unsafe-inline'` allows same-origin CSS plus inline
 *    styles that xterm.js and Monaco inject at runtime.
 *    `connect-src 'self' ws: wss:` allows WebSocket back to the server.
 *    `worker-src 'self' blob:` allows Monaco's web workers (created via
 *    blob: URLs from the same origin).
 *    `img-src 'self' data: blob:` allows inline SVGs and canvas exports.
 *    `font-src 'self' data:` allows the embedded terminal font.
 *    `frame-ancestors 'none'` is a stronger X-Frame-Options equivalent.
 *    `base-uri 'self'` prevents <base href="..."> injection.
 *    `form-action 'none'` — the remote UI has no forms.
 *  - `X-Content-Type-Options: nosniff` — browser must trust our explicit
 *    Content-Type and not MIME-sniff a `.json` blob into HTML.
 *  - `X-Frame-Options: DENY` — strideterm never renders inside a frame;
 *    block clickjacking attempts that would embed the remote UI.
 *  - `Referrer-Policy: no-referrer` — prevents the access token (which
 *    rides in `?token=...`) from leaking to third-party origins via
 *    Referer when the user clicks an external link.
 *  - `Cache-Control: no-store` — JSON state and HTML responses include
 *    workspace metadata; do not let a shared HTTP cache (or the browser
 *    history) hold onto it.
 *  - `Permissions-Policy` — disables browser features that the remote UI
 *    never uses (camera, microphone, geolocation, payment).
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; "),
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/**
 * How long a mobile (ticket-bootstrapped) session may live, and how long it may sit idle.
 *
 * From the shared protocol constants rather than spelled out here, because the relay enforces the
 * same two numbers on its own side of the same session: the relay's cookie is renewable only inside
 * the absolute window, and this is the window (production hardening §5 "Session" 1). They live in
 * `relay-limits.json` because the relay path is where they are also enforced; a legacy-transport
 * mobile session is held to the same pair on purpose — the transport is not what decides how long a
 * phone may hold a remote session.
 */
const MOBILE_SESSION_ABSOLUTE_TTL_MS = RELAY_MOBILE_SESSION_ABSOLUTE_TTL_MS;
const MOBILE_SESSION_IDLE_TTL_MS = RELAY_MOBILE_SESSION_IDLE_TTL_MS;
/**
 * How often the deadline sweep runs.
 *
 * A minute: the deadlines are eight hours and thirty minutes, so a minute of slack is invisible to a
 * user and the sweep costs one pass over a map that holds at most a handful of entries. Its purpose
 * is to close a socket nothing is talking on, which is precisely the case no request-path check can
 * reach.
 */
const MOBILE_SESSION_SWEEP_MS = 60_000;
/** A mobile session's pending terminal-input audit row is flushed after this long without further input. */
const MOBILE_TERMINAL_INPUT_FLUSH_MS = 10_000;
/** Longest client-named value (a file path) kept in a mobile session audit `detail`. */
const MOBILE_AUDIT_VALUE_MAX = 1024;

/**
 * The file operations recorded as `session.file` for a mobile session, each with the `detail` tail it
 * writes: the path(s) the client named (quoted), never content. fileRoute prefixes `root=<rootPath>` to every one. Anything not listed here is a pure
 * metadata listing and leaves no row.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MobileFileAuditDescriber = (body: any, q: (value: unknown) => string) => string;
const MOBILE_AUDITED_FILE_OPS: Record<string, MobileFileAuditDescriber> = {
  preview: (b, q) => `path=${q(b.relativePath)}`,
  read: (b, q) => `path=${q(b.relativePath)}`,
  write: (b, q) => `path=${q(b.relativePath)}`,
  "create-file": (b, q) => `path=${q(b.parentPath)} name=${q(b.name)}`,
  "create-dir": (b, q) => `path=${q(b.parentPath)} name=${q(b.name)}`,
  rename: (b, q) => `path=${q(b.relativePath)} target=${q(b.newName)}`,
  delete: (b, q) => `path=${q(b.relativePath)}`,
  move: (b, q) => `path=${q(b.fromPath)} target=${q(b.toPath)}`,
  copy: (b, q) => `path=${q(b.fromPath)} target=${q(b.toPath)}`,
  "git-ignore": (b, q) => `path=${q(b.relativePath)}`,
  "git-diff": (b, q) => `path=${q(b.relativePath)}`,
  "commit-diff": (b, q) => `path=${q(b.relativePath)} hash=${q(b.hash)}`,
  "commit-files": (b, q) => `hash=${q(b.hash)}`,
};

function writeHead(response: ServerResponse, statusCode: number, headers: Record<string, string>): void {
  response.writeHead(statusCode, { ...SECURITY_HEADERS, ...headers });
}

/**
 * One entry per active session (plan §9.2/§10.6 — this replaces the bare
 * `activeSessions: Set<string>`). `deviceId`/`pairId` are non-null only for
 * a session minted by the mobile ticket-bootstrap route; every existing
 * browser/token-client/Telegram-`/tunnel` session keeps getting `null` here.
 *
 * A MOBILE SESSION IS FINITE NOW, and that is a change in behaviour rather than a refactor
 * (production hardening §5 "Session"). It used to carry `expiresAt: null` — the ticket that created
 * it had a sixty-second TTL, and the session it produced then lasted until the process restarted, so
 * the shortest-lived credential in the system minted the longest-lived one. Three deadlines replace
 * that:
 *
 *   - `expiresAt`: the ABSOLUTE end, eight hours from the bootstrap. Nothing moves it.
 *   - `idleExpiresAt`: thirty minutes of no meaningful activity. Moved forward by real requests and
 *     real client messages, and deliberately NOT by a heartbeat or a ping — a keep-alive frame is the
 *     client saying its socket is open, not the user doing anything, and letting it hold a session
 *     open forever would make the idle deadline decorative.
 *   - and the device's own authorization, re-read on every request: a revoke, a capability change or
 *     a profile-allowlist change ends the session at the next thing it tries to do, in addition to
 *     the revoke path closing it immediately.
 *
 * `expiresAt` stays `null` for the pre-existing browser/token-client/Telegram sessions, whose
 * lifetime question is a different one (they hold the master token or a desktop-issued cookie, and
 * the user's own remote-access settings are what end them). Only a mobile session — the kind a phone
 * bootstraps from a ticket — is bounded here.
 */
interface MobileSessionRecord {
  sessionId: string;
  deviceId: string | null;
  pairId: string | null;
  profileId: string;
  createdAt: number;
  lastSeenAt: number;
  /** Absolute deadline. Non-null exactly for a mobile (ticket-bootstrapped) session. */
  expiresAt: number | null;
  /** Idle deadline, moved forward by meaningful activity only. Null when `expiresAt` is. */
  idleExpiresAt: number | null;
}

/**
 * Settings on `remoteAccess` that a remote caller (HTTP-side updateSettings)
 * may not change. Local IPC bypasses this filter — the desktop Settings UI
 * needs to be able to flip these freely.
 *
 * Why each is dangerous when reachable from a leaked-token attacker:
 *   - `cloudflaredPath`: tunnel-manager spawns this binary directly. Combined
 *     with file-write into a workspace cwd (allowed by the file-API
 *     allowlist) it's a one-shot RCE — drop a script, repoint the path,
 *     POST /api/tunnel/create.
 *   - `enabled`/`host`/`port`: change how the server binds. Disabling kicks
 *     the legitimate user off; widening `host` increases exposure.
 *   - `token`: rotating invalidates every existing session and locks the
 *     legitimate user out until they walk back to the desktop.
 *   - `customPublicUrl`: display-only metadata, but the desktop "Copy share
 *     URL" affordance reads it — rewriting it from a leaked session turns the
 *     local user into an unwitting phishing courier. See the inline comment
 *     in the array below for the full rationale.
 */
export const REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS: ReadonlyArray<string> = [
  // `autoTunnel` gates whether the Cloudflare quick-tunnel is re-established
  // on the next desktop startup (runtime.ts:3429). Starting a tunnel right
  // now is already a legitimate remote action via POST /api/tunnel/create,
  // but that path is overt — the user sees the tunnel state in the UI
  // immediately. Flipping `autoTunnel` is the *quiet* version: an attacker
  // with a leaked session can persist the tunnel across restarts without
  // having to keep calling /api/tunnel/create, and the user only finds out
  // when they notice cloudflared running on next launch. Per invariant M1/S1,
  // any remoteAccess.* field that triggers process spawn is blocklisted; this
  // field is the trigger. Legitimate writers (createCloudflareTunnel /
  // stopCloudflareTunnel in runtime.ts) flip it as a server-side side-effect,
  // never via /api/settings/update, so the blocklist costs no UX.
  "autoTunnel",
  "paused",
  "cloudflaredPath",
  "enabled",
  "host",
  // `networkAccess` opens (or closes) the port to the network. Turning it on is a deliberate step
  // taken at the machine — same reasoning as `autoTunnel` — and turning it off from a LAN client
  // would cut that client's own connection. Dropped in both directions.
  "networkAccess",
  "port",
  "token",
  // `customPublicUrl` is display-only metadata — but the desktop "Copy share
  // URL" affordance reads it, so a leaked-token attacker rewriting it to
  // `https://evil/strideterm` turns the local user into an unwitting phishing
  // courier. Blast radius is small (token leak already grants RCE-equivalent
  // access), but the fix is one entry and the lost capability — "edit my
  // VPS URL from the phone" — is rare enough to walk back to the desktop.
  "customPublicUrl",
];

/**
 * Top-level settings keys (sibling to `remoteAccess`, directly under
 * `state.settings.X`) that a remote caller may not change. Same threat model
 * as REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS — a leaked-token attacker must not be
 * able to repoint a binary the local desktop will later spawn — but these
 * fields don't live under `remoteAccess`, so the per-field loop on that
 * subtree wouldn't see them.
 *
 *   - `externalPathOpener`: when `mode === "command"`, the desktop main
 *     process spawns `command` (parsed argv-style) every time the user
 *     clicks a path link in terminal output. Allowing a remote caller to
 *     repoint this turns a benign local action ("click a filename in my
 *     terminal") into arbitrary code execution. Per invariant S1 ("any
 *     user-configurable binary path pattern automatically belongs in the
 *     remote blocklist"), this entry is mandatory; do not relax it.
 *
 *     The whole subtree is dropped (not per-field) because `mode` and
 *     `command` are jointly part of the spawn chain — flipping `mode` from
 *     `"system"` to `"command"` is half the exploit by itself.
 *
 *   - `externalEditor`: same threat as `externalPathOpener.command` — the
 *     desktop spawns this binary with the clicked file path as argv on every
 *     terminal path link click. A remote caller repointing it to
 *     `C:\\Users\\<me>\\malware.exe` (or any local binary they smuggled in
 *     via an earlier upload primitive) gets RCE the next time the local user
 *     clicks a path in their terminal.
 *
 *   - `terminalFontSizeLocal`: not a security threat — a transport-isolation
 *     invariant. Desktop and remote/mobile clients each persist their own
 *     terminal font size (`terminalFontSizeLocal` vs `terminalFontSizeRemote`)
 *     so the two never overwrite each other when both are connected. Remote
 *     clients may freely write the `Remote` key but must not touch the
 *     `Local` one.
 *
 *   - `clipboardImagePasteDir`: filesystem path that the desktop main
 *     process writes PNGs into when the user pastes a screenshot. A
 *     remote caller repointing it (e.g. into a Startup folder or to
 *     overwrite a sensitive file via a chosen filename) turns paste-
 *     into-terminal into an arbitrary file-write primitive. Per
 *     invariant S1 ("any user-configurable filesystem path the desktop
 *     later writes to belongs in the remote blocklist"), this entry is
 *     mandatory.
 */
/**
 * Per-field drops inside the `notifications` subtree. Per-field rather than
 * wholesale, because everything else under `notifications` (quiet timings,
 * agentsOnly, subagent pings) is a legitimate thing to tune from a phone.
 *
 *   - `autoApprovePermissions`: arms strIDEterm to answer Claude Code's
 *     permission prompts with `allow` on the DESKTOP, unattended. Same threat
 *     shape as `autoTunnel` — a quiet, persistent flip whose consequences land
 *     somewhere the remote caller cannot see — except worse in kind: what it
 *     buys an attacker is every future `Bash` and `Write` the agent proposes,
 *     approved with nobody watching. Turning this on must always be a
 *     deliberate act at the machine that will execute the result. Reading the
 *     resulting trail (GET /api/approvals/audit-log) stays allowed.
 */
export const REMOTE_BLOCKED_NOTIFICATION_FIELDS: ReadonlyArray<string> = ["autoApprovePermissions"];

export const REMOTE_BLOCKED_TOP_LEVEL_FIELDS: ReadonlyArray<string> = [
  "ssh",
  "externalPathOpener",
  "externalEditor",
  "terminalFontSizeLocal",
  // `clipboardImagePasteDir` decides where the desktop main process
  // writes PNGs on Ctrl+V of a screenshot. A remote caller repointing
  // it (e.g. to `C:\\Users\\<me>\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\`)
  // turns a benign local action into arbitrary file writes at attacker-
  // controlled paths on the next paste. Per invariant S1 (any user-
  // configurable filesystem path that the desktop later writes to
  // belongs in the remote blocklist), this entry is mandatory.
  "clipboardImagePasteDir",
];

/**
 * `settings.integrations.mobile` (plan §10.5): "Remote HTTP klient nesmí
 * měnit mobile credentials, pairing ani device settings." Unlike
 * `remoteAccess` (blocked per-field, since most of its fields ARE safe to
 * let a remote client change — see REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS), the
 * ENTIRE `integrations.mobile` subtree is dropped wholesale: its only
 * fields are the enabled flag and the full paired-device list (capability +
 * profile allowlists, revocation status) — desktop-owned pairing state with
 * no safe partial-write subset, same reasoning as `externalPathOpener`
 * above. Sibling integrations (`integrations.telegram`, `.azureDevops`,
 * `.github`) are untouched — only `mobile` is blocked.
 */
function sanitizeIntegrationsMobileFromRemote(settings: Record<string, unknown>): string[] {
  const integrations = settings.integrations as Record<string, unknown> | undefined;
  if (integrations && typeof integrations === "object" && "mobile" in integrations) {
    delete integrations.mobile;
    return ["integrations.mobile"];
  }
  return [];
}

/**
 * Apply the same blocklist `/api/settings/update` enforces. Exported for
 * tests; mutates `settings` in place to drop both the blocked top-level keys
 * and the blocked `remoteAccess` keys, and returns the names of fields that
 * were actually present so the caller can audit-log the drop.
 */
export function sanitizeSettingsFromRemote(settings: Record<string, unknown>): string[] {
  const removed: string[] = [];
  // Top-level subtrees first — these are dropped wholesale.
  for (const key of REMOTE_BLOCKED_TOP_LEVEL_FIELDS) {
    if (key in settings) {
      delete settings[key];
      removed.push(key);
    }
  }
  // Per-field drop inside `remoteAccess` (preserves non-blocked siblings).
  const remoteAccess = settings.remoteAccess as Record<string, unknown> | undefined;
  if (remoteAccess && typeof remoteAccess === "object") {
    for (const key of REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS) {
      if (key in remoteAccess) {
        delete remoteAccess[key];
        removed.push(key);
      }
    }
  }
  // Per-field drop inside `notifications` — its siblings are ordinary
  // remote-tunable preferences and must survive.
  const notifications = settings.notifications as Record<string, unknown> | undefined;
  if (notifications && typeof notifications === "object") {
    for (const key of REMOTE_BLOCKED_NOTIFICATION_FIELDS) {
      if (key in notifications) {
        delete notifications[key];
        removed.push(key);
      }
    }
  }
  removed.push(...sanitizeIntegrationsMobileFromRemote(settings));
  return removed;
}

/**
 * Strip server-side secrets that a remote browser must never see in JSON
 * responses or `state:updated` broadcasts. Today that's only the master
 * access token — every other remote-only secret either rides outside the
 * payload (Set-Cookie session id) or is intentionally part of the share-URL
 * UX (`payload.remoteAccess.urls[*]` still embeds `?token=…`, accepted by
 * SEC-004 as the cost of a working "Copy share URL" button).
 *
 * This is defense in depth: the desktop Electron renderer reads state via
 * IPC, not /api/state, so stripping for the HTTP/WS path doesn't break any
 * local UI. A remote browser that wants to hand off the share URL still has
 * `payload.remoteAccess.urls`; UIs that surface the bare token (e.g.
 * "Token: <value>" in a settings panel) will now see an empty string when
 * loaded over remote, which is the desired outcome.
 *
 * Returns the input unchanged when it doesn't look like a runtime payload —
 * safe to wrap every JSON response, including `{ ok: true }` and error
 * envelopes.
 */
export interface StripSecretsOptions {
  /**
   * Also blank `payload.remoteAccess.urls[*]` — the share URLs that embed
   * `?token=<master>`.
   *
   * Set for managed relay responses and device-bound mobile sessions. Desktop
   * browser sessions retain share URLs so the ordinary QR/share flow keeps
   * working:
   *
   *  - On the user's own LAN listener or their own Cloudflare tunnel the share
   *    URL travels desktop → the owner's own browser, and "Copy share URL" is
   *    a real hand-off affordance there.
   *  - Over the managed relay the same response crosses a hosted Worker that
   *    TERMINATES TLS and forwards decrypted frames (there is no end-to-end
   *    layer on the relay viewer path — see mobile-relay-connector.ts, which
   *    passes bodies and cookies through in the clear by design). R1's premise
   *    does not hold there: the token would be handed to the relay operator,
   *    and unlike a relay session cookie it is long-lived, survives the
   *    session, unlocks the whole remote API over the LAN independently of the
   *    relay, and would appear in any relay-side request logging.
   *
   * Nothing is lost by blanking it: a phone reaches this desktop through the
   * relay origin or a WebView ticket, never through a LAN share URL, so the
   * field has no consumer on this transport.
   */
  stripShareUrls?: boolean;
}

export function stripSecretsForRemote(body: unknown, opts: StripSecretsOptions = {}): unknown {
  if (!body || typeof body !== "object") return body;
  const payload = body as Record<string, unknown>;
  // A top-level state payload (a getPayload() result) — strip its master token.
  if (payload.appState) return stripStateSecrets(payload, opts);
  // A result envelope that WRAPS a state payload under `.payload` (git/docker
  // ops, verification results: `{ ok, payload: <full state> }`). Top-level-only
  // stripping missed these — a v1 nested mutation response could ship the master
  // token in `payload.appState.settings.remoteAccess.token`. Strip the nested
  // state too, leaving the envelope's small fields intact.
  const nested = payload.payload;
  if (nested && typeof nested === "object" && (nested as Record<string, unknown>).appState) {
    return { ...payload, payload: stripStateSecrets(nested as Record<string, unknown>, opts) };
  }
  return body;
}

/** Both strips, in one place, so the two payload shapes above stay one line each. */
function stripStateSecrets(state: Record<string, unknown>, opts: StripSecretsOptions): Record<string, unknown> {
  return stripShareUrls(stripStateToken(state), opts);
}

/**
 * Blank the token-bearing share URLs in one state-payload object.
 *
 * Deliberately a SEPARATE pass from `stripStateToken` rather than a branch
 * inside it: the token lives at `appState.settings.remoteAccess.token` and the
 * URLs at the payload-level `remoteAccess.urls` (runtime.ts's `setRemoteInfo`
 * spread, not the settings subtree). `stripStateToken` returns early when a
 * payload carries no `settings.remoteAccess`, which would otherwise skip the
 * URLs on exactly the payload shape that still has them.
 */
function stripShareUrls(state: Record<string, unknown>, opts: StripSecretsOptions): Record<string, unknown> {
  if (!opts.stripShareUrls) return state;
  const remoteAccess = state.remoteAccess as Record<string, unknown> | undefined;
  if (!remoteAccess || typeof remoteAccess !== "object") return state;
  if (!Array.isArray(remoteAccess.urls) || remoteAccess.urls.length === 0) return state;
  return { ...state, remoteAccess: { ...remoteAccess, urls: [] } };
}

/** Zero the master remote-access token in one state-payload object. Returns the
 *  input unchanged when it carries no `settings.remoteAccess` object. */
function stripStateToken(state: Record<string, unknown>): Record<string, unknown> {
  const appState = state.appState as Record<string, unknown> | undefined;
  const settings = appState?.settings as Record<string, unknown> | undefined;
  const remoteAccess = settings?.remoteAccess as Record<string, unknown> | undefined;
  if (!remoteAccess || typeof remoteAccess !== "object") return state;
  return {
    ...state,
    appState: {
      ...appState,
      settings: {
        ...settings,
        remoteAccess: { ...remoteAccess, token: "" },
      },
    },
  };
}

/**
 * Per-request remote-response context. Attached to the `ServerResponse` once, at
 * the top of the API branch, so the single `json()` writer can compose+slim
 * EVERY outbound body without threading arguments through ~150 call sites and
 * without a growing list of route intercepts.
 */
interface RemoteAdaptContext {
  protocol: number;
  /** Negotiated capability set (see selectCapabilities). Drives the v2-vs-legacy
   *  response contract and is echoed back to the client in the core. */
  capabilities: string[];
  /** Monotonic broadcast revision stamped onto the core so the client applies
   *  only newer snapshots (bootstrap→WS handoff). */
  coreRevision: number;
  /** Whether a v2 state payload on this path should be delivered as the full
   *  slim core (bootstrap `/api/state`, activation, WS state frames) or reduced
   *  to a small `{ ok, revision }` mutation ack (every button-click mutation /
   *  refresh). Defaults to false so a mutation never ships a whole core. */
  deliverCore?: boolean;
  sessionId: string;
  registry: RemoteClientRegistry;
  /** Request method, so ETag/304 applies only to idempotent GETs. */
  method?: string;
  /** Accept-Encoding, for opportunistic Brotli/gzip of bootstrap/detail JSON. */
  acceptEncoding?: string;
  /** If-None-Match, for a 304 on an unchanged detail refetch. */
  ifNoneMatch?: string;
  /** Request path — so a mutation ack can report the resources it changed. */
  route?: string;
  /** Parsed request body — set once the dispatch reads it; lets the ack pin the
   *  changed resource key(s) from prKey/workspaceId/projectId. */
  body?: Record<string, unknown>;
  /** True on the managed relay's loopback-origin server, so the token-bearing
   *  share URLs are blanked as well — see StripSecretsOptions.stripShareUrls. */
  stripShareUrls?: boolean;
  /** Mobile WebViews retain their HTTP cache across launches. State and API
   *  responses must never enter that persistent cache. */
  noStore?: boolean;
}

// Only compress JSON above this size — below it the framing/CPU overhead of
// gzip/brotli outweighs the win. The slim core + detail bodies that matter for
// bandwidth are comfortably above this; a `{ ok: true }` is not.
const JSON_COMPRESS_MIN_BYTES = 1024;

/**
 * POST routes whose renderer handler DISCARDS the whole-payload response on the
 * remote transport (a `setPayload` no-op — the client waits for the WS
 * broadcast). For a v2 client these return a small `{ ok, changedResources,
 * revision }` ack instead of serializing/transferring a whole core "after every
 * button click" (plan §2.10; judge #28/#36). These are the frequent refresh
 * buttons and the provider / review-bridge domain mutations. Everything else
 * (bootstrap, navigation the client adopts) delivers the slim core — see the
 * deliverCore comment where the response context is attached. A route is added
 * here ONLY when its client caller is provably a discard (setPayload); a route
 * the client adopts must stay core, so mis-classification can only over-deliver
 * a (harmless, adopted) core, never wipe state with an ack.
 */
const ACK_MUTATION_ROUTES = new Set<string>([
  // Refresh buttons — the client discards the response and repaints from the
  // WS broadcast the refresh triggers.
  "/api/git/refresh",
  "/api/azure/refresh",
  "/api/github/refresh",
  "/api/docker/refresh",
  "/api/telegram/refresh",
  "/api/tunnel/refresh",
  // Azure PR / review domain mutations (renderer: setPayload no-op).
  "/api/azure/pull-request/seen",
  "/api/azure/pull-request/comment",
  "/api/azure/pull-request/vote",
  "/api/azure/pull-request/thread-status",
  "/api/azure/pull-request/open",
  "/api/azure/workspace/fetch",
  "/api/azure/workspace/rebase",
  "/api/azure/delete-connection",
  // Re-run a CI check (renderer awaits + discards, then emits refresh).
  "/api/azure/rerun-check",
  "/api/github/rerun-check",
  // GitHub PR / review domain mutations (renderer: setPayload no-op).
  "/api/github/pull-request/seen",
  "/api/github/pull-request/comment",
  "/api/github/pull-request/review",
  "/api/github/pull-request/open",
  "/api/github/workspace/fetch",
  "/api/github/workspace/rebase",
  "/api/github/delete-connection",
  // Review-bridge domain mutations (renderer: setPayload no-op).
  "/api/review-bridge/draft/save",
  "/api/review-bridge/draft/delete",
  "/api/review-bridge/draft/queue",
  "/api/review-bridge/draft-comment/create",
  "/api/review-bridge/comment/delete",
  "/api/review-bridge/comment/reply-with-changes",
  "/api/review-bridge/pull-request/sync",
  "/api/review-bridge/pull-request/push-and-publish",
  "/api/review-bridge/agent-prompt/reset",
  // Docker domain mutations (renderer: setPayload no-op — the Docker pane
  // repaints from its `docker` detail resource, refetched via the ack's
  // changedResources / the WS invalidation). Prune routes return { payload,
  // result }: the ack keeps `result` (the reclaimed-size report) and drops only
  // the nested core, so the pane's toast still renders. Read-only docker ops
  // (inspect/top/stats/system-df/volume-read) return strings, not payloads, so
  // they pass through the adapter untouched even though they are not listed.
  "/api/docker/action",
  "/api/docker/compose-action",
  "/api/docker/open-session",
  "/api/docker/image/remove",
  "/api/docker/volume/remove",
  "/api/docker/network/remove",
  "/api/docker/image/pull",
  "/api/docker/image/prune",
  "/api/docker/volume/prune",
  "/api/docker/network/prune",
  "/api/docker/builder/prune",
]);

/**
 * The detail resource keys a mutation/refresh changed, so the ack can name them
 * and the client refetches exactly those interested panes without waiting for
 * the WS invalidation round-trip (the broadcast still covers it — this is a
 * latency optimization, not the correctness path). Derived from the route + the
 * request body's ids; returns [] when the affected resource can't be pinned to a
 * single key (e.g. a whole-provider refresh, where the client relies on the WS
 * invalidations for each changed PR/inbox instead).
 */
function changedResourcesForRoute(route: string, body: Record<string, unknown> | undefined): string[] {
  const b = (body || {}) as Record<string, unknown>;
  const prKey = String(b.prKey || "");
  const wsId = String(b.workspaceId || "");
  const azurePr = (): string[] => (prKey ? [`azure-pr:${prKey}`, `review-bridge:${prKey}`] : []);
  const githubPr = (): string[] => (prKey ? [`github-pr:${prKey}`, `review-bridge:${prKey}`] : []);
  switch (route) {
    case "/api/docker/refresh":
    case "/api/docker/action":
    case "/api/docker/compose-action":
    case "/api/docker/image/remove":
    case "/api/docker/volume/remove":
    case "/api/docker/network/remove":
    case "/api/docker/image/pull":
    case "/api/docker/image/prune":
    case "/api/docker/volume/prune":
    case "/api/docker/network/prune":
    case "/api/docker/builder/prune":
      return ["docker"];
    case "/api/azure/refresh":
    case "/api/azure/delete-connection":
      return ["azure-inbox"];
    case "/api/github/refresh":
    case "/api/github/delete-connection":
      return ["github-inbox"];
    case "/api/git/refresh":
      return b.projectId ? [`git:${String(b.projectId)}`] : [];
    case "/api/azure/pull-request/seen":
    case "/api/azure/pull-request/comment":
    case "/api/azure/pull-request/vote":
    case "/api/azure/pull-request/thread-status":
    case "/api/azure/pull-request/open":
    case "/api/azure/rerun-check":
      return azurePr();
    case "/api/github/pull-request/seen":
    case "/api/github/pull-request/comment":
    case "/api/github/pull-request/review":
    case "/api/github/pull-request/open":
    case "/api/github/rerun-check":
      return githubPr();
    case "/api/azure/workspace/fetch":
    case "/api/azure/workspace/rebase":
    case "/api/github/workspace/fetch":
    case "/api/github/workspace/rebase":
      return wsId ? [`git:${wsId}`] : [];
    case "/api/review-bridge/draft/save":
    case "/api/review-bridge/draft/delete":
    case "/api/review-bridge/draft/queue":
    case "/api/review-bridge/draft-comment/create":
    case "/api/review-bridge/comment/delete":
    case "/api/review-bridge/comment/reply-with-changes":
    case "/api/review-bridge/pull-request/sync":
    case "/api/review-bridge/pull-request/push-and-publish":
      return prKey ? [`review-bridge:${prKey}`] : [];
    // Prompt reset changes the global agent-prompts list — the ack names that
    // single resource so an interested (mounted) review pane refetches it
    // immediately instead of waiting for the WS invalidation round-trip. (Reset
    // is the only remote-reachable prompt mutation; save/delete are desktop IPC.)
    case "/api/review-bridge/agent-prompt/reset":
      return ["agent-prompts"];
    default:
      return [];
  }
}

const warnedStrayStateKeys = new Set<string>();

/**
 * A runtime method that bolts its result onto the state payload
 * (`payload.someResult = …`) works over desktop IPC but loses that result for
 * every protocol-2 client: the core is an allowlist and an ack carries no
 * payload at all. Name it once per route so the defect shows up in the log
 * instead of as a silently missing result on the phone.
 */
function warnStrayStateKeys(payload: unknown, route: string | undefined): void {
  const keys = strayStatePayloadKeys(payload);
  if (!keys.length) return;
  const signature = `${route || ""}|${keys.join(",")}`;
  if (warnedStrayStateKeys.has(signature)) return;
  warnedStrayStateKeys.add(signature);
  log.warn("remote response drops fields bolted onto the state payload — return them beside it as { payload, … }", {
    route,
    keys,
  });
}

/**
 * The one remote response adapter. Given any runtime result, it:
 *  - strips the master token (stripSecretsForRemote);
 *  - if the body IS a full desktop state payload → composes it per-client and,
 *    for a protocol-2 client, replaces it with the slim `RemoteStateV2` core;
 *  - if the body has a NESTED `payload` (mutation/verification results) → does
 *    the same to that nested payload, leaving the envelope intact;
 *  - otherwise passes the (stripped) small result through untouched.
 *
 * A remote HTTP/WS response therefore can never accidentally ship a raw desktop
 * `StatePayload`, even when the runtime method returns `getPayload()`. Legacy
 * (protocol < 2) clients still get the full composed payload — no silent slim.
 */
function adaptRemoteResponse(body: unknown, ctx: RemoteAdaptContext): unknown {
  const stripped = stripSecretsForRemote(body, { stripShareUrls: ctx.stripShareUrls });
  const v2 = servesRemoteCore(ctx.capabilities);
  if (v2) {
    warnStrayStateKeys(stripped, ctx.route);
    warnStrayStateKeys((stripped as Record<string, unknown> | null)?.payload, ctx.route);
  }
  // A v2 client receives a full slim core ONLY on the core-delivery paths
  // (bootstrap / activation / WS state). Every other state-bearing response is a
  // mutation/refresh result: it must NOT serialize+transfer a whole core after a
  // button click — the client already applies the WS state:updated broadcast +
  // per-resource invalidations the mutation triggers. Return a small targeted
  // ack instead. Legacy (v1) clients keep the full composed payload.
  if (looksLikeStatePayload(stripped)) {
    if (v2 && !ctx.deliverCore) return mutationAck(ctx);
    return composeAndSlim(stripped as Record<string, unknown>, ctx);
  }
  if (stripped && typeof stripped === "object") {
    const rec = stripped as Record<string, unknown>;
    const nested = rec.payload;
    if (looksLikeStatePayload(nested)) {
      if (v2 && !ctx.deliverCore) {
        // Drop the nested core; keep any small envelope fields (ok, result, …).
        const rest = { ...rec };
        delete rest.payload;
        const changedResources = ctx.route ? changedResourcesForRoute(ctx.route, ctx.body) : [];
        return { ok: true, changedResources, ...rest, revision: ctx.coreRevision };
      }
      return { ...rec, payload: composeAndSlim(nested as Record<string, unknown>, ctx) };
    }
  }
  return stripped;
}

/** The small targeted result a v2 mutation/refresh returns instead of a core.
 *  `revision` is the server's current broadcast revision so the client can tell
 *  its state moved; `changedResources` names the detail keys the mutation
 *  touched so the client refetches exactly those interested panes (the
 *  authoritative new core + per-resource invalidations also ride the WS
 *  state:updated broadcast the mutation triggers — the ack just skips the
 *  round-trip). */
function mutationAck(ctx: RemoteAdaptContext): Record<string, unknown> {
  const changedResources = ctx.route ? changedResourcesForRoute(ctx.route, ctx.body) : [];
  return { ok: true, changedResources, revision: ctx.coreRevision };
}

function composeAndSlim(payload: Record<string, unknown>, ctx: RemoteAdaptContext): unknown {
  const bound = Boolean(ctx.sessionId && ctx.registry.get(ctx.sessionId));
  const composed = bound ? ctx.registry.composePayload(ctx.sessionId, payload) : payload;
  if (!servesRemoteCore(ctx.capabilities)) return composed;
  // v2 core is ALWAYS profile-scoped. A bound socket carries its profile in the
  // composed remoteClient; an unbound socket is scoped to the server's default
  // profile (never every profile) via opts.profileId.
  const profileId = bound
    ? undefined
    : ctx.registry.resolveFallbackProfileId((payload as Record<string, unknown>).appState);
  return buildRemoteCore(composed as Record<string, unknown>, {
    coreRevision: ctx.coreRevision,
    capabilities: ctx.capabilities,
    ...(profileId !== undefined ? { profileId } : {}),
  });
}

/** Protocol version a request advertises (header wins, then `?sp=`, else 1). */
function requestProtocol(requestUrl: string, headers: IncomingMessage["headers"]): number {
  const raw = headers["x-strideterm-state-protocol"];
  const fromHeader = Array.isArray(raw) ? raw[0] : raw;
  if (fromHeader) return Number(fromHeader) || 1;
  const sp = new URL(requestUrl || "/", "http://localhost").searchParams.get("sp");
  return sp ? Number(sp) || 1 : 1;
}

/** Capabilities a request advertises (`X-Strideterm-Capabilities` header wins,
 *  then `?caps=`; comma-separated). Empty list when none advertised — a plain
 *  `?sp=2` client then implicitly gets the full set (see selectCapabilities). */
function requestCapabilities(requestUrl: string, headers: IncomingMessage["headers"]): string[] {
  const raw = headers["x-strideterm-capabilities"];
  const fromHeader = Array.isArray(raw) ? raw[0] : raw;
  const source = fromHeader ?? new URL(requestUrl || "/", "http://localhost").searchParams.get("caps") ?? "";
  return source
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

/** The bootstrap revision a WS client echoes back (`?rev=`), or null when it has
 *  not bootstrapped yet (first connect) — see the WS open handler. */
function requestBootstrapRevision(requestUrl: string): number | null {
  const rev = new URL(requestUrl || "/", "http://localhost").searchParams.get("rev");
  if (rev === null) return null;
  const n = Number(rev);
  return Number.isFinite(n) ? n : null;
}

type ResponseWithCtx = ServerResponse & { __remoteCtx?: RemoteAdaptContext };

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  const ctx = (response as ResponseWithCtx).__remoteCtx;
  const adapted = ctx ? adaptRemoteResponse(body, ctx) : stripSecretsForRemote(body);
  const raw = JSON.stringify(adapted);
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };

  // ETag/304 for idempotent GETs (bootstrap /api/state, detail refetches): a
  // client that already holds the current body sends If-None-Match and we skip
  // re-sending it. Supplementary — correctness never depends on it.
  if (ctx?.method === "GET" && statusCode === 200) {
    // sha256, not sha1: the ETag is only a cache validator, but the body it
    // digests carries workspace/session identifiers, and CodeQL's
    // weak-cryptographic-algorithm rule flags sha1 over that data as a high
    // alert. Nothing here depends on the digest being short.
    const etag = `"${createHash("sha256").update(raw).digest("base64")}"`;
    headers.ETag = etag;
    headers["Cache-Control"] = ctx.noStore ? "no-store" : "no-cache";
    if (ctx.ifNoneMatch && ctx.ifNoneMatch === etag) {
      writeHead(response, 304, headers);
      response.end();
      return;
    }
  }

  const bodyBuf = Buffer.from(raw, "utf8");
  const encoding = pickEncoding(ctx?.acceptEncoding, bodyBuf.length);
  if (encoding) {
    const compressed = encoding === "br" ? brotliCompressSync(bodyBuf) : gzipSync(bodyBuf);
    headers["Content-Encoding"] = encoding;
    headers.Vary = "Accept-Encoding";
    writeHead(response, statusCode, headers);
    response.end(compressed);
    return;
  }
  writeHead(response, statusCode, headers);
  response.end(bodyBuf);
}

/** Choose a supported content encoding for a JSON body, or "" for none. Brotli
 *  preferred (better ratio on JSON) when the client accepts it. */
function pickEncoding(acceptEncoding: string | undefined, byteLength: number): "" | "br" | "gzip" {
  if (byteLength < JSON_COMPRESS_MIN_BYTES) return "";
  const accept = (acceptEncoding || "").toLowerCase();
  if (accept.includes("br")) return "br";
  if (accept.includes("gzip")) return "gzip";
  return "";
}

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5 MB

// A request stream can be read once. The mobile route policy reads the body before the
// route it is guarding does, so the parse is cached per request and every later caller
// gets the same result instead of a stream that has already ended.
const parsedRequestBodies = new WeakMap<IncomingMessage, Promise<Record<string, unknown>>>();

function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let parsed = parsedRequestBodies.get(request);
  if (!parsed) {
    parsed = readRequestBodyOnce(request);
    parsedRequestBodies.set(request, parsed);
  }
  return parsed;
}

function readRequestBodyOnce(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        request.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      raw += chunk.toString();
    });
    request.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function getTokenFromRequest(requestUrl: string, headers: IncomingMessage["headers"]): string {
  const url = new URL(requestUrl, "http://localhost");
  const header = (headers.authorization as string) || "";
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7);
  }

  return url.searchParams.get("token") || "";
}

/**
 * Pull the session id out of the Cookie header. The header is a
 * single-line `name=value; name2=value2; …` blob; we only care about
 * our own cookie so a forgiving parser is fine.
 */
function getSessionFromRequest(headers: IncomingMessage["headers"]): string {
  const raw = (headers.cookie as string) || "";
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) continue;
    return trimmed.slice(SESSION_COOKIE_NAME.length + 1).trim();
  }
  return "";
}

function getClientIdFromRequest(requestUrl: string, headers: IncomingMessage["headers"]): string {
  const header = headers["x-strideterm-client-id"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const raw = fromHeader || new URL(requestUrl || "/", "http://localhost").searchParams.get("clientId") || "";
  const normalized = String(raw).trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(normalized) ? normalized : "";
}

function remoteSessionRef(sessionId: string): string {
  if (!sessionId) return "none";
  const kind = sessionId.startsWith("token-client:") ? "token-client" : "cookie";
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return `${kind}:${digest}`;
}

/**
 * Constant-time string comparison for token validation. Prevents timing
 * attacks where the attacker probes the token byte-by-byte by measuring
 * how long the server takes to reject each guess.
 *
 * `timingSafeEqual` requires equal-length buffers, so we short-circuit
 * the length check before the cryptographic compare. The empty-token
 * case is handled explicitly because `Buffer.from("")` is also length 0
 * and would compare equal to itself.
 */
function tokensEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function listRemoteUrls(host: string, port: number, token: string): string[] {
  const urls: string[] = [];
  // Bound to loopback (network access off): no other device can use any URL, so none is advertised
  // and Settings shows only the tunnel and the relay.
  if (isLoopbackBindHost(host)) return urls;
  const interfaces = os.networkInterfaces();

  if (host === "0.0.0.0") {
    for (const addresses of Object.values(interfaces)) {
      for (const address of addresses || []) {
        if (address.family === "IPv4" && !address.internal) {
          urls.push(`http://${address.address}:${port}/?token=${token}`);
        }
      }
    }
  } else {
    urls.push(`http://${host}:${port}/?token=${token}`);
  }

  return urls;
}

const REVALIDATED_STATIC_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
]);

function etagMatches(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(",") : ifNoneMatch;
  if (!raw) return false;
  return raw.split(",").some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, "");
    return normalized === "*" || normalized === etag;
  });
}

async function serveStatic(
  staticRoot: string,
  requestUrl: string,
  requestHeaders: IncomingMessage["headers"],
  response: ServerResponse,
): Promise<void> {
  const url = new URL(requestUrl, "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolvedPath = path.normalize(path.join(staticRoot, pathname));
  const safeRoot = path.normalize(staticRoot);
  if (!resolvedPath.startsWith(safeRoot)) {
    writeHead(response, 403, {});
    response.end("Forbidden");
    return;
  }

  let finalPath = resolvedPath;
  if (!existsSync(finalPath)) {
    // SPA fallback: route-style paths (no extension, e.g. /workspace/abc) get
    // index.html so client-side routing works on hard refresh. But hashed
    // assets (/assets/foo-XXX.js, .css, .map, etc.) must NOT fall back to
    // HTML — the browser's strict-MIME check rejects HTML for module
    // <script> tags and the page crashes with "Failed to load module
    // script". Return 404 instead so a stale chunk after a fresh build
    // surfaces as a clean error rather than a misleading HTML response.
    if (url.pathname.startsWith("/assets/") || /\.[a-zA-Z0-9]+$/.test(url.pathname)) {
      // Return 404 *with the requested file's MIME* so the browser surfaces a
      // plain "asset 404" rather than the extra-loud "Refused to apply style
      // because MIME ('text/plain') is wrong" message that fires whenever a
      // 404 carries text/plain for a <link rel=stylesheet> or module script.
      // The latter masks the real problem (stale chunk hash after rebuild) in
      // a wall of MIME-policy text.
      const ext = path.extname(url.pathname);
      const ct = CONTENT_TYPES[ext] || "text/plain; charset=utf-8";
      writeHead(response, 404, { "Content-Type": ct });
      response.end("");
      return;
    }
    finalPath = path.join(staticRoot, "index.html");
  }

  try {
    const buffer = await fs.readFile(finalPath);
    const extension = path.extname(finalPath).toLowerCase();
    const contentType = CONTENT_TYPES[extension] || "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (REVALIDATED_STATIC_EXTENSIONS.has(extension)) {
      const etag = `"${createHash("sha256").update(buffer).digest("base64")}"`;
      headers.ETag = etag;
      headers["Cache-Control"] = "private, no-cache";
      if (etagMatches(requestHeaders["if-none-match"], etag)) {
        writeHead(response, 304, headers);
        response.end();
        return;
      }
    }
    writeHead(response, 200, headers);
    response.end(buffer);
  } catch {
    writeHead(response, 503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("strIDEterm remote UI is unavailable until the renderer build exists.");
  }
}

/**
 * Read the approval-log filters off the query string. Only the fields the
 * store understands are forwarded, and the numeric ones are clamped by the
 * store itself (limit is capped at 500 there).
 */
function approvalAuditLogFilters(url: URL, profileId: string): Record<string, unknown> {
  const limit = Number(url.searchParams.get("limit"));
  const offset = Number(url.searchParams.get("offset"));
  const afterId = Number(url.searchParams.get("afterId"));
  const beforeId = Number(url.searchParams.get("beforeId"));
  return {
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    // The keyset cursors a remote Notification Center pages its back-fill
    // with. Not a scope: `profileId` below is still the only thing deciding
    // WHOSE rows come back, and the store ignores a non-positive cursor.
    afterId: Number.isFinite(afterId) && afterId > 0 ? Math.floor(afterId) : undefined,
    beforeId: Number.isFinite(beforeId) && beforeId > 0 ? Math.floor(beforeId) : undefined,
    search: url.searchParams.get("search") || undefined,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined,
    offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : undefined,
    // Scope, not decoration. `profileId` comes from the SERVER's view of the
    // caller's bound session — never from a query parameter — so a client
    // cannot ask for another profile's trail by editing the URL.
    profileId: profileId || undefined,
  };
}

type ApiRouteHandler = (runtime: Runtime, body: Record<string, unknown>) => unknown;

/**
 * Plain POST routes: `json(response, 200, await handler(runtime, body))` is
 * the whole dispatch (handler may return a value directly or a Promise —
 * `await` on a non-Promise just resolves to it). Routes that need something
 * structurally different — an extra `broadcast` callback (docker/logs/open,
 * docker/shell/open), extra request context for its audit log
 * (/api/settings/update), or a non-200 response (the SSH administration
 * block) — stay as explicit cases in handleApiRequest instead of appearing
 * here.
 */
const API_ROUTES: Record<string, ApiRouteHandler> = {
  "/api/azure/verify-connection": (runtime, body) => runtime.verifyAzureConnection(body.connection || {}),
  "/api/azure/refresh": (runtime) => runtime.refreshAzureState(),
  "/api/azure/audit-log/query": (runtime, body) => runtime.queryAzureAuditLog(body),
  "/api/azure/audit-log/stats": (runtime, body) => runtime.getAzureAuditStats(body),
  // /api/azure/pull-request/open, /seen, /comment, /thread-status and /vote are
  // all handled in the outer dispatch (slotAwareRoute) so they resolve the
  // bound viewer id from the remote-client registry and reject cross-profile
  // PRs; reaching here would mean the route bypassed that intercept.
  "/api/review-bridge/agent-prompt/reset": (runtime) => runtime.resetAgentPrompts(),
  // /api/review-bridge/pull-request/sync is handled in the outer dispatch
  // (slotAwareRoute) so it resolves the caller's viewer id and refuses to
  // publish drafts to a PR outside the caller's profile.
  // /api/azure/pull-request/vote is handled in the outer dispatch
  // (slotAwareRoute) so it resolves the caller's viewer id and rejects a vote
  // on a PR outside the caller's profile.
  "/api/azure/workspace/fetch": (runtime, body) => runtime.fetchAzureReviewWorkspace(body.workspaceId),
  "/api/azure/workspace/rebase": (runtime, body) => runtime.rebaseAzureReviewWorkspace(body.workspaceId),
  "/api/azure/workspace/push": (runtime, body) =>
    runtime.pushAzureReviewWorkspace(body.workspaceId as string, { force: Boolean(body.force) }),
  "/api/azure/create-pull-request": (runtime, body) => runtime.azureCreatePullRequest(body),
  "/api/azure/list-remote-branches": (runtime, body) => runtime.azureListRemoteBranches(body),
  "/api/azure/quickfix/list-projects": (runtime, body) => runtime.azureQuickFixListProjects(body),
  "/api/azure/quickfix/list-repositories": (runtime, body) => runtime.azureQuickFixListRepositories(body),
  "/api/azure/quickfix/list-branches": (runtime, body) => runtime.azureQuickFixListBranches(body),
  // /api/azure/quickfix/create is handled in the outer dispatch (slot-aware).
  // /api/azure/rerun-check is handled in the outer dispatch (slotAwareRoute) so
  // it resolves the caller's viewer id and refuses a cross-profile prKey.
  // Pipelines tab — connectionId-addressed reads/actions, handled inline like
  // the quickfix reads above (they don't touch local workspace/slot state).
  "/api/azure/pipelines/list": (runtime, body) => runtime.listAzurePipelines(body),
  "/api/azure/pipelines/runs": (runtime, body) => runtime.listAzurePipelineRuns(body),
  "/api/azure/pipelines/run-seed": (runtime, body) => runtime.getAzurePipelineRunSeed(body),
  "/api/azure/pipelines/run-parameters": (runtime, body) => runtime.getAzurePipelineRunParameters(body),
  "/api/azure/pipelines/refs": (runtime, body) => runtime.getAzurePipelineRefs(body),
  "/api/azure/pipelines/commits": (runtime, body) => runtime.getAzurePipelineCommits(body),
  "/api/azure/pipelines/run": (runtime, body) => runtime.runAzurePipeline(body),
  "/api/azure/pipelines/run-status": (runtime, body) => runtime.getAzurePipelineRunStatus(body),
  "/api/azure/pipelines/cancel": (runtime, body) => runtime.cancelAzureBuild(body),
  "/api/azure/pipelines/build-log": (runtime, body) => runtime.getAzureBuildLog(body),
  "/api/azure/pipelines/run-detail": (runtime, body) => runtime.getAzurePipelineRunDetail(body),

  // --- GitHub ---
  "/api/github/verify-connection": (runtime, body) => runtime.verifyGitHubConnection(body.connection || {}),
  "/api/github/refresh": (runtime) => runtime.refreshGitHubState(),
  "/api/github/audit-log/query": (runtime, body) => runtime.queryGitHubAuditLog(body),
  "/api/github/audit-log/stats": (runtime, body) => runtime.getGitHubAuditStats(body),
  // /api/github/pull-request/open, /seen, /comment and /review are handled in
  // the outer dispatch (slotAwareRoute) so they resolve the bound viewer id
  // from the remote-client registry and reject cross-profile PRs.
  // /api/github/rerun-check is handled in the outer dispatch (slotAwareRoute)
  // so it resolves the caller's viewer id and refuses a cross-profile prKey.
  "/api/github/workspace/fetch": (runtime, body) => runtime.fetchGitHubReviewWorkspace(body.workspaceId),
  "/api/github/workspace/rebase": (runtime, body) => runtime.rebaseGitHubReviewWorkspace(body.workspaceId),
  "/api/github/workspace/push": (runtime, body) => runtime.pushGitHubReviewWorkspace(body.workspaceId, body),
  "/api/github/list-remote-branches": (runtime, body) => runtime.githubListRemoteBranches(body),
  "/api/github/create-pull-request": (runtime, body) => runtime.githubCreatePullRequest(body),
  "/api/github/quickfix/list-repos": (runtime, body) => runtime.githubQuickFixListRepos(body),
  "/api/github/quickfix/list-branches": (runtime, body) => runtime.githubQuickFixListBranches(body),
  // /api/github/quickfix/create is handled in the outer dispatch (slot-aware).

  // --- Telegram ---
  // verify-connection, detect-chats and save-connection are handled in the outer
  // dispatch (slotAwareRoute) so they resolve the caller's profile.
  "/api/telegram/delete-connection": (runtime, body) => runtime.deleteTelegramConnection(body.connectionId),
  "/api/telegram/refresh": (runtime) => runtime.refreshTelegramState(),

  "/api/remote/token/regenerate": (runtime) => runtime.regenerateRemoteToken(),
  "/api/tunnel/refresh": (runtime) => runtime.refreshTunnelState(),
  "/api/tunnel/create": (runtime) => runtime.createCloudflareTunnel(),
  "/api/tunnel/stop": (runtime) => runtime.stopCloudflareTunnel(),

  "/api/claude-hook/configure": (runtime) => runtime.configureClaudeHook(),
  "/api/claude-hook/remove": (runtime) => runtime.removeClaudeHook(),
  "/api/claude-hook/status": (runtime) => runtime.getClaudeHookStatus(),
  "/api/gemini-hook/configure": (runtime) => runtime.configureGeminiHook(),
  "/api/gemini-hook/remove": (runtime) => runtime.removeGeminiHook(),
  "/api/gemini-hook/status": (runtime) => runtime.getGeminiHookStatus(),
  "/api/claude-hook/test": (runtime) => runtime.testClaudeHook(),
  "/api/gemini-hook/test": (runtime) => runtime.testGeminiHook(),
  "/api/codex-hook/configure": (runtime) => runtime.configureCodexHook(),
  "/api/codex-hook/remove": (runtime) => runtime.removeCodexHook(),
  "/api/codex-hook/status": (runtime) => runtime.getCodexHookStatus(),
  "/api/codex-hook/test": (runtime) => runtime.testCodexHook(),
  "/api/copilot-hook/configure": (runtime) => runtime.configureCopilotHook(),
  "/api/copilot-hook/remove": (runtime) => runtime.removeCopilotHook(),
  "/api/copilot-hook/status": (runtime) => runtime.getCopilotHookStatus(),
  "/api/copilot-hook/test": (runtime) => runtime.testCopilotHook(),
  "/api/opencode-hook/configure": (runtime) => runtime.configureOpencodeHook(),
  "/api/opencode-hook/remove": (runtime) => runtime.removeOpencodeHook(),
  "/api/opencode-hook/status": (runtime) => runtime.getOpencodeHookStatus(),
  "/api/opencode-hook/test": (runtime) => runtime.testOpencodeHook(),

  "/api/check-command": (runtime, body) => runtime.checkCommand(body.command),

  // --- Task runner ---
  "/api/task/recheck-claude": (runtime) => runtime.recheckClaude(),
  "/api/task/check-providers": (runtime) => runtime.checkProviders(),
  "/api/task/check-git-repo": (runtime, body) => runtime.checkIsGitRepo(String(body?.cwd || "")),
  "/api/fs/probe-directory": (runtime, body) => runtime.probeDirectory(String(body?.cwd || "")),
  // /api/task/create is handled in the outer dispatch (slot-aware).
  "/api/task/reject-verdict": (runtime, body) => runtime.rejectTaskVerdict(body.workspaceId, body.feedback),
  "/api/task/resend-instruction": (runtime, body) => runtime.resendTaskInstruction(body.workspaceId, body.role),
  // /api/task-recovery/resolve is handled in the outer dispatch (slotAwareRoute)
  // so it resolves the caller's viewer id: an interactive Resume / Start fresh
  // stamps `lastWorkedAt` in the deciding viewer's own context.
  "/api/task/status": (runtime, body) => runtime.getTaskStatus(body.workspaceId),

  "/api/session/activate": (runtime, body) => runtime.activateSession(body.sessionId),

  // /api/workspace-grid/* and /api/attention/* — handled in the slot-aware
  // route block at the server top level so we can resolve windowId from
  // the bound session. The previous inline handlers passed no windowId and
  // the runtime fell back to windowSlots[0]'s profile, letting a remote
  // client on profile B mutate profile A's state.

  "/api/terminal/restart": (runtime, body) => {
    if (isDesktopPrivateSshSession(runtime, body.sessionId))
      throw new Error("Desktop-only SSH operations cannot be controlled remotely");
    return runtime.restartSession(body.sessionId);
  },
  "/api/terminal/replay": (runtime, body) => {
    const parsed = validateIpc(terminalSessionSchema, body, "/api/terminal/replay");
    if (isDesktopPrivateSshSession(runtime, parsed.sessionId))
      throw new Error("Desktop-only SSH operations cannot be replayed remotely");
    return runtime.getTerminalReplay(parsed.sessionId);
  },

  "/api/docker/refresh": (runtime) => runtime.refreshDockerState(),
  "/api/git/refresh": (runtime, body) => runtime.refreshGitState(body.projectId || null),

  // /api/git/skip, /list-conflicts, /conflict-detail, /resolve-conflict and
  // /unresolve-conflict are handled in the outer dispatch (slotAwareRoute) so
  // they resolve the caller's bound windowId and refuse a cross-profile
  // workspace. They are intentionally NOT handled here: the previous inline
  // handlers passed no windowId, so resolveGitWorkspace fell back to
  // windowSlots[0]'s profile and let a remote client on profile B drive
  // conflict resolution on a workspace in profile A. Removing the inline
  // fallback also fails safe — an accidental drop of the slot-aware entry
  // 404s rather than silently re-opening the cross-profile hole.

  // Docker endpoints are validated through the same zod schemas as the
  // Electron IPC channel so a remote/mobile client can't bypass the
  // argv-safety guards (no leading '-', length caps, character whitelists)
  // that the desktop path already enforces. The runtime methods themselves
  // trust their inputs — validation lives here at the trust boundary.
  "/api/docker/action": (runtime, body) => {
    const v = validateIpc(dockerActionSchema, body, "POST /api/docker/action");
    return runtime.dockerAction(v.action, v.containerId, v.backendId, v.contextName);
  },
  // /api/docker/logs/open and /api/docker/shell/open are handled explicitly in
  // handleApiRequest — they wire the streamer's onData/onClose into a
  // `broadcast` call the table has no access to.
  "/api/docker/logs/update": (runtime, body) => {
    const v = validateIpc(dockerLogsUpdateSchema, body, "POST /api/docker/logs/update");
    const ok = runtime.dockerLogsUpdate(v.sessionId, { timestamps: v.timestamps, tail: v.tail });
    return { ok };
  },
  "/api/docker/logs/close": (runtime, body) => {
    const v = validateIpc(dockerLogsCloseSchema, body, "POST /api/docker/logs/close");
    runtime.dockerLogsClose(v.sessionId);
    return { ok: true };
  },
  "/api/docker/shell/close": (runtime, body) => {
    const v = validateIpc(dockerShellCloseSchema, body, "POST /api/docker/shell/close");
    runtime.dockerShellClose(v.sessionId);
    return { ok: true };
  },
  "/api/docker/inspect": (runtime, body) => {
    const v = validateIpc(dockerInspectSchema, body, "POST /api/docker/inspect");
    return runtime.dockerInspect(v.containerId, v.backendId, v.contextName);
  },
  "/api/docker/top": (runtime, body) => {
    const v = validateIpc(dockerTopSchema, body, "POST /api/docker/top");
    return runtime.dockerTop(v.containerId, v.backendId, v.contextName);
  },
  "/api/docker/stats": (runtime, body) => {
    const v = validateIpc(dockerStatsSchema, body, "POST /api/docker/stats");
    return runtime.dockerStats(v.containerId, v.backendId, v.contextName);
  },
  "/api/docker/image/inspect": (runtime, body) => {
    const v = validateIpc(dockerResourceRefSchema, body, "POST /api/docker/image/inspect");
    return runtime.dockerImageInspect(v.resource, v.backendId, v.contextName);
  },
  "/api/docker/volume/inspect": (runtime, body) => {
    const v = validateIpc(dockerResourceRefSchema, body, "POST /api/docker/volume/inspect");
    return runtime.dockerVolumeInspect(v.resource, v.backendId, v.contextName);
  },
  "/api/docker/network/inspect": (runtime, body) => {
    const v = validateIpc(dockerResourceRefSchema, body, "POST /api/docker/network/inspect");
    return runtime.dockerNetworkInspect(v.resource, v.backendId, v.contextName);
  },
  "/api/docker/image/remove": (runtime, body) => {
    const v = validateIpc(dockerRemoveSchema, body, "POST /api/docker/image/remove");
    return runtime.dockerImageRemove(v.resource, v.backendId, v.contextName, !!v.force);
  },
  "/api/docker/volume/remove": (runtime, body) => {
    const v = validateIpc(dockerRemoveSchema, body, "POST /api/docker/volume/remove");
    return runtime.dockerVolumeRemove(v.resource, v.backendId, v.contextName, !!v.force);
  },
  "/api/docker/network/remove": (runtime, body) => {
    const v = validateIpc(dockerRemoveSchema, body, "POST /api/docker/network/remove");
    return runtime.dockerNetworkRemove(v.resource, v.backendId, v.contextName);
  },
  "/api/docker/image/pull": (runtime, body) => {
    const v = validateIpc(dockerResourceRefSchema, body, "POST /api/docker/image/pull");
    return runtime.dockerImagePull(v.resource, v.backendId, v.contextName);
  },
  "/api/docker/image/prune": (runtime, body) => {
    const v = validateIpc(dockerPruneSchema, body, "POST /api/docker/image/prune");
    return runtime.dockerImagePrune(v.backendId, v.contextName, !!v.all);
  },
  "/api/docker/volume/prune": (runtime, body) => {
    const v = validateIpc(dockerPruneSchema, body, "POST /api/docker/volume/prune");
    return runtime.dockerVolumePrune(v.backendId, v.contextName);
  },
  "/api/docker/network/prune": (runtime, body) => {
    const v = validateIpc(dockerPruneSchema, body, "POST /api/docker/network/prune");
    return runtime.dockerNetworkPrune(v.backendId, v.contextName);
  },
  "/api/docker/builder/prune": (runtime, body) => {
    const v = validateIpc(dockerPruneSchema, body, "POST /api/docker/builder/prune");
    return runtime.dockerBuilderPrune(v.backendId, v.contextName, !!v.all);
  },
  "/api/docker/system/df": (runtime, body) => {
    const v = validateIpc(dockerSystemDfSchema, body, "POST /api/docker/system/df");
    return runtime.dockerSystemDf(v.backendId, v.contextName);
  },
  "/api/docker/volume/list": (runtime, body) => {
    const v = validateIpc(dockerVolumeBrowseSchema, body, "POST /api/docker/volume/list");
    return runtime.dockerVolumeList(v.volumeName, v.backendId, v.contextName, v.subPath);
  },
  "/api/docker/volume/read": (runtime, body) => {
    const v = validateIpc(dockerVolumeBrowseSchema, body, "POST /api/docker/volume/read");
    return runtime.dockerVolumeReadFile(v.volumeName, v.backendId, v.contextName, v.subPath);
  },
  "/api/docker/compose-action": (runtime, body) => {
    const v = validateIpc(dockerComposeActionSchema, body, "POST /api/docker/compose-action");
    return runtime.dockerComposeAction(v.action, v.backendId, v.contextName, v.projectName);
  },
  "/api/docker/open-session": (runtime, body) => runtime.openDockerSession(body),
  "/api/docker/open-lazydocker": (runtime, body) => runtime.openLazydockerSession(body),
  "/api/git/open-lazygit": (runtime, body) => runtime.openLazygitSession(body),

  // /api/git/create-worktree is handled in the outer dispatch (slot-aware).

  "/api/profile/save": (runtime, body) => runtime.saveProfile(body.profile),
  "/api/profile/delete": (runtime, body) => runtime.deleteProfile(body.profileId),

  // --- File manager endpoints (read-only by default for remote) ---
  // The fm-backed file routes (list/tree/preview/read/write/…/commit-diff) are NOT here:
  // they run in the slot-aware dispatch (`slotAwareRoute`), which knows the caller's
  // profile and scopes the roots a path may live under to it. Only the no-ops stay.
  // Open-in-explorer is an Electron-only feature; noop for remote.
  "/api/file/open-in-explorer": () => ({ ok: true }),
  // OS-clipboard "copy file" is an Electron-only feature; noop for remote.
  // The renderer-side in-app clipboard still works for paste-within-app.
  "/api/file/clipboard-copy": () => ({ ok: true }),
  // Open-in-editor is an Electron-only feature; noop for remote.
  "/api/file/open-in-editor": () => ({ ok: true }),

  // --- SSH (remote is read-only per plan §14) ---
  "/api/ssh/capabilities": async (runtime) => {
    const capabilities = await runtime["ssh:capabilities:get"]();
    return {
      ...capabilities,
      permissions: {
        canManageHosts: false,
        reason: "SSH host and credential management is available on the desktop only.",
      },
    };
  },
  "/api/ssh/hosts/list": (runtime) => runtime["ssh:hosts:list"](),
  // Returns metadata only; private-key material never leaves the host.
  "/api/ssh/keys/list": (runtime) => runtime["ssh:keys:list"](),
  "/api/ssh/certs/list": (runtime) => runtime["ssh:certs:list"](),
  // Remote sessions are allowed to respond to active prompts only — they
  // can't create/edit credentials. This mirrors how the user is already
  // attached to a session created locally.
  "/api/ssh/auth/answer": (runtime, body) => {
    if (isDesktopPrivateSshSession(runtime, body.sessionId))
      throw new Error("Desktop-only SSH operations cannot be controlled remotely");
    return runtime["ssh:auth:answer"](body);
  },
  "/api/ssh/auth/cancel": (runtime, body) => {
    if (isDesktopPrivateSshSession(runtime, body.sessionId))
      throw new Error("Desktop-only SSH operations cannot be controlled remotely");
    return runtime["ssh:auth:cancel"](body);
  },
  "/api/ssh/host-key/accept": (runtime, body) => {
    if (isDesktopPrivateSshSession(runtime, body.sessionId))
      throw new Error("Desktop-only SSH operations cannot be controlled remotely");
    return runtime["ssh:host-key:accept"](body);
  },
  "/api/ssh/host-key/reject": (runtime, body) => {
    if (isDesktopPrivateSshSession(runtime, body.sessionId))
      throw new Error("Desktop-only SSH operations cannot be controlled remotely");
    return runtime["ssh:host-key:reject"](body);
  },
};

const ATTACHMENT_PROTOCOL_VERSION = 1;
const ATTACHMENT_INFO = Buffer.from("strideterm/attachments/v1", "utf8");
const ATTACHMENT_AAD = (
  direction: "request" | "response",
  pairId: string,
  source: string,
  target: string,
  requestId: string,
  sessionKeyVersion: number,
) =>
  Buffer.from(
    `strideterm-attachment-v1|1|${sessionKeyVersion}|${direction}|${pairId}|${source}|${target}|${requestId}`,
    "utf8",
  );

function resolveAttachmentRoot(runtime: Runtime, workspaceId: string, profileId: string): string {
  const state = (runtime.getPayload() as { appState?: { workspaces?: Array<Record<string, unknown>> } }).appState;
  const workspace = state?.workspaces?.find(
    (candidate) =>
      String(candidate.id ?? "") === workspaceId &&
      String(candidate.profileId ?? "default") === (profileId || "default"),
  );
  if (!workspace) throw new Error("Workspace is not available in this profile");
  const kind = String(workspace.kind ?? "").toLowerCase();
  const panels = Array.isArray(workspace.panels) ? workspace.panels : [];
  const hasUnsupportedPanel = panels.some((panel) => {
    const launch = panel && typeof panel === "object" ? (panel as Record<string, unknown>).launch : null;
    return (
      launch &&
      typeof launch === "object" &&
      ["ssh", "container", "docker"].includes(String((launch as Record<string, unknown>).kind ?? "").toLowerCase())
    );
  });
  if (kind === "ssh" || kind === "container" || kind === "docker" || hasUnsupportedPanel) {
    throw new Error("Attachments are unavailable for SSH or container workspaces");
  }
  const cwd = typeof workspace.cwd === "string" ? workspace.cwd : "";
  if (!cwd || !path.isAbsolute(cwd)) throw new Error("Workspace has no local filesystem root");
  return cwd;
}

function targetBelongsToCaller(
  runtime: Runtime,
  targetId: string,
  callerProfileId: string,
  sessionTarget = false,
): boolean {
  if (!callerProfileId) return true;
  const payload = runtime.getPayload() as { appState?: { workspaces?: Array<Record<string, unknown>> } };
  const parts = targetId.split(":");
  const workspaceId = sessionTarget && parts.length > 1 ? parts.slice(0, -1).join(":") : targetId;
  const workspace = payload.appState?.workspaces?.find((candidate) => String(candidate.id ?? "") === workspaceId);
  return workspace !== undefined && String(workspace.profileId || "default") === callerProfileId;
}

async function handleMobileAttachmentRequest(
  runtime: Runtime,
  session: MobileSessionRecord,
  profileId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!session.deviceId || !runtime.getMobileAttachmentContext) throw new Error("Attachment session is unavailable");
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const pairId = typeof body.pairId === "string" ? body.pairId : "";
  const source = typeof body.sourceDeviceId === "string" ? body.sourceDeviceId : "";
  const target = typeof body.targetDeviceId === "string" ? body.targetDeviceId : "";
  const version = Number(body.version);
  const sessionKeyVersion = Number(body.sessionKeyVersion);
  const outerIssuedAt = Number(body.issuedAt);
  const outerExpiresAt = Number(body.expiresAt);
  const nonce = typeof body.nonce === "string" ? Buffer.from(body.nonce, "base64url") : Buffer.alloc(0);
  const ciphertext = typeof body.ciphertext === "string" ? Buffer.from(body.ciphertext, "base64url") : Buffer.alloc(0);
  if (
    !requestId ||
    version !== ATTACHMENT_PROTOCOL_VERSION ||
    !pairId ||
    !source ||
    !target ||
    !Number.isInteger(sessionKeyVersion) ||
    nonce.length !== 12 ||
    ciphertext.length < 16
  )
    throw new Error("Invalid attachment envelope");
  if (
    pairId !== session.pairId ||
    source !== session.deviceId ||
    target !== runtime.getMobileAttachmentContext(session.deviceId).desktopDeviceId
  )
    throw new Error("Attachment identity mismatch");
  const context = runtime.getMobileAttachmentContext(session.deviceId);
  const device = context.device;
  if (
    !device ||
    device.revoked ||
    device.state !== "active" ||
    sessionKeyVersion !== device.sessionKeyVersion ||
    !runtime.isMobileSessionStillAuthorized?.(session.deviceId, profileId)
  )
    throw new Error("Attachment device is not authorized");
  if (pairId !== device.pairId) throw new Error("Attachment pairing mismatch");
  const key = deriveSessionKey(
    context.privateKey,
    publicKeyFromRaw(decodeCanonicalPublicKey(device.publicKey)),
    Buffer.from(pairId, "utf8"),
    ATTACHMENT_INFO,
  );
  const opened = openEnvelope(
    ciphertext,
    nonce,
    key,
    ATTACHMENT_AAD("request", pairId, source, target, requestId, sessionKeyVersion),
  );
  const request = validateIpc(
    mobileAttachmentOperationSchema,
    JSON.parse(opened.toString("utf8")),
    "mobile attachment operation",
  ) as {
    operation?: string;
    payload?: Record<string, unknown>;
    issuedAt?: number;
    expiresAt?: number;
  };
  const now = Date.now();
  const issuedAt = request.issuedAt;
  const expiresAt = request.expiresAt;
  if (
    !request.operation ||
    !request.payload ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    outerIssuedAt !== issuedAt ||
    outerExpiresAt !== expiresAt
  )
    throw new Error("Attachment request expired");
  const issuedAtNumber = issuedAt as number;
  const expiresAtNumber = expiresAt as number;
  if (
    expiresAtNumber < now ||
    issuedAtNumber > now + 30_000 ||
    expiresAtNumber <= issuedAtNumber ||
    expiresAtNumber - issuedAtNumber > 60_000
  )
    throw new Error("Attachment request expired");
  const payload = request.payload;
  const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : "";
  const owner = `${pairId}:${session.deviceId}:${profileId}:${workspaceId}`;
  let result: unknown;
  try {
    const root = workspaceId ? resolveAttachmentRoot(runtime, workspaceId, profileId) : "";
    switch (request.operation) {
      case "attachment.begin":
        result = await attachments.begin(
          root,
          String(payload.name ?? ""),
          Number(payload.size),
          String(payload.sha256 ?? ""),
          owner,
          // `idempotencyKey` is genuinely OPTIONAL (mobileAttachmentOperationSchema), and
          // `attachments.begin` treats "a key was provided" and "no key was provided" as two
          // different, both-valid states — coercing an absent key to "" collapsed them: `beginUnlocked`
          // refuses an EMPTY key ("Invalid idempotency key") to catch a caller that sent a blank
          // string on purpose, and that refusal fired on every begin that simply omitted the field.
          payload.idempotencyKey === undefined ? undefined : String(payload.idempotencyKey),
        );
        break;
      case "attachment.chunk":
        result = await attachments.chunk(
          root,
          String(payload.transferId ?? ""),
          Number(payload.offset),
          String(payload.data ?? ""),
          owner,
        );
        break;
      case "attachment.status": {
        const status = (await attachments.status(root, String(payload.transferId ?? ""), owner)) as Record<
          string,
          unknown
        >;
        result =
          "path" in status ? { state: "complete", ...status, offset: status.size } : { state: "receiving", ...status };
        break;
      }
      case "attachment.finish":
        result = await attachments.finish(root, String(payload.transferId ?? ""), owner);
        break;
      case "attachment.cancel":
        result = await attachments.cancel(root, String(payload.transferId ?? ""), owner);
        break;
      case "attachment.list":
        result = await attachments.listWithUsage(root);
        break;
      case "attachment.delete":
        result = await attachments.remove(root, String(payload.transferId ?? ""), String(payload.name ?? ""));
        break;
      default:
        throw new Error("Unknown attachment operation");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Attachment operation failed";
    const code =
      error instanceof AttachmentPolicyError
        ? error.code
        : /daily receive quota/i.test(message)
          ? "attachment-daily-quota-exceeded"
          : /quota exceeded|concurrent attachment/i.test(message)
            ? "attachment-quota-exceeded"
            : "attachment-failed";
    result = {
      error: { code },
    };
  }
  const response = sealEnvelope(
    Buffer.from(JSON.stringify(result), "utf8"),
    key,
    ATTACHMENT_AAD("response", pairId, source, target, requestId, sessionKeyVersion),
  );
  return {
    version,
    requestId,
    pairId,
    sourceDeviceId: source,
    targetDeviceId: target,
    sessionKeyVersion,
    nonce: response.nonce.toString("base64url"),
    ciphertext: response.ciphertext.toString("base64url"),
  };
}

/** HTTP status for an error thrown out of a route handler: a refused request is the caller's (4xx), anything else is ours (500). */
function refusalStatus(error: unknown, message: string): number {
  if (error instanceof ClientRequestError) return error.status;
  return message.startsWith("IPC validation failed") ? 400 : 500;
}

async function handleApiRequest(
  runtime: Runtime,
  request: IncomingMessage,
  response: ServerResponse,
  broadcast: (message: unknown) => void = () => {},
  /**
   * Profile the calling session is bound to, or "" for a caller that
   * authenticated with the master token alone and never bound a session.
   */
  callerProfileId = "",
  callerIsMobile = false,
  callerSessionId = "",
): Promise<void> {
  const url = new URL(request.url!, "http://localhost");

  try {
    if (request.method === "GET" && url.pathname === "/api/state") {
      json(response, 200, await runtime.getInitialState());
      return;
    }

    // Permission auto-approval trail. Read-only, hence remote-reachable: a
    // remote client may never FLIP `notifications.autoApprovePermissions`
    // (see REMOTE_BLOCKED_NOTIFICATION_FIELDS) but it should absolutely be
    // able to see what the desktop approved while nobody was looking.
    //
    // Scoped to the caller's profile, exactly like the live `approval:recorded`
    // event: a browser bound to profile B has never seen profile A's
    // workspaces and must not read their tools, summaries or session ids out
    // of the log either. A caller that presents the MASTER TOKEN and binds no
    // session gets the whole installation's trail — that token already grants
    // every mutation on every profile, so there is nothing left for scoping to
    // protect, and a machine-to-machine reader needs the complete view.
    if (request.method === "GET" && url.pathname === "/api/approvals/audit-log") {
      json(response, 200, runtime.queryApprovalAuditLog(approvalAuditLogFilters(url, callerProfileId)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/approvals/audit-log/stats") {
      json(response, 200, {
        ...runtime.getApprovalAuditStats({
          from: url.searchParams.get("from") || undefined,
          profileId: callerProfileId || undefined,
        }),
      });
      return;
    }

    const body = await readRequestBody(request);
    // Let the response adapter's mutation ack name the resources this route
    // changed (from prKey/workspaceId/projectId in the body). No-op for routes
    // that deliver a core rather than an ack.
    const ackCtx = (response as ResponseWithCtx).__remoteCtx;
    if (ackCtx) ackCtx.body = body as Record<string, unknown>;

    if (request.method === "POST" && url.pathname.startsWith("/api/mobile/workspaces/")) {
      if (!callerIsMobile || !callerProfileId) {
        json(response, 403, { error: "A bound mobile session is required" });
        return;
      }
      const assertedProfile = typeof body.profileId === "string" ? body.profileId : "";
      if (assertedProfile !== callerProfileId) {
        json(response, 403, { error: "Profile does not match this mobile session" });
        return;
      }
      try {
        switch (url.pathname) {
          case "/api/mobile/workspaces/directories/list": {
            const parsed = validateIpc(nativeWorkspaceDirectoryListSchema, body, url.pathname);
            json(
              response,
              200,
              await runtime.listWorkspaceDirectories!(callerProfileId, parsed.path, {
                query: parsed.query,
                sort: parsed.sort,
              }),
            );
            return;
          }
          case "/api/mobile/workspaces/directories/create": {
            const parsed = validateIpc(nativeWorkspaceDirectoryCreateSchema, body, url.pathname);
            json(
              response,
              200,
              await runtime.createWorkspaceDirectory!(callerProfileId, parsed.parentPath, parsed.name),
            );
            return;
          }
          case "/api/mobile/workspaces/create": {
            const parsed = validateIpc(nativeWorkspaceCreateSchema, body, url.pathname);
            json(
              response,
              200,
              await runtime.createWorkspaceFromDirectory!(
                callerProfileId,
                parsed.path,
                parsed.name,
                `remote:${callerSessionId}`,
              ),
            );
            return;
          }
          case "/api/mobile/workspaces/scratchpads/list": {
            validateIpc(nativeWorkspaceProfileSchema, body, url.pathname);
            json(response, 200, await runtime.listScratchpadWorkspaces!(callerProfileId));
            return;
          }
          case "/api/mobile/workspaces/scratchpads/create": {
            validateIpc(nativeWorkspaceProfileSchema, body, url.pathname);
            json(response, 200, await runtime.createScratchpadWorkspace!(callerProfileId, `remote:${callerSessionId}`));
            return;
          }
          case "/api/mobile/workspaces/scratchpads/keep": {
            const parsed = validateIpc(nativeScratchpadKeepSchema, body, url.pathname);
            json(response, 200, await runtime.keepScratchpadWorkspace!(callerProfileId, parsed.workspaceId, parsed));
            return;
          }
          case "/api/mobile/workspaces/scratchpads/discard": {
            const parsed = validateIpc(nativeScratchpadDiscardSchema, body, url.pathname);
            json(
              response,
              200,
              await runtime.discardScratchpadWorkspace!(callerProfileId, parsed.workspaceId, parsed.confirmed),
            );
            return;
          }
        }
      } catch (error) {
        json(response, 400, { error: (error as Error).message || "Workspace operation failed" });
        return;
      }
    }

    // NOTE: every POST pathname registered in `slotAwareRoute` (below, at the
    // server top level) is intercepted there UNCONDITIONALLY, before this
    // function ever runs — so this function must not carry an inline copy of
    // any of those routes. An inline copy would be dead code today, but would
    // silently "fail open" onto no-windowId behavior (re-opening the
    // cross-profile hole slot-aware routing exists to close) if the
    // slotAwareRoute entry were ever accidentally removed later. Only routes
    // that are NOT in slotAwareRoute belong here. See the `/api/git/skip`
    // family comment further down for the original instance of this pattern;
    // a source-shape test in remote-server.test.ts enforces it repo-wide.

    if (request.method === "POST" && url.pathname === "/api/settings/update") {
      // Drop fields a remote caller is never authorised to change. See
      // REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS and REMOTE_BLOCKED_TOP_LEVEL_FIELDS
      // for the rationale; the short version is "anything that controls a
      // binary spawn or the network bind/auth knobs". Mutating the parsed body
      // in place is fine — it isn't shared.
      //
      // We log every actual drop at warn-level so a leaked-token probe (or a
      // confused mobile UI sending desktop-only fields) leaves an
      // investigatable trail in the strideterm log; the per-request audit log
      // already records the request itself, this entry is the "and here's
      // what we silently stripped from it" annotation.
      const settings = (body.settings || {}) as Record<string, unknown>;
      const droppedFields = sanitizeSettingsFromRemote(settings);
      if (droppedFields.length > 0) {
        log.warn("remote settings update: dropped privileged fields", {
          fields: droppedFields,
          remoteAddress: request.socket?.remoteAddress,
        });
      }
      const result = await runtime.updateSettings(settings);
      json(response, 200, result.payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/logs/open") {
      // Wire the streamer's onData/onClose callbacks to WebSocket broadcasts.
      // Buffers come over WS as utf8 strings — docker log payloads are ANSI
      // text and the renderer's writeData() already accepts strings, so we
      // avoid the base64 round-trip. (Binary log payloads would still survive
      // as latin-1-ish noise; acceptable for an MVP that runs against text
      // logs in practice.)
      const v = validateIpc(dockerLogsOpenSchema, body, "POST /api/docker/logs/open");
      await runtime.dockerLogsOpen(
        v.sessionId,
        v.containerId,
        v.backendId,
        v.contextName,
        (sid: string, data: Buffer) =>
          broadcast({ type: "docker:logs:write", payload: { sessionId: sid, data: data.toString("utf8") } }),
        (sid: string, code: number | null) =>
          broadcast({ type: "docker:logs:close", payload: { sessionId: sid, code } }),
        { timestamps: v.timestamps, tail: v.tail },
      );
      json(response, 200, { ok: true });
      return;
    }
    // Docker interactive shell (`docker exec -it`). Open/close are infrequent
    // (once per tab) so they're plain HTTP POSTs, same shape as the log-stream
    // routes above; per-keystroke write/resize instead ride the WS socket
    // (see the "docker:shell:write"/"docker:shell:resize" branches in the WS
    // message handler below) exactly like terminal:input/terminal:resize do
    // for a regular terminal session — a docker shell is the same kind of
    // PTY-like stream, just one HTTP POST per keystroke would be wasteful.
    if (request.method === "POST" && url.pathname === "/api/docker/shell/open") {
      const v = validateIpc(dockerShellOpenSchema, body, "POST /api/docker/shell/open");
      await runtime.dockerShellOpen(
        v.sessionId,
        v.containerId,
        v.backendId,
        v.contextName,
        v.cols ?? 80,
        v.rows ?? 24,
        (sid: string, data: string) => broadcast({ type: "docker:shell:data", payload: { sessionId: sid, data } }),
        (sid: string, code: number | null) =>
          broadcast({ type: "docker:shell:close", payload: { sessionId: sid, code } }),
      );
      json(response, 200, { ok: true });
      return;
    }

    // Explicitly forbid credential/host administration from remote clients
    // so a leaked token can't exfiltrate or plant SSH hosts/keys. See plan
    // §14 — this must never be opened up without a per-host-on-remote
    // authorization story.
    if (
      request.method === "POST" &&
      (url.pathname === "/api/ssh/hosts/create" ||
        url.pathname === "/api/ssh/hosts/update" ||
        url.pathname === "/api/ssh/hosts/delete" ||
        url.pathname === "/api/ssh/hosts/duplicate" ||
        url.pathname === "/api/ssh/hosts/test" ||
        url.pathname === "/api/ssh/keys/import" ||
        url.pathname === "/api/ssh/keys/generate" ||
        url.pathname === "/api/ssh/keys/delete" ||
        url.pathname === "/api/ssh/keys/rename" ||
        url.pathname === "/api/ssh/keys/transfer/start" ||
        url.pathname === "/api/ssh/keys/transfer/stop" ||
        url.pathname === "/api/ssh/certs/import" ||
        url.pathname === "/api/ssh/certs/delete" ||
        url.pathname === "/api/ssh/config/preview" ||
        url.pathname === "/api/ssh/config/import" ||
        url.pathname === "/api/ssh/known-hosts/import")
    ) {
      json(response, 403, { error: "SSH administration is not permitted on remote clients." });
      return;
    }

    if (request.method === "POST") {
      const handler = API_ROUTES[url.pathname];
      if (handler) {
        if (
          url.pathname === "/api/terminal/replay" &&
          !targetBelongsToCaller(runtime, String(body.sessionId ?? ""), callerProfileId, true)
        ) {
          json(response, 403, { error: "Target session is not available in this profile" });
          return;
        }
        if (
          url.pathname === "/api/task/status" &&
          !targetBelongsToCaller(runtime, String(body.workspaceId ?? ""), callerProfileId)
        ) {
          json(response, 403, { error: "Target workspace is not available in this profile" });
          return;
        }
        json(response, 200, await handler(runtime, body));
        return;
      }
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    const msg = (error as Error).message || "Remote API failed";
    const statusCode = refusalStatus(error, msg);
    json(response, statusCode, { error: msg });
  }
}

export async function startRemoteServer({
  runtime,
  staticRoot,
  congestionCloseGraceMs = CONGESTION_CLOSE_GRACE_MS,
  socketStallGraceMs = SOCKET_STALL_GRACE_MS,
  socketStallSweepMs = SOCKET_STALL_SWEEP_MS,
  socketBufferedAmount = (socket) => socket.bufferedAmount,
  mobileSessionAbsoluteTtlMs = MOBILE_SESSION_ABSOLUTE_TTL_MS,
  mobileSessionIdleTtlMs = MOBILE_SESSION_IDLE_TTL_MS,
  mobileSessionSweepMs = MOBILE_SESSION_SWEEP_MS,
  mobileTerminalInputFlushMs = MOBILE_TERMINAL_INPUT_FLUSH_MS,
  wsHeartbeatIntervalMs = WS_HEARTBEAT_INTERVAL_MS,
  wsHeartbeatMaxMissed = WS_HEARTBEAT_MAX_MISSED,
  loopbackOrigin,
}: {
  runtime: Runtime;
  staticRoot: string;
  /** Grace period between a backpressure 1013 close and the terminate()
   *  fallback. Injectable so tests can exercise the fallback without a 5s wait. */
  congestionCloseGraceMs?: number;
  /** No-drain-progress window before a backlogged socket is closed. Injectable
   *  so tests don't wait the full 15s. */
  socketStallGraceMs?: number;
  /** Stall-sweep sample interval. Injectable so tests can drive it fast. */
  socketStallSweepMs?: number;
  /**
   * The two mobile-session deadlines and the sweep interval, injectable for the same reason as
   * everything above: eight hours and thirty minutes are the product's numbers, and a test that
   * proves a deadline closes a live WebSocket cannot wait for either.
   */
  mobileSessionAbsoluteTtlMs?: number;
  mobileSessionIdleTtlMs?: number;
  mobileSessionSweepMs?: number;
  /** Quiet period after which a mobile session's aggregated terminal-input audit row is written. */
  mobileTerminalInputFlushMs?: number;
  /**
   * The keep-alive tick and how many of them a silent client survives, injectable for the same
   * reason: the shipped tolerance is a minute of unreachability and no test can wait for it. What
   * they buy is the TOLERANCE ITSELF being provable — the difference between three strikes and one
   * is invisible on a desk and is the whole difference on a phone.
   */
  wsHeartbeatIntervalMs?: number;
  wsHeartbeatMaxMissed?: number;
  /** Reader for a socket's outbound buffered bytes. Defaults to the real
   *  `socket.bufferedAmount`. Injectable ONLY for tests: loopback kernel buffers
   *  absorb multi-MB queues so `bufferedAmount` never reflects a real backlog
   *  over 127.0.0.1, making the backlog/stall path impossible to exercise
   *  deterministically otherwise. Never overridden in production. */
  socketBufferedAmount?: (socket: import("ws").WebSocket) => number;
  /**
   * Starts this same server as the managed relay's INTERNAL ORIGIN instead of the user's
   * configured LAN/tunnel listener (relay plan §5.4).
   *
   * The relay connector needs the real remote handlers, the real registry and the real runtime —
   * "share the same handlers and runtime, but expose the connector a loopback-only origin" is what
   * the plan asks for, and a second instance of this function is the smallest way to get exactly
   * that. What it must NOT do is behave like the user's remote access: so when this is present the
   * server
   *
   *   - starts regardless of `remoteAccess.enabled`, because the relay is a different feature with
   *     its own flag, and turning the relay on must never open the LAN listener the user did not
   *     ask for (nor turning it off close one they did);
   *   - binds only the loopback address it is given, on a port the caller obtained from the OS;
   *   - authenticates with a per-process random token only the connector holds — never the user's
   *     master remote token, which is what a browser bookmark and a Telegram `/tunnel` message
   *     carry;
   *   - publishes nothing: no `setRemoteInfo` (which would overwrite the URLs the settings UI
   *     shows), no `setRemoteClientRegistry` and no `setMobileRemoteSessionRevoker` (both are the
   *     primary server's to own). The revoke hook is returned instead, for the relay manager to
   *     wire up itself. It does ADD its own remote-client registry to the runtime
   *     (`addRemoteClientRegistry`) and remove it again on close — without that the runtime cannot
   *     resolve a relay viewer at all, and a per-viewer operation either fails or, worse, skips a
   *     profile guard that reads an unresolvable viewer as "not a viewer".
   */
  loopbackOrigin?: {
    /** `127.0.0.1` or `::1`. Rejected otherwise — this listener must never be reachable off-box. */
    host: string;
    /** A port the caller has already obtained from the OS, or 0 to let the OS pick one now. */
    port: number;
    /**
     * Per-process random secret the connector presents on every request and upgrade, in the
     * `X-Strideterm-Relay-Origin` header.
     *
     * It is a TRANSPORT guard, not an authorization: it answers "is this the connector talking",
     * and nothing more. A viewer's own request still authenticates the ordinary way, with the
     * one-time WebView ticket it exchanges for the session cookie — otherwise the relay would be
     * handing every viewer the authority of a master token and letting it reach the API before the
     * bootstrap it is supposed to go through.
     *
     * The master token of a loopback-origin server is a fresh random this process never emits
     * anywhere, so that door is closed rather than merely unused (plan §5.4 "no publicly shared
     * master token").
     */
    guardToken: string;
    /**
     * The PUBLIC origin viewers reach this relay at — e.g. `https://relay.strideterm.dev`.
     *
     * Supplied by `MobileRelayManager`, which learned it from the grant issuer's own answer, and never
     * derived from a `Host`, `Origin` or `X-Forwarded-*` header on an incoming request. That is the
     * whole point: the loopback listener sees only the connector's rewritten headers, so anything it
     * inferred from a request would be a value a viewer could influence (production hardening §5
     * "Ticket" 3). It is what a relay-minted ticket's `allowedOrigin` is compared against.
     */
    publicOrigin: string;
  };
}): Promise<{
  close: () => Promise<void>;
  /** Present only for a `loopbackOrigin` server: the address it actually bound. */
  address?: { host: string; port: number };
  _debugRouting?: () => { congested: boolean; hasCloseTimer: boolean }[];
  _debugCongestionTerminates?: () => number;
  _debugTelemetry?: () => ReturnType<ReturnType<typeof createRemoteTelemetry>["snapshot"]>;
  /** Test-only: reference identity of the two per-request route lookup tables
   *  (DETAIL_ROUTES, slotAwareRoute). Both are built once per server instance,
   *  not rebuilt inside the request handler — this hook exists only so a test
   *  can prove that by comparing references across two live requests. */
  _debugRouteMapsIdentity?: () => { detailRoutes: unknown; slotAwareRoute: unknown };
  /** Test/production hook: close a revoked device's active remote HTTP/WS session(s) (plan §9.2/§10.6). */
  revokeMobileSessionsForDevice?: (deviceId: string) => void;
}> {
  const configured = runtime.getPayload().appState.settings.remoteAccess;
  // A loopback-origin server is the relay's internal origin, not the user's remote access: it never
  // consults `remoteAccess.enabled`, never uses the master token, and never reports URLs.
  const isLoopbackOrigin = loopbackOrigin !== undefined;
  if (isLoopbackOrigin && loopbackOrigin.host !== "127.0.0.1" && loopbackOrigin.host !== "::1") {
    throw new Error(`loopbackOrigin.host must be 127.0.0.1 or ::1 (got ${loopbackOrigin.host})`);
  }
  const host = isLoopbackOrigin ? loopbackOrigin.host : resolveRemoteBindHost(configured);
  // The configured port goes through the resolver, not straight off the settings object:
  // `STRIDETERM_REMOTE_PORT` has to be able to move a build that already HAS a settings file,
  // which is the only situation anybody sets it in (a dev build beside a production install,
  // both wanting 43123). A loopbackOrigin port is an explicit internal argument and is left
  // alone — overriding that would move the relay's own origin, which nobody asked for.
  const port = isLoopbackOrigin ? loopbackOrigin.port : resolveRemoteAccessPort(configured.port);
  // A loopback-origin server has no usable master token: this value is never logged, never listed
  // and never handed to anyone, so the `?token=`/`Authorization: Bearer` path simply has no key.
  const token = isLoopbackOrigin ? randomBytes(32).toString("base64url") : configured.token;
  if (!isLoopbackOrigin && (!configured.enabled || configured.paused)) {
    runtime.setRemoteInfo({ enabled: false, urls: [], port, host });
    return { close: async () => {} };
  }
  if (!isLoopbackOrigin && !token) {
    // The runtime adopts the token from the credential store at startup, so this is not expected.
    // Never start a server whose bearer secret is empty: treat remote access as disabled instead.
    log.error("remote access has no token; the remote server is not started");
    runtime.setRemoteInfo({ enabled: false, urls: [], port, host });
    return { close: async () => {} };
  }

  const audit = createAuditLogger(isLoopbackOrigin ? "relay-origin-api-audit" : "remote-api-audit");

  // Active sessions, keyed by session id (cookie value or `token-client:*`).
  // Lives only in process memory; restarts (settings change, token
  // regenerate, app quit) wipe it, by design — that's how clients lose
  // access when the user revokes the token. See SESSION_COOKIE_NAME for the
  // threat model. `.has(id)` is still the authorization check everywhere —
  // widening Set -> Map does not change what counts as authorized.
  const activeSessions = new Map<string, MobileSessionRecord>();

  // Per-session remote client contexts — profile / workspace / session the
  // browser is currently looking at.  Never persisted; wiped on restart.
  const registry = new RemoteClientRegistry();
  registry.startCleanupSweep();
  // Expose the registry so runtime can call fallback helpers when profiles /
  // workspaces are deleted (runtime.setRemoteClientRegistry).
  // The primary server owns the runtime-facing handles. A relay-origin instance has its own
  // registry (that is what gives the mobile viewer its own profile/workspace/tab state) but must
  // not replace the one the desktop windows and the LAN browser are using — so it is ADDED
  // alongside, and the runtime routes each per-client operation to whichever registry holds that
  // client. A relay viewer whose registry the runtime cannot see is a viewer whose workspace switch
  // fails and whose profile guard silently does not apply.
  let releaseRegistry: () => void = () => {};
  if (isLoopbackOrigin) {
    releaseRegistry = runtime.addRemoteClientRegistry?.(registry) ?? releaseRegistry;
  } else {
    runtime.setRemoteClientRegistry?.(registry);
  }

  /** Constant-time compare of the connector guard header against this server's own secret. */
  function relayGuardPassed(headers: IncomingMessage["headers"]): boolean {
    const presented = headers[RELAY_ORIGIN_GUARD_HEADER];
    return typeof presented === "string" && tokensEqual(presented, loopbackOrigin?.guardToken || "");
  }

  function isAuthorized(requestUrl: string, headers: IncomingMessage["headers"]): boolean {
    // Master token (URL `?token=` or `Authorization: Bearer …`) — used
    // by the renderer's fetch path and by external callers like the
    // mobile inbox / agent tooling.
    if (tokensEqual(getTokenFromRequest(requestUrl, headers), token)) return true;
    // Session cookie — minted on first HTML hit, used for every
    // subsequent navigation and WebSocket upgrade from the same
    // browser. Avoids re-emitting the long-lived token on every
    // request.
    const sessionId = getSessionFromRequest(headers);
    // `touchMobileSession` is the whole enforcement point for a mobile session: it ends one that is
    // past either deadline or whose device is no longer authorized, and returns false — so the answer
    // to "is this request authorized" and "is this session still alive" cannot disagree.
    if (sessionId && activeSessions.has(sessionId)) return touchMobileSession(sessionId);
    return false;
  }

  function mintSession(requestedProfileId = ""): string {
    const id = randomBytes(32).toString("base64url");
    // Bootstrap default profile / workspace context for this new session.
    const client = registry.getOrCreate(
      id,
      (runtime.getPayload() as Record<string, unknown>).appState,
      requestedProfileId,
    );
    const now = Date.now();
    activeSessions.set(id, {
      sessionId: id,
      deviceId: null,
      pairId: null,
      profileId: client.profileId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: null,
      idleExpiresAt: null,
    });
    return id;
  }

  /**
   * Records one `session.*` row for a MOBILE session (a record with a device id); a no-op for every
   * other kind of session. An audit failure must never break the request it describes.
   */
  function recordMobileSessionAudit(
    record: { deviceId: string | null; pairId: string | null } | undefined,
    action: string,
    status: "success" | "failure",
    detail?: string,
  ): void {
    if (!record?.deviceId) return;
    try {
      runtime.recordMobileSessionAudit?.({
        deviceId: record.deviceId,
        pairId: record.pairId ?? "",
        action,
        status,
        detail,
      });
    } catch (err) {
      log.warn("mobile session audit write failed", { err: (err as Error)?.message || String(err) });
    }
  }

  /**
   * Pushes the live mobile sessions (records with a device id) to the runtime. Metadata only: the
   * session id and pair id never leave this function. A failure here must never break the request
   * or shutdown that changed the set.
   */
  function publishMobileSessions(stopping = false): void {
    try {
      const sessions = stopping
        ? []
        : [...activeSessions.values()]
            .filter((record) => record.deviceId)
            .map((record) => ({
              deviceId: record.deviceId as string,
              profileId: record.profileId,
              startedAt: record.createdAt,
            }));
      runtime.onMobileSessionsChanged?.(sessions, isLoopbackOrigin ? "relay" : "direct");
    } catch (err) {
      log.warn("mobile session list publish failed", { err: (err as Error)?.message || String(err) });
    }
  }

  /** Quotes a client-named value (a path) for an audit `detail`: no control characters, bounded length. */
  function auditDetailValue(value: unknown): string {
    const text = typeof value === "string" ? value : "";
    return JSON.stringify(text.length > MOBILE_AUDIT_VALUE_MAX ? text.slice(0, MOBILE_AUDIT_VALUE_MAX) : text);
  }

  /**
   * Terminal input of a mobile session, aggregated per (mobile session, terminal). One row per
   * submitted command or per quiet period — never one per keystroke, and never the typed bytes
   * (they may be a password): only how many bytes and how many line breaks went through.
   */
  interface MobileTerminalInputAccumulator {
    deviceId: string;
    pairId: string | null;
    sessionId: string;
    terminalSessionId: string;
    bytes: number;
    lines: number;
    timer: NodeJS.Timeout | null;
  }
  const mobileTerminalInput = new Map<string, MobileTerminalInputAccumulator>();

  function flushMobileTerminalInput(key: string): void {
    const acc = mobileTerminalInput.get(key);
    if (!acc) return;
    mobileTerminalInput.delete(key);
    if (acc.timer) clearTimeout(acc.timer);
    recordMobileSessionAudit(
      acc,
      "session.terminal-input",
      "success",
      `terminal=${acc.terminalSessionId} bytes=${acc.bytes} lines=${acc.lines}`,
    );
  }

  function flushMobileTerminalInputForSession(sessionId: string): void {
    for (const [key, acc] of [...mobileTerminalInput]) {
      if (acc.sessionId === sessionId) flushMobileTerminalInput(key);
    }
  }

  function recordMobileTerminalInput(sessionId: string, terminalSessionId: string, data: string): void {
    const record = activeSessions.get(sessionId);
    if (!record?.deviceId) return;
    const key = `${sessionId}\u0000${terminalSessionId}`;
    let acc = mobileTerminalInput.get(key);
    if (!acc) {
      acc = {
        deviceId: record.deviceId,
        pairId: record.pairId,
        sessionId,
        terminalSessionId,
        bytes: 0,
        lines: 0,
        timer: null,
      };
      mobileTerminalInput.set(key, acc);
    }
    acc.bytes += Buffer.byteLength(data, "utf8");
    // A CRLF pair is one submitted line, not two.
    const lineBreaks = data.match(/\r\n|\r|\n/g)?.length ?? 0;
    acc.lines += lineBreaks;
    if (acc.timer) clearTimeout(acc.timer);
    if (lineBreaks > 0) {
      flushMobileTerminalInput(key);
      return;
    }
    acc.timer = setTimeout(() => flushMobileTerminalInput(key), mobileTerminalInputFlushMs);
    acc.timer.unref?.();
  }

  /** Audit side of a mobile session going away: pending input first, then the `session.ended` row. */
  function auditMobileSessionEnded(record: MobileSessionRecord | undefined, reason: string): void {
    if (!record?.deviceId) return;
    flushMobileTerminalInputForSession(record.sessionId);
    recordMobileSessionAudit(record, "session.ended", "success", `reason=${reason}`);
  }

  /** Mints a session bound to a mobile device, from an already-consumed WebView ticket record (never from client-supplied fields). */
  function mintMobileSession(ticket: { deviceId: string; pairId: string; profileId: string }): string {
    const id = randomBytes(32).toString("base64url");
    registry.getOrCreate(id, (runtime.getPayload() as Record<string, unknown>).appState, ticket.profileId);
    const now = Date.now();
    activeSessions.set(id, {
      sessionId: id,
      deviceId: ticket.deviceId,
      pairId: ticket.pairId,
      profileId: ticket.profileId,
      createdAt: now,
      lastSeenAt: now,
      // Both deadlines start here, and the absolute one is never moved again.
      expiresAt: now + mobileSessionAbsoluteTtlMs,
      idleExpiresAt: now + mobileSessionIdleTtlMs,
    });
    publishMobileSessions();
    return id;
  }

  /**
   * Whether [record] is past either of its deadlines, or belongs to a device that may no longer use it.
   *
   * One function for all three questions, called from every door: the HTTP authorization gate, the
   * WebSocket upgrade, and the sweep that runs without traffic. A session that fails it is removed and
   * its sockets closed — the plan's "mobile session past expiry answers 401 and the registry holds no
   * stale state for it".
   */
  function mobileSessionExpiry(
    record: MobileSessionRecord,
    now: number,
  ): "live" | "absolute-expired" | "idle-expired" | "unauthorized" {
    if (record.expiresAt === null) return "live";
    if (record.expiresAt <= now) return "absolute-expired";
    if (record.idleExpiresAt !== null && record.idleExpiresAt <= now) return "idle-expired";
    // The device's CURRENT authorization, not the one that produced the ticket. A capability or
    // profile change is not a revoke, so nothing pushes it; asking here is what makes it take effect.
    if (record.deviceId && runtime.isMobileSessionStillAuthorized) {
      const profileId = registry.get(record.sessionId)?.profileId ?? record.profileId;
      if (!runtime.isMobileSessionStillAuthorized(record.deviceId, profileId)) return "unauthorized";
    }
    return "live";
  }

  /**
   * Ends [sessionId] and everything holding it: the record, its sockets, and its registry client.
   *
   * The registry entry matters as much as the record: a remote client left behind resolves for
   * per-viewer operations and makes a dead session look like a live viewer to the runtime.
   */
  function endMobileSession(sessionId: string, reason: string): void {
    const record = activeSessions.get(sessionId);
    activeSessions.delete(sessionId);
    auditMobileSessionEnded(record, reason);
    closeSessionSockets(sessionId, reason);
    registry.remove(sessionId);
    if (record?.deviceId) publishMobileSessions();
    audit.info("mobile session ended", { sessionRef: remoteSessionRef(sessionId), reason });
  }

  /**
   * Evaluates a session on the request path: ends it if it is over, and otherwise records activity.
   *
   * `activity` is false for the things that must NOT hold a session open — a heartbeat, a ping, a
   * keep-alive. The absolute deadline is untouched either way, because that is what "absolute" means.
   */
  function touchMobileSession(sessionId: string, activity = true): boolean {
    const record = activeSessions.get(sessionId);
    if (!record) return false;
    const now = Date.now();
    const verdict = mobileSessionExpiry(record, now);
    if (verdict !== "live") {
      endMobileSession(sessionId, verdict);
      return false;
    }
    if (activity && record.expiresAt !== null) {
      activeSessions.set(sessionId, {
        ...record,
        lastSeenAt: now,
        idleExpiresAt: now + mobileSessionIdleTtlMs,
      });
    }
    return true;
  }

  /**
   * The deadline sweep: ends what has run out of time whether or not anything is still talking.
   *
   * Without it an idle WebSocket would sit open past both deadlines until the next request that never
   * comes — which is exactly the shape of session the deadlines exist to end (production hardening §5
   * "Session" 3). One interval for the whole server, unref'd so it never holds the process open.
   */
  const mobileSessionSweep = setInterval(() => {
    for (const [sessionId, record] of [...activeSessions]) {
      if (record.expiresAt === null) continue;
      const verdict = mobileSessionExpiry(record, Date.now());
      if (verdict !== "live") endMobileSession(sessionId, verdict);
    }
  }, mobileSessionSweepMs);
  mobileSessionSweep.unref?.();

  function sessionIdForRequest(requestUrl: string, headers: IncomingMessage["headers"]): string {
    const url = new URL(requestUrl, "http://localhost");
    const cookieSessionId = getSessionFromRequest(headers);
    if (cookieSessionId && activeSessions.has(cookieSessionId)) {
      // Same check as `isAuthorized`, because this function is reached on paths that did not go
      // through it — and a session id handed out here would otherwise outlive its own deadline.
      return touchMobileSession(cookieSessionId) ? cookieSessionId : "";
    }
    if (!tokensEqual(getTokenFromRequest(requestUrl, headers), token)) return "";
    const clientId = getClientIdFromRequest(requestUrl, headers);
    if (!clientId) return "";
    const tokenSessionId = `token-client:${clientId}`;
    const existing = activeSessions.get(tokenSessionId);
    const client = registry.getOrCreate(
      tokenSessionId,
      (runtime.getPayload() as Record<string, unknown>).appState,
      url.searchParams.get("profileId") || "",
    );
    const now = Date.now();
    activeSessions.set(tokenSessionId, {
      sessionId: tokenSessionId,
      deviceId: null,
      pairId: null,
      profileId: client.profileId,
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
      expiresAt: null,
      idleExpiresAt: null,
    });
    return tokenSessionId;
  }

  // Slim-core detail resources — on demand, profile-authorized. Each maps a
  // domain-specific GET to a resource key; the response is
  // `{ resource, revision, data }` and is NOT slimmed (it IS the detail).
  const DETAIL_ROUTES: Record<string, (u: URL) => string | null> = {
    "/api/git/workspace-detail": (u) => {
      const id = u.searchParams.get("workspaceId");
      return id ? `git:${id}` : null;
    },
    "/api/docker/detail": () => "docker",
    "/api/azure/inbox": () => "azure-inbox",
    "/api/github/inbox": () => "github-inbox",
    "/api/azure/pull-request-detail": (u) => {
      const k = u.searchParams.get("prKey");
      return k ? `azure-pr:${k}` : null;
    },
    "/api/github/pull-request-detail": (u) => {
      const k = u.searchParams.get("prKey");
      return k ? `github-pr:${k}` : null;
    },
    "/api/review-bridge/pull-request": (u) => {
      const k = u.searchParams.get("prKey");
      return k ? `review-bridge:${k}` : null;
    },
    "/api/review-bridge/agent-prompts": () => "agent-prompts",
  };

  // Slot-aware create/activate endpoints — mirror the new workspace into
  // the bound desktop slot so the frontend selector (slot-first) follows.
  // handleApiRequest doesn't have apiSessionId in scope, so we intercept
  // here. See runtime-azure-handlers.openAzurePullRequest for the flicker
  // this prevents.
  // File-manager routes run under the caller's profile: the roots a `rootPath` may name are
  // those of the profile's own workspaces (fm.withCallerProfile). The dispatch below refuses
  // a caller with no bound session before any handler runs, so a profile is always known here.
  //
  // `op` names the operation for the mobile audit trail: a mobile session's content-touching
  // operations (MOBILE_AUDITED_FILE_OPS) are recorded as `session.file` rows — the path the client
  // named, never a byte of content. Pure listings (list, tree, info, git-status, git-refs) are not.
  const fileRoute =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (op: string, run: (body: any) => Promise<unknown>) => (body: any, windowId: string) => {
      const clientSessionId = parseRemoteViewerId(windowId);
      const profileId = clientSessionId ? registry.get(clientSessionId)?.profileId : undefined;
      if (!profileId) throw new ClientRequestError("File access requires a session bound to a profile.");
      const auditedSession = clientSessionId ? activeSessions.get(clientSessionId) : undefined;
      const describe = auditedSession?.deviceId ? MOBILE_AUDITED_FILE_OPS[op] : undefined;
      const auditFile = (status: "success" | "failure"): void => {
        if (!describe) return;
        let detail: string;
        try {
          detail = `op=${op} root=${auditDetailValue(body?.rootPath)} ${describe(body ?? {}, auditDetailValue)}`;
        } catch {
          detail = `op=${op}`;
        }
        recordMobileSessionAudit(auditedSession, "session.file", status, detail);
      };
      return fm
        .withCallerProfile(profileId, () => run(body))
        .then(
          (result) => {
            auditFile("success");
            return result;
          },
          (error: unknown) => {
            auditFile("failure");
            // A root outside the caller's profile is a refusal (403), not a server fault.
            if (error instanceof Error && error.message.startsWith("Root path not allowed")) {
              throw new ClientRequestError(error.message, 403);
            }
            throw error;
          },
        );
    };

  const slotAwareRoute: Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (body: any, windowId: string) => Promise<unknown>
  > = {
    "/api/azure/pull-request/open": (body, windowId) => runtime.openAzurePullRequest(body, windowId),
    "/api/github/pull-request/open": (body, windowId) => runtime.openGitHubPullRequest(body, windowId),
    // Per-PR review mutations post externally-visible side effects (a comment
    // on the PR, a resolved thread, a cast vote). Route them through the
    // viewer path so the runtime rejects a PR outside the caller's profile —
    // otherwise a remote client bound to profile B could act on a profile-A PR.
    "/api/azure/pull-request/comment": (body, windowId) => runtime.commentAzurePullRequest(body, windowId),
    "/api/azure/pull-request/thread-status": (body, windowId) => runtime.updateAzureThreadStatus(body, windowId),
    "/api/azure/pull-request/vote": (body, windowId) => runtime.voteAzurePullRequest(body, windowId),
    // Marking a PR seen mutates the tracked-PR store (clears the "new
    // activity" badge). Viewerless it let a client on profile B silence
    // profile-A PR badges; route it through the viewer path so the runtime
    // rejects a cross-profile prKey. Same for the GitHub PR mutations below.
    "/api/azure/pull-request/seen": (body, windowId) => runtime.markAzurePullRequestSeen(body.prKey, windowId),
    "/api/github/pull-request/seen": (body, windowId) => runtime.markGitHubPullRequestSeen(body.prKey, windowId),
    "/api/github/pull-request/comment": (body, windowId) => runtime.commentGitHubPullRequest(body, windowId),
    "/api/github/pull-request/review": (body, windowId) => runtime.submitGitHubPullRequestReview(body, windowId),
    // Re-running a CI check queues an external pipeline run against the PR —
    // another cross-profile-visible side effect, so refuse a foreign prKey.
    "/api/azure/rerun-check": (body, windowId) => runtime.rerunAzureCheck(body.prKey, body.checkItem, windowId),
    "/api/github/rerun-check": (body, windowId) => runtime.rerunGitHubCheck(body.prKey, body.checkItem, windowId),
    // The Refresh button's git-mutating half (fast-forward the review
    // checkout onto the PR's latest source commit). Unlike the plain
    // fetch/rebase/push review-workspace routes above (flat API_ROUTES,
    // unguarded — a pre-existing gap), this one is new and routed through
    // slotAwareRoute so the runtime can refuse a workspace outside the
    // caller's profile.
    "/api/azure/workspace/sync": (body, windowId) =>
      runtime.syncAzureReviewWorkspace(
        validateIpc(workspaceIdSchema, body.workspaceId, "POST /api/azure/workspace/sync"),
        windowId,
      ),
    "/api/github/workspace/sync": (body, windowId) =>
      runtime.syncGitHubReviewWorkspace(
        validateIpc(workspaceIdSchema, body.workspaceId, "POST /api/github/workspace/sync"),
        windowId,
      ),
    // Sync publishes queued draft comments to the PR provider — an
    // externally visible side effect that must refuse cross-profile prKeys.
    "/api/review-bridge/pull-request/sync": (body, windowId) => runtime.syncReviewBridgePullRequest(body, windowId),
    // File manager. Routed here so the call knows WHO is asking: the roots a path may
    // live under are narrowed to the caller's profile (see fileRoute), where the flat
    // API_ROUTES table gave every bound session every workspace's roots. The writes are
    // refused for a mobile session by the route gate before they get here.
    "/api/file/list": fileRoute("list", (body) =>
      fm.listDirectory(body.rootPath as string, body.relativePath as string),
    ),
    "/api/file/tree": fileRoute("tree", (body) =>
      fm.getDirectoryTree(body.rootPath as string, body.relativePath as string),
    ),
    "/api/file/preview": fileRoute("preview", (body) =>
      fm.readFilePreview(body.rootPath as string, body.relativePath as string),
    ),
    "/api/file/read": fileRoute("read", (body) =>
      fm.readFileContent(body.rootPath as string, body.relativePath as string),
    ),
    "/api/file/write": fileRoute("write", (body) =>
      fm.writeFileContent(body.rootPath as string, body.relativePath as string, body.content as string),
    ),
    "/api/file/create-file": fileRoute("create-file", (body) =>
      fm.createFile(body.rootPath as string, body.parentPath as string, body.name as string),
    ),
    "/api/file/create-dir": fileRoute("create-dir", (body) =>
      fm.createDirectory(body.rootPath as string, body.parentPath as string, body.name as string),
    ),
    "/api/file/rename": fileRoute("rename", (body) =>
      fm.renameEntry(body.rootPath as string, body.relativePath as string, body.newName as string),
    ),
    "/api/file/delete": fileRoute("delete", (body) =>
      fm.deleteEntry(body.rootPath as string, body.relativePath as string),
    ),
    "/api/file/git-ignore": fileRoute("git-ignore", (body) =>
      fm.addToGitignore(body.rootPath as string, body.relativePath as string, body.isDirectory === true),
    ),
    "/api/file/move": fileRoute("move", (body) =>
      fm.moveEntry(body.rootPath as string, body.fromPath as string, body.toPath as string),
    ),
    "/api/file/copy": fileRoute("copy", (body) =>
      fm.copyEntry(body.rootPath as string, body.fromPath as string, body.toPath as string),
    ),
    "/api/file/info": fileRoute("info", (body) => fm.getFileInfo(body.rootPath as string, body.relativePath as string)),
    "/api/file/git-status": fileRoute("git-status", (body) =>
      fm.getGitFileStatus(body.rootPath as string, { includeIgnored: !!body.includeIgnored }),
    ),
    "/api/file/git-refs": fileRoute("git-refs", (body) =>
      fm.getGitRefs(body.rootPath as string, (body.relativePath as string) || ""),
    ),
    "/api/file/git-diff": fileRoute("git-diff", (body) =>
      fm.computeFileDiff(body.rootPath as string, body.relativePath as string, {
        source: (body.source as string) || "head",
        revisionRef: (body.revisionRef as string) || "",
      }),
    ),
    "/api/file/commit-files": fileRoute("commit-files", (body) =>
      fm.getCommitFiles(body.rootPath as string, body.hash as string),
    ),
    "/api/file/commit-diff": fileRoute("commit-diff", (body) =>
      fm.computeCommitFileDiff(body.rootPath as string, body.relativePath as string, body.hash as string),
    ),
    // A recovery decision resumes or resets a supervised task and, when it
    // succeeds, stamps `lastWorkedAt`. Both need the caller's viewer id: the
    // dialog can list candidates from more than one profile, so the target is
    // taken from the authoritative candidate and the stamp is credited in the
    // deciding viewer's context (V5 review, Fáze 1).
    "/api/task-recovery/resolve": (body, windowId) => runtime.resolveTaskRecovery(body.decisions, windowId),
    "/api/azure/quickfix/create": (body, windowId) => runtime.azureQuickFixCreate(body, windowId),
    "/api/github/quickfix/create": (body, windowId) => runtime.githubQuickFixCreate(body, windowId),
    "/api/task/create": (body, windowId) => runtime.createTaskWorkspace(body, windowId),
    "/api/git/create-worktree": (body, windowId) => runtime.createWorktree(body, windowId),
    // saveWorkspace can change profileId or overwrite an existing
    // workspace; without slot-aware routing a remote on profile B
    // could create entries in profile A or hijack profile-A workspaces.
    "/api/workspace/save": (body, windowId) => runtime.saveWorkspace(body.workspace || body.project, windowId),
    "/api/project/save": (body, windowId) => runtime.saveWorkspace(body.workspace || body.project, windowId),
    "/api/workspace/set-ui-state": (body, windowId) =>
      runtime.setWorkspaceUIState(body.workspaceId, body.uiState, windowId),
    // Task lifecycle ops drive the runner against the workspace's cwd
    // (edits TASK.md, signals PTY, etc). Cross-profile must refuse.
    "/api/task/start": (body, windowId) => runtime.startTask(body.workspaceId, windowId),
    "/api/task/stop": (body, windowId) => Promise.resolve(runtime.stopTask(body.workspaceId, windowId)),
    "/api/task/pause": (body, windowId) => Promise.resolve(runtime.pauseTask(body.workspaceId, windowId)),
    "/api/task/resume": (body, windowId) => Promise.resolve(runtime.resumeTask(body.workspaceId, windowId)),
    "/api/task/reset": (body, windowId) => runtime.resetTask(body.workspaceId, windowId),
    "/api/task/update-description": (body, windowId) => {
      const parsed = validateIpc(taskUpdateDescriptionSchema, body, "POST /api/task/update-description");
      return runtime.updateTaskDescription(parsed.workspaceId, parsed.description, windowId);
    },
    // Companion loop (attached mode) — validated explicitly here (unlike the
    // legacy /api/task/create gap noted above) since remote/mobile clients
    // are the least-trusted caller for a new create channel.
    "/api/task/create-companion": (body, windowId) => {
      const parsed = validateIpc(taskCompanionCreateSchema, body, "POST /api/task/create-companion");
      return runtime.createCompanionTask(parsed, windowId);
    },
    "/api/task/answer-companion": (body, windowId) => {
      const parsed = validateIpc(taskCompanionAnswerSchema, body, "POST /api/task/answer-companion");
      return runtime.answerCompanionTask(parsed.workspaceId, parsed.questionIds, parsed.answer, windowId);
    },
    // Activation also moves slot.activeWorkspaceId for the bound slot
    // (legacy activateWorkspace mirrors to windowSlots[0]) — must be
    // refused when the target lives in another profile.
    "/api/workspace/activate": (body, windowId) =>
      runtime.activateWorkspace((body.workspaceId || body.projectId) as string, windowId),
    "/api/project/activate": (body, windowId) =>
      runtime.activateWorkspace((body.workspaceId || body.projectId) as string, windowId),
    // Delete is irreversible — cross-profile delete is data loss in
    // another profile.
    "/api/workspace/delete": (body, windowId) => {
      const wsId = validateIpc(
        workspaceIdSchema,
        body.workspaceId || body.projectId,
        "remote-slot:workspace/delete.workspaceId",
      );
      const opts = validateIpc(
        workspaceDeleteOptionsSchema,
        { deleteFromDisk: body.deleteFromDisk, diskPath: body.diskPath },
        "remote-slot:workspace/delete.options",
      );
      return runtime.deleteWorkspace(wsId, opts, windowId);
    },
    "/api/project/delete": (body, windowId) => {
      const wsId = validateIpc(
        workspaceIdSchema,
        body.workspaceId || body.projectId,
        "remote-slot:project/delete.workspaceId",
      );
      const opts = validateIpc(
        workspaceDeleteOptionsSchema,
        { deleteFromDisk: body.deleteFromDisk, diskPath: body.diskPath },
        "remote-slot:project/delete.options",
      );
      return runtime.deleteWorkspace(wsId, opts, windowId);
    },
    // Connection save/delete pins connection.profileId to the bound
    // window's profile; without slot-aware routing a remote on profile
    // B that omits profileId silently lands the connection in
    // windowSlots[0]'s profile (typically "default").
    "/api/azure/save-connection": (body, windowId) => runtime.saveAzureConnection(body.connection || body, windowId),
    "/api/azure/delete-connection": (body, windowId) =>
      runtime.deleteAzureConnection(body.connectionId || body.id || "", windowId),
    "/api/telegram/verify-connection": (body, windowId) =>
      runtime.verifyTelegramConnection(body.connection || {}, windowId),
    "/api/telegram/detect-chats": (body, windowId) => runtime.detectTelegramChats(body.connection || {}, windowId),
    "/api/telegram/save-connection": async (body, windowId) => {
      const result = await runtime.saveTelegramConnection(body.connection || {}, windowId);
      return result.payload;
    },
    "/api/github/save-connection": (body, windowId) => runtime.saveGitHubConnection(body.connection || body, windowId),
    "/api/github/delete-connection": (body, windowId) =>
      runtime.deleteGitHubConnection(body.connectionId || body.id || "", windowId),
    // Activation in window slot — same cross-profile rules as workspace.
    "/api/session/activate-in-window": (body, windowId) => runtime.activateSessionInWindow(body.sessionId, windowId),
    // Take over the per-session input lease ("Take control?" confirm).
    "/api/session/take-control": (body, windowId) =>
      Promise.resolve(runtime.takeSessionControl(String(body.sessionId || ""), windowId)),
    // Reorder must be slot-aware: the runtime's profile-safe branch only
    // activates when windowId is supplied. Without it, the legacy global
    // branch replaces the entire workspaces array with the caller's IDs
    // and silently drops every workspace in other profiles.
    "/api/workspace/reorder": (body, windowId) =>
      runtime.reorderWorkspaces((body.workspaceIds || body.projectIds || []) as string[], windowId),
    "/api/project/reorder": (body, windowId) =>
      runtime.reorderWorkspaces((body.workspaceIds || body.projectIds || []) as string[], windowId),
    // Review-bridge handlers can publish comments to the PR provider
    // (pushAndPublishReview) and push to the git remote — both
    // externally visible side effects that must refuse cross-profile.
    "/api/review-bridge/draft-comment/create": (body, windowId) =>
      runtime.createReviewBridgeDraftComment(body, windowId),
    "/api/review-bridge/draft/save": (body, windowId) => runtime.saveReviewBridgeDraft(body, windowId),
    "/api/review-bridge/draft/queue": (body, windowId) => runtime.queueReviewBridgeDraft(body, windowId),
    "/api/review-bridge/draft/delete": (body, windowId) => runtime.deleteReviewBridgeDraft(body, windowId),
    "/api/review-bridge/comment/delete": (body, windowId) => runtime.deleteReviewBridgeComment(body, windowId),
    "/api/review-bridge/comment/reply-with-changes": (body, windowId) => runtime.replyWithCodeChanges(body, windowId),
    "/api/review-bridge/pull-request/push-and-publish": (body, windowId) =>
      runtime.pushAndPublishReview(body, windowId),
    // Git ops all mutate state in a workspace's cwd (and gitFetch/Push/Pull
    // touch external remotes). Routing them through slotAwareRoute pins
    // each request to the caller's bound profile so a remote/mobile
    // client can't drive git on a workspace they don't see.
    "/api/git/fetch": (body, windowId) => runtime.gitFetch(body, windowId),
    "/api/git/pull": (body, windowId) => runtime.gitPull(body, windowId),
    "/api/git/push": (body, windowId) => runtime.gitPush(body, windowId),
    "/api/git/checkout-branch": (body, windowId) => runtime.gitCheckoutBranch(body, windowId),
    "/api/git/create-branch": (body, windowId) => runtime.gitCreateBranch(body, windowId),
    "/api/git/merge-into-current": (body, windowId) => runtime.gitMergeIntoCurrent(body, windowId),
    "/api/git/rebase-onto": (body, windowId) => runtime.gitRebaseOnto(body, windowId),
    // Cherry-pick / squash rewrite history in the workspace's cwd —
    // validate like the IPC path (hash regex blocks option injection).
    "/api/git/cherry-pick": (body, windowId) =>
      runtime.gitCherryPick(validateIpc(gitCherryPickSchema, body, "POST /api/git/cherry-pick"), windowId),
    "/api/git/squash-commits": (body, windowId) =>
      runtime.gitSquashCommits(validateIpc(gitSquashSchema, body, "POST /api/git/squash-commits"), windowId),
    "/api/git/continue": (body, windowId) => runtime.gitContinueOperation(body, windowId),
    "/api/git/abort": (body, windowId) => runtime.gitAbortOperation(body, windowId),
    "/api/git/diff-preview": (body, windowId) => runtime.gitDiffPreview(body, windowId),
    "/api/git/compare-branch": (body, windowId) => runtime.gitCompareBranch(body, windowId),
    "/api/git/merge-into-base": (body, windowId) => runtime.gitMergeCurrentIntoBase(body, windowId),
    "/api/git/remove-worktree": (body, windowId) => runtime.gitRemoveWorktree(body, windowId),
    "/api/git/commit-all": (body, windowId) =>
      runtime.gitCommitAll(validateIpc(gitCommitSchema, body, "POST /api/git/commit-all"), windowId),
    // Validate the same way the Electron IPC handlers do (ipc.ts) and the
    // branch routes below: this slot-aware map is the LIVE remote path for
    // stash ops (it intercepts before handleApiRequest), so without these
    // the `stash@{N}` ref regex and the 64 MiB import cap would never run
    // on the remote/mobile transport.
    "/api/git/stash": (body, windowId) =>
      runtime.gitStash(validateIpc(gitPayloadSchema, body, "POST /api/git/stash"), windowId),
    "/api/git/stash-pop": (body, windowId) =>
      runtime.gitStashPop(validateIpc(gitPayloadSchema, body, "POST /api/git/stash-pop"), windowId),
    // Stash detail/lifecycle ops are slot-aware too: write actions mutate
    // the workspace's working tree, and even the read actions expose file
    // content, so both must refuse cross-profile workspace IDs.
    "/api/git/stash-list": (body, windowId) =>
      runtime.gitListStashes(validateIpc(gitStashListSchema, body, "POST /api/git/stash-list"), windowId),
    "/api/git/stash-files": (body, windowId) =>
      runtime.gitStashFiles(validateIpc(gitStashFilesSchema, body, "POST /api/git/stash-files"), windowId),
    "/api/git/stash-file-diff": (body, windowId) =>
      runtime.gitStashFileDiff(validateIpc(gitStashFileDiffSchema, body, "POST /api/git/stash-file-diff"), windowId),
    "/api/git/stash-apply": (body, windowId) =>
      runtime.gitStashApply(validateIpc(gitStashApplySchema, body, "POST /api/git/stash-apply"), windowId),
    "/api/git/stash-drop": (body, windowId) =>
      runtime.gitStashDrop(validateIpc(gitStashDropSchema, body, "POST /api/git/stash-drop"), windowId),
    "/api/git/stash-branch": (body, windowId) =>
      runtime.gitStashBranch(validateIpc(gitStashBranchSchema, body, "POST /api/git/stash-branch"), windowId),
    "/api/git/stash-export": (body, windowId) =>
      runtime.gitStashExport(validateIpc(gitStashExportSchema, body, "POST /api/git/stash-export"), windowId),
    "/api/git/stash-import": (body, windowId) =>
      runtime.gitStashImport(validateIpc(gitStashImportSchema, body, "POST /api/git/stash-import"), windowId),
    "/api/git/commit-diff": (body, windowId) => runtime.gitCommitDiff(body, windowId),
    "/api/git/commit-info": (body, windowId) => runtime.gitCommitInfo(body, windowId),
    "/api/git/log-page": (body, windowId) => runtime.gitLogPage(body, windowId),
    "/api/git/list-tags": (body, windowId) => runtime.gitListTags(body, windowId),
    "/api/git/create-tag": (body, windowId) => runtime.gitCreateTag(body, windowId),
    "/api/git/delete-tag": (body, windowId) => runtime.gitDeleteTag(body, windowId),
    "/api/git/push-tag": (body, windowId) => runtime.gitPushTag(body, windowId),
    "/api/git/push-all-tags": (body, windowId) => runtime.gitPushAllTags(body, windowId),
    "/api/git/delete-remote-tag": (body, windowId) => runtime.gitDeleteRemoteTag(body, windowId),
    "/api/git/force-push-with-lease": (body, windowId) => runtime.gitForcePushWithLease(body, windowId),
    "/api/git/list-branches": (body, windowId) =>
      runtime.gitListBranches(validateIpc(gitBranchListSchema, body, "POST /api/git/list-branches"), windowId),
    "/api/git/delete-branch": (body, windowId) =>
      runtime.gitDeleteBranch(validateIpc(gitBranchDeleteSchema, body, "POST /api/git/delete-branch"), windowId),
    "/api/git/delete-remote-branch": (body, windowId) =>
      runtime.gitDeleteRemoteBranch(
        validateIpc(gitRemoteBranchDeleteSchema, body, "POST /api/git/delete-remote-branch"),
        windowId,
      ),
    "/api/git/rename-branch": (body, windowId) =>
      runtime.gitRenameBranch(validateIpc(gitBranchRenameSchema, body, "POST /api/git/rename-branch"), windowId),
    "/api/git/checkout-remote-branch": (body, windowId) =>
      runtime.gitCheckoutRemoteBranch(
        validateIpc(gitCheckoutRemoteSchema, body, "POST /api/git/checkout-remote-branch"),
        windowId,
      ),
    "/api/git/log-graph": (body, windowId) =>
      runtime.gitLogGraph(validateIpc(gitLogGraphSchema, body, "POST /api/git/log-graph"), windowId),
    // Conflict-resolution ops mutate / read a workspace's working tree
    // (skip a commit, list/read conflicted files, stage/unstage a
    // resolution), so — like every other git op above — they must be pinned
    // to the caller's bound profile. Without slot-aware routing they fell
    // through to handleApiRequest with no windowId, and resolveGitWorkspace
    // then fell back to windowSlots[0]'s profile, letting a remote client on
    // profile B drive conflict resolution on a workspace in profile A. Same
    // gitPayloadSchema the IPC handlers validate with (ipc.ts).
    "/api/git/skip": (body, windowId) =>
      runtime.gitSkipCommit(validateIpc(gitPayloadSchema, body, "POST /api/git/skip"), windowId),
    "/api/git/list-conflicts": (body, windowId) =>
      runtime.gitListConflicts(validateIpc(gitPayloadSchema, body, "POST /api/git/list-conflicts"), windowId),
    "/api/git/conflict-detail": (body, windowId) =>
      runtime.gitConflictDetail(validateIpc(gitPayloadSchema, body, "POST /api/git/conflict-detail"), windowId),
    "/api/git/resolve-conflict": (body, windowId) =>
      runtime.gitResolveConflict(validateIpc(gitPayloadSchema, body, "POST /api/git/resolve-conflict"), windowId),
    "/api/git/unresolve-conflict": (body, windowId) =>
      runtime.gitUnresolveConflict(validateIpc(gitPayloadSchema, body, "POST /api/git/unresolve-conflict"), windowId),
    // Grid mutations resolve their target profile from windowId. Without
    // the slot-aware path a mobile client bound to profile B would mutate
    // profile A's grid (runtime falls back to windowSlots[0] when no
    // windowId is supplied — see resolveWorkspaceGridProfile).
    "/api/workspace-grid/enable": (body, windowId) => {
      const parsed = validateIpc(workspaceGridEnableSchema, body, "POST /api/workspace-grid/enable");
      return runtime.enableWorkspaceGrid(parsed.layout, parsed.workspaceIds, windowId);
    },
    "/api/workspace-grid/disable": (_body, windowId) => runtime.disableWorkspaceGrid(windowId),
    "/api/workspace-grid/set-layout": (body, windowId) => {
      const parsed = validateIpc(workspaceGridSetLayoutSchema, body, "POST /api/workspace-grid/set-layout");
      return runtime.setGridLayout(parsed.layout, windowId);
    },
    "/api/workspace-grid/set-cell": (body, windowId) => {
      const parsed = validateIpc(workspaceGridSetCellSchema, body, "POST /api/workspace-grid/set-cell");
      return runtime.setGridCell(parsed.cellIndex, parsed.workspaceId, windowId);
    },
    "/api/workspace-grid/swap-cells": (body, windowId) => {
      const parsed = validateIpc(workspaceGridSwapCellsSchema, body, "POST /api/workspace-grid/swap-cells");
      return runtime.swapGridCells(parsed.a, parsed.b, windowId);
    },
    // "Clear all" must stay scoped to the caller's profile — otherwise
    // a Clear from profile B's window would wipe attention alerts on
    // workspaces in profile A (and silence the bell on every other
    // open window). Slot-aware routing supplies the bound windowId,
    // and runtime.clearAllAttention resolves the profile from it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "/api/attention/clear-all": (_body, windowId) => (runtime as any).clearAllAttention(windowId),
    // Same reasoning as clear-all: clear-session deletes a workspace's
    // alert entry by sessionId — without scoping, a remote client on
    // profile B could clear alerts on a workspace in profile A by
    // submitting any sessionId. The runtime cross-checks the resolved
    // profile against the workspace's profileId and refuses mismatches.
    "/api/attention/clear-session": (body, windowId) =>
      runtime.clearAlertForSession(String(body?.sessionId || ""), {
        dismissed: body?.dismissed === true,
        windowId,
      }),
    // Sync surfaces "user is currently looking at these tabs" and after
    // ATTENTION_MIN_DISPLAY_MS turns visible sessions into cleared
    // alerts. Without scoping, profile B could mark profile A's
    // sessions visible and silently clear their bells.
    "/api/attention/sync": (body, windowId) =>
      runtime.syncAttentionContext({
        visibleSessionIds: Array.isArray(body?.visibleSessionIds) ? body.visibleSessionIds : [],
        windowFocused: body?.windowFocused !== false,
        windowId,
      }),
  };

  const server = http.createServer((request, response) => {
    void handleHttpRequest(request, response);
  });

  // http.createServer's listener type is (req, res) => void — Node itself
  // never awaits it, so an async listener passed directly is a floating
  // promise (a synchronous throw before the first await would be an
  // unhandled rejection with the client left hanging). Named + wrapped in
  // try/catch here instead, matching how every route handler further down
  // (handleApiRequest, the slot-aware dispatch) already guards its own body.
  /**
   * Judge one POST from a mobile session. Returns null when it may proceed, or
   * the refusal to answer with. The body is read through the per-request cache,
   * so the route that runs afterwards still sees it.
   */
  async function evaluateMobileSessionRequest(
    request: IncomingMessage,
    sessionId: string,
    pathname: string,
  ): Promise<{ status: number; error: string; reason: string; detail?: string } | null> {
    if (classifyMobileRoute(pathname) === "own-check") return null;
    let body: Record<string, unknown>;
    try {
      body = await readRequestBody(request);
    } catch (err) {
      return { status: 400, error: (err as Error).message || "invalid request body", reason: "invalid-body" };
    }
    const profileId = registry.get(sessionId)?.profileId || activeSessions.get(sessionId)?.profileId || "";
    if (!profileId) {
      return { status: 403, error: "Not available to a mobile session", reason: "session-has-no-profile" };
    }
    const decision = evaluateMobileRoute({
      pathname,
      body,
      profileId,
      workspaceProfile: (workspaceId) => cachedWorkspaceProfiles.get(workspaceId),
      connectionProfile: (connectionId) => {
        const integrations = ((runtime.getPayload() as { appState?: { settings?: { integrations?: unknown } } })
          ?.appState?.settings?.integrations || {}) as Record<string, { connections?: Array<Record<string, unknown>> }>;
        const all = [...(integrations.azureDevops?.connections || []), ...(integrations.github?.connections || [])];
        const found = all.find((c) => c.id === connectionId);
        return found ? String(found.profileId || "default") : undefined;
      },
    });
    if (decision.allow) return null;
    return {
      status: 403,
      error: "Not available to a mobile session",
      reason: decision.reason,
      ...(decision.detail ? { detail: decision.detail } : {}),
    };
  }

  async function handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      // The relay origin answers only its own connector. This runs before routing, before the
      // session lookup and before the unauthenticated bootstrap route, so no part of this server is
      // reachable from another local process that merely learned the port.
      if (isLoopbackOrigin && !relayGuardPassed(request.headers)) {
        audit.warn("relay origin request rejected", {
          surface: "http",
          routeCategory: "pre-routing",
          statusCode: 403,
          reason: "loopback-guard",
        });
        writeHead(response, 403, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }
      const requestUrl = request.url || "/";
      const url = new URL(requestUrl, "http://localhost");
      const isApiRoute = url.pathname.startsWith("/api/");

      // Unauthenticated-by-design (the ticket itself is the auth) — must be
      // handled before the generic isAuthorized() gate below, which would
      // otherwise 401 it since it carries no token/cookie. See plan §9.2.
      if (request.method === "POST" && url.pathname === "/api/mobile/session/bootstrap") {
        await handleMobileSessionBootstrap(request, response);
        return;
      }

      if (isApiRoute && !isAuthorized(requestUrl, request.headers)) {
        writeHead(response, 401, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Unauthorized");
        // WHY it was rejected, not just that it was. Three booleans separate three very different
        // failures that all look like this line: a client that sent no credential at all, one whose
        // session cookie names a session this server does not have (restarted, or swept), and one
        // whose session exists but has run out of time. Diagnosing a mobile viewer that authenticated
        // successfully and then got 401 on every call took a packet-level guess without them.
        const rejectedCookie = getSessionFromRequest(request.headers);
        audit.warn("api request rejected", {
          method: request.method,
          path: url.pathname,
          statusCode: 401,
          remoteAddress: request.socket?.remoteAddress,
          hasCookie: Boolean(rejectedCookie),
          cookieKnown: Boolean(rejectedCookie && activeSessions.has(rejectedCookie)),
          hasToken: Boolean(getTokenFromRequest(requestUrl, request.headers)),
        });
        return;
      }

      if (isApiRoute) {
        const startedAt = Date.now();
        const remoteAddress = request.socket?.remoteAddress;
        response.on("finish", () => {
          audit.info("api request", {
            method: request.method,
            path: url.pathname,
            statusCode: response.statusCode,
            durationMs: Date.now() - startedAt,
            remoteAddress,
          });
        });

        // Bump TTL and get session for per-client endpoints.
        const apiSessionId = sessionIdForRequest(requestUrl, request.headers);
        if (apiSessionId && activeSessions.has(apiSessionId)) {
          registry.bumpLastSeen(apiSessionId);
          const sessionRecord = activeSessions.get(apiSessionId);
          if (sessionRecord) sessionRecord.lastSeenAt = Date.now();
        }

        // Attach the remote-response context ONCE. From here every json() writer —
        // in the intercepts below AND in handleApiRequest — composes the response
        // per-client and (for a protocol-2 client) slims it to the RemoteStateV2
        // core. This is the single adapter the plan requires: no per-route
        // compose calls, and no runtime method can leak a raw desktop StatePayload.
        // The old /api/state, azure|github/refresh and pull-request/seen intercepts
        // existed only to compose those payloads; the adapter now does it uniformly,
        // so they are gone.
        // A mobile session is ALWAYS served the profile-scoped v2 core with the full
        // capability set, whatever the client advertised: protocol 1 answers with the
        // whole composed appState (every profile's workspaces), and a capability list
        // without `remote-core-v2` falls back to it. Only the profile scoping in
        // buildRemoteCore keeps another profile's state off the phone.
        const apiIsMobile = Boolean(apiSessionId && activeSessions.get(apiSessionId)?.deviceId);
        const httpProtocol = apiIsMobile ? REMOTE_STATE_PROTOCOL : requestProtocol(requestUrl, request.headers);
        // Response contract for a v2 client (see adaptRemoteResponse):
        //  - A route whose renderer handler ADOPTS the response (bootstrap,
        //    navigation: save / activate / reorder / settings / create-worktree /
        //    profile) delivers the full slim v2 core — the ~10 KiB "targeted
        //    result" the client applies synchronously (some inside a suppressed-
        //    broadcast window, so it cannot wait for the async push).
        //  - A route whose renderer handler DISCARDS the response (the frequent
        //    refresh buttons + provider / review-bridge domain mutations, which are
        //    a no-op on the remote transport) returns a small `{ ok, revision }`
        //    ack — never serializing / transferring a core "after every button
        //    click" — and the authoritative core rides the WS broadcast.
        // Default is core: a misrouted core is harmless (adopted), a misrouted ack
        // would wipe the client's state, so only PROVABLY-discarded routes ack.
        const deliversCore = !(request.method === "POST" && ACK_MUTATION_ROUTES.has(url.pathname));
        (response as ResponseWithCtx).__remoteCtx = {
          protocol: httpProtocol,
          capabilities: selectCapabilities(
            apiIsMobile ? [] : requestCapabilities(requestUrl, request.headers),
            httpProtocol,
          ),
          coreRevision,
          deliverCore: deliversCore,
          sessionId: apiSessionId,
          registry,
          route: url.pathname,
          method: request.method,
          acceptEncoding: Array.isArray(request.headers["accept-encoding"])
            ? request.headers["accept-encoding"][0]
            : request.headers["accept-encoding"],
          ifNoneMatch: Array.isArray(request.headers["if-none-match"])
            ? request.headers["if-none-match"][0]
            : request.headers["if-none-match"],
          stripShareUrls: isLoopbackOrigin || apiIsMobile,
          noStore: isLoopbackOrigin || apiIsMobile,
        };

        if (request.method === "POST" && url.pathname === "/api/mobile/attachments") {
          const session = apiSessionId ? activeSessions.get(apiSessionId) : undefined;
          if (!session?.deviceId || !session.pairId) {
            json(response, 401, { error: "No active mobile session" });
            return;
          }
          let body: Record<string, unknown>;
          try {
            body = validateIpc(
              mobileAttachmentEnvelopeSchema,
              await readRequestBody(request),
              "POST /api/mobile/attachments",
            );
            json(
              response,
              200,
              await handleMobileAttachmentRequest(
                runtime,
                session,
                session.profileId || registry.get(apiSessionId)?.profileId || "",
                body,
              ),
            );
          } catch (error) {
            json(response, 403, { error: (error as Error).message || "Attachment request refused" });
          }
          return;
        }

        if (
          request.method === "POST" &&
          (url.pathname === "/api/attachment/list" || url.pathname === "/api/attachment/delete")
        ) {
          const session = apiSessionId ? activeSessions.get(apiSessionId) : undefined;
          const profileId = apiSessionId ? session?.profileId || registry.get(apiSessionId)?.profileId || "" : "";
          if (
            !apiSessionId ||
            (session?.deviceId && !runtime.isMobileSessionStillAuthorized?.(session.deviceId, profileId))
          ) {
            json(response, 401, { error: "No authorized mobile session" });
            return;
          }
          try {
            const body = await readRequestBody(request);
            const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
            const root = resolveAttachmentRoot(runtime, workspaceId, profileId);
            if (url.pathname === "/api/attachment/list") {
              json(response, 200, await attachments.listWithUsage(root));
            } else {
              const transferId = typeof body.transferId === "string" ? body.transferId : "";
              const name = typeof body.name === "string" ? body.name : "";
              json(response, 200, await attachments.remove(root, transferId, name));
            }
          } catch (error) {
            json(response, 400, { error: (error as Error).message || "Attachment request refused" });
          }
          return;
        }

        // THE MOBILE ROUTE GATE — the one place a mobile session's HTTP call is
        // judged, before the slot-aware dispatch and before API_ROUTES. See
        // mobile-session-route-policy.ts for what it refuses and why.
        if (request.method === "POST" && apiSessionId && activeSessions.get(apiSessionId)?.deviceId) {
          const refusal = await evaluateMobileSessionRequest(request, apiSessionId, url.pathname);
          if (refusal) {
            audit.warn("mobile route denied", {
              sessionRef: remoteSessionRef(apiSessionId),
              path: url.pathname,
              reason: refusal.reason,
              detail: refusal.detail,
            });
            json(response, refusal.status, { error: refusal.error, reason: refusal.reason });
            return;
          }
        }

        const detailRoute = request.method === "GET" ? DETAIL_ROUTES[url.pathname] : undefined;
        if (detailRoute) {
          const resourceKey = detailRoute(url);
          if (!resourceKey || !isKnownResourceKey(resourceKey)) {
            json(response, 400, { error: "Missing or invalid resource id" });
            return;
          }
          const rawPayload = runtime.getPayload() as Record<string, unknown>;
          // A detail request is ALWAYS profile-scoped: the session's profile, or —
          // for an unbound caller — the server's default profile. Never null (which
          // resourceProfileAuthorized now denies), so an unbound client is confined
          // to one profile's resources rather than authorized for everything.
          const boundProfile = apiSessionId ? registry.get(apiSessionId)?.profileId : undefined;
          const profileId = boundProfile ?? registry.resolveFallbackProfileId(rawPayload.appState) ?? null;
          if (!resourceProfileAuthorized(rawPayload, profileId, resourceKey)) {
            json(response, 403, { error: "Resource is not in your active profile" });
            return;
          }
          const detail = buildResourceDetail(rawPayload, profileId, resourceKey);
          if (!detail) {
            json(response, 404, { error: "Resource not available yet" });
            return;
          }
          json(response, 200, detail);
          return;
        }

        // Remote-client-scoped activation endpoints — derive clientId from cookie or token client id.
        if (url.pathname.startsWith("/api/remote-client/")) {
          if (!apiSessionId || !activeSessions.has(apiSessionId)) {
            json(response, 401, { error: "No active session" });
            return;
          }
          let body: Record<string, unknown>;
          try {
            body = await readRequestBody(request);
          } catch (err) {
            json(response, 400, { error: (err as Error).message || "invalid request body" });
            return;
          }
          try {
            // Diagnostic for the mobile workspace flip-flop: compare this sessionRef
            // against the one logged at "WebSocket session resolution" — if HTTP
            // activations and the WS socket resolve to DIFFERENT sessionRefs for the
            // same client, the active-workspace selection is split across two registry
            // contexts (HTTP writes one, WS broadcasts read the other).
            log.debug("remote-client activation request", {
              method: request.method,
              path: url.pathname,
              sessionRef: remoteSessionRef(apiSessionId),
            });
            // The remote client is an independent viewer: activation mutates
            // ONLY its own RemoteClientContext (profile/workspace/session) and
            // never touches a desktop windowSlot. The runtime methods spawn
            // PTYs for the newly viewed workspace and broadcast state — every
            // socket gets a per-client composed payload with its own view.
            if (request.method === "POST" && url.pathname === "/api/remote-client/profile/activate") {
              const profileId = String(body.profileId ?? "");
              const mobileSession = activeSessions.get(apiSessionId);
              if (
                mobileSession?.deviceId &&
                !runtime.isMobileSessionStillAuthorized?.(mobileSession.deviceId, profileId)
              ) {
                json(response, 403, { error: "This phone cannot access that profile" });
                return;
              }
              await runtime.activateProfileForRemoteClient(apiSessionId, profileId);
              if (mobileSession?.deviceId) mobileSession.profileId = profileId;
            } else if (request.method === "POST" && url.pathname === "/api/remote-client/workspace/activate") {
              await runtime.activateWorkspaceForRemoteClient(apiSessionId, String(body.workspaceId ?? ""));
            } else if (request.method === "POST" && url.pathname === "/api/remote-client/session/activate") {
              await runtime.activateSessionForRemoteClient(
                apiSessionId,
                String(body.workspaceId ?? ""),
                String(body.sessionId ?? ""),
              );
            } else {
              json(response, 404, { error: "Not found" });
              return;
            }
            // The central adapter (attached __remoteCtx) composes per-client and
            // slims to the v2 core; just hand it the raw payload.
            json(response, 200, runtime.getPayload());
          } catch (err) {
            json(response, 400, { error: (err as Error).message || "Activation failed" });
          }
          return;
        }

        const slotAwareHandler = request.method === "POST" ? slotAwareRoute[url.pathname] : undefined;
        if (slotAwareHandler) {
          let body: Record<string, unknown>;
          try {
            body = await readRequestBody(request);
          } catch (err) {
            json(response, 400, { error: (err as Error).message || "invalid request body" });
            return;
          }
          // Let the response adapter's mutation ack name the resources this route
          // changed (from prKey/workspaceId in the body).
          const slotAckCtx = (response as ResponseWithCtx).__remoteCtx;
          if (slotAckCtx) slotAckCtx.body = body as Record<string, unknown>;
          // Viewer-aware routes mutate state in the context of the caller's
          // profile. The remote client IS the viewer: pass its viewer id
          // (`remote:<sessionId>`) — the runtime resolves the profile through
          // the registry, so these operations work even when the client's
          // profile is not open in any desktop window, and per-viewer
          // mutations (grid, activation mirror) land on the remote context
          // instead of a desktop slot. A token-only caller that skipped the
          // session/client-id binding must NOT get to mutate.
          const viewerId = apiSessionId && registry.get(apiSessionId) ? remoteViewerId(apiSessionId) : "";
          if (!viewerId) {
            json(response, 400, {
              error:
                "Slot-aware operation requires a bound session — include the strideterm cookie or X-Strideterm-Client-Id header so the server can resolve which profile to act on.",
            });
            return;
          }
          try {
            json(response, 200, await slotAwareHandler(body, viewerId));
          } catch (err) {
            const msg = (err as Error).message || "Slot operation failed";
            const statusCode = refusalStatus(err, msg);
            json(response, statusCode, { error: msg });
          }
          return;
        }

        await handleApiRequest(
          runtime,
          request,
          response,
          broadcast,
          (apiSessionId && registry.get(apiSessionId)?.profileId) || "",
          Boolean(apiSessionId && activeSessions.get(apiSessionId)?.deviceId),
          apiSessionId,
        );
        return;
      }

      // First-hit bootstrap: a freshly-shared QR/URL arrives as
      // `GET /?token=<master>`. Validate the token, mint a fresh session,
      // and 302 the browser to a clean URL. Net effect: the master token
      // appears in network logs / browser history exactly once (the
      // initial HTTP request) and never again — the cookie carries every
      // subsequent request, including the WebSocket upgrade.
      if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
        if (!tokensEqual(url.searchParams.get("token") || "", token)) {
          writeHead(response, 401, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Unauthorized");
          return;
        }
        const sessionId = mintSession(url.searchParams.get("profileId") || "");
        writeHead(response, 302, {
          "Set-Cookie": `${SESSION_COOKIE_NAME}=${sessionId}; ${buildSessionCookieAttrs(request.headers)}`,
          Location: "/",
        });
        response.end();
        return;
      }

      // Static asset fetches don't gate on auth (they're harmless JS/CSS
      // bundles served to any LAN peer who guesses the URL), but the
      // renderer's API + WS calls do. Keeping static open avoids a
      // brittle dependency on every asset path also having auth headers.
      await serveStatic(staticRoot, requestUrl, request.headers, response);
    } catch (err) {
      log.error("unhandled HTTP request error", { err: (err as Error)?.message || String(err) });
      if (!response.headersSent) {
        try {
          writeHead(response, 500, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Internal server error");
        } catch {
          // response is in a bad state (socket gone, etc.) — nothing more we can do
        }
      }
    }
  }

  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<import("ws").WebSocket>();
  // Maps each WS socket to its cookie session ID so per-client payloads can
  // be composed on every state:updated event.
  const socketSession = new WeakMap<import("ws").WebSocket, string>();
  // Sockets we've already debug-logged a raw (uncomposed) broadcast for, so the
  // diagnostic below fires at most once per socket instead of once per broadcast.
  const rawBroadcastLogged = new WeakSet<import("ws").WebSocket>();

  /**
   * Closes every open WebSocket tagged with `sessionId` (plan §9.2/§10.6 device revoke, and now also
   * the session deadlines).
   *
   * The reason travels to the client so the app can tell "you were revoked" from "your session ran
   * out" — the first is final, the second is something a fresh ticket fixes.
   */
  function closeSessionSockets(sessionId: string, reason = "device revoked"): void {
    for (const ws of sockets) {
      if (socketSession.get(ws) === sessionId) {
        try {
          ws.close(1008, reason);
        } catch {
          // already closing/closed
        }
      }
    }
  }

  /**
   * Called when a mobile device is revoked (MobileManager.revokeDevice, via
   * runtime.setMobileRemoteSessionRevoker below): removes every session this
   * device bootstrapped so the next request bearing its cookie is treated as
   * unauthenticated, and closes any of its open WebSocket(s).
   */
  function revokeMobileSessionsForDevice(deviceId: string): void {
    let ended = false;
    for (const [sessionId, record] of activeSessions) {
      if (record.deviceId === deviceId) {
        activeSessions.delete(sessionId);
        auditMobileSessionEnded(record, "revoked");
        closeSessionSockets(sessionId);
        audit.info("mobile device revoked: session closed", { sessionRef: remoteSessionRef(sessionId) });
        ended = true;
      }
    }
    if (ended) publishMobileSessions();
  }
  if (!isLoopbackOrigin) runtime.setMobileRemoteSessionRevoker?.(revokeMobileSessionsForDevice);

  // Minimal in-memory rate limiter scoped to the mobile ticket-bootstrap
  // route only (no general rate-limiting middleware exists elsewhere in this
  // file to reuse). The route is unauthenticated by design — the ticket IS
  // the auth — so it must not become a brute-force oracle even though the
  // ticket secret's 256 bits already make brute force computationally
  // infeasible within the 60s TTL; this is defense in depth against request
  // flooding, not the primary defense.
  //
  // WHAT IT IS KEYED ON, AND WHY THAT CHANGED (production hardening §5 "Session" 8). On the RELAY
  // instance every request arrives from `127.0.0.1`, because the connector is the only client — so a
  // per-address bucket was ONE bucket shared by every paired phone, and one malicious device could
  // exhaust it for all of them. The relay states which device it verified in a header the desktop
  // accepts only alongside the connector's guard secret (which every request to this instance must
  // carry), so the bucket is now per device there. The LEGACY instance keeps the network principal,
  // because that is genuinely all it knows about an unauthenticated caller, plus a global ceiling so
  // a rotating source address cannot turn many small buckets into an unbounded one.
  //
  // NEITHER IS A DURABLE SECURITY BOUND, and the distinction matters (production hardening §9): both
  // live in process memory and both reset on restart. The security bound on this route is the
  // single-use 60-second ticket with a 256-bit secret; these are load shedding.
  const MOBILE_BOOTSTRAP_RATE_LIMIT_WINDOW_MS = 60_000;
  const MOBILE_BOOTSTRAP_RATE_LIMIT_MAX = 20;
  /** The whole route, across every key. Bounds a caller that varies its key to get many buckets. */
  const MOBILE_BOOTSTRAP_GLOBAL_MAX = 200;
  const mobileBootstrapAttempts = new Map<string, { count: number; windowStart: number }>();
  let mobileBootstrapGlobal = { count: 0, windowStart: 0 };

  function countedInWindow(
    entry: { count: number; windowStart: number },
    now: number,
  ): { count: number; windowStart: number } {
    if (now - entry.windowStart >= MOBILE_BOOTSTRAP_RATE_LIMIT_WINDOW_MS) return { count: 1, windowStart: now };
    return { count: entry.count + 1, windowStart: entry.windowStart };
  }

  function mobileBootstrapRateLimited(principal: string): boolean {
    const now = Date.now();
    // The global ceiling first, so a caller shopping for fresh keys is bounded even before its own
    // bucket is. Deliberately an order of magnitude above the per-key limit: it is a backstop, not
    // the limit.
    mobileBootstrapGlobal = countedInWindow(mobileBootstrapGlobal, now);
    if (mobileBootstrapGlobal.count > MOBILE_BOOTSTRAP_GLOBAL_MAX) return true;

    const key = principal || "unknown";
    const entry = mobileBootstrapAttempts.get(key);
    if (!entry) {
      // One entry per key per window, and stale ones are swept whenever the map grows past a small
      // ceiling — the map itself must not become the unbounded thing.
      if (mobileBootstrapAttempts.size > 512) {
        for (const [existingKey, existing] of mobileBootstrapAttempts) {
          if (now - existing.windowStart >= MOBILE_BOOTSTRAP_RATE_LIMIT_WINDOW_MS) {
            mobileBootstrapAttempts.delete(existingKey);
          }
        }
      }
      mobileBootstrapAttempts.set(key, { count: 1, windowStart: now });
      return false;
    }
    const next = countedInWindow(entry, now);
    mobileBootstrapAttempts.set(key, next);
    return next.count > MOBILE_BOOTSTRAP_RATE_LIMIT_MAX;
  }

  /**
   * The device the RELAY says is presenting this request, or "".
   *
   * Only ever read on a loopback-origin instance, and only because every request to that instance has
   * already passed the connector guard — so the header is the relay's statement rather than a client's
   * claim. The connector is what makes that true on BOTH paths: it passes through the Worker's own stamp
   * on a plaintext stream and sets it from the relay-stamped `d` on an e2e-wrapped one, dropping
   * whatever the inner frame (the phone's) carried. On the legacy instance it is ignored entirely:
   * nothing upstream there verifies a device, so believing the header would be believing the caller.
   */
  function relayVerifiedDeviceId(headers: IncomingMessage["headers"]): string {
    if (!isLoopbackOrigin) return "";
    const value = headers["x-strideterm-relay-device"];
    return typeof value === "string" ? value : "";
  }

  /**
   * The origins THIS server currently answers on, for the ticket's origin binding.
   *
   * The relay instance has exactly one and it was given to it by the relay manager. The legacy
   * instance's list is whatever the runtime is publishing right now, which is the point: a ticket
   * minted for a quick tunnel that has since been replaced names an origin that is no longer in the
   * list, so it stops being redeemable rather than working against the new tunnel (production
   * hardening §5 "Ticket" 4).
   */
  function ticketRedemptionContext(): { transport: "relay" | "legacy"; origins: string[] } {
    if (isLoopbackOrigin) return { transport: "relay", origins: [loopbackOrigin.publicOrigin] };
    // The authoritative list, from the runtime. Falling back to the bound URLs keeps an older host
    // (or a test double) working rather than refusing every ticket.
    const urls = runtime.listMobileTicketOrigins?.() ?? runtime.listRemoteUrls?.() ?? [];
    const origins = new Set<string>();
    for (const url of urls) {
      try {
        origins.add(new URL(url).origin);
      } catch {
        // A malformed entry cannot match a normalized origin anyway; skipping it is the same answer.
      }
    }
    return { transport: "legacy", origins: [...origins] };
  }

  /**
   * `POST /api/mobile/session/bootstrap` (plan §9.2 steps 5-6): unauthenticated
   * but ticket-authenticated exchange of a single-use WebView session ticket
   * for the same HttpOnly session cookie the `?token=` bootstrap mints below.
   * Never trusts profile/capabilities/deviceId from the request body — only
   * from the consumed ticket record (plan §10.6).
   */
  async function handleMobileSessionBootstrap(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const remoteAddress = request.socket?.remoteAddress || "";
    const relayDeviceId = relayVerifiedDeviceId(request.headers);
    // A ticket redeemed on the relay instance was presented by SOME device the relay verified, and the
    // connector says which. A request with no device header did not come through that path intact, so
    // it is refused rather than treated as a caller with no identity: skipping the ticket↔device
    // binding and pooling every phone into one rate-limit bucket is the failure this closes.
    if (isLoopbackOrigin && !relayDeviceId) {
      audit.warn("mobile session bootstrap rejected: relay did not name the presenting device", { remoteAddress });
      writeHead(response, 401, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Unauthorized");
      return;
    }
    // On the relay instance the principal is the device the relay verified; on the legacy one it is
    // the network address, which is all there is.
    if (mobileBootstrapRateLimited(relayDeviceId ? `device:${relayDeviceId}` : `addr:${remoteAddress}`)) {
      audit.warn("mobile session bootstrap rate-limited", { remoteAddress });
      writeHead(response, 429, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Too Many Requests");
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readRequestBody(request);
    } catch {
      audit.warn("mobile session bootstrap rejected", {
        routeCategory: "mobile-session-bootstrap",
        statusCode: 400,
        reason: "body-read",
      });
      writeHead(response, 400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Bad Request");
      return;
    }

    let parsed: { ticketId: string; secret: string };
    try {
      parsed = validateIpc(mobileSessionBootstrapSchema, body, "POST /api/mobile/session/bootstrap");
    } catch {
      audit.warn("mobile session bootstrap rejected", {
        routeCategory: "mobile-session-bootstrap",
        statusCode: 400,
        reason: "invalid-schema",
      });
      writeHead(response, 400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Bad Request");
      return;
    }

    const ticket =
      runtime.consumeMobileWebSessionTicket?.(parsed.ticketId, parsed.secret, ticketRedemptionContext()) ?? null;
    if (!ticket) {
      // Generic failure — don't disclose unknown vs. expired vs. wrong secret vs. wrong server vs. an
      // origin this server no longer answers on. The store spends the ticket in the cases where the
      // secret was right, so none of them is a retryable probe.
      audit.warn("mobile session bootstrap rejected", { remoteAddress });
      writeHead(response, 401, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Unauthorized");
      return;
    }
    // AND THE PRESENTER HAS TO BE THE DEVICE THE TICKET NAMES, when the relay is in a position to say
    // who is presenting it. Without this, a viewer session belonging to device A could redeem a ticket
    // minted for device B if it ever obtained one — the ticket is single-use and short-lived, but "who
    // is holding it" is a check the relay can make for free and the desktop cannot make otherwise.
    if (relayDeviceId && relayDeviceId !== ticket.deviceId) {
      audit.warn("mobile session bootstrap rejected: relay device does not match the ticket", { remoteAddress });
      writeHead(response, 401, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Unauthorized");
      return;
    }

    const sessionId = mintMobileSession(ticket);
    recordMobileSessionAudit(
      activeSessions.get(sessionId),
      "session.started",
      "success",
      `profile=${ticket.profileId} transport=${ticket.transport}`,
    );
    audit.info("mobile session bootstrap succeeded", { remoteAddress, sessionRef: remoteSessionRef(sessionId) });
    writeHead(response, 302, {
      "Set-Cookie": `${SESSION_COOKIE_NAME}=${sessionId}; ${buildSessionCookieAttrs(request.headers)}`,
      Location: "/",
    });
    response.end();
  }

  // Per-socket terminal-stream routing + backpressure state.
  //  - mode: "legacy" until the client sends its first terminal:subscribe, then
  //    "filtered". A legacy socket (e.g. a page loaded before this rollout)
  //    keeps receiving the full terminal broadcast so it never blanks out.
  //  - sessions: the filtered client's subscribed terminal session ids.
  //  - congested: once tripped, every send to this socket is suppressed while
  //    the 1013 close handshake drains (the "whole-socket gate").
  type SocketRouting = {
    mode: "legacy" | "filtered";
    sessions: Set<string>;
    congested: boolean;
    closeTimer: ReturnType<typeof setTimeout> | null;
    /**
     * Bytes of replay frames still queued on this socket. Replay is a bounded,
     * expected burst — it must not make the next live frame trip the bound, or a
     * reconnect into a grid becomes a 1013 loop. Maintained precisely: bumped
     * when a replay is enqueued and decremented by that replay's send-drain
     * callback when it flushes, so it only ever counts replay actually in the
     * queue — never already-drained replay or any live/state byte.
     */
    exemptBytes: number;
    /**
     * Client session id resolved at subscribe time, used to re-validate profile
     * access on every routed frame (a profile switch must stop old-profile
     * sessions immediately). Same identity subscribe authz used, so the two can
     * never disagree.
     */
    clientSessionId: string;
    /**
     * Latest-wins coalescer for this socket's state:updated frames. Created on
     * the first state send. Keeps at most one state frame in flight and one
     * newest pending, so a mutation burst never queues N historical snapshots.
     */
    stateCoalescer: ReturnType<typeof makeStateCoalescer> | null;
    /**
     * When the live backlog first crossed SOCKET_STALL_THRESHOLD_BYTES without
     * since draining below it, or null while healthy. Drives socketStallDecision
     * in the periodic sweep — the socket is closed only if this timestamp ages
     * past the grace window with no drain progress.
     */
    backlogSince: number | null;
    /**
     * When the live backlog FIRST crossed the watermark, and unlike backlogSince
     * NOT reset when it shrinks — so the telemetry can record total end-to-end
     * time-to-drain (first-crossing → cleared), not just the final drain step.
     * backlogSince drives the stall/close grace (must reset on progress);
     * backlogEnteredAt drives the drain-time metric (must not). Null while healthy.
     */
    backlogEnteredAt: number | null;
    /** Previous live-backlog sample, so the sweep can detect drain progress. */
    lastLiveBacklog: number;
    /**
     * Detail resources this socket has declared interest in (mounted panes /
     * visible grid cells), analogous to the terminal subscription set. Only
     * known + profile-authorized keys are stored; recomputed on every
     * resource:interest message and resent by the client on reconnect.
     */
    interests: Set<string>;
    /**
     * Last revision token pushed to this socket per interested resource, so a
     * state:updated only emits a resource:invalidate when the resource actually
     * changed (no pointless refetch of an unchanged detail).
     */
    sentRevisions: Map<string, string>;
  };
  const socketRouting = new WeakMap<import("ws").WebSocket, SocketRouting>();
  // Maps each WS socket to its advertised state-protocol version (2 for a slim
  // client, 1/absent for a legacy tab that must keep receiving full payloads).
  const socketProtocol = new WeakMap<import("ws").WebSocket, number>();
  // Maps each WS socket to its negotiated capability set (see selectCapabilities).
  const socketCapabilities = new WeakMap<import("ws").WebSocket, string[]>();
  // Monotonic revision bumped once per state:updated broadcast and stamped onto
  // every core (HTTP bootstrap + WS). The client applies a snapshot only when its
  // revision is newer than the last one it applied, so the post-bootstrap WS
  // stream provably delivers only newer state (bootstrap→WS handoff).
  let coreRevision = 0;
  // Upper bound on resource-interest keys one message may carry — a defence
  // against a buggy/hostile client, sized well above any real visible grid.
  const MAX_INTERESTS = 128;

  // Test-only: how many times a congestion close-timer actually fired terminate().
  // A graceful close must clearTimeout the armed timer, so this stays 0 for a
  // client that acks the 1013 in time — lets a test prove the timer was cleared,
  // which the routing snapshot alone cannot (routing is gone the moment it closes).
  let congestionTerminateCount = 0;

  // Diagnostics only — frame sizes, coalescing counts, backlog high-water and
  // drain times. Never a hard pass/fail limit (see the backpressure policy in
  // plan-remote-payload-slim.md). Logged periodically and on close.
  const telemetry = createRemoteTelemetry();

  // Cheap workspace→profile map for per-frame authz re-checks in
  // routeTerminalFrame (rebuilt on every state:updated, not per frame — getPayload
  // is a deep clone). A remote client that switches profile must stop receiving
  // its old profile's sessions immediately, before the renderer resubscribes.
  let cachedWorkspaceProfiles = new Map<string, string>();
  function rebuildWorkspaceProfiles(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appState = ((runtime.getPayload() as any)?.appState || {}) as any;
    cachedWorkspaceProfiles = new Map<string, string>(
      ((appState.workspaces as { id?: string; profileId?: string }[]) || [])
        .filter((ws) => ws?.id)
        .map((ws) => [String(ws.id), String(ws.profileId || "default")]),
    );
  }
  rebuildWorkspaceProfiles();

  function routingFor(socket: import("ws").WebSocket): SocketRouting {
    let routing = socketRouting.get(socket);
    if (!routing) {
      routing = {
        mode: "legacy",
        sessions: new Set(),
        congested: false,
        closeTimer: null,
        exemptBytes: 0,
        clientSessionId: "",
        stateCoalescer: null,
        backlogSince: null,
        backlogEnteredAt: null,
        lastLiveBacklog: 0,
        interests: new Set(),
        sentRevisions: new Map(),
      };
      socketRouting.set(socket, routing);
    }
    return routing;
  }

  /**
   * Mark a socket congested and start a bounded close→terminate sequence. Once
   * congested, checkedSend suppresses ALL further sends to it, so queued memory
   * can actually drain instead of being re-grown by state/docker/ssh messages.
   */
  function markCongested(socket: import("ws").WebSocket, bufferedBytes: number, frameBytes: number): void {
    const routing = routingFor(socket);
    if (routing.congested) return;
    routing.congested = true;
    log.warn("WebSocket backpressure limit exceeded — closing client", {
      sessionRef: remoteSessionRef(socketSession.get(socket) || ""),
      bufferedBytes,
      frameBytes,
      subscriptions: routing.sessions.size,
    });
    try {
      socket.close(1013, "backpressure");
    } catch {
      // already closing/closed
    }
    routing.closeTimer = setTimeout(() => {
      congestionTerminateCount++;
      try {
        socket.terminate();
      } catch {
        // noop
      }
    }, congestionCloseGraceMs);
    routing.closeTimer.unref?.();
  }

  /**
   * Single checked send for every outbound WS message. Respects the congestion
   * gate and skips non-open sockets. A FILTERED socket is bounded on EVERY
   * non-replay send (terminal, state:updated, docker, ssh) — any of them can push
   * it into congestion, so the queue is bounded across all message types.
   * LEGACY (pre-rollout) sockets are never tripped: they have no resubscribe/
   * replay path to heal a 1013-induced gap, so unbounded-but-eventually-delivered
   * is the lesser evil (dead sockets are still reaped by the heartbeat).
   * Replay (`exempt: true`) is excluded from the bound — a bounded one-shot
   * payload per session — and its bytes are credited as exempt only while they
   * sit in the queue: the send-drain callback uncredits them the moment they
   * flush, so a later live frame is measured against the real backlog.
   */
  function checkedSend(socket: import("ws").WebSocket, data: string, opts?: { exempt?: boolean }): void {
    if (socket.readyState !== socket.OPEN) return;
    const routing = socketRouting.get(socket);
    if (routing?.congested) return;
    const bytes = Buffer.byteLength(data);
    if (routing?.mode === "filtered" && !opts?.exempt) {
      const buffered = socketBufferedAmount(socket);
      telemetry.recordFrame(bytes);
      telemetry.recordBacklog(Math.max(0, buffered - (routing.exemptBytes || 0)));
      // Memory-safety ceiling ONLY, evaluated on the existing backlog — a single
      // large frame is never treated as congestion (that was the 2.4.11 loop).
      // A genuinely stalled socket is caught by the time-based stall sweep.
      const decision = terminalBackpressureDecision(routing.exemptBytes || 0, buffered, SOCKET_HARD_CEILING_BYTES);
      if (decision.trip) {
        markCongested(socket, buffered, bytes);
        return;
      }
    }
    if (opts?.exempt && routing) {
      routing.exemptBytes += bytes;
      socket.send(data, () => {
        routing.exemptBytes = Math.max(0, routing.exemptBytes - bytes);
      });
    } else {
      socket.send(data);
    }
  }

  /**
   * Send a state:updated frame through the socket's latest-wins coalescer:
   * exactly one state frame in flight per socket, and if more state arrives
   * while it is sending, only the newest is kept and sent next. This is the
   * primary protection against a mutation burst queuing obsolete snapshots.
   * Unlike ordered streams (terminal/docker/ssh) state has no ordering to
   * preserve — only the latest revision matters.
   */
  function sendStateFrame(socket: import("ws").WebSocket, msg: string): void {
    if (socket.readyState !== socket.OPEN) return;
    const routing = routingFor(socket);
    if (routing.congested) return;
    if (!routing.stateCoalescer) {
      routing.stateCoalescer = makeStateCoalescer((data, onDrain) => {
        // The socket may have congested/closed between enqueue and this
        // dispatch; drop silently (the coalescer dies with the socket).
        if (socket.readyState !== socket.OPEN || routing.congested) return;
        const frameBytes = Buffer.byteLength(data);
        const buffered = socketBufferedAmount(socket);
        telemetry.recordFrame(frameBytes);
        telemetry.recordBacklog(Math.max(0, buffered - (routing.exemptBytes || 0)));
        if (routing.mode === "filtered") {
          const decision = terminalBackpressureDecision(routing.exemptBytes || 0, buffered, SOCKET_HARD_CEILING_BYTES);
          if (decision.trip) {
            markCongested(socket, buffered, frameBytes);
            return;
          }
        }
        socket.send(data, () => {
          telemetry.recordStateSent();
          onDrain();
        });
      });
    }
    telemetry.recordStateProduced();
    if (routing.stateCoalescer.enqueue(msg) === "coalesced") telemetry.recordStateCoalesced();
  }

  /**
   * Send ONE catch-up state:updated frame to a single socket, composed + slimmed
   * for its protocol/capabilities/session. Used by the WS open handoff (stale
   * `?rev=`) and the `state:sync` message (first-connect [bootstrap, open] gap).
   */
  async function sendCoreCatchUp(socket: import("ws").WebSocket, wsSessionId: string): Promise<void> {
    // Both call sites either fire this without awaiting (the state:sync
    // message handler) or await it from an async callback with no enclosing
    // try/catch (the connection handler) — a rejection from getInitialState()
    // (git/docker refreshes can throw) would otherwise be an unhandled
    // rejection, and the client would silently never receive its catch-up
    // core with no log tying the failure to this socket.
    try {
      const baseInitial = await runtime.getInitialState();
      if (socket.readyState !== socket.OPEN) return;
      const socketProto = socketProtocol.get(socket) || 1;
      const payload = adaptRemoteResponse(baseInitial, {
        protocol: socketProto,
        capabilities: socketCapabilities.get(socket) ?? selectCapabilities(null, socketProto),
        coreRevision,
        deliverCore: true, // a catch-up frame IS a core push, not a mutation ack
        sessionId: wsSessionId || "",
        registry,
        stripShareUrls: isLoopbackOrigin || Boolean(wsSessionId && activeSessions.get(wsSessionId)?.deviceId),
      });
      sendStateFrame(socket, JSON.stringify({ type: "state:updated", payload }));
    } catch (err) {
      log.warn("WebSocket catch-up failed", {
        sessionRef: remoteSessionRef(wsSessionId),
        err: (err as Error)?.message || String(err),
      });
    }
  }

  function broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const socket of sockets) checkedSend(socket, payload);
  }

  /**
   * Route a live terminal frame (`terminal:data` or `terminal:exit`). Legacy
   * sockets get every frame AND are never tripped by the backpressure bound — a
   * pre-rollout page has no subscribe/replay mechanism to heal a 1013-induced
   * gap, so for it the old unbounded-but-eventually-delivered behaviour is the
   * lesser evil (dead sockets are still reaped by the heartbeat). Filtered
   * sockets get only their subscribed sessions and are subject to the bound;
   * they heal via resubscribe + replay after a 1013.
   *
   * `terminal:exit` is filtered exactly like data: the runtime folds the exit
   * notice into replay for an unexpected exit (see runtime.ts), so a hidden pane
   * still sees "[process exited]" when it later subscribes and replays. A
   * separate broadcast would only duplicate that, and would leak exit metadata
   * (plus grow a renderer buffer) on sockets that don't render the session.
   */
  function routeTerminalFrame(type: "terminal:data" | "terminal:exit", payload: unknown): void {
    const sessionId = String((payload as { sessionId?: unknown })?.sessionId || "");
    if (isDesktopPrivateSshSession(runtime, sessionId)) return;
    const serialized = JSON.stringify({ type, payload });
    for (const socket of sockets) {
      const routing = socketRouting.get(socket);
      if (routing?.mode === "filtered") {
        if (!routing.sessions.has(sessionId)) continue;
        // Re-validate on every frame against the CURRENT profile binding: if the
        // client switched profile, its old sessions must stop immediately even
        // if the resubscribe is delayed, lost, or rejected. Drop the stale
        // subscription so it can't route again until a fresh subscribe re-adds it.
        const client = routing.clientSessionId ? registry.get(routing.clientSessionId) : undefined;
        if (!canAccessTerminalSession(client, cachedWorkspaceProfiles, sessionId)) {
          routing.sessions.delete(sessionId);
          continue;
        }
        checkedSend(socket, serialized);
      } else {
        checkedSend(socket, serialized);
      }
    }
  }

  /**
   * Whether a WS client may stream a terminal session, given a workspace→
   * profile map computed ONCE per subscribe request (runtime.getPayload() is a
   * deep state clone — never call it per session id). Mirrors the profile/
   * workspace binding used by per-client state composition: a composed client
   * may only reach sessions whose workspace is in its active profile; an
   * uncomposed/token socket sees the raw (unfiltered) state and so may reach
   * any session.
   */
  function canAccessTerminalSession(
    client: { profileId: string } | undefined,
    workspaceProfiles: Map<string, string>,
    terminalSessionId: string,
  ): boolean {
    const workspaceId = terminalSessionId.split(":")[0];
    if (!workspaceId) return false;
    const profileId = workspaceProfiles.get(workspaceId);
    if (profileId === undefined) return false;
    if (!client) return true; // uncomposed socket sees raw state → all workspaces
    return profileId === client.profileId;
  }

  /**
   * Whether a WS client may WRITE to a terminal session: the same profile binding
   * a subscribe is held to, applied to keystrokes and resizes. A socket that is
   * bound (cookie session, or a token client that sent a client id) may only reach
   * sessions of its own profile; an unbound socket (master token, no client id, so
   * no registry record) keeps reaching every session, exactly as it does for reads.
   * Reading the session from the registry per message is a map lookup — the
   * workspace→profile map is the cached one, never a getPayload() per keystroke.
   */
  function viewerMayTouchTerminal(clientSessionId: string, terminalSessionId: string): boolean {
    const client = clientSessionId ? registry.get(clientSessionId) : undefined;
    return canAccessTerminalSession(client, cachedWorkspaceProfiles, terminalSessionId);
  }

  /**
   * Handle a terminal:subscribe. The client sends its COMPLETE desired set.
   *
   * Ordering invariant (see plan v2): after validation there is NO `await`
   * between snapshotting a session's replay and adding it to the live set, so a
   * live frame emitted synchronously right after can never slip in ahead of the
   * replay or fall into a gap. Validation/authz happens BEFORE that section.
   */
  function handleTerminalSubscribe(
    socket: import("ws").WebSocket,
    clientSessionId: string,
    requestedRaw: string[],
  ): void {
    // A well-formed subscribe means a capable client → filtered mode, even if
    // the request is ultimately rejected, so it never falls back to broadcast.
    const routing = routingFor(socket);
    routing.mode = "filtered";
    // Remember the resolved client identity so routeTerminalFrame can re-validate
    // profile access per frame with the SAME identity used for subscribe authz.
    routing.clientSessionId = clientSessionId;

    const requested = Array.from(new Set(requestedRaw));
    // Over the cap → reject the WHOLE request rather than silently subscribing to
    // a truncated 64-id subset (a partial set is exactly what the plan forbids).
    // The cap sits well above any real visible grid, so this only fires for a
    // buggy/hostile client.
    if (requested.length > MAX_SUBSCRIBED_SESSIONS) {
      log.warn("WebSocket terminal subscribe rejected: over id cap", {
        sessionRef: remoteSessionRef(clientSessionId),
        requested: requested.length,
        cap: MAX_SUBSCRIBED_SESSIONS,
      });
      return;
    }

    // One payload snapshot per request (deep clone — see canAccessTerminalSession).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appState = ((runtime.getPayload() as any)?.appState || {}) as any;
    const workspaceProfiles = new Map<string, string>(
      ((appState.workspaces as { id?: string; profileId?: string }[]) || [])
        .filter((ws) => ws?.id)
        .map((ws) => [String(ws.id), String(ws.profileId || "default")]),
    );
    // Set of session ids that map to a currently-existing panel. A removed
    // panel's session id must be rejected so a client can't re-request (and be
    // re-served) the stale replay of a pane that no longer exists.
    const validSessionIds = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const ws of (appState.workspaces as any[]) || []) {
      if (!ws?.id) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const panel of (ws.panels as any[]) || []) {
        if (panel?.id) validSessionIds.add(`${ws.id}:${panel.id}`);
      }
    }
    const client = clientSessionId ? registry.get(clientSessionId) : undefined;

    // Reject the WHOLE request if any id is inaccessible OR names a non-existent
    // panel; keep the prior set so a partial/ambiguous subscription is never
    // applied.
    for (const id of requested) {
      if (!validSessionIds.has(id) || !canAccessTerminalSession(client, workspaceProfiles, id)) {
        log.warn("WebSocket terminal subscribe rejected: inaccessible or unknown session", {
          sessionRef: remoteSessionRef(clientSessionId),
        });
        return;
      }
    }

    // --- critical section: no await between snapshot and set-add ---
    const nextSet = new Set(requested);
    for (const id of nextSet) {
      if (routing.sessions.has(id)) continue; // already subscribed — don't re-replay
      const snapshot = runtime.getTerminalReplaySnapshot(id);
      checkedSend(
        socket,
        JSON.stringify({
          type: "terminal:replay",
          payload: { sessionId: id, data: snapshot.data, throughSeq: snapshot.throughSeq },
        }),
        // Replay bytes are excluded from the backpressure bound the next live
        // frame is checked against — see SocketRouting.exemptBytes.
        { exempt: true },
      );
    }
    routing.sessions = nextSet;
  }

  /**
   * Handle a resource:interest message. The client sends its COMPLETE set of
   * mounted/visible detail-resource keys (git panes, docker pane, inbox/review
   * panes across every visible grid cell). We keep only the keys that are known
   * AND authorized for the client's profile, then push an immediate
   * resource:invalidate for each NEWLY-interested key so the client fetches it.
   * Ongoing changes are pushed from the state:updated loop. Dropped resources
   * stop receiving invalidations. Mirrors terminal:subscribe (idempotent,
   * client resends on reconnect).
   */
  function handleResourceInterest(
    socket: import("ws").WebSocket,
    clientSessionId: string,
    requestedRaw: string[],
  ): void {
    const routing = routingFor(socket);
    const requested = Array.from(new Set(requestedRaw));
    if (requested.length > MAX_INTERESTS) {
      log.warn("WebSocket resource interest rejected: over cap", {
        sessionRef: remoteSessionRef(clientSessionId),
        requested: requested.length,
        cap: MAX_INTERESTS,
      });
      return;
    }
    const raw = runtime.getPayload() as Record<string, unknown>;
    const profileId = clientSessionId ? (registry.get(clientSessionId)?.profileId ?? null) : null;
    const next = new Set<string>();
    for (const key of requested) {
      if (!isKnownResourceKey(key)) continue;
      if (!resourceProfileAuthorized(raw, profileId, key)) continue;
      next.add(key);
    }
    // Forget revisions for resources no longer of interest.
    for (const key of [...routing.sentRevisions.keys()]) {
      if (!next.has(key)) routing.sentRevisions.delete(key);
    }
    // For newly-interested resources, prime the revision and push an immediate
    // invalidate so the client fetches the current detail once.
    for (const key of next) {
      if (routing.interests.has(key)) continue;
      const rev = resourceRevision(raw, key);
      routing.sentRevisions.set(key, rev);
      checkedSend(socket, JSON.stringify({ type: "resource:invalidate", payload: { resource: key, revision: rev } }));
    }
    routing.interests = next;
  }

  /**
   * After a state change, tell each socket which of its interested resources
   * actually changed (revision differs from the last one we sent it). The client
   * refetches only those — hidden resources get nothing, unchanged resources get
   * nothing. `rawPayload` is the full (unslimmed) payload so revisions read the
   * real git/provider/docker fields.
   */
  function pushResourceInvalidations(socket: import("ws").WebSocket, rawPayload: Record<string, unknown>): void {
    const routing = socketRouting.get(socket);
    if (!routing || routing.interests.size === 0) return;
    for (const key of routing.interests) {
      const rev = resourceRevision(rawPayload, key);
      if (routing.sentRevisions.get(key) === rev) continue;
      routing.sentRevisions.set(key, rev);
      checkedSend(socket, JSON.stringify({ type: "resource:invalidate", payload: { resource: key, revision: rev } }));
    }
  }

  const unsubscribe = [
    // state:updated — compose per-client (and slim to the v2 core for protocol-2
    // sockets) so each browser sees only its own profile context and no heavy
    // detail. Then push targeted resource invalidations for interested details.
    runtime.on("state:updated", (payload: unknown) => {
      // Keep the per-frame authz cache fresh: a profile switch broadcasts state,
      // so routeTerminalFrame's re-check sees the new workspace→profile binding.
      rebuildWorkspaceProfiles();
      const rawPayload = payload as Record<string, unknown>;
      // One revision per broadcast — every socket's core this frame carries the
      // same coreRevision, and the next broadcast is strictly newer.
      coreRevision += 1;
      for (const socket of sockets) {
        if (socket.readyState !== socket.OPEN) continue;
        const sessionId = socketSession.get(socket);
        if (!sessionId && !rawBroadcastLogged.has(socket)) {
          // No session bound to this socket → it receives the RAW (uncomposed)
          // payload, which forces the renderer's workspace fallback. Log once so a
          // repro shows whether the affected socket ever lost its session binding.
          rawBroadcastLogged.add(socket);
          log.debug("state:updated sent without per-client composition (socket has no session)", {
            openSockets: sockets.size,
          });
        }
        const socketProto = socketProtocol.get(socket) || 1;
        const adapted = adaptRemoteResponse(payload, {
          protocol: socketProto,
          capabilities: socketCapabilities.get(socket) ?? selectCapabilities(null, socketProto),
          coreRevision,
          deliverCore: true, // a WS state:updated frame IS the authoritative core push
          sessionId: sessionId || "",
          registry,
          stripShareUrls: isLoopbackOrigin || Boolean(sessionId && activeSessions.get(sessionId)?.deviceId),
        });
        sendStateFrame(socket, JSON.stringify({ type: "state:updated", payload: adapted }));
        // Only protocol-2 sockets fetch details; a legacy socket carries the full
        // payload and never registers interests, so this is a no-op for it.
        pushResourceInvalidations(socket, rawPayload);
      }
    }),
    runtime.on("terminal:data", (payload: unknown) => routeTerminalFrame("terminal:data", payload)),
    // terminal:exit is filtered exactly like terminal:data — the runtime folds
    // the exit notice into replay so an unsubscribed/hidden pane still sees it on
    // a later subscribe. See routeTerminalFrame.
    runtime.on("terminal:exit", (payload: unknown) => routeTerminalFrame("terminal:exit", payload)),
    // A removed panel (destroy, or a never-created failed spawn) must be pruned
    // from every socket's live set. Otherwise the id lingers subscribed: a
    // recreated same-id panel would stream live with no fresh replay, and a
    // resubscribe would skip replay because the id is still present.
    runtime.on("terminal:removed", (payload: unknown) => {
      const sessionId = String((payload as { sessionId?: unknown })?.sessionId || "");
      if (!sessionId) return;
      for (const socket of sockets) {
        const routing = socketRouting.get(socket);
        // Only touch (and notify) sockets that actually had it subscribed.
        if (!routing?.sessions.delete(sessionId)) continue;
        // Tell the client we dropped the id from its live routing set. Without
        // this the client keeps the id in its own subscription memory, so a
        // debounced remove+recreate of the SAME id computes an unchanged desired
        // set and never re-subscribes — the recreated pane's stream would stay
        // frozen. On receipt the client forgets the id and re-subscribes if it
        // still renders it (harmless if the pane is truly gone: the resubscribe
        // is rejected server-side and the next sync unsubscribes it).
        if (socket.readyState === socket.OPEN) {
          checkedSend(socket, JSON.stringify({ type: "terminal:removed", payload: { sessionId } }));
        }
      }
    }),
    // Live push progress (streamed git output, incl. pre-push hook). Broadcast
    // to all authed sockets like ssh:*/docker:* — the git state it mirrors is
    // already pushed to every client via state:updated.
    runtime.on("git:push-progress", (payload: unknown) => broadcast({ type: "git:push-progress", payload })),
    runtime.on("ssh:auth-prompt", (payload: unknown) => {
      if (!isDesktopPrivateSshSession(runtime, (payload as { sessionId?: unknown })?.sessionId))
        broadcast({ type: "ssh:auth-prompt", payload });
    }),
    runtime.on("ssh:auth-prompt-cancel", (payload: unknown) => {
      if (!isDesktopPrivateSshSession(runtime, (payload as { sessionId?: unknown })?.sessionId))
        broadcast({ type: "ssh:auth-prompt-cancel", payload });
    }),
    runtime.on("ssh:host-key-change", (payload: unknown) => {
      if (!isDesktopPrivateSshSession(runtime, (payload as { sessionId?: unknown })?.sessionId))
        broadcast({ type: "ssh:host-key-change", payload });
    }),
    runtime.on("ssh:state", (payload: unknown) => broadcast({ type: "ssh:state", payload })),
    runtime.on("ssh:connection-state", (payload: unknown) => {
      if (!isDesktopPrivateSshSession(runtime, (payload as { sessionId?: unknown })?.sessionId))
        broadcast({ type: "ssh:connection-state", payload });
    }),
    // Notification history is per-viewer, so this is deliberately NOT a
    // broadcast: a client bound to another profile never saw the removed
    // workspace and its own history must not be touched. Unauthenticated /
    // unbound sockets have no resolvable profile and are skipped.
    runtime.on(NOTIFICATION_TARGET_REMOVED_CHANNEL, (payload: unknown) => {
      const eventProfileId = String((payload as { profileId?: unknown })?.profileId || "");
      if (!eventProfileId) return;
      const serialized = JSON.stringify({ type: NOTIFICATION_TARGET_REMOVED_CHANNEL, payload });
      for (const socket of sockets) {
        const clientSessionId = socketSession.get(socket);
        if (!clientSessionId) continue;
        if (registry.get(clientSessionId)?.profileId !== eventProfileId) continue;
        checkedSend(socket, serialized);
      }
    }),
    // Profile-scoped for the same reason: a client bound to another profile
    // never saw the workspace whose agent was approved, so the entry would be
    // noise in its history.
    runtime.on(APPROVAL_RECORDED_CHANNEL, (payload: unknown) => {
      const eventProfileId = String((payload as { profileId?: unknown })?.profileId || "");
      if (!eventProfileId) return;
      const serialized = JSON.stringify({ type: APPROVAL_RECORDED_CHANNEL, payload });
      for (const socket of sockets) {
        const clientSessionId = socketSession.get(socket);
        if (!clientSessionId) continue;
        if (registry.get(clientSessionId)?.profileId !== eventProfileId) continue;
        checkedSend(socket, serialized);
      }
    }),
  ];

  server.on("upgrade", (request, socket, head) => {
    if (isLoopbackOrigin && !relayGuardPassed(request.headers)) {
      audit.warn("relay origin request rejected", {
        surface: "websocket",
        routeCategory: "pre-routing",
        statusCode: 403,
        reason: "loopback-guard",
      });
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(request.url || "/", "http://localhost");
    // WS upgrade accepts either the master token (Bearer header or
    // ?token= URL — useful for non-browser clients that don't carry
    // cookies) or the session cookie set during bootstrap. Browsers
    // attach cookies to WS upgrade requests automatically, so the
    // renderer's `new WebSocket(url)` call no longer needs the token
    // in the URL once the user has bootstrapped.
    if (url.pathname !== "/ws" || !isAuthorized(request.url || "/", request.headers)) {
      log.warn("WebSocket upgrade rejected: unauthorized", {
        path: url.pathname,
        remoteAddress: request.socket?.remoteAddress,
      });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    // CSRF guard for the WebSocket: a malicious page in the user's browser
    // could open ws://host:port/ws?token=<leaked> and (since browsers send
    // cookies/auth headers cross-origin for WS) ride the user's session.
    // Refuse upgrades whose Origin doesn't match the Host the user is
    // connecting to. Same-origin and tooling without an Origin header (curl,
    // websocat, the Electron renderer) still pass.
    const origin = (request.headers.origin || "").toString();
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const host = (request.headers.host || "").toString().toLowerCase();
        const expected =
          `${originUrl.hostname}:${originUrl.port || (originUrl.protocol === "https:" ? "443" : "80")}`.toLowerCase();
        if (host && host !== expected && host !== originUrl.hostname.toLowerCase()) {
          log.warn("WebSocket upgrade rejected: origin/host mismatch", { origin, host });
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
      } catch {
        log.warn("WebSocket upgrade rejected: malformed Origin", { origin });
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      void handleWsUpgrade(request, ws);
    });
  });

  // wss.handleUpgrade's callback type is (ws) => void — same reasoning as
  // handleHttpRequest above: an async listener passed directly is a
  // floating promise from Node's perspective. Named + wrapped in try/catch
  // so a synchronous throw anywhere in the (long) connection-setup body
  // can't become an unhandled rejection that silently drops the socket.
  async function handleWsUpgrade(request: IncomingMessage, ws: import("ws").WebSocket): Promise<void> {
    try {
      sockets.add(ws);
      // Start in legacy mode: the socket receives the full terminal broadcast
      // until it sends its first terminal:subscribe (see handleTerminalSubscribe).
      routingFor(ws);
      // Record the state-protocol the client advertised (?sp=2). Absent → 1
      // (legacy tab): it keeps receiving the full composed payload and never
      // gets slimmed, so an old open page never silently consumes the v2 shape.
      // A mobile session is always v2 with the full capability set — see the HTTP
      // equivalent (apiIsMobile) for why a client-chosen protocol 1 must not apply.
      const wsSessionId = sessionIdForRequest(request.url || "/", request.headers);
      const wsIsMobile = Boolean(wsSessionId && activeSessions.get(wsSessionId)?.deviceId);
      const wsAdvertisedProtocol = wsIsMobile
        ? REMOTE_STATE_PROTOCOL
        : requestProtocol(request.url || "/", request.headers);
      socketProtocol.set(ws, wsAdvertisedProtocol);
      // Negotiate + record capabilities (?caps=). The intersection with what the
      // server supports selects the response contract and is echoed to the client.
      const wsCapabilities = selectCapabilities(
        wsIsMobile ? [] : requestCapabilities(request.url || "/", request.headers),
        wsAdvertisedProtocol,
      );
      socketCapabilities.set(ws, wsCapabilities);
      // Tolerant heartbeat: count consecutive missed pongs instead of the
      // binary alive/dead flag. A pong on any tick resets the counter.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- missedPongs is the heartbeat counter attached to the ws instance
      (ws as any).missedPongs = 0;
      ws.on("pong", () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ws as any).missedPongs = 0;
      });
      // Tag the socket with its session so per-client state can be composed on broadcast.
      const wsComposed = Boolean(wsSessionId && activeSessions.has(wsSessionId));
      if (wsComposed) {
        socketSession.set(ws, wsSessionId);
        registry.bumpLastSeen(wsSessionId);
      }
      // Diagnostic for the mobile workspace flip-flop: `composed=false` means this
      // socket will get RAW broadcasts (no remoteClient) and the renderer will fall
      // back; `hadCookie` with a token-client sessionRef means the cookie session was
      // present but stale (e.g. after a server restart), so HTTP and WS can resolve to
      // different identities. sessionRef encodes cookie-vs-token-client + a digest.
      log.debug("WebSocket session resolution", {
        sessionRef: remoteSessionRef(wsSessionId),
        composed: wsComposed,
        hadCookie: Boolean(getSessionFromRequest(request.headers)),
      });
      log.info("WebSocket client connected", {
        remoteAddress: request.socket?.remoteAddress,
        sessionRef: remoteSessionRef(wsSessionId),
        total: sockets.size,
      });
      // NOTE: every ws.on(...) handler is registered BEFORE the awaited
      // initial-state send below. getInitialState() can take hundreds of ms
      // (git/docker refreshes); a reconnecting client sends terminal:subscribe
      // immediately in its open handler, and `ws` emits "message" with no
      // listener during that await — the subscribe would be silently dropped
      // and the socket stuck in legacy mode with no replay.
      ws.on("message", (raw: Buffer) => {
        // Every incoming message counts as activity — bump TTL.
        if (wsSessionId) registry.bumpLastSeen(wsSessionId);
        try {
          const message = JSON.parse(raw.toString()) as { type: string };
          // THE IDLE DEADLINE MOVES FOR MEANINGFUL TRAFFIC ONLY (production hardening §5 "Session" 7).
          // Typing, resizing, subscribing and asking for state are the user doing something; a
          // `state:sync` catch-up or a protocol keep-alive is the client saying its socket is open,
          // and a session that could be held open forever by a keep-alive has no idle deadline at
          // all. The absolute deadline is never moved by either — and a session already past a
          // deadline is closed HERE rather than at the next HTTP request, which for an open terminal
          // socket may be hours away.
          const meaningful =
            message.type === "terminal:input" ||
            message.type === "terminal:resize" ||
            message.type === "terminal:subscribe" ||
            message.type === "docker:shell:write" ||
            message.type === "docker:shell:resize" ||
            message.type === "resource:interest";
          if (wsSessionId && !touchMobileSession(wsSessionId, meaningful)) {
            try {
              ws.close(1008, "session expired");
            } catch {
              // Already closing.
            }
            return;
          }
          if (message.type === "terminal:input") {
            const parsed = wsTerminalInputSchema.safeParse(message);
            if (parsed.success && isDesktopPrivateSshSession(runtime, parsed.data.sessionId)) {
              log.warn("WebSocket terminal input rejected: desktop SSH test sessions are private", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            } else if (parsed.success && !viewerMayTouchTerminal(wsSessionId, parsed.data.sessionId)) {
              log.warn("WebSocket terminal input rejected: session outside caller profile", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            } else if (parsed.success) {
              log.debug("WebSocket terminal input", {
                sessionRef: remoteSessionRef(wsSessionId),
                terminalSessionId: parsed.data.sessionId,
                bytes: Buffer.byteLength(parsed.data.data || "", "utf8"),
              });
              // A mobile session's typing is audited as counts only (never the bytes). Nothing is
              // recorded for a master-token or browser session — it has no device id.
              if (wsSessionId) recordMobileTerminalInput(wsSessionId, parsed.data.sessionId, parsed.data.data || "");
              // The remote client is a viewer — its typing participates in
              // the per-session input lease like a desktop window's.
              const viewerId = wsSessionId ? remoteViewerId(wsSessionId) : undefined;
              const result = runtime.writeToSession(
                parsed.data.sessionId,
                parsed.data.data,
                viewerId,
                parsed.data.originWorkspaceId,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ) as any;
              if (result?.blocked) {
                checkedSend(
                  ws,
                  JSON.stringify({
                    type: "terminal:input-blocked",
                    sessionId: parsed.data.sessionId,
                    ownerLabel: String(result.ownerLabel || "another window"),
                  }),
                );
              }
            } else {
              log.warn("WebSocket terminal input rejected: invalid payload", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            }
          } else if (message.type === "terminal:resize") {
            const parsed = wsTerminalResizeSchema.safeParse(message);
            if (parsed.success && isDesktopPrivateSshSession(runtime, parsed.data.sessionId)) {
              log.warn("WebSocket terminal resize rejected: desktop SSH test sessions are private", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            } else if (parsed.success && !viewerMayTouchTerminal(wsSessionId, parsed.data.sessionId)) {
              log.warn("WebSocket terminal resize rejected: session outside caller profile", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            } else if (parsed.success) {
              log.debug("WebSocket terminal resize", {
                sessionRef: remoteSessionRef(wsSessionId),
                terminalSessionId: parsed.data.sessionId,
                cols: parsed.data.cols,
                rows: parsed.data.rows,
              });
              runtime.resizeSession(parsed.data.sessionId, { cols: parsed.data.cols, rows: parsed.data.rows });
            } else {
              log.warn("WebSocket terminal resize rejected: invalid payload", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            }
          } else if (message.type === "docker:shell:write") {
            const parsed = wsDockerShellWriteSchema.safeParse(message);
            if (parsed.success && wsIsMobile) {
              // A docker shell is not bound to a workspace, so there is no profile to
              // compare — and it is a shell on the host. Refused for a mobile session.
              log.warn("WebSocket docker shell write rejected: mobile session", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            } else if (parsed.success) {
              runtime.dockerShellWrite(parsed.data.sessionId, parsed.data.data);
            } else {
              log.warn("WebSocket docker shell write rejected: invalid payload", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            }
          } else if (message.type === "docker:shell:resize") {
            const parsed = wsDockerShellResizeSchema.safeParse(message);
            if (parsed.success && wsIsMobile) {
              log.warn("WebSocket docker shell resize rejected: mobile session", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            } else if (parsed.success) {
              runtime.dockerShellResize(parsed.data.sessionId, parsed.data.cols, parsed.data.rows);
            } else {
              log.warn("WebSocket docker shell resize rejected: invalid payload", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            }
          } else if (message.type === "terminal:subscribe") {
            const parsed = wsTerminalSubscribeSchema.safeParse(message);
            if (parsed.success) {
              log.debug("WebSocket terminal subscribe", {
                sessionRef: remoteSessionRef(wsSessionId),
                count: parsed.data.sessionIds.length,
              });
              handleTerminalSubscribe(ws, wsSessionId, parsed.data.sessionIds);
            } else {
              log.warn("WebSocket terminal subscribe rejected: invalid payload", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            }
          } else if (message.type === "resource:interest") {
            const parsed = wsResourceInterestSchema.safeParse(message);
            if (parsed.success) {
              log.debug("WebSocket resource interest", {
                sessionRef: remoteSessionRef(wsSessionId),
                count: parsed.data.resources.length,
              });
              handleResourceInterest(ws, wsSessionId, parsed.data.resources);
            } else {
              log.warn("WebSocket resource interest rejected: invalid payload", {
                sessionRef: remoteSessionRef(wsSessionId),
              });
            }
          } else if (message.type === "state:sync") {
            // First-connect bootstrap handoff: the very first WS URL is built
            // before the HTTP bootstrap records a revision, so it cannot carry
            // `?rev=`. The client sends its bootstrap revision here once it has
            // one; if state moved in the [bootstrap, open] window we send ONE
            // catch-up core so no update is missed. Reconnects carry `?rev=` in
            // the URL and are handled by the open handoff instead.
            const rev = Number((message as { rev?: unknown }).rev);
            if (servesRemoteCore(wsCapabilities) && Number.isFinite(rev) && rev < coreRevision) {
              log.debug("WebSocket state:sync catch-up", { sessionRef: remoteSessionRef(wsSessionId), rev });
              void sendCoreCatchUp(ws, wsSessionId);
            }
          }
        } catch (err) {
          log.warn("WebSocket message ignored: malformed JSON", {
            sessionRef: remoteSessionRef(wsSessionId),
            err: (err as Error)?.message || String(err),
          });
        }
      });

      ws.on("error", (err) => {
        log.warn("WebSocket client error", {
          sessionRef: remoteSessionRef(wsSessionId),
          err: (err as Error)?.message || String(err),
        });
      });

      ws.on("close", (code, reason) => {
        sockets.delete(ws);
        // Release routing + congestion state (and any pending terminate timer)
        // so a closed socket doesn't leak its subscription set or a live timer.
        const routing = socketRouting.get(ws);
        if (routing?.closeTimer) clearTimeout(routing.closeTimer);
        socketRouting.delete(ws);
        // If this was the LAST live socket for the session, the viewer is gone
        // — drop its visible-session contribution so its panels stop counting
        // as visible. A session can hold more than one socket (reconnect race,
        // a second tab), so only drop when none remain; otherwise a transient
        // reconnect would wrongly clear a still-watching viewer.
        if (wsSessionId) {
          let stillConnected = false;
          for (const other of sockets) {
            if (socketSession.get(other) === wsSessionId) {
              stillConnected = true;
              break;
            }
          }
          if (!stillConnected) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (runtime as any).dropViewerVisibility?.(remoteViewerId(wsSessionId));
          }
        }
        const meta = {
          sessionRef: remoteSessionRef(wsSessionId),
          code,
          reason: reason?.toString("utf8") || "",
          remaining: sockets.size,
        };
        if (code === 1000 || code === 1001) {
          log.info("WebSocket client disconnected", meta);
        } else {
          log.warn("WebSocket client disconnected unexpectedly", meta);
        }
      });

      // Bootstrap→WS handoff (plan §11). A slim (remote-core-v2) client
      // bootstraps its state over HTTP `GET /api/state` (cacheable, compressible)
      // and passes the revision it received back on the WS as `?rev=`:
      //   - rev absent  → first connect, still bootstrapping over HTTP → send
      //     nothing HERE (bootstrap-once: no redundant second full transfer). The
      //     client instead sends a `state:sync` message carrying its bootstrap
      //     revision once it has one, which catches it up on any change in the
      //     [bootstrap, WS-open] window (see the message handler) — closing the
      //     race where the first socket's URL was frozen before the revision
      //     existed;
      //   - rev present and DIFFERENT from the current coreRevision → resync with
      //     ONE catch-up core. This is the single authoritative reconnect path
      //     (the client no longer also re-fetches `/api/state`). It covers two
      //     cases: (a) rev < coreRevision — a change slipped in between bootstrap
      //     and this connect, or during a reconnect gap; (b) rev > coreRevision —
      //     the server RESTARTED and its monotonic coreRevision reset below the
      //     value this client still holds, so a `<` test would wrongly send
      //     nothing and strand the client on state from the dead process. Either
      //     way the client's revision gate drops the frame if it is not newer, and
      //     after a restart the fresh core always parses as authoritative;
      //   - rev present and equal → send nothing (a no-change reconnect transfers
      //     zero state bytes).
      // A legacy socket has no HTTP bootstrap guarantee in its old renderer, so it
      // always gets the initial composed payload. Registered LAST (see the NOTE
      // above the message handler) so the await never opens a window with no
      // message listener.
      const wsServesCore = servesRemoteCore(wsCapabilities);
      const wsBootstrapRev = requestBootstrapRevision(request.url || "/");
      const needsCatchUp = wsServesCore ? wsBootstrapRev !== null && wsBootstrapRev !== coreRevision : true;
      if (needsCatchUp) await sendCoreCatchUp(ws, wsSessionId);
    } catch (err) {
      log.error("unhandled WebSocket upgrade error", { err: (err as Error)?.message || String(err) });
      try {
        ws.close(1011, "internal error");
      } catch {
        // socket may already be gone
      }
    }
  }

  // Drop dead WebSocket clients: each tick we ping every connection and bump
  // its missed-pong counter. Pong handlers reset it. Only after
  // WS_HEARTBEAT_MAX_MISSED consecutive ticks with no pong do we terminate —
  // that handles NAT boxes silently dropping the connection (the counter
  // climbs) without punishing real clients for a single 20s network blip.
  // Without this, a leaked-token attacker reusing an idle channel would
  // never be evicted by token regeneration alone.
  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const missed = (ws as any).missedPongs ?? 0;
      if (missed >= wsHeartbeatMaxMissed) {
        log.warn("WebSocket heartbeat timeout — terminating client", {
          sessionRef: remoteSessionRef(socketSession.get(ws) || ""),
          missedPongs: missed,
          remaining: Math.max(0, sockets.size - 1),
        });
        sockets.delete(ws);
        ws.terminate();
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ws as any).missedPongs = missed + 1;
      try {
        ws.ping();
      } catch {
        // Ping on a half-closed socket throws; the next tick will reap it
        // once missedPongs crosses the threshold.
      }
    }
  }, wsHeartbeatIntervalMs);
  // Ensure the heartbeat doesn't keep the event loop alive on shutdown.
  heartbeat.unref?.();

  // Stall sweep: the ONLY place a healthy socket's backlog is turned into a
  // close. A filtered socket whose live backlog sits above the watermark
  // without draining for the grace window is a genuinely stalled consumer —
  // close it (1013) so it reconnects and recovers via bounded replay. Any
  // shrinking backlog resets the clock. A single large frame never lands here:
  // it drains and the backlog returns below the watermark. Drain times are
  // recorded as telemetry when a backlogged socket clears.
  const stallSweep = setInterval(() => {
    const now = Date.now();
    for (const ws of sockets) {
      const routing = socketRouting.get(ws);
      if (!routing || routing.mode !== "filtered" || routing.congested) continue;
      const liveBacklog = Math.max(0, socketBufferedAmount(ws) - (routing.exemptBytes || 0));
      telemetry.recordBacklog(liveBacklog);
      const decision = socketStallDecision({
        liveBacklog,
        prevLiveBacklog: routing.lastLiveBacklog,
        backlogSince: routing.backlogSince,
        now,
        thresholdBytes: SOCKET_STALL_THRESHOLD_BYTES,
        graceMs: socketStallGraceMs,
      });
      // Total time-to-drain telemetry rides backlogEnteredAt (see
      // drainTelemetryTransition) — stamped once on the first crossing, never
      // reset on a mere shrink, so a stepwise drain reports the full span.
      const drain = drainTelemetryTransition({
        backlogEnteredAt: routing.backlogEnteredAt,
        backloggedNow: decision.backlogSince !== null,
        now,
      });
      if (drain.drainMs !== null) telemetry.recordDrainMs(drain.drainMs);
      routing.backlogEnteredAt = drain.backlogEnteredAt;
      routing.backlogSince = decision.backlogSince;
      routing.lastLiveBacklog = liveBacklog;
      if (decision.trip) {
        log.warn("WebSocket stalled — no drain progress over grace window", {
          sessionRef: remoteSessionRef(socketSession.get(ws) || ""),
          liveBacklog,
          graceMs: socketStallGraceMs,
        });
        markCongested(ws, liveBacklog, 0);
      }
    }
  }, socketStallSweepMs);
  stallSweep.unref?.();

  // Periodic telemetry summary — trends, never a gate. Emitted only when there
  // has been state-delivery activity so an idle server stays quiet.
  const telemetryLog = setInterval(() => {
    if (!telemetry.hasActivity()) return;
    log.debug("remote state delivery telemetry", telemetry.snapshot());
  }, 60_000);
  telemetryLog.unref?.();

  const listenResult = await new Promise<{ ok: boolean; error?: Error }>((resolve) => {
    server.once("error", (error: Error) => {
      const isPortBusy = (error as NodeJS.ErrnoException).code === "EADDRINUSE" || /EADDRINUSE/.test(error.message);
      if (isPortBusy) {
        log.warn("remote access port already in use — disabled until restart", {
          port,
          host,
          hint: "Set STRIDETERM_REMOTE_PORT to pick a different port, or stop the other strideterm instance.",
        });
      } else {
        log.warn("remote access server failed", { err: error.message, port, host });
      }
      resolve({ ok: false, error });
    });
    // Keep idle keep-alive connections open longer than the upstream
    // (cloudflared) reuses them. cloudflared pools TCP connections to the
    // origin; with Node's 5s default the origin closes a pooled connection
    // just as cloudflared sends the next request on it → the proxy reads a
    // reset ("An existing connection was forcibly closed by the remote host")
    // and returns 502 for whatever endpoint happened to land on that socket
    // (terminal/replay, attention/sync, azure/refresh). A failed replay then
    // surfaces as "Remote workspace is temporarily unavailable" and remounts
    // the pane. cloudflared's default proxy keepalive is 90s, so sit above it.
    server.keepAliveTimeout = 100_000;
    server.headersTimeout = 101_000;
    server.listen(port, host, () => resolve({ ok: true }));
  });

  if (!listenResult.ok) {
    clearInterval(heartbeat);
    clearInterval(stallSweep);
    clearInterval(telemetryLog);
    clearInterval(mobileSessionSweep);
    audit.close();
    unsubscribe.forEach((dispose) => dispose());
    wss.close();
    server.close();
    if (!isLoopbackOrigin) {
      runtime.setRemoteInfo({ enabled: false, urls: [], port, host, error: listenResult.error!.message });
      return { close: async () => {} };
    }
    // A relay origin that cannot bind is a failure the relay manager has to see, not a silent
    // no-op: without it the connector would attach to the relay and then answer nothing.
    throw listenResult.error!;
  }

  const bound = server.address();
  const boundPort = typeof bound === "object" && bound !== null ? bound.port : port;
  if (isLoopbackOrigin) {
    // Deliberately no URL and no token in this line: the relay origin's address is not something a
    // human ever types, and its token is a credential.
    log.info("relay internal origin ready", { host, port: boundPort });
  } else {
    runtime.setRemoteInfo({
      enabled: true,
      host,
      port,
      urls: listRemoteUrls(host, port, token),
    });
    const urls = runtime.listRemoteUrls();
    if (urls.length > 0) {
      log.info("remote access ready", { url: urls[0] });
    }
  }

  return {
    address: { host, port: boundPort },
    async close() {
      clearInterval(heartbeat);
      clearInterval(stallSweep);
      clearInterval(telemetryLog);
      clearInterval(mobileSessionSweep);
      if (telemetry.hasActivity()) log.debug("remote state delivery telemetry (final)", telemetry.snapshot());
      registry.stopCleanupSweep();
      releaseRegistry();
      // Sessions live only in this process: stopping the server drops every one of them.
      for (const record of [...activeSessions.values()]) auditMobileSessionEnded(record, "server-stopped");
      // Sessions die with the process; the desktop's "connected" indicator must not outlive them.
      publishMobileSessions(true);
      audit.close();
      unsubscribe.forEach((dispose) => dispose());
      for (const socket of sockets) {
        socket.close();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      // `server.close()` waits for every open connection, and a keep-alive pool holds them open
      // indefinitely. Idle ones are ended in both cases; for the relay origin — whose only client is
      // the connector that has already been stopped — every connection is ended, because "the relay
      // is off" has to mean the listener is gone rather than waiting on a socket nobody will use
      // again. This was observed for real: turning the relay off left `close()` pending on one
      // pooled connection, so it could never be turned back on.
      server.closeIdleConnections?.();
      if (isLoopbackOrigin) server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    // Test-only: snapshot each live socket's congestion + close-timer state so
    // tests can assert the backpressure close→terminate handshake and its cleanup
    // without reaching into module internals. Iterates `sockets` because routing
    // is a WeakMap; a socket drops from `sockets` (and its routing) on close.
    _debugRouting: () => {
      const out: { congested: boolean; hasCloseTimer: boolean }[] = [];
      for (const s of sockets) {
        const r = socketRouting.get(s);
        if (r) out.push({ congested: r.congested, hasCloseTimer: r.closeTimer !== null });
      }
      return out;
    },
    // Test-only: total congestion close-timers that fired terminate() over this
    // server's lifetime. Stays 0 when every congested client acks its 1013 in
    // time (the close handler clears the armed timer).
    _debugCongestionTerminates: () => congestionTerminateCount,
    // Test-only: current telemetry snapshot (frame sizes, coalescing counts,
    // backlog high-water, drain times).
    _debugTelemetry: () => telemetry.snapshot(),
    // Test-only: see the interface comment above — proves DETAIL_ROUTES and
    // slotAwareRoute are built once (module/closure scope) rather than
    // rebuilt on every request.
    _debugRouteMapsIdentity: () => ({ detailRoutes: DETAIL_ROUTES, slotAwareRoute }),
    // Exposed directly (in addition to runtime.setMobileRemoteSessionRevoker
    // above) so tests can drive a device revoke without needing a real
    // MobileManager/runtime wired up.
    revokeMobileSessionsForDevice,
  };
}

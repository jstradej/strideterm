/// <reference types="node" />
/**
 * Top-level mobile lifecycle: outbox (encrypted ExternalNotificationEvents
 * -> Firebase), inbox (encrypted command envelopes <- Firebase -> typed
 * dispatch -> encrypted result), device/membership management via
 * mobile-device-store.ts, and `mobile:*` runtime events for renderer status/
 * pairing UI (status/pairing progress ONLY — never a secret, private key, or
 * plaintext payload crosses these events).
 *
 * Constructed the same way TelegramManager/CloudflareTunnelManager are (one
 * options object, extends EventEmitter, start()/stop() lifecycle) — see
 * runtime.ts for where this is wired in alongside them.
 *
 * Design decision (disclosed): each device has its own X25519 keypair and
 * thus its own pairwise session key with this desktop — there is no single
 * "pair-level" shared key. So this desktop sends one independently-encrypted
 * copy of each qualifying event per active, filter-passing device. Under v1
 * every copy landed in one shared `/v1/pairs/{pairId}/events` mailbox and had
 * to carry a `${eventId}:${deviceId}` suffix to stay distinct, which left
 * every phone able to read every other phone's ciphertext and routing
 * metadata. In v2 the recipient is a path segment
 * (`v2/pairs/{pairId}/events/{targetDeviceId}/{eventId}`), so the copies no
 * longer share a parent, the suffix is gone, and the rules grant the read to
 * exactly one device's uid — see strideterm-mobile's
 * docs/adr/0016-recipient-bound-routing.md.
 */
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  buildRoutingAad,
  computeKeyProof,
  computePairingApprovalTranscriptHash,
  computePairingSas,
  decodeCanonicalPublicKey,
  deriveSessionKey,
  keyProofsEqual,
  openEnvelope,
  publicKeyFromRaw,
  routingAadMatches,
  sealEnvelope,
  sealToCombinedBase64,
} from "./mobile-crypto.js";
import {
  AEAD_NONCE_BYTES,
  CommandSchema,
  MAX_CLIENT_CLOCK_SKEW_MS,
  MAX_COMMAND_TTL_MS,
  MAX_EVENT_TTL_MS,
  MAX_PUSH_EVENTS_PER_PAIR_PER_UTC_DAY,
  PROTOCOL_VERSION,
  RESERVED_HIGH_PRIORITY_DAILY_PUSH_SLOTS,
  SESSION_KEY_HKDF_INFO,
} from "./mobile-schemas.js";
import type {
  Capability,
  Command,
  EncryptedEnvelope,
  MobileDeviceRecord,
  NotificationEvent,
  NotificationKind,
  NotificationPayload,
  Severity,
} from "./mobile-schemas.js";
import type { MobileAuditLogEntry, MobileAuditLogFilters, MobileAuditLogStore } from "./mobile-audit-log-store.js";
import type { MobileCommandDispatcher } from "./mobile-command-dispatch.js";
import type { MobileNotificationOriginStore } from "./mobile-notification-origin-store.js";
import { isDeviceUsable, type MobileDeviceStore } from "./mobile-device-store.js";
import type {
  CreateInvitationOptions,
  MobilePairing,
  PendingInvitationInfo,
  QrPairingPayload,
} from "./mobile-pairing.js";
import { MobileQuotaExceededError } from "./mobile-firebase-transport.js";
import type { MobileConnectionState, MobileFirebaseTransport } from "./mobile-firebase-transport.js";
import type { ExternalNotificationEvent } from "../../shared/types/notifications.js";
import { mobileErrorCode } from "./mobile-error-codes.js";
import { MobileFirebaseCallableError } from "./mobile-firebase-rest.js";
import { getLogger } from "../logger.js";

const log = getLogger("mobile-manager");

// HKDF `info` for the pairing session key — the generated cross-side constant, not a
// desktop-local choice (see SESSION_KEY_HKDF_INFO's doc comment for the drift this fixed).
const PROTOCOL_INFO = Buffer.from(SESSION_KEY_HKDF_INFO);
/** Command/result envelopes get a short TTL — plan §8 ("destructive command má krátkou TTL"). */
const RESULT_ENVELOPE_TTL_MS = 5 * 60_000;
const PRIORITY_RANK: Record<Severity, number> = { low: 0, normal: 1, high: 2 };
const ONE_DAY_MS = 86_400_000;

/**
 * Why a pairing was rejected. A fixed set, mirroring the reasons `rejectPairing` accepts — never free
 * text, because it is stored in the audit log and shown to a human during an incident.
 */
export type PairingRejectionReason =
  "sas-mismatch" | "dialog-dismissed" | "key-proof-failed" | "grant-mismatch" | "timeout";

/**
 * Maps the runtime's open-ended `ExternalNotificationEvent.kind` (whatever the
 * alert classifier produced — "waiting", "completed", "info", "review",
 * "pipeline", …) onto the four-value NotificationKind the protocol defines,
 * which is what decides the notification channel the phone files it under.
 *
 * Exported for its own test: this is the one place where an unrecognised kind
 * silently becomes "general", and that fallback should be a deliberate,
 * asserted behaviour rather than an implementation detail.
 */
export function notificationKindFor(kind: string): NotificationKind {
  switch (kind) {
    case "question":
    case "waiting":
    case "user-action-required":
      return "waiting";
    case "completed":
    case "done":
      return "completed";
    case "error":
    case "failed":
      return "error";
    default:
      // "info", "progress", "review", "pipeline" and anything a future classifier invents.
      // Deliberately not a throw: an unknown kind must still reach the user, just in the
      // lowest-urgency channel.
      return "general";
  }
}

/** Desktop UI status snapshot (plan §10.5 "refresh connection health") — never a secret/key. */
export interface MobileConnectionHealth {
  running: boolean;
  connectionState: MobileConnectionState;
  lastError: string | null;
  deviceCount: number;
  pendingInvitation: PendingInvitationInfo | null;
  /**
   * Whether the cloud still recognises this desktop as the owner of its own pair.
   *
   * `connectionState` answers a narrower question than it looks like it does: it means a transport
   * that authenticated and stayed up. A desktop whose uid is no longer in the pair's `members` —
   * which is what a re-minted anonymous account leaves behind — connects exactly as happily and has
   * every read and write refused, so "connected" alone reported a working link where there was
   * none. `denied` is that case: the phone sees this desktop as unreachable and nothing it asks for
   * will be answered until the pairing is re-established. `unknown` means no evidence yet.
   */
  pairAuthorization: "unknown" | "ok" | "denied";
}

/**
 * Today's push-quota display (plan §7/§10.5: "přehled dnešní push kvóty
 * used/100, reserved high-priority slots a reset time"). DISCLOSED GAP: the
 * real quota counter is server-side (Firebase RTDB `quotaWindows`), and this
 * pass has no live Firebase project to read it from (see
 * mobile-firebase-transport.ts's own disclosed gap). This is therefore a
 * desktop-local APPROXIMATION derived from this desktop's own audit log of
 * successful `event.sent` entries since the start of the current UTC day —
 * good enough for an honest local display, but not the authoritative
 * server-enforced counter the plan describes. Test pushes are logged via the
 * exact same `event.sent` audit action, so they count against this the same
 * way a real push would (plan §10.5 "send test push ... se započítá do
 * normální kvóty").
 */
export interface MobileQuotaSnapshot {
  used: number;
  limit: number;
  reservedHighPriorityRemaining: number;
  /** Epoch ms of the next UTC-day boundary (when the local approximation resets). */
  resetAt: number;
  /**
   * Count of pushes suppressed today because the pair's quota was exhausted
   * (plan §7: "Nad limit se alert stále může objevit v lokálním desktopu;
   * pouze se nevytvoří cloud event/push"). Derived from the same local audit
   * log as `used`, so it shares its "approximation, not the authoritative
   * server counter" caveat — see this interface's own doc comment above.
   */
  suppressedToday: number;
}

export interface MobileManagerDeps {
  getProfileIds?: () => string[];
  getCatalogSignature?: (allowedProfileIds: string[]) => string;
  transport: MobileFirebaseTransport;
  pairing: MobilePairing;
  deviceStore: MobileDeviceStore;
  auditLogStore: MobileAuditLogStore;
  commandDispatcher: MobileCommandDispatcher;
  /** Shared source of ExternalNotificationEvent (plan §10.1) — the runtime's raiseAlert()/PR/pipeline paths emit here. */
  externalNotificationEvents: EventEmitter;
  ownDeviceId: string;
  ownPrivateKey: KeyObject;
  /**
   * Same shared instance mobile-command-dispatch.ts issues tickets from
   * (see mobile-web-session-ticket-store.ts). Revoking a device must
   * invalidate any outstanding-but-unconsumed ticket so it can't be
   * redeemed after the device has been kicked out (plan §5.4/§10.6).
   * Optional so existing tests/callers that don't exercise the WebView
   * ticket flow don't need to supply one.
   */
  ticketStore?: { revokeForDevice(deviceId: string): void };
  /**
   * Closes the device's active remote-server HTTP/WS session(s), if any
   * (plan §9.2/§10.6: "Revoke uzavře odpovídající WS spojení a odstraní
   * sessions"). remote-server.ts isn't constructed until after the runtime
   * (main.ts starts it), so runtime.ts wires this through a settable
   * indirection (setMobileRemoteSessionRevoker) rather than a direct
   * reference — same reasoning as ticketStore above, optional for callers
   * that don't need it.
   */
  revokeRemoteSessions?: (deviceId: string) => void;
  /**
   * Withdraws a device's relay end-to-end keys and ends its live e2e streams (plan 2026-09-23). The
   * keys sit in memory for up to the relay session's lifetime; without this a revoked phone's
   * connector keeps decrypting and serving its frames until they expire, whether or not the relay
   * closed the viewer socket.
   */
  revokeRelayE2eSession?: (deviceId: string) => void;
  /**
   * Same shared instance mobile-command-dispatch.ts reads acknowledgements against. An event's
   * origin is recorded here on the way out so that `notification.acknowledge` — whose payload is
   * only `{eventId}` — can find the alert it refers to on the way back.
   *
   * Optional for the same reason ticketStore is: a test that does not exercise acknowledgement need
   * not supply one, and without it the ack keeps its previous local-only behaviour.
   */
  notificationOrigins?: MobileNotificationOriginStore;
  now?: () => number;
}

function meetsNotificationFilter(device: MobileDeviceRecord, event: ExternalNotificationEvent): boolean {
  if (device.notificationFilter.mutedKinds.includes(event.kind)) return false;
  return PRIORITY_RANK[event.priority] >= PRIORITY_RANK[device.notificationFilter.minPriority];
}

/**
 * The catalog revision is a pure function of the catalog content. It used to be a random UUID minted on
 * every publish, so each manager restart (the hourly token-refresh one, 2026-10-05) "changed" the
 * catalog and made the phone refetch its profile catalog although nothing in it had moved. Shaped
 * like a UUID so the cloud's opaque-id validation and the phone's parsing stay untouched.
 */
export function catalogRevisionOf(catalogSignature: string): string {
  const hex = createHash("sha256").update(catalogSignature).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class MobileManager extends EventEmitter {
  /** How often a connected desktop refreshes its presence node. See beginPresence. */
  private static readonly PRESENCE_REFRESH_MS = 60_000;
  /** Leave enough room for the rest of Electron's ten-second shutdown cleanup. */
  private static readonly PRESENCE_SHUTDOWN_TIMEOUT_MS = 2_000;

  private transport: MobileFirebaseTransport;
  private pairing: MobilePairing;
  private deviceStore: MobileDeviceStore;
  private auditLogStore: MobileAuditLogStore;
  private commandDispatcher: MobileCommandDispatcher;
  private externalNotificationEvents: EventEmitter;
  private ownDeviceId: string;

  /**
   * The interval that keeps this desktop's presence node fresh, or null when it is not connected.
   *
   * WHY THIS EXISTS AT ALL. `MobileFirebaseTransport.updatePresence` has been part of the interface
   * and implemented against the REST transport since the feature landed, the security rules were
   * written to allow exactly this write ("either auth.uid is the desktop and $deviceId is
   * publicMeta.desktopDeviceId..."), and NOTHING EVER CALLED IT. Read against the live database, the
   * pair's whole `presence` branch was null. The phone renders that branch as "Reachable / Not
   * reachable", so a desktop that was paired, connected and answering commands showed on the phone
   * as unreachable — the exact report this fixes.
   */
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private stopPromise: Promise<void> | null = null;
  private ownPrivateKey: KeyObject;
  private ticketStore: { revokeForDevice(deviceId: string): void } | undefined;
  private revokeRemoteSessions: ((deviceId: string) => void) | undefined;
  private revokeRelayE2eSession: ((deviceId: string) => void) | undefined;
  private notificationOrigins: MobileNotificationOriginStore | undefined;
  private now: () => number;

  private running = false;
  private sessionKeyCache = new Map<string, Buffer>();
  private unsubscribeCommands: (() => void) | null = null;
  private unsubscribeDeviceUpdates: (() => void) | null = null;
  private externalEventListener: ((event: ExternalNotificationEvent) => void) | null = null;
  private connectionState: MobileConnectionState = "disconnected";
  private pairAuthorization: MobileConnectionHealth["pairAuthorization"] = "unknown";
  private lastConnectionError: string | null = null;
  /** Guards `flushPendingCloudRevocations` against its two callers firing for the same reconnect. */
  private flushingCloudRevocations = false;
  private unsubscribeConnectionState: (() => void) | null = null;
  private lifecycleGeneration = 0;

  private getProfileIds?: () => string[];
  private getCatalogSignature?: (allowedProfileIds: string[]) => string;
  private profileSync: Promise<void> | null = null;
  private profileSyncRequested = false;
  private profileSyncRetryAt = 0;
  private syncedAccess = new Map<string, string>();

  constructor(deps: MobileManagerDeps) {
    super();
    this.transport = deps.transport;
    this.getProfileIds = deps.getProfileIds;
    this.getCatalogSignature = deps.getCatalogSignature;
    this.pairing = deps.pairing;
    this.deviceStore = deps.deviceStore;
    this.auditLogStore = deps.auditLogStore;
    this.commandDispatcher = deps.commandDispatcher;
    this.externalNotificationEvents = deps.externalNotificationEvents;
    this.ownDeviceId = deps.ownDeviceId;
    this.ownPrivateKey = deps.ownPrivateKey;
    this.ticketStore = deps.ticketStore;
    this.revokeRemoteSessions = deps.revokeRemoteSessions;
    this.revokeRelayE2eSession = deps.revokeRelayE2eSession;
    this.notificationOrigins = deps.notificationOrigins;
    this.now = deps.now || (() => Date.now());

    // "Somebody scanned it and I am working on it." The renderer covers the QR with a spinner from
    // here until the SAS arrives (or the claim is rejected), so the gap between the scan and the code
    // appearing stops looking like nothing happened.
    this.pairing.onClaimSeen((info) => {
      this.emit("mobile:pairing-progress", { status: "claimed", pairingId: info.pairingId });
    });
    this.pairing.onClaim((outcome) => {
      if (outcome.ok) {
        // The claim was adopted, which now means three things were checked before the record was
        // stored: it names this desktop's pending invitation, the grants the server recorded match the
        // grants the human ticked, and its key proof recomputes correctly under this desktop's private
        // key (review 3 §P0.1). What it does NOT mean is that the device can do anything — the record
        // is `keyProven`, and reaching `active` needs the human decision below.
        this.emit("mobile:pairing-progress", {
          status: "awaiting-approval",
          deviceId: outcome.device.deviceId,
          label: outcome.device.label,
          // The short authentication string is derived here from both public keys, both device ids,
          // the pair and the invitation — nothing that travelled through the backend. The phone
          // computes the same value from the same transcript and shows it; the USER TYPES what the
          // phone shows and `approveDevice` compares it with this desktop's own derivation (review 3
          // §3.6). The string itself never crosses to the renderer — the event says only whether a
          // code could be derived — because a desktop that displays it turns a comparison into a
          // one-click approval: whoever scanned the invitation first gets a code on screen and a
          // button beside it, and nothing forces the user to look at the phone.
          sasReady: this.computeSasFor(outcome.device, outcome.pairingId) !== null,
          pairingId: outcome.pairingId,
        });
      } else {
        this.emit("mobile:pairing-progress", { status: "rejected", reason: outcome.reason });
      }
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  getSystemChannelDevice(deviceId: string): {
    deviceId: string;
    pairId: string;
    sessionKey: Buffer;
    capabilities: string[];
    profileAllowlist: string[];
  } | null {
    const device = this.deviceStore.getDevice(deviceId);
    if (!isDeviceUsable(device)) return null;
    return {
      deviceId: device.deviceId,
      pairId: device.pairId,
      sessionKey: Buffer.from(this.sessionKeyFor(device)),
      capabilities: [...device.capabilities],
      profileAllowlist: [...device.profileAllowlist],
    };
  }

  /**
   * The pairing SAS for one just-claimed device, or `null` if either key is unusable.
   *
   * `null` rather than a placeholder: showing a code the user is asked to compare, when it was not
   * actually derived from both real keys, would be worse than showing nothing — it would train them
   * to accept whatever appears.
   */
  private computeSasFor(device: MobileDeviceRecord, pairingId: string): string | null {
    try {
      const identity = this.pairing.getDesktopIdentity();
      return computePairingSas({
        protocolVersion: PROTOCOL_VERSION,
        pairId: this.ownDeviceId,
        pairingId,
        desktopDeviceId: identity.deviceId,
        desktopPublicKeyBase64: identity.publicKeyBase64,
        mobileDeviceId: device.deviceId,
        mobilePublicKeyBase64: device.publicKey,
      });
    } catch (err) {
      log.warn("could not derive the pairing SAS", { code: mobileErrorCode(err) });
      return null;
    }
  }

  /**
   * Installs the two long-lived transport streams as one unit.
   *
   * A real Firebase transport can reject these calls synchronously (most notably when the desktop
   * was started without its Firebase configuration). That must be treated as mobile connection
   * health, not allowed to escape from start() and abort the whole desktop runtime before Electron
   * registers its IPC handlers.
   */
  private subscribeTransportStreams(): void {
    if (!this.running || (this.unsubscribeCommands && this.unsubscribeDeviceUpdates)) return;

    // A previous partial attempt should not normally be observable because assignments happen only
    // after both subscriptions succeed. Clean it defensively so a retry can never double-subscribe.
    this.unsubscribeCommands?.();
    this.unsubscribeCommands = null;
    this.unsubscribeDeviceUpdates?.();
    this.unsubscribeDeviceUpdates = null;

    let unsubscribeCommands: (() => void) | null = null;
    try {
      unsubscribeCommands = this.transport.watchCommandEnvelopes(this.ownDeviceId, (envelope) => {
        this.handleIncomingEnvelope(envelope).catch((err: unknown) => {
          log.warn("handleIncomingEnvelope failed", { code: mobileErrorCode(err) });
        });
      });
      const unsubscribeDeviceUpdates = this.transport.watchDeviceUpdates(this.ownDeviceId, (device) => {
        void this.syncRemoteDeviceState(device).catch((err: unknown) => {
          log.warn("failed to apply a remote device update", { code: mobileErrorCode(err) });
        });
      });
      this.unsubscribeCommands = unsubscribeCommands;
      this.unsubscribeDeviceUpdates = unsubscribeDeviceUpdates;
    } catch (err) {
      try {
        unsubscribeCommands?.();
      } catch {
        // The original subscription error is the useful health signal.
      }
      throw err;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.lifecycleGeneration;
    this.unsubscribeConnectionState = this.transport.onConnectionStateChange((state) => {
      this.connectionState = state;
      if (state === "connected") {
        this.lastConnectionError = null;
        this.syncedAccess.clear();
        this.profileSyncRetryAt = 0;
      }
      // Presence follows the transport, not start(): it is a claim about being reachable, and the
      // only moment that claim is both true and writable is while the link is up.
      if (state === "connected") this.beginPresence();
      else this.clearPresenceTimer();
      // THE RETRY THAT MAKES A REVOKE SURVIVE BEING OFFLINE. Here rather than on a timer because the
      // only thing that ever changes the outcome is the link coming back, and this is the event that
      // says it did. Fire-and-forget: a flush that fails leaves the entries exactly where they were
      // and the next reconnect tries again.
      if (state === "connected") {
        void this.flushPendingCloudRevocations().catch((err: unknown) => {
          log.warn("flushPendingCloudRevocations failed", { code: mobileErrorCode(err) });
        });
      }
      // Structured, redacted reconnect signal (review §8): a state name and nothing else — no
      // token, no uid, no pair content. Reconnects are the one lifecycle event an operator
      // debugging "my phone stopped getting alerts" actually needs a timeline of.
      log.info("mobile transport connection state", { state });
      this.auditLogStore.logEntry({
        // Pair-level, not device-level: a transport reconnect is about this desktop's link to the
        // control plane, not any one paired device.
        deviceId: this.ownDeviceId,
        pairId: this.ownDeviceId,
        actor: "desktop",
        action: state === "connected" ? "transport.connected" : "transport.disconnected",
        status: "success",
      });
    });
    // Not awaited (start() is sync, matching TelegramManager/CloudflareTunnelManager's
    // start()) — connectionState/lastError above and the .then()/.catch() here are
    // how getConnectionHealth() finds out the outcome without a synchronous
    // getCurrentState() on the transport interface. A transport that was already
    // connected before start() (e.g. tests) won't re-fire onConnectionStateChange
    // (no state transition), so the .then() branch is what catches that case.
    this.transport
      .connect()
      .then(() => {
        if (!this.running || generation !== this.lifecycleGeneration) return;
        this.connectionState = "connected";
        this.lastConnectionError = null;
        // Same reason the subscription retry below exists: a transport that was already connected
        // before start() never fires a state TRANSITION, so this path is what covers it — including
        // for the owed revocations, which is the case of "the desktop was killed while offline and
        // the user restarted it once the network was back".
        this.beginPresence();
        void this.flushPendingCloudRevocations().catch((err: unknown) => {
          log.warn("flushPendingCloudRevocations failed", { code: mobileErrorCode(err) });
        });
        try {
          // Some transports cannot create streams until authentication performed by connect() has
          // completed. The eager attempt below preserves immediate delivery for already-connected
          // transports; this retry covers the authenticated-after-connect case.
          this.subscribeTransportStreams();
        } catch (err) {
          this.lastConnectionError = mobileErrorCode(err);
          log.warn("transport subscription failed", { code: this.lastConnectionError });
        }
      })
      .catch((err: unknown) => {
        if (!this.running || generation !== this.lifecycleGeneration) return;
        // A fixed code, not the transport's own text: this value is both logged AND surfaced to
        // the renderer through getConnectionHealth(), so a raw undici message would cross two
        // boundaries at once (review 2 §"Logy a diagnostika").
        this.lastConnectionError = mobileErrorCode(err);
        log.warn("transport connect failed", { code: this.lastConnectionError });
      });
    try {
      this.subscribeTransportStreams();
    } catch (err) {
      // In particular, an unconfigured Firebase transport throws synchronously here. Keep the
      // manager (and therefore the desktop runtime) alive; connect() records the same stable code
      // asynchronously and a later health refresh can retry both connection and subscriptions.
      this.lastConnectionError = mobileErrorCode(err);
      log.warn("transport subscription failed", { code: this.lastConnectionError });
    }
    this.externalEventListener = (event) => {
      this.handleExternalEvent(event).catch((err: unknown) => {
        log.warn("handleExternalEvent failed", { code: mobileErrorCode(err) });
      });
    };
    this.externalNotificationEvents.on("event", this.externalEventListener);
    this.emit("mobile:status", { running: true });
  }

  /**
   * THE ONE LOCAL REVOCATION SEQUENCE (plan §3.9).
   *
   * Five things have to happen when a device stops being allowed here, and they have to happen
   * together: the store transition, the cached session keys, any outstanding WebView ticket, any live
   * remote-server session, and the relay's own record of the device. Before this method existed they
   * were spelled out at four call sites — `revokeDevice`, `rejectDevice`, the cloud-update watcher and
   * the authoritative re-read in the command path — and the last of those did only the first two,
   * which meant a revoke discovered at command time left a ticket redeemable and a WebView session
   * live. One method, called by all four, is the only arrangement in which they cannot drift apart
   * again.
   *
   * Deliberately local-only and non-throwing. The cloud half differs per caller (revoke, reject, or
   * nothing at all when the cloud is the party that told us), and a cleanup step that throws must not
   * prevent the ones after it — the record is already revoked by then, so every remaining step is
   * making a true statement more thoroughly, and skipping the rest would be the only way to end up
   * half-revoked.
   */
  private async applyLocalRevocation(deviceId: string): Promise<void> {
    await this.deviceStore.revokeDevice(deviceId, this.now());
    this.forgetSessionKeys(deviceId);
    for (const [step, run] of [
      ["ticketStore.revokeForDevice", () => this.ticketStore?.revokeForDevice(deviceId)],
      ["revokeRemoteSessions", () => this.revokeRemoteSessions?.(deviceId)],
      ["revokeRelayE2eSession", () => this.revokeRelayE2eSession?.(deviceId)],
    ] as const) {
      try {
        run();
      } catch (err) {
        log.warn("a local revocation step failed (the record is still revoked)", {
          deviceId,
          step,
          code: mobileErrorCode(err),
        });
      }
    }
  }

  /**
   * Applies one cloud device record to the local store — one way only, into `revoked`.
   *
   * A cloud record that says `active` never activates a local one (that takes a human, through
   * `approveDevice`) and never resurrects a locally-revoked one. So the only thing this stream can do is
   * tighten, which is what makes it safe to act on a value this desktop did not write.
   */
  private async syncRemoteDeviceState(remote: { deviceId: string; revoked: boolean; state: string }): Promise<void> {
    const local = this.deviceStore.getDevice(remote.deviceId);
    if (!local || local.revoked) return;
    if (!remote.revoked && remote.state !== "revoked") return;
    await this.applyLocalRevocation(remote.deviceId);
    this.auditLogStore.logEntry({
      deviceId: remote.deviceId,
      pairId: this.ownDeviceId,
      actor: "device",
      action: "device.revoked-remotely",
      status: "success",
    });
    this.emit("mobile:device-revoked", { deviceId: remote.deviceId });
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.running) return Promise.resolve();
    this.running = false;
    this.lifecycleGeneration += 1;
    this.clearPresenceTimer();
    // Cleared BEFORE the goodbye write, not after: that write's outcome is the freshest evidence
    // there is about whether this desktop is still the pair's owner, so it is allowed to set the
    // flag again on its way out.
    this.pairAuthorization = "unknown";
    this.unsubscribeCommands?.();
    this.unsubscribeCommands = null;
    this.unsubscribeDeviceUpdates?.();
    this.unsubscribeDeviceUpdates = null;
    if (this.externalEventListener) {
      this.externalNotificationEvents.off("event", this.externalEventListener);
      this.externalEventListener = null;
    }
    this.unsubscribeConnectionState?.();
    this.unsubscribeConnectionState = null;
    this.connectionState = "disconnected";
    this.emit("mobile:status", { running: false });
    this.stopPromise = (async () => {
      let published = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          this.publishPresence("offline").then(() => {
            published = true;
          }),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, MobileManager.PRESENCE_SHUTDOWN_TIMEOUT_MS);
            timeout.unref?.();
          }),
        ]);
        if (!published) log.warn("presence offline update timed out during shutdown");
      } finally {
        if (timeout) clearTimeout(timeout);
        await this.transport.disconnect().catch((err: unknown) => {
          log.warn("mobile transport disconnect failed", { code: mobileErrorCode(err) });
        });
        this.stopPromise = null;
      }
    })();
    return this.stopPromise;
  }

  /**
   * Publishes this desktop's presence and keeps it fresh while the transport is connected.
   *
   * The refresh is what makes a crash detectable: a desktop killed by the OS never writes
   * `offline`, so the phone has to be able to tell a live node from an abandoned one, and it does
   * that by age. Sixty seconds is well inside the window the phone treats as stale and cheap enough
   * to ignore — one tiny write a minute, only while connected.
   */
  private beginPresence(): void {
    void this.syncProfileAccess().catch((err: unknown) =>
      log.warn("profile access sync failed", { code: mobileErrorCode(err) }),
    );
    void this.publishPresence("online");
    if (this.presenceTimer) return;
    this.presenceTimer = setInterval(() => {
      void this.syncProfileAccess().catch((err: unknown) =>
        log.warn("profile access sync failed", { code: mobileErrorCode(err) }),
      );
      void this.publishPresence("online");
    }, MobileManager.PRESENCE_REFRESH_MS);
    // A heartbeat must never be the reason the process cannot exit.
    this.presenceTimer.unref?.();
  }

  private clearPresenceTimer(): void {
    if (!this.presenceTimer) return;
    clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  /**
   * One presence write. `pairId` and `deviceId` are both this desktop's own id, which is not a
   * shortcut: one desktop is one pair (see cloud/database.rules.json's "pairId := the desktop's
   * deviceId"), and the rules require the path key to be `publicMeta.desktopDeviceId`.
   *
   * Never rejects. Presence is a display signal, not a correctness one — failing to publish it must
   * not take down a reconnect, a command or a shutdown.
   */
  private publishPresence(status: "online" | "offline"): Promise<void> {
    return this.transport
      .updatePresence(this.ownDeviceId, this.ownDeviceId, status)
      .then(() => {
        this.pairAuthorization = "ok";
      })
      .catch((err: unknown) => {
        const code = mobileErrorCode(err);
        // The heartbeat is the only write this desktop makes on its own schedule, which makes it
        // the one place a lost pair membership surfaces without a phone having to do anything. A
        // rules rejection here is not a presence problem: it means this uid is no longer the pair's
        // owner, so the commands it is watching for are being refused too, and the UI must stop
        // calling that "Connected". Any other failure (offline, unconfigured, 5xx) says nothing
        // about authorization and leaves the flag where it was.
        if (code === "permission-denied") this.pairAuthorization = "denied";
        log.warn("presence update failed", { status, code });
      });
  }

  createInvitation(options: CreateInvitationOptions): Promise<QrPairingPayload> {
    return this.pairing.createInvitation(options);
  }

  cancelInvitation(): Promise<void> {
    return this.pairing.cancelInvitation();
  }

  /**
   * Revokes a single device: local record, cloud membership, cached session
   * key, any outstanding WebView session ticket, and any active remote-server
   * HTTP/WS session (plan §5.4/§9.2/§10.6). Other paired devices are
   * unaffected.
   */
  async revokeDevice(deviceId: string): Promise<void> {
    // Local first, cloud second, and the local half is the shared sequence — so "revoked here" means
    // the same five things whichever path discovered it.
    await this.applyLocalRevocation(deviceId);
    // DURABLE BEFORE THE CALL. This used to be one attempt whose failure went into a `log.warn` and
    // nowhere else, so a desktop that was offline when the user revoked a phone left the cloud
    // record `active` for ever: the phone never learned it had been unpaired, kept its membership
    // and its push token, and nothing would ever reconcile the two sides. See `pendingCloudRevoke`.
    await this.deviceStore.markCloudRevokePending(deviceId, { kind: "revoke" });
    await this.flushCloudRevoke(deviceId);
    this.emit("mobile:device-revoked", { deviceId });
  }

  /**
   * Sends the cloud half this desktop owes for one device, and records honestly what happened.
   *
   * TWO AUDIT LINES, NOT ONE. The old single `device.revoked` / `status: "success"` was written after
   * the try/catch unconditionally, so it claimed success even when the transport had just failed —
   * in the exact place somebody debugging "why is my phone still paired" would look first. The local
   * revocation and its cloud half are separate facts and now say so separately.
   */
  private async flushCloudRevoke(deviceId: string): Promise<boolean> {
    const device = this.deviceStore.getDevice(deviceId);
    const pending = device?.pendingCloudRevoke;
    if (!device || !pending) return true;
    try {
      if (pending.kind === "reject") {
        await this.transport.rejectPairing(this.ownDeviceId, deviceId, device.pairingId, pending.reason ?? "unknown");
      } else {
        await this.transport.revokeDevice(this.ownDeviceId, deviceId);
      }
      await this.deviceStore.clearCloudRevokePending(deviceId);
      this.auditLogStore.logEntry({
        deviceId,
        pairId: this.ownDeviceId,
        actor: "desktop",
        action: pending.kind === "reject" ? "device.rejected" : "device.revoked",
        status: "success",
        detail: pending.attempts > 0 ? `synced after ${pending.attempts} failed attempt(s)` : undefined,
      });
      return true;
    } catch (err) {
      const code = mobileErrorCode(err);
      if (err instanceof MobileFirebaseCallableError && ["NOT_FOUND", "not-found"].includes(err.status)) {
        await this.deviceStore.clearCloudRevokePending(deviceId);
        this.auditLogStore.logEntry({
          deviceId,
          pairId: this.ownDeviceId,
          actor: "desktop",
          action: pending.kind === "reject" ? "device.rejected" : "device.revoked",
          status: "success",
          detail: "cloud device already absent",
        });
        return true;
      }
      await this.deviceStore.recordCloudRevokeAttempt(deviceId, code);
      const attempts = this.deviceStore.getDevice(deviceId)?.pendingCloudRevoke?.attempts ?? 0;
      // WARN, not error: the device is already unusable here, and the retry is guaranteed. What an
      // operator needs from this line is that the cloud has NOT been told yet, and how long for.
      log.warn("cloud revocation still owed (local revoke applied, will retry on reconnect)", {
        deviceId,
        kind: pending.kind,
        code,
        attempts,
      });
      this.auditLogStore.logEntry({
        deviceId,
        pairId: this.ownDeviceId,
        actor: "desktop",
        action: pending.kind === "reject" ? "device.rejected" : "device.revoked",
        status: "failure",
        detail: `local revoke applied; cloud pending (${code}, attempt ${attempts})`,
      });
      return false;
    }
  }

  /**
   * Retries every cloud revocation this desktop still owes. Called whenever the transport comes up.
   *
   * This is the half of the user's "one side revokes, the other finishes when it reconnects" that
   * lives here: the server is the authority both sides read, so a revocation that never reached it
   * is a revocation that never happened, however thoroughly this desktop applied it locally.
   */
  async flushPendingCloudRevocations(): Promise<{ sent: number; owed: number }> {
    // NOT RE-ENTRANT, and it has two callers that can both fire for one link coming up: a transport
    // which transitions to `connected` AND resolves `connect()` runs both paths. Two concurrent
    // flushes would send each call twice and, on failure, count one attempt as two.
    if (this.flushingCloudRevocations) return { sent: 0, owed: 0 };
    this.flushingCloudRevocations = true;
    try {
      const pending = this.deviceStore.listPendingCloudRevocations();
      if (pending.length === 0) return { sent: 0, owed: 0 };
      log.info("flushing owed cloud revocations", { count: pending.length });
      let sent = 0;
      for (const device of pending) {
        if (await this.flushCloudRevoke(device.deviceId)) sent += 1;
      }
      return { sent, owed: pending.length - sent };
    } finally {
      this.flushingCloudRevocations = false;
    }
  }

  /**
   * Forgets a revoked device, so the user can clear a list that otherwise only ever grows.
   *
   * HOUSEKEEPING, NOT A SECURITY ACTION, and the distinction is the whole reason this is separate
   * from `revokeDevice`. It changes nothing about what that phone may do — it was already revoked,
   * and `isDeviceUsable` turns away a missing record exactly as it turns away a revoked one. What it
   * removes is a row in a list. `mobile-device-store.ts#removeRevokedDevice` holds the two refusals
   * that make that true, and the audit log keeps the history regardless.
   *
   * Reports the refusal rather than throwing: the caller is a dialog, and "this one still owes the
   * cloud a revocation" is something to show, not an exception.
   */
  async removeRevokedDevice(deviceId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await this.deviceStore.removeRevokedDevice(deviceId);
    this.auditLogStore.logEntry({
      deviceId,
      pairId: this.ownDeviceId,
      actor: "desktop",
      action: "device.forgotten",
      status: result.ok ? "success" : "failure",
      detail: result.ok ? "removed from the local device list" : result.reason,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    this.emit("mobile:device-forgotten", { deviceId });
    return { ok: true };
  }

  /** All devices (active and revoked) — desktop Settings → Mobile device list (plan §10.5). */
  listDevices(): MobileDeviceRecord[] {
    return this.deviceStore.listDevices();
  }

  /** Desktop-local display label only — never touches the device's identity/keys. */
  async renameDevice(deviceId: string, label: string): Promise<void> {
    await this.deviceStore.renameDevice(deviceId, label);
    this.auditLogStore.logEntry({
      deviceId,
      pairId: this.ownDeviceId,
      actor: "desktop",
      action: "device.renamed",
      status: "success",
    });
  }

  /** Updates a device's capability and/or profile allowlist (plan §10.5). Re-validated on every command anyway (mobile-command-dispatch.ts) — this only changes what's ALLOWED going forward. */
  async updateDeviceAllowlist(
    deviceId: string,
    update: { capabilities?: Capability[]; profileAllowlist?: string[]; excludedProfileIds?: string[] },
  ): Promise<void> {
    const profileIds = this.getProfileIds?.();
    const exclusions =
      update.excludedProfileIds ??
      (update.profileAllowlist && profileIds
        ? profileIds.filter((id) => !update.profileAllowlist!.includes(id))
        : undefined);
    await this.deviceStore.updateAllowlist(deviceId, {
      ...update,
      ...(exclusions
        ? {
            excludedProfileIds: exclusions,
            profileAllowlist: profileIds?.filter((id) => !exclusions.includes(id)) ?? update.profileAllowlist,
          }
        : {}),
    });
    this.ticketStore?.revokeForDevice(deviceId);
    this.revokeRemoteSessions?.(deviceId);
    this.syncedAccess.delete(deviceId);
    this.profileSyncRetryAt = 0;
    if (profileIds) await this.syncProfileAccess();
    else {
      const device = this.deviceStore.getDevice(deviceId);
      if (device?.state === "active" && !device.revoked) {
        await this.transport.updateDeviceAccess(
          this.ownDeviceId,
          deviceId,
          device.capabilities,
          device.profileAllowlist,
        );
      }
    }
    this.auditLogStore.logEntry({
      deviceId,
      pairId: this.ownDeviceId,
      actor: "desktop",
      action: "device.allowlist-updated",
      status: "success",
    });
  }

  syncProfileAccess(): Promise<void> {
    if (!this.getProfileIds || !this.running || this.now() < this.profileSyncRetryAt) return Promise.resolve();
    this.profileSyncRequested = true;
    if (this.profileSync) return this.profileSync;
    this.profileSync = (async () => {
      while (this.profileSyncRequested) {
        this.profileSyncRequested = false;
        const ids = this.getProfileIds!();
        for (const original of this.deviceStore.listUsableDevices()) {
          const excluded = original.excludedProfileIds ?? [];
          const allowed = ids.filter((id) => !excluded.includes(id));
          const changed = JSON.stringify(allowed) !== JSON.stringify(original.profileAllowlist);
          if (changed || original.excludedProfileIds === undefined) {
            await this.deviceStore.updateAllowlist(original.deviceId, {
              excludedProfileIds: excluded,
              profileAllowlist: allowed,
            });
            if (original.profileAllowlist.some((id) => !allowed.includes(id))) {
              this.ticketStore?.revokeForDevice(original.deviceId);
              this.revokeRemoteSessions?.(original.deviceId);
            }
          }
          const device = this.deviceStore.getDevice(original.deviceId);
          if (!device || device.revoked || device.state !== "active") continue;
          const catalogSignature = this.getCatalogSignature?.(device.profileAllowlist);
          const signature = JSON.stringify([device.capabilities, device.profileAllowlist, catalogSignature]);
          if (this.syncedAccess.get(device.deviceId) === signature) continue;
          await this.transport.updateDeviceAccess(
            this.ownDeviceId,
            device.deviceId,
            device.capabilities,
            device.profileAllowlist,
            ...(catalogSignature !== undefined ? [catalogRevisionOf(catalogSignature)] : []),
          );
          this.syncedAccess.set(device.deviceId, signature);
        }
      }
    })()
      .catch((error: unknown) => {
        this.profileSyncRetryAt = this.now() + 30_000;
        throw error;
      })
      .finally(() => {
        this.profileSync = null;
      });
    return this.profileSync;
  }

  /** Status snapshot for desktop Settings → Mobile (plan §10.5 "refresh connection health") — never a secret/key. */
  getConnectionHealth(): MobileConnectionHealth {
    return {
      running: this.running,
      connectionState: this.connectionState,
      lastError: this.lastConnectionError,
      deviceCount: this.deviceStore.listActiveDevices().length,
      pendingInvitation: this.pairing.getPendingInvitation(),
      pairAuthorization: this.pairAuthorization,
    };
  }

  /** Best-effort reconnect attempt (if currently disconnected) before returning the health snapshot. */
  async refreshConnectionHealth(): Promise<MobileConnectionHealth> {
    if (this.running && this.connectionState !== "connected") {
      try {
        await this.transport.connect();
        if (!this.running) return this.getConnectionHealth();
        this.connectionState = "connected";
        this.lastConnectionError = null;
        this.subscribeTransportStreams();
      } catch (err) {
        this.lastConnectionError = mobileErrorCode(err);
      }
    }
    return this.getConnectionHealth();
  }

  /** See MobileQuotaSnapshot's doc comment for why this is a local approximation, not the authoritative server counter. */
  getQuotaSnapshot(): MobileQuotaSnapshot {
    const startOfUtcDay = new Date(this.now());
    startOfUtcDay.setUTCHours(0, 0, 0, 0);
    const { total } = this.auditLogStore.query({
      action: "event.sent",
      status: "success",
      from: startOfUtcDay.toISOString(),
      limit: 1,
    });
    const { total: suppressedToday } = this.auditLogStore.query({
      action: "event.suppressed",
      status: "success",
      from: startOfUtcDay.toISOString(),
      limit: 1,
    });
    return {
      used: Math.min(total, MAX_PUSH_EVENTS_PER_PAIR_PER_UTC_DAY),
      limit: MAX_PUSH_EVENTS_PER_PAIR_PER_UTC_DAY,
      reservedHighPriorityRemaining: RESERVED_HIGH_PRIORITY_DAILY_PUSH_SLOTS,
      resetAt: startOfUtcDay.getTime() + ONE_DAY_MS,
      suppressedToday,
    };
  }

  /** Paginated local audit log read (plan §10.5 "query mobile audit metadata") — never returns ciphertext/plaintext payloads (mobile-audit-log-store.ts never stores any). */
  queryAuditLog(filters: MobileAuditLogFilters = {}) {
    return this.auditLogStore.query(filters);
  }

  /**
   * Sends a single test notification to one device, through the SAME
   * per-device encrypt-and-send path a real ExternalNotificationEvent uses
   * (sendEventToDevice below) — not a parallel mechanism — and flagged
   * `isTest: true` in the decrypted plaintext so the mobile side can label it
   * visibly. Logged via the same "event.sent" audit action a real push uses,
   * so it counts against getQuotaSnapshot() the same way (plan §10.5).
   */
  async sendTestPush(deviceId: string): Promise<{ ok: boolean; reason?: string }> {
    const device = this.deviceStore.getDevice(deviceId);
    if (!device || device.revoked) return { ok: false, reason: "device-not-found" };
    const testEvent: ExternalNotificationEvent = {
      eventId: randomUUID(),
      profileId: device.profileAllowlist[0] || "default",
      workspaceId: "",
      sessionId: null,
      panelId: null,
      kind: "test",
      priority: "normal",
      title: "strIDEterm test notification",
      detail: "This is a test push sent from desktop Settings → Mobile.",
      dedupeKey: `test:${deviceId}:${this.now()}`,
      collapseKey: null,
      createdAt: this.now(),
      actions: [],
    };
    await this.sendEventToDevice(device, testEvent, true);
    return { ok: true };
  }

  /**
   * The pairwise session key for one device.
   *
   * Cached under `deviceId:sessionKeyVersion`, not `deviceId`. A rotation bumps the device record's
   * sessionKeyVersion, so the old entry is simply never looked up again instead of shadowing the new key
   * for the lifetime of the process — the failure mode being every message after a rotation
   * failing its AEAD with nothing naming the cause (review 2 §P1 "Key lifecycle a rotace").
   */
  private sessionKeyFor(device: MobileDeviceRecord): Buffer {
    const cacheKey = `${device.deviceId}:${device.sessionKeyVersion}`;
    let key = this.sessionKeyCache.get(cacheKey);
    if (!key) {
      const devicePublicKey = publicKeyFromRaw(decodeCanonicalPublicKey(device.publicKey));
      key = deriveSessionKey(this.ownPrivateKey, devicePublicKey, Buffer.from(device.pairId), PROTOCOL_INFO);
      this.sessionKeyCache.set(cacheKey, key);
    }
    return key;
  }

  /** Drops every cached key for a device, whatever generation it was derived under. */
  private forgetSessionKeys(deviceId: string): void {
    for (const cacheKey of [...this.sessionKeyCache.keys()]) {
      if (cacheKey === deviceId || cacheKey.startsWith(`${deviceId}:`)) {
        this.sessionKeyCache.delete(cacheKey);
      }
    }
  }

  private async handleExternalEvent(event: ExternalNotificationEvent): Promise<void> {
    // Recorded before the fan-out and once per event, not once per device: every phone paired to
    // this desktop receives the SAME eventId (the recipient is a path segment, see sendEventToDevice),
    // so whichever of them acknowledges it is asking about this one alert. Only events that actually
    // raised an alert carry a workspace to clear — the PR-review and pipeline forwards leave
    // `workspaceId` set but never raised one, and `panelId`/`sessionId` null, which is what the
    // condition below filters out.
    if (event.workspaceId && (event.sessionId || event.panelId)) {
      this.notificationOrigins?.record(event.eventId, {
        profileId: event.profileId,
        workspaceId: event.workspaceId,
        panelId: event.panelId || "",
        sessionId: event.sessionId || "",
      });
    }
    // `listUsableDevices` is `state === "active"`, not `!revoked` (review 3 §P0.1). A device that has
    // been claimed, or whose key proof this desktop has verified, has not been approved by a human —
    // and event delivery is one of the four things that must require approval. Under v2 this loop
    // filtered on `verifiedAt !== null`, which an automatic challenge echo set, so no human decision
    // stood between a claim and real alert content being encrypted to whatever key was in the record.
    for (const device of this.deviceStore.listUsableDevices()) {
      if (!device.profileAllowlist.includes(event.profileId)) continue;
      if (!meetsNotificationFilter(device, event)) continue;
      await this.sendEventToDevice(device, event);
    }
  }

  /**
   * The human typed the code the phone shows, and it is the code this desktop derived. This is the ONLY
   * path to a usable device (review 3 §P0.1, §3.6).
   *
   * WHAT THIS REPLACED. v2 sent an encrypted challenge to a freshly-claimed device, the device echoed
   * it back as an ordinary `notification.acknowledge` command, and `verifiedAt` was set automatically —
   * no human input anywhere. The SAS screen's "I compared them" button only hid the code. So a device
   * could execute commands before anyone had compared anything, and a mismatch blocked nothing.
   *
   * The key proof is part of the claim now and was verified before the record was stored, so this
   * method is exactly and only the human decision. The local record moves to `userApproved` FIRST, so a
   * crash between here and the cloud confirming leaves a record that is still inert but visibly
   * mid-approval — recoverable rather than either activated or lost.
   *
   * THE CODE IS TYPED, NOT CONFIRMED (review 3 §3.6). Showing the desktop's SAS beside a "they match"
   * button made numeric comparison a one-click approval: an attacker who scanned the invitation first
   * leaves the user's own phone with "already used" and the desktop with the attacker's label and a
   * code, and approving is the obvious next click. `enteredSas` is what the user read off the phone;
   * it is compared with the code derived from this desktop's transcript, whitespace aside. A mismatch
   * changes nothing — no state, no cloud call — and is audited, because a typed code that is wrong
   * means either a typo or that the phone in the user's hand is not the one that claimed. Only the
   * desktop ever derives the expected value; the renderer is told whether one exists and no more.
   */
  async approveDevice(deviceId: string, enteredSas: string): Promise<{ ok: boolean; reason?: string }> {
    const device = this.deviceStore.getDevice(deviceId);
    if (!device || device.revoked) return { ok: false, reason: "device-not-found" };
    if (device.state === "active") return { ok: true };
    if (device.state !== "keyProven" && device.state !== "userApproved") {
      return { ok: false, reason: "not-awaiting-approval" };
    }

    const derived = this.computeSasFor(device, device.pairingId);
    if (derived === null) return { ok: false, reason: "unusable-key-material" };
    // The code is grouped for reading ("1234 5678"); what is compared is the eight digits.
    const expected = derived.replace(/\s+/g, "");
    const typed = String(enteredSas ?? "").replace(/\s+/g, "");
    if (typed === "") return { ok: false, reason: "sas-required" };
    if (typed !== expected) {
      this.auditLogStore.logEntry({
        deviceId,
        pairId: this.ownDeviceId,
        actor: "desktop",
        action: "pairing.sas-mismatch",
        status: "failure",
      });
      return { ok: false, reason: "sas-mismatch" };
    }

    await this.deviceStore.markUserApproved(deviceId);
    const identity = this.pairing.getDesktopIdentity();
    let transcriptHash: string;
    try {
      transcriptHash = computePairingApprovalTranscriptHash({
        protocolVersion: PROTOCOL_VERSION,
        pairId: this.ownDeviceId,
        pairingId: device.pairingId,
        desktopDeviceId: identity.deviceId,
        desktopPublicKeyBase64: identity.publicKeyBase64,
        mobileDeviceId: device.deviceId,
        mobilePublicKeyBase64: device.publicKey,
        grantCommitment: device.grantCommitment,
      });
    } catch (err) {
      log.warn("could not derive the pairing approval transcript", { code: mobileErrorCode(err) });
      return { ok: false, reason: "unusable-key-material" };
    }

    try {
      // Adoption may have persisted locally while its cloud attestation failed.
      const remote = await this.transport.getDevice(this.ownDeviceId, deviceId);
      if (remote?.state === "claimed") {
        await this.transport.attestPairingKeyProof(this.ownDeviceId, deviceId, device.pairingId);
      }
      await this.transport.approvePairing(this.ownDeviceId, deviceId, device.pairingId, transcriptHash);
    } catch (err) {
      // The cloud refused or could not be reached. The local record stays `userApproved`, which is NOT
      // usable — so a failure here cannot produce a half-activated device, and the user can retry or
      // reject. Reporting a fixed code, never the transport's text.
      const code = mobileErrorCode(err);
      this.auditLogStore.logEntry({
        deviceId,
        pairId: this.ownDeviceId,
        actor: "desktop",
        action: "pairing.approval-failed",
        status: "failure",
        detail: code,
      });
      return { ok: false, reason: code };
    }

    await this.deviceStore.markActive(deviceId, this.now());
    this.auditLogStore.logEntry({
      deviceId,
      pairId: this.ownDeviceId,
      actor: "desktop",
      action: "pairing.approved",
      status: "success",
    });
    this.emit("mobile:pairing-progress", { status: "active", deviceId, label: device.label });
    return { ok: true };
  }

  /**
   * The human said the codes do NOT match, or dismissed the dialog, or the desktop is shutting the
   * pairing down for any other reason (review 3 §P0.1).
   *
   * Runs the full revocation, locally and in the cloud — the same sequence a revoke does, because
   * "rejected" has to mean the same thing as "revoked" or the difference becomes a hole. In v2 the
   * remedy for a mismatch was the prose "revoke and pair again", i.e. after the device was already
   * live; here the device was never live and this makes sure it never will be.
   */
  async rejectDevice(deviceId: string, reason: PairingRejectionReason): Promise<void> {
    const device = this.deviceStore.getDevice(deviceId);
    if (!device) return;
    await this.applyLocalRevocation(deviceId);
    // THROUGH THE SAME OUTBOX AS A REVOKE. The cloud's pending-approval TTL sweep was the only
    // backstop here, which meant a rejection made offline was indistinguishable — to the phone and
    // to the cloud — from a desktop that simply never answered. It is not the same thing: the human
    // said no, and the record should say they did rather than time out as if nobody was there.
    await this.deviceStore.markCloudRevokePending(deviceId, { kind: "reject", reason });
    await this.flushCloudRevoke(deviceId);
    this.auditLogStore.logEntry({
      deviceId,
      pairId: this.ownDeviceId,
      actor: "desktop",
      action: "pairing.rejected",
      status: "success",
      detail: reason,
    });
    this.emit("mobile:pairing-progress", { status: "rejected", reason });
    this.emit("mobile:device-revoked", { deviceId });
  }

  /** Devices waiting for a human decision — so a restart can re-present the prompt rather than losing it. */
  listDevicesAwaitingApproval(): MobileDeviceRecord[] {
    return this.deviceStore.listPendingApprovalDevices();
  }

  /**
   * The pairing SAS for one device awaiting approval, recomputed on demand.
   *
   * Needed because the code is never persisted: it is derived from the transcript, and a desktop that
   * restarted mid-approval has to be able to check a typed value again without having stored it. Stays
   * inside the backend — the runtime hands the renderer only whether it is non-null.
   */
  sasForPendingDevice(deviceId: string): string | null {
    const device = this.deviceStore.getDevice(deviceId);
    if (!device || device.revoked) return null;
    return this.computeSasFor(device, device.pairingId);
  }

  /**
   * Encrypts and sends one ExternalNotificationEvent to one device — the
   * single outbox send path shared by handleExternalEvent's per-device loop
   * above and sendTestPush() (plan §10.5: a test push must reuse the same
   * outbox path, not a parallel one). `isTest` only ever adds a marker field
   * to the DECRYPTED plaintext (never the unencrypted wire envelope) and is
   * omitted entirely for real events, so the normal plaintext shape is
   * unchanged.
   */
  private async sendEventToDevice(
    device: MobileDeviceRecord,
    event: ExternalNotificationEvent,
    isTest = false,
  ): Promise<void> {
    const pairId = this.ownDeviceId;
    // The recipient is a path segment now (v2/pairs/{pairId}/events/{deviceId}/{eventId}), so the
    // eventId no longer has to carry it: the `${eventId}:${deviceId}` suffix existed only to keep
    // two devices' copies from colliding in one shared mailbox, and a shared mailbox is exactly
    // what v2 removes (review 2 §P0.1). Ids stay plain opaque ids, which is also what the boundary
    // validation on both sides now requires.
    const eventId = event.eventId;
    const createdAt = event.createdAt;
    const expiresAt = createdAt + MAX_EVENT_TTL_MS;
    const key = this.sessionKeyFor(device);
    // Canonical routing AAD, recomputed identically by the mobile app before it will decrypt (see
    // mobile-crypto.ts's buildRoutingAad). It binds the addressee, so this ciphertext cannot be
    // moved into another phone's mailbox and still open.
    const aad = buildRoutingAad({
      protocolVersion: PROTOCOL_VERSION,
      pairId,
      sourceDeviceId: this.ownDeviceId,
      targetDeviceId: device.deviceId,
      messageId: eventId,
      messageType: "notificationEvent",
      sessionKeyVersion: device.sessionKeyVersion,
      createdAt,
      expiresAt,
    });
    // NotificationPayloadSchema — the generated cross-side contract for what lives inside an
    // event's ciphertext. Before this was schematised, the desktop sealed {title, detail,
    // actions} while the app parsed {kind, title, body}: a successful decrypt was followed by a
    // guaranteed parse failure, on every event.
    const payload: NotificationPayload = {
      kind: notificationKindFor(event.kind),
      title: event.title,
      body: event.detail,
      actions: event.actions,
      isTest,
      ...(event.workspaceName ? { workspaceName: event.workspaceName } : {}),
      ...(event.taskId ? { taskId: event.taskId } : {}),
      ...(event.panelId ? { panelId: event.panelId } : {}),
      ...(event.tab ? { tab: event.tab } : {}),
      ...(event.activity ? { activity: event.activity } : {}),
      ...(event.prompt ? { prompt: event.prompt } : {}),
      ...(typeof event.exitCode === "number" ? { exitCode: event.exitCode } : {}),
      ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
    };
    const plaintext = Buffer.from(JSON.stringify(payload));
    const ciphertext = sealToCombinedBase64(plaintext, key, aad);

    const wireEvent: NotificationEvent = {
      protocolVersion: PROTOCOL_VERSION,
      eventId,
      pairId,
      sourceDeviceId: this.ownDeviceId,
      targetDeviceId: device.deviceId,
      profileId: event.profileId,
      workspaceId: event.workspaceId || null,
      severity: event.priority,
      dedupeKey: event.dedupeKey,
      collapseKey: event.collapseKey,
      createdAt,
      expiresAt,
      sessionKeyVersion: device.sessionKeyVersion,
      ciphertext,
      aad: aad.toString("base64"),
    };

    try {
      await this.transport.sendEvent(pairId, wireEvent);
      this.auditLogStore.logEntry({
        deviceId: device.deviceId,
        pairId,
        actor: "desktop",
        action: "event.sent",
        status: "success",
        detail: isTest ? "test" : undefined,
      });
    } catch (err) {
      if (err instanceof MobileQuotaExceededError) {
        this.handleQuotaExceeded(device.deviceId, pairId);
        return;
      }
      // A fixed code, not the transport's message. The audit log is durable, is shown in the UI,
      // and is exported by the operator — it must not accumulate remote-controlled text.
      const code = mobileErrorCode(err);
      this.auditLogStore.logEntry({
        deviceId: device.deviceId,
        pairId,
        actor: "desktop",
        action: "event.sent",
        status: "failure",
        detail: isTest ? `test:${code}` : code,
      });
    }
  }

  /**
   * Plan §7/§10.7: a quota-exceeded push must never raise a per-event desktop
   * notification, and Telegram/other channels for the SAME underlying alert
   * are completely unaffected — this only runs inside the Mobile-specific
   * send path (sendEventToDevice's catch above), never touching raiseAlert()'s
   * separate telegramManager.forwardAlert() call. Instead, only the FIRST
   * suppression of a given UTC day emits one `mobile:status` summary
   * (plan §7 "Desktop jednou denně ukáže souhrn Mobile push limit reached, ne
   * alert pro každý odmítnutý event"); every later suppression the same day
   * only adds to the audit-logged count that getQuotaSnapshot() surfaces.
   */
  private handleQuotaExceeded(deviceId: string, pairId: string): void {
    const startOfUtcDay = new Date(this.now());
    startOfUtcDay.setUTCHours(0, 0, 0, 0);
    const { total: suppressedBeforeToday } = this.auditLogStore.query({
      action: "event.suppressed",
      status: "success",
      from: startOfUtcDay.toISOString(),
      limit: 1,
    });
    this.auditLogStore.logEntry({
      deviceId,
      pairId,
      actor: "desktop",
      action: "event.suppressed",
      status: "success",
      detail: "quota-exceeded",
    });
    if (suppressedBeforeToday === 0) {
      this.emit("mobile:status", {
        pushLimitReached: true,
        suppressedCount: 1,
        resetAt: startOfUtcDay.getTime() + ONE_DAY_MS,
      });
    }
  }

  /**
   * Records a refusal without echoing anything the sender controls.
   *
   * `reason` is always a fixed code from this module, never a message, a field value or an error
   * string: an audit line is read by a human during an incident, and the one thing it must not do
   * is replay attacker-chosen text at them (review 2 §P0.2's "auditovat obecný reason code bez
   * obsahu").
   */
  private rejectEnvelope(envelope: EncryptedEnvelope, reason: string): void {
    const ageSeconds = Math.max(0, Math.round((this.now() - envelope.createdAt) / 1000));
    this.auditBurst(
      {
        deviceId: envelope.senderDeviceId,
        pairId: envelope.pairId,
        actor: "device",
        action: "command.rejected",
        status: "failure",
        detail: reason,
        msg: envelope.messageId.slice(-8),
        // The age is what tells a replayed backlog from a live clock problem; only meaningful here.
        ...(reason === "envelope-expired" ? { ageSeconds } : {}),
      },
      // Only the reasons a manager restart can re-deliver in bulk are collapsed. Every other refusal
      // (identity, AAD, decrypt) is a security signal and keeps its own line.
      reason === "envelope-expired",
    );
  }

  /** Message ids already answered (claimed or refused for good), so a replay costs no network round trip. */
  private handledMessageIds = new Set<string>();
  private markHandled(messageId: string): void {
    this.handledMessageIds.add(messageId);
    // Bounded: the mailbox holds 24 h of commands, so this is far more than a replay can contain.
    if (this.handledMessageIds.size > 5_000) {
      const oldest = this.handledMessageIds.values().next().value;
      if (oldest !== undefined) this.handledMessageIds.delete(oldest);
    }
  }

  private auditBursts = new Map<
    string,
    { suppressed: number; entry: MobileAuditLogEntry; timer: ReturnType<typeof setTimeout> }
  >();

  /**
   * Writes [entry], collapsing a replay burst when [collapse] is set.
   *
   * 2026-10-05: each restart of the manager re-delivered the whole 24 h command mailbox and wrote one
   * `command.rejected` / `duplicate-delivery-ignored` row per command — dozens of identical lines
   * drowning the audit log. The first row of a burst is written at once (so nothing is delayed and an
   * isolated event looks exactly as before); identical rows inside the window are only counted, and ONE
   * summary row with the count follows when the window closes.
   */
  private auditBurst(entry: MobileAuditLogEntry, collapse: boolean): void {
    if (!collapse) {
      this.auditLogStore.logEntry(entry);
      return;
    }
    const key = [entry.deviceId, entry.action, entry.detail ?? ""].join("|");
    const open = this.auditBursts.get(key);
    if (open) {
      open.suppressed += 1;
      return;
    }
    this.auditLogStore.logEntry(entry);
    const timer = setTimeout(() => {
      const burst = this.auditBursts.get(key);
      this.auditBursts.delete(key);
      if (burst && burst.suppressed > 0) {
        // The summary carries counts only: no message id (it would name one of N), the age of nothing.
        this.auditLogStore.logEntry({
          deviceId: entry.deviceId,
          pairId: entry.pairId,
          actor: entry.actor,
          action: entry.action,
          status: entry.status,
          detail: entry.detail,
          suppressed: burst.suppressed,
        });
      }
    }, MobileManager.AUDIT_BURST_WINDOW_MS);
    timer.unref?.();
    this.auditBursts.set(key, { suppressed: 0, entry, timer });
  }
  private static readonly AUDIT_BURST_WINDOW_MS = 2_000;

  private async handleIncomingEnvelope(envelope: EncryptedEnvelope): Promise<void> {
    if (envelope.messageType !== "command") return;

    // A message this manager already answered (a replay after a restart, or the transport's own
    // re-delivery) is dropped BEFORE any network round trip. This used to run after `getDevice`, so a
    // replayed mailbox cost one cloud read per command (2026-10-05).
    if (this.handledMessageIds.has(envelope.messageId)) {
      this.auditBurst(
        {
          deviceId: envelope.senderDeviceId,
          pairId: envelope.pairId,
          actor: "device",
          action: "command.duplicate-delivery-ignored",
          status: "success",
          msg: envelope.messageId.slice(-8),
        },
        true,
      );
      return;
    }

    // ---- Identity, before anything else (review 2 §P0.2) --------------------------------------
    //
    // Every check below is fail-closed and runs BEFORE `claimCommand`, before `touchLastSeen`,
    // before the verification-ack path and before dispatch. That ordering is the requirement, not
    // an implementation detail: claiming is an observable side effect (it consumes the command so
    // no other desktop can run it), and touching last-seen is a second one.
    //
    // The scenario these exist for is a phone paired with two desktops, A and B. It holds a session
    // key for each, so it can produce an envelope that is perfectly authentic to A — and name B
    // inside the plaintext. Under v1, A decrypted it, saw a valid Command, and executed it. AEAD
    // authenticity answers "did someone who holds this key write this?"; it does not answer "was
    // this addressed to me".
    if (envelope.pairId !== this.ownDeviceId) {
      // pairId := this desktop's own deviceId. An envelope naming another pair is not ours to act
      // on even if it somehow arrived on our watcher.
      this.rejectEnvelope(envelope, "foreign-pair");
      return;
    }
    if (envelope.targetDeviceId !== this.ownDeviceId) {
      this.rejectEnvelope(envelope, "foreign-target");
      return;
    }

    const device = this.deviceStore.getDevice(envelope.senderDeviceId);
    if (!device || device.revoked) {
      this.rejectEnvelope(envelope, "unknown-or-revoked-device");
      return;
    }
    if (device.pairId !== this.ownDeviceId) {
      // A locally-stored device record that belongs to a different pair. Reachable if a state file
      // is edited or merged across installations; acting on it would mean running a command from a
      // device this desktop never paired with.
      this.rejectEnvelope(envelope, "device-pair-mismatch");
      return;
    }
    if (!isDeviceUsable(device)) {
      // Review 3 §P0.1: "Desktop musí před dispatch odmítnout každý command od neaktivního device."
      // There is no exception carved out for a handshake message, because there is no handshake
      // message any more — the key proof is part of the claim. In v2 this check did not exist at all:
      // `MobileCommandDispatcher.dispatch` never looked at `verifiedAt`, and `handleIncomingEnvelope`
      // let through anything that was not a verification acknowledgement, so a claimed-but-unapproved
      // device could send ordinary AND destructive commands.
      this.rejectEnvelope(envelope, "device-not-active");
      return;
    }

    // ---- Time, before decrypt (review 3 §P0.4) ------------------------------------------------
    //
    // The envelope's own lifetime, checked at RECEIVE time rather than only when it was written.
    // `enqueueCommand` bounds the outer TTL generically at admission, but a command can sit in the
    // mailbox while this desktop is offline and arrive long afterwards — and nothing here looked at the
    // outer timestamps at all. A hostile phone could therefore mint an envelope valid for the full
    // 24-hour generic maximum, put a destructive command inside it dated `now + 23h55m` with a
    // five-minute inner TTL, and have an offline desktop execute it almost a day later: the inner
    // difference satisfied the per-type policy, and the inner `expiresAt` was still in the future.
    const receivedAt = this.now();
    if (envelope.expiresAt <= receivedAt) {
      // Final for good: an expired envelope never becomes valid again, so a replay of it is ignored
      // cheaply instead of being re-evaluated (and re-logged) after every manager restart.
      this.markHandled(envelope.messageId);
      this.rejectEnvelope(envelope, "envelope-expired");
      return;
    }
    if (envelope.createdAt > receivedAt + MAX_CLIENT_CLOCK_SKEW_MS) {
      this.rejectEnvelope(envelope, "envelope-created-in-the-future");
      return;
    }
    if (envelope.createdAt < receivedAt - MAX_COMMAND_TTL_MS - MAX_CLIENT_CLOCK_SKEW_MS) {
      this.rejectEnvelope(envelope, "envelope-created-too-long-ago");
      return;
    }

    // The attached AAD is plaintext, sender-chosen data: decrypting with it would authenticate
    // the sender but say nothing about *which* message this is. Recompute it from the envelope's
    // own routing fields and refuse on a mismatch (review §P1.7).
    const aadFields = {
      protocolVersion: envelope.protocolVersion,
      pairId: envelope.pairId,
      sourceDeviceId: envelope.senderDeviceId,
      targetDeviceId: envelope.targetDeviceId,
      messageId: envelope.messageId,
      messageType: envelope.messageType,
      sessionKeyVersion: envelope.sessionKeyVersion,
      createdAt: envelope.createdAt,
      expiresAt: envelope.expiresAt,
    };
    if (!routingAadMatches(envelope.aad, aadFields)) {
      this.rejectEnvelope(envelope, "aad-mismatch");
      return;
    }
    if (envelope.protocolVersion !== PROTOCOL_VERSION || envelope.sessionKeyVersion !== device.sessionKeyVersion) {
      // A version this build does not speak, or a key generation this device is no longer pinned
      // to. Both are rejections rather than best-effort attempts: the AEAD would fail anyway, and
      // failing here says which of the two it was.
      this.rejectEnvelope(envelope, "version-mismatch");
      return;
    }

    const key = this.sessionKeyFor(device);
    const aad = buildRoutingAad(aadFields);
    let command: Command;
    try {
      const nonce = Buffer.from(envelope.nonce, "base64");
      if (nonce.length !== AEAD_NONCE_BYTES) throw new Error("nonce length");
      const plaintext = openEnvelope(Buffer.from(envelope.ciphertext, "base64"), nonce, key, aad);
      command = CommandSchema.parse(JSON.parse(plaintext.toString("utf8")));
    } catch (err) {
      this.rejectEnvelope(envelope, "decrypt-or-schema-failed");
      log.warn("failed to decrypt/parse incoming command envelope", {
        deviceId: device.deviceId,
        code: mobileErrorCode(err),
      });
      return;
    }

    // ---- Identity, again, from the DECRYPTED command -------------------------------------------
    //
    // The two checks above were on the envelope header, which the cloud can also see and which the
    // rules and enqueueCommand already constrain. These two are on the plaintext, which only this
    // desktop can read — and which is where a target-confusion attack actually lives.
    if (command.targetDeviceId !== this.ownDeviceId) {
      this.rejectEnvelope(envelope, "command-target-mismatch");
      return;
    }
    if (command.commandId !== envelope.messageId) {
      // The RTDB node key, the AAD and the result path are all bound to `envelope.messageId`, while
      // the claim, the idempotency ledger and the audit trail key off `command.commandId`. If the
      // two can differ, a command can be claimed under one identity and answered under another —
      // and the mobile watcher subscribed to the outer id would never see the result.
      this.rejectEnvelope(envelope, "command-id-mismatch");
      return;
    }
    // The inner timestamps must EQUAL the outer ones (review 3 §P0.4). The outer pair is what the cloud
    // bounded and what this receiver has just checked against the clock; the inner pair is what
    // `checkCommandPolicy` measures the per-type TTL against. If the two may differ, the policy is
    // measuring a pair of numbers the sender chose freely — which is exactly how a destructive command
    // with a five-minute declared lifetime could be executed almost a day after it was written.
    //
    // Exact equality rather than a documented narrower relation, because equality is what the mobile
    // side actually produces (`CommandDispatcher._send` builds the envelope from the command's own
    // timestamps) and because "narrower" is a rule someone has to re-derive at every future edit.
    if (command.createdAt !== envelope.createdAt) {
      this.rejectEnvelope(envelope, "created-at-mismatch");
      return;
    }
    if (command.expiresAt !== envelope.expiresAt) {
      this.rejectEnvelope(envelope, "expires-at-mismatch");
      return;
    }

    // ---- The authoritative active state, immediately before the first side effect --------------
    //
    // Review 3 §P0.3: "Receiver musí těsně před side effectem pracovat s autoritativně synchronizovaným
    // active stavem." The local record was checked above, and `watchDeviceUpdates` keeps it current
    // while this desktop is connected — but a desktop that was offline when the phone revoked itself has
    // a stale copy, and claiming is a side effect. So the cloud record is re-read here, and a `revoked`
    // answer is applied locally on the way out.
    //
    // A FAILED read does not block the command. That is a deliberate, stated trade-off: refusing on a
    // failed read would make every command depend on a live round trip and break the offline case the
    // mailbox exists for. What bounds the residual risk is that `revokeDevice` DELETES the revoked
    // sender's queued commands server-side, so a command from a revoked device is normally gone from the
    // mailbox before this desktop reconnects at all.
    const remote = await this.transport.getDevice(envelope.pairId, device.deviceId).catch(() => null);
    if (remote && (remote.revoked || remote.state !== "active")) {
      // THE WHOLE cleanup, not just the record and the keys (plan §3.9's "an authoritative re-read
      // must not mark the local record revoked without the same cleanup"). This path used to stop
      // after the store transition and the key eviction, so a revoke first noticed here left an
      // outstanding WebView ticket redeemable, a live remote session open and the relay still
      // believing the device was fine — the three things a revoke exists to end.
      await this.applyLocalRevocation(device.deviceId);
      this.rejectEnvelope(envelope, "device-revoked-remotely");
      return;
    }

    // Exactly-one-desktop-executes guard — also protects against a duplicate
    // delivery of the same envelope (e.g. transport offline-queue replay).
    const claimed = await this.transport.claimCommand(envelope.pairId, command.commandId);
    this.markHandled(envelope.messageId);
    if (!claimed) {
      this.auditBurst(
        {
          deviceId: device.deviceId,
          pairId: envelope.pairId,
          actor: "device",
          action: "command.duplicate-delivery-ignored",
          status: "success",
          msg: envelope.messageId.slice(-8),
        },
        true,
      );
      return;
    }

    await this.deviceStore.touchLastSeen(device.deviceId, this.now());

    const result = await this.commandDispatcher.dispatch(command, device);

    // messageId IS the commandId: database.rules.json requires `messageId === $commandId` on the
    // results node, and the mobile watcher subscribes to results/{deviceId}/{commandId}. A fresh
    // random id here would have been rejected by the rules outright — and, if it had not been,
    // would have filed the answer under a key nobody was listening on.
    const resultCreatedAt = this.now();
    const resultExpiresAt = resultCreatedAt + RESULT_ENVELOPE_TTL_MS;
    const resultAad = buildRoutingAad({
      protocolVersion: PROTOCOL_VERSION,
      pairId: envelope.pairId,
      sourceDeviceId: this.ownDeviceId,
      // Back to the device that sent the command, which is also the results subtree it can read.
      targetDeviceId: device.deviceId,
      messageId: command.commandId,
      messageType: "commandResult",
      sessionKeyVersion: device.sessionKeyVersion,
      createdAt: resultCreatedAt,
      expiresAt: resultExpiresAt,
    });
    const sealed = sealEnvelope(Buffer.from(JSON.stringify(result)), key, resultAad);
    const resultEnvelope: EncryptedEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      pairId: envelope.pairId,
      senderDeviceId: this.ownDeviceId,
      targetDeviceId: device.deviceId,
      messageId: command.commandId,
      messageType: "commandResult",
      nonce: sealed.nonce.toString("base64"),
      createdAt: resultCreatedAt,
      expiresAt: resultExpiresAt,
      ciphertext: sealed.ciphertext.toString("base64"),
      aad: resultAad.toString("base64"),
      sessionKeyVersion: device.sessionKeyVersion,
    };
    try {
      await this.transport.sendResultEnvelope(envelope.pairId, device.deviceId, command.commandId, resultEnvelope);
    } catch (err) {
      log.warn("sendResultEnvelope failed", { commandId: command.commandId, code: mobileErrorCode(err) });
    }
  }
}

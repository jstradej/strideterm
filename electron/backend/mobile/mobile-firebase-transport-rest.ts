/// <reference types="node" />
/**
 * The real, Firebase-backed {@link MobileFirebaseTransport} (review §P0.2).
 *
 * Until this existed, `runtime.ts` wired up `createUnimplementedMobileFirebaseTransport()`, whose
 * every method threw — so with Mobile enabled the desktop could not create an invitation, receive
 * a command, or send an event, and no amount of Firebase credentials would have changed that. The
 * in-memory fake stays a test double only; this is what production uses.
 *
 * It talks to Auth, RTDB and the callable Functions through {@link MobileFirebaseRestClient} (see
 * that module for why the HTTP APIs rather than the `firebase` JS SDK), and every path it touches
 * comes from mobile-rtdb-paths.ts, the mirror of the canonical contract.
 *
 * Three behaviours worth reading before changing anything here:
 *
 *  - **Events go through a callable, not an RTDB write** (review 3 §P0.2). This used to write three
 *    `quotaWindows/{windowId}` nodes and then create the event referencing them, with the per-pair
 *    ceiling enforced by Security Rules validating the CONTENTS of those nodes — which a client could
 *    shard without limit, because a rule cannot constrain the KEY it is evaluated under. Both branches
 *    are Admin-SDK-only now and `enqueueEvent` derives every window id from server time. The per-pair
 *    serialisation queue went with it: the server reserves the event id inside one invocation, so
 *    concurrent sends no longer waste a slot.
 *  - **Quota rejections are a distinct signal.** A `resource-exhausted` callable rejection becomes
 *    {@link MobileQuotaExceededError}, which `mobile-manager.ts` treats as "suppress this push,
 *    roll it into the daily summary" rather than as a send failure.
 *  - **Claiming is local, deliberately.** The rules give the desktop no writable marker on a
 *    command node (only the *mobile* may write there, create-only), so there is no RTDB node to
 *    compare-and-set for "I am executing this". Since `pairId` is this desktop's own device id and
 *    the app holds a single-instance lock, "exactly one desktop instance" is already structurally
 *    true; what `claimCommand` actually has to prevent is the same envelope being handled twice by
 *    *this* process after a stream re-open, which a per-process set does exactly. Durable,
 *    across-restart replay protection is a separate layer (mobile-idempotency-store.ts, keyed by
 *    the command's own idempotencyKey) and is not this method's job.
 */
import {
  MobileQuotaExceededError,
  MobileRelayGrantDefinitiveRefusalError,
  type CreateInvitationRequest,
  type CreateInvitationResponse,
  type MobileConnectionState,
  type MobileFirebaseTransport,
  type RelayConnectorGrant,
} from "./mobile-firebase-transport.js";
import type { Device, EncryptedEnvelope, NotificationEvent } from "./mobile-schemas.js";
import { DeviceSchema, EncryptedEnvelopeSchema } from "./mobile-schemas.js";
import {
  MobileFirebaseNotConfiguredError,
  type MobileFirebaseConfig,
  type MobileFirebaseConfigRefusal,
} from "./mobile-firebase-config.js";
import { MobileFirebaseCallableError, type MobileFirebaseRestClient } from "./mobile-firebase-rest.js";
import {
  pairCommandsPath,
  pairDevicePath,
  pairDevicesPath,
  pairPresencePath,
  pairResultPath,
} from "./mobile-rtdb-paths.js";
import { mobileErrorCode } from "./mobile-error-codes.js";
import { getLogger } from "../logger.js";

const log = getLogger("mobile-firebase-transport");

/**
 * Re-adds the fields the Realtime Database silently drops on write.
 *
 * RTDB stores no null values and no empty containers: writing `{profileAllowlist: [],
 * revokedAt: null}` stores neither key, and reading the node back yields a record missing both.
 * `claimPairing` writes exactly that shape for a freshly-claimed device, so the record the
 * desktop streams back does not satisfy `DeviceSchema` and would be discarded as malformed —
 * which is precisely what happened the first time the cross-repo E2E ran this path end to end.
 *
 * Any RTDB reader has to account for this; doing it in one named place beats sprinkling
 * `?? []` through the parse sites.
 */
function hydrateDeviceRecord(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  // RTDB stores no nulls and no empty containers: a field written as `null`, and an array written as
  // `[]`, simply do not exist in the stored JSON. Every nullable field on DeviceSchema therefore has to
  // be restored here, or a perfectly good record fails to parse and is skipped with nothing but an
  // "ignoring malformed device record" line to explain why the desktop never saw a claim.
  //
  // `keyProvenAt` and `activatedAt` are exactly that case (review 3 §P0.1): a freshly claimed record has
  // both null, so before they were listed here the claim watcher discarded every new device.
  return {
    capabilities: [],
    profileAllowlist: [],
    keyProvenAt: null,
    activatedAt: null,
    revokedAt: null,
    ...(raw as Record<string, unknown>),
  };
}

/**
 * Whether a callable failure is the quota answer rather than a transport problem.
 *
 * `resource-exhausted` is the only status `enqueueEvent` uses for a refused quota, and the distinction
 * matters upstream: a quota rejection is rolled into the once-a-day suppression summary, while a real
 * failure is logged as one. The status is a gRPC code the callable chose — never a message — so
 * nothing remote-controlled reaches a log through this.
 */
function isQuotaRejection(err: unknown): boolean {
  return err instanceof MobileFirebaseCallableError && err.status === "resource-exhausted";
}

/**
 * Whether a relay-grant callable failure is DEFINITIVE — the caller's own entitlement, not the
 * network — rather than a `failed-precondition` ("no relay configured here", a supported state) or a
 * transport-level failure (plan 2026-09-14 §6). See {@link MobileRelayGrantDefinitiveRefusalError}.
 */
function isDefinitiveRelayGrantRefusal(err: unknown): boolean {
  return (
    err instanceof MobileFirebaseCallableError &&
    (err.status === "permission-denied" || err.status === "resource-exhausted")
  );
}

export interface FirebaseMobileTransportDeps {
  /** `null` when the install has no Firebase configuration yet — see `missingConfig`. */
  config: MobileFirebaseConfig | null;
  /** Names of the environment variables that were missing, for the error message. */
  missingConfig: string[];
  /** Why a complete configuration was refused (R06), so the error names the contradiction, not a missing variable. */
  configRefusal?: MobileFirebaseConfigRefusal | null;
  /** Built lazily from `config`, so an unconfigured install constructs no client at all. */
  createClient: (config: MobileFirebaseConfig) => MobileFirebaseRestClient;
  now?: () => number;
}

export function createFirebaseMobileTransport(deps: FirebaseMobileTransportDeps): MobileFirebaseTransport {
  const now = deps.now || (() => Date.now());

  let client: MobileFirebaseRestClient | null = null;
  let connectionState: MobileConnectionState = "disconnected";
  const connectionListeners = new Set<(state: MobileConnectionState) => void>();
  const unsubscribers = new Set<() => void>();
  const handledCommandIds = new Set<string>();

  function requireClient(): MobileFirebaseRestClient {
    if (!deps.config) throw new MobileFirebaseNotConfiguredError(deps.missingConfig, deps.configRefusal);
    if (!client) client = deps.createClient(deps.config);
    return client;
  }

  function setConnectionState(next: MobileConnectionState): void {
    if (connectionState === next) return;
    connectionState = next;
    for (const listener of connectionListeners) listener(next);
  }

  /** Registers an unsubscribe function so `disconnect()` can release every listener. */
  function track(unsubscribe: () => void): () => void {
    const wrapped = () => {
      unsubscribers.delete(wrapped);
      unsubscribe();
    };
    unsubscribers.add(wrapped);
    return wrapped;
  }

  /**
   * Every device record change in the pair, including ones already seen.
   *
   * The `seen` set this used to carry is gone (review 3 §P0.3). It made the stream one-shot per device
   * id, so the desktop learned about a device exactly once — a revoke performed by the phone or by
   * another installation never arrived, and a command queued before that revoke could still be executed
   * against a local record that said active. A stream that reports state changes has to report all of
   * them.
   */
  function watchDeviceUpdates(pairId: string, onDevice: (device: Device) => void): () => void {
    const unsubscribe = requireClient().stream(pairDevicesPath(pairId), {
      onEvent: (event) => {
        // `/` carries the whole devices map (initial snapshot / post-reconnect resync);
        // `/{deviceId}` carries one device. A deeper path is one FIELD of one device (what a partial
        // `update()` produces) and must not be parsed as a record — the revocation sequence writes the
        // whole record, so nothing is lost by skipping those.
        const entries: [string, unknown][] =
          event.path === "/"
            ? Object.entries((event.data as Record<string, unknown>) || {})
            : [[event.path.replace(/^\//, ""), event.data]];
        for (const [key, raw] of entries) {
          if (!raw || key.includes("/")) continue;
          const parsed = DeviceSchema.safeParse(hydrateDeviceRecord(raw));
          if (!parsed.success) {
            log.warn("ignoring malformed device record", { deviceId: key });
            continue;
          }
          onDevice(parsed.data);
        }
      },
      onError: (err) => log.warn("watchDeviceUpdates stream error", { code: mobileErrorCode(err) }),
    });
    return track(unsubscribe);
  }

  /**
   * Records claimed under ONE invitation.
   *
   * Implemented on top of the same devices stream — RTDB has no server-side filter this narrow without
   * an index, and adding one would put a `pairingId` index on a branch the desktop already reads in
   * full — but the FILTER IS THE SEAM: `mobile-pairing.ts` cannot see a record claimed under another
   * invitation, so it cannot adopt one (review 3 §P0.1).
   */
  function watchPairingClaim(pairId: string, pairingId: string, onClaim: (device: Device) => void): () => void {
    const announced = new Set<string>();
    return watchDeviceUpdates(pairId, (device) => {
      if (device.pairingId !== pairingId) return;
      // One announcement per device: a claim is a one-time event, and a later change to the same record
      // is `watchDeviceUpdates`' business, not this watcher's.
      if (announced.has(device.deviceId)) return;
      announced.add(device.deviceId);
      onClaim(device);
    });
  }

  return {
    async connect() {
      const active = requireClient();
      const session = await active.signIn();
      setConnectionState("connected");
      log.info("mobile Firebase transport connected", { uid: session.uid ? "present" : "missing" });
    },

    async disconnect() {
      // Release every listener before flipping state, so nothing fires against a torn-down
      // session. Repeated calls are safe: `track` removes each wrapper as it runs.
      for (const unsubscribe of [...unsubscribers]) unsubscribe();
      unsubscribers.clear();
      client?.clearCachedToken();
      setConnectionState("disconnected");
    },

    onConnectionStateChange(cb) {
      connectionListeners.add(cb);
      return () => connectionListeners.delete(cb);
    },

    async createInvitation(request: CreateInvitationRequest): Promise<CreateInvitationResponse> {
      const active = requireClient();
      const result = await active.callFunction<{ pairingId: string; expiresAt: number }>("createPairingInvitation", {
        desktopDeviceId: request.desktopDeviceId,
        desktopLabel: request.desktopLabel,
        desktopFingerprint: request.desktopFingerprint,
        desktopPublicKey: request.desktopPublicKey,
        // Only the hash ever leaves this process — mobile-pairing.ts owns that hashing; the
        // `secret` field on the request is the plaintext for the QR code, not for the wire.
        secret: request.secret,
        // The grants the human ticked. These MUST travel: claimPairing copies them onto the device
        // record and the claim request carries no capability list of its own any more, so dropping
        // them here does not silently fall back to "whatever the phone asked for" — it fails the
        // callable's validation outright (review 2 §P0.3).
        approvedCapabilities: request.approvedCapabilities,
        approvedProfileAllowlist: request.approvedProfileAllowlist,
      });
      return { pairingId: result.pairingId, expiresAt: result.expiresAt };
    },

    async cancelInvitation(pairingId: string): Promise<void> {
      const active = requireClient();
      // Best-effort: the invitation also expires server-side after 120s, so a failure here is not
      // a correctness problem — but it is worth surfacing rather than swallowing.
      await active.callFunction("cancelPairingInvitation", { pairingId }).catch((err: unknown) => {
        log.warn("cancelInvitation failed (the invitation still expires on its own)", {
          code: mobileErrorCode(err),
        });
      });
    },

    watchDeviceUpdates,
    watchPairingClaim,

    async getDevice(pairId: string, deviceId: string): Promise<Device | null> {
      const raw = await requireClient().get<unknown>(pairDevicePath(pairId, deviceId));
      if (!raw) return null;
      const parsed = DeviceSchema.safeParse(hydrateDeviceRecord(raw));
      if (!parsed.success) {
        log.warn("ignoring malformed device record", { deviceId });
        return null;
      }
      return parsed.data;
    },

    async attestPairingKeyProof(pairId: string, deviceId: string, pairingId: string): Promise<void> {
      await requireClient().callFunction("attestPairingKeyProof", { pairId, deviceId, pairingId });
    },

    async approvePairing(pairId: string, deviceId: string, pairingId: string, transcriptHash: string): Promise<void> {
      await requireClient().callFunction("approvePairing", { pairId, deviceId, pairingId, transcriptHash });
    },

    async rejectPairing(pairId: string, deviceId: string, pairingId: string, reason: string): Promise<void> {
      await requireClient().callFunction("rejectPairing", { pairId, deviceId, pairingId, reason });
    },

    async revokeDevice(pairId: string, deviceId: string): Promise<void> {
      await requireClient().callFunction("revokeDevice", { pairId, deviceId });
    },

    /**
     * The managed relay's connector grant.
     *
     * A rejection here is not a failure to report to the user: a deployment with no relay answers
     * `failed-precondition`, and the relay manager reads that as "there is no relay", leaving the
     * LAN and Cloudflare transports exactly as they were.
     */
    async issueRelayConnectorGrant(pairId: string, connectorKeyFingerprint: string): Promise<RelayConnectorGrant> {
      try {
        return await requireClient().callFunction<RelayConnectorGrant>("issueRelayConnectorGrant", {
          pairId,
          connectorKeyFingerprint,
        });
      } catch (err) {
        if (isDefinitiveRelayGrantRefusal(err)) {
          throw new MobileRelayGrantDefinitiveRefusalError((err as MobileFirebaseCallableError).status);
        }
        throw err;
      }
    },

    /**
     * One callable, no per-pair queue, no client-derived window ids (review 3 §P0.2).
     *
     * The queue this used to hold existed only because the two-phase RTDB protocol could waste a quota
     * slot when two sends for one pair interleaved: the second bump overwrote the first's `lastEventId`
     * and the first event's creation was then rejected. The server reserves the event id and consumes
     * the counters inside one invocation now, so concurrent sends are simply concurrent, and a
     * duplicate id costs nothing rather than a slot.
     *
     * What is left is the error mapping: `resource-exhausted` is the quota answer and becomes
     * MobileQuotaExceededError, which `mobile-manager.ts` treats as "suppress this push and roll it into
     * the daily summary" rather than as a send failure.
     */
    async sendEvent(pairId: string, event: NotificationEvent): Promise<void> {
      try {
        await requireClient().callFunction("enqueueEvent", { pairId, event });
      } catch (err) {
        if (isQuotaRejection(err)) {
          throw new MobileQuotaExceededError(`event admission rejected for pair ${pairId}`);
        }
        throw err;
      }
    },

    watchCommandEnvelopes(pairId: string, onEnvelope: (envelope: EncryptedEnvelope) => void): () => void {
      const unsubscribe = requireClient().stream(pairCommandsPath(pairId), {
        onEvent: (event) => {
          const entries: [string, unknown][] =
            event.path === "/"
              ? Object.entries((event.data as Record<string, unknown>) || {})
              : [[event.path.replace(/^\//, ""), event.data]];
          for (const [commandId, raw] of entries) {
            if (!raw) continue; // a delete (cleanup sweep) streams as data: null
            const parsed = EncryptedEnvelopeSchema.safeParse(raw);
            if (!parsed.success) {
              log.warn("ignoring malformed command envelope", { commandId });
              continue;
            }
            onEnvelope(parsed.data);
          }
        },
        onError: (err) => log.warn("watchCommandEnvelopes stream error", { code: mobileErrorCode(err) }),
      });
      return track(unsubscribe);
    },

    async claimCommand(pairId: string, commandId: string): Promise<boolean> {
      void pairId;
      if (handledCommandIds.has(commandId)) return false;
      handledCommandIds.add(commandId);
      return true;
    },

    async sendResultEnvelope(
      pairId: string,
      targetDeviceId: string,
      commandId: string,
      envelope: EncryptedEnvelope,
    ): Promise<void> {
      // Keyed by commandId, which the rules require to equal the envelope's messageId and which is
      // the node the mobile watcher subscribes to — under the ISSUING device's own results subtree,
      // so a result naming workspaces, tunnel URLs or WebView ticket material is not readable by a
      // sibling phone in the same pair (review 2 §P0.1).
      await requireClient().set(pairResultPath(pairId, targetDeviceId, commandId), envelope);
    },

    async updatePresence(pairId: string, deviceId: string, status: "online" | "offline"): Promise<void> {
      const active = requireClient();
      const session = await active.currentSession();
      await active.set(pairPresencePath(pairId, deviceId), {
        deviceId,
        uid: session.uid,
        status,
        lastSeenAt: now(),
      });
    },
  };
}

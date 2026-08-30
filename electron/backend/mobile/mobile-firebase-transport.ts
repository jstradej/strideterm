/**
 * The single module allowed to depend on a Firebase client SDK (plan §10.2).
 * No other file under electron/backend/mobile/ may import a Firebase package.
 *
 * This file owns the seam — MobileFirebaseTransport — plus the in-memory fake.
 * The real implementation lives in mobile-firebase-transport-rest.ts and is
 * what runtime.ts wires up; the fake here is a test double only (zero network,
 * deterministic) used by the pairing, command-dispatch and
 * reconnect/offline-queue tests.
 *
 * There used to be a third, deliberately-unimplemented implementation whose
 * every method threw, and it was the one production used. Firebase Auth's own
 * persistence layer cannot keep a headless process signed in across restarts
 * (verified against the real Auth emulator, not assumed — see
 * strideterm-mobile/docs/adr/0009-firebase-auth-node-persistence.md), which is
 * why the real transport owns its refresh credential through the credential
 * store instead of relying on SDK persistence.
 *
 * The interface intentionally maps directly onto the RTDB paths + Cloud
 * Functions in strideterm-mobile/cloud (rtdb-paths.ts, create-pairing-
 * invitation.ts, claim-pairing.ts, revoke-device.ts/revoke-pairing.ts) —
 * it is not a generic multi-provider abstraction, just enough surface for
 * MobileManager / mobile-pairing.ts / mobile-command-dispatch.ts.
 *
 * Wire content boundary: per the protocol schemas (mobile-schemas.ts), a
 * Device record is plaintext metadata (RTDB rules gate read access, no
 * encryption needed), but commands and command results only ever cross this
 * transport as an opaque EncryptedEnvelope (messageType "command" /
 * "commandResult") — this module never sees a decrypted Command/CommandResult.
 * NotificationEvent is a hybrid: plaintext routing metadata plus an opaque
 * ciphertext field for the alert content. Decrypting/encrypting envelope
 * content is mobile-manager.ts's job (via mobile-crypto.ts), not this
 * transport's.
 */
import type { Capability, Device, EncryptedEnvelope, NotificationEvent } from "./mobile-schemas.js";

export interface CreateInvitationRequest {
  desktopDeviceId: string;
  desktopLabel: string;
  /** Hash over (protocol version, desktopDeviceId, canonical public key) — recomputed server-side. */
  desktopFingerprint: string;
  /** Canonical base64 of exactly 32 bytes; the callable rejects anything else. */
  desktopPublicKey: string;
  /** Client-generated 256-bit secret (only its hash ever leaves this process) — see mobile-pairing.ts. */
  secret: string;
  /**
   * The grants the human ticked in the pairing dialog, frozen onto the invitation server-side.
   * claimPairing copies these onto the device record; the claiming phone has no say in them
   * (review 2 §P0.3).
   */
  approvedCapabilities: Capability[];
  approvedProfileAllowlist: string[];
}

export interface CreateInvitationResponse {
  pairingId: string;
  expiresAt: number;
}

export type MobileConnectionState = "connected" | "disconnected";

/**
 * Thrown by MobileFirebaseTransport.sendEvent() when the pair's push-event-creation
 * quota (plan §7 — MAX_PUSH_EVENTS_PER_PAIR_PER_UTC_DAY/_HOUR/_MINUTE and friends)
 * would reject this event. This is a distinct, testable signal from a generic
 * transport/network error: mobile-manager.ts must be able to tell "quota exceeded"
 * (suppress the per-event desktop notification, roll it into the once-a-day summary
 * — plan §7 "Nad limit se alert stále může objevit v lokálním desktopu; pouze se
 * nevytvoří cloud event/push") apart from a real send failure (still logged/handled
 * as a failure).
 *
 * Real-implementation contract (strideterm-mobile/cloud/database.rules.json +
 * docs/adr/0007-event-creation-ceiling.md): the ceiling is enforced by Security
 * Rules via a two-phase protocol, not a single atomic write. A real sendEvent()
 * must (1) bump all three quotaWindows/$windowId nodes (minute/hour/day) for this
 * pair in one multi-location update(), each naming an ad-hoc `lastEventId` field
 * equal to the eventId about to be created (and, for the day window only, a
 * self-declared `severity`), then (2) create the event referencing those three
 * windowIds. Either step's rejection (a `PERMISSION_DENIED`-class error from the
 * RTDB write itself, evaluated before any Cloud Function ever runs) maps to
 * MobileQuotaExceededError. Concurrent sendEvent() calls for the SAME pair must be
 * serialized (one full bump-then-create critical section at a time, e.g. via a
 * local queue) — interleaving two calls' bump/create steps can waste a quota slot
 * (the second call's bump overwrites the first's `lastEventId` before the first
 * reaches step 2), though it can never exceed the cap. See the ADR for the full
 * empirical reasoning, including why a single atomic multi-location update does not
 * work (confirmed against the real RTDB emulator, not assumed).
 */
export class MobileQuotaExceededError extends Error {
  constructor(message = "mobile push quota exceeded") {
    super(message);
    this.name = "MobileQuotaExceededError";
  }
}

/**
 * Narrow seam over Firebase Auth + RTDB + the pairing/revoke Cloud
 * Functions. Every method mirrors one real call in strideterm-mobile/cloud;
 * see that repo's rtdb-paths.ts for the exact branch shape each corresponds
 * to.
 */
export interface MobileFirebaseTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onConnectionStateChange(cb: (state: MobileConnectionState) => void): () => void;

  /** Calls the createPairingInvitation Cloud Function. */
  createInvitation(request: CreateInvitationRequest): Promise<CreateInvitationResponse>;
  /** Cancels/removes a pending invitation this desktop created (best-effort local cleanup; the invitation also expires server-side after 120s). */
  cancelInvitation(pairingId: string): Promise<void>;

  /**
   * Surfaces device records claimed under ONE specific invitation (review 3 §P0.1).
   *
   * The narrow seam that replaced `watchNewDevices`. That one delivered every previously-unseen record
   * in the pair, so `mobile-pairing.ts` adopted whatever appeared while an invitation was open — a
   * stale record, or one an attacker with Admin credentials had inserted earlier, was indistinguishable
   * from the claim the user was making. Filtering here means the pairing module cannot see anything
   * else, rather than being trusted to reject it.
   */
  watchPairingClaim(pairId: string, pairingId: string, onClaim: (device: Device) => void): () => void;

  /**
   * Surfaces every CHANGE to any device record in the pair, including ones already known.
   *
   * `watchNewDevices` added a device id to a `seen` set on first sight and ignored it forever after, so
   * a revoke performed by the phone or by another installation was invisible to this desktop until a
   * restart — and a command queued before the revoke could then be executed against a local record that
   * still said active (review 3 §P0.3). This is the stream that fixes that.
   */
  watchDeviceUpdates(pairId: string, onDevice: (device: Device) => void): () => void;

  /** One-shot authoritative read of a device record, for the check immediately before a side effect. */
  getDevice(pairId: string, deviceId: string): Promise<Device | null>;

  /** Calls the attestPairingKeyProof Cloud Function: `claimed` -> `keyProven`. */
  attestPairingKeyProof(pairId: string, deviceId: string, pairingId: string): Promise<void>;
  /** Calls the approvePairing Cloud Function: `keyProven` -> `active`. The only path to a usable device. */
  approvePairing(pairId: string, deviceId: string, pairingId: string, transcriptHash: string): Promise<void>;
  /** Calls the rejectPairing Cloud Function: any pending state -> `revoked`, with the full revocation sequence. */
  rejectPairing(pairId: string, deviceId: string, pairingId: string, reason: string): Promise<void>;

  /** Calls the revokeDevice Cloud Function. */
  revokeDevice(pairId: string, deviceId: string): Promise<void>;

  /**
   * Submits one encrypted NotificationEvent for one phone through the `enqueueEvent` callable.
   *
   * NO LONGER AN RTDB WRITE (review 3 §P0.2). The previous implementation wrote three
   * `quotaWindows/{windowId}` nodes and then created the event referencing them, with the per-pair
   * ceiling enforced by Security Rules validating the CONTENTS of those nodes. A rule cannot constrain
   * the KEY it is evaluated under, so the same canonical timestamps stored under any number of
   * different keys sharded the ceiling without limit. Both branches are Admin-SDK-only now and the
   * server derives every window id from its own clock.
   *
   * Still rejects with MobileQuotaExceededError (never a generic Error) when a quota refuses the event,
   * so `mobile-manager.ts` can keep telling "suppress this push" apart from "the send failed".
   */
  sendEvent(pairId: string, event: NotificationEvent): Promise<void>;
  /** Subscribes to incoming command envelopes under v2/pairs/{pairId}/commands. Returns an unsubscribe function. */
  watchCommandEnvelopes(pairId: string, onEnvelope: (envelope: EncryptedEnvelope) => void): () => void;
  /** Atomically claims a queued command (RTDB transaction equivalent) so exactly one desktop instance executes it. */
  claimCommand(pairId: string, commandId: string): Promise<boolean>;
  /** Writes an encrypted CommandResult under v2/pairs/{pairId}/results/{targetDeviceId}/{commandId}. */
  sendResultEnvelope(
    pairId: string,
    targetDeviceId: string,
    commandId: string,
    envelope: EncryptedEnvelope,
  ): Promise<void>;

  updatePresence(pairId: string, deviceId: string, status: "online" | "offline"): Promise<void>;

  /**
   * Calls the issueRelayConnectorGrant Cloud Function.
   *
   * Rejects when the deployment has no managed relay configured, which is a supported state rather
   * than an error: the relay manager treats a rejection as "no relay here" and leaves the existing
   * LAN/Cloudflare transports exactly as they were.
   */
  issueRelayConnectorGrant(pairId: string, connectorKeyFingerprint: string): Promise<RelayConnectorGrant>;
}

/** What issueRelayConnectorGrant answers with. */
export interface RelayConnectorGrant {
  /** Compact, short-lived, Ed25519-signed. Opaque to this desktop — it only carries it. */
  grant: string;
  /** Exact origin the grant's audience names. The connector connects here and nowhere else. */
  relayOrigin: string;
  /** This installation, as the control plane records it. */
  desktopInstallationId: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// In-memory fake — zero network, deterministic, used by every test.
// ---------------------------------------------------------------------------

interface InMemoryInvitation {
  request: CreateInvitationRequest;
  expiresAt: number;
}

export interface InMemoryMobileFirebaseTransport extends MobileFirebaseTransport {
  /** Test/simulation only: as if a mobile device claimed this invitation, adding `device` to the pair. */
  simulateClaim(pairId: string, device: Device): void;
  /**
   * Test/simulation only: delivers `device` to the claim listener registered for `pairingId`, whatever
   * the record itself says.
   *
   * It models a transport that surfaced too much — the v2 `watchNewDevices` behaviour, or a future
   * regression in the filter — so `mobile-pairing.ts`'s own `pairingId` comparison stays exercised
   * rather than becoming dead code behind the seam that replaced it. Both layers are deliberate: the
   * filter is the design, the comparison is the check that survives a mistake in it.
   */
  simulateUnfilteredClaim(pairId: string, pairingId: string, device: Device): void;
  /** Test/simulation only: as if an existing device record changed (e.g. the phone revoked itself). */
  simulateDeviceUpdate(pairId: string, device: Device): void;
  /** Test/simulation only: what `getDevice` will answer — the authoritative state the receiver re-reads. */
  setRemoteDevice(pairId: string, device: Device): void;
  /** Test/simulation only: the lifecycle transitions this transport was asked to perform, in order. */
  getPairingCalls(): Array<{ call: string; pairId: string; deviceId: string; pairingId: string; detail?: string }>;
  /** Test/simulation only: pushes a command envelope into a pair's queue as if the mobile app sent it. */
  pushCommandEnvelope(pairId: string, envelope: EncryptedEnvelope): void;
  /** Test/simulation only: flips connection state and replays anything queued while disconnected. */
  simulateDisconnect(): void;
  simulateReconnect(): void;
  /** Test/simulation only: inspect what was actually sent, for assertions. */
  getSentEvents(pairId: string): NotificationEvent[];
  getSentResultEnvelopes(pairId: string): EncryptedEnvelope[];
  /** Every presence write the manager made, in order: what it published and for whom. */
  getPresenceUpdates(): Array<{ pairId: string; deviceId: string; status: "online" | "offline" }>;
  /** Test/simulation only: makes subsequent sendEvent() calls for this pair reject with MobileQuotaExceededError, as if the real deliverPush quota transaction (plan §7) rejected them, until cleared. */
  setQuotaExceeded(pairId: string, exceeded: boolean): void;
  /**
   * Test/simulation only: gives this pair a managed relay.
   *
   * A fake with no relay configured is the DEFAULT, and deliberately so: the overwhelming majority
   * of this repository's tests describe a desktop that has never heard of a relay, and they must
   * keep passing unchanged.
   */
  setRelayConnectorGrant(pairId: string, grant: RelayConnectorGrant | null): void;
}

export function createInMemoryMobileFirebaseTransport(
  options: { now?: () => number } = {},
): InMemoryMobileFirebaseTransport {
  const now = options.now || (() => Date.now());
  let connectionState: MobileConnectionState = "disconnected";
  const connectionListeners = new Set<(state: MobileConnectionState) => void>();
  const invitations = new Map<string, InMemoryInvitation>();
  const claimListenersByPair = new Map<string, Map<string, Set<(device: Device) => void>>>();
  const deviceUpdateListenersByPair = new Map<string, Set<(device: Device) => void>>();
  const remoteDevicesByPair = new Map<string, Map<string, Device>>();
  const pairingCalls: Array<{
    call: string;
    pairId: string;
    deviceId: string;
    pairingId: string;
    detail?: string;
  }> = [];
  const commandListenersByPair = new Map<string, Set<(envelope: EncryptedEnvelope) => void>>();
  const claimedCommandIds = new Set<string>();
  const sentEventsByPair = new Map<string, NotificationEvent[]>();
  const sentResultEnvelopesByPair = new Map<string, EncryptedEnvelope[]>();
  const presenceUpdates: Array<{ pairId: string; deviceId: string; status: "online" | "offline" }> = [];
  const relayGrantByPair = new Map<string, RelayConnectorGrant>();
  const quotaExceededPairs = new Set<string>();
  // Queued while disconnected — replayed to listeners on simulateReconnect(), the
  // in-memory stand-in for Firebase's own offline queue / RTDB replay.
  const queuedEnvelopesByPair = new Map<string, EncryptedEnvelope[]>();

  function setConnectionState(next: MobileConnectionState): void {
    if (connectionState === next) return;
    connectionState = next;
    for (const listener of connectionListeners) listener(next);
  }

  /** Applies a lifecycle transition to the recorded cloud record, if there is one. */
  function applyRemoteState(pairId: string, deviceId: string, patch: Partial<Device>): void {
    const remote = remoteDevicesByPair.get(pairId);
    const existing = remote?.get(deviceId);
    if (!remote || !existing) return;
    remote.set(deviceId, { ...existing, ...patch });
  }

  return {
    async connect() {
      setConnectionState("connected");
    },
    async disconnect() {
      setConnectionState("disconnected");
    },
    onConnectionStateChange(cb) {
      connectionListeners.add(cb);
      return () => connectionListeners.delete(cb);
    },

    async createInvitation(request) {
      if (connectionState !== "connected") throw new Error("transport disconnected");
      const pairingId = `pairing-${invitations.size + 1}`;
      const expiresAt = now() + 120_000;
      invitations.set(pairingId, { request, expiresAt });
      return { pairingId, expiresAt };
    },
    async cancelInvitation(pairingId) {
      invitations.delete(pairingId);
    },
    watchPairingClaim(pairId, pairingId, onClaim) {
      const byPairing = claimListenersByPair.get(pairId) || new Map<string, Set<(device: Device) => void>>();
      const listeners = byPairing.get(pairingId) || new Set<(device: Device) => void>();
      listeners.add(onClaim);
      byPairing.set(pairingId, listeners);
      claimListenersByPair.set(pairId, byPairing);
      return () => listeners.delete(onClaim);
    },

    watchDeviceUpdates(pairId, onDevice) {
      const listeners = deviceUpdateListenersByPair.get(pairId) || new Set<(device: Device) => void>();
      listeners.add(onDevice);
      deviceUpdateListenersByPair.set(pairId, listeners);
      return () => listeners.delete(onDevice);
    },

    async getDevice(pairId, deviceId) {
      return remoteDevicesByPair.get(pairId)?.get(deviceId) ?? null;
    },

    // The three lifecycle callables MOVE the recorded state, not just log the call. That matters
    // because the receiver re-reads the authoritative record immediately before a side effect
    // (review 3 §P0.3): a fake that recorded an approval without applying it would leave every
    // post-approval command refused, and a test written against it would be testing the fake.
    async attestPairingKeyProof(pairId, deviceId, pairingId) {
      pairingCalls.push({ call: "attestPairingKeyProof", pairId, deviceId, pairingId });
      applyRemoteState(pairId, deviceId, { state: "keyProven", keyProvenAt: now() });
    },

    async approvePairing(pairId, deviceId, pairingId, transcriptHash) {
      pairingCalls.push({ call: "approvePairing", pairId, deviceId, pairingId, detail: transcriptHash });
      applyRemoteState(pairId, deviceId, { state: "active", activatedAt: now() });
    },

    async rejectPairing(pairId, deviceId, pairingId, reason) {
      pairingCalls.push({ call: "rejectPairing", pairId, deviceId, pairingId, detail: reason });
      applyRemoteState(pairId, deviceId, { state: "revoked", revoked: true, revokedAt: now() });
    },

    async issueRelayConnectorGrant(pairId, connectorKeyFingerprint) {
      const configured = relayGrantByPair.get(pairId);
      if (!configured) throw new Error("issueRelayConnectorGrant rejected: the managed relay is not configured");
      return { ...configured, grant: `${configured.grant}:${connectorKeyFingerprint}` };
    },

    async revokeDevice(pairId, deviceId) {
      pairingCalls.push({ call: "revokeDevice", pairId, deviceId, pairingId: "" });
      applyRemoteState(pairId, deviceId, { state: "revoked", revoked: true, revokedAt: now() });
      const listeners = commandListenersByPair.get(pairId);
      if (listeners) listeners.clear();
    },

    async sendEvent(pairId, event) {
      if (connectionState !== "connected") throw new Error("transport disconnected");
      if (quotaExceededPairs.has(pairId)) throw new MobileQuotaExceededError();
      const list = sentEventsByPair.get(pairId) || [];
      list.push(event);
      sentEventsByPair.set(pairId, list);
    },
    watchCommandEnvelopes(pairId, onEnvelope) {
      const listeners = commandListenersByPair.get(pairId) || new Set();
      listeners.add(onEnvelope);
      commandListenersByPair.set(pairId, listeners);
      return () => listeners.delete(onEnvelope);
    },
    async claimCommand(pairId, commandId) {
      void pairId;
      if (claimedCommandIds.has(commandId)) return false;
      claimedCommandIds.add(commandId);
      return true;
    },
    async sendResultEnvelope(pairId, targetDeviceId, commandId, envelope) {
      void targetDeviceId;
      void commandId;
      const list = sentResultEnvelopesByPair.get(pairId) || [];
      list.push(envelope);
      sentResultEnvelopesByPair.set(pairId, list);
    },

    async updatePresence(pairId, deviceId, status) {
      // Recorded rather than ignored: whether the desktop publishes its own presence at all is the
      // behaviour under test (it did not, for the whole life of this feature — see MobileManager's
      // publishPresence), so a fake that swallowed the call could not have caught its absence.
      presenceUpdates.push({ pairId, deviceId, status });
    },

    simulateClaim(pairId, device) {
      // Filtered by pairingId, exactly as the real transport filters the stream: a test that simulates a
      // claim naming a different invitation must see it dropped before the pairing module, not by it.
      const listeners = claimListenersByPair.get(pairId)?.get(device.pairingId);
      if (listeners) for (const listener of listeners) listener(device);
      const remote = remoteDevicesByPair.get(pairId) || new Map<string, Device>();
      remote.set(device.deviceId, device);
      remoteDevicesByPair.set(pairId, remote);
    },

    simulateUnfilteredClaim(pairId, pairingId, device) {
      const listeners = claimListenersByPair.get(pairId)?.get(pairingId);
      if (listeners) for (const listener of listeners) listener(device);
    },

    simulateDeviceUpdate(pairId, device) {
      const remote = remoteDevicesByPair.get(pairId) || new Map<string, Device>();
      remote.set(device.deviceId, device);
      remoteDevicesByPair.set(pairId, remote);
      const listeners = deviceUpdateListenersByPair.get(pairId);
      if (listeners) for (const listener of listeners) listener(device);
    },

    setRelayConnectorGrant(pairId, grant) {
      if (grant) relayGrantByPair.set(pairId, grant);
      else relayGrantByPair.delete(pairId);
    },

    setRemoteDevice(pairId, device) {
      const remote = remoteDevicesByPair.get(pairId) || new Map<string, Device>();
      remote.set(device.deviceId, device);
      remoteDevicesByPair.set(pairId, remote);
    },

    getPairingCalls() {
      return [...pairingCalls];
    },
    pushCommandEnvelope(pairId, envelope) {
      if (connectionState !== "connected") {
        const queued = queuedEnvelopesByPair.get(pairId) || [];
        queued.push(envelope);
        queuedEnvelopesByPair.set(pairId, queued);
        return;
      }
      const listeners = commandListenersByPair.get(pairId);
      if (listeners) for (const listener of listeners) listener(envelope);
    },
    simulateDisconnect() {
      setConnectionState("disconnected");
    },
    simulateReconnect() {
      setConnectionState("connected");
      for (const [pairId, queued] of queuedEnvelopesByPair) {
        const listeners = commandListenersByPair.get(pairId);
        if (listeners) {
          for (const envelope of queued) {
            for (const listener of listeners) listener(envelope);
          }
        }
      }
      queuedEnvelopesByPair.clear();
    },
    getSentEvents(pairId) {
      return sentEventsByPair.get(pairId) || [];
    },
    getSentResultEnvelopes(pairId) {
      return sentResultEnvelopesByPair.get(pairId) || [];
    },
    getPresenceUpdates() {
      return presenceUpdates.slice();
    },
    setQuotaExceeded(pairId, exceeded) {
      if (exceeded) quotaExceededPairs.add(pairId);
      else quotaExceededPairs.delete(pairId);
    },
  };
}

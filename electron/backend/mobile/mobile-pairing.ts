/**
 * Pairing invitation creation and E2E handshake completion (plan §5.2).
 *
 * Talks to Firebase only through the narrow MobileFirebaseTransport seam
 * (mobile-firebase-transport.ts) — never a Firebase SDK directly — and uses
 * mobile-crypto.ts's fingerprint helper plus mobile-device-store.ts to
 * finish the handshake once a claim arrives.
 *
 * Replay/expiry defense in depth: the real cloud's claimPairing function is
 * the authoritative single-claim guard (atomic pending -> claimed transition,
 * secret hash check — see strideterm-mobile/cloud/functions/src/claim-pairing.ts).
 * This module additionally never trusts a second "new device" notification
 * for an invitation it already considers consumed or expired — the same
 * "cloud authorization alone is not enough" principle the plan applies to
 * command dispatch (§8) applies here too.
 */
import { randomBytes } from "node:crypto";
import { computeDesktopFingerprint, computeGrantCommitment, decodeCanonicalPublicKey } from "./mobile-crypto.js";
import type { MobileDeviceStore, NewDeviceInput } from "./mobile-device-store.js";
import type { MobileAuditLogStore } from "./mobile-audit-log-store.js";
import type { MobileFirebaseTransport } from "./mobile-firebase-transport.js";
import {
  PAIRING_KEY_PROOF_CHALLENGE_BYTES,
  PAIRING_SECRET_BYTES,
  PROTOCOL_VERSION,
  type Capability,
  type Device,
  type MobileDeviceRecord,
} from "./mobile-schemas.js";

export interface MobilePairingIdentity {
  /** This desktop's own device id — also the pairId, per the cloud's "pairId := desktopDeviceId" design. */
  deviceId: string;
  label: string;
  publicKeyBase64: string;
}

export interface MobilePairingDeps {
  transport: MobileFirebaseTransport;
  deviceStore: MobileDeviceStore;
  auditLogStore: MobileAuditLogStore;
  identity: MobilePairingIdentity;
  /**
   * Recomputes the claim's key proof with THIS desktop's private key and compares it, in constant
   * time, against the value on the record (review 3 §P0.1).
   *
   * Injected rather than done here because the private key lives with `MobileManager`, and pairing has
   * never needed it for anything else. What it buys is the property the whole state machine rests on:
   * only a device that holds the private key behind the public key it published, AND that scanned this
   * desktop's QR, can produce a proof this returns true for — so a device record inserted straight into
   * the database by anyone with Admin credentials cannot be adopted, whatever public key it chose.
   */
  verifyKeyProof: (args: { device: Device; pairingId: string; challengeBase64Url: string }) => boolean;
  now?: () => number;
}

export interface CreateInvitationOptions {
  profileAllowlist: string[];
  capabilities: Capability[];
}

/**
 * What the desktop encodes into the QR.
 *
 * **v2 carries the desktop's public key** (review 2 §P0.4). v1 carried a `desktopFingerprint`
 * string and nothing else about this desktop's identity; the phone showed those digits to the user
 * and then stored whatever `desktopPublicKey` the *backend* returned from `claimPairing`, without
 * ever checking that the stored key was the key the digits described. The human's comparison and
 * the app's pinning were joined by nothing but trust in the control plane. Now the key itself is
 * scanned, the fingerprint is a hash over a transcript containing it, and the phone recomputes that
 * hash locally before it will continue.
 */
export interface QrPairingPayload {
  protocolVersion: number;
  pairingId: string;
  secret: string;
  /**
   * A fresh 32-byte challenge, base64url, that exists ONLY in this QR (review 3 §P0.1).
   *
   * It never reaches the cloud in any form. The claiming device folds it into the key proof it submits,
   * so a valid proof is evidence of having physically scanned THIS code — which is what makes an
   * Admin-injected device record unadoptable rather than merely suspicious.
   */
  keyProofChallenge: string;
  /** This desktop's installation id — also the pairId, and part of the fingerprint transcript. */
  desktopDeviceId: string;
  desktopLabel: string;
  /** Canonical base64 of this desktop's 32-byte X25519 public key. */
  desktopPublicKey: string;
  desktopFingerprint: string;
  expiresAt: number;
}

export type ClaimRejectionReason =
  | "expired"
  | "already-consumed"
  | "device-limit-reached"
  | "pairing-id-mismatch"
  | "grant-commitment-mismatch"
  | "key-proof-failed";

export type ClaimOutcome =
  | {
      ok: true;
      device: MobileDeviceRecord;
      /** The invitation the device consumed — one of the values the pairing SAS commits to. */
      pairingId: string;
    }
  | { ok: false; reason: ClaimRejectionReason };

export interface PendingInvitationInfo {
  pairingId: string;
  expiresAt: number;
  /**
   * The grants the human ticked for this invitation.
   *
   * Exposed because they are what the grant commitment is computed over: a caller that needs to know
   * what a claim will be checked against — the Settings dialog rendering "this code grants…", or a test
   * building the record `claimPairing` would have written — must not have to guess them.
   */
  capabilities: Capability[];
  profileAllowlist: string[];
}

export function createMobilePairing(deps: MobilePairingDeps) {
  const now = deps.now || (() => Date.now());
  // Canonicalised once, here: every later use — the QR, the fingerprint transcript, the SAS, the
  // createInvitation call — must agree on one spelling of the key, because the transcript hashes
  // the STRING. `decodeCanonicalPublicKey` throws rather than normalising silently, so a desktop
  // that somehow held a malformed key fails at startup of the pairing flow, not at a mismatch the
  // user would read as "the phone is broken".
  const desktopPublicKey = decodeCanonicalPublicKey(deps.identity.publicKeyBase64).toString("base64");
  const desktopFingerprint = computeDesktopFingerprint({
    protocolVersion: PROTOCOL_VERSION,
    desktopDeviceId: deps.identity.deviceId,
    desktopPublicKeyBase64: desktopPublicKey,
  });
  const pairId = deps.identity.deviceId;

  interface PendingInvitation {
    pairingId: string;
    expiresAt: number;
    profileAllowlist: string[];
    capabilities: Capability[];
    /** The challenge this invitation's QR carried. Never persisted, never sent anywhere. */
    keyProofChallenge: string;
    consumed: boolean;
    unsubscribe: () => void;
  }
  let pending: PendingInvitation | null = null;
  const claimListeners = new Set<(outcome: ClaimOutcome) => void>();

  function notifyClaim(outcome: ClaimOutcome): void {
    for (const listener of claimListeners) listener(outcome);
  }

  /**
   * Records a refused claim and tells the listeners, without echoing anything the sender controls.
   *
   * `reason` is always one of `ClaimRejectionReason`'s fixed codes.
   */
  function rejectClaim(device: Device, reason: ClaimRejectionReason): void {
    deps.auditLogStore.logEntry({
      deviceId: device.deviceId,
      pairId,
      actor: "device",
      action: "pairing.claim-rejected",
      status: "failure",
      detail: reason,
    });
    notifyClaim({ ok: false, reason });
  }

  /**
   * Decides whether one claimed device record may be adopted into the invitation now pending.
   *
   * WHAT THIS USED TO BE, AND WHY IT WAS THE WORST DEFECT IN THE PRODUCT (review 3 §P0.1). The
   * previous version accepted ANY previously-unknown device record that appeared while an invitation
   * was open, and stamped it with that invitation's capabilities and profile allowlist. It compared
   * nothing: not the invitation the record was claimed under, not the grants the server had actually
   * recorded, and nothing cryptographic about the key in the record. Then the desktop sent an
   * encrypted challenge, the record echoed it, `verifiedAt` was set automatically, and the SAS screen's
   * only button hid the code.
   *
   * So with Admin credentials (or a stolen desktop refresh token) an attacker could pre-insert a device
   * record holding their own X25519 public key; the next time the user opened the pairing dialog for
   * any reason, this desktop would adopt it, grant it whatever the human had just ticked, derive a
   * session key with the attacker's key, and start encrypting real events to it. The SAS would not have
   * matched the user's actual phone — and nothing checked the SAS.
   *
   * Three comparisons close it, in the order that fails cheapest first:
   *
   *   1. `pairingId` — the record must name the invitation this desktop is waiting on. A stale record,
   *      or one claimed against a different invitation, is not this claim.
   *   2. the grant commitment — the server's digest of the grants it copied must equal the digest this
   *      desktop computes from the options the human ticked. Otherwise the cloud's idea of what this
   *      device may do and this desktop's idea of it were never compared.
   *   3. the key proof — recomputed with this desktop's private key over a transcript containing the
   *      QR's one-time challenge. This is the one an attacker cannot pass.
   */
  /**
   * Abandons the pending invitation, in the cloud as well as locally.
   *
   * Every rejection below reaches a state where this desktop will never accept a claim for that
   * invitation again — it has stopped watching and cleared `pending`. Leaving the cloud record
   * `pending` therefore leaves an invitation nobody can complete occupying the one active-invitation
   * slot (MAX_ACTIVE_PAIRING_INVITATIONS_PER_DESKTOP is 1), so the user pressing "Pair device" again
   * would be refused with `too-many-active` until the 120-second TTL ran out. Found by the cross-repo
   * scenario: a rejected claim blocked the next pairing attempt for two minutes.
   *
   * Best-effort, and deliberately not awaited into the rejection path's result: the invitation also
   * expires on its own, and a failure to cancel must not turn a refusal into an error.
   */
  function discardPending(invitation: PendingInvitation): void {
    invitation.unsubscribe();
    pending = null;
    void deps.transport.cancelInvitation(invitation.pairingId).catch(() => {});
  }

  async function processNewDevice(device: Device): Promise<void> {
    // A device this desktop already knows is not a claim of the invitation now pending.
    //
    // The claim watcher only surfaces records whose `pairingId` matches the pending invitation, but the
    // store check stays: it is what "this desktop has already paired you" actually means, and it
    // survives a reconnect and a restart, which a per-subscription set does not. (The bug that made
    // this necessary: `watchNewDevices` streamed the whole devices map on subscribe with a
    // per-subscription "seen" set, so every invitation on a desktop that already had a paired phone
    // replayed that phone as a fresh claim and consumed the invitation before the phone the user was
    // holding could use it.)
    if (deps.deviceStore.getDevice(device.deviceId)) return;

    const invitation = pending;
    if (!invitation || invitation.consumed) {
      rejectClaim(device, "already-consumed");
      return;
    }

    // (1) The invitation binding, BEFORE the invitation is consumed. A record claimed under some other
    // invitation must not burn this one — otherwise an attacker who can write a device record can deny
    // pairing indefinitely by consuming every invitation the user creates.
    if (device.pairingId !== invitation.pairingId) {
      rejectClaim(device, "pairing-id-mismatch");
      return;
    }

    // Consume immediately (before any await) so a second delivery in the
    // same tick can't slip through and double-add the device.
    invitation.consumed = true;

    if (invitation.expiresAt <= now()) {
      discardPending(invitation);
      rejectClaim(device, "expired");
      return;
    }

    // (2) The grants the server recorded must be the grants the human ticked.
    const expectedCommitment = computeGrantCommitment({
      protocolVersion: PROTOCOL_VERSION,
      pairId,
      pairingId: invitation.pairingId,
      mobileDeviceId: device.deviceId,
      capabilities: invitation.capabilities,
      profileAllowlist: invitation.profileAllowlist,
    });
    if (device.grantCommitment !== expectedCommitment) {
      discardPending(invitation);
      rejectClaim(device, "grant-commitment-mismatch");
      return;
    }

    // (3) The cryptographic proof. Everything above could be forged by whoever wrote the record; this
    // cannot, because it needs this desktop's private key and the QR's challenge.
    if (
      !deps.verifyKeyProof({
        device,
        pairingId: invitation.pairingId,
        challengeBase64Url: invitation.keyProofChallenge,
      })
    ) {
      discardPending(invitation);
      rejectClaim(device, "key-proof-failed");
      return;
    }

    const input: NewDeviceInput = {
      deviceId: device.deviceId,
      uid: device.uid,
      pairId: device.pairId,
      pairingId: device.pairingId,
      grantCommitment: device.grantCommitment,
      keyProof: device.keyProof,
      // The proof has just been verified, so the record starts at `keyProven` — one step short of
      // usable. It authorizes nothing: reaching `active` needs a human to compare the SAS.
      state: "keyProven",
      platform: device.platform,
      label: device.label,
      // The device's own fingerprint, over the same transcript shape the desktop's uses — so what
      // is shown next to a paired phone in Settings commits to that phone's key and id, not to a
      // bare hash of some bytes the cloud handed over.
      fingerprint: computeDesktopFingerprint({
        protocolVersion: PROTOCOL_VERSION,
        desktopDeviceId: device.deviceId,
        desktopPublicKeyBase64: device.publicKey,
      }),
      publicKey: device.publicKey,
      sessionKeyVersion: device.sessionKeyVersion,
      // From the invitation the human approved, not from the claim. claimPairing already refuses to
      // read a capability list off the request, and this is the desktop-side half of the same rule
      // (review 2 §P0.3).
      capabilities: invitation.capabilities,
      profileAllowlist: invitation.profileAllowlist,
      now: now(),
    };
    const result = await deps.deviceStore.addDevice(input);
    invitation.unsubscribe();
    pending = null;

    if (!result.ok) {
      // The record was claimed in the cloud but this desktop has no room for it, so the invitation is
      // spent from its point of view: cancel it rather than leave the active slot occupied.
      void deps.transport.cancelInvitation(invitation.pairingId).catch(() => {});
      deps.auditLogStore.logEntry({
        deviceId: device.deviceId,
        pairId,
        actor: "device",
        action: "pairing.claim-rejected",
        status: "failure",
        detail: result.reason,
      });
      notifyClaim({ ok: false, reason: result.reason });
      return;
    }

    deps.auditLogStore.logEntry({
      deviceId: device.deviceId,
      pairId,
      actor: "device",
      action: "pairing.key-proven",
      status: "success",
    });
    // Tell the cloud the proof checked out, so `approvePairing` has the `keyProven` precondition it
    // requires. Best-effort and deliberately not fatal: the local record is already `keyProven`, and the
    // activation call will fail loudly on its own if this did not land — which is the right failure,
    // because a device the cloud still thinks is merely `claimed` cannot be activated by anyone.
    try {
      await deps.transport.attestPairingKeyProof(pairId, device.deviceId, invitation.pairingId);
    } catch {
      deps.auditLogStore.logEntry({
        deviceId: device.deviceId,
        pairId,
        actor: "desktop",
        action: "pairing.key-proof-attestation-failed",
        status: "failure",
      });
    }
    notifyClaim({ ok: true, device: result.device, pairingId: invitation.pairingId });
  }

  async function cancelInvitation(): Promise<void> {
    if (!pending) return;
    const pairingId = pending.pairingId;
    pending.unsubscribe();
    pending = null;
    await deps.transport.cancelInvitation(pairingId);
    deps.auditLogStore.logEntry({
      deviceId: "",
      pairId,
      actor: "desktop",
      action: "pairing.invitation-canceled",
      status: "success",
    });
  }

  return {
    /**
     * Creates a new pairing invitation. Only one may be active at a time
     * (mirrors MAX_ACTIVE_PAIRING_INVITATIONS_PER_DESKTOP=1) — creating a
     * new one cancels whatever was still pending, matching the desktop UX
     * of a single "Pair device" QR dialog.
     */
    async createInvitation(options: CreateInvitationOptions): Promise<QrPairingPayload> {
      if (pending) {
        await cancelInvitation();
      }
      const secret = randomBytes(PAIRING_SECRET_BYTES).toString("base64url");
      // The one-time key-proof challenge. Generated here, put in the QR, and never sent to the cloud in
      // any form — which is what makes a valid key proof evidence that the claiming device physically
      // scanned this code (review 3 §P0.1).
      const keyProofChallenge = randomBytes(PAIRING_KEY_PROOF_CHALLENGE_BYTES).toString("base64url");
      const response = await deps.transport.createInvitation({
        desktopDeviceId: deps.identity.deviceId,
        desktopLabel: deps.identity.label,
        desktopFingerprint,
        desktopPublicKey,
        secret,
        // The grants the human ticked, frozen onto the invitation server-side. claimPairing copies
        // these onto the device record and ignores anything the claiming phone sends.
        approvedCapabilities: [...options.capabilities],
        approvedProfileAllowlist: [...options.profileAllowlist],
      });
      // The CONCRETE claim, not the whole devices map (review 3 §P0.1: "Nahradit broad adoption
      // watcher konkrétním claim watcherem"). The transport filters on `pairingId`, so a record claimed
      // under a different invitation — or one that predates this invitation entirely — never reaches
      // this callback at all, rather than being rejected inside it.
      const unsubscribe = deps.transport.watchPairingClaim(pairId, response.pairingId, (device) => {
        void processNewDevice(device);
      });
      pending = {
        pairingId: response.pairingId,
        expiresAt: response.expiresAt,
        profileAllowlist: [...options.profileAllowlist],
        capabilities: [...options.capabilities],
        keyProofChallenge,
        consumed: false,
        unsubscribe,
      };
      deps.auditLogStore.logEntry({
        deviceId: "",
        pairId,
        actor: "desktop",
        action: "pairing.invitation-created",
        status: "success",
      });
      return {
        protocolVersion: PROTOCOL_VERSION,
        pairingId: response.pairingId,
        secret,
        keyProofChallenge,
        desktopDeviceId: deps.identity.deviceId,
        desktopLabel: deps.identity.label,
        desktopPublicKey,
        desktopFingerprint,
        expiresAt: response.expiresAt,
      };
    },

    cancelInvitation,

    /** Subscribes to claim outcomes (success or rejection) for whatever invitation is/was pending. Returns an unsubscribe function. */
    onClaim(listener: (outcome: ClaimOutcome) => void): () => void {
      claimListeners.add(listener);
      return () => claimListeners.delete(listener);
    },

    getPendingInvitation(): PendingInvitationInfo | null {
      return pending
        ? {
            pairingId: pending.pairingId,
            expiresAt: pending.expiresAt,
            capabilities: [...pending.capabilities],
            profileAllowlist: [...pending.profileAllowlist],
          }
        : null;
    },

    /**
     * This desktop's own canonical public key and the fingerprint committing to it.
     *
     * Exposed so MobileManager can compute the pairing SAS from the same values the QR carried —
     * both sides must derive that code from the transcript, not from anything a backend returned
     * (review 2 §P0.4).
     */
    getDesktopIdentity(): { deviceId: string; publicKeyBase64: string; fingerprint: string } {
      return { deviceId: deps.identity.deviceId, publicKeyBase64: desktopPublicKey, fingerprint: desktopFingerprint };
    },
  };
}

export type MobilePairing = ReturnType<typeof createMobilePairing>;

import { randomBytes, randomUUID, type KeyObject } from "node:crypto";
import {
  PEER_PAIRING_TTL_MS,
  type PeerApproveResult,
  type PeerDeviceRecord,
  type PeerIntegrationSettings,
  type PeerPairBegin,
  type PeerPairBeginResult,
  type PeerPairReveal,
  type PeerPairStatusResult,
  type PeerPairingState,
  type PeerPendingPairing,
} from "../../shared/peers.js";
import {
  exportPrivateKeyPem,
  exportRawPublicKey,
  generateX25519KeyPair,
  importPrivateKeyPem,
  type X25519KeyPair,
} from "../mobile/mobile-crypto.js";
import { getLogger } from "../logger.js";
import type { CredentialStore } from "../shared/credential-store.js";
import {
  PEER_PAIRING_IDENTITY,
  PEER_PAIRING_PSK,
  computePeerSas,
  derivePeerPsk,
  peerCommitmentMatches,
  peerSasMatches,
} from "./peer-crypto.js";

const log = getLogger("peers");

export const PEER_HOST_KEY_REF = "peer:identity:key";

const MAX_PENDING = 8;
const MAX_PENDING_PER_ADDRESS = 3;
const SEEN_PERSIST_INTERVAL_MS = 60_000;

export type PeerPairingErrorCode =
  "hosting-disabled" | "too-many-requests" | "not-found" | "commitment-mismatch" | "storage-unavailable";

export class PeerPairingError extends Error {
  constructor(
    readonly code: PeerPairingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PeerPairingError";
  }
}

export type PeerHostEvent = "peers:pairing-progress" | "peers:updated" | "peers:device-removed";

export interface PeerHostDeps {
  getSettings(): PeerIntegrationSettings;
  /** Persists through the state store; the callback mutates a draft of `settings.integrations.peers`. */
  updateSettings(reason: string, update: (draft: PeerIntegrationSettings) => void): Promise<void>;
  credentials: Pick<CredentialStore, "getSecret" | "setSecret" | "isEncryptionAvailable">;
  appVersion: string;
  hostName(): string;
  emit(event: PeerHostEvent, payload: unknown): void;
  now?(): number;
  randomId?(): string;
}

export interface PeerHost {
  ensureIdentity(): Promise<{ instanceId: string; publicKey: string }>;
  pskForIdentity(identity: string): Buffer | null;
  beginPairing(input: PeerPairBegin, remoteAddress: string): Promise<PeerPairBeginResult>;
  revealPairing(input: PeerPairReveal): { ok: true };
  pairingStatus(pairingId: string): PeerPairStatusResult;
  listPending(): PeerPendingPairing[];
  approvePairing(pairingId: string, typedCode: string): Promise<PeerApproveResult>;
  rejectPairing(pairingId: string): boolean;
  listDevices(): PeerDeviceRecord[];
  removeDevice(deviceId: string): Promise<boolean>;
  noteDeviceSeen(deviceId: string, address: string): void;
}

interface Pairing {
  pairingId: string;
  deviceId: string;
  name: string;
  platform: string;
  appVersion: string;
  address: string;
  createdAt: number;
  expiresAt: number;
  state: PeerPairingState;
  commitment: string;
  hostInstanceId: string;
  hostPublicKey: string;
  hostNonce: string;
  devicePublicKey: string;
  deviceNonce: string;
}

interface LoadedIdentity {
  instanceId: string;
  publicKey: string;
  privateKey: KeyObject;
}

const isLive = (pairing: Pairing) => pairing.state === "awaiting-reveal" || pairing.state === "awaiting-approval";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPeerHost(deps: PeerHostDeps): PeerHost {
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? randomUUID;
  const pairings = new Map<string, Pairing>();
  const pskCache = new Map<string, { publicKey: string; psk: Buffer }>();
  const lastSeenPersisted = new Map<string, number>();
  let identity: LoadedIdentity | null = null;
  let identityInFlight: Promise<LoadedIdentity> | null = null;

  function sweep(): void {
    const current = now();
    for (const [id, pairing] of pairings) {
      if (pairing.expiresAt <= current) pairings.delete(id);
    }
  }

  async function loadIdentity(): Promise<LoadedIdentity> {
    const stored = deps.credentials.getSecret(PEER_HOST_KEY_REF);
    let keys: X25519KeyPair;
    if (stored) {
      try {
        keys = importPrivateKeyPem(stored);
      } catch (error) {
        log.error("stored peer identity key cannot be read; not replacing it", { err: errorText(error) });
        throw new Error("The stored peer identity key cannot be read. Replacing it would unpair every device.", {
          cause: error,
        });
      }
    } else {
      if (!deps.credentials.isEncryptionAvailable()) {
        throw new PeerPairingError(
          "storage-unavailable",
          "Secure storage is required to attach profiles between desktops, and it is not available on this machine.",
        );
      }
      keys = generateX25519KeyPair();
      try {
        await deps.credentials.setSecret(PEER_HOST_KEY_REF, exportPrivateKeyPem(keys.privateKey), {
          requireEncryptedStorage: true,
        });
      } catch (error) {
        log.warn("peer identity key could not be stored", { err: errorText(error) });
        throw new PeerPairingError(
          "storage-unavailable",
          "Secure storage is required to attach profiles between desktops, and the key could not be stored.",
        );
      }
    }
    if (!deps.getSettings().instanceId) {
      const minted = randomId();
      await deps.updateSettings("peers:instance-id", (draft) => {
        if (!draft.instanceId) draft.instanceId = minted;
      });
    }
    return {
      instanceId: deps.getSettings().instanceId,
      publicKey: exportRawPublicKey(keys.publicKey).toString("base64"),
      privateKey: keys.privateKey,
    };
  }

  function ensureLoaded(): Promise<LoadedIdentity> {
    if (identity) return Promise.resolve(identity);
    identityInFlight ??= loadIdentity()
      .then((loaded) => {
        identity = loaded;
        return loaded;
      })
      .finally(() => {
        identityInFlight = null;
      });
    return identityInFlight;
  }

  function pskForDevice(device: PeerDeviceRecord, loaded: LoadedIdentity): Buffer | null {
    const cached = pskCache.get(device.id);
    if (cached && cached.publicKey === device.publicKey) return cached.psk;
    try {
      const psk = derivePeerPsk({
        privateKey: loaded.privateKey,
        remotePublicKey: device.publicKey,
        hostInstanceId: loaded.instanceId,
        deviceId: device.id,
      });
      pskCache.set(device.id, { publicKey: device.publicKey, psk });
      return psk;
    } catch {
      return null;
    }
  }

  return {
    async ensureIdentity() {
      const loaded = await ensureLoaded();
      return { instanceId: loaded.instanceId, publicKey: loaded.publicKey };
    },

    pskForIdentity(requested) {
      if (!identity || !deps.getSettings().hosting.enabled) return null;
      if (requested === PEER_PAIRING_IDENTITY) return PEER_PAIRING_PSK;
      const device = deps.getSettings().devices.find((entry) => entry.id === requested);
      return device ? pskForDevice(device, identity) : null;
    },

    async beginPairing(input, remoteAddress) {
      sweep();
      if (!deps.getSettings().hosting.enabled) {
        throw new PeerPairingError("hosting-disabled", "Attaching profiles is turned off on this desktop.");
      }
      const loaded = await ensureLoaded();
      sweep();
      const replaced = [...pairings.values()].filter(
        (pairing) => pairing.deviceId === input.deviceId && isLive(pairing),
      );
      const live = [...pairings.values()].filter((pairing) => isLive(pairing) && !replaced.includes(pairing));
      if (
        live.length >= MAX_PENDING ||
        live.filter((pairing) => pairing.address === remoteAddress).length >= MAX_PENDING_PER_ADDRESS
      ) {
        throw new PeerPairingError("too-many-requests", "Too many pairing requests are waiting. Try again later.");
      }
      for (const pairing of replaced) pairings.delete(pairing.pairingId);
      const created = now();
      const pairing: Pairing = {
        pairingId: randomId(),
        deviceId: input.deviceId,
        name: input.name,
        platform: input.platform,
        appVersion: input.appVersion,
        address: remoteAddress,
        createdAt: created,
        expiresAt: created + PEER_PAIRING_TTL_MS,
        state: "awaiting-reveal",
        commitment: input.commitment,
        hostInstanceId: loaded.instanceId,
        hostPublicKey: loaded.publicKey,
        hostNonce: randomBytes(32).toString("base64"),
        devicePublicKey: "",
        deviceNonce: "",
      };
      pairings.set(pairing.pairingId, pairing);
      log.info("pairing started", {
        pairingId: pairing.pairingId,
        deviceId: pairing.deviceId,
        platform: pairing.platform,
        address: remoteAddress,
      });
      return {
        pairingId: pairing.pairingId,
        hostInstanceId: loaded.instanceId,
        hostName: deps.hostName(),
        appVersion: deps.appVersion,
        hostPublicKey: loaded.publicKey,
        hostNonce: pairing.hostNonce,
      };
    },

    revealPairing(input) {
      sweep();
      const pairing = pairings.get(input.pairingId);
      if (!pairing || pairing.state !== "awaiting-reveal") {
        throw new PeerPairingError("not-found", "This pairing request is no longer available.");
      }
      let matches: boolean;
      try {
        matches = peerCommitmentMatches(pairing.commitment, {
          deviceId: pairing.deviceId,
          publicKey: input.publicKey,
          nonce: input.nonce,
        });
      } catch {
        matches = false;
      }
      if (!matches) {
        pairing.state = "rejected";
        log.warn("pairing rejected: reveal does not match the commitment", {
          pairingId: pairing.pairingId,
          deviceId: pairing.deviceId,
          address: pairing.address,
        });
        throw new PeerPairingError("commitment-mismatch", "The pairing request did not match its commitment.");
      }
      pairing.devicePublicKey = input.publicKey;
      pairing.deviceNonce = input.nonce;
      pairing.state = "awaiting-approval";
      log.info("pairing revealed", { pairingId: pairing.pairingId, deviceId: pairing.deviceId });
      deps.emit("peers:pairing-progress", { pairingId: pairing.pairingId, state: pairing.state });
      return { ok: true };
    },

    pairingStatus(pairingId) {
      sweep();
      return { state: pairings.get(pairingId)?.state ?? "expired" };
    },

    listPending() {
      sweep();
      return [...pairings.values()].filter(isLive).map((pairing) => ({
        pairingId: pairing.pairingId,
        deviceId: pairing.deviceId,
        name: pairing.name,
        platform: pairing.platform,
        appVersion: pairing.appVersion,
        address: pairing.address,
        createdAt: pairing.createdAt,
        sasReady: pairing.state === "awaiting-approval",
      }));
    },

    async approvePairing(pairingId, typedCode) {
      sweep();
      const pairing = pairings.get(pairingId);
      if (!pairing || pairing.state !== "awaiting-approval") return "not-found";
      const expected = computePeerSas({
        pairingId: pairing.pairingId,
        hostInstanceId: pairing.hostInstanceId,
        hostPublicKey: pairing.hostPublicKey,
        hostNonce: pairing.hostNonce,
        deviceId: pairing.deviceId,
        devicePublicKey: pairing.devicePublicKey,
        deviceNonce: pairing.deviceNonce,
      });
      if (!peerSasMatches(expected, typedCode)) {
        pairing.state = "rejected";
        log.warn("pairing refused: wrong code typed", {
          pairingId: pairing.pairingId,
          deviceId: pairing.deviceId,
          address: pairing.address,
        });
        deps.emit("peers:pairing-progress", { pairingId: pairing.pairingId, state: pairing.state });
        return "sas-mismatch";
      }
      const paired = now();
      const device: PeerDeviceRecord = {
        id: pairing.deviceId,
        name: pairing.name,
        platform: pairing.platform,
        publicKey: pairing.devicePublicKey,
        pairedAt: paired,
        lastSeenAt: paired,
        lastAddress: pairing.address.slice(0, 64),
      };
      await deps.updateSettings("peers:device-paired", (draft) => {
        const index = draft.devices.findIndex((entry) => entry.id === device.id);
        if (index >= 0) draft.devices[index] = device;
        else draft.devices.push(device);
      });
      pskCache.delete(device.id);
      pairing.state = "approved";
      log.info("pairing approved", {
        pairingId: pairing.pairingId,
        deviceId: device.id,
        platform: device.platform,
        address: pairing.address,
      });
      deps.emit("peers:pairing-progress", { pairingId: pairing.pairingId, state: pairing.state });
      deps.emit("peers:updated", {});
      return "approved";
    },

    rejectPairing(pairingId) {
      sweep();
      const pairing = pairings.get(pairingId);
      if (!pairing || !isLive(pairing)) return false;
      pairing.state = "rejected";
      log.info("pairing rejected", { pairingId, deviceId: pairing.deviceId });
      deps.emit("peers:pairing-progress", { pairingId, state: pairing.state });
      return true;
    },

    listDevices() {
      return deps.getSettings().devices.map((device) => ({ ...device }));
    },

    async removeDevice(deviceId) {
      const existing = deps.getSettings().devices.find((device) => device.id === deviceId);
      if (!existing) return false;
      await deps.updateSettings("peers:device-removed", (draft) => {
        draft.devices = draft.devices.filter((device) => device.id !== deviceId);
      });
      pskCache.delete(deviceId);
      lastSeenPersisted.delete(deviceId);
      log.info("device removed", { deviceId, platform: existing.platform });
      deps.emit("peers:device-removed", { deviceId });
      deps.emit("peers:updated", {});
      return true;
    },

    noteDeviceSeen(deviceId, address) {
      try {
        const current = now();
        const last = lastSeenPersisted.get(deviceId);
        if (last !== undefined && current - last < SEEN_PERSIST_INTERVAL_MS) return;
        if (!deps.getSettings().devices.some((device) => device.id === deviceId)) return;
        lastSeenPersisted.set(deviceId, current);
        deps
          .updateSettings("peers:device-seen", (draft) => {
            const device = draft.devices.find((entry) => entry.id === deviceId);
            if (!device) return;
            device.lastSeenAt = current;
            device.lastAddress = address.slice(0, 64);
          })
          .catch((error: unknown) => {
            log.warn("device last-seen could not be saved", { deviceId, err: errorText(error) });
          });
      } catch (error) {
        log.warn("device last-seen could not be saved", { deviceId, err: errorText(error) });
      }
    },
  };
}

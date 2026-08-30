/**
 * Device metadata + revocation state for paired mobile devices.
 *
 * Persistence: the main atomically-written state JSON (store.mutate /
 * store.getState — see store.ts), NOT a separate SQLite database. Plan
 * §10.4 is explicit that device records (id/label/platform/timestamps/
 * fingerprint/capability+profile allowlist/revocation status/notification
 * filter prefs) belong in the main state blob, the same way Telegram
 * connections live in state.settings.integrations.telegram.connections.
 * SQLite (mirroring telegram-audit-log-store.ts) is reserved here for
 * mobile-idempotency-store.ts / mobile-audit-log-store.ts — data that is
 * explicitly NOT part of the main state blob.
 *
 * This module itself is pure (no I/O): it operates on a MobileDeviceRecord[]
 * array and returns new arrays/records. createMobileDeviceStore() below is
 * the thin factory that wires those pure functions to an injected
 * getState/mutate pair (store.mutate has the same atomic tmp+rename+lock
 * write path as every other durable state in this app).
 */
import { randomUUID } from "node:crypto";
import { MAX_PAIRED_MOBILE_DEVICES_PER_DESKTOP } from "./mobile-schemas.js";
import type {
  Capability,
  DeviceState,
  MobileDeviceRecord,
  MobileNotificationFilter,
  Platform,
} from "./mobile-schemas.js";

export function listActiveDevices(devices: MobileDeviceRecord[]): MobileDeviceRecord[] {
  return devices.filter((d) => !d.revoked);
}

export function findDevice(devices: MobileDeviceRecord[], deviceId: string): MobileDeviceRecord | null {
  return devices.find((d) => d.deviceId === deviceId) || null;
}

/**
 * The single predicate every authorization path asks (review 3 §P0.1).
 *
 * `!device.revoked` was not enough, and that gap is the whole of the pairing defect: a record that had
 * been claimed — or one whose key proof had been verified automatically — was `revoked === false`, and
 * `MobileCommandDispatcher.dispatch` never looked at anything else. `state === "active"` means a human
 * compared the SAS on this desktop and the cloud committed the activation.
 */
export function isDeviceUsable(device: MobileDeviceRecord | null): device is MobileDeviceRecord {
  return !!device && !device.revoked && device.state === "active";
}

/** Devices that are `active` — what the outbox iterates, and what the UI counts. */
export function listUsableDevices(devices: MobileDeviceRecord[]): MobileDeviceRecord[] {
  return devices.filter((d) => isDeviceUsable(d));
}

/** Devices waiting for a human decision, so the UI can show the SAS prompt again after a restart. */
export function listPendingApprovalDevices(devices: MobileDeviceRecord[]): MobileDeviceRecord[] {
  return devices.filter((d) => !d.revoked && (d.state === "keyProven" || d.state === "userApproved"));
}

export interface NewDeviceInput {
  deviceId: string;
  uid: string;
  pairId: string;
  /** The invitation this device claimed. Only a claim naming the pending invitation is adopted. */
  pairingId: string;
  /** The server's digest of the approved grants, as this desktop verified it. */
  grantCommitment: string;
  /** The claim-time key proof, as submitted — kept for the audit trail. */
  keyProof: string;
  /**
   * Where the record starts. Callers pass `"keyProven"` when they have already verified the key proof
   * (which `mobile-pairing.ts` does before it adds anything at all) and `"claimed"` otherwise. Never
   * `"active"`: only a human's approval reaches that, through `MobileManager.approveDevice`.
   */
  state: Extract<DeviceState, "claimed" | "keyProven">;
  platform: Platform;
  label: string;
  fingerprint: string;
  publicKey: string;
  /** Which generation of `publicKey` this record pins — part of the AAD and of the key lookup. */
  sessionKeyVersion: number;
  /**
   * The grants the human approved in the pairing dialog. Typed as the closed `Capability` enum, not
   * `string[]`: it is what every later authorization decision reads, and the value it is compared
   * against comes from COMMAND_POLICY, so an arbitrary string here could only ever be dead weight or
   * a typo that silently denies everything (review 2 §P0.3).
   */
  capabilities: Capability[];
  profileAllowlist: string[];
  now: number;
}

export type AddDeviceResult =
  | { ok: true; devices: MobileDeviceRecord[]; device: MobileDeviceRecord }
  | { ok: false; reason: "device-limit-reached" };

/**
 * Adds a newly-claimed device, enforcing MAX_PAIRED_MOBILE_DEVICES_PER_DESKTOP
 * against currently-active (non-revoked) devices — mirrors
 * claim-pairing-core.ts's devicesTransactionUpdate so the desktop-local cap
 * agrees with the cloud-enforced one. Idempotent on deviceId: re-adding an
 * already-present device is a no-op success (a retried/replayed claim).
 */
export function addDevice(devices: MobileDeviceRecord[], input: NewDeviceInput): AddDeviceResult {
  const existing = findDevice(devices, input.deviceId);
  if (existing) {
    return { ok: true, devices, device: existing };
  }
  if (listActiveDevices(devices).length >= MAX_PAIRED_MOBILE_DEVICES_PER_DESKTOP) {
    return { ok: false, reason: "device-limit-reached" };
  }
  const device: MobileDeviceRecord = {
    deviceId: input.deviceId,
    uid: input.uid,
    pairId: input.pairId,
    pairingId: input.pairingId,
    grantCommitment: input.grantCommitment,
    keyProof: input.keyProof,
    // Claimed or keyProven — never active. Reaching `active` takes a human pressing "Codes match" and
    // the cloud confirming it (review 3 §P0.1); until then this record authorizes nothing at all: no
    // event is sent to it, no command from it is dispatched, and no WebView ticket is issued.
    state: input.state,
    platform: input.platform,
    label: input.label,
    fingerprint: input.fingerprint,
    publicKey: input.publicKey,
    sessionKeyVersion: input.sessionKeyVersion,
    capabilities: [...input.capabilities],
    profileAllowlist: [...input.profileAllowlist],
    createdAt: input.now,
    lastSeenAt: input.now,
    revoked: false,
    revokedAt: null,
    notificationFilter: { minPriority: "low", mutedKinds: [] },
    verifiedAt: input.state === "keyProven" ? input.now : null,
    activatedAt: null,
  };
  return { ok: true, devices: [...devices, device], device };
}

/**
 * Idempotent, and monotonic: revoking an already-revoked device is a no-op, and there is no branch here
 * that can move a record out of `revoked` (review 3 §P0.3 — "revoked se nikdy nesmí vrátit na active
 * ani starším stream eventem"). `state` moves with `revoked`, so the two flags cannot disagree.
 */
export function revokeDevice(devices: MobileDeviceRecord[], deviceId: string, now: number): MobileDeviceRecord[] {
  return devices.map((d) =>
    d.deviceId === deviceId && !d.revoked ? { ...d, state: "revoked" as const, revoked: true, revokedAt: now } : d,
  );
}

export function touchLastSeen(devices: MobileDeviceRecord[], deviceId: string, now: number): MobileDeviceRecord[] {
  return devices.map((d) => (d.deviceId === deviceId ? { ...d, lastSeenAt: now } : d));
}

/**
 * Records that the human pressed "Codes match — activate" but the cloud has not confirmed yet.
 *
 * This is what makes review 3 §P0.1's restart case answerable: a desktop killed between the click and
 * `approvePairing` returning finds the record in `userApproved`, which is NOT active — so the device
 * still cannot do anything — and can either retry the activation or reject it. Nothing else in the
 * codebase treats `userApproved` as authorization; `isDeviceUsable` and every dispatch path ask for
 * `active`.
 */
export function markUserApproved(devices: MobileDeviceRecord[], deviceId: string): MobileDeviceRecord[] {
  return devices.map((d) =>
    d.deviceId === deviceId && d.state === "keyProven" ? { ...d, state: "userApproved" as const } : d,
  );
}

/**
 * The device is live: a human compared the codes and the cloud committed the activation.
 *
 * Only reachable from `keyProven` or `userApproved`. A `claimed` record cannot jump here, which is the
 * local half of "key proof and human approval are separate steps" — the cloud's `approvePairing`
 * enforces the same ordering independently.
 */
export function markActive(devices: MobileDeviceRecord[], deviceId: string, now: number): MobileDeviceRecord[] {
  return devices.map((d) =>
    d.deviceId === deviceId && (d.state === "keyProven" || d.state === "userApproved")
      ? { ...d, state: "active" as const, activatedAt: now }
      : d,
  );
}

/**
 * Applies an authoritative cloud state to the local record — the desktop half of review 3 §P0.3's
 * revoke synchronisation.
 *
 * DELIBERATELY ONE-WAY. The only transition it performs is INTO `revoked`; a cloud record that still
 * says `active` never resurrects a locally-revoked one, and a cloud record that says `active` for a
 * device this desktop has not approved does not activate it either. `watchNewDevices` used to add a
 * device id to a `seen` set on first sight and ignore every later change, so a revoke performed by the
 * phone (or by another window) was invisible to this desktop until a restart — and a command that was
 * already queued could then be executed against a local record that still said active.
 */
export function applyRemoteRevocation(
  devices: MobileDeviceRecord[],
  deviceId: string,
  now: number,
): MobileDeviceRecord[] {
  return revokeDevice(devices, deviceId, now);
}

/** Renames a device's desktop-local display label (plan §10.5 "list/revoke/rename device"). Unknown deviceId is a no-op. */
export function renameDevice(devices: MobileDeviceRecord[], deviceId: string, label: string): MobileDeviceRecord[] {
  return devices.map((d) => (d.deviceId === deviceId ? { ...d, label } : d));
}

export function updateAllowlist(
  devices: MobileDeviceRecord[],
  deviceId: string,
  update: { capabilities?: Capability[]; profileAllowlist?: string[] },
): MobileDeviceRecord[] {
  return devices.map((d) =>
    d.deviceId === deviceId
      ? {
          ...d,
          capabilities: update.capabilities ? [...update.capabilities] : d.capabilities,
          profileAllowlist: update.profileAllowlist ? [...update.profileAllowlist] : d.profileAllowlist,
        }
      : d,
  );
}

export function updateNotificationFilter(
  devices: MobileDeviceRecord[],
  deviceId: string,
  filter: MobileNotificationFilter,
): MobileDeviceRecord[] {
  return devices.map((d) => (d.deviceId === deviceId ? { ...d, notificationFilter: filter } : d));
}

export function deviceHasCapability(device: MobileDeviceRecord, capability: string): boolean {
  return (device.capabilities as readonly string[]).includes(capability);
}

export function deviceAllowsProfile(device: MobileDeviceRecord, profileId: string): boolean {
  return device.profileAllowlist.includes(profileId);
}

/** Generates a fresh device id — used desktop-side for its own device identity, never for mobile devices (those bring their own). */
export function generateDeviceId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Stateful factory — wires the pure functions above to injected state access.
// ---------------------------------------------------------------------------

export interface MobileDeviceStoreDeps {
  getDevices: () => MobileDeviceRecord[];
  /** Mutator matching store.mutate's shape: applies fn to the devices array, persists, returns the new array. */
  mutateDevices: (fn: (devices: MobileDeviceRecord[]) => MobileDeviceRecord[]) => Promise<MobileDeviceRecord[]>;
}

export function createMobileDeviceStore(deps: MobileDeviceStoreDeps) {
  return {
    listDevices(): MobileDeviceRecord[] {
      return deps.getDevices();
    },
    listActiveDevices(): MobileDeviceRecord[] {
      return listActiveDevices(deps.getDevices());
    },
    getDevice(deviceId: string): MobileDeviceRecord | null {
      return findDevice(deps.getDevices(), deviceId);
    },
    async addDevice(input: NewDeviceInput): Promise<AddDeviceResult> {
      const result = addDevice(deps.getDevices(), input);
      if (!result.ok) return result;
      await deps.mutateDevices(() => result.devices);
      return result;
    },
    async revokeDevice(deviceId: string, now = Date.now()): Promise<void> {
      await deps.mutateDevices((devices) => revokeDevice(devices, deviceId, now));
    },
    async touchLastSeen(deviceId: string, now = Date.now()): Promise<void> {
      await deps.mutateDevices((devices) => touchLastSeen(devices, deviceId, now));
    },
    async renameDevice(deviceId: string, label: string): Promise<void> {
      await deps.mutateDevices((devices) => renameDevice(devices, deviceId, label));
    },
    async updateAllowlist(
      deviceId: string,
      update: { capabilities?: Capability[]; profileAllowlist?: string[] },
    ): Promise<void> {
      await deps.mutateDevices((devices) => updateAllowlist(devices, deviceId, update));
    },
    async updateNotificationFilter(deviceId: string, filter: MobileNotificationFilter): Promise<void> {
      await deps.mutateDevices((devices) => updateNotificationFilter(devices, deviceId, filter));
    },
    listUsableDevices(): MobileDeviceRecord[] {
      return listUsableDevices(deps.getDevices());
    },
    listPendingApprovalDevices(): MobileDeviceRecord[] {
      return listPendingApprovalDevices(deps.getDevices());
    },
    async markUserApproved(deviceId: string): Promise<void> {
      await deps.mutateDevices((devices) => markUserApproved(devices, deviceId));
    },
    async markActive(deviceId: string, now = Date.now()): Promise<void> {
      await deps.mutateDevices((devices) => markActive(devices, deviceId, now));
    },
    async applyRemoteRevocation(deviceId: string, now = Date.now()): Promise<void> {
      await deps.mutateDevices((devices) => applyRemoteRevocation(devices, deviceId, now));
    },
  };
}

export type MobileDeviceStore = ReturnType<typeof createMobileDeviceStore>;

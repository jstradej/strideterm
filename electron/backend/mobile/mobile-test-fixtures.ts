/**
 * Shared device-record fixtures for the mobile backend tests.
 *
 * It exists because review 3 §P0.1 added five required fields to both record shapes — the cloud
 * `Device` (`pairingId`, `state`, `grantCommitment`, `keyProof`, `keyProvenAt`/`activatedAt`) and the
 * desktop's `MobileDeviceRecord` — and eight test files each carried their own hand-written builder.
 * Eight copies means the next field lands as eight identical edits and, worse, that a test can keep
 * asserting against a record shape production no longer writes.
 *
 * Not under a `test/` directory because the desktop repo keeps its tests beside the code they cover and
 * `tsconfig.backend.json` excludes `*.test.ts` rather than a directory; a `.ts` file here is reachable
 * from both. It is exported only for tests and imported nowhere in production code.
 */
import type { Device, MobileDeviceRecord } from "./mobile-schemas.js";

/**
 * A CLOUD device record, active by default.
 *
 * Active is the right default because most tests mean "a paired phone" when they build one; the
 * pairing-lifecycle tests pass `state` explicitly, which is exactly where the distinction should be
 * visible rather than implied.
 */
export function makeCloudDevice(overrides: Partial<Device> = {}): Device {
  return {
    deviceId: "mobile-1",
    uid: "mobile-uid",
    pairId: "desktop-1",
    pairingId: "pairing-1",
    state: "active",
    grantCommitment: "grant-commitment",
    keyProof: "k".repeat(43),
    keyProvenAt: 10,
    activatedAt: 20,
    platform: "android",
    label: "Pixel",
    publicKey: "cHVibGljS2V5",
    sessionKeyVersion: 1,
    capabilities: [],
    profileAllowlist: [],
    createdAt: 0,
    lastSeenAt: 0,
    revoked: false,
    revokedAt: null,
    ...overrides,
  };
}

/** A DESKTOP-LOCAL device record, active by default. Same reasoning as above. */
export function makeLocalDevice(overrides: Partial<MobileDeviceRecord> = {}): MobileDeviceRecord {
  return {
    deviceId: "mobile-1",
    uid: "mobile-uid",
    pairId: "desktop-1",
    pairingId: "pairing-1",
    grantCommitment: "grant-commitment",
    keyProof: "k".repeat(43),
    state: "active",
    platform: "android",
    label: "Pixel",
    fingerprint: "AAAA:BBBB",
    publicKey: "cHVibGljS2V5",
    sessionKeyVersion: 1,
    capabilities: [],
    profileAllowlist: [],
    createdAt: 0,
    lastSeenAt: 0,
    revoked: false,
    revokedAt: null,
    remoteUiPaused: false,
    notificationFilter: { minPriority: "low", mutedKinds: [] },
    verifiedAt: 10,
    activatedAt: 20,
    ...overrides,
  };
}

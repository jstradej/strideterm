import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMobilePairing } from "./mobile-pairing.js";
import { createMobileDeviceStore } from "./mobile-device-store.js";
import { createMobileAuditLogStore } from "./mobile-audit-log-store.js";
import { createInMemoryMobileFirebaseTransport } from "./mobile-firebase-transport.js";
import { PROTOCOL_VERSION, type Capability, type Device, type MobileDeviceRecord } from "./mobile-schemas.js";
import { computeGrantCommitment } from "./mobile-crypto.js";

const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * Drains enough microtasks for one claim to be processed end to end.
 *
 * Adoption awaits more than it used to: the device-store mutation, and then the cloud key-proof
 * attestation that gives `approvePairing` its `keyProven` precondition (review 3 §P0.1). The two bare
 * `await Promise.resolve()` calls these tests used to carry no longer reach `notifyClaim`.
 */
async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// Plain string check instead of a single `(group){7}` regex: eslint's
// security/detect-unsafe-regex heuristic flags fixed-count repeated groups
// like /^[0-9A-F]{4}(:[0-9A-F]{4}){7}$/ even though a bounded {7} count can't
// backtrack catastrophically. Splitting avoids tripping that false positive.
function isEightHexGroups(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 8 && parts.every((part) => /^[0-9A-F]{4}$/.test(part));
}

async function createFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-mobile-pairing-"));
  tempDirs.push(dir);
  const auditLogStore = createMobileAuditLogStore(path.join(dir, "mobile-audit-log.db"));
  openStores.push(auditLogStore);
  let devices: MobileDeviceRecord[] = [];
  const deviceStore = createMobileDeviceStore({
    getDevices: () => devices,
    mutateDevices: async (fn) => {
      devices = fn(devices);
      return devices;
    },
  });
  let currentTime = 1_000_000;
  const now = () => currentTime;
  const transport = createInMemoryMobileFirebaseTransport({ now });
  await transport.connect();
  const pairing = createMobilePairing({
    transport,
    deviceStore,
    auditLogStore,
    identity: {
      deviceId: "desktop-1",
      label: "My Desktop",
      publicKeyBase64: Buffer.alloc(32, 0x11).toString("base64"),
    },
    // A stand-in for the real recomputation (review 3 §P0.1). The genuine HMAC-under-the-session-key
    // path is exercised end to end in mobile-manager.activation.test.ts and pinned by the shared
    // fixtures in mobile-crypto.test.ts; what THIS file tests is the adoption logic around it, so a
    // recognisable sentinel keeps each case about the thing it is named for.
    verifyKeyProof: ({ device }) => device.keyProof === VALID_KEY_PROOF,
    now,
  });
  return {
    pairing,
    deviceStore,
    auditLogStore,
    transport,
    advanceTime: (ms: number) => {
      currentTime += ms;
    },
  };
}

const VALID_KEY_PROOF = "v".repeat(43);

/**
 * The device record `claimPairing` would have written, defaulting to a claim of the CURRENT pending
 * invitation with a matching grant commitment and a proof the fixture accepts.
 *
 * Every one of those three has to be right for the record to be adopted (review 3 §P0.1), so a test
 * that wants to exercise one of them overrides exactly that field and leaves the others valid.
 */
function mkDevice(
  pairing: ReturnType<typeof createMobilePairing>,
  overrides: {
    deviceId?: string;
    uid?: string;
    pairId?: string;
    pairingId?: string;
    keyProof?: string;
    grantCommitment?: string;
    capabilities?: Capability[];
    profileAllowlist?: string[];
  } = {},
): Device {
  const deviceId = overrides.deviceId || "mobile-1";
  const pairId = overrides.pairId || "desktop-1";
  const pending = pairing.getPendingInvitation();
  const pairingId = overrides.pairingId ?? pending?.pairingId ?? "no-pending-invitation";
  // The grants come from the INVITATION, because that is what the server's commitment is computed over
  // and what this desktop recomputes it from. A test that wants a grant mismatch overrides them.
  const capabilities = overrides.capabilities ?? pending?.capabilities ?? (["task.control"] as Capability[]);
  const profileAllowlist = overrides.profileAllowlist ?? pending?.profileAllowlist ?? [];
  return {
    deviceId,
    uid: overrides.uid || "mobile-uid-1",
    pairId,
    pairingId,
    state: "claimed",
    grantCommitment:
      overrides.grantCommitment ??
      computeGrantCommitment({
        protocolVersion: PROTOCOL_VERSION,
        pairId: "desktop-1",
        pairingId,
        mobileDeviceId: deviceId,
        capabilities,
        profileAllowlist,
      }),
    keyProof: overrides.keyProof ?? VALID_KEY_PROOF,
    keyProvenAt: null,
    activatedAt: null,
    platform: "android" as const,
    label: "Pixel 8",
    publicKey: Buffer.alloc(32, 0x22).toString("base64"),
    sessionKeyVersion: 1,
    capabilities,
    profileAllowlist,
    createdAt: 1000,
    lastSeenAt: 1000,
    revoked: false,
    revokedAt: null,
  };
}

describe("mobile pairing: create", () => {
  test("createInvitation returns a QR payload and registers a watcher for this desktop's pairId", async () => {
    const { pairing, transport } = await createFixture();
    const qr = await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: ["task.control"] });
    expect(qr.pairingId).toBeTruthy();
    expect(qr.secret).toBeTruthy();
    expect(qr.desktopLabel).toBe("My Desktop");
    expect(isEightHexGroups(qr.desktopFingerprint)).toBe(true);
    expect(pairing.getPendingInvitation()).toMatchObject({ pairingId: qr.pairingId });

    const onClaim = vi.fn();
    pairing.onClaim(onClaim);
    transport.simulateClaim("desktop-1", mkDevice(pairing));
    // onClaim is invoked asynchronously (addDevice is awaited internally) — flush microtasks.
    await flush();
    expect(onClaim).toHaveBeenCalledWith({
      ok: true,
      device: expect.objectContaining({ deviceId: "mobile-1" }),
      // The invitation the device consumed — one of the values the pairing SAS commits to.
      pairingId: expect.any(String),
    });
  });

  test("a successful claim adds the device to the device store with the invitation's allowlist/capabilities", async () => {
    const { pairing, deviceStore, transport } = await createFixture();
    await pairing.createInvitation({
      profileAllowlist: ["default", "work"],
      capabilities: ["task.control", "remote.request"],
    });
    transport.simulateClaim("desktop-1", mkDevice(pairing));
    await flush();

    const device = deviceStore.getDevice("mobile-1");
    expect(device).toMatchObject({
      deviceId: "mobile-1",
      profileAllowlist: ["default", "work"],
      capabilities: ["task.control", "remote.request"],
      revoked: false,
    });
    expect(isEightHexGroups(device?.fingerprint || "")).toBe(true);
  });

  test("creating a second invitation while one is pending cancels the first (single active invitation)", async () => {
    const { pairing, transport } = await createFixture();
    const first = await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: [] });
    const cancelSpy = vi.spyOn(transport, "cancelInvitation");
    const second = await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: [] });
    expect(cancelSpy).toHaveBeenCalledWith(first.pairingId);
    expect(pairing.getPendingInvitation()).toMatchObject({ pairingId: second.pairingId });
  });
});

describe("mobile pairing: cancel", () => {
  test("cancelInvitation clears pending state and a claim for it afterwards is rejected", async () => {
    const { pairing, deviceStore, transport } = await createFixture();
    await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: [] });
    await pairing.cancelInvitation();
    expect(pairing.getPendingInvitation()).toBeNull();

    const onClaim = vi.fn();
    pairing.onClaim(onClaim);
    transport.simulateClaim("desktop-1", mkDevice(pairing));
    await flush();
    // Canceled invitation's watcher was unsubscribed — no claim outcome fires at all.
    expect(onClaim).not.toHaveBeenCalled();
    expect(deviceStore.listDevices()).toHaveLength(0);
  });
});

describe("mobile pairing: expire", () => {
  test("a claim delivered after the invitation's expiresAt is rejected as expired, device not added", async () => {
    const { pairing, deviceStore, transport, advanceTime } = await createFixture();
    await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: [] });
    advanceTime(121_000); // past the 120s TTL

    const onClaim = vi.fn();
    pairing.onClaim(onClaim);
    transport.simulateClaim("desktop-1", mkDevice(pairing));
    await flush();

    expect(onClaim).toHaveBeenCalledWith({ ok: false, reason: "expired" });
    expect(deviceStore.listDevices()).toHaveLength(0);
  });
});

describe("mobile pairing: replay", () => {
  test("a second claim notification for an already-claimed invitation is rejected, no second device added", async () => {
    const { pairing, deviceStore, transport } = await createFixture();
    await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: [] });

    const onClaim = vi.fn();
    pairing.onClaim(onClaim);
    transport.simulateClaim("desktop-1", mkDevice(pairing));
    await flush();
    expect(onClaim).toHaveBeenCalledWith({
      ok: true,
      device: expect.objectContaining({ deviceId: "mobile-1" }),
      // The invitation the device consumed — one of the values the pairing SAS commits to.
      pairingId: expect.any(String),
    });

    // Replay: same pairId claim fired again (e.g. duplicate delivery) after
    // the invitation is already consumed and unsubscribed.
    transport.simulateClaim("desktop-1", mkDevice(pairing, { deviceId: "mobile-2" }));
    await flush();

    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(deviceStore.listDevices()).toHaveLength(1);
    expect(deviceStore.getDevice("mobile-2")).toBeNull();
  });

  test("an already-paired device replayed on a new subscription does not consume the next invitation", async () => {
    // The real transport's watchNewDevices streams the WHOLE devices map when it subscribes, and
    // its "seen" set is per-subscription — so every invitation created on a desktop that already
    // has a paired phone replays that phone as a fresh claim. Before the device-store check in
    // processNewDevice, that consumed the invitation the user was holding a QR for, and the second
    // phone's claim (which had already succeeded in the cloud) was answered locally with
    // "already-consumed": pairing a second device to one desktop never worked. Found by the
    // cross-repo emulator scenario's two-phone step; pinned here at the unit level.
    const { pairing, deviceStore, transport } = await createFixture();
    await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: [] });
    transport.simulateClaim("desktop-1", mkDevice(pairing));
    await flush();
    expect(deviceStore.getDevice("mobile-1")).not.toBeNull();

    await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: [] });
    const onClaim = vi.fn();
    pairing.onClaim(onClaim);

    // The snapshot frame: the phone that paired a moment ago, arriving again.
    transport.simulateClaim("desktop-1", mkDevice(pairing));
    await flush();
    expect(onClaim).not.toHaveBeenCalled();
    expect(pairing.getPendingInvitation()).not.toBeNull();

    // The claim that is actually new.
    transport.simulateClaim("desktop-1", mkDevice(pairing, { deviceId: "mobile-2", uid: "mobile-uid-2" }));
    await flush();
    expect(onClaim).toHaveBeenCalledWith({
      ok: true,
      device: expect.objectContaining({ deviceId: "mobile-2" }),
      pairingId: expect.any(String),
    });
    expect(
      deviceStore
        .listDevices()
        .map((device) => device.deviceId)
        .sort(),
    ).toEqual(["mobile-1", "mobile-2"]);
  });

  test("two claim notifications delivered in the same tick only add one device (no TOCTOU double-claim)", async () => {
    const { pairing, deviceStore, transport } = await createFixture();
    await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: [] });

    transport.simulateClaim("desktop-1", mkDevice(pairing));
    transport.simulateClaim("desktop-1", mkDevice(pairing, { deviceId: "mobile-2" }));
    await flush();

    expect(deviceStore.listDevices()).toHaveLength(1);
    expect(deviceStore.getDevice("mobile-1")).not.toBeNull();
    expect(deviceStore.getDevice("mobile-2")).toBeNull();
  });
});

describe("mobile pairing: the three checks a claim must pass (review 3 §P0.1)", () => {
  test("the QR carries a one-time key-proof challenge, and a fresh one each time", async () => {
    // It exists only in the QR — never in any cloud record — which is what makes a valid key proof
    // evidence that the claiming device physically scanned THIS code, and not merely that it holds a
    // keypair.
    const { pairing } = await createFixture();
    const first = await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: ["task.control"] });
    const second = await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: ["task.control"] });
    expect(Buffer.from(first.keyProofChallenge, "base64url")).toHaveLength(32);
    expect(second.keyProofChallenge).not.toBe(first.keyProofChallenge);
  });

  test("a claim naming a different invitation is refused, and does NOT consume the pending one", async () => {
    // Both halves matter. Refusing it is the security property; not consuming the invitation is the
    // availability one — otherwise anyone who can write a device record could deny pairing indefinitely
    // by burning every invitation the user creates.
    const { pairing, deviceStore, transport, auditLogStore } = await createFixture();
    const qr = await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: ["task.control"] });
    const onClaim = vi.fn();
    pairing.onClaim(onClaim);

    // Delivered THROUGH the pending invitation's listener even though the record names another one —
    // i.e. as if the transport's filter had failed. The filter is the design; this is the check behind
    // it, and a defence-in-depth check that cannot be reached is not one.
    transport.simulateUnfilteredClaim(
      "desktop-1",
      qr.pairingId,
      mkDevice(pairing, { pairingId: "a-different-invitation" }),
    );
    await flush();

    expect(deviceStore.getDevice("mobile-1")).toBeNull();
    expect(onClaim).toHaveBeenCalledWith({ ok: false, reason: "pairing-id-mismatch" });
    expect(pairing.getPendingInvitation()).not.toBeNull();
    expect(auditLogStore.query({ action: "pairing.claim-rejected" }).entries[0]!.detail).toBe("pairing-id-mismatch");

    // And the real claim still works afterwards.
    transport.simulateClaim("desktop-1", mkDevice(pairing));
    await flush();
    expect(deviceStore.getDevice("mobile-1")).not.toBeNull();
  });

  test("a claim whose recorded grants do not match the approved ones is refused", async () => {
    // The cloud's idea of what this device may do and this desktop's idea of it must be the same idea.
    // v2 never compared them: it stapled its own pending invitation's grants onto whatever appeared.
    const { pairing, deviceStore, transport, auditLogStore } = await createFixture();
    await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: ["task.control"] });
    const onClaim = vi.fn();
    pairing.onClaim(onClaim);

    transport.simulateClaim("desktop-1", mkDevice(pairing, { grantCommitment: "a-commitment-over-something-else" }));
    await flush();

    expect(deviceStore.getDevice("mobile-1")).toBeNull();
    expect(onClaim).toHaveBeenCalledWith({ ok: false, reason: "grant-commitment-mismatch" });
    expect(auditLogStore.query({ action: "pairing.claim-rejected" }).entries[0]!.detail).toBe(
      "grant-commitment-mismatch",
    );
  });

  test("a widened grant set produces a different commitment, so it cannot be smuggled in", async () => {
    // Concretely: the human ticked `task.control`, and the record claims `task.destructive` as well.
    const { pairing, deviceStore, transport } = await createFixture();
    await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: ["task.control"] });
    transport.simulateClaim(
      "desktop-1",
      mkDevice(pairing, { capabilities: ["task.control", "task.destructive"], profileAllowlist: ["default"] }),
    );
    await flush();
    expect(deviceStore.getDevice("mobile-1")).toBeNull();
  });

  test("a claim whose key proof does not verify is refused", async () => {
    const { pairing, deviceStore, transport, auditLogStore } = await createFixture();
    await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: ["task.control"] });
    const onClaim = vi.fn();
    pairing.onClaim(onClaim);

    transport.simulateClaim("desktop-1", mkDevice(pairing, { keyProof: "not-the-proof" }));
    await flush();

    expect(deviceStore.getDevice("mobile-1")).toBeNull();
    expect(onClaim).toHaveBeenCalledWith({ ok: false, reason: "key-proof-failed" });
    expect(auditLogStore.query({ action: "pairing.claim-rejected" }).entries[0]!.detail).toBe("key-proof-failed");
  });

  test("an adopted claim lands in keyProven, never active, and the cloud is told", async () => {
    const { pairing, deviceStore, transport } = await createFixture();
    await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: ["task.control"] });
    transport.simulateClaim("desktop-1", mkDevice(pairing));
    await flush();

    const device = deviceStore.getDevice("mobile-1")!;
    expect(device.state).toBe("keyProven");
    expect(device.activatedAt).toBeNull();
    expect(device.verifiedAt).not.toBeNull();
    // The cloud needs the `keyProven` precondition too, or `approvePairing` cannot succeed.
    expect(transport.getPairingCalls().map((c) => c.call)).toContain("attestPairingKeyProof");
  });

  test("the claim watcher is scoped to one invitation, so a record for another never arrives", async () => {
    // The seam itself (review 3 §P0.1: "Nahradit broad adoption watcher konkrétním claim watcherem").
    // The in-memory transport filters by pairingId exactly as the real one does, so a record claimed
    // under a different invitation is dropped before the pairing module rather than by it.
    const { pairing, transport } = await createFixture();
    await pairing.createInvitation({ profileAllowlist: ["default"], capabilities: ["task.control"] });
    const onClaim = vi.fn();
    pairing.onClaim(onClaim);
    transport.simulateClaim("desktop-1", mkDevice(pairing, { pairingId: "some-unrelated-invitation" }));
    await flush();
    // Not even a rejection: the callback was never reached.
    expect(onClaim).not.toHaveBeenCalled();
  });
});

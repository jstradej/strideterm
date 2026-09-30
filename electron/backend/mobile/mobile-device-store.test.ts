import { describe, expect, test } from "vitest";
import {
  addDevice,
  createMobileDeviceStore,
  deviceAllowsProfile,
  deviceHasCapability,
  findDevice,
  isDeviceUsable,
  listActiveDevices,
  applyRemoteRevocation,
  clearCloudRevokePending,
  listPendingCloudRevocations,
  markCloudRevokePending,
  markRelayE2eSeen,
  recordCloudRevokeAttempt,
  removeRevokedDevice,
  listPendingApprovalDevices,
  listUsableDevices,
  markActive,
  markUserApproved,
  revokeDevice,
  touchLastSeen,
  updateAllowlist,
  updateNotificationFilter,
} from "./mobile-device-store.js";
import type { NewDeviceInput } from "./mobile-device-store.js";
import type { MobileDeviceRecord } from "./mobile-schemas.js";

function newDeviceInput(deviceId: string, overrides: Partial<NewDeviceInput> = {}): NewDeviceInput {
  return {
    deviceId,
    uid: `uid-${deviceId}`,
    pairId: "pair-1",
    pairingId: "pairing-1",
    grantCommitment: "grant-commitment",
    keyProof: "k".repeat(43),
    // Adopted only after the key proof verified, so `keyProven` is what production passes here.
    state: "keyProven",
    platform: "android",
    label: "Pixel 8",
    fingerprint: "AB:CD:EF",
    publicKey: "base64key",
    sessionKeyVersion: 1,
    capabilities: ["task.control", "remote.request"],
    profileAllowlist: ["default"],
    now: 1000,
    ...overrides,
  };
}

describe("addDevice", () => {
  test("adds a new device", () => {
    const result = addDevice([], newDeviceInput("dev-1"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.devices).toHaveLength(1);
    expect(result.device).toMatchObject({ deviceId: "dev-1", revoked: false, revokedAt: null });
    expect(result.device.notificationFilter).toEqual({ minPriority: "low", mutedKinds: [] });
  });

  test("is idempotent for an already-present deviceId (replayed claim)", () => {
    const first = addDevice([], newDeviceInput("dev-1"));
    if (!first.ok) throw new Error("expected ok");
    const second = addDevice(first.devices, newDeviceInput("dev-1", { label: "Different label" }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.devices).toHaveLength(1);
    // Original record preserved, not overwritten by the replayed input.
    expect(second.device.label).toBe("Pixel 8");
  });

  test("rejects a 4th device once MAX_PAIRED_MOBILE_DEVICES_PER_DESKTOP (3) active devices exist", () => {
    let devices: MobileDeviceRecord[] = [];
    for (const id of ["dev-1", "dev-2", "dev-3"]) {
      const result = addDevice(devices, newDeviceInput(id));
      if (!result.ok) throw new Error("expected ok");
      devices = result.devices;
    }
    const fourth = addDevice(devices, newDeviceInput("dev-4"));
    expect(fourth).toEqual({ ok: false, reason: "device-limit-reached" });
  });

  test("a revoked device does not count against the active-device cap", () => {
    let devices: MobileDeviceRecord[] = [];
    for (const id of ["dev-1", "dev-2", "dev-3"]) {
      const result = addDevice(devices, newDeviceInput(id));
      if (!result.ok) throw new Error("expected ok");
      devices = result.devices;
    }
    devices = revokeDevice(devices, "dev-1", 2000);
    const fourth = addDevice(devices, newDeviceInput("dev-4"));
    expect(fourth.ok).toBe(true);
  });
});

describe("revokeDevice", () => {
  test("marks a device revoked with a timestamp", () => {
    const first = addDevice([], newDeviceInput("dev-1"));
    if (!first.ok) throw new Error("expected ok");
    const after = revokeDevice(first.devices, "dev-1", 5000);
    expect(after[0]).toMatchObject({ revoked: true, revokedAt: 5000 });
  });

  test("is idempotent — revoking twice keeps the original revokedAt", () => {
    const first = addDevice([], newDeviceInput("dev-1"));
    if (!first.ok) throw new Error("expected ok");
    const onceRevoked = revokeDevice(first.devices, "dev-1", 5000);
    const twiceRevoked = revokeDevice(onceRevoked, "dev-1", 9999);
    expect(twiceRevoked[0]).toMatchObject({ revoked: true, revokedAt: 5000 });
  });
});

describe("capability/profile checks", () => {
  test("deviceHasCapability / deviceAllowsProfile", () => {
    const result = addDevice([], newDeviceInput("dev-1"));
    if (!result.ok) throw new Error("expected ok");
    expect(deviceHasCapability(result.device, "task.control")).toBe(true);
    expect(deviceHasCapability(result.device, "remote.admin")).toBe(false);
    expect(deviceAllowsProfile(result.device, "default")).toBe(true);
    expect(deviceAllowsProfile(result.device, "other-profile")).toBe(false);
  });

  test("isDeviceUsable requires `active`, not merely not-revoked", () => {
    // Review 3 §P0.1: this predicate used to be `!device.revoked`, and that gap IS the pairing defect.
    // A freshly-adopted device is `keyProven` — its key proof verified, nobody having approved it — and
    // `revoked === false` was true of it, so every authorization path treated it as usable.
    const result = addDevice([], newDeviceInput("dev-1"));
    if (!result.ok) throw new Error("expected ok");
    expect(result.device.state).toBe("keyProven");
    expect(result.device.revoked).toBe(false);
    expect(isDeviceUsable(result.device)).toBe(false);

    const active = markActive(result.devices, "dev-1", 2000)[0]!;
    expect(isDeviceUsable(active)).toBe(true);

    const revoked = revokeDevice(markActive(result.devices, "dev-1", 2000), "dev-1", 1234)[0];
    expect(isDeviceUsable(revoked)).toBe(false);
    expect(isDeviceUsable(null)).toBe(false);
  });

  test("markActive only accepts a device a human could have approved", () => {
    // `claimed` cannot jump to `active`: key proof and human approval are separate steps, and the cloud
    // enforces the same ordering independently through `approvePairing`'s `keyProven` precondition.
    const claimed = addDevice([], newDeviceInput("dev-1", { state: "claimed" }));
    if (!claimed.ok) throw new Error("expected ok");
    expect(markActive(claimed.devices, "dev-1", 2000)[0]!.state).toBe("claimed");

    const proven = addDevice([], newDeviceInput("dev-2", { state: "keyProven" }));
    if (!proven.ok) throw new Error("expected ok");
    expect(markActive(proven.devices, "dev-2", 2000)[0]!.state).toBe("active");
    // And through the desktop-local intermediate, which is what a restart mid-approval leaves behind.
    const approved = markUserApproved(proven.devices, "dev-2");
    expect(approved[0]!.state).toBe("userApproved");
    expect(markActive(approved, "dev-2", 2000)[0]!.state).toBe("active");
  });

  test("a remote revocation is applied, and never reversed", () => {
    // The desktop half of review 3 §P0.3's monotonicity requirement: `revoked` is terminal, so a stale
    // stream snapshot arriving after a revoke cannot resurrect the device.
    const result = addDevice([], newDeviceInput("dev-1"));
    if (!result.ok) throw new Error("expected ok");
    const active = markActive(result.devices, "dev-1", 2000);
    const revoked = applyRemoteRevocation(active, "dev-1", 3000);
    expect(revoked[0]!.state).toBe("revoked");
    expect(revoked[0]!.revoked).toBe(true);
    // Re-applying keeps the original timestamp rather than sliding it forward, and markActive is inert.
    expect(applyRemoteRevocation(revoked, "dev-1", 9000)[0]!.revokedAt).toBe(3000);
    expect(markActive(revoked, "dev-1", 9000)[0]!.state).toBe("revoked");
  });

  test("listUsableDevices and listPendingApprovalDevices split the two populations", () => {
    const added = addDevice([], newDeviceInput("dev-active"));
    if (!added.ok) throw new Error("expected ok");
    const devices = markActive(added.devices, "dev-active", 2000);
    const withPending = addDevice(devices, newDeviceInput("dev-pending"));
    if (!withPending.ok) throw new Error("expected ok");
    expect(listUsableDevices(withPending.devices).map((d) => d.deviceId)).toEqual(["dev-active"]);
    expect(listPendingApprovalDevices(withPending.devices).map((d) => d.deviceId)).toEqual(["dev-pending"]);
  });
});

describe("listActiveDevices / findDevice", () => {
  test("excludes revoked devices from the active list but findDevice still finds them", () => {
    const first = addDevice([], newDeviceInput("dev-1"));
    if (!first.ok) throw new Error("expected ok");
    const revoked = revokeDevice(first.devices, "dev-1", 1000);
    expect(listActiveDevices(revoked)).toHaveLength(0);
    expect(findDevice(revoked, "dev-1")?.revoked).toBe(true);
  });
});

describe("touchLastSeen / updateAllowlist / updateNotificationFilter", () => {
  test("touchLastSeen updates only the target device", () => {
    let devices: MobileDeviceRecord[] = [];
    for (const id of ["dev-1", "dev-2"]) {
      const result = addDevice(devices, newDeviceInput(id));
      if (!result.ok) throw new Error("expected ok");
      devices = result.devices;
    }
    const touched = touchLastSeen(devices, "dev-1", 8000);
    expect(touched.find((d) => d.deviceId === "dev-1")?.lastSeenAt).toBe(8000);
    expect(touched.find((d) => d.deviceId === "dev-2")?.lastSeenAt).toBe(1000);
  });

  test("updateAllowlist replaces capabilities/profileAllowlist for the target device only", () => {
    const first = addDevice([], newDeviceInput("dev-1"));
    if (!first.ok) throw new Error("expected ok");
    const updated = updateAllowlist(first.devices, "dev-1", {
      capabilities: ["task.control"] as const,
      profileAllowlist: ["default", "work"],
    });
    expect(updated[0].capabilities).toEqual(["task.control"]);
    expect(updated[0].profileAllowlist).toEqual(["default", "work"]);
  });

  test("updateNotificationFilter sets the filter for the target device only", () => {
    const first = addDevice([], newDeviceInput("dev-1"));
    if (!first.ok) throw new Error("expected ok");
    const updated = updateNotificationFilter(first.devices, "dev-1", { minPriority: "high", mutedKinds: ["info"] });
    expect(updated[0].notificationFilter).toEqual({ minPriority: "high", mutedKinds: ["info"] });
  });
});

describe("createMobileDeviceStore (stateful factory)", () => {
  function createFakeBackedStore() {
    let devices: MobileDeviceRecord[] = [];
    const store = createMobileDeviceStore({
      getDevices: () => devices,
      mutateDevices: async (fn) => {
        devices = fn(devices);
        return devices;
      },
    });
    return store;
  }

  test("addDevice persists via mutateDevices and getDevice/listDevices reflect it", async () => {
    const store = createFakeBackedStore();
    const result = await store.addDevice(newDeviceInput("dev-1"));
    expect(result.ok).toBe(true);
    expect(store.listDevices()).toHaveLength(1);
    expect(store.getDevice("dev-1")).toMatchObject({ deviceId: "dev-1" });
  });

  test("revokeDevice removes the device from listActiveDevices", async () => {
    const store = createFakeBackedStore();
    await store.addDevice(newDeviceInput("dev-1"));
    await store.revokeDevice("dev-1", 4242);
    expect(store.listActiveDevices()).toHaveLength(0);
    expect(store.getDevice("dev-1")?.revokedAt).toBe(4242);
  });
});

describe("the relay end-to-end latch", () => {
  // Security review 3.5: once a device has completed an encrypted relay session, a later relay ticket
  // request from it without an `e2e` acceptance is a downgrade and is refused. This is the record of it.
  function twoDevices() {
    const first = addDevice([], newDeviceInput("dev-1"));
    if (!first.ok) throw new Error("fixture");
    const second = addDevice(first.devices, newDeviceInput("dev-2"));
    if (!second.ok) throw new Error("fixture");
    return second.devices;
  }

  test("sets the timestamp on the named device only", () => {
    const devices = markRelayE2eSeen(twoDevices(), "dev-1", 1234);
    expect(devices[0]?.relayE2eSeenAt).toBe(1234);
    expect(devices[1]).not.toHaveProperty("relayE2eSeenAt");
  });

  test("the first timestamp wins: marking again never moves it", () => {
    const once = markRelayE2eSeen(twoDevices(), "dev-1", 1234);
    const twice = markRelayE2eSeen(once, "dev-1", 9999);
    expect(twice[0]?.relayE2eSeenAt).toBe(1234);
  });

  test("an unknown device changes nothing, and the input is not mutated", () => {
    const devices = twoDevices();
    const result = markRelayE2eSeen(devices, "no-such-device", 1234);
    expect(result).toEqual(devices);
    markRelayE2eSeen(devices, "dev-1", 1234);
    expect(devices[0]).not.toHaveProperty("relayE2eSeenAt");
  });

  test("the store method persists it once and does not write again for a latched device", async () => {
    let devices: MobileDeviceRecord[] = [];
    let writes = 0;
    const store = createMobileDeviceStore({
      getDevices: () => devices,
      mutateDevices: async (fn) => {
        writes += 1;
        devices = fn(devices);
        return devices;
      },
    });
    await store.addDevice(newDeviceInput("dev-1"));
    const writesAfterAdd = writes;

    await store.markRelayE2eSeen("dev-1", 1234);
    await store.markRelayE2eSeen("dev-1", 5678);
    await store.markRelayE2eSeen("no-such-device", 5678);

    expect(store.getDevice("dev-1")?.relayE2eSeenAt).toBe(1234);
    expect(writes).toBe(writesAfterAdd + 1);
  });
});

describe("the cloud half of a revocation, owed and retried", () => {
  // `MobileManager.revokeDevice` used to call the transport once and swallow the failure, so a
  // desktop revoking a phone while offline left the cloud record `active` for ever. These are the
  // pure transitions the outbox that replaced it is built from.
  function devicesWithOne() {
    const result = addDevice([], newDeviceInput("dev-1"));
    if (!result.ok) throw new Error("fixture");
    return result.devices;
  }

  test("marking keeps the first request's timestamp when it is marked again", () => {
    // A second click on Revoke must not make the history read as if the first never happened, nor
    // restart the record of how long the cloud has been owed this.
    const once = markCloudRevokePending(devicesWithOne(), "dev-1", { kind: "revoke", now: 1000 });
    const twice = markCloudRevokePending(once, "dev-1", { kind: "revoke", now: 9000 });
    expect(twice[0]?.pendingCloudRevoke?.requestedAt).toBe(1000);
  });

  test("a rejection remembers its reason, because rejectPairing needs it on the retry", () => {
    const marked = markCloudRevokePending(devicesWithOne(), "dev-1", {
      kind: "reject",
      reason: "sas-mismatch",
      now: 1000,
    });
    expect(marked[0]?.pendingCloudRevoke).toMatchObject({ kind: "reject", reason: "sas-mismatch" });
  });

  test("attempts accumulate and the entry is never dropped", () => {
    // NO CEILING, deliberately: an attempt limit that discards the entry is exactly how the cloud
    // record ends up `active` for ever, which is the state this exists to prevent.
    let devices = markCloudRevokePending(devicesWithOne(), "dev-1", { kind: "revoke", now: 1000 });
    for (let i = 0; i < 50; i += 1) devices = recordCloudRevokeAttempt(devices, "dev-1", 2000 + i, "offline");
    expect(devices[0]?.pendingCloudRevoke?.attempts).toBe(50);
    expect(devices[0]?.pendingCloudRevoke?.lastErrorCode).toBe("offline");
  });

  test("an attempt against a device with nothing owed changes nothing", () => {
    const devices = recordCloudRevokeAttempt(devicesWithOne(), "dev-1", 2000, "offline");
    expect(devices[0]?.pendingCloudRevoke).toBeUndefined();
  });

  test("clearing removes the field rather than leaving an empty one behind", () => {
    const marked = markCloudRevokePending(devicesWithOne(), "dev-1", { kind: "revoke", now: 1000 });
    const cleared = clearCloudRevokePending(marked, "dev-1");
    expect(cleared[0]).not.toHaveProperty("pendingCloudRevoke");
  });

  test("the pending list is oldest first, so a flush retries in the order the user asked", () => {
    const added = addDevice(devicesWithOne(), newDeviceInput("dev-2"));
    if (!added.ok) throw new Error("fixture");
    let devices = added.devices;
    devices = markCloudRevokePending(devices, "dev-2", { kind: "revoke", now: 5000 });
    devices = markCloudRevokePending(devices, "dev-1", { kind: "revoke", now: 1000 });
    expect(listPendingCloudRevocations(devices).map((d) => d.deviceId)).toEqual(["dev-1", "dev-2"]);
  });

  test("a device with nothing owed is not in the list", () => {
    expect(listPendingCloudRevocations(devicesWithOne())).toHaveLength(0);
  });
});

describe("forgetting a revoked device", () => {
  // Housekeeping: the list only ever grew, and there was no function anywhere — not in the store,
  // not over IPC, not in the UI — that removed a row from it.
  function revokedOne() {
    const added = addDevice([], newDeviceInput("dev-1"));
    if (!added.ok) throw new Error("fixture");
    return revokeDevice(added.devices, "dev-1", 1000);
  }

  test("a revoked device can be forgotten", () => {
    const result = removeRevokedDevice(revokedOne(), "dev-1");
    expect(result.ok).toBe(true);
    expect(result.ok && result.devices).toHaveLength(0);
  });

  test("an ACTIVE device cannot — that would be a forget-locally back door", () => {
    // Removing the record while the cloud still has the device active would leave this desktop with
    // nothing to revoke it WITH, which is the exact trap the phone side names as a separate action.
    const added = addDevice([], newDeviceInput("dev-1"));
    const result = removeRevokedDevice(added.ok ? added.devices : [], "dev-1");
    expect(result).toEqual({ ok: false, reason: "not-revoked" });
  });

  test("one whose cloud revocation is still owed cannot — the record IS the outbox entry", () => {
    const pending = markCloudRevokePending(revokedOne(), "dev-1", { kind: "revoke", now: 1000 });
    expect(removeRevokedDevice(pending, "dev-1")).toEqual({ ok: false, reason: "cloud-revoke-pending" });
  });

  test("it is forgettable again once that revocation has been sent", () => {
    const pending = markCloudRevokePending(revokedOne(), "dev-1", { kind: "revoke", now: 1000 });
    const sent = clearCloudRevokePending(pending, "dev-1");
    expect(removeRevokedDevice(sent, "dev-1").ok).toBe(true);
  });

  test("a device that is not there at all is reported, not silently accepted", () => {
    expect(removeRevokedDevice([], "dev-1")).toEqual({ ok: false, reason: "not-found" });
  });

  test("it removes only the named device", () => {
    let devices = revokedOne();
    const added = addDevice(devices, newDeviceInput("dev-2"));
    if (!added.ok) throw new Error("fixture");
    devices = added.devices;
    const result = removeRevokedDevice(devices, "dev-1");
    expect(result.ok && result.devices.map((d) => d.deviceId)).toEqual(["dev-2"]);
  });
});

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

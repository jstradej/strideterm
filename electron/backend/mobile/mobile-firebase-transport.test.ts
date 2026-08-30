import { describe, expect, test, vi } from "vitest";
import { createInMemoryMobileFirebaseTransport } from "./mobile-firebase-transport.js";
import type { Device, EncryptedEnvelope, NotificationEvent } from "./mobile-schemas.js";

function fakeDevice(overrides: Partial<Device> = {}): Device {
  return {
    deviceId: "dev-1",
    uid: "uid-1",
    pairId: "pair-1",
    pairingId: "pairing-1",
    state: "active",
    grantCommitment: "grant-commitment",
    keyProof: "k".repeat(43),
    keyProvenAt: 10,
    activatedAt: 20,
    platform: "android",
    label: "Pixel 8",
    publicKey: Buffer.alloc(32, 0x33).toString("base64"),
    sessionKeyVersion: 1,
    capabilities: ["task.control"],
    profileAllowlist: ["default"],
    createdAt: 1000,
    lastSeenAt: 1000,
    revoked: false,
    revokedAt: null,
    ...overrides,
  };
}

function fakeEnvelope(overrides: Partial<EncryptedEnvelope> = {}): EncryptedEnvelope {
  return {
    protocolVersion: 2,
    pairId: "pair-1",
    senderDeviceId: "dev-1",
    targetDeviceId: "pair-1",
    messageId: "msg-1",
    messageType: "command",
    nonce: "nonce",
    createdAt: 1000,
    expiresAt: 2000,
    ciphertext: "cipher",
    aad: "aad",
    sessionKeyVersion: 1,
    ...overrides,
  };
}

function fakeNotificationEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    protocolVersion: 2,
    eventId: "evt-1",
    pairId: "pair-1",
    sourceDeviceId: "desktop-1",
    targetDeviceId: "dev-1",
    profileId: "default",
    workspaceId: "ws-1",
    severity: "high",
    dedupeKey: "ws-1:waiting",
    collapseKey: null,
    createdAt: 1000,
    expiresAt: 604_801_000,
    sessionKeyVersion: 1,
    ciphertext: "cipher",
    aad: "aad",
    ...overrides,
  };
}

describe("in-memory MobileFirebaseTransport", () => {
  test("createInvitation requires the transport to be connected first", async () => {
    const transport = createInMemoryMobileFirebaseTransport();
    await expect(
      transport.createInvitation({
        desktopDeviceId: "desktop-1",
        desktopLabel: "My Desktop",
        desktopFingerprint: "AB:CD",
        desktopPublicKey: "pub",
        secret: "secret",
        approvedCapabilities: ["notifications"],
        approvedProfileAllowlist: ["default"],
      }),
    ).rejects.toThrow(/disconnected/);
  });

  test("createInvitation returns a pairingId and a ~120s expiry once connected", async () => {
    const transport = createInMemoryMobileFirebaseTransport();
    await transport.connect();
    const before = Date.now();
    const response = await transport.createInvitation({
      desktopDeviceId: "desktop-1",
      desktopLabel: "My Desktop",
      desktopFingerprint: "AB:CD",
      desktopPublicKey: "pub",
      secret: "secret",
      approvedCapabilities: ["notifications"],
      approvedProfileAllowlist: ["default"],
    });
    expect(response.pairingId).toBeTruthy();
    expect(response.expiresAt).toBeGreaterThanOrEqual(before + 119_000);
    expect(response.expiresAt).toBeLessThanOrEqual(before + 121_000);
  });

  test("watchPairingClaim + simulateClaim delivers the claimed device to listeners", async () => {
    const transport = createInMemoryMobileFirebaseTransport();
    const onNewDevice = vi.fn();
    // Scoped to ONE invitation (review 3 §P0.1): the seam that replaced watchNewDevices, which
    // delivered every previously-unseen record in the pair and let the desktop adopt whatever appeared.
    const unsubscribe = transport.watchPairingClaim("pair-1", "pairing-1", onNewDevice);

    transport.simulateClaim("pair-1", fakeDevice());
    expect(onNewDevice).toHaveBeenCalledTimes(1);
    expect(onNewDevice).toHaveBeenCalledWith(fakeDevice());

    unsubscribe();
    transport.simulateClaim("pair-1", fakeDevice({ deviceId: "dev-2" }));
    expect(onNewDevice).toHaveBeenCalledTimes(1);
  });

  test("sendEvent/getSentEvents round trip", async () => {
    const transport = createInMemoryMobileFirebaseTransport();
    await transport.connect();
    await transport.sendEvent("pair-1", fakeNotificationEvent());
    expect(transport.getSentEvents("pair-1")).toEqual([fakeNotificationEvent()]);
    expect(transport.getSentEvents("pair-2")).toEqual([]);
  });

  test("sendEvent while disconnected throws", async () => {
    const transport = createInMemoryMobileFirebaseTransport();
    await expect(transport.sendEvent("pair-1", fakeNotificationEvent())).rejects.toThrow(/disconnected/);
  });

  test("watchCommandEnvelopes delivers envelopes pushed while connected", async () => {
    const transport = createInMemoryMobileFirebaseTransport();
    await transport.connect();
    const onEnvelope = vi.fn();
    transport.watchCommandEnvelopes("pair-1", onEnvelope);
    transport.pushCommandEnvelope("pair-1", fakeEnvelope());
    expect(onEnvelope).toHaveBeenCalledTimes(1);
    expect(onEnvelope).toHaveBeenCalledWith(fakeEnvelope());
  });

  test("commands pushed while disconnected are queued and replayed on reconnect (offline queue)", async () => {
    const transport = createInMemoryMobileFirebaseTransport();
    const onEnvelope = vi.fn();
    transport.watchCommandEnvelopes("pair-1", onEnvelope);

    // Disconnected the whole time — push happens before any connect() call.
    transport.pushCommandEnvelope("pair-1", fakeEnvelope({ messageId: "msg-offline" }));
    expect(onEnvelope).not.toHaveBeenCalled();

    transport.simulateReconnect();
    expect(onEnvelope).toHaveBeenCalledTimes(1);
    expect(onEnvelope).toHaveBeenCalledWith(fakeEnvelope({ messageId: "msg-offline" }));

    // Reconnecting again with nothing new queued must not redeliver.
    transport.simulateReconnect();
    expect(onEnvelope).toHaveBeenCalledTimes(1);
  });

  test("simulateDisconnect stops immediate delivery until simulateReconnect", async () => {
    const transport = createInMemoryMobileFirebaseTransport();
    await transport.connect();
    const onEnvelope = vi.fn();
    transport.watchCommandEnvelopes("pair-1", onEnvelope);

    transport.simulateDisconnect();
    transport.pushCommandEnvelope("pair-1", fakeEnvelope({ messageId: "msg-2" }));
    expect(onEnvelope).not.toHaveBeenCalled();

    transport.simulateReconnect();
    expect(onEnvelope).toHaveBeenCalledTimes(1);
  });

  test("claimCommand grants exactly one winner for a given commandId (duplicate delivery is safe)", async () => {
    const transport = createInMemoryMobileFirebaseTransport();
    const first = await transport.claimCommand("pair-1", "cmd-1");
    const second = await transport.claimCommand("pair-1", "cmd-1");
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  test("sendResultEnvelope/getSentResultEnvelopes round trip", async () => {
    const transport = createInMemoryMobileFirebaseTransport();
    await transport.sendResultEnvelope("pair-1", "dev-1", "cmd-1", fakeEnvelope({ messageType: "commandResult" }));
    expect(transport.getSentResultEnvelopes("pair-1")).toEqual([fakeEnvelope({ messageType: "commandResult" })]);
  });

  test("onConnectionStateChange fires for connect/disconnect and unsubscribes cleanly", async () => {
    const transport = createInMemoryMobileFirebaseTransport();
    const states: string[] = [];
    const unsubscribe = transport.onConnectionStateChange((state) => states.push(state));

    await transport.connect();
    transport.simulateDisconnect();
    unsubscribe();
    await transport.connect();

    expect(states).toEqual(["connected", "disconnected"]);
  });
});

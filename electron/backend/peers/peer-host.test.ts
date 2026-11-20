import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import {
  PEER_PAIRING_TTL_MS,
  defaultPeerSettings,
  type PeerIntegrationSettings,
  type PeerPairBegin,
} from "../../shared/peers.js";
import { exportRawPublicKey, generateX25519KeyPair } from "../mobile/mobile-crypto.js";
import {
  PEER_PAIRING_IDENTITY,
  PEER_PAIRING_PSK,
  computePeerCommitment,
  computePeerSas,
  derivePeerPsk,
} from "./peer-crypto.js";
import { PEER_HOST_KEY_REF, PeerPairingError, createPeerHost, type PeerHost } from "./peer-host.js";

interface Harness {
  host: PeerHost;
  settings: PeerIntegrationSettings;
  secrets: Map<string, string>;
  events: Array<{ event: string; payload: unknown }>;
  clock: { value: number };
  failSetSecret: { value: boolean };
  setSecretCalls: { value: number };
  updateReasons: string[];
}

function harness(): Harness {
  const settings = defaultPeerSettings();
  settings.hosting.enabled = true;
  const secrets = new Map<string, string>();
  const events: Harness["events"] = [];
  const clock = { value: 1_000_000 };
  const failSetSecret = { value: false };
  const setSecretCalls = { value: 0 };
  const updateReasons: string[] = [];
  let counter = 0;
  const host = createPeerHost({
    getSettings: () => settings,
    updateSettings: async (reason, update) => {
      updateReasons.push(reason);
      await Promise.resolve();
      update(settings);
    },
    credentials: {
      getSecret: (ref) => secrets.get(ref) ?? "",
      setSecret: async (ref, secret) => {
        setSecretCalls.value += 1;
        await Promise.resolve();
        if (failSetSecret.value) throw new Error("no keychain");
        secrets.set(ref, secret);
      },
      isEncryptionAvailable: () => true,
    },
    appVersion: "1.2.3",
    hostName: () => "Host PC",
    emit: (event, payload) => events.push({ event, payload }),
    now: () => clock.value,
    randomId: () => `id-${String(++counter).padStart(8, "0")}`,
  });
  return { host, settings, secrets, events, clock, failSetSecret, setSecretCalls, updateReasons };
}

function makeDevice(deviceId = "device-0001") {
  const keys = generateX25519KeyPair();
  const publicKey = exportRawPublicKey(keys.publicKey).toString("base64");
  const nonce = randomBytes(32).toString("base64");
  const begin: PeerPairBegin = {
    protocolVersion: 1,
    deviceId,
    name: "Laptop",
    platform: "win32",
    appVersion: "1.2.3",
    commitment: computePeerCommitment({ deviceId, publicKey, nonce }),
  };
  return { deviceId, keys, publicKey, nonce, begin };
}

async function pairUntilApproval(h: Harness, device = makeDevice(), address = "192.168.1.5") {
  const begun = await h.host.beginPairing(device.begin, address);
  h.host.revealPairing({ pairingId: begun.pairingId, publicKey: device.publicKey, nonce: device.nonce });
  const code = computePeerSas({
    pairingId: begun.pairingId,
    hostInstanceId: begun.hostInstanceId,
    hostPublicKey: begun.hostPublicKey,
    hostNonce: begun.hostNonce,
    deviceId: device.deviceId,
    devicePublicKey: device.publicKey,
    deviceNonce: device.nonce,
  });
  return { begun, code, device };
}

describe("peer host", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  test("happy path pairs a device and both sides derive the same PSK", async () => {
    const { begun, code, device } = await pairUntilApproval(h);
    expect(code).toMatch(/^\d{8}$/);
    expect(await h.host.approvePairing(begun.pairingId, code)).toBe("approved");
    expect(h.host.pairingStatus(begun.pairingId).state).toBe("approved");
    expect(h.settings.devices).toHaveLength(1);
    expect(h.settings.devices[0]).toMatchObject({
      id: "device-0001",
      name: "Laptop",
      publicKey: device.publicKey,
      pairedAt: h.clock.value,
      lastSeenAt: h.clock.value,
      lastAddress: "192.168.1.5",
    });
    const devicePsk = derivePeerPsk({
      privateKey: device.keys.privateKey,
      remotePublicKey: begun.hostPublicKey,
      hostInstanceId: begun.hostInstanceId,
      deviceId: device.deviceId,
    });
    const hostPsk = h.host.pskForIdentity("device-0001");
    expect(hostPsk?.length).toBe(32);
    expect(hostPsk?.equals(devicePsk)).toBe(true);
    expect(h.events.map((entry) => entry.event)).toContain("peers:updated");
  });

  test("the pending list never carries the code, keys or nonces", async () => {
    const { begun, code, device } = await pairUntilApproval(h);
    const pending = h.host.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ pairingId: begun.pairingId, sasReady: true, address: "192.168.1.5" });
    const json = JSON.stringify([pending, h.events]);
    for (const secret of [code, device.publicKey, device.nonce, begun.hostNonce, begun.hostPublicKey]) {
      expect(json).not.toContain(secret);
    }
  });

  test("sasReady is false until the reveal", async () => {
    const device = makeDevice();
    await h.host.beginPairing(device.begin, "10.0.0.1");
    expect(h.host.listPending()[0]!.sasReady).toBe(false);
  });

  test("a wrong code is one attempt: mismatch, no device, then not-found", async () => {
    const { begun, code } = await pairUntilApproval(h);
    const wrong = String((Number(code) + 1) % 1e8).padStart(8, "0");
    expect(await h.host.approvePairing(begun.pairingId, wrong)).toBe("sas-mismatch");
    expect(h.settings.devices).toHaveLength(0);
    expect(h.host.pairingStatus(begun.pairingId).state).toBe("rejected");
    expect(await h.host.approvePairing(begun.pairingId, code)).toBe("not-found");
    expect(h.settings.devices).toHaveLength(0);
    expect(h.host.listPending()).toHaveLength(0);
  });

  test("the typed code may contain a space", async () => {
    const { begun, code } = await pairUntilApproval(h);
    expect(await h.host.approvePairing(begun.pairingId, `${code.slice(0, 4)} ${code.slice(4)}`)).toBe("approved");
  });

  test("approving before the reveal is not-found", async () => {
    const begun = await h.host.beginPairing(makeDevice().begin, "10.0.0.1");
    expect(await h.host.approvePairing(begun.pairingId, "00000000")).toBe("not-found");
  });

  test("a reveal that does not match the commitment is refused and rejects the pairing", async () => {
    const device = makeDevice();
    const begun = await h.host.beginPairing(device.begin, "10.0.0.1");
    const other = randomBytes(32).toString("base64");
    expect(() =>
      h.host.revealPairing({ pairingId: begun.pairingId, publicKey: device.publicKey, nonce: other }),
    ).toThrow(expect.objectContaining({ code: "commitment-mismatch" }));
    expect(h.host.pairingStatus(begun.pairingId).state).toBe("rejected");
    expect(() =>
      h.host.revealPairing({ pairingId: begun.pairingId, publicKey: device.publicKey, nonce: device.nonce }),
    ).toThrow(expect.objectContaining({ code: "not-found" }));
  });

  test("an unknown pairing id on reveal is not-found", () => {
    expect(() =>
      h.host.revealPairing({
        pairingId: "missing-id",
        publicKey: randomBytes(32).toString("base64"),
        nonce: randomBytes(32).toString("base64"),
      }),
    ).toThrow(PeerPairingError);
  });

  test("pairings expire, including their status", async () => {
    const { begun, code } = await pairUntilApproval(h);
    h.clock.value += PEER_PAIRING_TTL_MS + 1;
    expect(h.host.pairingStatus(begun.pairingId).state).toBe("expired");
    expect(h.host.listPending()).toHaveLength(0);
    expect(await h.host.approvePairing(begun.pairingId, code)).toBe("not-found");
  });

  test("a finished pairing stays answerable until its TTL", async () => {
    const { begun, code } = await pairUntilApproval(h);
    await h.host.approvePairing(begun.pairingId, code);
    h.clock.value += PEER_PAIRING_TTL_MS - 1;
    expect(h.host.pairingStatus(begun.pairingId).state).toBe("approved");
  });

  test("limits: 3 per address, 8 overall, and the same device replaces its own request", async () => {
    for (let index = 0; index < 3; index++) {
      await h.host.beginPairing(makeDevice(`device-a${index}00000`).begin, "10.0.0.1");
    }
    await expect(h.host.beginPairing(makeDevice("device-a900000").begin, "10.0.0.1")).rejects.toMatchObject({
      code: "too-many-requests",
    });
    for (let index = 0; index < 5; index++) {
      await h.host.beginPairing(makeDevice(`device-b${index}00000`).begin, `10.0.1.${index}`);
    }
    expect(h.host.listPending()).toHaveLength(8);
    await expect(h.host.beginPairing(makeDevice("device-c000000").begin, "10.0.2.1")).rejects.toMatchObject({
      code: "too-many-requests",
    });
    const again = makeDevice("device-a000000");
    const first = h.host.listPending().find((entry) => entry.deviceId === "device-a000000")!;
    const replaced = await h.host.beginPairing(again.begin, "10.0.0.1");
    expect(replaced.pairingId).not.toBe(first.pairingId);
    expect(h.host.pairingStatus(first.pairingId).state).toBe("expired");
    expect(h.host.listPending()).toHaveLength(8);
  });

  test("a rejected pairing does not count against the limits", async () => {
    for (let index = 0; index < 3; index++) {
      const begun = await h.host.beginPairing(makeDevice(`device-a${index}00000`).begin, "10.0.0.1");
      expect(h.host.rejectPairing(begun.pairingId)).toBe(true);
    }
    await h.host.beginPairing(makeDevice("device-a900000").begin, "10.0.0.1");
  });

  test("rejectPairing answers false for unknown or finished pairings", async () => {
    expect(h.host.rejectPairing("missing-id")).toBe(false);
    const begun = await h.host.beginPairing(makeDevice().begin, "10.0.0.1");
    expect(h.host.rejectPairing(begun.pairingId)).toBe(true);
    expect(h.host.rejectPairing(begun.pairingId)).toBe(false);
  });

  test("hosting disabled refuses pairing and every PSK lookup", async () => {
    const { begun, code } = await pairUntilApproval(h);
    await h.host.approvePairing(begun.pairingId, code);
    expect(h.host.pskForIdentity(PEER_PAIRING_IDENTITY)?.equals(PEER_PAIRING_PSK)).toBe(true);
    expect(h.host.pskForIdentity("device-0001")).not.toBeNull();
    h.settings.hosting.enabled = false;
    expect(h.host.pskForIdentity(PEER_PAIRING_IDENTITY)).toBeNull();
    expect(h.host.pskForIdentity("device-0001")).toBeNull();
    await expect(h.host.beginPairing(makeDevice("device-0002").begin, "10.0.0.1")).rejects.toMatchObject({
      code: "hosting-disabled",
    });
  });

  test("pskForIdentity is null before the identity is loaded and for unknown identities", async () => {
    expect(h.host.pskForIdentity(PEER_PAIRING_IDENTITY)).toBeNull();
    await h.host.ensureIdentity();
    expect(h.host.pskForIdentity(PEER_PAIRING_IDENTITY)).not.toBeNull();
    expect(h.host.pskForIdentity("device-unknown")).toBeNull();
  });

  test("re-pairing the same device id replaces the record and changes the PSK", async () => {
    const first = await pairUntilApproval(h);
    await h.host.approvePairing(first.begun.pairingId, first.code);
    const before = Buffer.from(h.host.pskForIdentity("device-0001")!);
    h.clock.value += 5000;
    const second = await pairUntilApproval(h, makeDevice("device-0001"));
    expect(await h.host.approvePairing(second.begun.pairingId, second.code)).toBe("approved");
    expect(h.settings.devices).toHaveLength(1);
    expect(h.settings.devices[0]!.publicKey).toBe(second.device.publicKey);
    expect(h.settings.devices[0]!.pairedAt).toBe(h.clock.value);
    expect(h.host.pskForIdentity("device-0001")!.equals(before)).toBe(false);
  });

  test("removeDevice clears the PSK and emits the removal", async () => {
    const { begun, code } = await pairUntilApproval(h);
    await h.host.approvePairing(begun.pairingId, code);
    expect(h.host.pskForIdentity("device-0001")).not.toBeNull();
    h.events.length = 0;
    expect(await h.host.removeDevice("device-0001")).toBe(true);
    expect(h.host.pskForIdentity("device-0001")).toBeNull();
    expect(h.host.listDevices()).toEqual([]);
    expect(h.events).toEqual([
      { event: "peers:device-removed", payload: { deviceId: "device-0001" } },
      { event: "peers:updated", payload: {} },
    ]);
    expect(await h.host.removeDevice("device-0001")).toBe(false);
  });

  test("ensureIdentity is idempotent and concurrent callers share one key", async () => {
    const results = await Promise.all([h.host.ensureIdentity(), h.host.ensureIdentity(), h.host.ensureIdentity()]);
    expect(h.setSecretCalls.value).toBe(1);
    expect(h.updateReasons.filter((reason) => reason === "peers:instance-id")).toHaveLength(1);
    expect(new Set(results.map((entry) => entry.instanceId)).size).toBe(1);
    expect(new Set(results.map((entry) => entry.publicKey)).size).toBe(1);
    expect(h.settings.instanceId).toBe(results[0]!.instanceId);
    expect(h.secrets.get(PEER_HOST_KEY_REF)).toContain("PRIVATE KEY");
    expect(await h.host.ensureIdentity()).toEqual(results[0]);
    expect(h.setSecretCalls.value).toBe(1);
  });

  test("a second instance over the same stores keeps the same identity", async () => {
    const first = await h.host.ensureIdentity();
    const again = createPeerHost({
      getSettings: () => h.settings,
      updateSettings: async (_reason, update) => update(h.settings),
      credentials: {
        getSecret: (ref) => h.secrets.get(ref) ?? "",
        setSecret: async () => {
          throw new Error("must not write");
        },
        isEncryptionAvailable: () => true,
      },
      appVersion: "1",
      hostName: () => "x",
      emit: () => {},
    });
    expect(await again.ensureIdentity()).toEqual(first);
  });

  test("a credential store refusal becomes storage-unavailable and can be retried", async () => {
    h.failSetSecret.value = true;
    await expect(h.host.ensureIdentity()).rejects.toMatchObject({ code: "storage-unavailable" });
    expect(h.settings.instanceId).toBe("");
    await expect(h.host.beginPairing(makeDevice().begin, "10.0.0.1")).rejects.toMatchObject({
      code: "storage-unavailable",
    });
    h.failSetSecret.value = false;
    await expect(h.host.ensureIdentity()).resolves.toMatchObject({ instanceId: expect.any(String) });
  });

  test("a corrupt stored key throws and is not replaced", async () => {
    h.secrets.set(PEER_HOST_KEY_REF, "not a pem");
    await expect(h.host.ensureIdentity()).rejects.toThrow(/cannot be read/);
    expect(h.secrets.get(PEER_HOST_KEY_REF)).toBe("not a pem");
    expect(h.setSecretCalls.value).toBe(0);
  });

  test("noteDeviceSeen persists at most once a minute per device", async () => {
    const { begun, code } = await pairUntilApproval(h);
    await h.host.approvePairing(begun.pairingId, code);
    const seenWrites = () => h.updateReasons.filter((reason) => reason === "peers:device-seen").length;
    h.clock.value += 1000;
    h.host.noteDeviceSeen("device-0001", "10.0.0.9");
    await Promise.resolve();
    await Promise.resolve();
    expect(seenWrites()).toBe(1);
    expect(h.settings.devices[0]).toMatchObject({ lastSeenAt: h.clock.value, lastAddress: "10.0.0.9" });
    h.clock.value += 30_000;
    h.host.noteDeviceSeen("device-0001", "10.0.0.10");
    expect(seenWrites()).toBe(1);
    h.clock.value += 31_000;
    h.host.noteDeviceSeen("device-0001", "10.0.0.11");
    expect(seenWrites()).toBe(2);
    h.host.noteDeviceSeen("device-unknown", "10.0.0.11");
    expect(seenWrites()).toBe(2);
  });

  test("noteDeviceSeen never throws when persisting fails", async () => {
    const { begun, code } = await pairUntilApproval(h);
    await h.host.approvePairing(begun.pairingId, code);
    const failing = createPeerHost({
      getSettings: () => h.settings,
      updateSettings: () => Promise.reject(new Error("disk full")),
      credentials: { getSecret: () => "", setSecret: async () => {}, isEncryptionAvailable: () => true },
      appVersion: "1",
      hostName: () => "x",
      emit: () => {},
    });
    expect(() => failing.noteDeviceSeen("device-0001", "10.0.0.9")).not.toThrow();
    await Promise.resolve();
  });
});

import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { exportRawPublicKey, generateX25519KeyPair } from "../mobile/mobile-crypto.js";
import {
  computePeerCommitment,
  computePeerSas,
  derivePeerPsk,
  formatPeerSas,
  peerCommitmentMatches,
  peerSasMatches,
  type PeerSasFields,
} from "./peer-crypto.js";

const b64 = () => randomBytes(32).toString("base64");

function sasFields(): PeerSasFields {
  return {
    pairingId: "pairing-0001",
    hostInstanceId: "host-instance-1",
    hostPublicKey: b64(),
    hostNonce: b64(),
    deviceId: "device-0001",
    devicePublicKey: b64(),
    deviceNonce: b64(),
  };
}

describe("peer commitment", () => {
  const fields = { deviceId: "device-0001", publicKey: b64(), nonce: b64() };

  test("round trips", () => {
    expect(peerCommitmentMatches(computePeerCommitment(fields), fields)).toBe(true);
  });

  test.each([
    ["deviceId", { deviceId: "device-0002" }],
    ["publicKey", { publicKey: b64() }],
    ["nonce", { nonce: b64() }],
  ])("a changed %s does not match", (_name, change) => {
    expect(peerCommitmentMatches(computePeerCommitment(fields), { ...fields, ...change })).toBe(false);
  });

  test("garbage commitments do not match", () => {
    expect(peerCommitmentMatches("", fields)).toBe(false);
    expect(peerCommitmentMatches("AAAA", fields)).toBe(false);
  });

  test("non-canonical inputs are rejected", () => {
    expect(() => computePeerCommitment({ ...fields, publicKey: fields.publicKey.slice(0, 43) })).toThrow();
    expect(() => computePeerCommitment({ ...fields, nonce: randomBytes(31).toString("base64") })).toThrow();
  });
});

describe("peer SAS", () => {
  test("is deterministic and eight digits", () => {
    const fields = sasFields();
    const sas = computePeerSas(fields);
    expect(sas).toMatch(/^\d{8}$/);
    expect(computePeerSas({ ...fields })).toBe(sas);
  });

  test.each<[keyof PeerSasFields, () => string]>([
    ["pairingId", () => "pairing-0002"],
    ["hostInstanceId", () => "host-instance-2"],
    ["hostPublicKey", b64],
    ["hostNonce", b64],
    ["deviceId", () => "device-0002"],
    ["devicePublicKey", b64],
    ["deviceNonce", b64],
  ])("changes when %s changes", (field, next) => {
    const fields = sasFields();
    expect(computePeerSas({ ...fields, [field]: next() })).not.toBe(computePeerSas(fields));
  });

  test("accepts spaced and plain digits", () => {
    expect(peerSasMatches("12345678", "1234 5678")).toBe(true);
    expect(peerSasMatches("12345678", "12345678")).toBe(true);
    expect(formatPeerSas("12345678")).toBe("1234 5678");
  });

  test("rejects wrong, short and empty input", () => {
    expect(peerSasMatches("12345678", "12345679")).toBe(false);
    expect(peerSasMatches("12345678", "1234567")).toBe(false);
    expect(peerSasMatches("12345678", "")).toBe(false);
  });
});

describe("peer PSK", () => {
  const host = generateX25519KeyPair();
  const device = generateX25519KeyPair();
  const hostPublic = exportRawPublicKey(host.publicKey).toString("base64");
  const devicePublic = exportRawPublicKey(device.publicKey).toString("base64");
  const ids = { hostInstanceId: "host-instance-1", deviceId: "device-0001" };

  test("is symmetric and 32 bytes", () => {
    const hostSide = derivePeerPsk({ privateKey: host.privateKey, remotePublicKey: devicePublic, ...ids });
    const deviceSide = derivePeerPsk({ privateKey: device.privateKey, remotePublicKey: hostPublic, ...ids });
    expect(hostSide.length).toBe(32);
    expect(hostSide.equals(deviceSide)).toBe(true);
  });

  test("differs for another device id or host instance id", () => {
    const base = derivePeerPsk({ privateKey: host.privateKey, remotePublicKey: devicePublic, ...ids });
    const otherDevice = derivePeerPsk({
      privateKey: host.privateKey,
      remotePublicKey: devicePublic,
      ...ids,
      deviceId: "device-0002",
    });
    const otherHost = derivePeerPsk({
      privateKey: host.privateKey,
      remotePublicKey: devicePublic,
      ...ids,
      hostInstanceId: "host-instance-2",
    });
    expect(base.equals(otherDevice)).toBe(false);
    expect(base.equals(otherHost)).toBe(false);
  });

  test("rejects non-canonical public keys", () => {
    expect(() =>
      derivePeerPsk({ privateKey: host.privateKey, remotePublicKey: devicePublic.slice(0, 43), ...ids }),
    ).toThrow();
    expect(() =>
      derivePeerPsk({
        privateKey: host.privateKey,
        remotePublicKey: randomBytes(31).toString("base64"),
        ...ids,
      }),
    ).toThrow();
  });
});

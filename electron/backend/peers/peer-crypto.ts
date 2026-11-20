import { createHash, timingSafeEqual, type KeyObject } from "node:crypto";
import { PEER_PROTOCOL_VERSION, PEER_SAS_DIGITS } from "../../shared/peers.js";
import { deriveSessionKey, publicKeyFromRaw } from "../mobile/mobile-crypto.js";

/**
 * TLS-PSK is what protects a paired desktop's connection: the key comes out of the pairing, so there
 * is no certificate to mint or pin. TLS 1.2 on purpose — Electron's TLS library refuses an external
 * PSK under TLS 1.3, while plain Node accepts both.
 */
export const PEER_TLS_OPTIONS = {
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
  ciphers: "ECDHE-PSK-CHACHA20-POLY1305",
} as const;

/**
 * The identity and key a desktop that is NOT paired yet connects with. Public by design: such a
 * connection is private against a listener but proves nothing, may only reach the pairing routes,
 * and the pairing code is what authenticates the exchange carried over it.
 */
export const PEER_PAIRING_IDENTITY = "strideterm-peer-pairing-v1";
export const PEER_PAIRING_PSK = createHash("sha256").update("strideterm-peer/pairing-psk/v1").digest();

const COMMITMENT_DOMAIN = "strideterm-peer/pairing-commitment/v1";
const SAS_DOMAIN = "strideterm-peer/pairing-sas/v1";
const PSK_INFO = Buffer.from("strideterm-peer/psk/v1", "utf8");

function canonicalBytes32(value: string, label: string): Buffer {
  const decoded = Buffer.from(String(value || ""), "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error(`${label} must be 32 bytes in canonical base64`);
  }
  return decoded;
}

function digest(lines: string[]): Buffer {
  return createHash("sha256").update(lines.join("\n"), "utf8").digest();
}

/**
 * What the device sends BEFORE it learns the host's key and nonce. Without it the pairing code
 * protects nothing: a machine in the middle could keep choosing its own values until both sides
 * computed the same eight digits.
 */
export function computePeerCommitment(fields: { deviceId: string; publicKey: string; nonce: string }): string {
  canonicalBytes32(fields.publicKey, "Public key");
  canonicalBytes32(fields.nonce, "Nonce");
  return digest([COMMITMENT_DOMAIN, fields.deviceId, fields.publicKey, fields.nonce]).toString("base64");
}

export function peerCommitmentMatches(
  commitment: string,
  fields: { deviceId: string; publicKey: string; nonce: string },
): boolean {
  const expected = Buffer.from(computePeerCommitment(fields), "base64");
  const given = Buffer.from(commitment, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface PeerSasFields {
  pairingId: string;
  hostInstanceId: string;
  hostPublicKey: string;
  hostNonce: string;
  deviceId: string;
  devicePublicKey: string;
  deviceNonce: string;
}

/** The pairing code, as digits only. Both ends derive it; only the device ever shows it. */
export function computePeerSas(fields: PeerSasFields): string {
  for (const [label, value] of [
    ["Host public key", fields.hostPublicKey],
    ["Host nonce", fields.hostNonce],
    ["Device public key", fields.devicePublicKey],
    ["Device nonce", fields.deviceNonce],
  ] as const) {
    canonicalBytes32(value, label);
  }
  const hash = digest([
    SAS_DOMAIN,
    String(PEER_PROTOCOL_VERSION),
    fields.pairingId,
    fields.hostInstanceId,
    fields.hostPublicKey,
    fields.hostNonce,
    fields.deviceId,
    fields.devicePublicKey,
    fields.deviceNonce,
  ]);
  let value = 0;
  for (let index = 0; index < 6; index++) value = value * 256 + hash[index]!;
  return String(value % 10 ** PEER_SAS_DIGITS).padStart(PEER_SAS_DIGITS, "0");
}

export function formatPeerSas(digits: string): string {
  const half = PEER_SAS_DIGITS / 2;
  return `${digits.slice(0, half)} ${digits.slice(half)}`;
}

export function peerSasMatches(expectedDigits: string, typed: string): boolean {
  const entered = Buffer.from(String(typed || "").replace(/\D/g, ""), "utf8");
  const expected = Buffer.from(expectedDigits, "utf8");
  return entered.length === expected.length && timingSafeEqual(entered, expected);
}

/** The TLS key of one (host, device) pair. Never stored: each side derives it from its own private key. */
export function derivePeerPsk(args: {
  privateKey: KeyObject;
  remotePublicKey: string;
  hostInstanceId: string;
  deviceId: string;
}): Buffer {
  const remote = publicKeyFromRaw(canonicalBytes32(args.remotePublicKey, "Public key"));
  const salt = digest(["strideterm-peer/psk-salt/v1", args.hostInstanceId, args.deviceId]);
  return deriveSessionKey(args.privateKey, remote, salt, PSK_INFO);
}

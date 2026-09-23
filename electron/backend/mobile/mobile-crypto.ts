/// <reference types="node" />
/**
 * Envelope crypto for the desktop side of the mobile control channel —
 * X25519 key agreement + HKDF-SHA-256 + AES-256-GCM, built entirely on
 * Node's built-in `node:crypto` (OpenSSL-backed), no third-party crypto
 * dependency.
 *
 * This is a deliberate near-verbatim mirror of
 * strideterm-mobile/protocol/typescript/src/crypto/envelope-crypto.ts (same
 * algorithm choices, same nonce discipline, same DER wrapping for raw
 * X25519 keys). It exists as separate hand-written code in two repos —
 * not a shared package — for the same reason mobile-schemas.ts is a hand
 * mirror rather than an import: no versioned `@strideterm/mobile-protocol`
 * build exists yet in this sandbox (plan §3.2). Since both sides use the
 * exact same Node crypto primitives, this module's output is byte-for-byte
 * cross-checkable against the sibling repo's own test vectors — see
 * mobile-crypto.test.ts.
 *
 * Nonce-reuse safety: sealEnvelope always generates its own fresh random
 * 96-bit nonce internally and never accepts one from the caller. This module
 * is stateless — callers must fold the envelope's messageId into `aad`
 * (GCM authenticates aad) so ciphertext can't be replayed under a different
 * messageId. Duplicate-submission rejection (idempotencyKey / sequenceNumber)
 * is an application-level concern, not this module's.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import {
  PAIRING_APPROVAL_DOMAIN,
  PAIRING_FINGERPRINT_DOMAIN,
  PAIRING_GRANT_COMMITMENT_DOMAIN,
  PAIRING_KEY_PROOF_CHALLENGE_BYTES,
  PAIRING_KEY_PROOF_DOMAIN,
  PAIRING_SAS_DIGITS,
  PAIRING_SAS_DOMAIN,
  X25519_PUBLIC_KEY_BYTES,
} from "./mobile-schemas.js";

const AES_GCM_KEY_BYTES = 32; // AES-256
const AES_GCM_NONCE_BYTES = 12; // 96-bit GCM nonce
const AES_GCM_TAG_BYTES = 16;
const X25519_SEED_BYTES = 32;
const X25519_RAW_KEY_BYTES = 32;

// Fixed ASN.1 prefixes for wrapping a raw 32-byte X25519 key in PKCS8 (private)
// / SPKI (public) DER, per RFC 8410 — Node's crypto module only accepts
// X25519 keys via a DER/PEM/JWK container, not raw bytes directly.
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export interface X25519KeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

/** Generates a fresh random X25519 key pair (production device keys). */
export function generateX25519KeyPair(): X25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { publicKey, privateKey };
}

/**
 * PEM (PKCS8) export/import for this desktop's own long-lived device private
 * key, so runtime.ts can persist it via credential-store (setSecret/getSecret
 * work with strings) across restarts — the private key itself never leaves
 * that store (plan §5.1/§10.4: "Private keys nesmí být exportovány... do
 * state JSON... Firebase").
 */
export function exportPrivateKeyPem(privateKey: KeyObject): string {
  return privateKey.export({ format: "pem", type: "pkcs8" }) as string;
}

export function importPrivateKeyPem(pem: string): X25519KeyPair {
  const privateKey = createPrivateKey({ key: pem, format: "pem" });
  const publicKey = createPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * Deterministically derives an X25519 key pair from a fixed 32-byte seed.
 * Only for reproducible tests / cross-repo test-vector checks — production
 * device keys must use generateX25519KeyPair.
 */
export function x25519KeyPairFromSeed(seed: Buffer): X25519KeyPair {
  if (seed.length !== X25519_SEED_BYTES) {
    throw new Error(`X25519 seed must be exactly ${X25519_SEED_BYTES} bytes`);
  }
  const der = Buffer.concat([X25519_PKCS8_PREFIX, seed]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  return { publicKey, privateKey };
}

/** Exports the raw 32-byte X25519 public key from a KeyObject. */
export function exportRawPublicKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url");
}

/** Reconstructs an X25519 public KeyObject from its raw 32-byte form. */
export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== X25519_RAW_KEY_BYTES) {
    throw new Error(`X25519 public key must be exactly ${X25519_RAW_KEY_BYTES} bytes`);
  }
  const der = Buffer.concat([X25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/**
 * Derives a 32-byte AES-256-GCM session key via X25519 key agreement
 * followed by HKDF-SHA-256.
 */
export function deriveSessionKey(
  localPrivateKey: KeyObject,
  remotePublicKey: KeyObject,
  salt: Buffer,
  info: Buffer,
): Buffer {
  const sharedSecret = diffieHellman({ privateKey: localPrivateKey, publicKey: remotePublicKey });
  return Buffer.from(hkdfSync("sha256", sharedSecret, salt, info, AES_GCM_KEY_BYTES));
}

export interface SealedEnvelope {
  ciphertext: Buffer;
  nonce: Buffer;
}

/**
 * Seals `plaintext` with AES-256-GCM under `key`, authenticating `aad`
 * (which must already fold in the envelope's messageId). Always generates a
 * fresh random 96-bit nonce; nonce is never a parameter.
 */
export function sealEnvelope(plaintext: Buffer, key: Buffer, aad: Buffer): SealedEnvelope {
  if (key.length !== AES_GCM_KEY_BYTES) {
    throw new Error(`AES-256-GCM key must be exactly ${AES_GCM_KEY_BYTES} bytes`);
  }
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([encrypted, authTag]), nonce };
}

/**
 * Opens a ciphertext produced by sealEnvelope. `aad` must exactly match what
 * was passed to sealEnvelope (including the folded-in messageId) or
 * authentication fails and this throws.
 */
export function openEnvelope(ciphertext: Buffer, nonce: Buffer, key: Buffer, aad: Buffer): Buffer {
  if (key.length !== AES_GCM_KEY_BYTES) {
    throw new Error(`AES-256-GCM key must be exactly ${AES_GCM_KEY_BYTES} bytes`);
  }
  if (nonce.length !== AES_GCM_NONCE_BYTES) {
    throw new Error(`AES-256-GCM nonce must be exactly ${AES_GCM_NONCE_BYTES} bytes`);
  }
  if (ciphertext.length < AES_GCM_TAG_BYTES) {
    throw new Error("ciphertext too short to contain an AES-256-GCM auth tag");
  }
  const authTag = ciphertext.subarray(ciphertext.length - AES_GCM_TAG_BYTES);
  const encrypted = ciphertext.subarray(0, ciphertext.length - AES_GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * Combined nonce+ciphertext encoding for NotificationEvent (mobile-schemas.ts):
 * unlike EncryptedEnvelope, that wire schema has a single `ciphertext` field
 * with no separate `nonce` field (mirrored faithfully from the protocol
 * package — see mobile-schemas.ts). Since no reference implementation of the
 * actual byte encoding exists yet (the Flutter app is a later phase), this
 * module defines it: base64(12-byte nonce ‖ AES-GCM ciphertext+tag). Only
 * used for NotificationEvent; Command/CommandResult envelopes keep nonce and
 * ciphertext as separate EncryptedEnvelope fields.
 */
export function sealToCombinedBase64(plaintext: Buffer, key: Buffer, aad: Buffer): string {
  const sealed = sealEnvelope(plaintext, key, aad);
  return Buffer.concat([sealed.nonce, sealed.ciphertext]).toString("base64");
}

export function openCombinedBase64(combined: string, key: Buffer, aad: Buffer): Buffer {
  const buf = Buffer.from(combined, "base64");
  const nonce = buf.subarray(0, AES_GCM_NONCE_BYTES);
  const ciphertext = buf.subarray(AES_GCM_NONCE_BYTES);
  return openEnvelope(ciphertext, nonce, key, aad);
}

// ---------------------------------------------------------------------------
// Canonical routing AAD (hand mirror of the protocol package's buildRoutingAad)
// ---------------------------------------------------------------------------

/**
 * The ROUTING TRANSCRIPT: every wire field a receiver would otherwise have to
 * take on trust from the plaintext-visible part of a record.
 *
 * v1 bound four of them (messageId, pairId, senderDeviceId, messageType). That
 * left the addressee unbound — because there was no such field — so nothing
 * cryptographic distinguished "sealed for phone A" from "sealed for phone B",
 * and nothing stopped a record's timestamps or key version being edited in
 * place. v2 binds all nine (review 2 §P0.1).
 */
export interface RoutingAadFields {
  protocolVersion: number;
  pairId: string;
  /** EncryptedEnvelope.senderDeviceId, or NotificationEvent.sourceDeviceId. */
  sourceDeviceId: string;
  targetDeviceId: string;
  /** EncryptedEnvelope.messageId, or NotificationEvent.eventId. */
  messageId: string;
  messageType: string;
  sessionKeyVersion: number;
  createdAt: number;
  expiresAt: number;
}

/**
 * The canonical AAD bytes for a record on this channel: UTF-8 of
 * `{"protocolVersion":…,"pairId":…,"sourceDeviceId":…,"targetDeviceId":…,
 *   "messageId":…,"messageType":…,"sessionKeyVersion":…,"createdAt":…,"expiresAt":…}`
 * — exactly these nine keys, in this order, no whitespace.
 *
 * `EncryptedEnvelope.aad` is a plaintext, sender-chosen field. Decrypting with
 * whatever the sender attached proves only "the sender knew the session key";
 * it proves nothing about *which* message this is. The binding only exists if
 * the receiver recomputes the AAD from the record's own routing fields and
 * refuses to decrypt on a mismatch — see `routingAadMatches`, and
 * mobile-manager.ts's use of it on every inbound envelope.
 *
 * What each field buys, so none of them is cargo:
 *   - protocolVersion / sessionKeyVersion — a downgrade to an older wire or key
 *     generation cannot be presented as the current one.
 *   - targetDeviceId — the addressee. Moving a sealed record from one phone's
 *     mailbox to another's now fails the AEAD, so the path segment and the
 *     ciphertext cannot disagree.
 *   - messageType — a `command` ciphertext cannot be relabelled as its own
 *     `commandResult`, or the reverse.
 *   - createdAt / expiresAt — an expired record cannot be handed a fresh
 *     lifetime by editing the plaintext header.
 *
 * Byte-for-byte identical to strideterm-mobile's TypeScript and Dart
 * implementations; the shared fixtures in mobile-aad-vectors.json (a copy of
 * that repo's protocol/test-vectors/envelope-aad.json, kept in sync by
 * `npm run check:mobile-schema-drift`) are what pin the agreement.
 */
export function buildRoutingAad(fields: RoutingAadFields): Buffer {
  return Buffer.from(
    JSON.stringify({
      protocolVersion: fields.protocolVersion,
      pairId: fields.pairId,
      sourceDeviceId: fields.sourceDeviceId,
      targetDeviceId: fields.targetDeviceId,
      messageId: fields.messageId,
      messageType: fields.messageType,
      sessionKeyVersion: fields.sessionKeyVersion,
      createdAt: fields.createdAt,
      expiresAt: fields.expiresAt,
    }),
    "utf8",
  );
}

/** True when the AAD carried on the wire is exactly the one these routing fields imply. */
export function routingAadMatches(attachedAadBase64: string, fields: RoutingAadFields): boolean {
  const expected = buildRoutingAad(fields);
  let attached: Buffer;
  try {
    attached = Buffer.from(attachedAadBase64, "base64");
  } catch {
    return false;
  }
  return attached.length === expected.length && attached.equals(expected);
}

// ---------------------------------------------------------------------------
// Pairing transcript (hand mirror of protocol/typescript/src/crypto/pairing-transcript.ts)
// ---------------------------------------------------------------------------

/**
 * Strictly decodes a base64 X25519 public key: exactly 32 bytes, in the
 * *canonical* encoding of those bytes.
 *
 * Node's decoder silently accepts trailing garbage, missing padding and
 * non-alphabet characters, so without the re-encode check two different strings
 * would pin the same key — and the fingerprint transcript, which contains the
 * string, would then differ from the one the phone computed over its own
 * spelling of the same key.
 */
export function decodeCanonicalPublicKey(base64Key: string): Buffer {
  if (typeof base64Key !== "string" || base64Key.length === 0) {
    throw new Error("X25519 public key must be a non-empty base64 string");
  }
  const decoded = Buffer.from(base64Key, "base64");
  if (decoded.length !== X25519_PUBLIC_KEY_BYTES) {
    throw new Error(`X25519 public key must decode to exactly ${X25519_PUBLIC_KEY_BYTES} bytes`);
  }
  if (decoded.toString("base64") !== base64Key) {
    throw new Error("X25519 public key is not canonical base64");
  }
  return decoded;
}

/**
 * The bytes hashed into a desktop fingerprint: the domain string, the protocol
 * version, the desktop's device id and its canonical public key, each on its own
 * line.
 *
 * Line-separated rather than concatenated because the fields are
 * variable-length: `deviceId="ab"+key="cd"` and `deviceId="abc"+key="d"` must
 * not hash to the same value.
 */
export function buildPairingFingerprintTranscript(args: {
  protocolVersion: number;
  desktopDeviceId: string;
  desktopPublicKeyBase64: string;
}): Buffer {
  const canonicalKey = decodeCanonicalPublicKey(args.desktopPublicKeyBase64).toString("base64");
  return Buffer.from(
    [PAIRING_FINGERPRINT_DOMAIN, String(args.protocolVersion), args.desktopDeviceId, canonicalKey].join("\n"),
    "utf8",
  );
}

/**
 * The human-comparable desktop fingerprint: eight colon-separated groups of four
 * uppercase hex digits.
 *
 * WHAT CHANGED AND WHY (review 2 §P0.4). This used to be a bare SHA-256 of the
 * public key bytes, and the QR carried only the resulting string — not the key.
 * The phone showed the digits to the user and then stored whatever public key
 * the *backend* returned from claimPairing, never checking that the stored key
 * was the key those digits described. The two were joined by nothing but trust
 * in the control plane, and the encrypted verification round trip could not tell
 * the difference: it proves both parties use the same key, not that they use the
 * right one. The fingerprint is a commitment to a specific (version, device id,
 * key) triple now, the QR carries the key itself, and the phone recomputes this
 * value locally before it will continue.
 */
export function computeDesktopFingerprint(args: {
  protocolVersion: number;
  desktopDeviceId: string;
  desktopPublicKeyBase64: string;
}): string {
  const digest = createHash("sha256").update(buildPairingFingerprintTranscript(args)).digest("hex");
  return (digest.match(/.{1,4}/g) || []).slice(0, 8).join(":").toUpperCase();
}

/** Every identity the pairing SAS commits to — both ends, both keys, one invitation. */
export interface PairingSasFields {
  protocolVersion: number;
  pairId: string;
  pairingId: string;
  desktopDeviceId: string;
  desktopPublicKeyBase64: string;
  mobileDeviceId: string;
  mobilePublicKeyBase64: string;
}

export function buildPairingSasTranscript(fields: PairingSasFields): Buffer {
  return Buffer.from(
    [
      PAIRING_SAS_DOMAIN,
      String(fields.protocolVersion),
      fields.pairId,
      fields.pairingId,
      fields.desktopDeviceId,
      decodeCanonicalPublicKey(fields.desktopPublicKeyBase64).toString("base64"),
      fields.mobileDeviceId,
      decodeCanonicalPublicKey(fields.mobilePublicKeyBase64).toString("base64"),
    ].join("\n"),
    "utf8",
  );
}

/**
 * The short authentication string both screens display, as `PAIRING_SAS_DIGITS`
 * decimal digits in two space-separated groups.
 *
 * Derived from BOTH public keys and BOTH device ids, so the code the two screens
 * show can only agree if both ends really hold the same two keys. A control
 * plane that swapped one key makes the two codes diverge — a difference a human
 * can act on.
 */
export function computePairingSas(fields: PairingSasFields): string {
  const digest = createHash("sha256").update(buildPairingSasTranscript(fields)).digest();
  // 6 bytes = 48 bits, comfortably more entropy than the digits rendered, so the
  // modulo bias is negligible and the arithmetic stays exactly representable in
  // both languages.
  let value = 0;
  for (let i = 0; i < 6; i++) value = value * 256 + digest[i]!;
  const digits = String(value % 10 ** PAIRING_SAS_DIGITS).padStart(PAIRING_SAS_DIGITS, "0");
  const half = Math.floor(PAIRING_SAS_DIGITS / 2);
  return `${digits.slice(0, half)} ${digits.slice(half)}`;
}

// ---------------------------------------------------------------------------
// Review 3 §P0.1 — the three commitments the pairing state machine turns on.
// Mirrors protocol/typescript/src/crypto/pairing-transcript.ts; the shared fixtures in
// mobile-pairing-vectors.json pin all three across the three implementations.
// ---------------------------------------------------------------------------

/**
 * Strictly decodes the QR's one-time key-proof challenge: canonical unpadded base64url of exactly
 * `PAIRING_KEY_PROOF_CHALLENGE_BYTES` bytes.
 *
 * Canonical for the same reason the public key must be — the transcript hashes the STRING, so two
 * spellings of the same bytes produce two different proofs and the two ends disagree with nothing
 * naming the encoding as the cause.
 */
export function decodeCanonicalKeyProofChallenge(base64urlChallenge: string): Buffer {
  if (typeof base64urlChallenge !== "string" || base64urlChallenge.length === 0) {
    throw new Error("pairing key-proof challenge must be a non-empty base64url string");
  }
  const decoded = Buffer.from(base64urlChallenge, "base64url");
  if (decoded.length !== PAIRING_KEY_PROOF_CHALLENGE_BYTES) {
    throw new Error(
      `pairing key-proof challenge must decode to exactly ${PAIRING_KEY_PROOF_CHALLENGE_BYTES} bytes, got ${decoded.length}`,
    );
  }
  if (decoded.toString("base64url") !== base64urlChallenge) {
    throw new Error("pairing key-proof challenge is not canonical base64url");
  }
  return decoded;
}

/** Everything the claim-time key proof commits to. */
export interface PairingKeyProofFields {
  protocolVersion: number;
  pairId: string;
  pairingId: string;
  desktopDeviceId: string;
  desktopPublicKeyBase64: string;
  mobileDeviceId: string;
  mobilePublicKeyBase64: string;
  /** The one-time challenge this desktop put in the QR — never in any cloud record. */
  challengeBase64Url: string;
}

export function buildPairingKeyProofTranscript(fields: PairingKeyProofFields): Buffer {
  return Buffer.from(
    [
      PAIRING_KEY_PROOF_DOMAIN,
      String(fields.protocolVersion),
      fields.pairId,
      fields.pairingId,
      fields.desktopDeviceId,
      decodeCanonicalPublicKey(fields.desktopPublicKeyBase64).toString("base64"),
      fields.mobileDeviceId,
      decodeCanonicalPublicKey(fields.mobilePublicKeyBase64).toString("base64"),
      decodeCanonicalKeyProofChallenge(fields.challengeBase64Url).toString("base64url"),
    ].join("\n"),
    "utf8",
  );
}

/**
 * The claiming device's proof that it holds the private key behind the public key it published, and
 * that it scanned this desktop's QR.
 *
 * This desktop recomputes it with its OWN private key and the record's public key. That is what makes
 * an injected device record unusable: the injector can choose any public key it likes, but it cannot
 * produce a MAC under a session key derived from this desktop's private key, and it never saw the
 * challenge either. It replaces v2's post-claim encrypted challenge event, which had to be delivered
 * to a device nobody had approved.
 */
export function computeKeyProof(sessionKey: Buffer, fields: PairingKeyProofFields): string {
  return createHmac("sha256", sessionKey).update(buildPairingKeyProofTranscript(fields)).digest("base64url");
}

/** Constant-time comparison of two key proofs. */
export function keyProofsEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export interface PairingGrantCommitmentFields {
  protocolVersion: number;
  pairId: string;
  pairingId: string;
  mobileDeviceId: string;
  capabilities: readonly string[];
  profileAllowlist: readonly string[];
}

/**
 * Digest over the grants `claimPairing` copied from the invitation.
 *
 * The server writes it onto the device record; this desktop recomputes it from the options the human
 * actually ticked in the dialog it still has open, and refuses the claim on a mismatch. Without it,
 * the desktop read `capabilities` and `profileAllowlist` out of its own pending invitation and stapled
 * them onto whatever record appeared — so the grants the cloud recorded and the grants this desktop
 * enforced were never compared (review 3 §P0.1).
 *
 * Sorted before hashing, so a re-ordered list is the same commitment; the two-level separator keeps
 * ["a","b"] distinct from ["ab"].
 */
export function computeGrantCommitment(fields: PairingGrantCommitmentFields): string {
  return createHash("sha256")
    .update(
      Buffer.from(
        [
          PAIRING_GRANT_COMMITMENT_DOMAIN,
          String(fields.protocolVersion),
          fields.pairId,
          fields.pairingId,
          fields.mobileDeviceId,
          [...fields.capabilities].sort().join(""),
          [...fields.profileAllowlist].sort().join(""),
        ].join("\n"),
        "utf8",
      ),
    )
    .digest("hex");
}

export interface PairingApprovalFields {
  protocolVersion: number;
  pairId: string;
  pairingId: string;
  desktopDeviceId: string;
  desktopPublicKeyBase64: string;
  mobileDeviceId: string;
  mobilePublicKeyBase64: string;
  grantCommitment: string;
}

/**
 * The transcript hash `approvePairing` takes as an argument and recomputes server-side.
 *
 * Not a secret and not authorization — the caller's uid is. It is an agreement check: this desktop can
 * only produce the value from the same two public keys, the same invitation and the same grant
 * commitment the record holds, so an activation cannot be replayed against a record whose key or
 * grants moved between the SAS being rendered and the button being pressed.
 */
export function computePairingApprovalTranscriptHash(fields: PairingApprovalFields): string {
  return createHash("sha256")
    .update(
      Buffer.from(
        [
          PAIRING_APPROVAL_DOMAIN,
          String(fields.protocolVersion),
          fields.pairId,
          fields.pairingId,
          fields.desktopDeviceId,
          decodeCanonicalPublicKey(fields.desktopPublicKeyBase64).toString("base64"),
          fields.mobileDeviceId,
          decodeCanonicalPublicKey(fields.mobilePublicKeyBase64).toString("base64"),
          fields.grantCommitment,
        ].join("\n"),
        "utf8",
      ),
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Relay end-to-end encryption (plan 2026-09-23, decisions 1 and 2).
//
// Hand mirror of strideterm-mobile/protocol/typescript/src/crypto/relay-e2e-crypto.ts, same
// reasoning as the rest of this file for why it is a mirror rather than an import. The shared
// fixtures in mobile-relay-e2e-vectors.json (a copy of that repo's protocol/test-vectors/
// relay-e2e.json, kept in sync by `npm run check:mobile-schema-drift`) are what pin the agreement
// between this implementation and the mobile app's.
//
// INVARIANT this whole section exists to uphold: the relay session key never leaves this process
// and the phone's — it is derived from material agreed over the Firebase envelope channel, never
// from anything the relay Worker sends or can influence. See mobile-relay-connector.ts for where
// the derived keys and the per-direction counters actually live (in memory only, TTL bound to the
// ticket, never logged or persisted — CLAUDE.md's "relay session key" invariant).
// ---------------------------------------------------------------------------

export const RELAY_E2E_VERSION = 1 as const;
export const RELAY_E2E_HKDF_INFO = "strideterm-relay-e2e/v1" as const;
export const RELAY_E2E_AEAD_ALG = "AES-256-GCM" as const;
export const RELAY_E2E_KEY_BYTES = 32 as const;
export const RELAY_E2E_DERIVED_KEY_BYTES = 64 as const;
export const RELAY_E2E_NONCE_BYTES = 12 as const;
export const RELAY_E2E_NONCE_RESERVED_BYTES = 4 as const;
export const RELAY_E2E_NONCE_COUNTER_BYTES = 8 as const;
export const RELAY_E2E_X25519_PUBLIC_KEY_BYTES = 32 as const;

const RELAY_E2E_AES_GCM_TAG_BYTES = 16;

/** The desktop's half of the key-exchange transcript — the `e2e` block of a `remote.endpoint.request` answer. */
export interface RelayE2eDesktopOffer {
  v: 1;
  keyId: string;
  desktopEphemeralPub: string;
}

/** The phone's half — the `e2e` block of its `remote.webSession.issue`. */
export interface RelayE2ePhoneAcceptance {
  v: 1;
  keyId: string;
  phoneEphemeralPub: string;
}

/**
 * HKDF salt: SHA-256 over both `e2e` blocks, desktop offer first, each as a canonical JSON object
 * with exactly its three keys in this exact order, no whitespace, concatenated (not itself one
 * JSON document) before hashing.
 */
export function relayE2eSalt(desktop: RelayE2eDesktopOffer, phone: RelayE2ePhoneAcceptance): Buffer {
  const canonical =
    JSON.stringify({ v: desktop.v, keyId: desktop.keyId, desktopEphemeralPub: desktop.desktopEphemeralPub }) +
    JSON.stringify({ v: phone.v, keyId: phone.keyId, phoneEphemeralPub: phone.phoneEphemeralPub });
  return createHash("sha256").update(canonical, "utf8").digest();
}

/**
 * HKDF info: `RELAY_E2E_HKDF_INFO` and the pairing/device/ticket identifiers, slash-delimited —
 * the same domain-separation shape as `PAIRING_SAS_DOMAIN` elsewhere in this file, chosen so
 * `pairId="ab", deviceId="cd"` cannot collide with `pairId="a", deviceId="bcd"` the way raw
 * concatenation would.
 */
export function relayE2eInfo(pairId: string, deviceId: string, ticketId: string): Buffer {
  return Buffer.from(`${RELAY_E2E_HKDF_INFO}/${pairId}/${deviceId}/${ticketId}`, "utf8");
}

export interface RelayE2eKeys {
  desktopToPhone: Buffer;
  phoneToDesktop: Buffer;
}

/**
 * Derives the two directional session keys from the ephemeral ECDH output (forward secrecy for
 * this one relay session) followed by the long-term pairing-key ECDH output (binds the session to
 * the paired device, exactly like the existing envelope session key). `RELAY_E2E_DERIVED_KEY_BYTES`
 * bytes come out of HKDF-SHA-256 and split evenly: the first half is the desktop->phone key, the
 * second the phone->desktop key.
 */
export function deriveRelayE2eKeys(
  ephemeralPrivateKey: KeyObject,
  ephemeralRemotePublicKey: KeyObject,
  pairingPrivateKey: KeyObject,
  pairingRemotePublicKey: KeyObject,
  salt: Buffer,
  info: Buffer,
): RelayE2eKeys {
  const ephemeralShared = diffieHellman({ privateKey: ephemeralPrivateKey, publicKey: ephemeralRemotePublicKey });
  const pairingShared = diffieHellman({ privateKey: pairingPrivateKey, publicKey: pairingRemotePublicKey });
  const ikm = Buffer.concat([ephemeralShared, pairingShared]);
  const derived = Buffer.from(hkdfSync("sha256", ikm, salt, info, RELAY_E2E_DERIVED_KEY_BYTES));
  return {
    desktopToPhone: derived.subarray(0, RELAY_E2E_KEY_BYTES),
    phoneToDesktop: derived.subarray(RELAY_E2E_KEY_BYTES, 2 * RELAY_E2E_KEY_BYTES),
  };
}

/** Builds the 12-byte nonce for frame `counter` in one direction: 4 reserved zero bytes + an 8-byte big-endian counter. */
export function relayE2eNonce(counter: bigint): Buffer {
  if (counter < 0n) throw new Error("relayE2eNonce: counter must not be negative");
  if (counter > 0xffffffffffffffffn) {
    throw new Error("relayE2eNonce: counter overflowed 64 bits — the session must end");
  }
  const nonce = Buffer.alloc(RELAY_E2E_NONCE_BYTES);
  nonce.writeBigUInt64BE(counter, RELAY_E2E_NONCE_RESERVED_BYTES);
  return nonce;
}

/**
 * Seals `plaintext` (a complete inner relay frame, produced by `encodeRelayFrame`) under `key` for
 * frame `counter` in this direction, authenticating `aad` (the canonical outer `e2e.data` frame
 * header bytes). Returns the exact `e2e.data` payload: `nonce || ciphertext-with-tag`.
 */
export function sealRelayE2eFrame(plaintext: Buffer, key: Buffer, counter: bigint, aad: Buffer): Buffer {
  if (key.length !== RELAY_E2E_KEY_BYTES) throw new Error(`relay-e2e key must be exactly ${RELAY_E2E_KEY_BYTES} bytes`);
  const nonce = relayE2eNonce(counter);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, authTag]);
}

/**
 * Opens an `e2e.data` payload produced by {@link sealRelayE2eFrame}. `aad` must exactly match what
 * the sender authenticated or this throws — never attempt a plaintext fallback on failure; the
 * caller ends the stream (`ws.error`) instead.
 */
export function openRelayE2eFrame(payload: Buffer, key: Buffer, aad: Buffer): Buffer {
  if (key.length !== RELAY_E2E_KEY_BYTES) throw new Error(`relay-e2e key must be exactly ${RELAY_E2E_KEY_BYTES} bytes`);
  if (payload.length < RELAY_E2E_NONCE_BYTES + RELAY_E2E_AES_GCM_TAG_BYTES) {
    throw new Error("relay-e2e payload too short to contain a nonce and an auth tag");
  }
  const nonce = payload.subarray(0, RELAY_E2E_NONCE_BYTES);
  const rest = payload.subarray(RELAY_E2E_NONCE_BYTES);
  const authTag = rest.subarray(rest.length - RELAY_E2E_AES_GCM_TAG_BYTES);
  const encrypted = rest.subarray(0, rest.length - RELAY_E2E_AES_GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/** Reads the frame counter back out of a nonce, for replay/ordering checks. */
export function relayE2eCounterOf(nonce: Buffer): bigint {
  if (nonce.length !== RELAY_E2E_NONCE_BYTES)
    throw new Error(`relay-e2e nonce must be exactly ${RELAY_E2E_NONCE_BYTES} bytes`);
  return nonce.readBigUInt64BE(RELAY_E2E_NONCE_RESERVED_BYTES);
}

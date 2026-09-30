/// <reference types="node" />
/**
 * This installation's relay identity: one long-lived Ed25519 keypair, one stable installation id.
 *
 * WHAT AN INSTALLATION IS. One data directory. Not one window, not one profile, not one workspace —
 * the relay plan §4 is explicit that the Durable Object corresponds to "one desktop installation
 * identity / data directory", and a second `--data-dir` is therefore a different desktop with no
 * path between the two. The id used is the same `mobile:desktop-device-id` the pairing already
 * generates once per data directory and reuses forever, so "installation" means exactly what it
 * already meant everywhere else in this integration rather than a fourth notion of identity.
 *
 * WHY A SEPARATE KEYPAIR FROM THE PAIRING KEY. The pairing key is X25519 and exists to derive a
 * session key with a phone; this one is Ed25519 and exists to sign a challenge for a relay. Reusing
 * one key across two algorithms and two protocols is the kind of economy that turns a weakness in
 * either into a weakness in both, and neither key is expensive.
 *
 * The private key never leaves the credential store, never reaches the relay and never appears in a
 * log — the relay only ever sees the raw public key and a signature over its own nonce.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { rawEd25519PublicKey, relayKeyFingerprint } from "./mobile-relay-protocol.js";

/** Credential-store reference for the relay installation private key. */
export const RELAY_INSTALLATION_KEY_REF = "mobile:relay-installation-private-key";

export interface RelayInstallationIdentity {
  /** Stable per data directory. Equals the desktop's mobile device id, which is also its pair id. */
  installationId: string;
  /** Unpadded base64url of the raw 32-byte Ed25519 public key. */
  publicKeyBase64Url: string;
  /** Unpadded base64url SHA-256 of that raw key — what a connector grant pins. */
  fingerprint: string;
  /** Signs the relay's challenge transcript. */
  signChallenge(transcript: Buffer): Buffer;
}

export interface RelayIdentityCredentialStore {
  getSecret(ref: string): string;
  setSecret(ref: string, secret: string): Promise<void>;
  isEncryptionAvailable?(): boolean;
}

/**
 * Loads the installation identity, generating and persisting the keypair on first use.
 *
 * The PEM is stored rather than a raw seed because that is what this codebase already does for the
 * pairing key (`exportPrivateKeyPem`), and one storage convention per repository is worth more than
 * a few saved bytes.
 */
export async function loadRelayInstallationIdentity(args: {
  installationId: string;
  credentialStore: RelayIdentityCredentialStore;
}): Promise<RelayInstallationIdentity> {
  const { installationId, credentialStore } = args;

  let privateKey: KeyObject;
  const existingPem = credentialStore.getSecret(RELAY_INSTALLATION_KEY_REF);
  if (existingPem) {
    privateKey = createPrivateKey({ key: existingPem, format: "pem", type: "pkcs8" });
  } else {
    const generated = generateKeyPairSync("ed25519");
    privateKey = generated.privateKey;
    try {
      await credentialStore.setSecret(
        RELAY_INSTALLATION_KEY_REF,
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      );
    } catch (err) {
      // The store refuses this key as plaintext when the OS keychain is unavailable. The identity is
      // also the account's installation key, so the runtime must still start: the key then lives for
      // this run only (and Mobile, which needs it persisted, stays off). Anything else is a real
      // storage failure and still surfaces.
      if (credentialStore.isEncryptionAvailable?.() !== false) throw err;
    }
  }

  const publicKey = createPublicKey(privateKey);
  const raw = rawEd25519PublicKey(publicKey);
  return {
    installationId,
    publicKeyBase64Url: raw.toString("base64url"),
    fingerprint: relayKeyFingerprint(raw),
    // Ed25519 signs the message directly — `null` is the correct digest argument, not an omission.
    signChallenge: (transcript: Buffer) => sign(null, transcript, privateKey),
  };
}

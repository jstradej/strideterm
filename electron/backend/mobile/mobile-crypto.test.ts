import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildRoutingAad,
  computeDesktopFingerprint,
  computeGrantCommitment,
  computeKeyProof,
  computePairingApprovalTranscriptHash,
  computePairingSas,
  decodeCanonicalKeyProofChallenge,
  decodeCanonicalPublicKey,
  deriveRelayE2eKeys,
  deriveSessionKey,
  keyProofsEqual,
  openRelayE2eFrame,
  relayE2eCounterOf,
  relayE2eInfo,
  relayE2eNonce,
  relayE2eSalt,
  routingAadMatches,
  RELAY_E2E_NONCE_BYTES,
  exportPrivateKeyPem,
  exportRawPublicKey,
  generateX25519KeyPair,
  importPrivateKeyPem,
  openCombinedBase64,
  openEnvelope,
  publicKeyFromRaw,
  sealEnvelope,
  sealRelayE2eFrame,
  sealToCombinedBase64,
  x25519KeyPairFromSeed,
  type RelayE2eDesktopOffer,
  type RelayE2ePhoneAcceptance,
} from "./mobile-crypto.js";

describe("mobile-crypto round trip", () => {
  test("sender and receiver derive the same session key", () => {
    const sender = generateX25519KeyPair();
    const receiver = generateX25519KeyPair();
    const salt = Buffer.from("salt");
    const info = Buffer.from("info");

    const senderKey = deriveSessionKey(sender.privateKey, receiver.publicKey, salt, info);
    const receiverKey = deriveSessionKey(receiver.privateKey, sender.publicKey, salt, info);
    expect(senderKey.equals(receiverKey)).toBe(true);
    expect(senderKey).toHaveLength(32);
  });

  test("seal/open round trip recovers the original plaintext", () => {
    const sender = generateX25519KeyPair();
    const receiver = generateX25519KeyPair();
    const key = deriveSessionKey(sender.privateKey, receiver.publicKey, Buffer.alloc(0), Buffer.from("v1"));
    const aad = Buffer.from("messageId:msg-1|pairId:pair-1");
    const plaintext = Buffer.from(JSON.stringify({ type: "task.pause", workspaceId: "ws-1", taskId: "task-1" }));

    const sealed = sealEnvelope(plaintext, key, aad);
    const opened = openEnvelope(sealed.ciphertext, sealed.nonce, key, aad);
    expect(opened.equals(plaintext)).toBe(true);
  });

  test("round trip works for empty plaintext", () => {
    const sender = generateX25519KeyPair();
    const receiver = generateX25519KeyPair();
    const key = deriveSessionKey(sender.privateKey, receiver.publicKey, Buffer.alloc(0), Buffer.from("v1"));
    const aad = Buffer.from("messageId:msg-2|pairId:pair-1");

    const sealed = sealEnvelope(Buffer.alloc(0), key, aad);
    const opened = openEnvelope(sealed.ciphertext, sealed.nonce, key, aad);
    expect(opened).toHaveLength(0);
  });

  test("each seal call uses a fresh random nonce (never caller-supplied)", () => {
    const sender = generateX25519KeyPair();
    const receiver = generateX25519KeyPair();
    const key = deriveSessionKey(sender.privateKey, receiver.publicKey, Buffer.alloc(0), Buffer.from("v1"));
    const aad = Buffer.from("messageId:msg-3|pairId:pair-1");
    const plaintext = Buffer.from("same plaintext every time");

    const first = sealEnvelope(plaintext, key, aad);
    const second = sealEnvelope(plaintext, key, aad);
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  test("wrong AAD is rejected (authentication failure)", () => {
    const sender = generateX25519KeyPair();
    const receiver = generateX25519KeyPair();
    const key = deriveSessionKey(sender.privateKey, receiver.publicKey, Buffer.alloc(0), Buffer.from("v1"));
    const sealed = sealEnvelope(Buffer.from("hello"), key, Buffer.from("messageId:msg-4|pairId:pair-1"));

    expect(() =>
      openEnvelope(sealed.ciphertext, sealed.nonce, key, Buffer.from("messageId:msg-5|pairId:pair-1")),
    ).toThrow();
  });

  test("tampered ciphertext is rejected (authentication failure)", () => {
    const sender = generateX25519KeyPair();
    const receiver = generateX25519KeyPair();
    const key = deriveSessionKey(sender.privateKey, receiver.publicKey, Buffer.alloc(0), Buffer.from("v1"));
    const aad = Buffer.from("messageId:msg-6|pairId:pair-1");
    const sealed = sealEnvelope(Buffer.from("hello"), key, aad);

    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] ^= 0xff;
    expect(() => openEnvelope(tampered, sealed.nonce, key, aad)).toThrow();
  });

  test("wrong key is rejected (authentication failure)", () => {
    const sender = generateX25519KeyPair();
    const receiver = generateX25519KeyPair();
    const wrongReceiver = generateX25519KeyPair();
    const key = deriveSessionKey(sender.privateKey, receiver.publicKey, Buffer.alloc(0), Buffer.from("v1"));
    const wrongKey = deriveSessionKey(sender.privateKey, wrongReceiver.publicKey, Buffer.alloc(0), Buffer.from("v1"));
    const aad = Buffer.from("messageId:msg-7|pairId:pair-1");
    const sealed = sealEnvelope(Buffer.from("hello"), key, aad);

    expect(() => openEnvelope(sealed.ciphertext, sealed.nonce, wrongKey, aad)).toThrow();
  });

  test("raw public key export/import round trip matches the original key material", () => {
    const pair = generateX25519KeyPair();
    const raw = exportRawPublicKey(pair.publicKey);
    expect(raw).toHaveLength(32);
    const reconstructed = publicKeyFromRaw(raw);
    // Re-derive a session key using the reconstructed public key and confirm
    // it matches a session key derived using the original — proves the
    // raw <-> KeyObject round trip preserves the actual key material.
    const other = generateX25519KeyPair();
    const viaOriginal = deriveSessionKey(other.privateKey, pair.publicKey, Buffer.alloc(0), Buffer.from("v1"));
    const viaReconstructed = deriveSessionKey(other.privateKey, reconstructed, Buffer.alloc(0), Buffer.from("v1"));
    expect(viaOriginal.equals(viaReconstructed)).toBe(true);
  });

  test("sealToCombinedBase64/openCombinedBase64 round trip (NotificationEvent's single-field ciphertext encoding)", () => {
    const sender = generateX25519KeyPair();
    const receiver = generateX25519KeyPair();
    const key = deriveSessionKey(sender.privateKey, receiver.publicKey, Buffer.alloc(0), Buffer.from("v1"));
    const aad = Buffer.from("messageId:evt-1|pairId:pair-1");
    const plaintext = Buffer.from(JSON.stringify({ title: "Waiting for input", detail: "idle_prompt" }));

    const combined = sealToCombinedBase64(plaintext, key, aad);
    const recovered = openCombinedBase64(combined, key, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  test("openCombinedBase64 rejects tampered combined ciphertext", () => {
    const sender = generateX25519KeyPair();
    const receiver = generateX25519KeyPair();
    const key = deriveSessionKey(sender.privateKey, receiver.publicKey, Buffer.alloc(0), Buffer.from("v1"));
    const aad = Buffer.from("messageId:evt-2|pairId:pair-1");
    const combined = sealToCombinedBase64(Buffer.from("hello"), key, aad);
    const tampered = Buffer.from(combined, "base64");
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => openCombinedBase64(tampered.toString("base64"), key, aad)).toThrow();
  });
});

describe("exportPrivateKeyPem / importPrivateKeyPem", () => {
  test("round trip preserves the key material (derives the same session key either way)", () => {
    const original = generateX25519KeyPair();
    const pem = exportPrivateKeyPem(original.privateKey);
    expect(pem).toContain("PRIVATE KEY");
    const restored = importPrivateKeyPem(pem);

    const other = generateX25519KeyPair();
    const viaOriginal = deriveSessionKey(original.privateKey, other.publicKey, Buffer.alloc(0), Buffer.from("v1"));
    const viaRestored = deriveSessionKey(restored.privateKey, other.publicKey, Buffer.alloc(0), Buffer.from("v1"));
    expect(viaOriginal.equals(viaRestored)).toBe(true);
    expect(exportRawPublicKey(restored.publicKey).equals(exportRawPublicKey(original.publicKey))).toBe(true);
  });
});

// Plain string check instead of a single `(group){7}` regex: eslint's
// security/detect-unsafe-regex heuristic flags fixed-count repeated groups
// like /^[0-9A-F]{4}(:[0-9A-F]{4}){7}$/ even though a bounded {7} count can't
// backtrack catastrophically. Splitting avoids tripping that false positive.
function isEightHexGroups(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 8 && parts.every((part) => /^[0-9A-F]{4}$/.test(part));
}

describe("pairing transcript (review 2 §P0.4)", () => {
  const keyA = Buffer.alloc(32, 0x11).toString("base64");
  const keyB = Buffer.alloc(32, 0x22).toString("base64");
  const fingerprintFor = (desktopDeviceId: string, desktopPublicKeyBase64: string) =>
    computeDesktopFingerprint({ protocolVersion: 2, desktopDeviceId, desktopPublicKeyBase64 });

  test("the fingerprint is deterministic and formatted as 8 colon-separated 4-hex groups", () => {
    const fingerprint = fingerprintFor("desk-1", keyA);
    expect(isEightHexGroups(fingerprint)).toBe(true);
    expect(fingerprintFor("desk-1", keyA)).toBe(fingerprint);
  });

  test("the fingerprint commits to the public key AND the device id", () => {
    // The whole point of the v2 transcript: the digits a human compares describe a specific key
    // belonging to a specific installation, so a control plane cannot substitute either.
    const baseline = fingerprintFor("desk-1", keyA);
    expect(fingerprintFor("desk-1", keyB)).not.toBe(baseline);
    expect(fingerprintFor("desk-2", keyA)).not.toBe(baseline);
  });

  test("decodeCanonicalPublicKey refuses anything but 32 canonical base64 bytes", () => {
    expect(decodeCanonicalPublicKey(keyA)).toHaveLength(32);
    expect(() => decodeCanonicalPublicKey(Buffer.alloc(31).toString("base64"))).toThrow(/exactly 32 bytes/);
    expect(() => decodeCanonicalPublicKey(Buffer.alloc(33).toString("base64"))).toThrow(/exactly 32 bytes/);
    expect(() => decodeCanonicalPublicKey("")).toThrow(/non-empty/);
    // Node's decoder ignores trailing junk, so two strings would otherwise pin one key — and the
    // transcript hashes the STRING.
    expect(() => decodeCanonicalPublicKey(`${keyA}=junk`)).toThrow(/not canonical/);
  });

  test("the SAS commits to both keys and both device ids", () => {
    const base = {
      protocolVersion: 2,
      pairId: "desk-1",
      pairingId: "inv-1",
      desktopDeviceId: "desk-1",
      desktopPublicKeyBase64: keyA,
      mobileDeviceId: "phone-1",
      mobilePublicKeyBase64: keyB,
    };
    const baseline = computePairingSas(base);
    expect(baseline).toMatch(/^\d{4} \d{4}$/);
    for (const mutation of [
      { desktopPublicKeyBase64: Buffer.alloc(32, 0x33).toString("base64") },
      { mobilePublicKeyBase64: Buffer.alloc(32, 0x44).toString("base64") },
      { desktopDeviceId: "other" },
      { mobileDeviceId: "other" },
      { pairingId: "other" },
      { pairId: "other" },
      { protocolVersion: 3 },
    ]) {
      expect(computePairingSas({ ...base, ...mutation })).not.toBe(baseline);
    }
  });
});

describe("mobile-crypto cross-repo test vectors", () => {
  // Frozen copy of strideterm-mobile/protocol/test-vectors/x25519-hkdf-aead.json
  // (generated there from strideterm-mobile's own envelope-crypto.ts, which
  // mobile-crypto.ts hand-mirrors). Copied inline rather than read from the
  // sibling checkout at test time: strideterm-mobile is a separate private
  // repo that will not be present as a sibling directory in CI or on another
  // contributor's machine, and a path-not-found test should not be able to
  // silently no-op this cross-check. Regenerate this block by hand (see that
  // file's own generate-vectors.mts) only if the crypto implementation there
  // intentionally changes.
  //
  // Both implementations sit directly on the same Node built-in `node:crypto`
  // primitives (X25519 via the same PKCS8/SPKI DER wrapping, HKDF-SHA-256,
  // AES-256-GCM with a 96-bit nonce/16-byte tag) with no algorithm choices of
  // our own, so byte-for-byte cross-checking against their fixed seeds/nonces
  // is meaningful, not coincidental: any accidental drift between the two
  // mirrors (different DER prefix, different HKDF hash, different nonce/tag
  // size) would show up here as a vector mismatch.
  const vectors = [
    {
      description: "basic notification-event style message, empty salt",
      senderSeedHex: "0101010101010101010101010101010101010101010101010101010101010101",
      receiverSeedHex: "0202020202020202020202020202020202020202020202020202020202020202",
      senderPublicKeyRawHex: "a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209",
      receiverPublicKeyRawHex: "ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59",
      saltUtf8: "",
      infoUtf8: "strideterm-mobile-protocol/v1",
      aadUtf8: "messageId:msg-0001|pairId:pair-aaa",
      plaintextUtf8: "hello from desktop",
      expectedSessionKeyHex: "e2b744ad100a23f634446567e5c05d75dd75c9595cae48166a24cd988c735c4b",
      nonceHex: "b0d1728785742e3c8bac0290",
      ciphertextHex: "7b72afd321726778b30c4b17c420445f0fcab2763f4709102effa47a3c80970ac2ed",
    },
    {
      description: "command envelope style message, non-empty salt",
      senderSeedHex: "0303030303030303030303030303030303030303030303030303030303030303",
      receiverSeedHex: "0404040404040404040404040404040404040404040404040404040404040404",
      senderPublicKeyRawHex: "5dfedd3b6bd47f6fa28ee15d969d5bb0ea53774d488bdaf9df1c6e0124b3ef22",
      receiverPublicKeyRawHex: "ac01b2209e86354fb853237b5de0f4fab13c7fcbf433a61c019369617fecf10b",
      saltUtf8: "per-pair-salt-0002",
      infoUtf8: "strideterm-mobile-protocol/v1",
      aadUtf8: "messageId:msg-0002|pairId:pair-bbb",
      plaintextUtf8: '{"type":"task.pause","workspaceId":"ws-1","taskId":"task-1"}',
      expectedSessionKeyHex: "2967a686380249c4b7d63f52c77c21832e3670e1906c26d5a7915f0585b75958",
      nonceHex: "99de61a07eeb7324366d9d77",
      ciphertextHex:
        "5c5faee5d53d496fb7171bbffcd8adce98c2a976ad69c14aaaa4e2979ffd6ab292c30fa2dc095542ed4c7c07b684d7775d6b1fe7762787df4ab48e3a8121165bcdfe27250cc1bde8e58f3e50",
    },
    {
      description: "empty plaintext (e.g. an ack-only payload)",
      senderSeedHex: "0505050505050505050505050505050505050505050505050505050505050505",
      receiverSeedHex: "0606060606060606060606060606060606060606060606060606060606060606",
      senderPublicKeyRawHex: "50a61409b1ddd0325e9b16b700e719e9772c07000b1bd7786e907c653d20495d",
      receiverPublicKeyRawHex: "f5b2d6e60f9477e310c2982daaa6c9136c108a1777c5947e448fa37d68174557",
      saltUtf8: "salt-0003",
      infoUtf8: "strideterm-mobile-protocol/v1",
      aadUtf8: "messageId:msg-0003|pairId:pair-ccc",
      plaintextUtf8: "",
      expectedSessionKeyHex: "ce9be4a354c9a3640184035cfd6e09a109564906d35f11d3c5b95264ac2f4f1e",
      nonceHex: "9308a8cc2d59bb775f139de7",
      ciphertextHex: "f107bea5a439b91b7dda027b13da1f87",
    },
    {
      description: "long info/aad strings and multi-byte UTF-8 plaintext",
      senderSeedHex: "0707070707070707070707070707070707070707070707070707070707070707",
      receiverSeedHex: "0808080808080808080808080808080808080808080808080808080808080808",
      senderPublicKeyRawHex: "13be4feaeaf204c7fd3358fc9c00721881d174278128227ec674f37f7fe97b6d",
      receiverPublicKeyRawHex: "31d4ab6aceec961137917037936e60716fac573afe94d9da84a8020448dfc112",
      saltUtf8: "salt-0004-with-more-entropy-than-the-others",
      infoUtf8: "strideterm-mobile-protocol/v1/notification-event/high-priority",
      aadUtf8: "messageId:msg-0004|pairId:pair-ddd|profileId:profile-x",
      plaintextUtf8: "v remotém terminálu proběhla akce ✅",
      expectedSessionKeyHex: "317c26c441faa1ceac7d0973228dfc7e31bba0e11c9c79039ca3af50a8f00524",
      nonceHex: "b34f479202c9df5a94ff0bc8",
      ciphertextHex:
        "d3253ebc58576839f05481eb554e1a975fe45c334f672246279144f4659ccd2fcf5ae0d3a4e05e274ebf39ea2635b6d85a948d3cb11dcb6b",
    },
  ];

  test("every vector's derived session key, nonce, and ciphertext match byte-for-byte", () => {
    for (const vector of vectors) {
      const sender = x25519KeyPairFromSeed(Buffer.from(vector.senderSeedHex, "hex"));
      const receiver = x25519KeyPairFromSeed(Buffer.from(vector.receiverSeedHex, "hex"));

      expect(exportRawPublicKey(sender.publicKey).toString("hex")).toBe(vector.senderPublicKeyRawHex);
      expect(exportRawPublicKey(receiver.publicKey).toString("hex")).toBe(vector.receiverPublicKeyRawHex);

      const salt = Buffer.from(vector.saltUtf8, "utf8");
      const info = Buffer.from(vector.infoUtf8, "utf8");
      const aad = Buffer.from(vector.aadUtf8, "utf8");
      const plaintext = Buffer.from(vector.plaintextUtf8, "utf8");

      const senderKey = deriveSessionKey(sender.privateKey, receiver.publicKey, salt, info);
      const receiverKey = deriveSessionKey(receiver.privateKey, sender.publicKey, salt, info);
      expect(senderKey.equals(receiverKey)).toBe(true);
      expect(senderKey.toString("hex")).toBe(vector.expectedSessionKeyHex);

      // sealEnvelope generates its own random nonce, so it can't reproduce
      // the vector's exact ciphertext bytes directly. Instead, decrypt the
      // vector's own recorded nonce/ciphertext with openEnvelope and confirm
      // the recovered plaintext matches — proving this module's AEAD
      // decryption is byte-compatible with the sibling repo's encryption.
      const recovered = openEnvelope(
        Buffer.from(vector.ciphertextHex, "hex"),
        Buffer.from(vector.nonceHex, "hex"),
        senderKey,
        aad,
      );
      expect(recovered.equals(plaintext)).toBe(true);
    }
  });
});

describe("canonical envelope AAD (shared fixtures with strideterm-mobile)", () => {
  // mobile-aad-vectors.json is a committed copy of strideterm-mobile's
  // protocol/test-vectors/envelope-aad.json — the same file that repo's TypeScript and Dart
  // suites read. `npm run check:mobile-schema-drift` fails if the copy diverges from the
  // sibling's original, so this test is hermetic (no sibling checkout needed to run it) without
  // being able to drift silently.
  const vectors = JSON.parse(readFileSync(new URL("./mobile-aad-vectors.json", import.meta.url), "utf8")) as {
    cases: {
      name: string;
      fields: {
        protocolVersion: number;
        pairId: string;
        sourceDeviceId: string;
        targetDeviceId: string;
        messageId: string;
        messageType: string;
        sessionKeyVersion: number;
        createdAt: number;
        expiresAt: number;
      };
      aadUtf8: string;
      aadBase64: string;
    }[];
  };
  const BASE_FIELDS = {
    protocolVersion: 2,
    pairId: "p",
    sourceDeviceId: "s",
    targetDeviceId: "t",
    messageId: "m",
    messageType: "command",
    sessionKeyVersion: 1,
    createdAt: 1,
    expiresAt: 2,
  };

  test("the fixture file is not empty", () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  for (const vector of vectors.cases) {
    test(`matches the shared vector: ${vector.name}`, () => {
      const aad = buildRoutingAad(vector.fields);
      expect(aad.toString("utf8")).toBe(vector.aadUtf8);
      expect(aad.toString("base64")).toBe(vector.aadBase64);
    });
  }

  test("every one of the nine routing fields is bound", () => {
    const baseline = buildRoutingAad(BASE_FIELDS).toString("base64");
    const variations: Record<string, string | number> = {
      protocolVersion: 3,
      pairId: "other",
      sourceDeviceId: "other",
      targetDeviceId: "other",
      messageId: "other",
      messageType: "commandResult",
      sessionKeyVersion: 2,
      createdAt: 99,
      expiresAt: 99,
    };
    for (const [key, value] of Object.entries(variations)) {
      expect(buildRoutingAad({ ...BASE_FIELDS, [key]: value }).toString("base64")).not.toBe(baseline);
    }
  });

  test("routingAadMatches accepts only the exact AAD for the given fields", () => {
    expect(routingAadMatches(buildRoutingAad(BASE_FIELDS).toString("base64"), BASE_FIELDS)).toBe(true);
    expect(
      routingAadMatches(buildRoutingAad({ ...BASE_FIELDS, sourceDeviceId: "x" }).toString("base64"), BASE_FIELDS),
    ).toBe(false);
    // Length is compared before contents, so neither a truncated nor a padded AAD can match.
    expect(routingAadMatches(Buffer.from("{}", "utf8").toString("base64"), BASE_FIELDS)).toBe(false);
  });

  test("a message relabelled as a different type does not authenticate", () => {
    const key = Buffer.alloc(32, 7);
    const sealed = sealEnvelope(Buffer.from("payload"), key, buildRoutingAad(BASE_FIELDS));
    expect(() =>
      openEnvelope(
        sealed.ciphertext,
        sealed.nonce,
        key,
        buildRoutingAad({ ...BASE_FIELDS, messageType: "commandResult" }),
      ),
    ).toThrow();
  });

  test("a record re-addressed to another device does not authenticate", () => {
    // The recipient-isolation property, at the crypto layer: moving a sealed event from one phone's
    // mailbox to another's fails the AEAD rather than merely being in the wrong place (review 2
    // §P0.1). Under v1 there was no target field in the AAD at all, so the two were identical.
    const key = Buffer.alloc(32, 9);
    const sealed = sealEnvelope(Buffer.from("payload"), key, buildRoutingAad(BASE_FIELDS));
    expect(() =>
      openEnvelope(
        sealed.ciphertext,
        sealed.nonce,
        key,
        buildRoutingAad({ ...BASE_FIELDS, targetDeviceId: "other-phone" }),
      ),
    ).toThrow();
  });
});

describe("pairing transcript (shared fixtures with strideterm-mobile)", () => {
  // mobile-pairing-vectors.json is a committed copy of strideterm-mobile's
  // protocol/test-vectors/pairing-transcript.json — the same file that repo's TypeScript and Dart
  // suites read. `npm run check:mobile-schema-drift` fails if the copy diverges.
  //
  // These values are what a human compares across two screens. If the desktop and the phone
  // derived them from even slightly different transcript bytes, the codes would never match and
  // the user would be told, in effect, that their own pairing looks like an attack.
  const vectors = JSON.parse(readFileSync(new URL("./mobile-pairing-vectors.json", import.meta.url), "utf8")) as {
    cases: {
      name: string;
      fields: {
        protocolVersion: number;
        pairId: string;
        pairingId: string;
        desktopDeviceId: string;
        desktopPublicKeyBase64: string;
        mobileDeviceId: string;
        mobilePublicKeyBase64: string;
      };
      fingerprint: string;
      sas: string;
      sessionKeyBase64: string;
      keyProofChallengeBase64Url: string;
      keyProof: string;
      approvedCapabilities: string[];
      approvedProfileAllowlist: string[];
      grantCommitment: string;
      approvalTranscriptHash: string;
    }[];
  };

  test("the fixture file is not empty", () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  for (const vector of vectors.cases) {
    test(`matches the shared vector: ${vector.name}`, () => {
      expect(computeDesktopFingerprint(vector.fields)).toBe(vector.fingerprint);
      expect(computePairingSas(vector.fields)).toBe(vector.sas);
      // Review 3 §P0.1's three commitments, from the same fixture. The key proof matters most here:
      // the PHONE produces it and this desktop recomputes it, so a divergence between the two
      // implementations would present as a pairing that silently never completes.
      expect(
        computeKeyProof(Buffer.from(vector.sessionKeyBase64, "base64"), {
          ...vector.fields,
          challengeBase64Url: vector.keyProofChallengeBase64Url,
        }),
      ).toBe(vector.keyProof);
      expect(
        computeGrantCommitment({
          protocolVersion: vector.fields.protocolVersion,
          pairId: vector.fields.pairId,
          pairingId: vector.fields.pairingId,
          mobileDeviceId: vector.fields.mobileDeviceId,
          capabilities: vector.approvedCapabilities,
          profileAllowlist: vector.approvedProfileAllowlist,
        }),
      ).toBe(vector.grantCommitment);
      expect(computePairingApprovalTranscriptHash({ ...vector.fields, grantCommitment: vector.grantCommitment })).toBe(
        vector.approvalTranscriptHash,
      );
    });
  }

  test("the key proof needs the session key, which is why the cloud cannot forge one", () => {
    const vector = vectors.cases[0]!;
    const fields = { ...vector.fields, challengeBase64Url: vector.keyProofChallengeBase64Url };
    expect(computeKeyProof(Buffer.alloc(32, 0x99), fields)).not.toBe(vector.keyProof);
    // And a substituted mobile public key invalidates it, which is what stops an injected device
    // record being adopted: the injector chooses the key, so the proof it would need cannot exist.
    expect(
      computeKeyProof(Buffer.from(vector.sessionKeyBase64, "base64"), {
        ...fields,
        mobilePublicKeyBase64: Buffer.alloc(32, 0x77).toString("base64"),
      }),
    ).not.toBe(vector.keyProof);
  });

  test("keyProofsEqual is length-safe", () => {
    const proof = vectors.cases[0]!.keyProof;
    expect(keyProofsEqual(proof, proof)).toBe(true);
    expect(keyProofsEqual(proof, `${proof}x`)).toBe(false);
    expect(keyProofsEqual(proof, "")).toBe(false);
  });

  test("the grant commitment is order-insensitive and content-sensitive", () => {
    const base = {
      protocolVersion: 2,
      pairId: "desk-1",
      pairingId: "inv-1",
      mobileDeviceId: "phone-1",
      capabilities: ["notifications", "task.control"],
      profileAllowlist: ["a", "b"],
    };
    expect(computeGrantCommitment({ ...base, capabilities: ["task.control", "notifications"] })).toBe(
      computeGrantCommitment(base),
    );
    expect(computeGrantCommitment({ ...base, capabilities: ["notifications"] })).not.toBe(computeGrantCommitment(base));
  });

  test("decodeCanonicalKeyProofChallenge demands exactly 32 canonical base64url bytes", () => {
    const good = Buffer.alloc(32, 0x55).toString("base64url");
    expect(decodeCanonicalKeyProofChallenge(good).length).toBe(32);
    expect(() => decodeCanonicalKeyProofChallenge("")).toThrow();
    expect(() => decodeCanonicalKeyProofChallenge(Buffer.alloc(31).toString("base64url"))).toThrow();
    expect(() => decodeCanonicalKeyProofChallenge(`${good}=`)).toThrow();
  });

  test("no two fixture cases share a fingerprint or a SAS", () => {
    // Cases 2 and 3 differ from case 1 only by the desktop key and only by the desktop device id;
    // if either failed to move both values, key substitution would be invisible.
    expect(new Set(vectors.cases.map((c) => c.fingerprint)).size).toBe(vectors.cases.length);
    expect(new Set(vectors.cases.map((c) => c.sas)).size).toBe(vectors.cases.length);
  });
});

describe("relay end-to-end encryption (shared fixtures with strideterm-mobile)", () => {
  // mobile-relay-e2e-vectors.json is a committed copy of strideterm-mobile's
  // protocol/test-vectors/relay-e2e.json (generated there from that repo's
  // relay-e2e-crypto.ts, which this file's relay-e2e section hand-mirrors). `npm run
  // check:mobile-schema-drift` fails if the copy diverges.
  const vectors = JSON.parse(readFileSync(new URL("./mobile-relay-e2e-vectors.json", import.meta.url), "utf8")) as {
    vectors: Array<{
      description: string;
      keyId: string;
      pairId: string;
      deviceId: string;
      ticketId: string;
      desktopEphemeralSeedHex: string;
      phoneEphemeralSeedHex: string;
      desktopPairingSeedHex: string;
      phonePairingSeedHex: string;
      desktopEphemeralPubBase64: string;
      phoneEphemeralPubBase64: string;
      saltHex: string;
      infoUtf8: string;
      expectedDesktopToPhoneKeyHex: string;
      expectedPhoneToDesktopKeyHex: string;
      outerHeader: Record<string, unknown>;
      counter: number;
      plaintextUtf8: string;
      payloadHex: string;
      mustFailToDecrypt?: boolean;
    }>;
  };

  test("the fixture file has at least 3 valid cases plus 1 deliberately corrupted", () => {
    expect(vectors.vectors.filter((v) => !v.mustFailToDecrypt).length).toBeGreaterThanOrEqual(3);
    expect(vectors.vectors.some((v) => v.mustFailToDecrypt === true)).toBe(true);
  });

  for (const v of vectors.vectors) {
    test(`matches the shared vector: ${v.description}`, () => {
      const desktopEphemeral = x25519KeyPairFromSeed(Buffer.from(v.desktopEphemeralSeedHex, "hex"));
      const phoneEphemeral = x25519KeyPairFromSeed(Buffer.from(v.phoneEphemeralSeedHex, "hex"));
      const desktopPairing = x25519KeyPairFromSeed(Buffer.from(v.desktopPairingSeedHex, "hex"));
      const phonePairing = x25519KeyPairFromSeed(Buffer.from(v.phonePairingSeedHex, "hex"));

      expect(exportRawPublicKey(desktopEphemeral.publicKey).toString("base64")).toBe(v.desktopEphemeralPubBase64);
      expect(exportRawPublicKey(phoneEphemeral.publicKey).toString("base64")).toBe(v.phoneEphemeralPubBase64);

      const desktopOffer: RelayE2eDesktopOffer = {
        v: 1,
        keyId: v.keyId,
        desktopEphemeralPub: v.desktopEphemeralPubBase64,
      };
      const phoneAcceptance: RelayE2ePhoneAcceptance = {
        v: 1,
        keyId: v.keyId,
        phoneEphemeralPub: v.phoneEphemeralPubBase64,
      };

      const salt = relayE2eSalt(desktopOffer, phoneAcceptance);
      expect(salt.toString("hex")).toBe(v.saltHex);
      const info = relayE2eInfo(v.pairId, v.deviceId, v.ticketId);
      expect(info.toString("utf8")).toBe(v.infoUtf8);

      // Derived from the DESKTOP's own key material and the phone's raw public keys, exactly as
      // the real connector would from a wire e2e block.
      const keys = deriveRelayE2eKeys(
        desktopEphemeral.privateKey,
        publicKeyFromRaw(Buffer.from(v.phoneEphemeralPubBase64, "base64")),
        desktopPairing.privateKey,
        phonePairing.publicKey,
        salt,
        info,
      );
      expect(keys.desktopToPhone.toString("hex")).toBe(v.expectedDesktopToPhoneKeyHex);
      expect(keys.phoneToDesktop.toString("hex")).toBe(v.expectedPhoneToDesktopKeyHex);

      const aad = Buffer.from(JSON.stringify(v.outerHeader), "utf8");
      const payload = Buffer.from(v.payloadHex, "hex");

      if (v.mustFailToDecrypt) {
        expect(() => openRelayE2eFrame(payload, keys.phoneToDesktop, aad)).toThrow();
        return;
      }

      const opened = openRelayE2eFrame(payload, keys.phoneToDesktop, aad);
      expect(opened.toString("utf8")).toBe(v.plaintextUtf8);
      expect(relayE2eCounterOf(payload.subarray(0, RELAY_E2E_NONCE_BYTES))).toBe(BigInt(v.counter));

      const resealed = sealRelayE2eFrame(
        Buffer.from(v.plaintextUtf8, "utf8"),
        keys.phoneToDesktop,
        BigInt(v.counter),
        aad,
      );
      expect(resealed.toString("hex")).toBe(v.payloadHex);
    });
  }

  test("a payload authenticated under one AAD is refused under another", () => {
    const key = Buffer.alloc(32, 0x42);
    const aad = Buffer.from(
      JSON.stringify({ v: 2, t: "e2e.data", src: "viewer", dst: "connector", s: "s1", id: "i1", q: 0 }),
    );
    const otherAad = Buffer.from(
      JSON.stringify({ v: 2, t: "e2e.data", src: "viewer", dst: "connector", s: "s1", id: "i2", q: 0 }),
    );
    const sealed = sealRelayE2eFrame(Buffer.from("hello"), key, 0n, aad);
    expect(() => openRelayE2eFrame(sealed, key, otherAad)).toThrow();
    expect(() => openRelayE2eFrame(sealed, key, aad)).not.toThrow();
  });

  test("the nonce is 4 reserved zero bytes followed by the big-endian counter", () => {
    const nonce = relayE2eNonce(300n);
    expect(nonce.length).toBe(RELAY_E2E_NONCE_BYTES);
    expect([...nonce.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(relayE2eCounterOf(nonce)).toBe(300n);
  });

  test("a negative counter is refused, and the counter never silently wraps past 64 bits", () => {
    expect(() => relayE2eNonce(-1n)).toThrow();
    expect(() => relayE2eNonce(0xffffffffffffffffn)).not.toThrow();
    expect(() => relayE2eNonce(0x10000000000000000n)).toThrow();
  });
});

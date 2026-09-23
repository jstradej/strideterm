import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createPrivateKey, sign, verify } from "node:crypto";

import {
  decodeCanonicalBase64Url,
  decodeRelayFrame,
  ed25519PublicKeyFromRaw,
  encodeRelayFrame,
  RELAY_FRAME_RULES,
  RELAY_FRAME_TYPES,
  RELAY_PROTOCOL_VERSION,
  RelayFrameError,
  relayConnectorChallengeTranscript,
  relayFrameCarriesPayload,
  relayKeyFingerprint,
  validateHeaderList,
  validateRequestTarget,
  type RelayFrameHeader,
} from "./mobile-relay-protocol.js";

/**
 * The shared cross-runtime fixture, read from this repo's own copy so the suite stays hermetic.
 * `npm run check:mobile-schema-drift` is what keeps the copy identical to
 * `strideterm-mobile/protocol/test-vectors/relay-grants.json`.
 */
const VECTORS = JSON.parse(readFileSync(path.join(import.meta.dirname, "mobile-relay-vectors.json"), "utf8")) as {
  signingKey: { kid: string; seedBase64: string; pkcs8Prefix: string; publicKeyBase64Url: string };
  audience: string;
  positive: { role: string; claims: Record<string, unknown>; canonicalPayloadJson: string; token: string }[];
  connectorChallenge: {
    audience: string;
    desktopInstallationId: string;
    connectorKeyFingerprint: string;
    nonce: string;
    transcriptUtf8: string;
    identityPublicKeyBase64Url: string;
    signature: string;
  };
};

const SESSION = "relay-session-0000000000000001";
const STREAM = "stream-0000000000000001";

function rejectionCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof RelayFrameError) return error.code;
    return `unexpected:${(error as Error).message}`;
  }
  return "accepted";
}

function requestStart(overrides: Partial<RelayFrameHeader> = {}): RelayFrameHeader {
  return {
    v: RELAY_PROTOCOL_VERSION,
    t: "http.request.start",
    src: "viewer",
    dst: "connector",
    s: SESSION,
    id: STREAM,
    m: "GET",
    u: "/api/state",
    h: [["accept", "application/json"]],
    ...overrides,
  };
}

describe("the relay frame codec mirror", () => {
  test("round-trips a header and its payload exactly", () => {
    const payload = Buffer.from([1, 2, 3, 250, 251, 252]);
    const decoded = decodeRelayFrame(
      encodeRelayFrame(
        {
          v: RELAY_PROTOCOL_VERSION,
          t: "ws.data",
          src: "connector",
          dst: "viewer",
          s: SESSION,
          id: STREAM,
          q: 7,
          b: true,
        },
        payload,
      ),
    );
    expect(decoded.header.q).toBe(7);
    expect(decoded.header.b).toBe(true);
    expect([...decoded.payload]).toEqual([...payload]);
  });

  test("the decoded payload is a copy, because `ws` reuses its read buffer", () => {
    const encoded = encodeRelayFrame(
      {
        v: RELAY_PROTOCOL_VERSION,
        t: "ws.data",
        src: "connector",
        dst: "viewer",
        s: SESSION,
        id: STREAM,
        q: 0,
        b: false,
      },
      Buffer.from([9, 9, 9]),
    );
    const decoded = decodeRelayFrame(encoded);
    encoded.fill(0);
    expect([...decoded.payload]).toEqual([9, 9, 9]);
  });

  test("payloads are allowed on exactly the ordered frame types", () => {
    expect(RELAY_FRAME_TYPES).toHaveLength(27);
    for (const type of RELAY_FRAME_TYPES) {
      expect(relayFrameCarriesPayload(type)).toBe(RELAY_FRAME_RULES[type].required.includes("q"));
    }
  });

  test("an unknown field, a missing field, an unknown type and another version are all refused", () => {
    expect(rejectionCode(() => encodeRelayFrame({ ...requestStart(), z: 1 } as RelayFrameHeader))).toBe(
      "unknown-field",
    );
    const { m: _method, ...withoutMethod } = requestStart();
    expect(rejectionCode(() => encodeRelayFrame(withoutMethod as RelayFrameHeader))).toBe("missing-field");
    expect(
      rejectionCode(() => encodeRelayFrame({ ...requestStart(), t: "http.magic" } as unknown as RelayFrameHeader)),
    ).toBe("unknown-type");
    // v1 is the version the revocation-sync phase replaced (protocol v2); a frame from it is refused
    // rather than coerced, which is what "an older protocol version is deterministically refused"
    // means at the codec level.
    expect(rejectionCode(() => encodeRelayFrame(requestStart({ v: 1 })))).toBe("unsupported-version");
    expect(rejectionCode(() => encodeRelayFrame(requestStart({ v: 3 })))).toBe("unsupported-version");
  });

  test("roles are checked per frame type, and a frame never addresses itself", () => {
    expect(rejectionCode(() => encodeRelayFrame(requestStart({ src: "relay" })))).toBe("src-role-not-allowed");
    expect(rejectionCode(() => encodeRelayFrame(requestStart({ dst: "relay" })))).toBe("dst-role-not-allowed");
    expect(
      rejectionCode(() =>
        encodeRelayFrame({ v: RELAY_PROTOCOL_VERSION, t: "conn.heartbeat", src: "relay", dst: "relay", s: SESSION }),
      ),
    ).toBe("src-equals-dst");
  });

  test("a request target must be origin-form, so a relay message cannot pick the connector's target", () => {
    validateRequestTarget("/");
    validateRequestTarget("/api/state?x=1");
    validateRequestTarget("/assets/index-abc123.js");

    expect(rejectionCode(() => validateRequestTarget("http://127.0.0.1:9/secret"))).toBe("target-not-origin-form");
    expect(rejectionCode(() => validateRequestTarget("https://example.invalid/"))).toBe("target-not-origin-form");
    expect(rejectionCode(() => validateRequestTarget("//example.invalid/path"))).toBe("target-not-origin-form");
    expect(rejectionCode(() => validateRequestTarget("/a\\..\\b"))).toBe("target-has-backslash");
    expect(rejectionCode(() => validateRequestTarget("/api/../../etc/passwd"))).toBe("target-has-dot-dot");
    expect(rejectionCode(() => validateRequestTarget("/api\r\nX-Injected: 1"))).toBe("target-has-control-characters");
    expect(rejectionCode(() => validateRequestTarget(`/${"a".repeat(4096)}`))).toBe("target-too-long");
  });

  test("header lists refuse smuggling, uppercase names and unbounded size", () => {
    validateHeaderList([
      ["accept", "text/html"],
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
    expect(rejectionCode(() => validateHeaderList([["Accept", "x"]]))).toBe("header-name-not-lowercase");
    expect(rejectionCode(() => validateHeaderList([["accept", "a\r\nx-injected: 1"]]))).toBe(
      "header-value-has-control-characters",
    );
    expect(rejectionCode(() => validateHeaderList(Array.from({ length: 65 }, () => ["x", "y"])))).toBe(
      "too-many-headers",
    );
  });

  test("the method set is closed", () => {
    expect(rejectionCode(() => encodeRelayFrame(requestStart({ m: "TRACE" as never })))).toBe("unknown-method");
    expect(rejectionCode(() => encodeRelayFrame(requestStart({ m: "get" as never })))).toBe("unknown-method");
  });

  test("conn.revoke names one device, in the one direction that can know", () => {
    const revoke = (overrides: Partial<RelayFrameHeader> = {}): RelayFrameHeader => ({
      v: RELAY_PROTOCOL_VERSION,
      t: "conn.revoke",
      src: "connector",
      dst: "relay",
      s: SESSION,
      d: "mobile-AAAAAAAAAAAAAAAAAAAAAA",
      ...overrides,
    });
    expect(decodeRelayFrame(encodeRelayFrame(revoke())).header.d).toBe("mobile-AAAAAAAAAAAAAAAAAAAAAA");
    expect(rejectionCode(() => encodeRelayFrame(revoke({ d: "mobile/../other" })))).toBe("device-id-not-canonical");
    expect(rejectionCode(() => encodeRelayFrame(revoke({ src: "relay", dst: "connector" })))).toBe(
      "src-role-not-allowed",
    );
  });
});

describe("the relay grant helpers mirror", () => {
  test("the challenge transcript is byte-identical to the shared fixture", () => {
    const { connectorChallenge } = VECTORS;
    const transcript = relayConnectorChallengeTranscript({
      audience: connectorChallenge.audience,
      desktopInstallationId: connectorChallenge.desktopInstallationId,
      connectorKeyFingerprint: connectorChallenge.connectorKeyFingerprint,
      nonce: connectorChallenge.nonce,
    });
    expect(transcript.toString("utf8")).toBe(connectorChallenge.transcriptUtf8);
  });

  test("the fixture's own signature verifies against the fixture's key, through this mirror", () => {
    const { connectorChallenge } = VECTORS;
    const raw = decodeCanonicalBase64Url(connectorChallenge.identityPublicKeyBase64Url, "publicKey");
    expect(relayKeyFingerprint(raw)).toBe(connectorChallenge.connectorKeyFingerprint);

    const publicKey = ed25519PublicKeyFromRaw(raw);
    const transcript = relayConnectorChallengeTranscript(connectorChallenge);
    expect(verify(null, transcript, publicKey, Buffer.from(connectorChallenge.signature, "base64url"))).toBe(true);
  });

  test("a signature does not carry across installations, relays or nonces", () => {
    const { connectorChallenge } = VECTORS;
    const raw = decodeCanonicalBase64Url(connectorChallenge.identityPublicKeyBase64Url, "publicKey");
    const publicKey = ed25519PublicKeyFromRaw(raw);
    const signature = Buffer.from(connectorChallenge.signature, "base64url");
    const variants = [
      { ...connectorChallenge, desktopInstallationId: "installation-BBBBBBBBBBBBBBBBBBBB" },
      { ...connectorChallenge, audience: "https://relay.other.invalid" },
      { ...connectorChallenge, nonce: Buffer.alloc(32, 0x44).toString("base64url") },
    ];
    for (const variant of variants) {
      expect(verify(null, relayConnectorChallengeTranscript(variant), publicKey, signature)).toBe(false);
    }
  });

  test("this repo can sign the fixture's own connector grant, byte for byte", () => {
    // Not a re-implementation of the grant format — the desktop never mints one — but proof that
    // the two repositories agree on the bytes, which is what the connector's proof depends on.
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from(VECTORS.signingKey.pkcs8Prefix, "hex"),
        Buffer.from(VECTORS.signingKey.seedBase64, "base64"),
      ]),
      format: "der",
      type: "pkcs8",
    });
    for (const vector of VECTORS.positive) {
      const [headerPart, payloadPart, signaturePart] = vector.token.split(".") as [string, string, string];
      expect(Buffer.from(payloadPart, "base64url").toString("utf8")).toBe(vector.canonicalPayloadJson);
      const produced = sign(null, Buffer.from(`${headerPart}.${payloadPart}`, "utf8"), privateKey);
      expect(produced.toString("base64url")).toBe(signaturePart);
    }
  });

  test("base64url is decoded canonically, so one value has one spelling", () => {
    expect([...decodeCanonicalBase64Url("AQ", "x")]).toEqual([0x01]);
    expect(rejectionCode(() => decodeCanonicalBase64Url("AA==", "x"))).toBe("x-illegal-characters");
    expect(rejectionCode(() => decodeCanonicalBase64Url("a+b/", "x"))).toBe("x-illegal-characters");
    expect(rejectionCode(() => decodeCanonicalBase64Url("AB", "x"))).toBe("x-not-canonical");
    expect(rejectionCode(() => decodeCanonicalBase64Url("", "x"))).toBe("x-empty");
  });

  test("a fingerprint is only defined for a raw 32-byte key", () => {
    expect(rejectionCode(() => relayKeyFingerprint(Buffer.alloc(31)))).toBe("public-key-wrong-length");
    expect(rejectionCode(() => ed25519PublicKeyFromRaw(Buffer.alloc(33)))).toBe("public-key-wrong-length");
  });
});

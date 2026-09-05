// This desktop's copy of the bootstrap rules, against the CANONICAL cross-runtime vectors.
//
// The copy exists because this checkout cannot import the mobile monorepo's protocol package (plan
// §3.2); what stops it drifting is this fixture, which `npm run check:mobile-schema-drift` proves is
// the same file as the canonical one and which these tests then execute case by case.
//
// It matters more here than for the other three mirrored fixtures. `strideterm-ops recovery
// bootstrap-verify` exists so an operator can learn, BEFORE publishing, whether the released clients
// will accept an envelope. If this desktop's rules drifted, that tool would confirm an envelope this
// desktop then refused — and it would be discovered during a recovery, which is the one moment there
// is no time to discover it.
import { createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { describe, expect, test } from "vitest";

import vectors from "./mobile-bootstrap-vectors.json" with { type: "json" };
import {
  BOOTSTRAP_SCHEMA_VERSION,
  BOOTSTRAP_SIGNING_DOMAIN,
  bootstrapEndpointHost,
  bootstrapSigningInput,
  chooseBootstrap,
  isSecureBootstrapEndpoint,
  verifyControlPlaneBootstrap,
  type BootstrapEnvironment,
  type ControlPlaneBootstrapEnvelope,
  type ControlPlaneBootstrapPayload,
} from "./control-plane-bootstrap.js";

interface VectorCase {
  name: string;
  why: string;
  envelope: ControlPlaneBootstrapEnvelope;
  context: { expectedEnvironment: BootstrapEnvironment; highestSeenEpoch: number; now: number };
  expected: string;
}

const cases = vectors.cases as unknown as VectorCase[];
const trustKeys = new Map(
  (vectors.trustKeys as { keyId: string; publicKeyBase64: string }[]).map(
    (entry) => [entry.keyId, new Uint8Array(Buffer.from(entry.publicKeyBase64, "base64"))] as const,
  ),
);

function nodeVerifier(args: { message: Uint8Array; signature: Uint8Array; publicKey: Uint8Array }): boolean {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(args.publicKey)]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return verifyEd25519(null, Buffer.from(args.message), key, Buffer.from(args.signature));
}

describe("the mirrored bootstrap rules", () => {
  test("the fixture is the one this build understands", () => {
    expect(vectors.schemaVersion).toBe(BOOTSTRAP_SCHEMA_VERSION);
    expect(vectors.signingDomain).toBe(BOOTSTRAP_SIGNING_DOMAIN);
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  test("the bytes this desktop signs are the bytes the canonical implementation signs", () => {
    // Checked before the verdicts: a canonicalisation difference would otherwise look like a
    // mysterious signature failure rather than the input mismatch it is.
    const example = vectors.signingInputExample as { name: string; utf8: string };
    const named = cases.find((entry) => entry.name === example.name)!;
    expect(Buffer.from(bootstrapSigningInput(named.envelope.payload)).toString("utf8")).toBe(example.utf8);
  });

  test("every canonical case reaches the same verdict here, for the same reason", () => {
    const seen = new Set<string>();
    for (const entry of cases) {
      const verdict = verifyControlPlaneBootstrap({
        envelope: entry.envelope,
        trustKeys,
        expectedEnvironment: entry.context.expectedEnvironment,
        highestSeenEpoch: entry.context.highestSeenEpoch,
        now: entry.context.now,
        verifySignature: nodeVerifier,
      });
      const actual = verdict.accepted ? "accepted" : verdict.refusal;
      expect(actual, `${entry.name}: ${entry.why}`).toBe(entry.expected);
      seen.add(entry.expected);
    }
    for (const refusal of [
      "accepted",
      "unknown-key",
      "bad-signature",
      "wrong-environment",
      "epoch-not-newer",
      "not-yet-valid",
      "insecure-endpoint",
      "unsupported-version",
      "malformed",
    ]) {
      expect(seen, `no vector produces ${refusal}`).toContain(refusal);
    }
  });

  test("an unknown key never reaches the signature primitive", () => {
    let calls = 0;
    const verdict = verifyControlPlaneBootstrap({
      envelope: cases.find((entry) => entry.name === "accepted-primary-key")!.envelope,
      trustKeys: new Map(),
      expectedEnvironment: "prod",
      highestSeenEpoch: 0,
      now: Date.UTC(2026, 5, 1),
      verifySignature: () => {
        calls += 1;
        return true;
      },
    });
    expect(verdict.refusal).toBe("unknown-key");
    expect(calls).toBe(0);
  });

  test("nothing after the signature check is decided from an unsigned value", () => {
    for (const entry of cases) {
      const verdict = verifyControlPlaneBootstrap({
        envelope: entry.envelope,
        trustKeys,
        expectedEnvironment: entry.context.expectedEnvironment,
        highestSeenEpoch: entry.context.highestSeenEpoch,
        now: entry.context.now,
        verifySignature: () => false,
      });
      expect(verdict.accepted, entry.name).toBe(false);
      expect(["bad-signature", "malformed", "unsupported-version", "unknown-key"]).toContain(verdict.refusal);
    }
  });

  test("a production build refuses a local endpoint however it is spelled", () => {
    for (const value of [
      "https://127.0.0.1:9000",
      "https://localhost",
      "https://[::1]:9000",
      "https://[::ffff:127.0.0.1]:5001",
      "https://[fe80::1]",
      "https://10.0.0.5",
      "https://172.16.0.1",
      "https://192.168.1.1",
      "https://169.254.169.254",
      "http://rtdb.example.com",
      "",
    ]) {
      expect(isSecureBootstrapEndpoint(value), value).toBe(false);
    }
    for (const value of [
      "https://strideterm-prod-default-rtdb.europe-west1.firebasedatabase.app",
      "https://relay.strideterm.com",
      // Adjacent to a private range but not in one: a prefix rule gets these wrong.
      "https://172.32.0.1",
      "https://11.0.0.1",
    ]) {
      expect(isSecureBootstrapEndpoint(value), value).toBe(true);
    }
    expect(bootstrapEndpointHost("https://[::1]:9000")).toBe("::1");
    expect(bootstrapEndpointHost("https://EXAMPLE.com:443/x")).toBe("example.com");
  });

  test("last-known-good is replaced only by a strictly higher epoch", () => {
    const at = (configEpoch: number) => ({ payload: { configEpoch } as ControlPlaneBootstrapPayload });
    expect(chooseBootstrap(at(4), at(4))!.payload.configEpoch).toBe(4);
    expect(chooseBootstrap(at(4), at(3))!.payload.configEpoch).toBe(4);
    expect(chooseBootstrap(at(3), at(4))!.payload.configEpoch).toBe(4);
  });
});

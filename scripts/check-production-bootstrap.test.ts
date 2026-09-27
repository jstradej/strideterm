import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import { checkProductionBootstrap } from "./check-production-bootstrap.mts";
import { bootstrapSigningInput, BOOTSTRAP_SCHEMA_VERSION } from "../electron/backend/mobile/control-plane-bootstrap.js";

const primary = generateKeyPairSync("ed25519");
const standby = generateKeyPairSync("ed25519");
const keyId = "test-primary";
const trust = {
  url: "https://bootstrap.example.test/prod.json",
  keys: new Map([
    [keyId, new Uint8Array(primary.publicKey.export({ format: "der", type: "spki" }).subarray(-32))],
    ["test-standby", new Uint8Array(standby.publicKey.export({ format: "der", type: "spki" }).subarray(-32))],
  ]),
};

function envelope(projectId = "strideterm-mobile-prod") {
  const payload = {
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    environment: "prod" as const,
    configEpoch: 1,
    issuedAt: Date.now() - 1_000,
    projectId,
    apiKey: "synthetic-public-client-identifier",
    appId: "1:1:android:test",
    messagingSenderId: "1",
    databaseUrl: `https://${projectId}-default-rtdb.europe-west1.firebasedatabase.app`,
    functionsBaseUrl: `https://europe-west1-${projectId}.cloudfunctions.net`,
    relayOrigin: "https://relay.strideterm.com",
  };
  return {
    v: 1,
    keyId,
    payload,
    signature: sign(null, Buffer.from(bootstrapSigningInput(payload)), primary.privateKey).toString("base64"),
  };
}

describe("production bootstrap release gate", () => {
  test("accepts a signed production envelope for a clean desktop", async () => {
    const result = await checkProductionBootstrap(trust, async () => Response.json(envelope()));
    expect(result).toEqual({ epoch: 1, projectId: "strideterm-mobile-prod" });
  });

  test("refuses an absent trust anchor before any network request", async () => {
    const fetchImpl = vi.fn();
    await expect(checkProductionBootstrap({ keys: new Map() }, fetchImpl)).rejects.toThrow(/URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("refuses a second key ID that repeats the first public key", async () => {
    const duplicate = {
      ...trust,
      keys: new Map([
        [keyId, trust.keys.get(keyId)!],
        ["second", trust.keys.get(keyId)!],
      ]),
    };
    await expect(checkProductionBootstrap(duplicate, async () => Response.json(envelope()))).rejects.toThrow(
      /distinct/,
    );
  });

  test("refuses a validly signed envelope for a different production project", async () => {
    await expect(
      checkProductionBootstrap(trust, async () => Response.json(envelope("another-project"))),
    ).rejects.toThrow(/wrong Firebase project/);
  });
});

/**
 * Release gate for a fresh production desktop install. The desktop must be able to
 * fetch and verify its Firebase client configuration before it can create a QR.
 * No Firebase API key or signing private key is read from this repository.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createControlPlaneBootstrapClient,
  resolveBootstrapFirebaseConfig,
} from "../electron/backend/mobile/bootstrap-client.js";
import { bootstrapTrustSet, type BootstrapTrust } from "../electron/backend/mobile/bootstrap-trust.js";
import { isSecureBootstrapEndpoint } from "../electron/backend/mobile/control-plane-bootstrap.js";
import { databaseInstanceUrl, FUNCTIONS_REGION } from "../electron/backend/mobile/mobile-rtdb-paths.js";
import { resolveMobileFirebaseConfig } from "../electron/backend/mobile/mobile-firebase-config.js";

const EXPECTED_PROJECT = "strideterm-mobile-prod";
const EXPECTED_RELAY = "https://relay.strideterm.com";

export async function checkProductionBootstrap(
  trust: BootstrapTrust,
  fetchImpl?: (_input: string, _init?: RequestInit) => Promise<Response>,
): Promise<{ epoch: number; projectId: string }> {
  if (!trust.url || !isSecureBootstrapEndpoint(trust.url)) {
    throw new Error("Production bootstrap URL is missing or is not a public HTTPS endpoint");
  }
  const endpoint = new URL(trust.url);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Production bootstrap URL must have no credentials, query or fragment");
  }
  const keys = [...trust.keys.values()];
  if (
    keys.length < 2 ||
    keys.some((key) => key.length !== 32) ||
    new Set(keys.map((key) => Buffer.from(key).toString("hex"))).size !== keys.length
  ) {
    throw new Error("Production build needs two distinct, valid, compiled-in Ed25519 public bootstrap keys");
  }

  const stateDir = mkdtempSync(join(tmpdir(), "strideterm-prod-bootstrap-check-"));
  try {
    const result = await createControlPlaneBootstrapClient({
      stateDir,
      environment: "prod",
      url: trust.url,
      trust,
      ...(fetchImpl ? { fetchImpl } : {}),
    }).refresh();
    if (!result.changed || !result.envelope) {
      throw new Error(`Production bootstrap cannot be adopted by a fresh desktop (${result.refusal ?? "unknown"})`);
    }

    const payload = result.envelope.payload;
    if (
      payload.projectId !== EXPECTED_PROJECT ||
      payload.databaseUrl !== databaseInstanceUrl(EXPECTED_PROJECT) ||
      payload.functionsBaseUrl !== `https://${FUNCTIONS_REGION}-${EXPECTED_PROJECT}.cloudfunctions.net` ||
      payload.relayOrigin !== EXPECTED_RELAY
    ) {
      throw new Error("Production bootstrap names the wrong Firebase project, database, Functions or relay");
    }
    const cleanInstall = resolveMobileFirebaseConfig({ STRIDETERM_ENV: "prod" }, FUNCTIONS_REGION);
    const effective = resolveBootstrapFirebaseConfig(cleanInstall, result.envelope, FUNCTIONS_REGION);
    if (
      !effective.config ||
      effective.config.projectId !== EXPECTED_PROJECT ||
      effective.config.apiKey !== payload.apiKey
    ) {
      throw new Error("A clean production desktop cannot construct its Firebase client from the bootstrap");
    }
    return { epoch: payload.configEpoch, projectId: payload.projectId };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkProductionBootstrap(bootstrapTrustSet("prod", {}));
    console.log(`Production bootstrap accepted: ${result.projectId}, epoch ${result.epoch}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Production bootstrap check failed");
    process.exitCode = 1;
  }
}

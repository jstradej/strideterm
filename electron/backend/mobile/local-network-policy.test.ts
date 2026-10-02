import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { createControlPlaneBootstrapClient } from "./bootstrap-client.js";
import { resolveMobileFirebaseConfig } from "./mobile-firebase-config.js";
import { createMobileFirebaseRestClient } from "./mobile-firebase-rest.js";

test("Firebase and bootstrap requests do not follow a redirect even to another loopback path", async () => {
  let targetCalls = 0;
  const redirected: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/target") {
      targetCalls++;
      response.end("{}");
    } else {
      redirected.push(request.url ?? "");
      response.writeHead(307, { location: "/target" });
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stateDir = mkdtempSync(join(tmpdir(), "local-redirect-"));
  try {
    const bootstrap = createControlPlaneBootstrapClient({
      stateDir,
      environment: "local",
      url: `http://${host}/bootstrap`,
      // A trust key, or `refresh()` answers `not-configured` without fetching anything and this test
      // proves nothing about redirects. The envelope is never verified: the redirect is the answer.
      trust: { keys: new Map([["test-key", new Uint8Array(32)]]) },
    });
    expect((await bootstrap.refresh()).refusal).toBe("network");
    expect(redirected).toEqual(["/bootstrap"]);
    const config = resolveMobileFirebaseConfig(
      {
        STRIDETERM_ENV: "local",
        STRIDETERM_MOBILE_FIREBASE_PROJECT_ID: "demo-local",
        FIREBASE_AUTH_EMULATOR_HOST: host,
        FIREBASE_DATABASE_EMULATOR_HOST: host,
        FIREBASE_FUNCTIONS_EMULATOR_HOST: host,
      },
      "europe-west1",
    ).config!;
    const firebase = createMobileFirebaseRestClient({
      config,
      refreshTokenRef: "test",
      credentialStore: { getSecret: () => "", setSecret: async () => {}, deleteSecret: async () => {} },
    });
    await expect(firebase.signIn()).rejects.toThrow();
    expect(targetCalls).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

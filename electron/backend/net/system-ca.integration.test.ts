/**
 * Real TLS handshake, no network and no OS store — runs the same on every CI OS.
 *
 * A local HTTPS/WSS server presents a leaf signed by a test CA that Node's bundled roots do not
 * know: the situation behind a corporate TLS-inspection proxy. `applySystemCaTrust` is then fed
 * that CA as the "system" store and the real `tls.setDefaultCACertificates` applies it.
 *
 * Mutates process-global TLS state; vitest runs each test file in its own worker, and `afterAll`
 * restores the original default set.
 */
import https from "node:https";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { __resetSystemCaForTests, applySystemCaTrust } from "./system-ca.js";
import { classifyNetworkError } from "./network-error.js";

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const hasApi =
  typeof (tls as { setDefaultCACertificates?: unknown }).setDefaultCACertificates === "function" &&
  typeof (tls as { getCACertificates?: unknown }).getCACertificates === "function";

async function startServer(): Promise<{ server: https.Server; wss: WebSocketServer; port: number }> {
  const server = https.createServer(
    { cert: fixture("test-server.pem"), key: fixture("test-server.key") },
    (_req, res) => {
      res.setHeader("connection", "close");
      res.end("ok");
    },
  );
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.send("hello"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, wss, port: (server.address() as AddressInfo).port };
}

describe.skipIf(!hasApi)("applySystemCaTrust against a real TLS server", () => {
  const originalDefault = hasApi ? tls.getCACertificates("default") : [];
  const testCa = fixture("test-ca.pem");
  let before: Awaited<ReturnType<typeof startServer>>;
  let after: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    __resetSystemCaForTests();
    // Two servers on two ports: a pooled undici connection from the first assert can never be
    // reused for the second.
    before = await startServer();
    after = await startServer();
  });

  afterAll(async () => {
    tls.setDefaultCACertificates(originalDefault);
    __resetSystemCaForTests();
    for (const s of [before, after]) {
      s?.wss.close();
      await new Promise<void>((resolve) => (s ? s.server.close(() => resolve()) : resolve()));
    }
  });

  it("fails today, is classified as tls-untrusted, and succeeds once the system CA is trusted", async () => {
    // Assert 1: the untrusted chain fails like it does behind inspection.
    const failure = await fetch(`https://127.0.0.1:${before.port}/`).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(TypeError);
    // A leaf-only chain yields UNABLE_TO_VERIFY_LEAF_SIGNATURE; a proxy that also sends an
    // intermediate yields UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Both mean "no trusted root".
    expect(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"]).toContain(
      (failure as { cause?: { code?: string } }).cause?.code,
    );
    // Assert 1b: classification on the real undici error, not a hand-built shape.
    expect(classifyNetworkError(failure)).toBe("tls-untrusted");

    const result = applySystemCaTrust({
      getCACertificates: (type) => (type === "system" ? [testCa] : tls.getCACertificates(type)),
      env: {},
    });
    expect(result).toMatchObject({ status: "applied", systemCount: 1, addedCount: 1 });

    // Assert 2: fetch now passes.
    const response = await fetch(`https://127.0.0.1:${after.port}/`);
    expect(await response.text()).toBe("ok");

    // Assert 3: a `ws` client completes the WSS handshake too.
    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`wss://127.0.0.1:${after.port}`);
      socket.once("message", (data) => {
        socket.close();
        resolve(String(data));
      });
      socket.once("error", reject);
    });
    expect(message).toBe("hello");
  });
});

import net from "node:net";
import { describe, expect, test } from "vitest";
import { startRemoteServer } from "./remote-server.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

describe("bootstrap auth limiter cookie exemption", () => {
  test("a live cookie neither counts nor is blocked at token and ticket bootstrap routes", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const runtime = {
      getPayload: () => ({
        appState: {
          settings: {
            remoteAccess: {
              enabled: true,
              host: "127.0.0.1",
              port,
              token: "cookie-exemption-master-token",
              sessionIdleTtlMinutes: 15,
              sessionAbsoluteTtlMinutes: 60,
            },
          },
          profiles: [{ id: "default" }],
          workspaces: [],
          windowSlots: [],
        },
      }),
      getInitialState: async () => ({}),
      setRemoteInfo: () => undefined,
      listRemoteUrls: () => [],
      on: () => () => undefined,
      off: () => undefined,
      consumeRemoteBrowserTicket: (ticket: string, requestOrigin: string) =>
        ticket === "valid-ticket" && requestOrigin === origin ? { profileId: "default" } : null,
    };
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });

    try {
      const bootstrap = await fetch(`${origin}/?token=cookie-exemption-master-token`, { redirect: "manual" });
      const cookie = (bootstrap.headers.get("set-cookie") || "").split(";")[0]!;
      expect(cookie).toMatch(/^strideterm_session=/);

      for (let index = 0; index < 10; index += 1) {
        expect((await fetch(`${origin}/?token=invalid-${index}`, { redirect: "manual" })).status).toBe(401);
      }
      expect(
        (
          await fetch(`${origin}/?token=still-invalid`, {
            redirect: "manual",
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(401);
      expect((await fetch(`${origin}/?token=eleventh-invalid`, { redirect: "manual" })).status).toBe(429);

      expect(
        (
          await fetch(`${origin}/?ticket=invalid-ticket`, {
            redirect: "manual",
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(401);
      const ticketBootstrap = await fetch(`${origin}/?ticket=valid-ticket`, {
        redirect: "manual",
        headers: { Cookie: cookie },
      });
      expect(ticketBootstrap.status).toBe(302);
      expect(ticketBootstrap.headers.get("location")).toBe("/");
    } finally {
      await server.close();
    }
  });
});

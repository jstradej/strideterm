import { afterEach, describe, expect, test, vi } from "vitest";
import net from "node:net";
import { WebSocket } from "ws";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

describe("remote WebSocket upgrade error boundary", () => {
  afterEach(() => {
    vi.doUnmock("./logger.js");
    vi.resetModules();
  });

  test("logs malformed target metadata, returns 400, closes, and continues serving", async () => {
    const errors: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    vi.resetModules();
    vi.doMock("./logger.js", async () => {
      const actual = await vi.importActual<typeof import("./logger.js")>("./logger.js");
      return {
        ...actual,
        getLogger(label: string) {
          const base = actual.getLogger(label);
          if (label !== "remote-server") return base;
          return {
            ...base,
            error(message: string, meta?: Record<string, unknown>) {
              errors.push({ message, meta });
              base.error(message, meta);
            },
          };
        },
      };
    });

    const { startRemoteServer } = await import("./remote-server.js");
    const port = await getFreePort();
    const payload = {
      appState: {
        settings: {
          remoteAccess: {
            enabled: true,
            host: "127.0.0.1",
            port,
            token: "ws-upgrade-error-test-token",
          },
        },
        profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: [] }],
        workspaces: [],
        windowSlots: [],
      },
    };
    let tunnelResolverFails = false;
    const runtime = {
      getPayload: () => payload,
      getInitialState: async () => payload,
      setRemoteInfo: () => undefined,
      listRemoteUrls: () => [],
      on: () => () => undefined,
      off: () => undefined,
      setRemoteBrowserSessionController: () => undefined,
      isCloudflareTunnelConnected: () => {
        if (tunnelResolverFails) throw new Error("test auth address resolver failure");
        return false;
      },
    };
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const malformedResponse = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
          socket.write(
            "GET http://[?ticket=malformed-target-secret HTTP/1.1\r\n" +
              `Host: 127.0.0.1:${port}\r\n` +
              "Connection: Upgrade\r\n" +
              "Upgrade: websocket\r\n" +
              "Sec-WebSocket-Version: 13\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
          );
        });
        let response = "";
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("malformed upgrade socket did not close"));
        }, 2_000);
        timeout.unref();
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => (response += chunk));
        socket.once("end", () => {
          clearTimeout(timeout);
          resolve(response);
        });
        socket.once("error", reject);
      });

      expect(malformedResponse).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe("WebSocket upgrade rejected: malformed request target");
      expect(errors[0]?.meta).toMatchObject({
        errorName: "TypeError",
        errorCode: "ERR_INVALID_URL",
        remoteAddress: "127.0.0.1",
      });
      expect(JSON.stringify(errors[0])).not.toContain("malformed-target-secret");

      const bootstrap = await fetch(`${baseUrl}/?token=ws-upgrade-error-test-token`, { redirect: "manual" });
      expect(bootstrap.status).toBe(302);
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toMatch(/^strideterm_session=/);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const wsClosed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      ws.close();
      await wsClosed;

      tunnelResolverFails = true;
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
          socket.write(
            "GET /ws?token=invalid-upgrade-token HTTP/1.1\r\n" +
              `Host: 127.0.0.1:${port}\r\n` +
              "Connection: Upgrade\r\n" +
              "Upgrade: websocket\r\n" +
              "Sec-WebSocket-Version: 13\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
          );
        });
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("unexpected upgrade error socket did not close"));
        }, 2_000);
        timeout.unref();
        socket.on("error", () => undefined);
        socket.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      expect(errors).toHaveLength(2);
      expect(errors[1]?.message).toBe("WebSocket upgrade failed");
      expect(errors[1]?.meta).toMatchObject({
        error: { name: "Error", message: "test auth address resolver failure" },
        remoteAddress: "127.0.0.1",
      });
    } finally {
      await server.close();
    }
  });
});

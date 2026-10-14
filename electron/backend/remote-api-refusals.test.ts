/**
 * Two things the real remote server owes a remote page that cannot speak for itself:
 *  - Settings → SSH's explicit refresh reaches the runtime (the remote transport POSTs
 *    `{ refresh: true }` to /api/ssh/capabilities — src/transport.test.ts pins that body), so a phone
 *    or browser is not shown the runtime's cached preflight either;
 *  - a request it refused or failed lands in strideterm.log. The page's own `rlog` is a no-op, and in
 *    the native app the refusal's toast is the only other trace (CLAUDE.md: "A failed user action must
 *    reach the user AND strideterm.log").
 */
import net from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";

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

type LogCall = { message: string; meta?: Record<string, unknown> };

async function startServer() {
  const warnings: LogCall[] = [];
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
          warn(message: string, meta?: Record<string, unknown>) {
            warnings.push({ message, meta });
            base.warn(message, meta);
          },
        };
      },
    };
  });
  const { startRemoteServer } = await import("./remote-server.js");
  const port = await freePort();
  const token = "refusals-test-token";
  const capabilityCalls: unknown[] = [];
  const runtime = {
    getPayload: () => ({
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token } },
        profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: [] }],
        workspaces: [],
        windowSlots: [],
      },
    }),
    getInitialState: async () => ({}),
    setRemoteInfo: () => undefined,
    listRemoteUrls: () => [],
    on: () => () => undefined,
    off: () => undefined,
    "ssh:capabilities:get": async (payload: unknown) => {
      capabilityCalls.push(payload);
      return { platform: "linux", wsl: null, permissions: { canManageHosts: true } };
    },
  };
  const server = await startRemoteServer({
    runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
    staticRoot: process.cwd(),
  });
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  return { server, post, warnings, capabilityCalls };
}

describe("remote API refusals and refreshes", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await close?.();
    close = null;
    vi.doUnmock("./logger.js");
    vi.resetModules();
  });

  test("Settings → SSH's refresh reaches the runtime; an ordinary read does not ask for one", async () => {
    const { server, post, capabilityCalls } = await startServer();
    close = server.close;

    expect((await post("/api/ssh/capabilities", { refresh: true })).status).toBe(200);
    expect((await post("/api/ssh/capabilities", {})).status).toBe(200);
    expect(capabilityCalls).toEqual([{ refresh: true }, { refresh: false }]);
  });

  test("a refused request is written to strideterm.log with its route, status and reason — once a minute", async () => {
    const { server, post, warnings } = await startServer();
    close = server.close;

    const refused = await post("/api/ssh/keys/transfer/start", { profileId: "default", hostId: "h1", keyId: "k1" });
    expect(refused.status).toBe(403);
    await post("/api/ssh/keys/transfer/start", { profileId: "default", hostId: "h1", keyId: "k1" });
    await vi.waitFor(() =>
      expect(warnings.filter((call) => call.message === "remote API request failed")).toEqual([
        {
          message: "remote API request failed",
          meta: {
            method: "POST",
            path: "/api/ssh/keys/transfer/start",
            statusCode: 403,
            error: "SSH administration is not permitted on remote clients.",
          },
        },
      ]),
    );
  });
});

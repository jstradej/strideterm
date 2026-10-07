import { describe, expect, test, vi } from "vitest";
import net from "node:net";
import { WebSocket } from "ws";
import { startRemoteServer } from "./remote-server.js";
import type { RemoteBrowserSession, RemoteSessionRevoke } from "../shared/remote-access.js";
import * as logger from "./logger.js";

type SessionController = {
  list: () => RemoteBrowserSession[];
  revoke: (payload: RemoteSessionRevoke) => { revoked: number };
};

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

function makeRuntime(
  port: number,
  onController: (controller: unknown) => void,
  overrides: Record<string, unknown> = {},
) {
  const payload = {
    appState: {
      settings: {
        remoteAccess: {
          enabled: true,
          host: "127.0.0.1",
          port,
          token: "browser-hardening-token",
          sessionIdleTtlMinutes: 15,
          sessionAbsoluteTtlMinutes: 60,
        },
      },
      profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: [] }],
      workspaces: [],
      windowSlots: [],
    },
  };
  return {
    getPayload: () => payload,
    getInitialState: async () => payload,
    setRemoteInfo: () => undefined,
    listRemoteUrls: () => [],
    on: () => () => undefined,
    off: () => undefined,
    setRemoteBrowserSessionController: onController,
    ...overrides,
  };
}

async function bootstrap(baseUrl: string): Promise<{ cookie: string; maxAge: string | null }> {
  const response = await fetch(`${baseUrl}/?token=browser-hardening-token`, { redirect: "manual" });
  const cookieHeader = response.headers.get("set-cookie") || "";
  return {
    cookie: cookieHeader.split(";")[0] || "",
    maxAge: cookieHeader.match(/(?:^|;\s*)Max-Age=([^;]+)/i)?.[1] ?? null,
  };
}

describe("remote browser session hardening", () => {
  test("a token-client registry id cannot be presented as a session cookie", async () => {
    const port = await getFreePort();
    const runtime = makeRuntime(port, () => undefined);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const bearer = await fetch(`${baseUrl}/api/state`, {
        headers: {
          Authorization: "Bearer browser-hardening-token",
          "X-Strideterm-Client-Id": "known-client-id",
        },
      });
      expect(bearer.status).toBe(200);

      const forged = await fetch(`${baseUrl}/api/state`, {
        headers: { Cookie: "strideterm_session=token-client:known-client-id" },
      });
      expect(forged.status).toBe(401);

      const forgedWithBearer = await fetch(`${baseUrl}/api/state`, {
        headers: {
          Authorization: "Bearer wrong-token",
          Cookie: "strideterm_session=token-client:known-client-id",
        },
      });
      expect(forgedWithBearer.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("browser sessions advertise their absolute cookie lifetime and revoke closes its WebSocket", async () => {
    const port = await getFreePort();
    const controller: { current?: SessionController | null } = {};
    const runtime = makeRuntime(port, (value) => {
      controller.current = value as SessionController | null;
    });
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      mobileSessionSweepMs: 50,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const { cookie, maxAge } = await bootstrap(baseUrl);
      expect(Number(maxAge)).toBeGreaterThanOrEqual(3599);
      expect(Number(maxAge)).toBeLessThanOrEqual(3600);
      expect(cookie).toMatch(/^strideterm_session=[A-Za-z0-9_-]+$/);
      expect(controller.current?.list()).toHaveLength(1);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
      const listed = controller.current!.list()[0]!;
      expect(controller.current!.revoke({ sessionRef: listed.sessionRef })).toEqual({ revoked: 1 });
      expect(await closed).toBe(1008);
      expect(controller.current!.list()).toHaveLength(0);
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).status).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("revoking one browser session leaves a second session active", async () => {
    const port = await getFreePort();
    const controller: { current?: SessionController | null } = {};
    const runtime = makeRuntime(port, (value) => {
      controller.current = value as SessionController | null;
    });
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const first = await bootstrap(baseUrl);
      const second = await bootstrap(baseUrl);
      const sessions = controller.current!.list();
      expect(sessions).toHaveLength(2);
      expect(controller.current!.revoke({ sessionRef: sessions[0]!.sessionRef })).toEqual({ revoked: 1 });
      expect(controller.current!.list()).toHaveLength(1);
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: first.cookie } })).status).toBe(401);
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: second.cookie } })).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  test("heartbeat traffic does not extend browser idle expiry", async () => {
    const port = await getFreePort();
    const now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const runtime = makeRuntime(port, () => undefined);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      mobileSessionSweepMs: 1_000_000,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const { cookie } = await bootstrap(baseUrl);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
      vi.spyOn(Date, "now").mockImplementation(() => now + 15 * 60_000 + 1);
      ws.send(JSON.stringify({ type: "state:sync", rev: 1 }));
      expect(await closed).toBe(1008);
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).status).toBe(401);
    } finally {
      await server.close();
      vi.restoreAllMocks();
    }
  });

  test("the eleventh failed token bootstrap is rate limited while a valid cookie remains usable", async () => {
    const port = await getFreePort();
    const runtime = makeRuntime(port, () => undefined);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const { cookie } = await bootstrap(baseUrl);
      for (let index = 0; index < 10; index++) {
        expect((await fetch(`${baseUrl}/?token=wrong-${index}`, { redirect: "manual" })).status).toBe(401);
      }
      expect((await fetch(`${baseUrl}/?token=wrong-eleventh`, { redirect: "manual" })).status).toBe(429);
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  test("a blocked address gets 429 on WS upgrade while its valid cookie still opens a socket", async () => {
    const port = await getFreePort();
    const runtime = makeRuntime(port, () => undefined);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const { cookie } = await bootstrap(baseUrl);
      for (let index = 0; index < 10; index++) {
        expect((await fetch(`${baseUrl}/?token=bad-ws-${index}`, { redirect: "manual" })).status).toBe(401);
      }
      expect((await fetch(`${baseUrl}/?token=bad-ws-eleven`, { redirect: "manual" })).status).toBe(429);

      const unauthorized = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        socket.once("unexpected-response", (_request, response) => {
          response.resume();
          if (typeof response.statusCode !== "number") {
            reject(new Error("WebSocket upgrade response omitted its status code"));
            return;
          }
          resolve(response.statusCode);
        });
        socket.once("open", () => reject(new Error("unauthenticated socket unexpectedly opened")));
        socket.once("error", (error) => reject(error));
      });
      expect(unauthorized).toBe(429);

      const authorized = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
      await new Promise<void>((resolve, reject) => {
        authorized.once("open", resolve);
        authorized.once("error", reject);
      });
      authorized.close();
    } finally {
      await server.close();
    }
  });

  test("failed-auth audit metadata omits token and ticket secrets and request queries", async () => {
    const port = await getFreePort();
    const auditRows: { message: string; meta?: unknown }[] = [];
    vi.spyOn(logger, "createAuditLogger").mockImplementation(() => ({
      info: (message, meta) => auditRows.push({ message, meta }),
      warn: (message, meta) => auditRows.push({ message, meta }),
      close: () => undefined,
    }));
    const runtime = makeRuntime(port, () => undefined, {
      consumeRemoteBrowserTicket: () => null,
    });
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const tokenSecret = "token-secret-query-sentinel";
    const ticketSecret = "ticket-secret-query-sentinel";
    try {
      expect((await fetch(`${baseUrl}/?token=${tokenSecret}`, { redirect: "manual" })).status).toBe(401);
      expect((await fetch(`${baseUrl}/?ticket=${ticketSecret}`, { redirect: "manual" })).status).toBe(401);
      const authRows = auditRows.filter((row) => row.message === "auth failed");
      expect(authRows.map((row) => (row.meta as { kind: string }).kind)).toEqual(["token", "ticket"]);
      const serialized = JSON.stringify(authRows);
      expect(serialized).not.toContain(tokenSecret);
      expect(serialized).not.toContain(ticketSecret);
      expect(serialized).not.toContain("?token=");
      expect(serialized).not.toContain("?ticket=");
    } finally {
      await server.close();
      vi.restoreAllMocks();
    }
  });

  test("an unrecognized cookie cannot authenticate the API and is counted toward the address limit", async () => {
    const port = await getFreePort();
    const runtime = makeRuntime(port, () => undefined);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      for (let index = 0; index < 10; index++) {
        expect(
          (await fetch(`${baseUrl}/api/state`, { headers: { Cookie: `strideterm_session=bogus-${index}` } })).status,
        ).toBe(401);
      }
      expect(
        (await fetch(`${baseUrl}/api/state`, { headers: { Cookie: "strideterm_session=bogus-last" } })).status,
      ).toBe(429);
    } finally {
      await server.close();
    }
  });

  test("a failed-auth block lasts 15 minutes even after its five-minute count window", async () => {
    const port = await getFreePort();
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const runtime = makeRuntime(port, () => undefined);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      for (let index = 0; index < 11; index++) {
        const response = await fetch(`${baseUrl}/?token=bad-${index}`, { redirect: "manual" });
        expect(response.status).toBe(index === 10 ? 429 : 401);
      }
      now += 6 * 60_000;
      expect((await fetch(`${baseUrl}/?token=still-bad`, { redirect: "manual" })).status).toBe(429);
      now += 9 * 60_000 + 1;
      expect((await fetch(`${baseUrl}/?token=retry-after-block`, { redirect: "manual" })).status).toBe(401);
    } finally {
      await server.close();
      vi.restoreAllMocks();
    }
  });

  test("CF-Connecting-IP is used only for a connected tunnel and a valid IP", async () => {
    const port = await getFreePort();
    let tunnelConnected = false;
    const runtime = makeRuntime(port, () => undefined, { isCloudflareTunnelConnected: () => tunnelConnected });
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const attempt = (ip: string) =>
        fetch(`${baseUrl}/?token=bad`, {
          redirect: "manual",
          headers: { "CF-Connecting-IP": ip },
        });
      tunnelConnected = true;
      for (let index = 0; index < 10; index++) expect((await attempt("198.51.100.10")).status).toBe(401);
      expect((await attempt("198.51.100.10")).status).toBe(429);

      tunnelConnected = false;
      for (let index = 0; index < 10; index++) expect((await attempt("198.51.100.20")).status).toBe(401);
      expect((await attempt("198.51.100.20")).status).toBe(429);
      expect((await attempt("not-an-ip")).status).toBe(429);
    } finally {
      await server.close();
    }
  });

  test("the global failed-auth ceiling blocks rotating Cloudflare addresses", async () => {
    const port = await getFreePort();
    const runtime = makeRuntime(port, () => undefined, { isCloudflareTunnelConnected: () => true });
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      for (let index = 0; index < 200; index++) {
        const response = await fetch(`${baseUrl}/?token=global-bad-${index}`, {
          redirect: "manual",
          headers: { "CF-Connecting-IP": `198.51.${Math.floor(index / 250)}.${(index % 250) + 1}` },
        });
        expect(response.status).toBe(401);
      }
      const response = await fetch(`${baseUrl}/?token=global-bad-overflow`, {
        redirect: "manual",
        headers: { "CF-Connecting-IP": "203.0.113.7" },
      });
      expect(response.status).toBe(429);
    } finally {
      await server.close();
    }
  });

  test("failed-auth notification is emitted once per block and global cooldown is retained", async () => {
    const port = await getFreePort();
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const failures: { address: string; count: number; blockedUntil: number }[] = [];
    const runtime = makeRuntime(port, () => undefined, {
      reportRemoteAuthFailures: (event: { address: string; count: number; blockedUntil: number }) =>
        failures.push(event),
      isCloudflareTunnelConnected: () => true,
    });
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const attempt = (ip: string) =>
      fetch(`${baseUrl}/?token=bad`, {
        redirect: "manual",
        headers: { "CF-Connecting-IP": ip },
      });
    try {
      for (let index = 0; index < 11; index++) await attempt("198.51.100.55");
      expect(failures).toHaveLength(1);
      now += 6 * 60_000;
      expect((await attempt("198.51.100.55")).status).toBe(429);
      expect(failures).toHaveLength(1);

      for (let index = 0; index < 200; index++) {
        await attempt(`198.51.${Math.floor(index / 250)}.${(index % 250) + 1}`);
      }
      expect((await attempt("203.0.113.80")).status).toBe(429);
      now += 6 * 60_000;
      expect((await attempt("203.0.113.81")).status).toBe(429);
    } finally {
      await server.close();
      vi.restoreAllMocks();
    }
  });

  test("browser tickets are single use, profile-bound, and rejected by the relay origin", async () => {
    const port = await getFreePort();
    const tickets = new Map<string, { profileId: string; origin: string }>();
    const payload = {
      appState: {
        settings: {
          remoteAccess: {
            enabled: true,
            host: "127.0.0.1",
            port,
            token: "browser-hardening-token",
            sessionIdleTtlMinutes: 15,
            sessionAbsoluteTtlMinutes: 1440,
          },
        },
        profiles: [
          { id: "default", name: "Default", color: "#fff", workspaceIds: [] },
          { id: "work", name: "Work", color: "#000", workspaceIds: [] },
        ],
        workspaces: [],
        windowSlots: [],
      },
    };
    let consumeCalls = 0;
    const runtime = {
      getPayload: () => payload,
      getInitialState: async () => payload,
      setRemoteInfo: () => undefined,
      listRemoteUrls: () => [],
      on: () => () => undefined,
      off: () => undefined,
      setRemoteBrowserSessionController: () => undefined,
      consumeRemoteBrowserTicket(ticket: string, origin: string) {
        consumeCalls += 1;
        const record = tickets.get(ticket);
        if (!record || record.origin !== origin) return null;
        tickets.delete(ticket);
        return { profileId: record.profileId };
      },
    };
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      tickets.set("profile-ticket", { profileId: "work", origin: baseUrl });
      const first = await fetch(`${baseUrl}/?ticket=profile-ticket&profileId=default`, { redirect: "manual" });
      expect(first.status).toBe(302);
      expect(first.headers.get("location")).toBe("/");
      expect(first.headers.get("set-cookie")).toContain("strideterm_session=");
      const maxAge = Number(first.headers.get("set-cookie")!.match(/Max-Age=([^;]+)/)?.[1]);
      expect(maxAge).toBeGreaterThanOrEqual(43199);
      expect(maxAge).toBeLessThanOrEqual(43200);
      const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).status).toBe(200);
      expect((await fetch(`${baseUrl}/?ticket=profile-ticket`, { redirect: "manual" })).status).toBe(401);

      tickets.set("deleted-profile-ticket", { profileId: "deleted", origin: baseUrl });
      expect((await fetch(`${baseUrl}/?ticket=deleted-profile-ticket`, { redirect: "manual" })).status).toBe(401);
      expect(consumeCalls).toBe(3);
    } finally {
      await server.close();
    }

    const relayPort = await getFreePort();
    let relayConsumeCalls = 0;
    const relayRuntime = makeRuntime(relayPort, () => undefined, {
      consumeRemoteBrowserTicket: () => {
        relayConsumeCalls += 1;
        return { profileId: "default" };
      },
    });
    const relay = await startRemoteServer({
      runtime: relayRuntime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      loopbackOrigin: {
        host: "127.0.0.1",
        port: relayPort,
        guardToken: "relay-guard",
        publicOrigin: "https://relay.example",
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${relayPort}/?ticket=valid-looking-ticket`, {
        redirect: "manual",
        headers: { "X-Strideterm-Relay-Origin": "relay-guard" },
      });
      expect(response.status).toBe(401);
      expect(relayConsumeCalls).toBe(0);
    } finally {
      await relay.close();
    }
  });

  test("absolute session expiry closes an idle WebSocket and rejects the cookie", async () => {
    const port = await getFreePort();
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const runtime = makeRuntime(port, () => undefined);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      mobileSessionSweepMs: 50,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const { cookie } = await bootstrap(baseUrl);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
      now += 60 * 60_000 + 1;
      expect(await closed).toBe(1008);
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).status).toBe(401);
    } finally {
      await server.close();
      vi.restoreAllMocks();
    }
  });
});

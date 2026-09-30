import net from "node:net";
import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { startRemoteServer } from "./remote-server.js";

async function port(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return p;
}

function runtime(portNumber: number, relay = false, profileId = "default") {
  const events = new EventEmitter();
  const payload = {
    appState: {
      settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port: portNumber, token: "master-fixture" } },
      profiles: [
        { id: "default", workspaceIds: [] },
        { id: "other", workspaceIds: ["team:workspace"] },
      ],
      workspaces: [
        { id: "allowed", profileId: "default" },
        { id: "team:workspace", profileId: "other" },
      ],
      windowSlots: [],
    },
    remoteAccess: { urls: [`http://127.0.0.1:${portNumber}/?token=master-fixture`] },
  };
  let authorized = true;
  return {
    getPayload: () => payload,
    getInitialState: async () => payload,
    setRemoteInfo: () => undefined,
    listRemoteUrls: () => [],
    listMobileTicketOrigins: () => ["http://127.0.0.1"],
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      events.on(channel, listener);
      return () => events.off(channel, listener);
    },
    emitState: () => events.emit("state:updated", payload),
    isMobileSessionStillAuthorized: () => authorized,
    consumeMobileWebSessionTicket: () => ({
      deviceId: "phone",
      pairId: "pair",
      profileId,
      allowedOrigin: "http://127.0.0.1",
      transport: relay ? ("relay" as const) : ("legacy" as const),
      requiredCapability: "remote.webSession" as const,
      expiresAt: Date.now() + 60000,
    }),
    getTerminalReplay: (id: string) => ({ data: id }),
    getTaskStatus: (id: string) => ({ workspaceId: id }),
    refreshGitState: async () => ({ ok: true, payload }),
    revoke: () => {
      authorized = false;
    },
  };
}

async function mobileCookie(base: string): Promise<string> {
  const res = await fetch(`${base}/api/mobile/session/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticketId: "ticket", secret: "secret" }),
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

describe("remote mobile security boundaries", () => {
  test.each(["default", "other"])("protects HTTP and WebSocket state for profile %s", async (profileId) => {
    const p = await port();
    const rt = runtime(p, false, profileId);
    const allowed = profileId === "default" ? "allowed" : "team:workspace";
    const foreign = profileId === "default" ? "team:workspace" : "allowed";
    const server = await startRemoteServer({ runtime: rt as never, staticRoot: process.cwd() });
    const base = `http://127.0.0.1:${p}`;
    try {
      const cookie = await mobileCookie(base);
      const headers = { Cookie: cookie, "content-type": "application/json" };
      const state = await fetch(`${base}/api/state`, { headers });
      expect(state.status).toBe(200);
      expect(await state.text()).not.toContain("master-fixture");
      const nested = await fetch(`${base}/api/git/refresh`, { method: "POST", headers, body: "{}" });
      expect(nested.status).toBe(200);
      expect(await nested.text()).not.toContain("master-fixture");
      for (const [path, body] of [
        ["/api/terminal/replay", { sessionId: `${allowed}:panel` }],
        ["/api/task/status", { workspaceId: allowed }],
      ] as const) {
        expect((await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(200);
      }
      for (const [path, body] of [
        ["/api/terminal/replay", { sessionId: `${foreign}:panel` }],
        ["/api/task/status", { workspaceId: foreign }],
        ["/api/terminal/replay", { sessionId: "missing:panel" }],
        ["/api/task/status", { workspaceId: "missing" }],
      ] as const) {
        expect((await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(403);
      }
      // The official client connects as protocol 2 with the revision it bootstrapped over HTTP; a
      // revision the server does not hold makes the open handoff send one catch-up core. A mobile
      // socket is v2 whatever it sends, so there is no legacy first frame to wait for any more.
      const ws = new WebSocket(`ws://127.0.0.1:${p}/ws?sp=2&rev=999999`, { headers: { Cookie: cookie } });
      const frame = await new Promise<string>((resolve, reject) => {
        ws.once("message", (m) => resolve(String(m)));
        ws.once("error", reject);
      });
      expect(JSON.parse(frame).type).toBe("state:updated");
      expect(frame).not.toContain("master-fixture");
      const update = new Promise<string>((resolve) => ws.once("message", (message) => resolve(String(message))));
      rt.emitState();
      const updatedFrame = await update;
      expect(JSON.parse(updatedFrame).type).toBe("state:updated");
      expect(updatedFrame).not.toContain("master-fixture");
      ws.close();
      rt.revoke();
      expect((await fetch(`${base}/api/state`, { headers })).status).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("preserves ordinary browser QR bootstrap and share URL", async () => {
    const p = await port();
    const rt = runtime(p);
    const server = await startRemoteServer({ runtime: rt as never, staticRoot: process.cwd() });
    const base = `http://127.0.0.1:${p}`;
    try {
      const boot = await fetch(`${base}/?token=master-fixture`, { redirect: "manual" });
      expect(boot.status).toBe(302);
      expect(boot.headers.get("location")).toBe("/");
      const cookie = (boot.headers.get("set-cookie") || "").split(";")[0];
      const state = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
      expect(state.status).toBe(200);
      expect(await state.text()).toContain("master-fixture");
      for (const [path, body] of [
        ["/api/terminal/replay", { sessionId: "team:workspace:panel" }],
        ["/api/task/status", { workspaceId: "team:workspace" }],
      ] as const) {
        const response = await fetch(base + path, {
          method: "POST",
          headers: { Authorization: "Bearer master-fixture", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
      }
    } finally {
      await server.close();
    }
  });

  test("redacts mobile state on the relay listener too", async () => {
    const p = await port();
    const rt = runtime(p, true);
    const server = await startRemoteServer({
      runtime: rt as never,
      staticRoot: process.cwd(),
      loopbackOrigin: { host: "127.0.0.1", port: p, guardToken: "guard", publicOrigin: "https://relay.test" },
    });
    const base = `http://127.0.0.1:${p}`;
    try {
      const guard = { "x-strideterm-relay-origin": "guard", "x-strideterm-relay-device": "phone" };
      const boot = await fetch(`${base}/api/mobile/session/bootstrap`, {
        method: "POST",
        headers: { ...guard, "content-type": "application/json" },
        body: JSON.stringify({ ticketId: "ticket", secret: "secret" }),
        redirect: "manual",
      });
      expect(boot.status).toBe(302);
      const cookie = (boot.headers.get("set-cookie") || "").split(";")[0];
      const state = await fetch(`${base}/api/state`, { headers: { ...guard, Cookie: cookie } });
      expect(state.status).toBe(200);
      expect(await state.text()).not.toContain("master-fixture");
    } finally {
      await server.close();
    }
  });
});

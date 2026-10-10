import { describe, expect, test } from "vitest";
import net from "node:net";
import { startRemoteServer } from "./remote-server.js";

type Call = { method: string; args: unknown[] };

async function getFreePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

describe("mobile native workspace routes", () => {
  test("an authenticated empty-profile session receives an empty scoped core and can create its first workspace", async () => {
    const port = await getFreePort();
    const calls: Call[] = [];
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: "master-token" } },
        profiles: [
          { id: "default", name: "Default", workspaceIds: [] },
          { id: "other", name: "Other", workspaceIds: ["ws-other"] },
        ],
        workspaces: [{ id: "ws-other", name: "Other workspace", profileId: "other", panels: [] }],
        windowSlots: [{ id: "other-window", profileId: "other", activeWorkspaceId: "ws-other" }],
      },
    };
    const runtime = makeRuntime(payload, calls);
    const server = await startRemoteServer({ runtime: runtime as never, staticRoot: process.cwd() });
    const base = `http://127.0.0.1:${port}`;

    try {
      const cookie = await bootstrap(base, runtime, "default");
      const stateResponse = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
      expect(stateResponse.status).toBe(200);
      const core = (await stateResponse.json()) as {
        stateProtocol: number;
        appState: { workspaces: Array<{ id: string }> };
        remoteClient: { profileId: string; activeWorkspaceId: string };
      };
      expect(core.stateProtocol).toBe(2);
      expect(core.remoteClient).toMatchObject({ profileId: "default", activeWorkspaceId: "" });
      expect(core.appState.workspaces).toEqual([]);

      const create = (profileId: string) =>
        fetch(`${base}/api/mobile/workspaces/create`, {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie },
          body: JSON.stringify({ profileId, requestId: "create-first", path: "C:/Projects/First", name: "First" }),
        });
      expect((await create("other")).status).toBe(403);
      expect(calls).toEqual([]);

      const created = await create("default");
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({
        name: "First",
        path: "C:/Projects/First",
        profileId: "default",
        workspaceId: "ws-created",
      });
      expect(calls).toEqual([
        {
          method: "createWorkspaceFromDirectory",
          args: ["default", "C:/Projects/First", "First", expect.stringMatching(/^remote:/)],
        },
      ]);
    } finally {
      await server.close();
    }
  });

  test("authenticates and forwards all native workspace operations with the session profile", async () => {
    const port = await getFreePort();
    const calls: Call[] = [];
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: "master-token" } },
        profiles: [
          { id: "default", name: "Default", workspaceIds: [] },
          { id: "other", name: "Other", workspaceIds: [] },
        ],
        workspaces: [],
        windowSlots: [],
      },
    };
    const runtime = makeRuntime(payload, calls);
    const server = await startRemoteServer({ runtime: runtime as never, staticRoot: process.cwd() });
    const base = `http://127.0.0.1:${port}`;

    try {
      const cookie = await bootstrap(base, runtime, "default");
      const request = (path: string, body: Record<string, unknown>) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie },
          body: JSON.stringify(body),
        });

      const responses: Response[] = [];
      for (const [path, body] of [
        [
          "/api/mobile/workspaces/directories/list",
          { profileId: "default", requestId: "r-list", path: "C:/", query: "pro", sort: "nameDesc" },
        ],
        [
          "/api/mobile/workspaces/directories/create",
          {
            profileId: "default",
            requestId: "r-create-dir",
            parentPath: "C:/",
            name: "Projects",
          },
        ],
        [
          "/api/mobile/workspaces/create",
          {
            profileId: "default",
            requestId: "r-create-ws",
            path: "C:/Projects",
            name: "Project",
          },
        ],
        ["/api/mobile/workspaces/scratchpads/list", { profileId: "default", requestId: "r-sp-list" }],
        ["/api/mobile/workspaces/scratchpads/create", { profileId: "default", requestId: "r-sp-create" }],
        [
          "/api/mobile/workspaces/scratchpads/keep",
          {
            profileId: "default",
            requestId: "r-sp-keep",
            workspaceId: "scratch-1",
            name: "Kept",
          },
        ],
        [
          "/api/mobile/workspaces/scratchpads/discard",
          {
            profileId: "default",
            requestId: "r-sp-discard",
            workspaceId: "scratch-1",
            confirmed: true,
          },
        ],
      ] as const) {
        responses.push(await request(path, body));
      }

      const statusAndBodies = await Promise.all(
        responses.map(async (response) => ({ status: response.status, body: await response.text() })),
      );
      expect(statusAndBodies.map(({ status }) => status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
      expect(statusAndBodies.map(({ body }) => JSON.parse(body))).toEqual([
        { entries: [], path: "C:/", profileId: "default" },
        { created: true, name: "Projects", parentPath: "C:/", profileId: "default" },
        { name: "Project", path: "C:/Projects", profileId: "default", workspaceId: "ws-created" },
        { scratchpads: [], profileId: "default" },
        { name: "Scratchpad", path: "C:/scratch-1", profileId: "default", workspaceId: "scratch-1" },
        { name: "Kept", profileId: "default", workspaceId: "scratch-1" },
        { ok: true, profileId: "default", workspaceId: "scratch-1" },
      ]);

      expect(calls).toEqual([
        { method: "listWorkspaceDirectories", args: ["default", "C:/", { query: "pro", sort: "nameDesc" }] },
        { method: "createWorkspaceDirectory", args: ["default", "C:/", "Projects"] },
        { method: "createWorkspaceFromDirectory", args: ["default", "C:/Projects", "Project", expect.any(String)] },
        { method: "listScratchpadWorkspaces", args: ["default"] },
        { method: "createScratchpadWorkspace", args: ["default"] },
        {
          method: "keepScratchpadWorkspace",
          args: [
            "default",
            "scratch-1",
            { profileId: "default", requestId: "r-sp-keep", workspaceId: "scratch-1", name: "Kept" },
          ],
        },
        { method: "discardScratchpadWorkspace", args: ["default", "scratch-1", true] },
      ]);
    } finally {
      await server.close();
    }
  });

  test("rejects unauthenticated, master-token, cross-profile, revoked, malformed, and unsafe requests", async () => {
    const port = await getFreePort();
    const calls: Call[] = [];
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: "master-token" } },
        profiles: [
          { id: "default", name: "Default", workspaceIds: [] },
          { id: "other", name: "Other", workspaceIds: [] },
        ],
        workspaces: [],
        windowSlots: [],
      },
    };
    const runtime = makeRuntime(payload, calls);
    const server = await startRemoteServer({ runtime: runtime as never, staticRoot: process.cwd() });
    const base = `http://127.0.0.1:${port}`;
    try {
      const route = "/api/mobile/workspaces/scratchpads/discard";
      const body = { profileId: "default", requestId: "reject", workspaceId: "scratch-1", confirmed: true };
      expect((await post(base, route, body)).status).toBe(401);
      expect((await post(base, route, body, { Authorization: "Bearer master-token" })).status).toBe(403);

      const cookie = await bootstrap(base, runtime, "default");
      expect((await post(base, route, { ...body, profileId: "other" }, { Cookie: cookie })).status).toBe(403);
      expect((await post(base, route, { ...body, confirmed: false }, { Cookie: cookie })).status).toBe(400);
      expect(
        (
          await post(
            base,
            "/api/mobile/workspaces/directories/create",
            {
              profileId: "default",
              parentPath: "C:/",
              name: "",
            },
            { Cookie: cookie },
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await post(
            base,
            "/api/mobile/workspaces/directories/list",
            { profileId: "default", query: "x".repeat(257) },
            { Cookie: cookie },
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await post(
            base,
            "/api/mobile/workspaces/directories/list",
            { profileId: "default", sort: "size" },
            { Cookie: cookie },
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await post(
            base,
            "/api/mobile/workspaces/scratchpads/keep",
            {
              profileId: "default",
              workspaceId: "",
            },
            { Cookie: cookie },
          )
        ).status,
      ).toBe(400);

      runtime.authorized = false;
      expect((await post(base, route, body, { Cookie: cookie })).status).toBe(401);
      expect(calls).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

function makeRuntime(payload: Record<string, unknown>, calls: Call[]) {
  const runtime = {
    authorized: true,
    getPayload: () => payload,
    getInitialState: async () => payload,
    setRemoteInfo: () => undefined,
    listRemoteUrls: () => [],
    listMobileTicketOrigins: () => ["http://127.0.0.1"],
    on: () => () => undefined,
    isMobileSessionStillAuthorized: () => runtime.authorized,
    consumeMobileWebSessionTicket: (ticketId: string, secret: string) => {
      if (secret !== "secret") return null;
      return {
        deviceId: "phone-1",
        pairId: "pair-1",
        profileId: ticketId === "other" ? "other" : "default",
        allowedOrigin: "http://127.0.0.1",
        transport: "legacy" as const,
        requiredCapability: "remote.webSession" as const,
        expiresAt: Date.now() + 60_000,
      };
    },
    listWorkspaceDirectories: async (
      profileId: string,
      path?: string,
      options?: { query?: string; sort?: "nameAsc" | "nameDesc" },
    ) => {
      calls.push({
        method: "listWorkspaceDirectories",
        args: [profileId, path, ...(options?.query || options?.sort ? [options] : [])],
      });
      return { entries: [], path, profileId };
    },
    createWorkspaceDirectory: async (profileId: string, parentPath: string, name: string) => {
      calls.push({ method: "createWorkspaceDirectory", args: [profileId, parentPath, name] });
      return { created: true, name, parentPath, profileId };
    },
    createWorkspaceFromDirectory: async (profileId: string, path: string, name: string, viewerId: string) => {
      calls.push({ method: "createWorkspaceFromDirectory", args: [profileId, path, name, viewerId] });
      return { name, path, profileId, workspaceId: "ws-created" };
    },
    listScratchpadWorkspaces: async (profileId: string) => {
      calls.push({ method: "listScratchpadWorkspaces", args: [profileId] });
      return { scratchpads: [], profileId };
    },
    createScratchpadWorkspace: async (profileId: string) => {
      calls.push({ method: "createScratchpadWorkspace", args: [profileId] });
      return { name: "Scratchpad", path: "C:/scratch-1", profileId, workspaceId: "scratch-1" };
    },
    keepScratchpadWorkspace: async (profileId: string, workspaceId: string, options: Record<string, unknown>) => {
      calls.push({ method: "keepScratchpadWorkspace", args: [profileId, workspaceId, options] });
      return { name: options.name, profileId, workspaceId };
    },
    discardScratchpadWorkspace: async (profileId: string, workspaceId: string, confirmed: boolean) => {
      calls.push({ method: "discardScratchpadWorkspace", args: [profileId, workspaceId, confirmed] });
      return { ok: true, profileId, workspaceId };
    },
  };
  return runtime;
}

async function bootstrap(base: string, _runtime: unknown, profile: string) {
  const response = await fetch(`${base}/api/mobile/session/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticketId: profile, secret: "secret" }),
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

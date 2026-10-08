import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { startRemoteServer } from "./remote-server.js";
import { setAllowedRootsResolver } from "./file-manager.js";

/**
 * A mobile session's profile is a boundary, not a filter on what the UI draws.
 * Two profiles ("home", "work") share one desktop; a phone is bound to "home".
 * Everything here goes through the real remote server with a real mobile cookie
 * minted by the ticket bootstrap, against a runtime whose every method records
 * its call — so "refused" means the runtime was never reached.
 */

const MASTER = "master-token-for-boundary-tests";
const ORIGIN = "https://example.trycloudflare.com";

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

interface Call {
  name: string;
  args: unknown[];
}

function makeRuntime(port: number) {
  const payload = {
    appState: {
      settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: MASTER } },
      profiles: [
        { id: "home", name: "Home", color: "#fff", workspaceIds: ["ws-home"] },
        { id: "work", name: "Work Secret Profile", color: "#000", workspaceIds: ["ws-work"] },
      ],
      workspaces: [
        { id: "ws-home", name: "Home repo", profileId: "home", cwd: "/home-root", panels: [{ id: "a" }] },
        { id: "ws-work", name: "Work repo", profileId: "work", cwd: "/work-root", panels: [{ id: "a" }] },
      ],
      windowSlots: [
        { id: "win-home", profileId: "home", activeWorkspaceId: "ws-home" },
        { id: "win-work", profileId: "work", activeWorkspaceId: "ws-work" },
      ],
    },
  };
  const calls: Call[] = [];
  const handlers: Record<string, ((p: unknown) => void)[]> = {};
  const base: Record<string, unknown> = {
    getPayload: () => payload,
    getInitialState: async () => payload,
    setRemoteInfo: () => undefined,
    listRemoteUrls: () => [],
    listMobileTicketOrigins: () => [ORIGIN],
    on: (channel: string, handler: (p: unknown) => void) => {
      (handlers[channel] ||= []).push(handler);
      return () => undefined;
    },
    setRemoteClientRegistry: () => undefined,
    isSshTestSessionId: (sessionId: unknown) => typeof sessionId === "string" && sessionId.startsWith("ssh-test:"),
    isPrivateSshOperationSessionId: (sessionId: unknown) =>
      typeof sessionId === "string" && /^(ssh-test:|ssh-transfer:)/.test(sessionId),
    isMobileSessionStillAuthorized: () => true,
    consumeMobileWebSessionTicket: (ticketId: string, secret: string) =>
      ticketId === "ticket-home" && secret === "secret"
        ? {
            deviceId: "device-1",
            pairId: "pair-1",
            profileId: "home",
            allowedOrigin: ORIGIN,
            transport: "legacy" as const,
            requiredCapability: "remote.webSession" as const,
            expiresAt: Date.now() + 60_000,
          }
        : null,
  };
  // Routes that hand back `result.payload` need that shape, not the bare payload.
  base.updateSettings = (...args: unknown[]) => {
    calls.push({ name: "updateSettings", args });
    return { payload };
  };
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return undefined;
    };
  // Every method the test does not define itself is a recording no-op that answers with the
  // state payload — enough for a route that reaches it to answer 200.
  const runtime = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      if (prop in target) return target[prop];
      const fn = record(prop);
      return (...args: unknown[]) => {
        fn(...args);
        return payload;
      };
    },
  });
  return { runtime, calls, payload, handlers, called: (name: string) => calls.filter((c) => c.name === name) };
}

type Fixture = ReturnType<typeof makeRuntime> & {
  port: number;
  base: string;
  close: () => Promise<void>;
  mobileCookie: () => Promise<string>;
};

const open: Fixture[] = [];

async function startFixture(): Promise<Fixture> {
  const port = await getFreePort();
  const rt = makeRuntime(port);
  const server = await startRemoteServer({
    runtime: rt.runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
    staticRoot: process.cwd(),
  });
  const fixture: Fixture = {
    ...rt,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => server.close(),
    mobileCookie: async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/mobile/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: "ticket-home", secret: "secret" }),
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      return (res.headers.get("set-cookie") || "").split(";")[0];
    },
  };
  open.push(fixture);
  return fixture;
}

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  setAllowedRootsResolver(() => []);
});

const post = (f: Fixture, route: string, cookie: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${f.base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, ...headers },
    body: JSON.stringify(body),
  });

const tokenClient = (clientId: string, profileId?: string): Record<string, string> => ({
  Authorization: `Bearer ${MASTER}`,
  "X-Strideterm-Client-Id": clientId,
  ...(profileId ? { "X-Strideterm-Profile-Id": profileId } : {}),
});

describe("a mobile session is always served the profile-scoped v2 core", () => {
  test("GET /api/state with no protocol header omits the other profile", async () => {
    const f = await startFixture();
    const cookie = await f.mobileCookie();
    const res = await fetch(`${f.base}/api/state`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const core = JSON.parse(text) as { stateProtocol: number; appState: { workspaces: Array<{ id: string }> } };
    expect(core.stateProtocol).toBe(2);
    expect(core.appState.workspaces.map((w) => w.id)).toEqual(["ws-home"]);
    expect(text).not.toContain("Work repo");
    expect(text).not.toContain("/work-root");
  });

  test("a client-sent protocol 1, and a capability list without remote-core-v2, are ignored", async () => {
    const f = await startFixture();
    const cookie = await f.mobileCookie();
    const variants: Array<Record<string, string>> = [
      { "X-Strideterm-State-Protocol": "1" },
      { "X-Strideterm-Capabilities": "resource-details-v1" },
    ];
    for (const headers of variants) {
      const res = await fetch(`${f.base}/api/state?sp=1`, { headers: { Cookie: cookie, ...headers } });
      const core = (await res.json()) as { stateProtocol: number; appState: { workspaces: Array<{ id: string }> } };
      expect(core.stateProtocol, JSON.stringify(headers)).toBe(2);
      expect(core.appState.workspaces.map((w) => w.id)).toEqual(["ws-home"]);
    }
  });

  test("a master-token client with no protocol header still gets the legacy full payload (control)", async () => {
    const f = await startFixture();
    const res = await fetch(`${f.base}/api/state`, { headers: { Authorization: `Bearer ${MASTER}` } });
    const legacy = (await res.json()) as { appState: { workspaces: Array<{ id: string }> } };
    expect(legacy.appState.workspaces.map((w) => w.id)).toEqual(["ws-home", "ws-work"]);
  });

  test("the WebSocket of a mobile session gets no other profile either, with no ?sp=", async () => {
    const f = await startFixture();
    const cookie = await f.mobileCookie();
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws?rev=999`, { headers: { Cookie: cookie } });
    const frames: string[] = [];
    ws.on("message", (raw: Buffer) => frames.push(raw.toString()));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 300));
    ws.close();
    const all = frames.join("\n");
    // `rev` differing from the server's makes the open handoff send one catch-up core.
    expect(all).toContain('"stateProtocol":2');
    expect(all).toContain("ws-home");
    expect(all).not.toContain("Work repo");
    expect(all).not.toContain("/work-root");
  });
});

describe("routes a mobile session may not call", () => {
  const DENIED: Array<[string, string, Record<string, unknown>]> = [
    ["/api/remote/token/regenerate", "regenerateRemoteToken", {}],
    ["/api/tunnel/create", "createCloudflareTunnel", {}],
    ["/api/tunnel/stop", "stopCloudflareTunnel", {}],
    ["/api/telegram/save-connection", "saveTelegramConnection", { connection: { chatId: "1", botToken: "x" } }],
    ["/api/profile/delete", "deleteProfile", { profileId: "work" }],
    ["/api/profile/save", "saveProfile", { profile: { id: "x" } }],
    ["/api/claude-hook/configure", "configureClaudeHook", {}],
    ["/api/docker/action", "dockerAction", { containerId: "c" }],
    ["/api/docker/image/remove", "removeDockerImage", {}],
    [
      "/api/docker/shell/open",
      "dockerShellOpen",
      { sessionId: "s", containerId: "c", backendId: "b", contextName: "x" },
    ],
    ["/api/azure/save-connection", "saveAzureConnection", { connection: { id: "a" } }],
    ["/api/github/delete-connection", "deleteGitHubConnection", { connectionId: "g" }],
    ["/api/task/reject-verdict", "rejectTaskVerdict", { workspaceId: "ws-home" }],
    ["/api/task/resend-instruction", "resendTaskInstruction", { workspaceId: "ws-home" }],
    ["/api/terminal/restart", "restartTerminal", { sessionId: "ws-home:a" }],
    ["/api/session/activate", "activateSession", { sessionId: "ws-home:a" }],
    ["/api/file/write", "", { rootPath: "/home-root", relativePath: "x", content: "y" }],
    ["/api/file/delete", "", { rootPath: "/home-root", relativePath: "x" }],
  ];

  test.each(DENIED)("POST %s answers 403 and never reaches the runtime", async (route, method) => {
    const f = await startFixture();
    const cookie = await f.mobileCookie();
    const res = await post(f, route, cookie, DENIED.find(([r]) => r === route)![2]);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason?: string }).reason).toBe("route-not-available-to-mobile");
    if (method) expect(f.called(method)).toEqual([]);
  });

  test("the same route is still available to a master-token client (control)", async () => {
    const f = await startFixture();
    const res = await fetch(`${f.base}/api/remote/token/regenerate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${MASTER}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(f.called("regenerateRemoteToken")).toHaveLength(1);
  });

  test("settings/update: a phone may persist only its remote terminal font size", async () => {
    const f = await startFixture();
    const cookie = await f.mobileCookie();
    const allowed = await post(f, "/api/settings/update", cookie, {
      settings: { terminalFontSizeRemote: 14 },
    });
    expect(allowed.status).toBe(200);
    expect(f.called("updateSettings").map((call) => call.args[0])).toEqual([{ terminalFontSizeRemote: 14 }]);

    for (const body of [
      { settings: { terminalFontSizeLocal: 14 } },
      { settings: { externalEditor: "x" } },
      { settings: { terminalFontSizeRemote: 14, externalEditor: "x" } },
      { settings: { terminalFontSizeRemote: 7 } },
      { settings: { terminalFontSizeRemote: 14 }, workspaceId: "ws-home" },
    ]) {
      expect((await post(f, "/api/settings/update", cookie, body)).status).toBe(403);
    }
    expect(f.called("updateSettings")).toHaveLength(1);
  });

  test("a target of another profile is refused on routes that are otherwise allowed", async () => {
    const f = await startFixture();
    const cookie = await f.mobileCookie();
    const foreign = await post(f, "/api/task/stop", cookie, { workspaceId: "ws-work" });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { reason?: string }).reason).toBe("target-outside-profile");
    expect(f.called("stopTask")).toEqual([]);
    const foreignGit = await post(f, "/api/git/refresh", cookie, { projectId: "ws-work" });
    expect(foreignGit.status).toBe(403);
    expect(f.called("refreshGitState")).toEqual([]);

    const own = await post(f, "/api/task/stop", cookie, { workspaceId: "ws-home" });
    expect(own.status).toBe(200);
    expect(f.called("stopTask")).toHaveLength(1);
    // The body was read by the gate, then again by the route: the cache hands it over intact.
    expect(f.called("stopTask")[0].args[0]).toBe("ws-home");
  });

  test("creating a workspace with a client-generated id still works and runs as the phone's viewer", async () => {
    const f = await startFixture();
    const cookie = await f.mobileCookie();
    const res = await post(f, "/api/workspace/save", cookie, {
      workspace: { id: "workspace-brand-new", name: "New", cwd: "/somewhere/new" },
    });
    expect(res.status).toBe(200);
    const [call] = f.called("saveWorkspace");
    expect(call.args[1]).toMatch(/^remote:/);
  });
});

describe("file roots follow the caller's profile", () => {
  async function withRoots() {
    // realpath: on macOS os.tmpdir() is under /var, which the file manager refuses as a system path.
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "boundary-files-")));
    const homeRoot = path.join(dir, "home");
    const workRoot = path.join(dir, "work");
    await fs.mkdir(homeRoot);
    await fs.mkdir(workRoot);
    await fs.writeFile(path.join(homeRoot, "note.txt"), "home note");
    await fs.writeFile(path.join(workRoot, "secret.txt"), "work secret");
    const byProfile: Record<string, string[]> = { home: [homeRoot], work: [workRoot] };
    setAllowedRootsResolver((profile) => (profile ? byProfile[profile] || [] : [homeRoot, workRoot]));
    return { dir, homeRoot, workRoot };
  }

  test("a mobile session reads its own profile's files and is refused another's", async () => {
    const { dir, homeRoot, workRoot } = await withRoots();
    try {
      const f = await startFixture();
      const cookie = await f.mobileCookie();
      const own = await post(f, "/api/file/read", cookie, { rootPath: homeRoot, relativePath: "note.txt" });
      expect(own.status).toBe(200);
      expect(JSON.stringify(await own.json())).toContain("home note");
      const foreign = await post(f, "/api/file/read", cookie, { rootPath: workRoot, relativePath: "secret.txt" });
      expect(foreign.status).toBe(403);
      expect(await foreign.text()).not.toContain("work secret");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("a mobile session cannot write or delete files at all, in its own profile either", async () => {
    const { dir, homeRoot } = await withRoots();
    try {
      const f = await startFixture();
      const cookie = await f.mobileCookie();
      const write = await post(f, "/api/file/write", cookie, {
        rootPath: homeRoot,
        relativePath: "note.txt",
        content: "overwritten",
      });
      expect(write.status).toBe(403);
      expect(await fs.readFile(path.join(homeRoot, "note.txt"), "utf8")).toBe("home note");
      const del = await post(f, "/api/file/delete", cookie, { rootPath: homeRoot, relativePath: "note.txt" });
      expect(del.status).toBe(403);
      await expect(fs.stat(path.join(homeRoot, "note.txt"))).resolves.toBeTruthy();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("a bound remote client of another profile is scoped the same way", async () => {
    const { dir, homeRoot, workRoot } = await withRoots();
    try {
      const f = await startFixture();
      const headers = { ...tokenClient("work-browser", "work"), "Content-Type": "application/json" };
      const call = (rootPath: string, relativePath: string) =>
        fetch(`${f.base}/api/file/read?profileId=work`, {
          method: "POST",
          headers,
          body: JSON.stringify({ rootPath, relativePath }),
        });
      expect((await call(workRoot, "secret.txt")).status).toBe(200);
      expect((await call(homeRoot, "note.txt")).status).toBe(403);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("WebSocket writes are held to the caller's profile", () => {
  async function connect(f: Fixture, opts: { cookie?: string; clientId?: string; profileId?: string }) {
    const q = new URLSearchParams({ token: MASTER });
    if (opts.clientId) q.set("clientId", opts.clientId);
    if (opts.profileId) q.set("profileId", opts.profileId);
    const url = opts.cookie ? `ws://127.0.0.1:${f.port}/ws` : `ws://127.0.0.1:${f.port}/ws?${q.toString()}`;
    const ws = new WebSocket(url, opts.cookie ? { headers: { Cookie: opts.cookie } } : undefined);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    return ws;
  }
  const settle = () => new Promise((r) => setTimeout(r, 250));
  const send = (ws: WebSocket, message: unknown) => ws.send(JSON.stringify(message));

  test("a bound client's terminal writes and resize for another profile's session are dropped", async () => {
    const f = await startFixture();
    const ws = await connect(f, { clientId: "home-tab", profileId: "home" });
    send(ws, { type: "terminal:input", sessionId: "ws-work:a", data: "rm -rf ~\n" });
    send(ws, { type: "terminal:submit", sessionId: "ws-work:a", text: "rm -rf ~" });
    send(ws, { type: "terminal:resize", sessionId: "ws-work:a", cols: 80, rows: 24 });
    await settle();
    expect(f.called("writeToSession")).toEqual([]);
    expect(f.called("submitToSession")).toEqual([]);
    expect(f.called("resizeSession")).toEqual([]);
    ws.close();
  });

  test("the same client's own profile still types and resizes (regression)", async () => {
    const f = await startFixture();
    const ws = await connect(f, { clientId: "home-tab", profileId: "home" });
    send(ws, { type: "terminal:input", sessionId: "ws-home:a", data: "ls\n" });
    send(ws, { type: "terminal:submit", sessionId: "ws-home:a", text: "echo hi" });
    send(ws, { type: "terminal:resize", sessionId: "ws-home:a", cols: 100, rows: 30 });
    await settle();
    expect(f.called("writeToSession")).toHaveLength(1);
    expect(f.called("submitToSession")).toHaveLength(1);
    expect(f.called("resizeSession")).toHaveLength(1);
    ws.close();
  });

  test("remote clients cannot write to ephemeral SSH test sessions", async () => {
    const f = await startFixture();
    const ws = await connect(f, {});
    send(ws, { type: "terminal:input", sessionId: "ssh-test:private", data: "whoami\n" });
    send(ws, { type: "terminal:submit", sessionId: "ssh-test:private", text: "whoami" });
    send(ws, { type: "terminal:resize", sessionId: "ssh-test:private", cols: 80, rows: 24 });
    await settle();
    expect(f.called("writeToSession")).toEqual([]);
    expect(f.called("submitToSession")).toEqual([]);
    expect(f.called("resizeSession")).toEqual([]);
    ws.close();
  });

  test("terminal:submit drops invalid payloads", async () => {
    const f = await startFixture();
    const ws = await connect(f, {});
    send(ws, { type: "terminal:submit", sessionId: "ws-home:a", text: 7 });
    await settle();
    expect(f.called("submitToSession")).toEqual([]);
    ws.close();
  });

  test("a mobile session cannot type into or resize another profile's session", async () => {
    const f = await startFixture();
    const ws = await connect(f, { cookie: await f.mobileCookie() });
    send(ws, { type: "terminal:input", sessionId: "ws-work:a", data: "\u0003" });
    send(ws, { type: "terminal:submit", sessionId: "ws-work:a", text: "blocked" });
    send(ws, { type: "terminal:resize", sessionId: "ws-work:a", cols: 80, rows: 24 });
    send(ws, { type: "terminal:input", sessionId: "ws-home:a", data: "pwd\n" });
    send(ws, { type: "terminal:submit", sessionId: "ws-home:a", text: "allowed" });
    await settle();
    expect(f.called("writeToSession").map((c) => c.args[0])).toEqual(["ws-home:a"]);
    expect(f.called("submitToSession").map((c) => c.args[0])).toEqual(["ws-home:a"]);
    expect(f.called("resizeSession")).toEqual([]);
    ws.close();
  });

  test("an unbound socket (master token, no client id) keeps reaching every session", async () => {
    const f = await startFixture();
    const ws = await connect(f, {});
    send(ws, { type: "terminal:input", sessionId: "ws-work:a", data: "echo\n" });
    await settle();
    expect(f.called("writeToSession").map((c) => c.args[0])).toEqual(["ws-work:a"]);
    ws.close();
  });

  test("docker shell write/resize: refused for a mobile session, unchanged for other clients", async () => {
    const f = await startFixture();
    const phone = await connect(f, { cookie: await f.mobileCookie() });
    send(phone, { type: "docker:shell:write", sessionId: "shell-1", data: "id\n" });
    send(phone, { type: "docker:shell:resize", sessionId: "shell-1", cols: 80, rows: 24 });
    await settle();
    expect(f.called("dockerShellWrite")).toEqual([]);
    expect(f.called("dockerShellResize")).toEqual([]);
    phone.close();

    const browser = await connect(f, { clientId: "home-tab", profileId: "home" });
    send(browser, { type: "docker:shell:write", sessionId: "shell-1", data: "id\n" });
    send(browser, { type: "docker:shell:resize", sessionId: "shell-1", cols: 80, rows: 24 });
    await settle();
    expect(f.called("dockerShellWrite")).toHaveLength(1);
    expect(f.called("dockerShellResize")).toHaveLength(1);
    browser.close();
  });
});

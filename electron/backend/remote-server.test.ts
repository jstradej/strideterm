import { describe, expect, test } from "vitest";
import net from "node:net";
import { WebSocket } from "ws";
import {
  REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS,
  REMOTE_BLOCKED_TOP_LEVEL_FIELDS,
  buildSessionCookieAttrs,
  createRemoteTelemetry,
  drainTelemetryTransition,
  makeStateCoalescer,
  sanitizeSettingsFromRemote,
  socketStallDecision,
  startRemoteServer,
  stripSecretsForRemote,
  terminalBackpressureDecision,
} from "./remote-server.js";

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

describe("sanitizeSettingsFromRemote", () => {
  test("drops every blocked remoteAccess field", () => {
    const settings = {
      remoteAccess: {
        autoTunnel: true,
        cloudflaredPath: "/tmp/evil.sh",
        enabled: false,
        host: "0.0.0.0",
        port: 1234,
        token: "attacker-chosen",
        customPublicUrl: "https://my.tunnel.example",
        someUnknownFutureField: "kept",
      },
      logLevel: "debug",
    };
    const removed = sanitizeSettingsFromRemote(settings as Record<string, unknown>);
    expect(removed.sort()).toEqual([...REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS].sort());
    // Only the non-blocked extra field survives.
    expect(settings.remoteAccess).toEqual({ someUnknownFutureField: "kept" });
    // Non-remoteAccess settings are untouched.
    expect(settings.logLevel).toBe("debug");
  });

  test("REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS includes autoTunnel", () => {
    // Defensive — invariant M1/S1 ("any remoteAccess field affecting process
    // spawn is blocklisted") is enforced by this entry being present. An
    // attacker who can flip autoTunnel via /api/settings/update gets quiet
    // persistence of the Cloudflare tunnel across desktop restarts. If a
    // future refactor accidentally removes the entry, this test fires
    // before the multi-transport gap reopens.
    expect(REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS).toContain("autoTunnel");
  });

  test("is a no-op when remoteAccess is missing", () => {
    const settings = { logLevel: "info" };
    const removed = sanitizeSettingsFromRemote(settings as Record<string, unknown>);
    expect(removed).toEqual([]);
    expect(settings).toEqual({ logLevel: "info" });
  });

  test("is a no-op when remoteAccess is not an object", () => {
    const settings = { remoteAccess: "not-a-record" };
    const removed = sanitizeSettingsFromRemote(settings as unknown as Record<string, unknown>);
    expect(removed).toEqual([]);
  });

  test("only removes the blocked keys — non-blocked fields stay", () => {
    const settings = {
      remoteAccess: {
        cloudflaredPath: "/should/be/removed",
        customPublicUrl: "/should/be/removed/too",
        someFutureField: "stays",
      },
    };
    sanitizeSettingsFromRemote(settings as Record<string, unknown>);
    expect(settings.remoteAccess).toEqual({
      someFutureField: "stays",
    });
  });

  test("drops the externalPathOpener subtree wholesale", () => {
    // A leaked-token attacker repointing this would turn the desktop user's
    // next path-link click in xterm output into arbitrary code execution
    // (see REMOTE_BLOCKED_TOP_LEVEL_FIELDS comment in remote-server.ts).
    // Both `mode` and `command` are part of the spawn chain — flipping
    // mode to "command" is half the exploit by itself — so the whole
    // subtree is dropped, not just `command`.
    const settings = {
      externalPathOpener: {
        mode: "command",
        command: "powershell -c <evil>",
      },
      logLevel: "debug",
    };
    const removed = sanitizeSettingsFromRemote(settings as Record<string, unknown>);
    expect(removed).toContain("externalPathOpener");
    expect(settings).not.toHaveProperty("externalPathOpener");
    expect(settings.logLevel).toBe("debug");
  });

  test("drops top-level + remoteAccess fields in one pass", () => {
    const settings = {
      externalPathOpener: { mode: "command", command: "/tmp/evil.sh" },
      remoteAccess: { cloudflaredPath: "/tmp/also-evil", enabled: true, someFutureField: "stays" },
      theme: "dark",
    };
    const removed = sanitizeSettingsFromRemote(settings as Record<string, unknown>);
    expect(removed.sort()).toEqual(["cloudflaredPath", "enabled", "externalPathOpener"].sort());
    expect(settings).not.toHaveProperty("externalPathOpener");
    expect(settings.remoteAccess).toEqual({ someFutureField: "stays" });
    expect(settings.theme).toBe("dark");
  });

  test("REMOTE_BLOCKED_TOP_LEVEL_FIELDS includes externalPathOpener", () => {
    // Defensive — invariant S1 ("any user-configurable binary path pattern
    // automatically belongs in the remote blocklist") is enforced by this
    // entry being present. If a future refactor accidentally removes it,
    // this test fires before the multi-transport gap reopens.
    expect(REMOTE_BLOCKED_TOP_LEVEL_FIELDS).toContain("externalPathOpener");
  });

  test("drops externalEditor — same spawn-chain threat as externalPathOpener", () => {
    // `externalEditor` is the simple-field variant of the same primitive:
    // desktop spawns this binary with the clicked file path as the final
    // argv slot on every terminal path-link click. A remote caller
    // repointing it to a smuggled-in binary path is identical RCE.
    const settings = {
      externalEditor: "C:\\Users\\me\\evil.exe",
      theme: "dark",
    };
    const removed = sanitizeSettingsFromRemote(settings as Record<string, unknown>);
    expect(removed).toContain("externalEditor");
    expect(settings).not.toHaveProperty("externalEditor");
    expect(settings.theme).toBe("dark");
  });

  test("REMOTE_BLOCKED_TOP_LEVEL_FIELDS includes externalEditor", () => {
    expect(REMOTE_BLOCKED_TOP_LEVEL_FIELDS).toContain("externalEditor");
  });

  test("drops terminalFontSizeLocal but passes terminalFontSizeRemote through", () => {
    const settings = {
      terminalFontSizeLocal: 18,
      terminalFontSizeRemote: 16,
      theme: "dark",
    };
    const removed = sanitizeSettingsFromRemote(settings as Record<string, unknown>);
    expect(removed).toContain("terminalFontSizeLocal");
    expect(settings).not.toHaveProperty("terminalFontSizeLocal");
    // Remote clients are allowed to set their own font size.
    expect((settings as Record<string, unknown>).terminalFontSizeRemote).toBe(16);
    expect((settings as Record<string, unknown>).theme).toBe("dark");
  });

  test("REMOTE_BLOCKED_TOP_LEVEL_FIELDS includes terminalFontSizeLocal", () => {
    expect(REMOTE_BLOCKED_TOP_LEVEL_FIELDS).toContain("terminalFontSizeLocal");
  });

  test("drops clipboardImagePasteDir — remote must not repoint desktop file writes", () => {
    const settings = {
      clipboardImagePasteDir: "C:\\Users\\victim\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
      theme: "dark",
    };
    const removed = sanitizeSettingsFromRemote(settings as Record<string, unknown>);
    expect(removed).toContain("clipboardImagePasteDir");
    expect(settings).not.toHaveProperty("clipboardImagePasteDir");
    expect((settings as Record<string, unknown>).theme).toBe("dark");
  });

  test("REMOTE_BLOCKED_TOP_LEVEL_FIELDS includes clipboardImagePasteDir", () => {
    expect(REMOTE_BLOCKED_TOP_LEVEL_FIELDS).toContain("clipboardImagePasteDir");
  });
});

describe("stripSecretsForRemote", () => {
  test("zeros the master token in a runtime payload", () => {
    const payload = {
      appState: {
        settings: {
          remoteAccess: {
            enabled: true,
            host: "0.0.0.0",
            port: 43123,
            token: "super-secret-master-token",
            customPublicUrl: "",
            cloudflaredPath: "",
          },
          logLevel: "info",
        },
      },
      remoteAccess: { enabled: true, urls: ["http://1.2.3.4:43123/?token=super-secret-master-token"] },
    };
    const stripped = stripSecretsForRemote(payload) as typeof payload;
    expect(stripped.appState.settings.remoteAccess.token).toBe("");
    // Non-token fields untouched.
    expect(stripped.appState.settings.remoteAccess.host).toBe("0.0.0.0");
    expect(stripped.appState.settings.logLevel).toBe("info");
    // Original is untouched (immutable strip).
    expect(payload.appState.settings.remoteAccess.token).toBe("super-secret-master-token");
  });

  test("passes through bodies that don't carry the secret", () => {
    expect(stripSecretsForRemote({ ok: true })).toEqual({ ok: true });
    expect(stripSecretsForRemote(null)).toBeNull();
    expect(stripSecretsForRemote(undefined)).toBeUndefined();
    expect(stripSecretsForRemote("string body")).toBe("string body");
    expect(stripSecretsForRemote({ error: "Not found" })).toEqual({ error: "Not found" });
  });

  test("passes through partial payload shapes", () => {
    const partial = { appState: { settings: { logLevel: "info" } } };
    expect(stripSecretsForRemote(partial)).toEqual(partial);
  });

  test("zeros the master token in a NESTED result envelope (mutation/verification results)", () => {
    // Git/docker ops return `{ ok, payload: <full state> }`. Top-level-only
    // stripping missed the nested state, so a v1 nested mutation response leaked
    // the master token (#7/#29/#67). It must be stripped here too.
    const envelope = {
      ok: true,
      result: { reclaimed: "1MB" },
      payload: {
        appState: { settings: { remoteAccess: { enabled: true, token: "super-secret-master-token" } } },
      },
    };
    const stripped = stripSecretsForRemote(envelope) as typeof envelope;
    expect(stripped.payload.appState.settings.remoteAccess.token).toBe("");
    // Envelope fields are preserved.
    expect(stripped.ok).toBe(true);
    expect(stripped.result).toEqual({ reclaimed: "1MB" });
    // Original untouched (immutable strip).
    expect(envelope.payload.appState.settings.remoteAccess.token).toBe("super-secret-master-token");
    // No stray copy of the token survives anywhere in the serialized result.
    expect(JSON.stringify(stripped)).not.toContain("super-secret-master-token");
  });
});

describe("buildSessionCookieAttrs", () => {
  test("omits Secure on plain HTTP (no x-forwarded-proto)", () => {
    expect(buildSessionCookieAttrs({})).toBe("HttpOnly; SameSite=Strict; Path=/");
  });

  test("omits Secure when x-forwarded-proto is http", () => {
    expect(buildSessionCookieAttrs({ "x-forwarded-proto": "http" })).toBe("HttpOnly; SameSite=Strict; Path=/");
  });

  test("appends Secure when x-forwarded-proto is https (Cloudflare tunnel)", () => {
    expect(buildSessionCookieAttrs({ "x-forwarded-proto": "https" })).toBe("HttpOnly; SameSite=Strict; Path=/; Secure");
  });

  test("respects only the first proto in a comma-separated chain", () => {
    // Some proxies append; the originating client-facing proto is the first.
    expect(buildSessionCookieAttrs({ "x-forwarded-proto": "https, http" })).toBe(
      "HttpOnly; SameSite=Strict; Path=/; Secure",
    );
    expect(buildSessionCookieAttrs({ "x-forwarded-proto": "http, https" })).toBe("HttpOnly; SameSite=Strict; Path=/");
  });

  test("is case-insensitive", () => {
    expect(buildSessionCookieAttrs({ "x-forwarded-proto": "HTTPS" })).toBe("HttpOnly; SameSite=Strict; Path=/; Secure");
  });
});

describe("remote token client profile context", () => {
  test("keeps profile activation scoped to the token client id", async () => {
    const port = await getFreePort();
    const auth = "test-token";
    const payload = {
      appState: {
        settings: {
          remoteAccess: { enabled: true, host: "127.0.0.1", port, token: auth },
        },
        profiles: [
          { id: "p1", name: "P1", color: "#fff", workspaceIds: [] },
          { id: "p2", name: "P2", color: "#fff", workspaceIds: [] },
        ],
        workspaces: [
          { id: "ws1", name: "WS1", profileId: "p1", panels: [{ id: "a" }, { id: "b" }] },
          { id: "ws2", name: "WS2", profileId: "p2", panels: [{ id: "a" }, { id: "b" }] },
        ],
        windowSlots: [
          { id: "win-1", profileId: "p1", activeWorkspaceId: "ws1" },
          { id: "win-2", profileId: "p2", activeWorkspaceId: "ws2" },
        ],
      },
    };
    // Minimal runtime mock that mirrors the real activate-for-remote-client
    // wiring: the server hands its registry over via setRemoteClientRegistry
    // and the runtime mutates the client context through it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let registryRef: any = null;
    const runtime = {
      getPayload: () => payload,
      getInitialState: async () => payload,
      setRemoteInfo: () => undefined,
      listRemoteUrls: () => [],
      on: () => () => undefined,
      writeToSession: () => undefined,
      resizeSession: () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setRemoteClientRegistry: (registry: any) => {
        registryRef = registry;
      },
      async activateProfileForRemoteClient(clientId: string, profileId: string) {
        registryRef.activateProfile(clientId, profileId, payload.appState);
        return registryRef.composePayload(clientId, payload);
      },
    };
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = {
      Authorization: `Bearer ${auth}`,
      "X-Strideterm-Client-Id": "mobile-client-a",
    };

    try {
      const initial = (await (await fetch(`${baseUrl}/api/state`, { headers })).json()) as {
        remoteClient?: { profileId?: string; activeWorkspaceId?: string };
      };
      expect(initial.remoteClient).toMatchObject({ profileId: "p1", activeWorkspaceId: "ws1" });

      const activated = (await (
        await fetch(`${baseUrl}/api/remote-client/profile/activate`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ profileId: "p2" }),
        })
      ).json()) as { remoteClient?: { profileId?: string; activeWorkspaceId?: string } };
      expect(activated.remoteClient).toMatchObject({ profileId: "p2", activeWorkspaceId: "ws2" });

      const sameClient = (await (await fetch(`${baseUrl}/api/state`, { headers })).json()) as {
        remoteClient?: { profileId?: string; activeWorkspaceId?: string };
      };
      expect(sameClient.remoteClient).toMatchObject({ profileId: "p2", activeWorkspaceId: "ws2" });

      const otherClient = (await (
        await fetch(`${baseUrl}/api/state`, {
          headers: { Authorization: `Bearer ${auth}`, "X-Strideterm-Client-Id": "mobile-client-b" },
        })
      ).json()) as { remoteClient?: { profileId?: string; activeWorkspaceId?: string } };
      expect(otherClient.remoteClient).toMatchObject({ profileId: "p1", activeWorkspaceId: "ws1" });
    } finally {
      await server.close();
    }
  });

  test("remote azure/github refresh return a per-client composed payload (no raw desktop payload)", async () => {
    // Regression: /api/azure/refresh and /api/github/refresh returned the RAW
    // global payload (no `remoteClient`), so the mobile client snapped its view
    // to the desktop's active workspace, then snapped back on the next composed
    // WS broadcast — a network-paced flip-flop. The responses must be composed.
    const port = await getFreePort();
    const auth = "test-token";
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: auth } },
        profiles: [
          { id: "p1", name: "P1", color: "#fff", workspaceIds: [] },
          { id: "p2", name: "P2", color: "#fff", workspaceIds: [] },
        ],
        workspaces: [
          { id: "ws1", name: "WS1", profileId: "p1", panels: [{ id: "a" }, { id: "b" }] },
          { id: "ws2", name: "WS2", profileId: "p2", panels: [{ id: "a" }, { id: "b" }] },
        ],
        windowSlots: [
          { id: "win-1", profileId: "p1", activeWorkspaceId: "ws1" },
          { id: "win-2", profileId: "p2", activeWorkspaceId: "ws2" },
        ],
      },
    };
    const runtime = {
      getPayload: () => payload,
      getInitialState: async () => payload,
      setRemoteInfo: () => undefined,
      listRemoteUrls: () => [],
      on: () => () => undefined,
      writeToSession: () => undefined,
      resizeSession: () => undefined,
      setRemoteClientRegistry: () => undefined,
      // Both return the full global payload; the server must compose per-client.
      refreshAzureState: async () => payload,
      refreshGitHubState: async () => payload,
      markAzurePullRequestSeen: async () => payload,
      markGitHubPullRequestSeen: async () => payload,
    };
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = {
      Authorization: `Bearer ${auth}`,
      "X-Strideterm-Client-Id": "mobile-client-a",
      "Content-Type": "application/json",
    };
    try {
      const azure = (await (
        await fetch(`${baseUrl}/api/azure/refresh`, { method: "POST", headers, body: "{}" })
      ).json()) as { remoteClient?: { profileId?: string; activeWorkspaceId?: string } };
      // Composed → carries this client's own context, not a bare desktop payload.
      expect(azure.remoteClient).toMatchObject({ profileId: "p1", activeWorkspaceId: "ws1" });

      const github = (await (
        await fetch(`${baseUrl}/api/github/refresh`, { method: "POST", headers, body: "{}" })
      ).json()) as { remoteClient?: { profileId?: string } };
      expect(github.remoteClient).toMatchObject({ profileId: "p1" });

      const azureSeen = (await (
        await fetch(`${baseUrl}/api/azure/pull-request/seen`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prKey: "ado:repo:1" }),
        })
      ).json()) as { remoteClient?: { profileId?: string; activeWorkspaceId?: string } };
      expect(azureSeen.remoteClient).toMatchObject({ profileId: "p1", activeWorkspaceId: "ws1" });

      const githubSeen = (await (
        await fetch(`${baseUrl}/api/github/pull-request/seen`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prKey: "gh:repo:1" }),
        })
      ).json()) as { remoteClient?: { profileId?: string; activeWorkspaceId?: string } };
      expect(githubSeen.remoteClient).toMatchObject({ profileId: "p1", activeWorkspaceId: "ws1" });
    } finally {
      await server.close();
    }
  });

  test("bootstraps token client from profileId query parameter when that profile is open", async () => {
    const port = await getFreePort();
    const auth = "test-token";
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: auth } },
        profiles: [
          { id: "p1", name: "P1", color: "#fff", workspaceIds: [] },
          { id: "p2", name: "P2", color: "#fff", workspaceIds: [] },
        ],
        workspaces: [
          { id: "ws1", name: "WS1", profileId: "p1", panels: [{ id: "a" }, { id: "b" }] },
          { id: "ws2", name: "WS2", profileId: "p2", panels: [{ id: "a" }, { id: "b" }] },
        ],
        windowSlots: [
          { id: "win-1", profileId: "p1", activeWorkspaceId: "ws1" },
          { id: "win-2", profileId: "p2", activeWorkspaceId: "ws2" },
        ],
      },
    };
    const runtime = {
      getPayload: () => payload,
      getInitialState: async () => payload,
      setRemoteInfo: () => undefined,
      listRemoteUrls: () => [],
      on: () => () => undefined,
      writeToSession: () => undefined,
      resizeSession: () => undefined,
      setRemoteClientRegistry: () => undefined,
    };
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });

    try {
      const initial = (await (
        await fetch(`http://127.0.0.1:${port}/api/state?profileId=p2`, {
          headers: { Authorization: `Bearer ${auth}`, "X-Strideterm-Client-Id": "mobile-client-c" },
        })
      ).json()) as { remoteClient?: { profileId?: string; activeWorkspaceId?: string } };
      expect(initial.remoteClient).toMatchObject({ profileId: "p2", activeWorkspaceId: "ws2" });
    } finally {
      await server.close();
    }
  });
});

describe("workspace delete endpoint validation", () => {
  function makeMinimalRuntime(auth: string, port: number) {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: auth } },
        profiles: [{ id: "default", name: "Default" }],
        workspaces: [{ id: "ws-1", name: "WS1", profileId: "default", panels: [] }],
        windowSlots: [{ id: "win-1", profileId: "default", activeWorkspaceId: "ws-1" }],
      },
    };
    return {
      getPayload: () => payload,
      getInitialState: async () => payload,
      setRemoteInfo: () => undefined,
      listRemoteUrls: () => [],
      on: () => () => undefined,
      writeToSession: () => undefined,
      resizeSession: () => undefined,
      setRemoteClientRegistry: () => undefined,
      deleteWorkspace: async () => payload,
    };
  }

  // Uses the slot-aware delete route (requires a client-id to bind a window session).
  const clientHeaders = (auth: string) => ({
    Authorization: `Bearer ${auth}`,
    "Content-Type": "application/json",
    "X-Strideterm-Client-Id": "test-client",
  });

  test("POST /api/workspace/delete with invalid options (wrong type) returns 400", async () => {
    const port = await getFreePort();
    const auth = "test-token-del";
    const runtime = makeMinimalRuntime(auth, port);
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/workspace/delete`, {
        method: "POST",
        headers: clientHeaders(auth),
        body: JSON.stringify({ workspaceId: "ws-1", diskPath: 123 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/IPC validation failed/);
    } finally {
      await server.close();
    }
  });

  test("POST /api/workspace/delete with valid body returns 200", async () => {
    const port = await getFreePort();
    const auth = "test-token-del-ok";
    const runtime = makeMinimalRuntime(auth, port);
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/workspace/delete`, {
        method: "POST",
        headers: clientHeaders(auth),
        body: JSON.stringify({ workspaceId: "ws-1" }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe("terminal streaming — subscription routing + backpressure", () => {
  // Runtime mock that captures event handlers so a test can drive terminal:data
  // / terminal:exit emissions, and serves per-session replay snapshots.
  // `initialStateDelayMs` simulates the real runtime's slow getInitialState
  // (git/docker refreshes) — needed to prove a subscribe arriving during that
  // window is not dropped.
  function makeStreamingRuntime(auth: string, port: number, opts: { initialStateDelayMs?: number } = {}) {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: auth } },
        profiles: [
          { id: "p1", name: "P1", color: "#fff", workspaceIds: [] },
          { id: "p2", name: "P2", color: "#fff", workspaceIds: [] },
        ],
        workspaces: [
          { id: "ws1", name: "WS1", profileId: "p1", panels: [{ id: "a" }, { id: "b" }] },
          { id: "ws2", name: "WS2", profileId: "p2", panels: [{ id: "a" }, { id: "b" }] },
        ],
        // p1 is the first open desktop profile → fallback binding for token clients.
        windowSlots: [
          { id: "win-1", profileId: "p1", activeWorkspaceId: "ws1" },
          { id: "win-2", profileId: "p2", activeWorkspaceId: "ws2" },
        ],
      },
      // Heavy domains so the slim-core contract has something to strip. A single
      // shared object mutated in place by _bumpGit so revision changes are
      // observable to the interest/invalidate path.
      git: {
        connections: [],
        workspaces: {
          ws1: {
            available: true,
            branch: "main",
            dirty: false,
            dirtyCount: 0,
            lastChangeAt: "2026-07-15T10:00:00Z",
            lastUpdatedAt: "2026-07-15T10:00:00Z",
            log: [{ subject: "HEAVY-GIT-LOG-ENTRY".repeat(20) }],
            roots: { "/repo": {} },
          },
          ws2: { available: true, branch: "dev", dirty: false, dirtyCount: 0, lastUpdatedAt: "z", log: [] },
        },
        activeWorkspace: null,
      },
      azureDevops: {
        connections: [{ id: "az1", profileId: "p1" }],
        inbox: { needsMyReview: [{ prKey: "azure:pr1", connectionId: "az1" }], needsAttention: [] },
        pullRequests: { "azure:pr1": { prKey: "azure:pr1", profileId: "p1", threads: ["HEAVY-THREAD".repeat(20)] } },
        reviewActivity: [],
        sync: {},
      },
      github: {
        connections: [],
        inbox: {},
        pullRequests: { "gh:pr1": { prKey: "gh:pr1", profileId: "p1" } },
        reviewActivity: [],
        sync: {},
      },
      reviewBridge: {
        agentPrompts: [{ promptId: "ap1", title: "Prompt", updatedAt: "2026-07-15T10:00:00Z" }],
        pullRequests: {},
      },
      docker: {
        available: true,
        lastUpdatedAt: "2026-07-15T12:00:00Z",
        containers: [{ ID: "c1", State: "running" }],
        images: [{ ID: "HEAVY-IMAGE" }],
        volumes: [],
        networks: [],
        backends: [],
        contexts: [],
        lazydocker: {},
      },
    };
    const handlers: Record<string, ((p: unknown) => void)[]> = {};
    const replay = new Map<string, { data: string; throughSeq: number }>();
    // Fired the instant the server snapshots a session's replay inside the
    // subscribe critical section — lets a test inject a live frame at exactly
    // that point to guard the no-`await`-before-set-add ordering invariant.
    let onSnapshot: ((sessionId: string) => void) | null = null;
    // Records the viewer id each per-PR review mutation received, so a test can
    // prove they are now routed through the profile-bound viewer path (#62).
    const azureMutationCalls: { method: string; prKey?: string; windowId?: string }[] = [];
    // Same, for git conflict-resolution ops now routed through slotAwareRoute.
    const gitConflictCalls: { method: string; workspaceId?: string; windowId?: string }[] = [];
    // Same, for the PR mutations moved into slotAwareRoute this round: azure/github
    // mark-seen, github comment/review and review-bridge sync (#32/#58/#63).
    const prMutationCalls: { method: string; prKey?: string; windowId?: string }[] = [];
    const runtime = {
      getPayload: () => payload,
      _azureMutationCalls: azureMutationCalls,
      _gitConflictCalls: gitConflictCalls,
      _prMutationCalls: prMutationCalls,
      // Mark-seen / github comment+review / review-bridge sync are now viewer-bound:
      // each records the windowId it received so a test can assert it is a
      // `remote:` viewer id (was a viewerless global path).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      markAzurePullRequestSeen: async (prKey: any, windowId?: string) => {
        prMutationCalls.push({ method: "azure-seen", prKey, windowId });
        return payload;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      markGitHubPullRequestSeen: async (prKey: any, windowId?: string) => {
        prMutationCalls.push({ method: "github-seen", prKey, windowId });
        return payload;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commentGitHubPullRequest: async (p: any, windowId?: string) => {
        prMutationCalls.push({ method: "github-comment", prKey: p?.prKey, windowId });
        return payload;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      submitGitHubPullRequestReview: async (p: any, windowId?: string) => {
        prMutationCalls.push({ method: "github-review", prKey: p?.prKey, windowId });
        return payload;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      syncReviewBridgePullRequest: async (p: any, windowId?: string) => {
        prMutationCalls.push({ method: "review-sync", prKey: p?.prKey, windowId });
        return payload;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rerunAzureCheck: async (prKey: any, _checkItem: any, windowId?: string) => {
        prMutationCalls.push({ method: "azure-rerun", prKey, windowId });
        return payload;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rerunGitHubCheck: async (prKey: any, _checkItem: any, windowId?: string) => {
        prMutationCalls.push({ method: "github-rerun", prKey, windowId });
        return payload;
      },
      // Agent-prompt reset returns the full payload (a v2 client gets an ack that
      // NAMES the agent-prompts resource so the mounted review pane refetches it).
      resetAgentPrompts: async () => payload,
      // Docker refresh — a full-payload result a v2 client must receive as an ack.
      refreshDockerState: async () => payload,
      // Conflict-resolution ops record the viewer id (windowId) they received so a
      // test can prove they are now profile-bound (was a viewerless global path).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gitSkipCommit: async (p: any, windowId?: string) => {
        gitConflictCalls.push({ method: "skip", workspaceId: p?.workspaceId, windowId });
        return { ok: true, payload };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gitResolveConflict: async (p: any, windowId?: string) => {
        gitConflictCalls.push({ method: "resolve", workspaceId: p?.workspaceId, windowId });
        return { ok: true, payload };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gitListConflicts: async (p: any, windowId?: string) => {
        gitConflictCalls.push({ method: "list", workspaceId: p?.workspaceId, windowId });
        return { ok: true, conflicts: [] };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commentAzurePullRequest: async (p: any, windowId?: string) => {
        azureMutationCalls.push({ method: "comment", prKey: p?.prKey, windowId });
        return payload;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateAzureThreadStatus: async (p: any, windowId?: string) => {
        azureMutationCalls.push({ method: "thread", prKey: p?.prKey, windowId });
        return payload;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      voteAzurePullRequest: async (p: any, windowId?: string) => {
        azureMutationCalls.push({ method: "vote", prKey: p?.prKey, windowId });
        return payload;
      },
      // A NAVIGATION mutation the renderer adopts synchronously — returns the
      // full payload, which a v2 client must receive as the slim CORE (not an ack).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      saveWorkspace: async (_ws: any, _windowId?: string) => payload,
      getInitialState: async () => {
        if (opts.initialStateDelayMs) {
          await new Promise((r) => setTimeout(r, opts.initialStateDelayMs));
        }
        return payload;
      },
      setRemoteInfo: () => undefined,
      listRemoteUrls: () => [],
      on: (channel: string, handler: (p: unknown) => void) => {
        (handlers[channel] ||= []).push(handler);
        return () => undefined;
      },
      writeToSession: () => undefined,
      resizeSession: () => undefined,
      setRemoteClientRegistry: () => undefined,
      // A mutation-shaped result: a runtime method that wraps the full payload
      // under `.payload` (git ops return `{ ok, payload }`). The adapter must
      // slim the NESTED payload, not just top-level ones.
      refreshGitState: async () => ({ ok: true, payload }),
      getTerminalReplaySnapshot: (sessionId: string) => {
        const snap = replay.get(sessionId) || { data: "", throughSeq: 0 };
        onSnapshot?.(sessionId);
        return snap;
      },
      // test hooks
      _onSnapshot: (fn: (sessionId: string) => void) => {
        onSnapshot = fn;
      },
      _emit: (channel: string, p: unknown) => (handlers[channel] || []).forEach((h) => h(p)),
      _setReplay: (sessionId: string, data: string, throughSeq: number) => replay.set(sessionId, { data, throughSeq }),
      _setWorkspaceProfile: (workspaceId: string, profileId: string) => {
        const ws = payload.appState.workspaces.find((w) => w.id === workspaceId);
        if (ws) ws.profileId = profileId;
      },
      _removePanel: (workspaceId: string, panelId: string) => {
        const ws = payload.appState.workspaces.find((w) => w.id === workspaceId);
        if (ws) ws.panels = ws.panels.filter((p) => p.id !== panelId);
      },
      _addPanel: (workspaceId: string, panelId: string) => {
        const ws = payload.appState.workspaces.find((w) => w.id === workspaceId);
        if (ws && !ws.panels.some((p) => p.id === panelId)) ws.panels.push({ id: panelId });
      },
      // Bump a git workspace's revision so the interest/invalidate path fires.
      _bumpGit: (workspaceId: string, ts: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const snap = (payload as any).git.workspaces[workspaceId];
        if (snap) snap.lastUpdatedAt = ts;
      },
    };
    return runtime;
  }

  type WsClient = {
    ws: WebSocket;
    messages: { type: string; payload?: unknown }[];
    opened: Promise<void>;
    closeCode: () => number | null;
  };

  function connectWs(
    port: number,
    auth: string,
    clientId: string,
    profileId?: string,
    sp?: number,
    opts?: { caps?: string; rev?: number },
  ): WsClient {
    const q = new URLSearchParams({ token: auth, clientId });
    if (profileId) q.set("profileId", profileId);
    if (sp) q.set("sp", String(sp));
    if (opts?.caps !== undefined) q.set("caps", opts.caps);
    if (opts?.rev !== undefined) q.set("rev", String(opts.rev));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${q.toString()}`);
    const messages: { type: string; payload?: unknown }[] = [];
    let code: number | null = null;
    ws.on("message", (raw: Buffer) => {
      try {
        messages.push(JSON.parse(raw.toString()));
      } catch {
        // ignore non-JSON
      }
    });
    ws.on("close", (c: number) => {
      code = c;
    });
    const opened = new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    return { ws, messages, opened, closeCode: () => code };
  }

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function waitUntil(fn: () => boolean, timeout = 1500): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (fn()) return true;
      await delay(10);
    }
    return fn();
  }

  const terminalFrames = (c: WsClient) =>
    c.messages.filter((m) => m.type === "terminal:data" || m.type === "terminal:replay");
  type FramePayload = { sessionId?: string; data?: string; throughSeq?: number };
  const framePayload = (m: { payload?: unknown }): FramePayload => (m.payload || {}) as FramePayload;

  async function withServer(
    auth: string,
    run: (ctx: {
      port: number;
      runtime: ReturnType<typeof makeStreamingRuntime>;
      server: Awaited<ReturnType<typeof startRemoteServer>>;
    }) => Promise<void>,
    opts: {
      initialStateDelayMs?: number;
      congestionCloseGraceMs?: number;
      socketStallGraceMs?: number;
      socketStallSweepMs?: number;
      socketBufferedAmount?: (socket: WebSocket) => number;
    } = {},
  ): Promise<void> {
    const port = await getFreePort();
    const runtime = makeStreamingRuntime(auth, port, opts);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      congestionCloseGraceMs: opts.congestionCloseGraceMs,
      socketStallGraceMs: opts.socketStallGraceMs,
      socketStallSweepMs: opts.socketStallSweepMs,
      socketBufferedAmount: opts.socketBufferedAmount as ((socket: import("ws").WebSocket) => number) | undefined,
    });
    try {
      await run({ port, runtime, server });
    } finally {
      await server.close();
    }
  }

  test("legacy socket (never subscribes) receives the full terminal broadcast", async () => {
    await withServer("tok-legacy", async ({ port, runtime }) => {
      const c = connectWs(port, "tok-legacy", "legacy-a");
      await c.opened;
      await delay(30);
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: "hello", seq: 1 });
      expect(await waitUntil(() => terminalFrames(c).some((m) => framePayload(m).data === "hello"))).toBe(true);
      c.ws.close();
    });
  });

  test("empty subscription (filtered) receives no terminal frames", async () => {
    await withServer("tok-empty", async ({ port, runtime }) => {
      const c = connectWs(port, "tok-empty", "empty-aa");
      await c.opened;
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: [] }));
      await delay(50);
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: "hidden", seq: 1 });
      await delay(80);
      expect(terminalFrames(c)).toHaveLength(0);
      c.ws.close();
    });
  });

  test("filtered socket receives only its subscribed sessions", async () => {
    await withServer("tok-filter", async ({ port, runtime }) => {
      const c = connectWs(port, "tok-filter", "filter-a");
      await c.opened;
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      await delay(50);
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: "mine", seq: 1 });
      runtime._emit("terminal:data", { sessionId: "ws1:b", data: "notmine", seq: 1 });
      await delay(80);
      const datas = terminalFrames(c).map((m) => framePayload(m).data);
      expect(datas).toContain("mine");
      expect(datas).not.toContain("notmine");
      c.ws.close();
    });
  });

  test("two filtered sockets each receive only their own session", async () => {
    await withServer("tok-two", async ({ port, runtime }) => {
      const a = connectWs(port, "tok-two", "two-aaaa");
      const b = connectWs(port, "tok-two", "two-bbbb");
      await Promise.all([a.opened, b.opened]);
      a.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      b.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:b"] }));
      await delay(60);
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: "for-a", seq: 1 });
      runtime._emit("terminal:data", { sessionId: "ws1:b", data: "for-b", seq: 1 });
      await delay(80);
      // Only live data frames here — a fresh subscribe also delivers a (here
      // empty) terminal:replay, which is exercised separately.
      const liveData = (c: WsClient) =>
        c.messages.filter((m) => m.type === "terminal:data").map((m) => framePayload(m).data);
      expect(liveData(a)).toEqual(["for-a"]);
      expect(liveData(b)).toEqual(["for-b"]);
      a.ws.close();
      b.ws.close();
    });
  });

  test("replay is delivered before the live frame that follows a subscribe", async () => {
    await withServer("tok-replay", async ({ port, runtime }) => {
      runtime._setReplay("ws1:a", "REPLAYED", 5);
      const c = connectWs(port, "tok-replay", "replay-a");
      await c.opened;
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      // Wait until the replay frame has actually arrived, THEN emit a live frame.
      expect(await waitUntil(() => c.messages.some((m) => m.type === "terminal:replay"))).toBe(true);
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: "LIVE", seq: 6 });
      expect(await waitUntil(() => terminalFrames(c).some((m) => m.type === "terminal:data"))).toBe(true);
      const frames = terminalFrames(c);
      const replayIdx = frames.findIndex((m) => m.type === "terminal:replay");
      const liveIdx = frames.findIndex((m) => m.type === "terminal:data");
      expect(replayIdx).toBeGreaterThanOrEqual(0);
      expect(liveIdx).toBeGreaterThan(replayIdx);
      expect(framePayload(frames[replayIdx]).data).toBe("REPLAYED");
      expect(framePayload(frames[replayIdx]).throughSeq).toBe(5);
      c.ws.close();
    });
  });

  test("a live frame racing the critical section still lands after replay (no-await invariant)", async () => {
    // Guards the load-bearing invariant: NO `await` between snapshotting replay
    // and adding the session to the live set. The moment the server snapshots
    // ws1:a we schedule a live frame as a microtask. In correct (synchronous)
    // code the handler finishes adding ws1:a to the live set before that
    // microtask runs, so the frame is routed and lands after the replay. If a
    // future `await` slips between snapshot and set-add, the microtask fires
    // while ws1:a is NOT yet subscribed → the live frame is dropped → a gap the
    // seq guard can't heal → this test fails.
    await withServer("tok-order2", async ({ port, runtime }) => {
      runtime._setReplay("ws1:a", "REPLAYED", 5);
      runtime._onSnapshot((sessionId) => {
        if (sessionId === "ws1:a") {
          queueMicrotask(() => runtime._emit("terminal:data", { sessionId: "ws1:a", data: "RACED", seq: 6 }));
        }
      });
      const c = connectWs(port, "tok-order2", "order2-a", "p1");
      await c.opened;
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      expect(await waitUntil(() => terminalFrames(c).some((m) => framePayload(m).data === "RACED"))).toBe(true);
      const frames = terminalFrames(c);
      const replayIdx = frames.findIndex((m) => m.type === "terminal:replay");
      const liveIdx = frames.findIndex((m) => framePayload(m).data === "RACED");
      expect(replayIdx).toBeGreaterThanOrEqual(0);
      expect(liveIdx).toBeGreaterThan(replayIdx);
      c.ws.close();
    });
  });

  test("repeating the same subscription does not re-send replay", async () => {
    await withServer("tok-idem", async ({ port, runtime }) => {
      runtime._setReplay("ws1:a", "ONCE", 1);
      const c = connectWs(port, "tok-idem", "idem-aaa");
      await c.opened;
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      expect(await waitUntil(() => c.messages.filter((m) => m.type === "terminal:replay").length === 1)).toBe(true);
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      await delay(80);
      expect(c.messages.filter((m) => m.type === "terminal:replay")).toHaveLength(1);
      c.ws.close();
    });
  });

  test("unsubscribing (subscribe to []) stops delivery immediately", async () => {
    await withServer("tok-unsub", async ({ port, runtime }) => {
      const c = connectWs(port, "tok-unsub", "unsub-aa");
      await c.opened;
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      await delay(50);
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: [] }));
      await delay(50);
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: "after-unsub", seq: 2 });
      await delay(80);
      expect(terminalFrames(c).some((m) => framePayload(m).data === "after-unsub")).toBe(false);
      c.ws.close();
    });
  });

  test("subscribing to a profile-inaccessible session is rejected as a whole", async () => {
    await withServer("tok-authz", async ({ port, runtime }) => {
      // Token client with no profileId → bound to the first open desktop profile (p1).
      const c = connectWs(port, "tok-authz", "authz-aa");
      await c.opened;
      // ws2 belongs to p2 → inaccessible. The whole request is rejected: the
      // socket stays filtered with an empty set, so no replay and no live frames.
      runtime._setReplay("ws2:a", "SECRET", 1);
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws2:a"] }));
      await delay(80);
      expect(c.messages.some((m) => m.type === "terminal:replay")).toBe(false);
      runtime._emit("terminal:data", { sessionId: "ws2:a", data: "SECRET-LIVE", seq: 2 });
      await delay(80);
      expect(terminalFrames(c)).toHaveLength(0);
      c.ws.close();
    });
  });

  test("a removed panel is pruned from an active subscription and needs a fresh replay on recreate", async () => {
    // Review F2: on panel removal the runtime emits terminal:removed. The server
    // must (a) drop the id from any socket already subscribed so live frames stop
    // even though the workspace — and thus the client's profile access — is
    // unchanged, (b) reject a resubscribe to the now-missing panel, and (c) treat
    // a recreated same-id panel as fresh, replaying again instead of skipping it
    // because the id "was already subscribed". Emitting state:updated {} is NOT
    // used to force the drop here: that only worked in the old test because
    // composePayload({}) corrupted the client's profile, masking the real cause.
    await withServer("tok-nopanel", async ({ port, runtime }) => {
      const c = connectWs(port, "tok-nopanel", "nopanel1", "p1");
      await c.opened;
      // Baseline: the panel exists → subscribe replays and the id is live.
      runtime._setReplay("ws1:a", "STILL-HERE", 1);
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      expect(await waitUntil(() => c.messages.some((m) => m.type === "terminal:replay"))).toBe(true);

      // Remove the panel exactly as production does: state loses the panel and the
      // runtime emits terminal:removed. ws1 stays in p1, so profile access is
      // untouched — the ONLY reason a later frame drops is the routing prune.
      runtime._removePanel("ws1", "a");
      runtime._emit("terminal:removed", { sessionId: "ws1:a" });
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: "GHOST-LIVE", seq: 2 });

      // Re-requesting the removed id is rejected as a whole → no new replay.
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      await delay(80);
      expect(c.messages.filter((m) => m.type === "terminal:replay")).toHaveLength(1); // only the baseline
      expect(terminalFrames(c).some((m) => framePayload(m).data === "GHOST-LIVE")).toBe(false);

      // Recreate the same panel id → a fresh subscribe must replay again. If the
      // id had lingered in the live set, this subscribe would skip replay.
      runtime._addPanel("ws1", "a");
      runtime._setReplay("ws1:a", "REBORN", 5);
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      expect(await waitUntil(() => c.messages.filter((m) => m.type === "terminal:replay").length === 2)).toBe(true);
      const replays = c.messages.filter((m) => m.type === "terminal:replay");
      expect(framePayload(replays[1]).data).toBe("REBORN");
      c.ws.close();
    });
  });

  test("terminal:removed prune notifies the subscribed socket only (finding 4)", async () => {
    // The server must tell a client that its id was pruned from the live routing
    // set. Otherwise a debounced remove+recreate of the SAME id leaves the
    // client's own subscription memory unchanged and it never re-subscribes — the
    // recreated pane's stream freezes. Only sockets that actually had the id are
    // notified; a socket that never subscribed hears nothing.
    await withServer("tok-rm-notify", async ({ port, runtime }) => {
      const subbed = connectWs(port, "tok-rm-notify", "rmn-sub1", "p1");
      const other = connectWs(port, "tok-rm-notify", "rmn-oth1", "p1");
      await subbed.opened;
      await other.opened;

      // Only `subbed` subscribes to ws1:a; `other` is filtered with an empty set.
      runtime._setReplay("ws1:a", "HELLO", 1);
      subbed.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      other.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: [] }));
      await delay(50);

      // Remove the panel exactly as production does.
      runtime._removePanel("ws1", "a");
      runtime._emit("terminal:removed", { sessionId: "ws1:a" });

      expect(
        await waitUntil(() =>
          subbed.messages.some((m) => m.type === "terminal:removed" && framePayload(m).sessionId === "ws1:a"),
        ),
      ).toBe(true);
      await delay(50);
      // The socket that never subscribed to ws1:a is not spammed with the notice.
      expect(other.messages.some((m) => m.type === "terminal:removed")).toBe(false);
      subbed.ws.close();
      other.ws.close();
    });
  });

  test("a subscribe over the id cap is rejected as a whole (never a truncated subset)", async () => {
    await withServer("tok-cap", async ({ port, runtime }) => {
      const c = connectWs(port, "tok-cap", "cap-aaaa", "p1");
      await c.opened;
      runtime._setReplay("ws1:a", "CAPPED", 1);
      const overCap = Array.from({ length: 65 }, (_, i) => `ws1:p${i}`);
      overCap[0] = "ws1:a"; // include a valid id — must STILL be rejected wholesale
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: overCap }));
      await delay(80);
      // Rejected before the replay loop → no replay for the valid id either.
      expect(c.messages.some((m) => m.type === "terminal:replay")).toBe(false);
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: "AFTER-CAP", seq: 2 });
      await delay(80);
      expect(terminalFrames(c)).toHaveLength(0);
      c.ws.close();
    });
  });

  test("a large one-shot non-terminal frame no longer trips a filtered socket (2.4.11 regression fix)", async () => {
    // The 2.4.11 loop was caused by treating one large frame as proof of
    // congestion: a >2 MiB frame on an otherwise-idle socket tripped a 1013.
    // The bound is now the memory ceiling on the EXISTING backlog plus a
    // time-based stall detector — a one-shot large frame on a draining socket
    // must pass. A single >2 MiB non-terminal message must NOT close the socket.
    await withServer("tok-nonterm", async ({ port, runtime }) => {
      const c = connectWs(port, "tok-nonterm", "nonterm1", "p1");
      await c.opened;
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      await delay(50); // socket is now filtered
      runtime._emit("ssh:state", { blob: "x".repeat(2_300_000) }); // >2 MiB, non-terminal
      await delay(120);
      expect(c.closeCode()).toBeNull();
      c.ws.close();
    });
  });

  test("a session that leaves the client's profile stops streaming without a resubscribe", async () => {
    // Review F2: routeTerminalFrame re-validates profile access per frame. When a
    // client's active profile no longer contains a subscribed session, that
    // session must stop immediately even if the renderer's resubscribe is
    // delayed, lost, or rejected — the old subscription is dropped in place.
    await withServer("tok-pswitch", async ({ port, runtime }) => {
      const c = connectWs(port, "tok-pswitch", "pswitch1", "p1");
      await c.opened;
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      await delay(50);
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: "before-switch", seq: 1 });
      expect(await waitUntil(() => terminalFrames(c).some((m) => framePayload(m).data === "before-switch"))).toBe(true);
      // ws1 is reassigned to p2 (the client stays p1) and state broadcasts, which
      // refreshes the per-frame authz cache. ws1:a is now cross-profile.
      runtime._setWorkspaceProfile("ws1", "p2");
      runtime._emit("state:updated", {});
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: "after-switch", seq: 2 });
      await delay(80);
      expect(terminalFrames(c).some((m) => framePayload(m).data === "after-switch")).toBe(false);
      c.ws.close();
    });
  });

  test("a single frame larger than the old watermark is delivered, not dropped", async () => {
    // The mirror of the regression fix: a live frame far larger than the old
    // 2 MiB bound, on an empty/draining socket, must be delivered rather than
    // trigger a 1013. Delivery + no close is the whole point.
    await withServer("tok-bp", async ({ port, runtime }) => {
      const c = connectWs(port, "tok-bp", "bp-aaaaa", "p1");
      await c.opened;
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      await delay(50);
      const huge = "x".repeat(2_300_000);
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: huge, seq: 1 });
      expect(
        await waitUntil(() =>
          terminalFrames(c).some((m) => m.type === "terminal:data" && framePayload(m).data?.length === huge.length),
        ),
      ).toBe(true);
      expect(c.closeCode()).toBeNull();
      c.ws.close();
    });
  });

  // The backlog/stall path can't be exercised over real loopback (the kernel
  // absorbs multi-MB queues, so bufferedAmount never reflects a real backlog),
  // so these two feed an injected buffered-amount reader that reports a
  // persistent 10 MiB backlog. That is above the 2 MiB stall watermark and below
  // the 48 MiB hard ceiling, so only the TIME-BASED stall detector fires — which
  // is exactly the machinery under test (close→terminate handshake + cleanup).
  const STALL_BACKLOG = () => 10 * 1024 * 1024;

  test(
    "a stuck close handshake is force-closed by the terminate() fallback",
    { retry: 2, timeout: 20_000 },
    async () => {
      // The stall sweep marks a non-draining socket congested: a 1013 close plus an
      // armed terminate() timer. If the client never completes the closing
      // handshake (dead/wedged socket), the fallback must forcibly drop it rather
      // than leak it forever. Tiny injected graces so it doesn't wait the real 5s.
      await withServer(
        "tok-term",
        async ({ port, server }) => {
          const c = connectWs(port, "tok-term", "term-aaa", "p1");
          await c.opened;
          c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
          await delay(50); // socket is now filtered
          // Pause the client's raw socket so it never reads the server's 1013 close
          // frame and never replies → the graceful handshake can NEVER complete, so
          // the routing entry can only be released by the terminate() fallback.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c.ws as any)._socket.pause();
          // The injected backlog + stall grace trip congestion from the sweep.
          // Generous timeouts: the stall sweep is a setInterval that can be starved
          // under parallel-test CPU load, so don't race it on a tight budget.
          expect(await waitUntil(() => server._debugRouting?.()?.[0]?.congested === true, 6000)).toBe(true);
          expect(server._debugRouting?.()).toEqual([{ congested: true, hasCloseTimer: true }]);
          // The socket is dropped ONLY because terminate() fired after the grace —
          // the paused client rules out a graceful close as the cause.
          expect(await waitUntil(() => (server._debugRouting?.() ?? []).length === 0, 6000)).toBe(true);
        },
        {
          congestionCloseGraceMs: 120,
          socketStallGraceMs: 40,
          socketStallSweepMs: 20,
          socketBufferedAmount: STALL_BACKLOG,
        },
      );
    },
  );

  // TODO(de-flake): quarantined. The interval stall-sweep gets starved for
  // >15s under heavy parallel-test CPU load on CI — flaked on both macOS and
  // Ubuntu across all retries even with generous timeouts — so this integration
  // timing test is unstable in CI. The underlying logic is covered by the pure
  // unit tests; re-enable once the sweep is made deterministic (or this file
  // runs isolated from the rest of the backend suite).
  test.skip(
    "a completed close clears the terminate timer and routing/congestion state",
    { retry: 2, timeout: 40_000 },
    async () => {
      // The ws 'close' handler must clearTimeout(closeTimer) and drop the socket
      // from socketRouting, so a disconnected client leaks neither the pending
      // terminate timer nor its subscription/congestion state. A tiny grace lets
      // the test outlast it and prove the timer never fired.
      await withServer(
        "tok-clean",
        async ({ port, server }) => {
          const c = connectWs(port, "tok-clean", "clean-aa", "p1");
          await c.opened;
          c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
          await delay(50);
          // Stall sweep trips congestion (injected persistent backlog). Generous
          // timeout — the sweep interval can be starved for several seconds under
          // parallel-test load on slow CI runners (macOS especially), so give it
          // plenty of wall-clock; this asserts eventual congestion, not latency.
          expect(await waitUntil(() => server._debugRouting?.()?.[0]?.congested === true, 15000)).toBe(true);
          // The client (not paused) acks the 1013 and closes → the server's close
          // handler releases the routing entry (and with it the cleared timer).
          expect(await waitUntil(() => (server._debugRouting?.() ?? []).length === 0, 15000)).toBe(true);
          // The graceful close won the race against the 120 ms grace, so the armed
          // terminate() timer must have been cleared. Wait well past the grace and
          // assert it never fired.
          await delay(200);
          expect(server._debugCongestionTerminates?.()).toBe(0);
        },
        {
          congestionCloseGraceMs: 120,
          socketStallGraceMs: 40,
          socketStallSweepMs: 20,
          socketBufferedAmount: STALL_BACKLOG,
        },
      );
    },
  );

  test("a large replay burst is exempt from the bound and does not trip a disconnect", async () => {
    await withServer("tok-bp2", async ({ port, runtime }) => {
      const big = "R".repeat(2_300_000);
      runtime._setReplay("ws1:a", big, 3);
      const c = connectWs(port, "tok-bp2", "bp2-aaaa");
      await c.opened;
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      expect(await waitUntil(() => c.messages.some((m) => m.type === "terminal:replay"), 2500)).toBe(true);
      await delay(80);
      expect(c.closeCode()).toBeNull();
      const replayMsg = c.messages.find((m) => m.type === "terminal:replay");
      expect(framePayload(replayMsg!).data?.length).toBe(big.length);
      c.ws.close();
    });
  });

  test("subscribe sent immediately on open is not dropped while getInitialState is slow", async () => {
    // Regression (review F2): the message listener used to be attached only
    // AFTER `await runtime.getInitialState()`; a reconnecting client sends its
    // subscribe in the open handler, landing in that window and vanishing.
    await withServer(
      "tok-early",
      async ({ port, runtime }) => {
        runtime._setReplay("ws1:a", "EARLY-REPLAY", 4);
        const c = connectWs(port, "tok-early", "early-aaa");
        await c.opened;
        // Send during the server's 300 ms initial-state await.
        c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
        expect(await waitUntil(() => c.messages.some((m) => m.type === "terminal:replay"), 2500)).toBe(true);
        expect(framePayload(c.messages.find((m) => m.type === "terminal:replay")!).data).toBe("EARLY-REPLAY");
        // Filtered mode took effect despite the early send.
        runtime._emit("terminal:data", { sessionId: "ws1:b", data: "other", seq: 1 });
        await delay(80);
        expect(terminalFrames(c).some((m) => framePayload(m).data === "other")).toBe(false);
        c.ws.close();
      },
      { initialStateDelayMs: 300 },
    );
  });

  test("legacy socket is never tripped by the backpressure bound (no heal path)", async () => {
    // Regression (review F5): a pre-rollout page has no subscribe/replay
    // mechanism — a 1013 close would leave a permanent output gap. Legacy
    // sockets keep the old eventually-delivered behaviour.
    await withServer("tok-legbp", async ({ port, runtime }) => {
      const c = connectWs(port, "tok-legbp", "legbp-aaa");
      await c.opened;
      await delay(30);
      const huge = "x".repeat(2_300_000); // > 2 MiB — would trip a filtered socket
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: huge, seq: 1 });
      expect(
        await waitUntil(() => terminalFrames(c).some((m) => framePayload(m).data?.length === huge.length), 5000),
      ).toBe(true);
      expect(c.closeCode()).toBeNull();
      c.ws.close();
    });
  });

  test("a queued replay backlog does not make the next live frame trip congestion", async () => {
    // Review F4 end-to-end smoke: 12 MB replay + paused client + live frame →
    // no 1013 and replay→live ordering holds. NOTE: on loopback the kernel
    // absorbs the whole backlog (bufferedAmount stays 0), so the exempt
    // ACCOUNTING itself can't trip here either way — the deterministic proof
    // lives in the terminalBackpressureDecision unit tests below.
    await withServer("tok-bp3", async ({ port, runtime }) => {
      const big = "R".repeat(12_000_000); // far above the bound and loopback kernel buffers
      runtime._setReplay("ws1:a", big, 3);
      const c = connectWs(port, "tok-bp3", "bp3-aaaa");
      await c.opened;
      // Pause BEFORE subscribing: the client must not read a single byte of
      // the replay, otherwise loopback drains it instantly and the test can't
      // distinguish exempt accounting from an empty buffer. Sending still
      // works while paused (pause only stops the receive stream).
      c.ws.pause();
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      await delay(150); // let the server process the subscribe + queue the replay
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: "LIVE-AFTER-BACKLOG", seq: 4 });
      await delay(150);
      expect(c.closeCode()).toBeNull(); // no 1013 despite the multi-MB backlog
      c.ws.resume();
      expect(
        await waitUntil(() => terminalFrames(c).some((m) => framePayload(m).data === "LIVE-AFTER-BACKLOG"), 5000),
      ).toBe(true);
      const frames = terminalFrames(c);
      const replayIdx = frames.findIndex((m) => m.type === "terminal:replay");
      const liveIdx = frames.findIndex((m) => framePayload(m).data === "LIVE-AFTER-BACKLOG");
      expect(replayIdx).toBeGreaterThanOrEqual(0);
      expect(liveIdx).toBeGreaterThan(replayIdx); // ordering held through the backlog
      c.ws.close();
    });
  });

  describe("terminalBackpressureDecision — memory-safety ceiling on existing backlog", () => {
    const MiB = 1024 * 1024;
    const CEILING = 48 * MiB;

    test("a large one-shot frame does not trip: the decision ignores frame size", () => {
      // Empty socket, nothing queued → live backlog 0 → never trips no matter how
      // big the frame about to be sent is. This is the whole 2.4.11 fix.
      expect(terminalBackpressureDecision(0, 0, CEILING).trip).toBe(false);
      // Even a backlog just under the ceiling passes — the frame's size is not
      // added in.
      expect(terminalBackpressureDecision(0, CEILING, CEILING).trip).toBe(false);
    });

    test("replay backlog alone is exempt and never trips", () => {
      // 12 MB of replay queued, nothing else: live backlog is 0.
      expect(terminalBackpressureDecision(12 * MiB, 12 * MiB, CEILING).trip).toBe(false);
    });

    test("an existing live backlog above the ceiling trips (hard memory bound)", () => {
      // 60 MB buffered of which only 0.5 MB is replay → ~59.5 MB live backlog.
      expect(terminalBackpressureDecision(0.5 * MiB, 60 * MiB, CEILING).trip).toBe(true);
    });

    test("live bytes are never credited as exempt: only queued replay counts", () => {
      // 50 MB buffered with just 1 MB of replay still queued → 49 MB live backlog,
      // over the 48 MB ceiling → trips.
      expect(terminalBackpressureDecision(1 * MiB, 50 * MiB, CEILING).trip).toBe(true);
    });

    test("exempt exceeding buffered (callback/OS skew) clamps to zero, never negative", () => {
      const d = terminalBackpressureDecision(5 * MiB, 1 * MiB, CEILING);
      expect(d.trip).toBe(false);
    });
  });

  describe("socketStallDecision — time-based slow-consumer detection", () => {
    const MiB = 1024 * 1024;
    const THRESHOLD = 2 * MiB;
    const GRACE = 10_000;

    test("a backlog below the watermark is healthy and clears the clock", () => {
      const d = socketStallDecision({
        liveBacklog: MiB,
        prevLiveBacklog: MiB,
        backlogSince: 5_000,
        now: 20_000,
        thresholdBytes: THRESHOLD,
        graceMs: GRACE,
      });
      expect(d).toEqual({ backlogSince: null, trip: false });
    });

    test("first crossing above the watermark starts the clock, does not trip", () => {
      const d = socketStallDecision({
        liveBacklog: 5 * MiB,
        prevLiveBacklog: 0,
        backlogSince: null,
        now: 1_000,
        thresholdBytes: THRESHOLD,
        graceMs: GRACE,
      });
      expect(d).toEqual({ backlogSince: 1_000, trip: false });
    });

    test("a shrinking backlog is draining — the clock resets, no trip", () => {
      const d = socketStallDecision({
        liveBacklog: 3 * MiB,
        prevLiveBacklog: 5 * MiB,
        backlogSince: 1_000,
        now: 30_000, // well past grace, but progress resets it
        thresholdBytes: THRESHOLD,
        graceMs: GRACE,
      });
      expect(d).toEqual({ backlogSince: 30_000, trip: false });
    });

    test("a non-draining backlog trips once the grace window elapses", () => {
      const before = socketStallDecision({
        liveBacklog: 5 * MiB,
        prevLiveBacklog: 5 * MiB,
        backlogSince: 1_000,
        now: 1_000 + GRACE - 1,
        thresholdBytes: THRESHOLD,
        graceMs: GRACE,
      });
      expect(before.trip).toBe(false);
      const after = socketStallDecision({
        liveBacklog: 5 * MiB,
        prevLiveBacklog: 5 * MiB,
        backlogSince: 1_000,
        now: 1_000 + GRACE,
        thresholdBytes: THRESHOLD,
        graceMs: GRACE,
      });
      expect(after).toEqual({ backlogSince: 1_000, trip: true });
    });
  });

  describe("drainTelemetryTransition — total time-to-drain, not just the final step", () => {
    test("first crossing stamps the entry time and records nothing yet", () => {
      const d = drainTelemetryTransition({ backlogEnteredAt: null, backloggedNow: true, now: 1_000 });
      expect(d).toEqual({ backlogEnteredAt: 1_000, drainMs: null });
    });

    test("still-backlogged ticks keep the ORIGINAL entry time (a shrink must not reset it)", () => {
      // This is the whole point of the fix: backlogSince resets on every shrink,
      // but the drain-time anchor must NOT — otherwise a stepwise drain reports
      // only the last step, not the end-to-end time (#16/#51).
      const d = drainTelemetryTransition({ backlogEnteredAt: 1_000, backloggedNow: true, now: 9_000 });
      expect(d).toEqual({ backlogEnteredAt: 1_000, drainMs: null });
    });

    test("clearing records the FULL first-crossing→cleared span and resets the anchor", () => {
      const d = drainTelemetryTransition({ backlogEnteredAt: 1_000, backloggedNow: false, now: 12_000 });
      expect(d).toEqual({ backlogEnteredAt: null, drainMs: 11_000 });
    });

    test("a stepwise drain reports total time, not the final step", () => {
      // Simulate the sweep across ticks: enters backlog at t=1000, shrinks (but
      // stays backlogged) at t=4000 and t=7000, clears at t=10000. The recorded
      // drain must be 9000 (10000-1000), NOT 3000 (the last shrink→clear step
      // that the old backlogSince-based code would have reported).
      let anchor: number | null = null;
      const ticks: { backloggedNow: boolean; now: number }[] = [
        { backloggedNow: true, now: 1_000 },
        { backloggedNow: true, now: 4_000 },
        { backloggedNow: true, now: 7_000 },
        { backloggedNow: false, now: 10_000 },
      ];
      let recorded: number | null = null;
      for (const t of ticks) {
        const d = drainTelemetryTransition({ backlogEnteredAt: anchor, ...t });
        anchor = d.backlogEnteredAt;
        if (d.drainMs !== null) recorded = d.drainMs;
      }
      expect(recorded).toBe(9_000);
      expect(anchor).toBeNull();
    });
  });

  describe("makeStateCoalescer — latest-wins state delivery", () => {
    test("a burst while one send is in flight delivers only the newest follow-up", () => {
      const sent: string[] = [];
      let release: (() => void) | null = null;
      const coalescer = makeStateCoalescer((data, onDrain) => {
        sent.push(data);
        release = onDrain; // hold the drain open to simulate a slow send
      });
      // First enqueue dispatches immediately (nothing in flight).
      expect(coalescer.enqueue("rev1")).toBe("dispatched");
      // While rev1 is "sending", a burst arrives: rev2 is queued, rev3..rev5
      // coalesce over it — none are sent, only the newest is retained.
      expect(coalescer.enqueue("rev2")).toBe("queued");
      expect(coalescer.enqueue("rev3")).toBe("coalesced");
      expect(coalescer.enqueue("rev4")).toBe("coalesced");
      expect(coalescer.enqueue("rev5")).toBe("coalesced");
      expect(sent).toEqual(["rev1"]); // still only the first frame on the wire
      // rev1 drains → the single newest pending (rev5) goes next; rev2..rev4 are
      // discarded, never serialized onto the socket.
      release!();
      expect(sent).toEqual(["rev1", "rev5"]);
      expect(coalescer.hasPending()).toBe(false);
    });

    test("sends made when idle each dispatch immediately", () => {
      const sent: string[] = [];
      const coalescer = makeStateCoalescer((data, onDrain) => {
        sent.push(data);
        onDrain(); // synchronous drain — never in flight
      });
      coalescer.enqueue("a");
      coalescer.enqueue("b");
      coalescer.enqueue("c");
      expect(sent).toEqual(["a", "b", "c"]);
    });
  });

  describe("createRemoteTelemetry", () => {
    test("tracks produced/sent/coalesced counts and frame percentiles", () => {
      const t = createRemoteTelemetry();
      expect(t.hasActivity()).toBe(false);
      t.recordStateProduced();
      t.recordStateProduced();
      t.recordStateSent();
      t.recordStateCoalesced();
      for (const n of [10, 20, 30, 40, 100]) t.recordFrame(n);
      t.recordBacklog(4096);
      t.recordBacklog(1024);
      t.recordDrainMs(50);
      const snap = t.snapshot();
      expect(snap.stateProduced).toBe(2);
      expect(snap.stateSent).toBe(1);
      expect(snap.stateCoalesced).toBe(1);
      expect(snap.maxBacklog).toBe(4096);
      expect(snap.frameP50).toBeGreaterThan(0);
      expect(snap.frameP95).toBeGreaterThanOrEqual(snap.frameP50);
      expect(snap.frameSamples).toBe(5);
      expect(t.hasActivity()).toBe(true);
    });

    test("reports the state send rate per minute over elapsed time (injected clock)", () => {
      let clock = 1_000_000;
      const t = createRemoteTelemetry(() => clock);
      // 6 frames actually sent, then 30s elapse → 12 frames/min.
      for (let i = 0; i < 6; i += 1) t.recordStateSent();
      clock += 30_000;
      expect(t.snapshot().sendRatePerMin).toBe(12);
      // Snapshot is non-mutating: reading it again at the same clock is stable.
      expect(t.snapshot().sendRatePerMin).toBe(12);
    });
  });

  test("terminal:exit is filtered like data — subscribed sockets only, legacy still broadcast", async () => {
    // Review F4: exit was broadcast so a crashed BACKGROUND tab would show its
    // exit notice on switch-to. That reason is gone — the runtime now folds the
    // "[process exited]" notice into replay for an unexpected exit, so a hidden
    // pane sees it when it later subscribes and replays. The live exit event is
    // therefore routed exactly like terminal:data: a filtered socket receives it
    // only for its subscribed sessions; a legacy socket still gets the broadcast.
    await withServer("tok-exit", async ({ port, runtime }) => {
      const filtered = connectWs(port, "tok-exit", "exit-flt", "p1");
      const legacy = connectWs(port, "tok-exit", "exit-leg", "p1");
      await Promise.all([filtered.opened, legacy.opened]);
      filtered.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      await delay(50); // legacy never subscribes → stays in legacy mode

      // Exit for a session the filtered socket is NOT subscribed to.
      runtime._emit("terminal:exit", { sessionId: "ws1:b", exitCode: 137, intentional: false });
      // Legacy socket receives every exit (full broadcast).
      expect(
        await waitUntil(() =>
          legacy.messages.some((m) => m.type === "terminal:exit" && framePayload(m).sessionId === "ws1:b"),
        ),
      ).toBe(true);
      // Filtered socket, not subscribed to ws1:b, does not receive its exit.
      expect(filtered.messages.some((m) => m.type === "terminal:exit")).toBe(false);

      // Exit for the filtered socket's own subscribed session IS delivered.
      runtime._emit("terminal:exit", { sessionId: "ws1:a", exitCode: 0, intentional: false });
      expect(
        await waitUntil(() =>
          filtered.messages.some((m) => m.type === "terminal:exit" && framePayload(m).sessionId === "ws1:a"),
        ),
      ).toBe(true);
      filtered.ws.close();
      legacy.ws.close();
    });
  });

  describe("slim remote core (protocol 2) — composition, details, interests", () => {
    const initialState = (c: WsClient) => c.messages.find((m) => m.type === "state:updated")?.payload as AnyState;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type AnyState = any;

    async function apiGet(port: number, path: string, auth: string, clientId: string): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}${path}`, {
        headers: {
          Authorization: `Bearer ${auth}`,
          "X-Strideterm-Client-Id": clientId,
          "X-Strideterm-State-Protocol": "2",
        },
      });
    }

    test(
      "GET /api/state slims to the v2 core; a v2 WS delta is also slim; a legacy socket keeps full state",
      { retry: 2, timeout: 20_000 },
      async () => {
        await withServer("tok-v2", async ({ port, runtime }) => {
          // Bootstrap-once: a v2 client bootstraps over HTTP and gets NO initial WS
          // frame; a legacy client still receives the full initial WS payload.
          const v2 = connectWs(port, "tok-v2", "v2-aaaaa", "p1", 2);
          const legacy = connectWs(port, "tok-v2", "leg-aaaa", "p1");
          await Promise.all([v2.opened, legacy.opened]);
          expect(await waitUntil(() => Boolean(initialState(legacy)))).toBe(true);
          await delay(60);
          expect(initialState(v2)).toBeUndefined(); // no redundant WS bootstrap for v2

          // HTTP bootstrap for v2 is the slim core.
          const res = await apiGet(port, "/api/state", "tok-v2", "v2-aaaaa");
          const core = (await res.json()) as AnyState;
          expect(core.stateProtocol).toBe(2);
          expect(core.gitSummaries.ws1).toMatchObject({ available: true, branch: "main" });
          expect(core.git.workspaces).toBeUndefined();
          expect(JSON.stringify(core)).not.toContain("HEAVY-GIT-LOG-ENTRY");
          expect(JSON.stringify(core)).not.toContain("HEAVY-THREAD");
          expect(JSON.stringify(core)).not.toContain("HEAVY-IMAGE");
          expect(core.azureDevops.inbox).toBeUndefined();
          expect(core.docker.counts).toEqual({ containers: 1, running: 1 });
          expect(Object.keys(core.gitSummaries)).toEqual(["ws1"]); // profile-scoped

          // A subsequent state broadcast reaches the v2 socket as a slim delta too.
          runtime._emit("state:updated", runtime.getPayload());
          expect(await waitUntil(() => Boolean(initialState(v2)))).toBe(true);
          expect(initialState(v2).stateProtocol).toBe(2);
          expect(initialState(v2).git.workspaces).toBeUndefined();

          // Legacy socket's initial WS payload is the full desktop shape.
          const full = initialState(legacy);
          expect(full.stateProtocol).toBeUndefined();
          expect(full.git.workspaces.ws1.log).toBeDefined();
          expect(full.gitSummaries).toBeUndefined();

          v2.ws.close();
          legacy.ws.close();
        });
      },
    );

    test("git workspace-detail returns {resource,revision,data}; cross-profile is 403", async () => {
      await withServer("tok-det", async ({ port }) => {
        // Bind a token-client session (profile p1) via one authorized call.
        const ok = await apiGet(port, "/api/git/workspace-detail?workspaceId=ws1", "tok-det", "det-aaaa");
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as { resource: string; revision: string; data: { log: unknown[] } };
        expect(body.resource).toBe("git:ws1");
        expect(body.revision).toBe("2026-07-15T10:00:00Z");
        expect(body.data.log).toHaveLength(1); // full snapshot

        // ws2 belongs to p2 — the p1-bound client must be refused.
        const forbidden = await apiGet(port, "/api/git/workspace-detail?workspaceId=ws2", "tok-det", "det-aaaa");
        expect(forbidden.status).toBe(403);
      });
    });

    test("docker + azure inbox detail endpoints return the heavy data", async () => {
      await withServer("tok-det2", async ({ port }) => {
        const docker = await apiGet(port, "/api/docker/detail", "tok-det2", "det2-aaa");
        expect(docker.status).toBe(200);
        expect(((await docker.json()) as { data: { images: unknown[] } }).data.images).toHaveLength(1);

        const inbox = await apiGet(port, "/api/azure/inbox", "tok-det2", "det2-aaa");
        expect(inbox.status).toBe(200);
        const inboxBody = (await inbox.json()) as { data: { inbox: { needsMyReview: unknown[] } } };
        expect(inboxBody.data.inbox.needsMyReview).toHaveLength(1); // az1 is p1's connection
      });
    });

    test("agent-prompts detail endpoint returns the global prompt list (#6/#37)", async () => {
      await withServer("tok-ap", async ({ port }) => {
        const res = await apiGet(port, "/api/review-bridge/agent-prompts", "tok-ap", "ap-aaaaa");
        expect(res.status).toBe(200);
        const body = (await res.json()) as { resource: string; revision: string; data: { agentPrompts: unknown[] } };
        expect(body.resource).toBe("agent-prompts");
        expect(body.data.agentPrompts).toHaveLength(1);
        // Revision folds the prompt list so a reset/edit bumps it — the WS
        // invalidation then refetches the mounted review pane's prompts.
        expect(body.revision).not.toBe("0");
      });
    });

    test(
      "resource:interest triggers an immediate invalidate, and again when the resource changes",
      { retry: 2, timeout: 20_000 },
      async () => {
        await withServer("tok-int", async ({ port, runtime }) => {
          const c = connectWs(port, "tok-int", "int-aaaa", "p1", 2);
          await c.opened;
          await delay(40);
          c.ws.send(JSON.stringify({ type: "resource:interest", resources: ["git:ws1"] }));
          // First interest → immediate invalidate so the client fetches once.
          expect(
            await waitUntil(() =>
              c.messages.some(
                (m) => m.type === "resource:invalidate" && (m.payload as AnyState)?.resource === "git:ws1",
              ),
            ),
          ).toBe(true);
          const firstCount = c.messages.filter((m) => m.type === "resource:invalidate").length;

          // A state broadcast with an UNCHANGED git revision must NOT re-invalidate.
          runtime._emit("state:updated", runtime.getPayload());
          await delay(60);
          expect(c.messages.filter((m) => m.type === "resource:invalidate").length).toBe(firstCount);

          // Bumping the git revision → one more invalidate.
          runtime._bumpGit("ws1", "2026-07-15T13:00:00Z");
          runtime._emit("state:updated", runtime.getPayload());
          expect(
            await waitUntil(() => c.messages.filter((m) => m.type === "resource:invalidate").length > firstCount),
          ).toBe(true);
          c.ws.close();
        });
      },
    );

    test("a v2 mutation/refresh returns a small targeted ack, NOT a nested core", async () => {
      await withServer("tok-mut", async ({ port }) => {
        // A route whose runtime method returns { ok, payload: <full state> } (git
        // ops shape). For a v2 client this must NOT serialize+transfer a whole
        // core after the button click — the response is a small targeted ack and
        // the authoritative new core rides the WS state:updated broadcast instead.
        const res = await fetch(`http://127.0.0.1:${port}/api/git/refresh`, {
          method: "POST",
          headers: {
            Authorization: "Bearer tok-mut",
            "X-Strideterm-Client-Id": "mut-aaaa",
            "X-Strideterm-State-Protocol": "2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ projectId: null }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          ok: boolean;
          payload?: unknown;
          revision: number;
          changedResources: unknown[];
        };
        expect(body.ok).toBe(true);
        // No core in the response — neither a nested payload nor a slim core.
        expect(body.payload).toBeUndefined();
        expect(typeof body.revision).toBe("number");
        expect(Array.isArray(body.changedResources)).toBe(true);
        expect(JSON.stringify(body)).not.toContain("HEAVY-GIT-LOG-ENTRY");
        expect(JSON.stringify(body)).not.toContain("gitSummaries");
      });
    });

    test("a v2 NAVIGATION mutation the renderer adopts still delivers the slim core", async () => {
      await withServer("tok-nav", async ({ port }) => {
        // /api/workspace/save is adopted synchronously by the renderer (some of
        // it inside a suppressed-broadcast window), so it must return the slim
        // core — NOT an ack that would wipe the client's state.
        const res = await fetch(`http://127.0.0.1:${port}/api/workspace/save`, {
          method: "POST",
          headers: {
            Authorization: "Bearer tok-nav",
            "X-Strideterm-Client-Id": "nav-aaaa",
            "X-Strideterm-State-Protocol": "2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ workspace: { id: "ws1", name: "WS1", profileId: "p1" } }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as AnyState;
        expect(body.stateProtocol).toBe(2); // a slim core, not an ack
        expect(body.gitSummaries).toBeDefined();
        expect(body.git.workspaces).toBeUndefined();
      });
    });

    test("a legacy (v1) mutation/refresh still returns the full composed payload", async () => {
      await withServer("tok-mut1", async ({ port }) => {
        // Same route, but a protocol-1 client — the slim contract does not apply,
        // so its old renderer keeps receiving the full nested payload it expects.
        const res = await fetch(`http://127.0.0.1:${port}/api/git/refresh`, {
          method: "POST",
          headers: {
            Authorization: "Bearer tok-mut1",
            "X-Strideterm-Client-Id": "mut1-aaa",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ projectId: null }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; payload: AnyState };
        expect(body.ok).toBe(true);
        expect(body.payload.git.workspaces).toBeDefined(); // full desktop shape
        expect(body.payload.stateProtocol).toBeUndefined();
        // The nested state payload must STILL be token-stripped. Top-level-only
        // stripping missed a `{ ok, payload: <state> }` envelope, so a v1 nested
        // mutation response could ship the master token (#7/#29/#67). It is a
        // legacy full payload, but the master token is never allowed out.
        expect(body.payload.appState.settings.remoteAccess.token).toBe("");
        expect(JSON.stringify(body)).not.toContain("tok-mut1");
      });
    });

    test("mark-seen (azure + github) is viewer-bound, not viewerless global (#32/#63)", async () => {
      await withServer("tok-seen", async ({ port, runtime }) => {
        const post = (path: string, bound: boolean) =>
          fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: {
              Authorization: "Bearer tok-seen",
              "Content-Type": "application/json",
              ...(bound ? { "X-Strideterm-Client-Id": "seen-aaa", "X-Strideterm-State-Protocol": "2" } : {}),
            },
            body: JSON.stringify({ prKey: "azure:pr1" }),
          });
        expect((await post("/api/azure/pull-request/seen", true)).status).toBe(200);
        expect((await post("/api/github/pull-request/seen", true)).status).toBe(200);
        const calls = (runtime as unknown as { _prMutationCalls: { method: string; windowId?: string }[] })
          ._prMutationCalls;
        for (const method of ["azure-seen", "github-seen"]) {
          const call = calls.find((c) => c.method === method);
          expect(call, method).toBeDefined();
          expect(String(call!.windowId)).toMatch(/^remote:/);
        }
        // Unbound → refused (no viewerless fallback that would silence another
        // profile's PR badge).
        expect((await post("/api/azure/pull-request/seen", false)).status).toBe(400);
      });
    });

    test("github comment/review + review-bridge sync are viewer-bound (#32/#58/#63)", async () => {
      await withServer("tok-ghv", async ({ port, runtime }) => {
        const post = (path: string, body: unknown, bound = true) =>
          fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: {
              Authorization: "Bearer tok-ghv",
              "Content-Type": "application/json",
              ...(bound ? { "X-Strideterm-Client-Id": "ghv-aaaa", "X-Strideterm-State-Protocol": "2" } : {}),
            },
            body: JSON.stringify(body),
          });
        expect((await post("/api/github/pull-request/comment", { prKey: "gh:pr1", body: "hi" })).status).toBe(200);
        expect((await post("/api/github/pull-request/review", { prKey: "gh:pr1", event: "APPROVE" })).status).toBe(200);
        expect((await post("/api/review-bridge/pull-request/sync", { prKey: "azure:pr1" })).status).toBe(200);
        // rerun-check (both providers) is the same class of PR mutation.
        expect((await post("/api/azure/rerun-check", { prKey: "azure:pr1", checkItem: {} })).status).toBe(200);
        expect((await post("/api/github/rerun-check", { prKey: "gh:pr1", checkItem: {} })).status).toBe(200);
        const calls = (runtime as unknown as { _prMutationCalls: { method: string; windowId?: string }[] })
          ._prMutationCalls;
        for (const method of ["github-comment", "github-review", "review-sync", "azure-rerun", "github-rerun"]) {
          const call = calls.find((c) => c.method === method);
          expect(call, method).toBeDefined();
          expect(String(call!.windowId)).toMatch(/^remote:/);
        }
        // Unbound sync → refused before publishing a comment to the PR provider.
        expect((await post("/api/review-bridge/pull-request/sync", { prKey: "azure:pr1" }, false)).status).toBe(400);
      });
    });

    test("agent-prompt reset ack NAMES the agent-prompts resource so the review pane refetches (#6/#30/#38)", async () => {
      await withServer("tok-apr", async ({ port }) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/review-bridge/agent-prompt/reset`, {
          method: "POST",
          headers: {
            Authorization: "Bearer tok-apr",
            "X-Strideterm-Client-Id": "apr-aaaa",
            "X-Strideterm-State-Protocol": "2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; changedResources: string[]; payload?: unknown };
        expect(body.ok).toBe(true);
        expect(body.payload).toBeUndefined(); // ack, not a core
        expect(body.changedResources).toEqual(["agent-prompts"]);
      });
    });

    test("per-PR review mutations (comment/thread/vote) are viewer-bound, not global (#62)", async () => {
      await withServer("tok-azc", async ({ port, runtime }) => {
        // Bound request (clientId → session): routed through the slot-aware viewer
        // path, so the runtime method receives the caller's remote viewer id and
        // can reject a cross-profile PR. Previously these ran globally, viewerless.
        const post = (path: string, body: unknown) =>
          fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: {
              Authorization: "Bearer tok-azc",
              "X-Strideterm-Client-Id": "azc-aaaa",
              "X-Strideterm-State-Protocol": "2",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
        expect((await post("/api/azure/pull-request/comment", { prKey: "azure:pr1", content: "hi" })).status).toBe(200);
        expect((await post("/api/azure/pull-request/vote", { prKey: "azure:pr1", vote: "approve" })).status).toBe(200);
        expect(
          (await post("/api/azure/pull-request/thread-status", { prKey: "azure:pr1", threadId: "t", status: "fixed" }))
            .status,
        ).toBe(200);
        const calls = (runtime as unknown as { _azureMutationCalls: { method: string; windowId?: string }[] })
          ._azureMutationCalls;
        for (const method of ["comment", "vote", "thread"]) {
          const call = calls.find((c) => c.method === method);
          expect(call, method).toBeDefined();
          // The runtime got a remote viewer id — the profile-scoped guard runs.
          expect(String(call!.windowId)).toMatch(/^remote:/);
        }

        // Unbound request (no clientId, no cookie) → the slot-aware guard refuses
        // it; there is no longer a global fallback that would run viewerless.
        const unbound = await fetch(`http://127.0.0.1:${port}/api/azure/pull-request/vote`, {
          method: "POST",
          headers: { Authorization: "Bearer tok-azc", "Content-Type": "application/json" },
          body: JSON.stringify({ prKey: "azure:pr1", vote: "approve" }),
        });
        expect(unbound.status).toBe(400);
      });
    });

    test("a v2 mutation ack NAMES the resources it changed (not an empty list) (#28/#36)", async () => {
      await withServer("tok-chg", async ({ port }) => {
        const post = (path: string, body: unknown) =>
          fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: {
              Authorization: "Bearer tok-chg",
              "X-Strideterm-Client-Id": "chg-aaaa",
              "X-Strideterm-State-Protocol": "2",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });

        // A per-PR review mutation names both the PR detail and its review-bridge context.
        const comment = (await (
          await post("/api/azure/pull-request/comment", { prKey: "azure:pr1", content: "x" })
        ).json()) as {
          ok: boolean;
          changedResources: string[];
          payload?: unknown;
        };
        expect(comment.ok).toBe(true);
        expect(comment.payload).toBeUndefined(); // ack, not a core
        expect(comment.changedResources).toEqual(
          expect.arrayContaining(["azure-pr:azure:pr1", "review-bridge:azure:pr1"]),
        );

        // A scoped git refresh names the exact workspace resource.
        const gitRefresh = (await (await post("/api/git/refresh", { projectId: "ws1" })).json()) as {
          changedResources: string[];
        };
        expect(gitRefresh.changedResources).toEqual(["git:ws1"]);
      });
    });

    test("Docker mutations return a targeted ack (docker), never a whole core (#28/#36)", async () => {
      await withServer("tok-dck", async ({ port }) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/docker/refresh`, {
          method: "POST",
          headers: {
            Authorization: "Bearer tok-dck",
            "X-Strideterm-Client-Id": "dck-aaaa",
            "X-Strideterm-State-Protocol": "2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; changedResources: string[]; payload?: unknown };
        expect(body.ok).toBe(true);
        expect(body.payload).toBeUndefined(); // no whole core after a docker action
        expect(body.changedResources).toEqual(["docker"]);
        // The heavy docker lists must not have been serialized into the ack.
        expect(JSON.stringify(body)).not.toContain("HEAVY-IMAGE");
      });
    });

    test("git conflict-resolution routes are viewer-bound, not viewerless global (#57/#62)", async () => {
      await withServer("tok-cfl", async ({ port, runtime }) => {
        const post = (path: string, body: unknown, bound: boolean) =>
          fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: {
              Authorization: "Bearer tok-cfl",
              "Content-Type": "application/json",
              ...(bound ? { "X-Strideterm-Client-Id": "cfl-aaaa", "X-Strideterm-State-Protocol": "2" } : {}),
            },
            body: JSON.stringify(body),
          });

        // Bound → slot-aware viewer path: the runtime receives a remote viewer id
        // so the profile-scoped guard runs.
        expect(
          (await post("/api/git/resolve-conflict", { workspaceId: "ws1", filePath: "a", mode: "ours" }, true)).status,
        ).toBe(200);
        expect((await post("/api/git/skip", { workspaceId: "ws1" }, true)).status).toBe(200);
        const calls = (runtime as unknown as { _gitConflictCalls: { method: string; windowId?: string }[] })
          ._gitConflictCalls;
        for (const method of ["resolve", "skip"]) {
          const call = calls.find((c) => c.method === method);
          expect(call, method).toBeDefined();
          expect(String(call!.windowId)).toMatch(/^remote:/);
        }

        // Unbound → refused (no viewerless global fallback remains).
        const unbound = await post(
          "/api/git/resolve-conflict",
          { workspaceId: "ws1", filePath: "a", mode: "ours" },
          false,
        );
        expect(unbound.status).toBe(400);
      });
    });

    test(
      "state:sync closes the first-connect [bootstrap, open] window: a stale rev gets one catch-up",
      { retry: 2, timeout: 20_000 },
      async () => {
        await withServer("tok-sync", async ({ port, runtime }) => {
          // Simulate the real client's first socket: its URL was frozen before the
          // HTTP bootstrap recorded a revision, so it carries NO ?rev= and the
          // server holds bootstrap-once (no initial frame).
          const c = connectWs(port, "tok-sync", "sync-aaa", "p1", 2);
          await c.opened;
          await delay(60);
          expect(initialState(c)).toBeUndefined(); // bootstrap-once: nothing yet

          // State moves while the client was mid-bootstrap.
          runtime._bumpGit("ws1", "2026-07-15T13:30:00Z");
          runtime._emit("state:updated", runtime.getPayload());
          await delay(40);
          const before = c.messages.filter((m) => m.type === "state:updated").length;

          // The client now hands off its (stale) bootstrap revision. Because the
          // server's coreRevision advanced past it, exactly one catch-up core is
          // sent — closing the missed-update window.
          c.ws.send(JSON.stringify({ type: "state:sync", rev: 0 }));
          expect(await waitUntil(() => c.messages.filter((m) => m.type === "state:updated").length > before)).toBe(
            true,
          );
          const synced = c.messages.filter((m) => m.type === "state:updated").pop()!.payload as AnyState;
          expect(synced.stateProtocol).toBe(2);

          // A current rev (>= server's) triggers no catch-up.
          const after = c.messages.filter((m) => m.type === "state:updated").length;
          c.ws.send(JSON.stringify({ type: "state:sync", rev: 999 }));
          await delay(80);
          expect(c.messages.filter((m) => m.type === "state:updated").length).toBe(after);
          c.ws.close();
        });
      },
    );

    test("interest for a cross-profile resource is silently ignored (no invalidate)", async () => {
      await withServer("tok-int2", async ({ port }) => {
        const c = connectWs(port, "tok-int2", "int2-aaa", "p1", 2);
        await c.opened;
        await delay(40);
        // git:ws2 belongs to p2 — a p1 client's interest must not be honored.
        c.ws.send(JSON.stringify({ type: "resource:interest", resources: ["git:ws2"] }));
        await delay(80);
        expect(c.messages.some((m) => m.type === "resource:invalidate")).toBe(false);
        c.ws.close();
      });
    });

    test("the v2 core is profile-filtered and secret-stripped, echoing the negotiated caps", async () => {
      await withServer("tok-core", async ({ port }) => {
        const res = await apiGet(port, "/api/state", "tok-core", "core-aaa");
        const core = (await res.json()) as AnyState;
        // Bare sp=2 (no explicit caps) implies the full supported capability set.
        expect(core.capabilities).toEqual(["remote-core-v2", "resource-details-v1"]);
        // appState workspaces filtered to the client's profile (p1); legacy alias gone.
        expect(core.appState.workspaces.map((w: AnyState) => w.id)).toEqual(["ws1"]);
        expect(core.appState.projects).toBeUndefined();
        // settings.remoteAccess is reduced to just { enabled } — the tunnel
        // token, host and port are all desktop-only management data and gone.
        expect(core.appState.settings.remoteAccess).toEqual({ enabled: true });
        expect(core.appState.settings.remoteAccess.token).toBeUndefined();
        expect(core.appState.settings.remoteAccess.host).toBeUndefined();
        // A per-broadcast revision is present for the bootstrap→WS handoff.
        expect(typeof core.coreRevision).toBe("number");
      });
    });

    test("explicit caps narrow the contract: without remote-core-v2 the client is NOT slimmed", async () => {
      await withServer("tok-cap", async ({ port }) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
          headers: {
            Authorization: "Bearer tok-cap",
            "X-Strideterm-Client-Id": "cap-aaaa",
            "X-Strideterm-State-Protocol": "2",
            "X-Strideterm-Capabilities": "resource-details-v1",
          },
        });
        const body = (await res.json()) as AnyState;
        // No remote-core-v2 → full composed desktop payload, not the slim core.
        expect(body.stateProtocol).toBeUndefined();
        expect(body.git.workspaces).toBeDefined();
        expect(body.gitSummaries).toBeUndefined();
      });
    });

    test(
      "a v2 socket echoing a STALE bootstrap rev gets one catch-up; a current rev gets none",
      { retry: 2, timeout: 20_000 },
      async () => {
        await withServer("tok-rev", async ({ port }) => {
          // Read the current coreRevision from the HTTP bootstrap.
          const boot = await apiGet(port, "/api/state", "tok-rev", "rev-boot");
          const rev = ((await boot.json()) as AnyState).coreRevision as number;

          // Stale client (rev < current) → server sends ONE catch-up state frame
          // so it never misses a change that landed between bootstrap and connect.
          const stale = connectWs(port, "tok-rev", "rev-stale", "p1", 2, { rev: rev - 1 });
          await stale.opened;
          expect(await waitUntil(() => Boolean(initialState(stale)))).toBe(true);
          expect(initialState(stale).stateProtocol).toBe(2);
          // Deterministic single-transfer: the stale reconnect resyncs with
          // EXACTLY one catch-up core over the WS, never a duplicate frame — and
          // since the client no longer re-fetches /api/state on reconnect, this
          // WS body is the ONLY state transfer of the resync.
          await delay(80);
          expect(stale.messages.filter((m) => m.type === "state:updated").length).toBe(1);

          // Current client (rev == current) → no catch-up (bootstrap-once holds).
          const current = connectWs(port, "tok-rev", "rev-curr", "p1", 2, { rev });
          await current.opened;
          await delay(80);
          expect(initialState(current)).toBeUndefined();

          stale.ws.close();
          current.ws.close();
        });
      },
    );

    test(
      "server-restart recovery: a v2 socket whose rev is AHEAD of coreRevision still gets exactly one catch-up",
      { retry: 2, timeout: 20_000 },
      async () => {
        await withServer("tok-restart", async ({ port }) => {
          // After a server restart the monotonic coreRevision resets low, but a
          // reconnecting client still advertises the (higher) rev it cached from
          // the dead process. A `rev < coreRevision` gate would send nothing and
          // strand that client on state from the dead process; the `!==` gate
          // resyncs it with exactly one fresh core so it always recovers.
          const c = connectWs(port, "tok-restart", "restart-aaa", "p1", 2, { rev: 999_999 });
          await c.opened;
          expect(await waitUntil(() => c.messages.filter((m) => m.type === "state:updated").length === 1)).toBe(true);
          await delay(80);
          // Exactly one catch-up — a resync, not a broadcast loop.
          expect(c.messages.filter((m) => m.type === "state:updated").length).toBe(1);
          expect(initialState(c).stateProtocol).toBe(2);
          c.ws.close();
        });
      },
    );
  });
});

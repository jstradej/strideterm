import { describe, expect, test } from "vitest";
import net from "node:net";
import { WebSocket } from "ws";
import {
  REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS,
  REMOTE_BLOCKED_TOP_LEVEL_FIELDS,
  buildSessionCookieAttrs,
  sanitizeSettingsFromRemote,
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
    };
    const handlers: Record<string, ((p: unknown) => void)[]> = {};
    const replay = new Map<string, { data: string; throughSeq: number }>();
    // Fired the instant the server snapshots a session's replay inside the
    // subscribe critical section — lets a test inject a live frame at exactly
    // that point to guard the no-`await`-before-set-add ordering invariant.
    let onSnapshot: ((sessionId: string) => void) | null = null;
    const runtime = {
      getPayload: () => payload,
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
    };
    return runtime;
  }

  type WsClient = {
    ws: WebSocket;
    messages: { type: string; payload?: unknown }[];
    opened: Promise<void>;
    closeCode: () => number | null;
  };

  function connectWs(port: number, auth: string, clientId: string, profileId?: string): WsClient {
    const q = new URLSearchParams({ token: auth, clientId });
    if (profileId) q.set("profileId", profileId);
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
    opts: { initialStateDelayMs?: number; congestionCloseGraceMs?: number } = {},
  ): Promise<void> {
    const port = await getFreePort();
    const runtime = makeStreamingRuntime(auth, port, opts);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      congestionCloseGraceMs: opts.congestionCloseGraceMs,
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

  test("a large non-terminal message trips a filtered socket (whole-socket bound)", async () => {
    // Review F1: only live terminal frames used to be able to trip the bound, so
    // a slow client fed by state/ssh/docker could grow an unbounded queue. Every
    // non-replay send on a FILTERED socket is now bounded. A single >2 MiB
    // non-terminal message trips regardless of the loopback kernel buffer.
    await withServer("tok-nonterm", async ({ port, runtime }) => {
      const c = connectWs(port, "tok-nonterm", "nonterm1", "p1");
      await c.opened;
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      await delay(50); // socket is now filtered
      runtime._emit("ssh:state", { blob: "x".repeat(2_300_000) }); // >2 MiB, non-terminal
      expect(await waitUntil(() => c.closeCode() === 1013)).toBe(true);
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

  test("crossing the buffered-byte limit trips a 1013 close and drops the live frame", async () => {
    await withServer("tok-bp", async ({ port, runtime }) => {
      const c = connectWs(port, "tok-bp", "bp-aaaaa");
      await c.opened;
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
      await delay(50);
      // A single live frame larger than the 2 MiB bound trips immediately.
      const huge = "x".repeat(2_300_000);
      runtime._emit("terminal:data", { sessionId: "ws1:a", data: huge, seq: 1 });
      expect(await waitUntil(() => c.closeCode() === 1013)).toBe(true);
      expect(terminalFrames(c).some((m) => m.type === "terminal:data")).toBe(false);
    });
  });

  test("a stuck close handshake is force-closed by the terminate() fallback", async () => {
    // markCongested sends a 1013 close, then arms a terminate() timer. If the
    // client never completes the closing handshake (dead/wedged socket), the
    // fallback must forcibly drop the connection rather than leak it forever.
    // Only tested here at a tiny injected grace so it doesn't wait the real 5s.
    await withServer(
      "tok-term",
      async ({ port, runtime, server }) => {
        const c = connectWs(port, "tok-term", "term-aaa");
        await c.opened;
        c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
        await delay(50); // socket is now filtered
        // Pause the client's raw socket so it never reads the server's 1013 close
        // frame and never replies → the graceful handshake can NEVER complete, so
        // the routing entry can only be released by the terminate() fallback.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c.ws as any)._socket.pause();
        runtime._emit("terminal:data", { sessionId: "ws1:a", data: "x".repeat(2_300_000), seq: 1 });
        // Congested, with a pending terminate timer, before it can (never) ack.
        expect(server._debugRouting?.()).toEqual([{ congested: true, hasCloseTimer: true }]);
        // The socket is dropped ONLY because terminate() fired after the grace —
        // the paused client rules out a graceful close as the cause.
        expect(await waitUntil(() => (server._debugRouting?.() ?? []).length === 0, 2000)).toBe(true);
      },
      { congestionCloseGraceMs: 120 },
    );
  });

  test("a completed close clears the terminate timer and routing/congestion state", async () => {
    // The ws 'close' handler must clearTimeout(closeTimer) and drop the socket
    // from socketRouting, so a disconnected client leaks neither the pending
    // terminate timer nor its subscription/congestion state. A tiny grace lets
    // the test outlast it and prove the timer never fired.
    await withServer(
      "tok-clean",
      async ({ port, runtime, server }) => {
        const c = connectWs(port, "tok-clean", "clean-aa");
        await c.opened;
        c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: ["ws1:a"] }));
        await delay(50);
        // Trip congestion. markCongested runs synchronously inside _emit, so right
        // after it the socket is congested with a pending terminate timer — before
        // it can complete the 1013 handshake.
        runtime._emit("terminal:data", { sessionId: "ws1:a", data: "x".repeat(2_300_000), seq: 1 });
        expect(server._debugRouting?.()).toEqual([{ congested: true, hasCloseTimer: true }]);
        // The client acks the 1013 and closes → the server's close handler releases
        // the routing entry (and with it the cleared terminate timer).
        expect(await waitUntil(() => (server._debugRouting?.() ?? []).length === 0)).toBe(true);
        // The graceful close won the race against the 120 ms grace, so the armed
        // terminate() timer must have been cleared. Wait well past the grace and
        // assert it never fired — the routing snapshot can't show this because the
        // entry is already gone. Without the close handler's clearTimeout, the
        // orphaned timer would fire here and make this 1.
        await delay(200);
        expect(server._debugCongestionTerminates?.()).toBe(0);
      },
      { congestionCloseGraceMs: 120 },
    );
  });

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

  describe("terminalBackpressureDecision — replay-exempt accounting (review F4)", () => {
    const MiB = 1024 * 1024;
    const LIMIT = 2 * MiB;

    test("replay backlog alone does not trip the next small live frame", () => {
      // 12 MB of replay queued, nothing else: live backlog is 0.
      expect(terminalBackpressureDecision(12 * MiB, 12 * MiB, 1024, LIMIT).trip).toBe(false);
    });

    test("a live frame larger than the limit trips regardless of exempt bytes", () => {
      expect(terminalBackpressureDecision(12 * MiB, 12 * MiB, LIMIT + 1, LIMIT).trip).toBe(true);
    });

    test("non-replay backlog above the limit trips even with some replay queued", () => {
      // 3 MB buffered of which only 0.5 MB is replay → 2.5 MB live backlog.
      expect(terminalBackpressureDecision(0.5 * MiB, 3 * MiB, 1024, LIMIT).trip).toBe(true);
    });

    test("live bytes are never credited as exempt: only queued replay counts", () => {
      // exemptBytes tracks ONLY replay still in the queue (the send-drain callback
      // decrements it as replay flushes). So once replay has drained, the exempt
      // input is already low and the full live backlog is measured. Here 4 MB is
      // buffered with just 1 MB of replay still queued → 3 MB live backlog trips.
      expect(terminalBackpressureDecision(1 * MiB, 4 * MiB, 1024, LIMIT).trip).toBe(true);
    });

    test("exempt exceeding buffered (callback/OS skew) clamps to zero, never negative", () => {
      // If the drain callback lags the OS socket, exempt can momentarily exceed
      // bufferedAmount. Live backlog clamps at 0 rather than going negative and
      // masking a real backlog on the next frame.
      const d = terminalBackpressureDecision(5 * MiB, 1 * MiB, 1024, LIMIT);
      expect(d.trip).toBe(false);
      // A genuinely over-limit live frame still trips despite the skew.
      expect(terminalBackpressureDecision(5 * MiB, 1 * MiB, LIMIT + 1, LIMIT).trip).toBe(true);
    });

    test("zero state: small frame passes, buffered live bytes count fully", () => {
      expect(terminalBackpressureDecision(0, 0, 1024, LIMIT).trip).toBe(false);
      expect(terminalBackpressureDecision(0, LIMIT, 1, LIMIT).trip).toBe(true);
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
});

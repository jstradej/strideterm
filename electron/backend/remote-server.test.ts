import { describe, expect, test } from "vitest";
import net from "node:net";
import {
  REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS,
  REMOTE_BLOCKED_TOP_LEVEL_FIELDS,
  buildSessionCookieAttrs,
  sanitizeSettingsFromRemote,
  startRemoteServer,
  stripSecretsForRemote,
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
          { id: "ws1", name: "WS1", profileId: "p1", panels: [] },
          { id: "ws2", name: "WS2", profileId: "p2", panels: [] },
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
          { id: "ws1", name: "WS1", profileId: "p1", panels: [] },
          { id: "ws2", name: "WS2", profileId: "p2", panels: [] },
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

import type { RemoteClientRegistry } from "./remote-client-registry.js";
import { describe, expect, test, vi } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { WebSocket } from "ws";
import { getLogDir } from "./logger.js";
import * as fm from "./file-manager.js";
import {
  REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS,
  REMOTE_BLOCKED_TOP_LEVEL_FIELDS,
  buildSessionCookieAttrs,
  createRemoteTelemetry,
  drainTelemetryTransition,
  makeStateCoalescer,
  sanitizeSettingsFromRemote,
  REMOTE_BLOCKED_NOTIFICATION_FIELDS,
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

// The audit logger writes through winston's async file stream and closing it does not wait for the
// flush, so callers read it inside `vi.waitFor` instead of once.
async function readAuditLog(name: string): Promise<string> {
  try {
    return await fs.readFile(path.join(getLogDir(), `${name}.log`), "utf8");
  } catch {
    return "";
  }
}

describe("static asset HTTP caching", () => {
  test("revalidates content assets, changes validators with content, and never caches HTML", async () => {
    const staticRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-static-cache-"));
    const assetPath = path.join(staticRoot, "app.js");
    await fs.writeFile(assetPath, "console.log('v1')");
    await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>remote</title>");
    const port = await getFreePort();
    const server = await startRemoteServer({
      runtime: {
        getPayload: () => ({
          appState: {
            settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: "test-token" } },
          },
        }),
        setRemoteInfo: () => undefined,
        listRemoteUrls: () => [],
        on: () => () => undefined,
        off: () => undefined,
      } as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const first = await fetch(`${baseUrl}/app.js`);
      const firstEtag = first.headers.get("etag");
      expect(first.status).toBe(200);
      expect(await first.text()).toBe("console.log('v1')");
      expect(first.headers.get("cache-control")).toBe("private, no-cache");
      expect(firstEtag).toMatch(/^".+"$/);

      const unchanged = await fetch(`${baseUrl}/app.js`, { headers: { "If-None-Match": `W/${firstEtag}` } });
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe("");
      expect(unchanged.headers.get("etag")).toBe(firstEtag);

      await fs.writeFile(assetPath, "console.log('v2')");
      const changed = await fetch(`${baseUrl}/app.js`, { headers: { "If-None-Match": firstEtag! } });
      expect(changed.status).toBe(200);
      expect(await changed.text()).toBe("console.log('v2')");
      expect(changed.headers.get("etag")).not.toBe(firstEtag);

      const html = await fetch(`${baseUrl}/`);
      expect(html.status).toBe(200);
      expect(html.headers.get("cache-control")).toBe("no-store");
      expect(html.headers.get("etag")).toBeNull();
    } finally {
      await server.close();
      await fs.rm(staticRoot, { recursive: true, force: true });
    }
  });
});

test("a paused desktop does not bind the browser remote server", async () => {
  let info: unknown;
  const server = await startRemoteServer({
    runtime: {
      getPayload: () => ({
        appState: {
          settings: { remoteAccess: { enabled: true, paused: true, host: "127.0.0.1", port: 0, token: "test" } },
        },
      }),
      setRemoteInfo: (value: unknown) => {
        info = value;
      },
    } as Parameters<typeof startRemoteServer>[0]["runtime"],
    staticRoot: ".",
  });
  expect(info).toMatchObject({ enabled: false, urls: [] });
  await server.close();
});

test("an enabled remote server with an empty token is not started", async () => {
  let info: unknown;
  const server = await startRemoteServer({
    runtime: {
      getPayload: () => ({
        appState: { settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port: 0, token: "" } } },
      }),
      setRemoteInfo: (value: unknown) => {
        info = value;
      },
    } as Parameters<typeof startRemoteServer>[0]["runtime"],
    staticRoot: ".",
  });
  expect(info).toMatchObject({ enabled: false, urls: [] });
  await server.close();
});

describe("sanitizeSettingsFromRemote", () => {
  test("drops every blocked remoteAccess field", () => {
    const settings = {
      remoteAccess: {
        autoTunnel: true,
        paused: false,
        cloudflaredPath: "/tmp/evil.sh",
        enabled: false,
        host: "0.0.0.0",
        networkAccess: true,
        port: 1234,
        token: "attacker-chosen",
        customPublicUrl: "https://my.tunnel.example",
        sessionIdleTtlMinutes: 30,
        sessionAbsoluteTtlMinutes: 60,
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

  test("drops notifications.autoApprovePermissions but keeps its siblings", () => {
    // Arming the desktop to answer permission prompts unattended must be a
    // deliberate act at the machine that executes the result. Everything else
    // under `notifications` is an ordinary preference a phone may tune.
    const settings = {
      notifications: {
        autoApprovePermissions: true,
        agentsOnly: false,
        subagentCompletion: true,
        alertCooldownMs: 5_000,
      },
    };
    const removed = sanitizeSettingsFromRemote(settings as Record<string, unknown>);
    expect(removed).toContain("autoApprovePermissions");
    expect(settings.notifications).toEqual({
      agentsOnly: false,
      subagentCompletion: true,
      alertCooldownMs: 5_000,
    });
  });

  test("REMOTE_BLOCKED_NOTIFICATION_FIELDS includes autoApprovePermissions", () => {
    // Same defensive intent as the autoTunnel test above: if a refactor drops
    // the entry, this fires before a remote caller can arm an unattended
    // permission bypass on someone's desktop.
    expect(REMOTE_BLOCKED_NOTIFICATION_FIELDS).toContain("autoApprovePermissions");
  });

  test("keeps settings.git — a remote client may choose the update strategy", () => {
    // The parity tests here all pin what a remote caller must NOT write, so a
    // key that is deliberately remote-writable needs its own assertion or the
    // next person to add a blocklist entry has nothing telling them this one
    // is intentional.
    //
    // `git.ui.updateStrategy` is not in the blocklist on purpose: it is not
    // transport-specific like `terminalFontSizeLocal`, and it is not a bypass
    // like `autoApprovePermissions` — it only chooses which integration the
    // Pull/Update buttons OFFER. The rebase and merge actions themselves are
    // already fully invokable from a phone, so blocking the preference while
    // allowing the operation would be incoherent.
    const settings = { git: { ui: { updateStrategy: "merge", showAllActions: true } } };
    const removed = sanitizeSettingsFromRemote(settings as unknown as Record<string, unknown>);
    expect(removed).toEqual([]);
    expect(settings.git.ui.updateStrategy).toBe("merge");
    expect(REMOTE_BLOCKED_TOP_LEVEL_FIELDS).not.toContain("git");
  });

  test("is a no-op when notifications is not an object", () => {
    const settings = { notifications: "not-a-record" };
    const removed = sanitizeSettingsFromRemote(settings as unknown as Record<string, unknown>);
    expect(removed).toEqual([]);
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

  test("drops integrations.mobile wholesale but leaves sibling integrations untouched", () => {
    // Remote HTTP clients must never touch mobile pairing/device/credential
    // state (plan §10.5) — the whole subtree is dropped, same as
    // externalPathOpener, because every field in it (enabled flag + the full
    // paired-device list) is desktop-owned pairing state.
    const settings = {
      integrations: {
        mobile: {
          enabled: true,
          devices: [{ deviceId: "dev-1", capabilities: ["remote.request"] }],
          // Desktop-only: a remote client that could untick this would re-open the plaintext relay
          // downgrade the desktop setting exists to close (security review 3.5).
          relay: { enabled: true, requireE2e: false },
        },
        telegram: { enabled: true, defaultPollSeconds: 5, connections: [] },
        azureDevops: { enabled: false, reviewRoot: "", defaultPollSeconds: 60, connections: [] },
      },
      theme: "dark",
    };
    const removed = sanitizeSettingsFromRemote(settings as unknown as Record<string, unknown>);
    expect(removed).toContain("integrations.mobile");
    expect(settings.integrations).not.toHaveProperty("mobile");
    expect(JSON.stringify(settings)).not.toContain("requireE2e");
    // Sibling integrations survive untouched.
    expect(settings.integrations.telegram).toEqual({ enabled: true, defaultPollSeconds: 5, connections: [] });
    expect(settings.integrations.azureDevops).toEqual({
      enabled: false,
      reviewRoot: "",
      defaultPollSeconds: 60,
      connections: [],
    });
    expect(settings.theme).toBe("dark");
  });

  test("is a no-op when integrations.mobile is absent", () => {
    const settings = { integrations: { telegram: { enabled: true, defaultPollSeconds: 5, connections: [] } } };
    const removed = sanitizeSettingsFromRemote(settings as unknown as Record<string, unknown>);
    expect(removed).toEqual([]);
    expect(settings.integrations.telegram).toEqual({ enabled: true, defaultPollSeconds: 5, connections: [] });
  });
});

describe("stripSecretsForRemote", () => {
  const MASTER = "super-secret-master-token";

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

  // --- stripShareUrls: relay and device-bound mobile response strip ---
  //
  // `payload.remoteAccess.urls[*]` embeds `?token=<master>` and residual R1 accepts that, on the
  // premise that the URL only ever travels desktop → the OWNER's own browser. Over the managed
  // relay a hosted Worker terminates TLS and forwards decrypted frames, so that premise does not
  // hold: the token would reach the relay operator, and unlike a relay session cookie it is
  // long-lived and keeps unlocking the whole remote API over the LAN after the session ends.
  //
  // The pair of tests below is the point: the SAME payload strips differently for remote viewers
  // and desktop/browser share flows. If a refactor ever makes this unconditional it breaks
  // "Copy share URL" on the desktop; if it makes it never apply, remote viewers leak the token.
  function payloadWithShareUrls() {
    return {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "0.0.0.0", port: 43123, token: MASTER } },
      },
      remoteAccess: {
        enabled: true,
        host: "0.0.0.0",
        port: 43123,
        urls: [`http://192.168.1.50:43123/?token=${MASTER}`, `http://127.0.0.1:43123/?token=${MASTER}`],
        tunnel: { status: "connected", mode: "quick", url: "https://x.trycloudflare.com" },
      },
    };
  }

  test("with stripShareUrls, no copy of the master token survives anywhere in the payload", () => {
    const payload = payloadWithShareUrls();
    const stripped = stripSecretsForRemote(payload, { stripShareUrls: true }) as typeof payload;
    expect(stripped.remoteAccess.urls).toEqual([]);
    expect(stripped.appState.settings.remoteAccess.token).toBe("");
    // The whole-serialization assertion is the one that matters — it is what a leak looks like.
    expect(JSON.stringify(stripped)).not.toContain(MASTER);
    // Everything a relay viewer legitimately reads off remoteAccess survives; only the URLs go.
    expect(stripped.remoteAccess.enabled).toBe(true);
    expect(stripped.remoteAccess.port).toBe(43123);
    expect(stripped.remoteAccess.tunnel).toEqual({
      status: "connected",
      mode: "quick",
      url: "https://x.trycloudflare.com",
    });
    // Immutable strip — the runtime's own payload object is not mutated for the desktop's benefit.
    expect(payload.remoteAccess.urls).toHaveLength(2);
  });

  test("WITHOUT the option the share URLs are left alone — residual R1, deliberately", () => {
    const stripped = stripSecretsForRemote(payloadWithShareUrls()) as ReturnType<typeof payloadWithShareUrls>;
    expect(stripped.remoteAccess.urls).toHaveLength(2);
    expect(stripped.remoteAccess.urls[0]).toContain(`?token=${MASTER}`);
    // The settings-level strip (invariant A1) still applies on this path.
    expect(stripped.appState.settings.remoteAccess.token).toBe("");
  });

  test("stripShareUrls reaches the share URLs inside a NESTED result envelope too", () => {
    // Same reason the token strip had to: a v1 mutation result wraps the whole state under
    // `.payload`, and a strip that only looked at the top level would miss it there.
    const envelope = { ok: true, payload: payloadWithShareUrls() };
    const stripped = stripSecretsForRemote(envelope, { stripShareUrls: true }) as typeof envelope;
    expect(stripped.payload.remoteAccess.urls).toEqual([]);
    expect(stripped.ok).toBe(true);
    expect(JSON.stringify(stripped)).not.toContain(MASTER);
  });

  test("stripShareUrls is a no-op on payload shapes that carry no share URLs", () => {
    // `stripStateToken` returns its input early when there is no `settings.remoteAccess`, which is
    // why the URL strip is a separate pass — these shapes prove the pass neither throws nor
    // invents a `remoteAccess` object that the client would then read as "relay off".
    const noRemoteAccess = { appState: { settings: { logLevel: "info" } } };
    expect(stripSecretsForRemote(noRemoteAccess, { stripShareUrls: true })).toEqual(noRemoteAccess);

    const emptyUrls = { appState: { settings: {} }, remoteAccess: { enabled: false, urls: [] } };
    expect(stripSecretsForRemote(emptyUrls, { stripShareUrls: true })).toEqual(emptyUrls);

    expect(stripSecretsForRemote({ ok: true }, { stripShareUrls: true })).toEqual({ ok: true });
    expect(stripSecretsForRemote(null, { stripShareUrls: true })).toBeNull();
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
      isSshTestSessionId: (sessionId: unknown) => typeof sessionId === "string" && sessionId.startsWith("ssh-test:"),
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

describe("remoteAccess.networkAccess (desktop-only, loopback bind)", () => {
  function makeRuntime(auth: string, port: number, remoteAccess: Record<string, unknown>) {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, port, token: auth, ...remoteAccess } },
        profiles: [{ id: "default", name: "Default" }],
        workspaces: [],
        windowSlots: [{ id: "win-1", profileId: "default", activeWorkspaceId: "" }],
      },
    };
    const updates: Array<Record<string, unknown>> = [];
    let info: { urls?: string[]; host?: string } | undefined;
    return {
      updates,
      info: () => info,
      runtime: {
        getPayload: () => payload,
        getInitialState: async () => payload,
        setRemoteInfo: (value: { urls?: string[]; host?: string }) => {
          info = value;
        },
        listRemoteUrls: () => info?.urls ?? [],
        on: () => () => undefined,
        setRemoteClientRegistry: () => undefined,
        updateSettings: async (settings: Record<string, unknown>) => {
          updates.push(JSON.parse(JSON.stringify(settings)));
          return { payload };
        },
      },
    };
  }

  test.each([true, false])(
    "/api/settings/update with remoteAccess.networkAccess: %s does not change it",
    async (value) => {
      const port = await getFreePort();
      const auth = "test-token-network-access";
      const fixture = makeRuntime(auth, port, { host: "127.0.0.1" });
      const server = await startRemoteServer({
        runtime: fixture.runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
        staticRoot: process.cwd(),
      });
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/settings/update`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth}`,
            "Content-Type": "application/json",
            "X-Strideterm-Client-Id": "test-client",
          },
          body: JSON.stringify({ settings: { remoteAccess: { networkAccess: value }, logLevel: "debug" } }),
        });
        expect(res.status).toBe(200);
        expect(fixture.updates).toHaveLength(1);
        expect(fixture.updates[0]).toEqual({ remoteAccess: {}, logLevel: "debug" });
      } finally {
        await server.close();
      }
    },
  );

  test("networkAccess: false with a wildcard host binds loopback and advertises no network URL", async () => {
    const port = await getFreePort();
    const fixture = makeRuntime("t", port, { host: "0.0.0.0", networkAccess: false });
    const server = await startRemoteServer({
      runtime: fixture.runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      expect(server.address?.host).toBe("127.0.0.1");
      expect(fixture.info()?.host).toBe("127.0.0.1");
      expect(fixture.info()?.urls).toEqual([]);
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  test("networkAccess: true with a wildcard host binds every interface as before", async () => {
    const port = await getFreePort();
    const fixture = makeRuntime("t", port, { host: "0.0.0.0", networkAccess: true });
    const server = await startRemoteServer({
      runtime: fixture.runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      expect(fixture.info()?.host).toBe("0.0.0.0");
      for (const url of fixture.info()?.urls ?? []) expect(url).not.toMatch(/127\.0\.0\.1/);
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

  // review-code-quality-2026-07.md finding 1.7: handleApiRequest's inline copy
  // of this route validated with taskUpdateDescriptionSchema (a comment there
  // called out "HTTP path was missing the Zod parse its IPC counterpart
  // uses"), but that inline copy was PROVABLY DEAD — slotAwareRoute always
  // intercepts POST /api/task/update-description first. Deleting the dead
  // inline copy (as part of removing ~60 shadowed handlers) would have
  // silently dropped this validation entirely unless the slot-aware entry
  // gained its own validateIpc call, which it now has.
  test("POST /api/task/update-description with an over-length description returns 400 (validated on the live slot-aware path)", async () => {
    const port = await getFreePort();
    const auth = "test-token-desc-invalid";
    const runtime = makeMinimalRuntime(auth, port) as ReturnType<typeof makeMinimalRuntime> & {
      updateTaskDescription: (...args: unknown[]) => Promise<unknown>;
    };
    runtime.updateTaskDescription = async () => ({});
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/task/update-description`, {
        method: "POST",
        headers: clientHeaders(auth),
        body: JSON.stringify({ workspaceId: "ws-1", description: "x".repeat(200_000) }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/IPC validation failed/);
    } finally {
      await server.close();
    }
  });

  test("POST /api/task/update-description with a valid body returns 200 and forwards the parsed fields", async () => {
    const port = await getFreePort();
    const auth = "test-token-desc-ok";
    const calls: unknown[] = [];
    const runtime = makeMinimalRuntime(auth, port) as ReturnType<typeof makeMinimalRuntime> & {
      updateTaskDescription: (...args: unknown[]) => Promise<unknown>;
    };
    runtime.updateTaskDescription = async (...args: unknown[]) => {
      calls.push(args);
      return {};
    };
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/task/update-description`, {
        method: "POST",
        headers: clientHeaders(auth),
        body: JSON.stringify({ workspaceId: "ws-1", description: "new brief" }),
      });
      expect(res.status).toBe(200);
      expect(calls[0]).toEqual(["ws-1", "new brief", expect.any(String)]);
    } finally {
      await server.close();
    }
  });
});

// review-code-quality-2026-07.md finding 1.7: ~60 POST routes had a SHADOWED
// inline copy in handleApiRequest that could never actually run (slotAwareRoute
// always intercepts first, unconditionally) but which — per a comment already
// in this file documenting the /api/git/skip family's prior removal — made an
// accidental future drop of the slot-aware entry silently "fail open" onto the
// inline handler, which passes no windowId and so re-opens the cross-profile
// hole slot-aware routing exists to close. The shadowed copies were deleted as
// a mechanical pass: for every key in slotAwareRoute, remove the matching
// `url.pathname === "<key>"` check from handleApiRequest. This is a permanent
// static regression guard against that duplication creeping back in — it reads
// the actual source text (not a mocked HTTP request) so it fails the moment
// ANY of these route names reappears as an inline POST dispatch, regardless of
// how the surrounding code around it is refactored later.
describe("remote-server.ts source shape — no route may have BOTH a slotAwareRoute entry and a shadowed inline handleApiRequest copy", () => {
  test("none of the slot-aware route keys appear as an inline POST dispatch inside handleApiRequest", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const srcPath = path.resolve(process.cwd(), "electron/backend/remote-server.ts");
    const src = fs.readFileSync(srcPath, "utf8");

    const fnStart = src.indexOf("async function handleApiRequest(");
    const fnEnd = src.indexOf("export async function startRemoteServer(");
    expect(fnStart).toBeGreaterThan(0);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const handleApiRequestBody = src.slice(fnStart, fnEnd);

    const slotMapStart = src.indexOf("const slotAwareRoute:");
    const slotMapEnd = src.indexOf("const slotAwareHandler =", slotMapStart);
    expect(slotMapStart).toBeGreaterThan(0);
    const slotAwareRouteBody = src.slice(slotMapStart, slotMapEnd);
    const slotKeys = [...slotAwareRouteBody.matchAll(/"(\/api\/[^"]+)":/g)].map((m) => m[1]);
    expect(slotKeys.length).toBeGreaterThan(50); // sanity: the map still has its full route set

    const stillShadowed = slotKeys.filter((key) => handleApiRequestBody.includes(`url.pathname === "${key}"`));
    expect(stillShadowed).toEqual([]);
  });
});

// review-code-quality-2026-07.md finding §5.3: DETAIL_ROUTES and slotAwareRoute
// were object literals (a ~280-line one for slotAwareRoute, ~100 closures)
// rebuilt from scratch inside the per-request HTTP callback even though both
// only close over the constant `runtime` reference. Hoisted to be built once
// at `startRemoteServer`'s top level instead.
describe("DETAIL_ROUTES / slotAwareRoute — built once per server instance, not per request", () => {
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
    };
  }

  test("route-map references are identical across two separate API requests", async () => {
    const port = await getFreePort();
    const auth = "test-token-routemap-identity";
    const runtime = makeMinimalRuntime(auth, port);
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      expect(server._debugRouteMapsIdentity).toBeTruthy();
      const res1 = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { Authorization: `Bearer ${auth}` },
      });
      expect(res1.status).toBe(200);
      const snapshot1 = server._debugRouteMapsIdentity!();

      const res2 = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { Authorization: `Bearer ${auth}` },
      });
      expect(res2.status).toBe(200);
      const snapshot2 = server._debugRouteMapsIdentity!();

      // Same object reference before/after a second request — proves the maps
      // are built once at server start, not reconstructed on every request.
      expect(snapshot1.detailRoutes).toBe(snapshot2.detailRoutes);
      expect(snapshot1.slotAwareRoute).toBe(snapshot2.slotAwareRoute);
    } finally {
      await server.close();
    }
  });
});

// review-code-quality-2026-07.md finding §5.3: handleApiRequest's ~150-block
// if-chain was replaced with an API_ROUTES lookup table (`Record<string,
// (runtime, body) => unknown>`) + a small dispatch wrapper. These tests hit a
// representative sample of the newly-tabled routes end-to-end (status codes,
// response shapes, validation error messages) to confirm the table produces
// identical behavior to the old if-chain for: a plain sync passthrough route,
// a validateIpc-guarded route (both the reject and accept paths), a route
// whose handler unwraps a nested `.payload` before responding, a bracket-
// notation runtime method call, and the 404 fallback for an untabled route.
describe("API_ROUTES table — representative route coverage", () => {
  function makeMinimalRuntime(auth: string, port: number) {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: auth } },
        profiles: [{ id: "default", name: "Default" }],
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
      writeToSession: () => undefined,
      resizeSession: () => undefined,
      setRemoteClientRegistry: () => undefined,
    };
  }

  const headers = (auth: string) => ({
    Authorization: `Bearer ${auth}`,
    "Content-Type": "application/json",
  });

  test("POST /api/azure/audit-log/query (sync, no validateIpc) returns 200 with the runtime's return value", async () => {
    const port = await getFreePort();
    const auth = "test-token-audit-query";
    const runtime = makeMinimalRuntime(auth, port) as ReturnType<typeof makeMinimalRuntime> & {
      queryAzureAuditLog: (body: unknown) => unknown;
    };
    let receivedBody: unknown;
    runtime.queryAzureAuditLog = (body: unknown) => {
      receivedBody = body;
      return { entries: ["a", "b"] };
    };
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/azure/audit-log/query`, {
        method: "POST",
        headers: headers(auth),
        body: JSON.stringify({ connectionId: "az1" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ entries: ["a", "b"] });
      expect(receivedBody).toEqual({ connectionId: "az1" });
    } finally {
      await server.close();
    }
  });

  test("POST /api/docker/action with an invalid body (missing containerId) returns 400 with an IPC validation error", async () => {
    const port = await getFreePort();
    const auth = "test-token-docker-action-invalid";
    const runtime = makeMinimalRuntime(auth, port) as ReturnType<typeof makeMinimalRuntime> & {
      dockerAction: (...args: unknown[]) => Promise<unknown>;
    };
    runtime.dockerAction = async () => ({ ok: true });
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/docker/action`, {
        method: "POST",
        headers: headers(auth),
        body: JSON.stringify({ action: "start" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/IPC validation failed/);
    } finally {
      await server.close();
    }
  });

  test("POST /api/docker/action with a valid body returns 200 and forwards the parsed fields", async () => {
    const port = await getFreePort();
    const auth = "test-token-docker-action-ok";
    const calls: unknown[] = [];
    const runtime = makeMinimalRuntime(auth, port) as ReturnType<typeof makeMinimalRuntime> & {
      dockerAction: (...args: unknown[]) => Promise<unknown>;
    };
    runtime.dockerAction = async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true };
    };
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/docker/action`, {
        method: "POST",
        headers: headers(auth),
        body: JSON.stringify({ action: "start", containerId: "c1", backendId: "docker" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(calls[0]).toEqual(["start", "c1", "docker", undefined]);
    } finally {
      await server.close();
    }
  });

  test("POST /api/telegram/save-connection returns the unwrapped result.payload, not the wrapping envelope", async () => {
    const port = await getFreePort();
    const auth = "test-token-telegram-save";
    const runtime = makeMinimalRuntime(auth, port) as ReturnType<typeof makeMinimalRuntime> & {
      saveTelegramConnection: (connection: unknown) => Promise<unknown>;
    };
    runtime.saveTelegramConnection = async () => ({ ok: true, payload: { marker: "unwrapped" } });
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/telegram/save-connection`, {
        method: "POST",
        headers: { ...headers(auth), "X-Strideterm-Client-Id": "test-client" },
        body: JSON.stringify({ connection: { botToken: "t" } }),
      });
      expect(res.status).toBe(200);
      // The response is result.payload directly — not { ok, payload } — proving
      // the multi-statement table entry (unwrap then return) behaves like the
      // original two-statement if-block.
      expect(await res.json()).toEqual({ marker: "unwrapped" });
    } finally {
      await server.close();
    }
  });

  test("POST /api/ssh/hosts/list (bracket-notation runtime call) returns 200 with the runtime's value", async () => {
    const port = await getFreePort();
    const auth = "test-token-ssh-hosts-list";
    const runtime = makeMinimalRuntime(auth, port) as ReturnType<typeof makeMinimalRuntime> & {
      "ssh:hosts:list": () => Promise<unknown>;
    };
    runtime["ssh:hosts:list"] = async () => [{ id: "host1" }];
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ssh/hosts/list`, {
        method: "POST",
        headers: headers(auth),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ id: "host1" }]);
    } finally {
      await server.close();
    }
  });

  test("POST /api/docker/logs/close validates then returns a static { ok: true } after the void runtime call", async () => {
    const port = await getFreePort();
    const auth = "test-token-docker-logs-close";
    const calls: unknown[] = [];
    const runtime = makeMinimalRuntime(auth, port) as ReturnType<typeof makeMinimalRuntime> & {
      dockerLogsClose: (sessionId: string) => void;
    };
    runtime.dockerLogsClose = (sessionId: string) => {
      calls.push(sessionId);
    };
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/docker/logs/close`, {
        method: "POST",
        headers: headers(auth),
        body: JSON.stringify({ sessionId: "s1" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(calls).toEqual(["s1"]);
    } finally {
      await server.close();
    }
  });

  test("POST to an unrecognized /api/ path still 404s (table-miss fallback matches the old if-chain's final else)", async () => {
    const port = await getFreePort();
    const auth = "test-token-404-fallback";
    const runtime = makeMinimalRuntime(auth, port);
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/this-route-does-not-exist`, {
        method: "POST",
        headers: headers(auth),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Not found");
    } finally {
      await server.close();
    }
  });
});

describe("malformed request body handling — must respond, never hang", () => {
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
      saveWorkspace: async () => payload,
      activateWorkspaceForRemoteClient: async () => payload,
    };
  }

  const clientHeaders = (auth: string) => ({
    Authorization: `Bearer ${auth}`,
    "Content-Type": "application/json",
    "X-Strideterm-Client-Id": "test-client",
  });

  test("slot-aware route (POST /api/workspace/save) with malformed JSON body returns 400, not a hang", async () => {
    const port = await getFreePort();
    const auth = "test-token-bad-json-slot";
    const runtime = makeMinimalRuntime(auth, port);
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/workspace/save`, {
        method: "POST",
        headers: clientHeaders(auth),
        body: "{not valid json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  test("remote-client-scoped route (POST /api/remote-client/workspace/activate) with malformed JSON body returns 400, not a hang", async () => {
    const port = await getFreePort();
    const auth = "test-token-bad-json-client";
    const runtime = makeMinimalRuntime(auth, port);
    const server = await startRemoteServer({
      runtime: runtime as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/remote-client/workspace/activate`, {
        method: "POST",
        headers: clientHeaders(auth),
        body: "{not valid json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    } finally {
      await server.close();
    }
  });
});

describe("sendCoreCatchUp resilience — a rejecting getInitialState() must not crash a WS connection", () => {
  // review-code-quality-2026-07.md finding §2.1 (remote-server.ts:3618,3703 in
  // the review's line numbers): the WS-connect-time catch-up
  // (`await sendCoreCatchUp(...)` with no enclosing try/catch in the
  // handleUpgrade callback) and the state:sync catch-up (`void
  // sendCoreCatchUp(...)`, fire-and-forget) both call runtime.getInitialState(),
  // which can reject (git/docker refreshes). Before the fix that was an
  // unhandled rejection and the client silently never got its catch-up core.
  test("connection-time catch-up: a rejecting getInitialState() is caught inside sendCoreCatchUp, socket stays open", async () => {
    const port = await getFreePort();
    const auth = "test-token-catchup-connect";
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: auth } },
        profiles: [{ id: "default", name: "Default" }],
        workspaces: [],
        windowSlots: [],
      },
    };
    const runtime = {
      getPayload: () => payload,
      getInitialState: async () => {
        throw new Error("boom: transient failure");
      },
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
      // needsCatchUp is unconditionally true for a socket that doesn't
      // advertise sp=2 (a legacy tab) — connecting one immediately exercises
      // the `await sendCoreCatchUp(ws, wsSessionId)` connection-time path.
      const q = new URLSearchParams({ token: auth, clientId: "catchup-client" });
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${q.toString()}`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 150));
      // The socket must still be open: a rejection from getInitialState()
      // must be absorbed inside sendCoreCatchUp, never crash/close the
      // connection or escape as an unhandled rejection (which would fail
      // this test file under vitest's unhandled-rejection detection).
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    } finally {
      await server.close();
    }
  });

  test("state:sync catch-up: a rejecting getInitialState() is caught, no unhandled rejection", async () => {
    const port = await getFreePort();
    const auth = "test-token-catchup-sync";
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: auth } },
        profiles: [{ id: "default", name: "Default" }],
        workspaces: [],
        windowSlots: [],
      },
    };
    let bootstrapDone = false;
    const runtime = {
      getPayload: () => payload,
      getInitialState: async () => {
        // Let the very first call (the legacy connection-time catch-up)
        // succeed so coreRevision-vs-rev state is established; the
        // state:sync-triggered catch-up below is the one under test.
        if (!bootstrapDone) {
          bootstrapDone = true;
          return payload;
        }
        throw new Error("boom: transient failure");
      },
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
      // sp=2 + a bootstrap rev equal to the server's initial coreRevision (0)
      // so the connection-time catch-up is skipped (needsCatchUp=false) and
      // the state:sync path below is the first thing to call getInitialState.
      const q = new URLSearchParams({ token: auth, clientId: "sync-client", profileId: "default", sp: "2", rev: "0" });
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${q.toString()}`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 80));
      // rev=0 is not < coreRevision (0), so this only exercises the fire-and-forget
      // `void sendCoreCatchUp(...)` branch once coreRevision has moved past what
      // the client reports — simulate that by sending a stale rev.
      ws.send(JSON.stringify({ type: "state:sync", rev: -1 }));
      await new Promise((r) => setTimeout(r, 150));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
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
    // Records every docker shell runtime call (open/write/resize/close) so a test
    // can assert the HTTP route / WS message handler forwarded the right args.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dockerShellCalls: Record<string, any>[] = [];
    const dockerShellCallbacks = new Map<
      string,
      { onData: (sid: string, data: string) => void; onClose: (sid: string, code: number | null) => void }
    >();
    const runtime = {
      getPayload: () => payload,
      isSshTestSessionId: (sessionId: unknown) => typeof sessionId === "string" && sessionId.startsWith("ssh-test:"),
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
      // Push & publish: an ack route whose result rides beside the payload.
      pushAndPublishReview: async () => ({
        payload,
        pushAndPublishResult: { commitCount: 2, publishedCount: 0, pushOk: true, publishError: "403 Forbidden" },
      }),
      // Docker interactive shell — mirrors the real runtime's dockerShellOpen/
      // Write/Resize/Close (electron/backend/runtime.ts): open records the
      // onData/onClose callbacks the caller wired up (broadcast over the WS in
      // production) so a test can trigger them via _emitDockerShellData/Close.
      async dockerShellOpen(
        sessionId: string,
        containerId: string,
        backendId: string,
        contextName: string,
        cols: number,
        rows: number,
        onData: (sid: string, data: string) => void,
        onClose: (sid: string, code: number | null) => void,
      ) {
        dockerShellCalls.push({ method: "open", sessionId, containerId, backendId, contextName, cols, rows });
        dockerShellCallbacks.set(sessionId, { onData, onClose });
      },
      dockerShellWrite(sessionId: string, data: string) {
        dockerShellCalls.push({ method: "write", sessionId, data });
      },
      dockerShellResize(sessionId: string, cols: number, rows: number) {
        dockerShellCalls.push({ method: "resize", sessionId, cols, rows });
      },
      dockerShellClose(sessionId: string) {
        dockerShellCalls.push({ method: "close", sessionId });
        dockerShellCallbacks.delete(sessionId);
      },
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
      _dockerShellCalls: dockerShellCalls,
      _emitDockerShellData: (sessionId: string, data: string) =>
        dockerShellCallbacks.get(sessionId)?.onData(sessionId, data),
      _emitDockerShellClose: (sessionId: string, code: number | null) =>
        dockerShellCallbacks.get(sessionId)?.onClose(sessionId, code),
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

  test("SSH test and key-transfer terminal, state, and authentication events never reach remote clients", async () => {
    await withServer("tok-ssh-test", async ({ port, runtime }) => {
      const c = connectWs(port, "tok-ssh-test", "ssh-test-remote");
      await c.opened;
      const marker = "private-test-marker-89df0";
      const privateIds = ["ssh-test:private", "ssh-transfer:private", "ssh-transfer:private:verify"];
      for (const sessionId of privateIds) {
        runtime._emit("terminal:data", { sessionId, data: marker, seq: 1 });
        runtime._emit("terminal:exit", { sessionId, exitCode: 0 });
        runtime._emit("ssh:auth-prompt", { sessionId, prompt: marker });
        runtime._emit("ssh:auth-prompt-cancel", { sessionId });
        runtime._emit("ssh:host-key-change", { sessionId, fingerprint: marker });
        runtime._emit("ssh:connection-state", { sessionId, status: "connected" });
      }
      runtime._emit("ssh:key-transfer:state", {
        operationId: "ssh-transfer:private",
        hostId: "h1",
        keyId: "k1",
        status: "uploading",
      });
      await delay(100);
      expect(c.messages.some((message) => privateIds.some((id) => JSON.stringify(message).includes(id)))).toBe(false);
      expect(c.messages.some((message) => JSON.stringify(message).includes(marker))).toBe(false);
      c.ws.close();
    });
  });

  test("remote clients cannot start or stop key transfer, answer its prompts, replay it, or attach terminal input", async () => {
    await withServer("tok-ssh-transfer-private", async ({ port, runtime }) => {
      const transferId = "ssh-transfer:private-http-ws";
      const verifyId = `${transferId}:verify`;
      const c = connectWs(port, "tok-ssh-transfer-private", "transfer-private-remote");
      await c.opened;
      const writes = vi.spyOn(runtime, "writeToSession");
      const resizes = vi.spyOn(runtime, "resizeSession");
      c.ws.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: [transferId, verifyId] }));
      c.ws.send(JSON.stringify({ type: "terminal:input", sessionId: transferId, data: "secret\r" }));
      c.ws.send(JSON.stringify({ type: "terminal:resize", sessionId: verifyId, cols: 100, rows: 35 }));
      runtime._emit("terminal:data", { sessionId: transferId, data: "private-output", seq: 1 });
      runtime._emit("terminal:data", { sessionId: verifyId, data: "private-verify-output", seq: 2 });
      await delay(100);
      expect(writes).not.toHaveBeenCalled();
      expect(resizes).not.toHaveBeenCalled();
      expect(c.messages.some((message) => JSON.stringify(message).includes("private-output"))).toBe(false);

      for (const sessionId of [transferId, verifyId]) {
        const replay = await fetch(`http://127.0.0.1:${port}/api/terminal/replay`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok-ssh-transfer-private" },
          body: JSON.stringify({ sessionId }),
        });
        expect(replay.status).not.toBe(200);
        const answer = await fetch(`http://127.0.0.1:${port}/api/ssh/auth/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok-ssh-transfer-private" },
          body: JSON.stringify({ sessionId, promptId: "p1", answers: ["never-forward"] }),
        });
        expect(answer.status).not.toBe(200);
        const trust = await fetch(`http://127.0.0.1:${port}/api/ssh/host-key/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok-ssh-transfer-private" },
          body: JSON.stringify({ sessionId, promptId: "p2", mode: "permanent" }),
        });
        expect(trust.status).not.toBe(200);
      }
      for (const [path, body] of [
        ["/api/ssh/keys/transfer/start", { profileId: "default", hostId: "h1", keyId: "k1" }],
        ["/api/ssh/keys/transfer/stop", { operationId: transferId }],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok-ssh-transfer-private" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(403);
      }
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

    test("push-and-publish ack keeps the result that rides beside the payload", async () => {
      await withServer("tok-pap", async ({ port }) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/review-bridge/pull-request/push-and-publish`, {
          method: "POST",
          headers: {
            Authorization: "Bearer tok-pap",
            "X-Strideterm-Client-Id": "pap-aaaa",
            "X-Strideterm-State-Protocol": "2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ workspaceId: "ws1" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; payload?: unknown; pushAndPublishResult?: unknown };
        expect(body.ok).toBe(true);
        expect(body.payload).toBeUndefined(); // ack, not a core
        // The phone must still learn that publishing failed.
        expect(body.pushAndPublishResult).toEqual({
          commitCount: 2,
          publishedCount: 0,
          pushOk: true,
          publishError: "403 Forbidden",
        });
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

    // Docker interactive shell (`docker exec -it`). Open/close are infrequent
    // HTTP POSTs, same shape as the docker/logs/open|close routes; write/resize
    // are per-keystroke frequent and instead ride the WS socket exactly like
    // terminal:input/terminal:resize do for a regular terminal session.
    test("POST /api/docker/shell/open opens a session; the runtime's data/close callbacks broadcast over the WS", async () => {
      await withServer("tok-shell", async ({ port, runtime }) => {
        const c = connectWs(port, "tok-shell", "shell-aaa");
        await c.opened;

        const res = await fetch(`http://127.0.0.1:${port}/api/docker/shell/open`, {
          method: "POST",
          headers: {
            Authorization: "Bearer tok-shell",
            "X-Strideterm-Client-Id": "shell-aaa",
            "X-Strideterm-State-Protocol": "2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionId: "shell-1",
            containerId: "c1",
            backendId: "host",
            contextName: "default",
            cols: 80,
            rows: 24,
          }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });

        expect(runtime._dockerShellCalls).toContainEqual({
          method: "open",
          sessionId: "shell-1",
          containerId: "c1",
          backendId: "host",
          contextName: "default",
          cols: 80,
          rows: 24,
        });

        // The PTY emits data, then exits — the server must broadcast both as
        // WS push messages so every connected client sees the live stream.
        runtime._emitDockerShellData("shell-1", "hello$ ");
        expect(await waitUntil(() => c.messages.some((m) => m.type === "docker:shell:data"))).toBe(true);
        expect(c.messages.find((m) => m.type === "docker:shell:data")?.payload).toEqual({
          sessionId: "shell-1",
          data: "hello$ ",
        });

        runtime._emitDockerShellClose("shell-1", 0);
        expect(await waitUntil(() => c.messages.some((m) => m.type === "docker:shell:close"))).toBe(true);
        expect(c.messages.find((m) => m.type === "docker:shell:close")?.payload).toEqual({
          sessionId: "shell-1",
          code: 0,
        });

        c.ws.close();
      });
    });

    test("POST /api/docker/shell/open defaults cols/rows to 80x24 when omitted", async () => {
      await withServer("tok-shell-def", async ({ port, runtime }) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/docker/shell/open`, {
          method: "POST",
          headers: {
            Authorization: "Bearer tok-shell-def",
            "X-Strideterm-Client-Id": "shldef01",
            "X-Strideterm-State-Protocol": "2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionId: "shell-def",
            containerId: "c1",
            backendId: "host",
            contextName: "default",
          }),
        });
        expect(res.status).toBe(200);
        expect(runtime._dockerShellCalls).toContainEqual(
          expect.objectContaining({ method: "open", sessionId: "shell-def", cols: 80, rows: 24 }),
        );
      });
    });

    test("POST /api/docker/shell/close closes the shell session", async () => {
      await withServer("tok-shell-close", async ({ port, runtime }) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/docker/shell/close`, {
          method: "POST",
          headers: {
            Authorization: "Bearer tok-shell-close",
            "X-Strideterm-Client-Id": "shlclose1",
            "X-Strideterm-State-Protocol": "2",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId: "shell-2" }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(runtime._dockerShellCalls).toContainEqual({ method: "close", sessionId: "shell-2" });
      });
    });

    test("WS docker:shell:write and docker:shell:resize route keystrokes/resizes to the runtime", async () => {
      await withServer("tok-shell-io", async ({ port, runtime }) => {
        const c = connectWs(port, "tok-shell-io", "shellioaa");
        await c.opened;
        c.ws.send(JSON.stringify({ type: "docker:shell:write", sessionId: "shell-3", data: "ls\n" }));
        c.ws.send(JSON.stringify({ type: "docker:shell:resize", sessionId: "shell-3", cols: 120, rows: 40 }));
        await delay(80);
        expect(runtime._dockerShellCalls).toContainEqual({ method: "write", sessionId: "shell-3", data: "ls\n" });
        expect(runtime._dockerShellCalls).toContainEqual({
          method: "resize",
          sessionId: "shell-3",
          cols: 120,
          rows: 40,
        });
        c.ws.close();
      });
    });

    test("WS docker:shell:write with an invalid payload is dropped, not forwarded to the runtime", async () => {
      await withServer("tok-shell-bad", async ({ port, runtime }) => {
        const c = connectWs(port, "tok-shell-bad", "shellbadaa");
        await c.opened;
        // Missing required `data` field.
        c.ws.send(JSON.stringify({ type: "docker:shell:write", sessionId: "shell-4" }));
        await delay(80);
        expect(runtime._dockerShellCalls.some((call) => call.method === "write")).toBe(false);
        c.ws.close();
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

  describe("notification:target-removed routing", () => {
    test("reaches only clients bound to the event's profile", async () => {
      // Notification history is per-viewer. A client bound to another profile
      // never saw the removed workspace, so purging its history would delete
      // threads that are still perfectly valid for it.
      await withServer("tok-notif", async ({ port, runtime }) => {
        const inProfile = connectWs(port, "tok-notif", "notif-p1", "p1");
        const otherProfile = connectWs(port, "tok-notif", "notif-p2", "p2");
        await inProfile.opened;
        await otherProfile.opened;

        runtime._emit("notification:target-removed", {
          target: "workspace",
          workspaceId: "ws1",
          profileId: "p1",
        });

        expect(
          await waitUntil(() =>
            inProfile.messages.some(
              (m) =>
                m.type === "notification:target-removed" &&
                (m.payload as { workspaceId?: string })?.workspaceId === "ws1",
            ),
          ),
        ).toBe(true);
        await delay(50);
        expect(otherProfile.messages.some((m) => m.type === "notification:target-removed")).toBe(false);
        inProfile.ws.close();
        otherProfile.ws.close();
      });
    });

    test("an event with no profileId is dropped rather than broadcast", async () => {
      await withServer("tok-notif-noprofile", async ({ port, runtime }) => {
        const c = connectWs(port, "tok-notif-noprofile", "notif-np1", "p1");
        await c.opened;

        runtime._emit("notification:target-removed", { target: "workspace", workspaceId: "ws1", profileId: "" });

        await delay(80);
        expect(c.messages.some((m) => m.type === "notification:target-removed")).toBe(false);
        c.ws.close();
      });
    });
  });
});

describe("GET /api/approvals/audit-log", () => {
  /** Minimal runtime exposing just the approval-log reads plus the fields the
   *  server needs to bind and compose responses. */
  function makeApprovalRuntime(port: number, token: string) {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token } },
        profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: [] }],
        workspaces: [],
        windowSlots: [{ id: "win-1", profileId: "default", activeWorkspaceId: "" }],
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queryCalls: any[] = [];
    return {
      queryCalls,
      runtime: {
        getPayload: () => payload,
        getInitialState: async () => payload,
        setRemoteInfo: () => undefined,
        listRemoteUrls: () => [],
        on: () => () => undefined,
        writeToSession: () => undefined,
        resizeSession: () => undefined,
        setRemoteClientRegistry: () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        queryApprovalAuditLog: (filters: any) => {
          queryCalls.push(filters);
          return {
            total: 1,
            entries: [
              {
                id: 1,
                timestamp: "2026-09-03T10:00:00.000Z",
                operation: "auto-approve",
                toolName: "Bash",
                summary: "Bash: chmod +x deploy.sh",
                workspaceId: "backend",
              },
            ],
          };
        },
        getApprovalAuditStats: () => ({ total: 1, writeCount: 1 }),
      },
    };
  }

  test("returns entries to an authorized caller and forwards its query filters", async () => {
    const port = await getFreePort();
    const token = "test-token";
    const { runtime, queryCalls } = makeApprovalRuntime(port, token);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/approvals/audit-log?limit=50&search=chmod`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { total?: number; entries?: unknown[] };
      expect(body.total).toBe(1);
      expect(body.entries).toHaveLength(1);
      expect(queryCalls[0]).toMatchObject({ limit: 50, search: "chmod" });
    } finally {
      await server.close();
    }
  });

  test("forwards the keyset cursors a remote back-fill pages with, and ignores junk ones", async () => {
    // The Notification Center on a phone pages its history with these; the
    // route is the only way they reach the store. Anything non-positive is no
    // cursor at all rather than a bound the store would have to defend
    // against — and neither one is a scope, so they cannot widen a read.
    const port = await getFreePort();
    const token = "test-token";
    const { runtime, queryCalls } = makeApprovalRuntime(port, token);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const good = await fetch(`http://127.0.0.1:${port}/api/approvals/audit-log?afterId=7&beforeId=42`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(good.status).toBe(200);
      expect(queryCalls.at(-1)).toMatchObject({ afterId: 7, beforeId: 42 });

      const junk = await fetch(`http://127.0.0.1:${port}/api/approvals/audit-log?afterId=nope&beforeId=-3`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(junk.status).toBe(200);
      expect(queryCalls.at(-1)?.afterId).toBeUndefined();
      expect(queryCalls.at(-1)?.beforeId).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  test("a master-token caller with no bound session reads the whole installation's trail", async () => {
    // Deliberate and documented: that token already grants every mutation on
    // every profile, so there is nothing left for scoping to protect, and a
    // machine-to-machine reader needs the complete view.
    const port = await getFreePort();
    const token = "test-token";
    const { runtime, queryCalls } = makeApprovalRuntime(port, token);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/approvals/audit-log`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(queryCalls[0].profileId).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  test("a browser session's read is scoped to the profile it is bound to", async () => {
    // The leak this closes: a client open in profile B could read the
    // workspace, session, tool and command of every approval in profile A.
    // The live `approval:recorded` event was already scoped; the GET was not.
    const port = await getFreePort();
    const token = "test-token";
    const { runtime, queryCalls } = makeApprovalRuntime(port, token);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      // Bootstrap a real session the way a browser does, then read the cookie
      // back out and use it — that binding is what carries the profile.
      const bootstrap = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: "manual" });
      const cookie = (bootstrap.headers.get("set-cookie") || "").split(";")[0];
      expect(cookie).toBeTruthy();

      const response = await fetch(`http://127.0.0.1:${port}/api/approvals/audit-log`, { headers: { cookie } });
      expect(response.status).toBe(200);
      // The server decides the scope from its own registry — never from a
      // query parameter, which a client could simply edit.
      expect(queryCalls.at(-1)?.profileId).toBe("default");

      const forged = await fetch(`http://127.0.0.1:${port}/api/approvals/audit-log?profileId=other`, {
        headers: { cookie },
      });
      expect(forged.status).toBe(200);
      expect(queryCalls.at(-1)?.profileId).toBe("default");
    } finally {
      await server.close();
    }
  });

  test("the stats endpoint answers an authorized caller", async () => {
    const port = await getFreePort();
    const token = "test-token";
    const { runtime } = makeApprovalRuntime(port, token);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/approvals/audit-log/stats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ total: 1 });
    } finally {
      await server.close();
    }
  });

  test("there is no remote route that deletes from the trail", async () => {
    // Reading the record of an unattended bypass from a phone is fine.
    // ERASING it is not: the bypass runs on the desktop, its consequences land
    // there, and `autoApprovePermissions` itself is already blocked from
    // /api/settings/update for that reason. A source check rather than a
    // request, so a route added later fails here even before it is reachable.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/backend/remote-server.ts"), "utf8");
    expect(src).not.toContain("approvals/audit-log/delete");
    expect(src).not.toContain("deleteApprovalAuditEntries");

    // ...and the desktop DOES have one, so the assertion above is about where
    // the capability lives, not about it being missing everywhere.
    const ipc = fs.readFileSync(path.resolve(process.cwd(), "electron/backend/ipc.ts"), "utf8");
    expect(ipc).toContain("approvals:audit-log:delete");
  });

  test("no remote route reaches the account surface at all", async () => {
    // Plan §8.2. Signing in, paying, revoking and deleting are acts whose consequences land at the
    // DESKTOP, and a password crossing a remote HTTP hop is a password in one more place than it
    // needs to be. A source check rather than a request, so a route added later fails here even
    // before it is reachable — the same discipline as the trail-delete assertion above.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/backend/remote-server.ts"), "utf8");
    for (const forbidden of [
      "account:sign-in:start",
      "account:sign-in:confirm",
      "account:sign-in:link",
      "account:checkout",
      "account:portal",
      "account:delete",
      "account:revoke",
      "accountBeginSignIn",
      "accountConfirmSignIn",
      "accountSubmitSignInLink",
      "accountOpenCheckout",
      "accountDelete",
      // Diagnostics too: what a remote caller could send from this machine, in this machine's name,
      // is this machine's own log.
      "account:diagnostics",
      "accountSubmitDiagnostics",
      "accountExportDiagnostics",
      "api/account",
    ]) {
      expect(src).not.toContain(forbidden);
    }

    // ...and the DESKTOP does have them, so the assertion above is about where the capability lives
    // rather than about it being missing everywhere.
    const ipc = fs.readFileSync(path.resolve(process.cwd(), "electron/backend/ipc.ts"), "utf8");
    expect(ipc).toContain("account:sign-in:start");
    // The manual link paste is the sharpest of these: its payload is a live sign-in code. It exists
    // as ONE desktop IPC channel and has no remote counterpart at all.
    expect(ipc).toContain("account:sign-in:link");
    expect(ipc).toContain("account:checkout");
    expect(ipc).toContain("account:delete");
    expect(ipc).toContain("account:diagnostics:submit");
  });

  test("a POST to the read endpoint's path is not a delete in disguise", async () => {
    const port = await getFreePort();
    const token = "test-token";
    const { runtime } = makeApprovalRuntime(port, token);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/approvals/audit-log`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  test("requires a token — reading the approval trail is not public", async () => {
    const port = await getFreePort();
    const token = "test-token";
    const { runtime, queryCalls } = makeApprovalRuntime(port, token);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const noAuth = await fetch(`http://127.0.0.1:${port}/api/approvals/audit-log`);
      expect(noAuth.status).toBe(401);

      const wrongAuth = await fetch(`http://127.0.0.1:${port}/api/approvals/audit-log`, {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(wrongAuth.status).toBe(401);

      expect(queryCalls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe("mobile session bootstrap (POST /api/mobile/session/bootstrap)", () => {
  function makeMobileRuntime(
    port: number,
    // The ticket record the fake answers with, or null. Deliberately the record shape rather than
    // `any`: these tests are about what the bootstrap route reads out of a consumed ticket, so the
    // fake has to be held to the same fields the real store returns.
    consumeMobileWebSessionTicket: (
      ticketId: string,
      secret: string,
      context: { transport: "relay" | "legacy"; origins: readonly string[] },
    ) => {
      deviceId: string;
      pairId: string;
      profileId: string;
      allowedOrigin: string;
      transport: "relay" | "legacy";
      requiredCapability: "remote.webSession";
      expiresAt: number;
    } | null,
  ) {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: "unused-master-token" } },
        profiles: [
          { id: "default", name: "Default", color: "#fff", workspaceIds: [] },
          { id: "other", name: "Other", color: "#000", workspaceIds: [] },
        ],
        workspaces: [],
        windowSlots: [],
      },
    };
    let activateProfileForRemoteClientCalls = 0;
    let registry: RemoteClientRegistry;
    return {
      getPayload: () => payload,
      getInitialState: async () => payload,
      setRemoteInfo: () => undefined,
      listRemoteUrls: () => [],
      listMobileTicketOrigins: () => ["https://example.trycloudflare.com"],
      on: () => () => undefined,
      writeToSession: () => undefined,
      resizeSession: () => undefined,
      setRemoteClientRegistry: (value: RemoteClientRegistry) => {
        registry = value;
      },
      consumeMobileWebSessionTicket,
      // Would succeed unconditionally if reached — used to prove the profile-switch block below
      // stops the request BEFORE this ever runs, not just because the stub happens to be absent.
      activateProfileForRemoteClient: async (clientId: string, profileId: string) => {
        activateProfileForRemoteClientCalls++;
        registry.activateProfile(clientId, profileId, payload.appState);
      },
      getActivateProfileForRemoteClientCalls: () => activateProfileForRemoteClientCalls,
    };
  }

  test("a valid ticket mints a session cookie and redirects to a clean '/'", async () => {
    const port = await getFreePort();
    const runtime = makeMobileRuntime(port, (ticketId, secret) => {
      if (ticketId === "ticket-1" && secret === "secret-1") {
        return {
          deviceId: "dev-1",
          pairId: "pair-1",
          profileId: "default",
          allowedOrigin: "https://example.trycloudflare.com",
          transport: "legacy" as const,
          requiredCapability: "remote.webSession" as const,
          expiresAt: Date.now() + 60_000,
        };
      }
      return null;
    });
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: "ticket-1", secret: "secret-1" }),
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      const setCookie = res.headers.get("set-cookie") || "";
      expect(setCookie).toContain("strideterm_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");

      // The minted cookie authenticates subsequent requests — no master token needed.
      const cookieValue = setCookie.split(";")[0];
      const stateRes = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookieValue } });
      expect(stateRes.status).toBe(200);
      expect(stateRes.headers.get("cache-control")).toBe("no-store");
    } finally {
      await server.close();
    }
  });

  test("an unknown/expired/wrong-secret ticket gets a generic 401 with no cookie set", async () => {
    const port = await getFreePort();
    const runtime = makeMobileRuntime(port, () => null);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: "nope", secret: "nope" }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    } finally {
      await server.close();
    }
  });

  test("rejects a malformed body with 400 (missing ticketId/secret)", async () => {
    const previousAudit = await readAuditLog("remote-api-audit");
    const port = await getFreePort();
    const runtime = makeMobileRuntime(port, () => null);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixtureSecret: "do-not-log-schema-marker" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
    await vi.waitFor(async () => {
      const audit = (await readAuditLog("remote-api-audit")).slice(previousAudit.length);
      expect(audit).toContain('"routeCategory":"mobile-session-bootstrap"');
      expect(audit).toContain('"statusCode":400');
      expect(audit).toContain('"reason":"invalid-schema"');
      expect(audit).not.toContain("do-not-log-schema-marker");
    });
  });

  test("logs a body parse failure without including request content", async () => {
    const previousAudit = await readAuditLog("remote-api-audit");
    const port = await getFreePort();
    const runtime = makeMobileRuntime(port, () => null);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"fixtureSecret":"do-not-log-body-marker"',
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
    await vi.waitFor(async () => {
      const audit = (await readAuditLog("remote-api-audit")).slice(previousAudit.length);
      expect(audit).toContain('"routeCategory":"mobile-session-bootstrap"');
      expect(audit).toContain('"statusCode":400');
      expect(audit).toContain('"reason":"body-read"');
      expect(audit).not.toContain("do-not-log-body-marker");
    });
  });

  test("this route requires no master token or existing session — it is reachable with no Authorization/cookie at all", async () => {
    // Implicitly proven by every request above (none carry Authorization or
    // a Cookie header) — asserted explicitly here so a future accidental
    // insertion before the generic isAuthorized() gate is caught immediately.
    const port = await getFreePort();
    const runtime = makeMobileRuntime(port, () => null);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: "x", secret: "y" }),
      });
      // Reached the route logic (401 from the ticket store, not 401 from the
      // generic isAuthorized() gate that guards every other /api/* route).
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("rate-limits repeated bootstrap attempts from the same client", async () => {
    const port = await getFreePort();
    const runtime = makeMobileRuntime(port, () => null);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) {
        const res = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticketId: `t-${i}`, secret: "x" }),
        });
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(0);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      // Once tripped, it stays tripped for the remainder of the window.
      expect(statuses[statuses.length - 1]).toBe(429);
    } finally {
      await server.close();
    }
  });

  test("a mobile session cannot pivot to a different profile via /api/remote-client/profile/activate", async () => {
    // Found via an adversarial security review: activateProfile (remote-client-registry.ts) only
    // checks the TARGET profile exists, never that the caller is authorized to switch to it — so
    // without this block, a mobile session bootstrapped for its one allowlisted profile ("default")
    // could call profile/activate to pivot to any other profile ("other"), bypassing the device's
    // profileAllowlist entirely.
    const port = await getFreePort();
    const runtime = makeMobileRuntime(port, (ticketId, secret) => {
      if (ticketId === "ticket-1" && secret === "secret-1") {
        return {
          deviceId: "dev-1",
          pairId: "pair-1",
          profileId: "default",
          allowedOrigin: "https://example.trycloudflare.com",
          transport: "legacy" as const,
          requiredCapability: "remote.webSession" as const,
          expiresAt: Date.now() + 60_000,
        };
      }
      return null;
    });
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const bootstrapRes = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: "ticket-1", secret: "secret-1" }),
        redirect: "manual",
      });
      const cookieValue = (bootstrapRes.headers.get("set-cookie") || "").split(";")[0];

      const activateRes = await fetch(`${baseUrl}/api/remote-client/profile/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieValue },
        body: JSON.stringify({ profileId: "other" }),
      });
      expect(activateRes.status).toBe(403);
      expect(runtime.getActivateProfileForRemoteClientCalls()).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("an authorized profile switch keeps the mobile cookie and follows target revocation", async () => {
    const port = await getFreePort();
    const runtime = makeMobileRuntime(port, (ticketId, secret) => {
      if (ticketId === "ticket-1" && secret === "secret-1") {
        return {
          deviceId: "dev-1",
          pairId: "pair-1",
          profileId: "default",
          allowedOrigin: "https://example.trycloudflare.com",
          transport: "legacy" as const,
          requiredCapability: "remote.webSession" as const,
          expiresAt: Date.now() + 60_000,
        };
      }
      return null;
    });
    let allowOther = true;
    const isMobileSessionStillAuthorized = vi.fn(
      (_deviceId: string, profileId: string) => profileId === "default" || (profileId === "other" && allowOther),
    );
    const server = await startRemoteServer({
      runtime: { ...runtime, isMobileSessionStillAuthorized } as unknown as Parameters<
        typeof startRemoteServer
      >[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const bootstrapRes = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: "ticket-1", secret: "secret-1" }),
        redirect: "manual",
      });
      const cookieValue = (bootstrapRes.headers.get("set-cookie") || "").split(";")[0];

      const activateRes = await fetch(`${baseUrl}/api/remote-client/profile/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieValue },
        body: JSON.stringify({ profileId: "other" }),
      });
      expect(activateRes.status).toBe(200);
      expect(activateRes.headers.get("set-cookie")).toBeNull();
      expect(runtime.getActivateProfileForRemoteClientCalls()).toBe(1);
      expect(isMobileSessionStillAuthorized).toHaveBeenCalledWith("dev-1", "other");
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookieValue } })).status).toBe(200);
      allowOther = false;
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookieValue } })).status).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("the session is scoped by the ticket record, not by profile/capabilities/deviceId in the request body", async () => {
    // Review §6 ("wrong origin/device/profile/secret is rejected") and plan §10.6: "Ticket endpoint
    // nesmí přijímat profile/capabilities z klienta jako autoritativní; načte je z ticket recordu."
    // handleMobileSessionBootstrap says so in a doc comment and the request schema happens to drop
    // unknown keys — both of which a later edit could undo silently, because a session scoped to a
    // client-declared profile/device behaves identically on the happy path.
    //
    // deviceId is the field with an observable consequence here, so it is the one asserted: it is
    // what revocation matches on, and mintMobileSession builds the whole session record from that
    // same one ticket object, so a body that cannot reach deviceId cannot reach profileId or
    // capabilities either.
    const port = await getFreePort();
    const runtime = makeMobileRuntime(port, (ticketId, secret) => {
      if (ticketId === "ticket-1" && secret === "secret-1") {
        return {
          deviceId: "dev-1",
          pairId: "pair-1",
          profileId: "default",
          allowedOrigin: "https://example.trycloudflare.com",
          transport: "legacy" as const,
          requiredCapability: "remote.webSession" as const,
          expiresAt: Date.now() + 60_000,
        };
      }
      return null;
    });
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const bootstrapRes = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Everything after `secret` is the attack: a client declaring the profile, capabilities and
        // device it would rather the session had.
        body: JSON.stringify({
          ticketId: "ticket-1",
          secret: "secret-1",
          profileId: "other",
          capabilities: ["remote.request", "remote.admin"],
          deviceId: "some-other-device",
          allowedOrigin: "https://attacker.example",
        }),
        redirect: "manual",
      });
      // The extra keys are ignored, not a 400 — the point is that they carry no authority, and a
      // session is still minted from the ticket record alone.
      expect(bootstrapRes.status).toBe(302);
      const cookieValue = (bootstrapRes.headers.get("set-cookie") || "").split(";")[0];
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookieValue } })).status).toBe(200);

      // The session is bound to the ticket record's device, not the one the body named: revoking
      // the body's claim leaves it alive, revoking the record's kills it.
      server.revokeMobileSessionsForDevice!("some-other-device");
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookieValue } })).status).toBe(200);
      server.revokeMobileSessionsForDevice!("dev-1");
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookieValue } })).status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("mobile device revoke closes remote sessions", () => {
  function makeMobileRuntime(port: number) {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: "unused-master-token" } },
        profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: [] }],
        workspaces: [],
        windowSlots: [],
      },
    };
    const tickets = new Map<string, { deviceId: string; pairId: string; profileId: string }>();
    return {
      payload,
      seedTicket(ticketId: string, secret: string, deviceId: string) {
        tickets.set(`${ticketId}:${secret}`, { deviceId, pairId: "pair-1", profileId: "default" });
      },
      runtime: {
        getPayload: () => payload,
        getInitialState: async () => payload,
        setRemoteInfo: () => undefined,
        listRemoteUrls: () => [],
        on: () => () => undefined,
        writeToSession: () => undefined,
        resizeSession: () => undefined,
        setRemoteClientRegistry: () => undefined,
        // The origins this server answers on. A ticket is bound to one of them, so a server that
        // reports none can redeem nothing — which is the new invariant, not an artefact of the fake.
        listMobileTicketOrigins: () => ["https://example.trycloudflare.com"],
        consumeMobileWebSessionTicket: (
          ticketId: string,
          secret: string,
          context: { transport: "relay" | "legacy"; origins: readonly string[] },
        ) => {
          const record = tickets.get(`${ticketId}:${secret}`);
          if (!record) return null;
          tickets.delete(`${ticketId}:${secret}`); // single-use, mirrors the real store
          // The real store compares the transport and the origin; this double records that it was
          // ASKED, so a caller that stopped passing a context would fail here rather than silently.
          if (context.transport !== "legacy" || context.origins.length === 0) return null;
          return {
            ...record,
            allowedOrigin: "https://example.trycloudflare.com",
            transport: "legacy" as const,
            requiredCapability: "remote.webSession" as const,
            expiresAt: Date.now() + 60_000,
          };
        },
      },
    };
  }

  async function bootstrapSession(baseUrl: string, ticketId: string, secret: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId, secret }),
      redirect: "manual",
    });
    const setCookie = res.headers.get("set-cookie") || "";
    return setCookie.split(";")[0];
  }

  test("revoking a device removes its session and closes its open WebSocket; a subsequent request with the old cookie is unauthorized", async () => {
    const port = await getFreePort();
    const { seedTicket, runtime } = makeMobileRuntime(port);
    seedTicket("t1", "s1", "dev-1");
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const cookieValue = await bootstrapSession(baseUrl, "t1", "s1");
      expect(cookieValue).toContain("strideterm_session=");

      // Confirm the session works before revoke.
      const beforeRevoke = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookieValue } });
      expect(beforeRevoke.status).toBe(200);

      // Open a WS bound to this cookie session (the ws upgrade request carries
      // the Cookie header, same as a browser would).
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookieValue } });
      let closeCode: number | null = null;
      const opened = new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      const closed = new Promise<void>((resolve) => {
        ws.on("close", (code: number) => {
          closeCode = code;
          resolve();
        });
      });
      await opened;

      expect(server.revokeMobileSessionsForDevice).toBeDefined();
      server.revokeMobileSessionsForDevice!("dev-1");
      await closed;
      expect(closeCode).toBe(1008);

      const afterRevoke = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookieValue } });
      expect(afterRevoke.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("revoking one device does not affect another device's active session", async () => {
    const port = await getFreePort();
    const { seedTicket, runtime } = makeMobileRuntime(port);
    seedTicket("t1", "s1", "dev-1");
    seedTicket("t2", "s2", "dev-2");
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const cookie1 = await bootstrapSession(baseUrl, "t1", "s1");
      const cookie2 = await bootstrapSession(baseUrl, "t2", "s2");

      server.revokeMobileSessionsForDevice!("dev-1");

      const dev1Res = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie1 } });
      expect(dev1Res.status).toBe(401);

      const dev2Res = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie2 } });
      expect(dev2Res.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe("the ticket-bootstrap limiter on the relay's loopback origin", () => {
  // Production hardening §5 "Session" 8. Every request the relay forwards arrives from `127.0.0.1`,
  // because the connector is the only client — so a per-address bucket was ONE bucket shared by every
  // paired phone, and one malicious device could exhaust it for all of them. The relay states which
  // device it verified in a header this instance accepts only alongside the connector's guard secret,
  // and the bucket is keyed on that.
  const GUARD_TOKEN = "guard-secret-for-the-bootstrap-limiter-test";

  function makeLoopbackRuntime(port: number) {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: false, host: "0.0.0.0", port, token: "unused-master-token" } },
        profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: [] }],
        workspaces: [],
        windowSlots: [],
      },
    };
    return {
      runtime: {
        getPayload: () => payload,
        getInitialState: async () => payload,
        setRemoteInfo: () => undefined,
        listRemoteUrls: () => [],
        on: () => () => undefined,
        writeToSession: () => undefined,
        resizeSession: () => undefined,
        addRemoteClientRegistry: () => () => undefined,
        isMobileSessionStillAuthorized: () => true,
        // Every attempt below carries a secret that matches nothing, so the store answers null and the
        // route answers 401 — which is what makes the RATE the only thing under test. A double that
        // succeeded would conflate "the limiter let this through" with "the ticket was good".
        consumeMobileWebSessionTicket: () => null,
      },
    };
  }

  async function attempt(baseUrl: string, deviceId: string): Promise<number> {
    const response = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Strideterm-Relay-Origin": GUARD_TOKEN,
        // What the Durable Object stamps on a forwarded viewer request. A browser cannot set it: the
        // relay strips both of its own prefixes from whatever arrived before it adds its own.
        "X-Strideterm-Relay-Device": deviceId,
      },
      body: JSON.stringify({ ticketId: "t", secret: "s" }),
      redirect: "manual",
    });
    return response.status;
  }

  test("one device exhausting its own bucket does not lock out another device", async () => {
    const port = await getFreePort();
    const { runtime } = makeLoopbackRuntime(port);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      loopbackOrigin: {
        host: "127.0.0.1",
        port: 0,
        guardToken: GUARD_TOKEN,
        publicOrigin: "https://relay.strideterm.test",
      },
    });
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;
    try {
      // The limiter's window allows twenty per key per minute. Twenty-five from one device.
      const noisy: number[] = [];
      for (let i = 0; i < 25; i++) noisy.push(await attempt(baseUrl, "mobile-noisy"));
      expect(noisy.filter((status) => status === 429).length).toBeGreaterThan(0);

      // The other phone is untouched: it gets the ordinary refusal for a bad ticket, not a 429.
      // Before the header existed, both devices shared `127.0.0.1` and this was a 429.
      expect(await attempt(baseUrl, "mobile-quiet")).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("the device header is ignored on the LAN server, where nothing upstream verified it", async () => {
    // On the legacy instance the header is a claim by the caller, and believing it would hand every
    // caller a fresh bucket per made-up device id — the sharding the plan warns about, in the one
    // place where the relay is not there to have verified anything.
    const port = await getFreePort();
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: "unused-master-token" } },
        profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: [] }],
        workspaces: [],
        windowSlots: [],
      },
    };
    const server = await startRemoteServer({
      runtime: {
        getPayload: () => payload,
        getInitialState: async () => payload,
        setRemoteInfo: () => undefined,
        listRemoteUrls: () => [],
        on: () => () => undefined,
        writeToSession: () => undefined,
        resizeSession: () => undefined,
        setRemoteClientRegistry: () => undefined,
        consumeMobileWebSessionTicket: () => null,
      } as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) {
        const response = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // A different claimed device every time. If the LAN server believed it, every request
            // would land in its own bucket and none of them would ever be limited.
            "X-Strideterm-Relay-Device": `mobile-claimed-${i}`,
          },
          body: JSON.stringify({ ticketId: "t", secret: "s" }),
          redirect: "manual",
        });
        statuses.push(response.status);
      }
      expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});

describe("the mobile session cookie's attributes", () => {
  // Production hardening §9's last row: assert `HttpOnly`, `Secure`, `SameSite=Strict`, the path and
  // the clearing attributes explicitly rather than trusting the string that builds them.
  //
  // WHY THE FORWARDED HEADER IS THE INTERESTING CASE. Over the relay the socket this server sees is
  // plain HTTP on loopback — the connector is the client — while the browser's own hop to the relay
  // is TLS. `Secure` is therefore decided by `X-Forwarded-Proto`, which the connector sets, and that
  // is exactly the decision worth testing: without it a phone reaching the desktop over HTTPS would
  // be handed a cookie it also sends over plain HTTP, and with it wrong in the other direction the
  // LAN bootstrap would hand out a cookie the browser refuses to return.
  function makeCookieRuntime(port: number) {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: "unused-master-token" } },
        profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: [] }],
        workspaces: [],
        windowSlots: [],
      },
    };
    const tickets = new Map<string, { deviceId: string; pairId: string; profileId: string }>();
    return {
      seedTicket(ticketId: string, secret: string) {
        tickets.set(`${ticketId}:${secret}`, { deviceId: "dev-1", pairId: "pair-1", profileId: "default" });
      },
      runtime: {
        getPayload: () => payload,
        getInitialState: async () => payload,
        setRemoteInfo: () => undefined,
        listRemoteUrls: () => [],
        listMobileTicketOrigins: () => ["https://example.trycloudflare.com"],
        on: () => () => undefined,
        writeToSession: () => undefined,
        resizeSession: () => undefined,
        setRemoteClientRegistry: () => undefined,
        isMobileSessionStillAuthorized: () => true,
        consumeMobileWebSessionTicket: (ticketId: string, secret: string) => {
          const record = tickets.get(`${ticketId}:${secret}`);
          if (!record) return null;
          tickets.delete(`${ticketId}:${secret}`);
          return {
            ...record,
            allowedOrigin: "https://example.trycloudflare.com",
            transport: "legacy" as const,
            requiredCapability: "remote.webSession" as const,
            expiresAt: Date.now() + 60_000,
          };
        },
      },
    };
  }

  async function bootstrapCookieHeader(baseUrl: string, headers: Record<string, string>): Promise<string> {
    const res = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ ticketId: "t1", secret: "s1" }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    return res.headers.get("set-cookie") || "";
  }

  test("a session reached over HTTPS gets HttpOnly, Secure, SameSite=Strict and Path=/", async () => {
    const port = await getFreePort();
    const { seedTicket, runtime } = makeCookieRuntime(port);
    seedTicket("t1", "s1");
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      // What the relay connector forwards: the browser's hop was TLS even though this one was not.
      const cookie = await bootstrapCookieHeader(`http://127.0.0.1:${port}`, { "X-Forwarded-Proto": "https" });

      expect(cookie).toMatch(/^strideterm_session=[A-Za-z0-9_-]+;/);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Secure");
      // No `Domain`: a cookie scoped to a parent domain is one a sibling host can shadow, and the
      // relay's own session verifier refuses a request carrying two of them for exactly that reason.
      expect(cookie).not.toMatch(/Domain=/i);
      // And no `Max-Age`/`Expires`: the desktop's session record is what bounds it, and a browser
      // cookie that outlived the record would be a credential the server has already forgotten.
      expect(cookie).not.toMatch(/Max-Age=|Expires=/i);
    } finally {
      await server.close();
    }
  });

  test("the same cookie over plain LAN HTTP is not marked Secure, so the LAN bootstrap still works", async () => {
    // The other half of the same decision. A `Secure` cookie is never returned over http://, so
    // marking it unconditionally would break the LAN path — and browsers scope cookies by origin, so
    // an HTTP and an HTTPS deployment never see each other's anyway.
    const port = await getFreePort();
    const { seedTicket, runtime } = makeCookieRuntime(port);
    seedTicket("t1", "s1");
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const cookie = await bootstrapCookieHeader(`http://127.0.0.1:${port}`, {});
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
      expect(cookie).not.toContain("Secure");
    } finally {
      await server.close();
    }
  });

  test("a forged X-Forwarded-Proto cannot make a LAN cookie insecure, because it can only ADD Secure", async () => {
    // The direction that matters: the header is attacker-influenceable on a LAN deployment, so the
    // only thing it may do is make the cookie stricter. `http` — or anything unrecognised — must not
    // strip `Secure` from a deployment that is genuinely behind TLS, and the way that is guaranteed is
    // that the header's only effect is additive.
    const port = await getFreePort();
    const { seedTicket, runtime } = makeCookieRuntime(port);
    seedTicket("t1", "s1");
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const cookie = await bootstrapCookieHeader(`http://127.0.0.1:${port}`, {
        "X-Forwarded-Proto": "gopher, https",
      });
      // First value wins and it is not https, so no Secure — and nothing else about the cookie moved.
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toContain("Secure");
    } finally {
      await server.close();
    }
  });
});

describe("a mobile session is finite", () => {
  /**
   * The same fake as the revoke block above, plus a switch for the device's current authorization.
   *
   * `isMobileSessionStillAuthorized` is what the server asks on every request, and it is the only way
   * a capability or profile-allowlist change reaches a live session — neither is a revoke, so nothing
   * pushes it.
   */
  function makeFiniteSessionRuntime(port: number) {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: "unused-master-token" } },
        profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: [] }],
        workspaces: [],
        windowSlots: [],
      },
    };
    const tickets = new Map<string, { deviceId: string; pairId: string; profileId: string }>();
    const authorized = new Set<string>();
    return {
      seedTicket(ticketId: string, secret: string, deviceId: string) {
        tickets.set(`${ticketId}:${secret}`, { deviceId, pairId: "pair-1", profileId: "default" });
        authorized.add(deviceId);
      },
      deauthorize(deviceId: string) {
        authorized.delete(deviceId);
      },
      runtime: {
        getPayload: () => payload,
        getInitialState: async () => payload,
        setRemoteInfo: () => undefined,
        listRemoteUrls: () => [],
        listMobileTicketOrigins: () => ["https://example.trycloudflare.com"],
        on: () => () => undefined,
        writeToSession: () => undefined,
        resizeSession: () => undefined,
        setRemoteClientRegistry: () => undefined,
        isMobileSessionStillAuthorized: (deviceId: string) => authorized.has(deviceId),
        consumeMobileWebSessionTicket: (
          ticketId: string,
          secret: string,
          context: { transport: "relay" | "legacy"; origins: readonly string[] },
        ) => {
          const record = tickets.get(`${ticketId}:${secret}`);
          if (!record) return null;
          tickets.delete(`${ticketId}:${secret}`);
          if (context.transport !== "legacy" || context.origins.length === 0) return null;
          return {
            ...record,
            allowedOrigin: "https://example.trycloudflare.com",
            transport: "legacy" as const,
            requiredCapability: "remote.webSession" as const,
            expiresAt: Date.now() + 60_000,
          };
        },
      },
    };
  }

  async function bootstrap(baseUrl: string, ticketId: string, secret: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId, secret }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") || "").split(";")[0]!;
  }

  test("the absolute deadline closes a live WebSocket with no traffic at all, and the cookie then 401s", async () => {
    // The case a request-path check cannot reach: an open terminal socket that nobody is typing on.
    // Before the sweep existed, this session lived until the process restarted.
    const port = await getFreePort();
    const { seedTicket, runtime } = makeFiniteSessionRuntime(port);
    seedTicket("t1", "s1", "dev-1");
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      mobileSessionAbsoluteTtlMs: 400,
      mobileSessionIdleTtlMs: 60_000,
      mobileSessionSweepMs: 50,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const cookie = await bootstrap(baseUrl, "t1", "s1");
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).status).toBe(200);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
      let closeCode: number | null = null;
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      const closed = new Promise<void>((resolve) => {
        ws.on("close", (code: number) => {
          closeCode = code;
          resolve();
        });
      });

      // Nothing is sent on the socket, and nothing is requested over HTTP. The sweep is the only
      // thing that can end this.
      await closed;
      expect(closeCode).toBe(1008);
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).status).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("the idle deadline ends a session that stops being used, and real activity postpones it", async () => {
    const port = await getFreePort();
    const { seedTicket, runtime } = makeFiniteSessionRuntime(port);
    seedTicket("t1", "s1", "dev-1");
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      mobileSessionAbsoluteTtlMs: 60_000,
      mobileSessionIdleTtlMs: 300,
      mobileSessionSweepMs: 50,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const cookie = await bootstrap(baseUrl, "t1", "s1");

      // Three requests inside the idle window keep it alive well past one window's worth of time.
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).status).toBe(200);
      }

      // Then nothing, for longer than the window.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).status).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("a keep-alive message does not postpone the idle deadline; typing does", async () => {
    // Production hardening §5 "Session" 7. `state:sync` is the client telling the server its socket is
    // open; `terminal:input` is the user doing something. A session that a keep-alive could hold open
    // forever has no idle deadline at all.
    const port = await getFreePort();
    const { seedTicket, runtime } = makeFiniteSessionRuntime(port);
    seedTicket("t1", "s1", "dev-1");
    seedTicket("t2", "s2", "dev-2");
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      mobileSessionAbsoluteTtlMs: 60_000,
      mobileSessionIdleTtlMs: 400,
      mobileSessionSweepMs: 1_000_000, // the sweep is out of the way: this is about the message path
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    async function pump(cookie: string, message: unknown, rounds: number): Promise<void> {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      for (let i = 0; i < rounds; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        ws.send(JSON.stringify(message));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      ws.close();
    }

    try {
      // Four keep-alives at 200ms — 800ms of wall clock against a 400ms idle window.
      const keepAliveCookie = await bootstrap(baseUrl, "t1", "s1");
      await pump(keepAliveCookie, { type: "state:sync", rev: 1 }, 4);
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: keepAliveCookie } })).status).toBe(401);

      // The same rhythm, with typing instead. Bootstrapped here rather than above, so its own idle
      // window starts when its pump does — otherwise this would be measuring the first pump's runtime.
      const typingCookie = await bootstrap(baseUrl, "t2", "s2");
      await pump(typingCookie, { type: "terminal:input", sessionId: "s", data: "x" }, 4);
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: typingCookie } })).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  test("the foreground presence message postpones the idle deadline, so watching a terminal is not idle", async () => {
    // 2026-10-05: a phone that only watched output was logged out after the idle window, because only
    // typing, resizing and subscribing counted. The page now sends `client:presence` while visible.
    const port = await getFreePort();
    const { seedTicket, runtime } = makeFiniteSessionRuntime(port);
    seedTicket("t1", "s1", "dev-1");
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      mobileSessionAbsoluteTtlMs: 60_000,
      mobileSessionIdleTtlMs: 400,
      mobileSessionSweepMs: 1_000_000,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const cookie = await bootstrap(baseUrl, "t1", "s1");
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        ws.send(JSON.stringify({ type: "client:presence" }));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      ws.close();
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  test("a capability or profile change ends the session at its next request, without a revoke", async () => {
    const port = await getFreePort();
    const { seedTicket, deauthorize, runtime } = makeFiniteSessionRuntime(port);
    seedTicket("t1", "s1", "dev-1");
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      mobileSessionAbsoluteTtlMs: 60_000,
      mobileSessionIdleTtlMs: 60_000,
      mobileSessionSweepMs: 50,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const cookie = await bootstrap(baseUrl, "t1", "s1");
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).status).toBe(200);

      // Not a revoke: the device is still paired, it just no longer holds what this session needs.
      deauthorize("dev-1");
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).status).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("a browser session with the master token is NOT bounded by these deadlines", async () => {
    // The regression this could easily have been: the deadlines are for ticket-bootstrapped mobile
    // sessions, and the ordinary `?token=` browser/Telegram flow has to be untouched.
    const port = await getFreePort();
    const { runtime } = makeFiniteSessionRuntime(port);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      mobileSessionAbsoluteTtlMs: 100,
      mobileSessionIdleTtlMs: 100,
      mobileSessionSweepMs: 50,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      // The HTML entry point is where a browser session cookie is minted, which is the flow a person
      // opening the share URL actually takes.
      const first = await fetch(`${baseUrl}/?token=unused-master-token`, { redirect: "manual" });
      expect([200, 302, 304]).toContain(first.status);
      const cookie = (first.headers.get("set-cookie") || "").split(";")[0]!;
      expect(cookie).toContain("strideterm_session=");

      // Well past both deadlines, and several sweeps later.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe("a mobile session's activity is audited (metadata only)", () => {
  type AuditRow = { deviceId: string; pairId: string; action: string; status: string; detail?: string };

  /**
   * A mobile-ticket runtime that also records what `recordMobileSessionAudit` is handed. The one
   * workspace ("ws1", in the ticket's profile) gives terminal ids of the form `ws1:<n>` a profile to
   * belong to, and `cwd` is the root the file routes are allowed to name.
   */
  function makeAuditedRuntime(
    port: number,
    cwd: string,
    options: { auditThrows?: boolean; publishThrows?: boolean } = {},
  ) {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: "unused-master-token" } },
        profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: ["ws1"] }],
        workspaces: [{ id: "ws1", profileId: "default", cwd }],
        windowSlots: [],
      },
    };
    const rows: AuditRow[] = [];
    const lists: { sessions: unknown[]; source?: string }[] = [];
    const written: { sessionId: string; data: string }[] = [];
    const tickets = new Map<string, { deviceId: string; pairId: string; profileId: string }>();
    return {
      rows,
      lists,
      written,
      seedTicket(ticketId: string, secret: string, deviceId: string) {
        tickets.set(`${ticketId}:${secret}`, { deviceId, pairId: `pair-${deviceId}`, profileId: "default" });
      },
      runtime: {
        getPayload: () => payload,
        getInitialState: async () => payload,
        setRemoteInfo: () => undefined,
        listRemoteUrls: () => [],
        listMobileTicketOrigins: () => ["https://example.trycloudflare.com"],
        on: () => () => undefined,
        writeToSession: (sessionId: string, data: string) => {
          written.push({ sessionId, data });
        },
        resizeSession: () => undefined,
        setRemoteClientRegistry: () => undefined,
        isMobileSessionStillAuthorized: () => true,
        recordMobileSessionAudit: (entry: AuditRow) => {
          if (options.auditThrows) throw new Error("audit store is down");
          rows.push(entry);
        },
        onMobileSessionsChanged: (sessions: unknown[], source?: string) => {
          lists.push({ sessions, source });
          if (options.publishThrows) throw new Error("runtime is down");
        },
        consumeMobileWebSessionTicket: (
          ticketId: string,
          secret: string,
          context: { transport: "relay" | "legacy"; origins: readonly string[] },
        ) => {
          const record = tickets.get(`${ticketId}:${secret}`);
          if (!record) return null;
          tickets.delete(`${ticketId}:${secret}`);
          if (context.transport !== "legacy" || context.origins.length === 0) return null;
          return {
            ...record,
            allowedOrigin: "https://example.trycloudflare.com",
            transport: "legacy" as const,
            requiredCapability: "remote.webSession" as const,
            expiresAt: Date.now() + 60_000,
          };
        },
      },
    };
  }

  async function bootstrap(baseUrl: string, ticketId: string, secret: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId, secret }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") || "").split(";")[0]!;
  }

  async function openSocket(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
    const ws = new WebSocket(url, { headers });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    return ws;
  }

  async function withAuditedServer(
    options: {
      auditThrows?: boolean;
      publishThrows?: boolean;
      server?: Partial<Parameters<typeof startRemoteServer>[0]>;
    },
    body: (ctx: {
      baseUrl: string;
      port: number;
      dir: string;
      rows: AuditRow[];
      lists: { sessions: unknown[]; source?: string }[];
      written: { sessionId: string; data: string }[];
      seedTicket: (ticketId: string, secret: string, deviceId: string) => void;
      server: Awaited<ReturnType<typeof startRemoteServer>>;
    }) => Promise<void>,
  ): Promise<void> {
    // realpath: on macOS os.tmpdir() is under /var, which the file manager refuses as a system path.
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-mobile-audit-")));
    const port = await getFreePort();
    const { runtime, rows, lists, written, seedTicket } = makeAuditedRuntime(port, dir, options);
    fm.setAllowedRootsResolver(() => [dir]);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      ...options.server,
    });
    try {
      await body({ baseUrl: `http://127.0.0.1:${port}`, port, dir, rows, lists, written, seedTicket, server });
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  test("bootstrap records session.started with the profile and transport", async () => {
    await withAuditedServer({}, async ({ baseUrl, rows, seedTicket }) => {
      seedTicket("t1", "s1", "dev-1");
      expect(await bootstrap(baseUrl, "t1", "s1")).toContain("strideterm_session=");
      expect(rows).toEqual([
        {
          deviceId: "dev-1",
          pairId: "pair-dev-1",
          action: "session.started",
          status: "success",
          detail: expect.stringMatching(/^profile=default transport=legacy sessionRef=cookie:[0-9a-f]{12}$/),
        },
      ]);
    });
  });

  describe("the live mobile session list is published to the runtime", () => {
    test("bootstrap publishes the device with its profile and start time, and never the session or pair id", async () => {
      await withAuditedServer({}, async ({ baseUrl, lists, seedTicket }) => {
        seedTicket("t1", "s1", "dev-1");
        const cookie = await bootstrap(baseUrl, "t1", "s1");
        const sessionId = decodeURIComponent(cookie.split("=")[1]!);
        expect(lists).toHaveLength(1);
        expect(lists[0]!.source).toBe("direct");
        expect(lists[0]!.sessions).toEqual([
          { deviceId: "dev-1", profileId: "default", startedAt: expect.any(Number) },
        ]);
        const serialized = JSON.stringify(lists);
        expect(serialized).not.toContain(sessionId);
        expect(serialized).not.toContain("pair-dev-1");
        expect(serialized).not.toContain("sessionId");
        expect(serialized).not.toContain("pairId");
      });
    });

    test("a second phone is added to the list; ending one leaves the other", async () => {
      await withAuditedServer({}, async ({ baseUrl, lists, seedTicket, server }) => {
        seedTicket("t1", "s1", "dev-1");
        seedTicket("t2", "s2", "dev-2");
        await bootstrap(baseUrl, "t1", "s1");
        await bootstrap(baseUrl, "t2", "s2");
        expect((lists.at(-1)!.sessions as { deviceId: string }[]).map((s) => s.deviceId)).toEqual(["dev-1", "dev-2"]);
        server.revokeMobileSessionsForDevice!("dev-1");
        expect((lists.at(-1)!.sessions as { deviceId: string }[]).map((s) => s.deviceId)).toEqual(["dev-2"]);
      });
    });

    test("a revoke publishes an empty list, and revoking a device with no session publishes nothing", async () => {
      await withAuditedServer({}, async ({ baseUrl, lists, seedTicket, server }) => {
        seedTicket("t1", "s1", "dev-1");
        await bootstrap(baseUrl, "t1", "s1");
        server.revokeMobileSessionsForDevice!("someone-else");
        expect(lists).toHaveLength(1);
        server.revokeMobileSessionsForDevice!("dev-1");
        expect(lists).toHaveLength(2);
        expect(lists[1]!.sessions).toEqual([]);
      });
    });

    test("an expired session publishes an empty list", async () => {
      await withAuditedServer(
        { server: { mobileSessionAbsoluteTtlMs: 300, mobileSessionIdleTtlMs: 60_000, mobileSessionSweepMs: 50 } },
        async ({ baseUrl, lists, seedTicket }) => {
          seedTicket("t1", "s1", "dev-1");
          await bootstrap(baseUrl, "t1", "s1");
          await vi.waitFor(() => expect(lists.at(-1)?.sessions).toEqual([]));
          expect(lists).toHaveLength(2);
        },
      );
    });

    test("a master-token browser session never appears, and ending it publishes nothing", async () => {
      await withAuditedServer({}, async ({ baseUrl, lists }) => {
        const first = await fetch(`${baseUrl}/?token=unused-master-token`, { redirect: "manual" });
        expect((first.headers.get("set-cookie") || "").split(";")[0]).toContain("strideterm_session=");
        expect(lists).toEqual([]);
      });
    });

    test("stopping the server publishes an empty list", async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-mobile-audit-")));
      const port = await getFreePort();
      const { runtime, lists, seedTicket } = makeAuditedRuntime(port, dir);
      const server = await startRemoteServer({
        runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
        staticRoot: process.cwd(),
      });
      try {
        seedTicket("t1", "s1", "dev-1");
        await bootstrap(`http://127.0.0.1:${port}`, "t1", "s1");
        expect(lists.at(-1)!.sessions).toHaveLength(1);
      } finally {
        await server.close();
        await fs.rm(dir, { recursive: true, force: true });
      }
      expect(lists.at(-1)!.sessions).toEqual([]);
    });

    test("a publisher that throws does not break the bootstrap", async () => {
      await withAuditedServer({ publishThrows: true }, async ({ baseUrl, seedTicket }) => {
        seedTicket("t1", "s1", "dev-1");
        expect(await bootstrap(baseUrl, "t1", "s1")).toContain("strideterm_session=");
      });
    });
  });

  test("a browser session with the master token records nothing", async () => {
    await withAuditedServer({}, async ({ baseUrl, rows }) => {
      const first = await fetch(`${baseUrl}/?token=unused-master-token`, { redirect: "manual" });
      expect((first.headers.get("set-cookie") || "").split(";")[0]).toContain("strideterm_session=");
      expect(rows).toEqual([]);
    });
  });

  test("the absolute deadline records session.ended with its reason", async () => {
    await withAuditedServer(
      { server: { mobileSessionAbsoluteTtlMs: 300, mobileSessionIdleTtlMs: 60_000, mobileSessionSweepMs: 50 } },
      async ({ baseUrl, rows, seedTicket }) => {
        seedTicket("t1", "s1", "dev-1");
        await bootstrap(baseUrl, "t1", "s1");
        await vi.waitFor(() => expect(rows.map((r) => r.action)).toEqual(["session.started", "session.ended"]));
        expect(rows[1]).toMatchObject({ deviceId: "dev-1", status: "success", detail: "reason=absolute-expired" });
      },
    );
  });

  test("the idle deadline records session.ended with reason=idle-expired", async () => {
    const previousAudit = await readAuditLog("remote-api-audit");
    await withAuditedServer(
      { server: { mobileSessionAbsoluteTtlMs: 60_000, mobileSessionIdleTtlMs: 200, mobileSessionSweepMs: 50 } },
      async ({ baseUrl, rows, seedTicket }) => {
        seedTicket("t1", "s1", "dev-1");
        seedTicket("t2", "s2", "dev-2"); // a DIFFERENT device: the same one would supersede the first
        const firstCookie = await bootstrap(baseUrl, "t1", "s1");
        const secondCookie = await bootstrap(baseUrl, "t2", "s2");
        await vi.waitFor(() => expect(rows.filter((row) => row.action === "session.ended")).toHaveLength(2));
        expect(
          rows.filter((row) => row.action === "session.ended").every((row) => row.detail === "reason=idle-expired"),
        ).toBe(true);
        await vi.waitFor(async () => {
          const audit = (await readAuditLog("remote-api-audit")).slice(previousAudit.length);
          const sessionRefs = (message: string) =>
            audit
              .split("\n")
              .filter((line) => line.includes(message))
              .map((line) => line.match(/"sessionRef":"(cookie:[a-f0-9]{12})"/)?.[1]);
          const started = sessionRefs("mobile session bootstrap succeeded");
          const ended = sessionRefs("mobile session ended");
          expect(started).toHaveLength(2);
          expect(new Set(started).size).toBe(2);
          expect(started.every((ref) => ref !== undefined)).toBe(true);
          expect(ended.sort()).toEqual(started.sort());
          expect(audit).not.toContain(firstCookie.split("=")[1]);
          expect(audit).not.toContain(secondCookie.split("=")[1]);
        });
      },
    );
  });

  test("a new bootstrap by the same device ends the previous session as superseded and closes its sockets", async () => {
    // 2026-10-05: the replaced session used to linger until its 30 minute idle deadline.
    await withAuditedServer({}, async ({ baseUrl, port, rows, seedTicket }) => {
      seedTicket("t1", "s1", "dev-1");
      seedTicket("t2", "s2", "dev-1");
      const first = await bootstrap(baseUrl, "t1", "s1");
      const ws = await openSocket(`ws://127.0.0.1:${port}/ws`, { Cookie: first });
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        ws.on("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString("utf8") })),
      );
      const second = await bootstrap(baseUrl, "t2", "s2");
      expect(await closed).toEqual({ code: 1008, reason: "superseded" });
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: first } })).status).toBe(401);
      expect((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: second } })).status).toBe(200);
      expect(rows.filter((r) => r.action === "session.ended").map((r) => r.detail)).toEqual(["reason=superseded"]);
    });
  });

  test("a revoke records session.ended with reason=revoked, once, after flushing pending terminal input", async () => {
    await withAuditedServer({}, async ({ baseUrl, port, rows, written, seedTicket, server }) => {
      seedTicket("t1", "s1", "dev-1");
      const cookie = await bootstrap(baseUrl, "t1", "s1");
      const ws = await openSocket(`ws://127.0.0.1:${port}/ws`, { Cookie: cookie });
      ws.send(JSON.stringify({ type: "terminal:input", sessionId: "ws1:1", data: "abc" }));
      await vi.waitFor(() => expect(written).toHaveLength(1));
      server.revokeMobileSessionsForDevice!("dev-1");
      server.revokeMobileSessionsForDevice!("dev-1");
      expect(rows.map((r) => `${r.action} ${r.detail}`)).toEqual([
        expect.stringMatching(/^session.started profile=default transport=legacy sessionRef=cookie:[0-9a-f]{12}$/),
        "session.terminal-input terminal=ws1:1 bytes=3 lines=0",
        "session.ended reason=revoked",
      ]);
    });
  });

  test("stopping the server records session.ended with reason=server-stopped for each live mobile session", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-mobile-audit-")));
    const port = await getFreePort();
    const { runtime, rows, seedTicket } = makeAuditedRuntime(port, dir);
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      seedTicket("t1", "s1", "dev-1");
      await bootstrap(`http://127.0.0.1:${port}`, "t1", "s1");
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
    expect(rows.map((r) => `${r.action} ${r.detail}`)).toEqual([
      expect.stringMatching(/^session.started profile=default transport=legacy sessionRef=cookie:[0-9a-f]{12}$/),
      "session.ended reason=server-stopped",
    ]);
  });

  test("terminal input is aggregated into one row per submitted command, with counts and never the text", async () => {
    await withAuditedServer({}, async ({ baseUrl, port, rows, written, seedTicket }) => {
      seedTicket("t1", "s1", "dev-1");
      const cookie = await bootstrap(baseUrl, "t1", "s1");
      const ws = await openSocket(`ws://127.0.0.1:${port}/ws`, { Cookie: cookie });
      const send = (data: string) => ws.send(JSON.stringify({ type: "terminal:input", sessionId: "ws1:1", data }));
      send("hunter");
      send("2-secret");
      send("\r");
      await vi.waitFor(() => expect(written).toHaveLength(3));
      ws.close();

      const inputRows = rows.filter((r) => r.action === "session.terminal-input");
      expect(inputRows).toHaveLength(1);
      expect(inputRows[0]).toMatchObject({
        deviceId: "dev-1",
        pairId: "pair-dev-1",
        status: "success",
        detail: "terminal=ws1:1 bytes=15 lines=1",
      });
      expect(JSON.stringify(rows)).not.toContain("hunter");
      expect(JSON.stringify(rows)).not.toContain("secret");
    });
  });

  test("input for two terminals is aggregated separately, and CRLF counts as one line", async () => {
    await withAuditedServer({}, async ({ baseUrl, port, rows, written, seedTicket }) => {
      seedTicket("t1", "s1", "dev-1");
      const cookie = await bootstrap(baseUrl, "t1", "s1");
      const ws = await openSocket(`ws://127.0.0.1:${port}/ws`, { Cookie: cookie });
      const send = (sessionId: string, data: string) =>
        ws.send(JSON.stringify({ type: "terminal:input", sessionId, data }));
      send("ws1:1", "ls");
      send("ws1:2", "pwd\r\n");
      send("ws1:1", "\n");
      await vi.waitFor(() => expect(written).toHaveLength(3));
      ws.close();
      expect(rows.filter((r) => r.action === "session.terminal-input").map((r) => r.detail)).toEqual([
        "terminal=ws1:2 bytes=5 lines=1",
        "terminal=ws1:1 bytes=3 lines=1",
      ]);
    });
  });

  test("input with no newline is flushed after the quiet period", async () => {
    await withAuditedServer(
      { server: { mobileTerminalInputFlushMs: 100 } },
      async ({ baseUrl, port, rows, seedTicket }) => {
        seedTicket("t1", "s1", "dev-1");
        const cookie = await bootstrap(baseUrl, "t1", "s1");
        const ws = await openSocket(`ws://127.0.0.1:${port}/ws`, { Cookie: cookie });
        ws.send(JSON.stringify({ type: "terminal:input", sessionId: "ws1:1", data: "ab" }));
        ws.send(JSON.stringify({ type: "terminal:input", sessionId: "ws1:1", data: "cd" }));
        await vi.waitFor(() =>
          expect(rows.filter((r) => r.action === "session.terminal-input").map((r) => r.detail)).toEqual([
            "terminal=ws1:1 bytes=4 lines=0",
          ]),
        );
        ws.close();
      },
    );
  });

  test("the same input from a master-token client (bound or unbound) records nothing", async () => {
    await withAuditedServer({ server: { mobileTerminalInputFlushMs: 50 } }, async ({ port, rows, written }) => {
      const unbound = await openSocket(`ws://127.0.0.1:${port}/ws?token=unused-master-token`);
      const bound = await openSocket(`ws://127.0.0.1:${port}/ws?token=unused-master-token&clientId=client-abcdef12`);
      for (const ws of [unbound, bound]) {
        ws.send(JSON.stringify({ type: "terminal:input", sessionId: "ws1:1", data: "ls\r" }));
        ws.send(JSON.stringify({ type: "terminal:input", sessionId: "ws1:1", data: "pw" }));
      }
      await vi.waitFor(() => expect(written).toHaveLength(4));
      await new Promise((resolve) => setTimeout(resolve, 200)); // past the flush period
      unbound.close();
      bound.close();
      expect(rows).toEqual([]);
    });
  });

  test("file reads are recorded with the path and outcome, listings are not", async () => {
    await withAuditedServer({}, async ({ baseUrl, dir, rows, seedTicket }) => {
      await fs.writeFile(path.join(dir, "a.txt"), "file-body-must-not-be-logged");
      seedTicket("t1", "s1", "dev-1");
      const cookie = await bootstrap(baseUrl, "t1", "s1");
      const post = (route: string, body: unknown) =>
        fetch(`${baseUrl}${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify(body),
        });

      expect((await post("/api/file/list", { rootPath: dir, relativePath: "" })).status).toBe(200);
      expect((await post("/api/file/read", { rootPath: dir, relativePath: "a.txt" })).status).toBe(200);
      expect((await post("/api/file/read", { rootPath: dir, relativePath: "missing.txt" })).status).not.toBe(200);

      const fileRows = rows.filter((r) => r.action === "session.file");
      expect(fileRows.map((r) => ({ status: r.status, detail: r.detail }))).toEqual([
        { status: "success", detail: `op=read root=${JSON.stringify(dir)} path="a.txt"` },
        { status: "failure", detail: `op=read root=${JSON.stringify(dir)} path="missing.txt"` },
      ]);
      expect(fileRows[0]).toMatchObject({ deviceId: "dev-1", pairId: "pair-dev-1" });
      expect(JSON.stringify(rows)).not.toContain("file-body-must-not-be-logged");
    });
  });

  test("a file read with the master token records nothing", async () => {
    await withAuditedServer({}, async ({ baseUrl, dir, rows }) => {
      await fs.writeFile(path.join(dir, "a.txt"), "x");
      const res = await fetch(`${baseUrl}/api/file/read?token=unused-master-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Strideterm-Client-Id": "client-abcdef12" },
        body: JSON.stringify({ rootPath: dir, relativePath: "a.txt" }),
      });
      expect(res.status).toBe(200);
      expect(rows).toEqual([]);
    });
  });

  test("a failing audit sink never breaks the session or the request", async () => {
    await withAuditedServer({ auditThrows: true }, async ({ baseUrl, port, dir, seedTicket }) => {
      await fs.writeFile(path.join(dir, "a.txt"), "x");
      seedTicket("t1", "s1", "dev-1");
      const cookie = await bootstrap(baseUrl, "t1", "s1");
      expect(cookie).toContain("strideterm_session=");
      const res = await fetch(`${baseUrl}/api/file/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ rootPath: dir, relativePath: "a.txt" }),
      });
      expect(res.status).toBe(200);
      const ws = await openSocket(`ws://127.0.0.1:${port}/ws`, { Cookie: cookie });
      ws.send(JSON.stringify({ type: "terminal:input", sessionId: "ws1:1", data: "x\r" }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });
});

describe("the managed relay's loopback-only internal origin", () => {
  const MASTER_TOKEN = "the-users-own-remote-token";
  const GUARD = "guard-secret-for-this-test";
  /** The public origin the relay manager tells a loopback instance it is reachable at. */
  const RELAY_PUBLIC_ORIGIN = "https://relay.strideterm.test";

  /**
   * A payload with remote access DISABLED, on purpose.
   *
   * The relay origin is a different feature with a different flag: turning the relay on must serve
   * the connector even when the user has never enabled remote access, and must not open the LAN
   * listener they did not ask for.
   */
  function makePayload(): Record<string, unknown> {
    return {
      appState: {
        settings: {
          remoteAccess: { enabled: false, host: "0.0.0.0", port: 43123, token: MASTER_TOKEN },
        },
        profiles: [{ id: "p1", name: "P1", color: "#fff", workspaceIds: [] }],
        workspaces: [{ id: "ws1", name: "WS1", profileId: "p1", panels: [{ id: "a" }] }],
        windowSlots: [{ id: "win-1", profileId: "p1", activeWorkspaceId: "ws1" }],
      },
    };
  }

  function makeRuntime(payload: Record<string, unknown>) {
    const calls = {
      setRemoteInfo: 0,
      setRemoteClientRegistry: 0,
      setMobileRemoteSessionRevoker: 0,
      addRemoteClientRegistry: 0,
      releasedRemoteClientRegistry: 0,
    };
    const runtime = {
      getPayload: () => payload,
      getInitialState: async () => payload,
      setRemoteInfo: () => {
        calls.setRemoteInfo += 1;
      },
      listRemoteUrls: () => [],
      on: () => () => undefined,
      writeToSession: () => undefined,
      resizeSession: () => undefined,
      setRemoteClientRegistry: () => {
        calls.setRemoteClientRegistry += 1;
      },
      addRemoteClientRegistry: () => {
        calls.addRemoteClientRegistry += 1;
        return () => {
          calls.releasedRemoteClientRegistry += 1;
        };
      },
      setMobileRemoteSessionRevoker: () => {
        calls.setMobileRemoteSessionRevoker += 1;
      },
    };
    return { runtime, calls };
  }

  test("starts although remote access is disabled, binds loopback, and publishes nothing", async () => {
    const { runtime, calls } = makeRuntime(makePayload());
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      loopbackOrigin: { host: "127.0.0.1", port: 0, guardToken: GUARD, publicOrigin: RELAY_PUBLIC_ORIGIN },
    });
    try {
      expect(server.address?.host).toBe("127.0.0.1");
      expect(server.address!.port).toBeGreaterThan(0);
      // Nothing the PRIMARY server owns: not the URLs the settings UI shows, not the registry the
      // desktop windows and the LAN browser use, not the revoke hook. What it DOES do is add its own
      // registry alongside — without that the runtime cannot resolve a relay viewer at all, so its
      // workspace switch fails and its profile guard silently does not apply.
      expect(calls).toEqual({
        setRemoteInfo: 0,
        setRemoteClientRegistry: 0,
        setMobileRemoteSessionRevoker: 0,
        addRemoteClientRegistry: 1,
        releasedRemoteClientRegistry: 0,
      });
      // Its own revoke hook is handed back instead, for the relay manager to wire up.
      expect(typeof server.revokeMobileSessionsForDevice).toBe("function");
    } finally {
      await server.close();
    }
    // And closing it takes the registry back out, so a stopped relay leaves no viewer behind.
    expect(calls.releasedRemoteClientRegistry).toBe(1);
  });

  test("answers only a caller presenting the guard, on HTTP and on the WebSocket upgrade alike", async () => {
    const previousAudit = await readAuditLog("relay-origin-api-audit");
    const { runtime } = makeRuntime(makePayload());
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      loopbackOrigin: { host: "127.0.0.1", port: 0, guardToken: GUARD, publicOrigin: RELAY_PUBLIC_ORIGIN },
    });
    const base = `http://127.0.0.1:${server.address!.port}`;
    try {
      // Another local process that merely learned the port gets nothing — not even the
      // unauthenticated static route or the unauthenticated mobile bootstrap.
      expect((await fetch(`${base}/`)).status).toBe(403);
      expect((await fetch(`${base}/api/state`)).status).toBe(403);
      expect(
        (
          await fetch(`${base}/api/mobile/session/bootstrap`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticketId: "x", secret: "y" }),
          })
        ).status,
      ).toBe(403);

      // With the guard, the ordinary rules apply again: `/api/*` still needs a session or a token.
      expect((await fetch(`${base}/api/state`, { headers: { "X-Strideterm-Relay-Origin": GUARD } })).status).toBe(401);

      // The user's own master token is NOT this server's token. A leaked LAN token must not become
      // a way into the relay origin.
      expect(
        (
          await fetch(`${base}/api/state`, {
            headers: { "X-Strideterm-Relay-Origin": GUARD, Authorization: `Bearer ${MASTER_TOKEN}` },
          })
        ).status,
      ).toBe(401);

      const rejected = await new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${server.address!.port}/ws`);
        socket.on("error", (error: Error) => resolve(error.message));
        socket.on("open", () => resolve("opened"));
      });
      expect(rejected).toMatch(/403/);
    } finally {
      await server.close();
    }
    await vi.waitFor(async () => {
      const audit = (await readAuditLog("relay-origin-api-audit")).slice(previousAudit.length);
      expect(audit).toContain('"surface":"http"');
      expect(audit).toContain('"surface":"websocket"');
      expect(audit).toContain('"routeCategory":"pre-routing"');
      expect(audit).toContain('"statusCode":403');
      expect(audit).toContain('"reason":"loopback-guard"');
      expect(audit).not.toContain(GUARD);
      expect(audit).not.toContain(MASTER_TOKEN);
    });
  });

  test("refuses to bind anything that is not loopback", async () => {
    const { runtime } = makeRuntime(makePayload());
    await expect(
      startRemoteServer({
        runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
        staticRoot: process.cwd(),
        loopbackOrigin: { host: "0.0.0.0", port: 0, guardToken: GUARD, publicOrigin: RELAY_PUBLIC_ORIGIN },
      }),
    ).rejects.toThrow(/127\.0\.0\.1 or ::1/);
  });

  test("a disabled remote access still returns an inert primary server, unchanged by any of this", async () => {
    const { runtime, calls } = makeRuntime(makePayload());
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    // The pre-existing contract: `enabled: false` reports that and binds nothing.
    expect(calls.setRemoteInfo).toBe(1);
    expect(server.address).toBeUndefined();
    await server.close();
  });
});

describe("the WebSocket keep-alive is tolerant, and still reaps", () => {
  // WHAT THIS GUARDS. The heartbeat used to be one strike: a socket that had not answered by the
  // next tick was terminated. On a desk that is invisible. On a phone it fired constantly — a
  // sub-second blip at a subway stop, a handover between cells, a radio the OS parked for a moment
  // — and every one of them cost the user a terminated socket, a reconnect, a `WebSocket heartbeat
  // timeout` warning, and any push that was in flight during the gap. The tolerance (a counter, not
  // a flag) is what fixed it, and it is exactly the kind of constant a later refactor "simplifies"
  // back to a boolean, because nothing on a developer's machine notices.
  //
  // WHY IT STILL REAPS. NAT boxes drop idle mappings without telling either end, and a leaked token
  // reusing an idle channel would otherwise sit there until the process restarted. So the property
  // is two-sided, and this test asserts both halves against one server.

  function heartbeatRuntime(port: number, token: string) {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token } },
        profiles: [{ id: "default", name: "Default" }],
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
      writeToSession: () => undefined,
      resizeSession: () => undefined,
      setRemoteClientRegistry: () => undefined,
    };
  }

  test("a client that misses one tick keeps its socket; one that answers nothing loses it", async () => {
    const port = await getFreePort();
    const auth = "test-token-heartbeat";
    const intervalMs = 60;
    const server = await startRemoteServer({
      runtime: heartbeatRuntime(port, auth) as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      wsHeartbeatIntervalMs: intervalMs,
      wsHeartbeatMaxMissed: 3,
    });
    const url = `ws://127.0.0.1:${port}/ws?${new URLSearchParams({ token: auth }).toString()}`;
    // `autoPong: false` is the point of the whole test: it is the only way to make a `ws` client
    // behave like a phone whose radio is gone — the handshake completed, the socket looks open from
    // both ends, and nothing comes back. Everything else about the two clients is identical.
    const answering = new WebSocket(url);
    const silent = new WebSocket(url, { autoPong: false });
    try {
      await Promise.all(
        [answering, silent].map(
          (ws) =>
            new Promise<void>((resolve, reject) => {
              ws.on("open", () => resolve());
              ws.on("error", reject);
            }),
        ),
      );
      const openedAt = Date.now();
      const silentClosed = new Promise<number>((resolve) => silent.on("close", () => resolve(Date.now() - openedAt)));

      // One and a half ticks in: the silent client has already missed a ping and is still connected.
      await new Promise((r) => setTimeout(r, intervalMs * 1.5));
      expect(silent.readyState).toBe(WebSocket.OPEN);

      // Left alone it is still reaped — the fourth tick is the one that finds three consecutive
      // misses. Awaiting the close rather than sleeping past it keeps the test off a timing cliff.
      const survivedMs = await silentClosed;

      // AND IT LASTED. This is the half the old one-strike heartbeat failed: a lower bound on how
      // long a silent socket keeps living, not merely a check that it eventually dies. Timers fire
      // late, never early, so only this direction is safe to assert — and a tolerance quietly
      // reduced back to a flag lands here rather than on a phone.
      expect(survivedMs).toBeGreaterThan(intervalMs * 2.5);

      // And the client that answered every ping sat through all four ticks untouched — a pong on any
      // tick resets its counter, so a healthy socket is never on a clock at all.
      expect(answering.readyState).toBe(WebSocket.OPEN);
    } finally {
      answering.close();
      silent.close();
      await server.close();
    }
  });
});

describe("the master token in payload.remoteAccess.urls, per transport", () => {
  // Residual R1 accepts that `payload.remoteAccess.urls[*]` keeps `?token=<master>` in the string,
  // because "Copy share URL" is a real hand-off and the URL travels desktop → the OWNER's own
  // browser. The managed relay breaks that premise: a hosted Worker terminates TLS and forwards
  // decrypted frames, so the same response would hand a full-privilege, long-lived credential to
  // the relay operator — one that keeps working over the LAN after the relay session is gone.
  //
  // These two tests are a matched pair on purpose. The same payload, the same route, two transports,
  // two answers. Either one alone would pass under a wrong global rule; only together do they pin
  // "blank it on the relay, keep it on the user's own listener".
  const MASTER = "the-users-own-master-token";
  const GUARD = "relay-origin-guard-secret";
  const RELAY_ORIGIN = "https://relay.strideterm.test";

  function makeRuntime(port: number, transport: "relay" | "legacy") {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: MASTER } },
        profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: ["ws1"] }],
        workspaces: [{ id: "ws1", name: "WS1", profileId: "default", panels: [{ id: "a" }] }],
        windowSlots: [{ id: "win-1", profileId: "default", activeWorkspaceId: "ws1" }],
      },
      // What runtime.ts's getPayload spreads out of `remoteInfo` once the LAN listener is up. Note
      // this is the payload-level remoteAccess, NOT appState.settings.remoteAccess — the token strip
      // (invariant A1) only ever touched the latter.
      remoteAccess: {
        enabled: true,
        host: "127.0.0.1",
        port,
        urls: [`http://192.168.1.50:${port}/?token=${MASTER}`],
        tunnel: { status: "idle", mode: "off", publicUrl: "" },
      },
    };
    return {
      getPayload: () => payload,
      getInitialState: async () => payload,
      setRemoteInfo: () => undefined,
      listRemoteUrls: () => payload.remoteAccess.urls,
      listMobileTicketOrigins: () => [RELAY_ORIGIN],
      on: () => () => undefined,
      writeToSession: () => undefined,
      resizeSession: () => undefined,
      setRemoteClientRegistry: () => undefined,
      addRemoteClientRegistry: () => () => undefined,
      setMobileRemoteSessionRevoker: () => undefined,
      isMobileSessionStillAuthorized: () => true,
      consumeMobileWebSessionTicket: (ticketId: string, secret: string) =>
        ticketId === "t1" && secret === "s1"
          ? {
              deviceId: "dev-1",
              pairId: "pair-1",
              profileId: "default",
              allowedOrigin: transport === "relay" ? RELAY_ORIGIN : "https://example.trycloudflare.com",
              transport,
              requiredCapability: "remote.webSession" as const,
              expiresAt: Date.now() + 60_000,
            }
          : null,
    };
  }

  test("a relay session's /api/state carries no copy of the master token, on v1 or v2", async () => {
    const server = await startRemoteServer({
      runtime: makeRuntime(43123, "relay") as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      loopbackOrigin: { host: "127.0.0.1", port: 0, guardToken: GUARD, publicOrigin: RELAY_ORIGIN },
    });
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;
    // Every request on this server carries the connector's guard and the relay's verified device id,
    // exactly as the Durable Object stamps them.
    const relayHeaders = {
      "X-Strideterm-Relay-Origin": GUARD,
      "X-Strideterm-Relay-Device": "dev-1",
      "X-Forwarded-Proto": "https",
    };
    try {
      const boot = await fetch(`${baseUrl}/api/mobile/session/bootstrap`, {
        method: "POST",
        headers: { ...relayHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: "t1", secret: "s1" }),
        redirect: "manual",
      });
      expect(boot.status).toBe(302);
      const cookie = (boot.headers.get("set-cookie") || "").split(";")[0]!;
      expect(cookie).toContain("strideterm_session=");

      // Both response contracts: the legacy full payload and the v2 slim core, whose
      // reduceRemoteAccess in remote-core.ts passes `urls` straight through.
      for (const query of ["", "?sp=2"]) {
        const res = await fetch(`${baseUrl}/api/state${query}`, { headers: { ...relayHeaders, Cookie: cookie } });
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const body = await res.text();
        expect(body).not.toContain(MASTER);
        // And specifically that the URL list is empty rather than merely token-free — a rewritten
        // URL that still pointed at the LAN listener would be a different bug, not a fix.
        const parsed = JSON.parse(body) as { remoteAccess?: { urls?: unknown } };
        expect(parsed.remoteAccess?.urls).toEqual([]);
      }
    } finally {
      await server.close();
    }
  });

  test("the user's own LAN listener still serves the share URLs — R1 is unchanged there", async () => {
    const port = await getFreePort();
    const server = await startRemoteServer({
      runtime: makeRuntime(port, "legacy") as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      for (const query of ["", "?sp=2"]) {
        const res = await fetch(`${baseUrl}/api/state${query}`, {
          headers: { Authorization: `Bearer ${MASTER}` },
        });
        expect(res.status).toBe(200);
        const parsed = JSON.parse(await res.text()) as { remoteAccess?: { urls?: string[] } };
        expect(parsed.remoteAccess?.urls).toEqual([`http://192.168.1.50:${port}/?token=${MASTER}`]);
      }
    } finally {
      await server.close();
    }
  });
});

describe("the relay's loopback origin requires the device the relay verified (E2E 3.1)", () => {
  // The connector sets x-strideterm-relay-device on BOTH relay paths: from the Worker's own stamp on a
  // plaintext stream, from the relay-stamped `d` on an e2e-wrapped one. A request that reaches this
  // instance without it did not come through that path intact — it must not be treated as a caller
  // with no identity, which would skip the ticket↔device binding and pool every phone into one
  // rate-limit bucket.
  const GUARD_TOKEN = "guard-secret-for-the-required-device-test";

  function makeRuntime(port: number, consumed: string[]) {
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: false, host: "0.0.0.0", port, token: "unused-master-token" } },
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
      writeToSession: () => undefined,
      resizeSession: () => undefined,
      addRemoteClientRegistry: () => () => undefined,
      isMobileSessionStillAuthorized: () => true,
      consumeMobileWebSessionTicket: (ticketId: string) => {
        consumed.push(ticketId);
        return {
          deviceId: "phone-1",
          pairId: "pair-1",
          profileId: "default",
          allowedOrigin: "https://relay.strideterm.test",
          transport: "relay" as const,
          requiredCapability: "remote.webSession" as const,
          expiresAt: Date.now() + 60_000,
        };
      },
    };
  }

  async function bootstrap(deviceHeader: string | undefined, consumed: string[]) {
    const port = await getFreePort();
    const server = await startRemoteServer({
      runtime: makeRuntime(port, consumed) as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      loopbackOrigin: {
        host: "127.0.0.1",
        port: 0,
        guardToken: GUARD_TOKEN,
        publicOrigin: "https://relay.strideterm.test",
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address!.port}/api/mobile/session/bootstrap`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Strideterm-Relay-Origin": GUARD_TOKEN,
          ...(deviceHeader === undefined ? {} : { "X-Strideterm-Relay-Device": deviceHeader }),
        },
        body: JSON.stringify({ ticketId: "t", secret: "s" }),
        redirect: "manual",
      });
      return response.status;
    } finally {
      await server.close();
    }
  }

  test("a bootstrap with the guard but NO device header is refused before the ticket is even looked at", async () => {
    const consumed: string[] = [];
    expect(await bootstrap(undefined, consumed)).toBe(401);
    expect(consumed).toEqual([]);
  });

  test("a bootstrap naming a device other than the ticket's is still refused, and one naming it succeeds", async () => {
    const consumed: string[] = [];
    expect(await bootstrap("some-other-phone", consumed)).toBe(401);
    expect(await bootstrap("phone-1", consumed)).toBe(302);
  });
});

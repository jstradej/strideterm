import { describe, expect, test } from "vitest";
import {
  REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS,
  buildSessionCookieAttrs,
  sanitizeSettingsFromRemote,
  stripSecretsForRemote,
} from "./remote-server.js";

describe("sanitizeSettingsFromRemote", () => {
  test("drops every blocked remoteAccess field", () => {
    const settings = {
      remoteAccess: {
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

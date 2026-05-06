import { describe, expect, test } from "vitest";
import {
  REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS,
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
      },
      logLevel: "debug",
    };
    const removed = sanitizeSettingsFromRemote(settings as Record<string, unknown>);
    expect(removed.sort()).toEqual([...REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS].sort());
    expect(settings.remoteAccess).toEqual({ customPublicUrl: "https://my.tunnel.example" });
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

  test("only removes the blocked keys — extra fields stay", () => {
    const settings = {
      remoteAccess: {
        cloudflaredPath: "/should/be/removed",
        customPublicUrl: "stays",
        someFutureField: "also stays",
      },
    };
    sanitizeSettingsFromRemote(settings as Record<string, unknown>);
    expect(settings.remoteAccess).toEqual({
      customPublicUrl: "stays",
      someFutureField: "also stays",
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

// Which port the remote server actually binds.
//
// This exists because of a failure with a paired phone at the other end of it. A production install
// held 0.0.0.0:43123. The dev build's own settings file — its own data dir, written on an earlier
// run — also said 43123, so its remote server bound nothing, and the phone got `desktopRefused` with
// `EADDRINUSE: address already in use 0.0.0.0:43123`. The two things that were supposed to fix that
// both pointed at STRIDETERM_REMOTE_PORT: `dev.ps1` sets it to 43124 for exactly this reason, and
// the tunnel's own error message tells the user to change it. Neither worked, because the variable
// was read in one place only — as the default for a settings file that does not exist yet.
import { afterEach, describe, expect, it, vi } from "vitest";

/** Loads a fresh copy of the config module under a given environment. */
async function loadConfig(port?: string) {
  vi.resetModules();
  vi.stubEnv("STRIDETERM_REMOTE_PORT", port ?? "");
  return import("../../config/app-config.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("resolveRemoteAccessPort", () => {
  it("uses the saved port when the variable is not set", async () => {
    const { resolveRemoteAccessPort } = await loadConfig();
    expect(resolveRemoteAccessPort(43123)).toBe(43123);
    expect(resolveRemoteAccessPort(50000)).toBe(50000);
  });

  it("falls back to the built-in default when nothing is saved", async () => {
    const { resolveRemoteAccessPort } = await loadConfig();
    expect(resolveRemoteAccessPort()).toBe(43123);
    expect(resolveRemoteAccessPort(null)).toBe(43123);
    expect(resolveRemoteAccessPort(0)).toBe(43123);
  });

  it("lets the variable OVERRIDE a saved port — the whole point", async () => {
    // The regression this file is named after: with a settings file already holding 43123, setting
    // the variable has to move the build off it. This assertion fails against the previous code.
    const { resolveRemoteAccessPort } = await loadConfig("43124");
    expect(resolveRemoteAccessPort(43123)).toBe(43124);
    expect(resolveRemoteAccessPort()).toBe(43124);
  });

  it("ignores a value that is not a usable port, rather than binding nonsense", async () => {
    for (const bad of ["abc", "0", "-1", "70000", "  "]) {
      const { resolveRemoteAccessPort } = await loadConfig(bad);
      expect(resolveRemoteAccessPort(43123)).toBe(43123);
    }
  });

  it("does not change the seeded default a fresh settings file gets", async () => {
    // `APP_CONFIG.remoteAccess.port` keeps its old meaning — the value a new settings file is
    // written with — so nothing about first-run behaviour moves with this.
    const withVar = await loadConfig("43124");
    expect(withVar.APP_CONFIG.remoteAccess.port).toBe(43124);
    const without = await loadConfig();
    expect(without.APP_CONFIG.remoteAccess.port).toBe(43123);
  });
});

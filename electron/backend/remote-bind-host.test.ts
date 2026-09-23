// Which address the remote server binds, given `remoteAccess.networkAccess` (plan: corporate
// network / EDR, Phase 3). The default must bind exactly what it did before the setting existed.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isLoopbackBindHost, resolveRemoteBindHost } from "../../config/app-config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveRemoteBindHost", () => {
  it.each([
    // [host, networkAccess, expected]
    ["0.0.0.0", false, "127.0.0.1"],
    ["0.0.0.0", true, "0.0.0.0"],
    ["0.0.0.0", undefined, "0.0.0.0"],
    ["", false, "127.0.0.1"],
    ["", true, "0.0.0.0"],
    ["100.64.1.2", false, "100.64.1.2"],
    ["100.64.1.2", true, "100.64.1.2"],
    ["127.0.0.1", true, "127.0.0.1"],
    ["127.0.0.1", false, "127.0.0.1"],
    ["::", false, "::1"],
    ["::", true, "::"],
    ["[::]", false, "::1"],
    ["::1", true, "::1"],
    ["::1", false, "::1"],
  ] as const)("host %j, networkAccess %j → %s", (host, networkAccess, expected) => {
    expect(resolveRemoteBindHost({ host, networkAccess }, null)).toBe(expected);
  });

  it("STRIDETERM_REMOTE_HOST wins over networkAccess and the stored host", async () => {
    expect(resolveRemoteBindHost({ host: "0.0.0.0", networkAccess: false }, "10.0.0.5")).toBe("10.0.0.5");
    vi.resetModules();
    vi.stubEnv("STRIDETERM_REMOTE_HOST", "10.0.0.5");
    const fresh = await import("../../config/app-config.js");
    expect(fresh.resolveRemoteBindHost({ host: "0.0.0.0", networkAccess: false })).toBe("10.0.0.5");
  });

  it("with no env override the default is the stored host", async () => {
    vi.resetModules();
    vi.stubEnv("STRIDETERM_REMOTE_HOST", "");
    const fresh = await import("../../config/app-config.js");
    expect(fresh.resolveRemoteBindHost({ host: "0.0.0.0", networkAccess: true })).toBe("0.0.0.0");
  });

  it("the resolved loopback address is what a server actually binds", async () => {
    const host = resolveRemoteBindHost({ host: "0.0.0.0", networkAccess: false }, null);
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    try {
      expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
      expect(isLoopbackBindHost(host)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("isLoopbackBindHost", () => {
    expect(isLoopbackBindHost("127.0.0.1")).toBe(true);
    expect(isLoopbackBindHost("::1")).toBe(true);
    expect(isLoopbackBindHost("localhost")).toBe(true);
    expect(isLoopbackBindHost("0.0.0.0")).toBe(false);
    expect(isLoopbackBindHost("192.168.1.10")).toBe(false);
  });
});

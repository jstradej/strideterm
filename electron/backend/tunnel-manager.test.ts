import { describe, expect, test } from "vitest";
import { canReconnectTunnel, extractQuickTunnelUrl } from "./tunnel-manager.js";

describe("CloudflareTunnelManager helpers", () => {
  test("extractQuickTunnelUrl reads the public trycloudflare URL from log output", () => {
    const url = extractQuickTunnelUrl(
      "INF +--------------------------------------------------------------------------------------------+\nINF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\nINF |  https://violet-moon-fire.trycloudflare.com                                               |\nINF +--------------------------------------------------------------------------------------------+",
    );

    expect(url).toBe("https://violet-moon-fire.trycloudflare.com");
  });

  test("extractQuickTunnelUrl returns empty string when no public URL is present", () => {
    expect(extractQuickTunnelUrl("INF starting metrics server")).toBe("");
  });
});

describe("canReconnectTunnel (Telegram + mobile shared safety gate)", () => {
  test("allows reconnect only when remote access is enabled AND a tunnel was already auto-started", () => {
    expect(canReconnectTunnel({ enabled: true, autoTunnel: true })).toBe(true);
  });

  test("refuses when remote access is disabled, even if autoTunnel was persisted true", () => {
    expect(canReconnectTunnel({ enabled: false, autoTunnel: true })).toBe(false);
  });

  test("refuses when no tunnel was ever auto-started, even with remote access enabled (no new exposure)", () => {
    expect(canReconnectTunnel({ enabled: true, autoTunnel: false })).toBe(false);
  });

  test("refuses when both are unset (e.g. a partially-loaded settings object)", () => {
    expect(canReconnectTunnel({})).toBe(false);
  });
});

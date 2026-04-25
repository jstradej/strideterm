import { describe, expect, test } from "vitest";
import { extractQuickTunnelUrl } from "./tunnel-manager.js";

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

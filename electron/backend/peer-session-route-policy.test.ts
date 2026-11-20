import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { PEER_DENIED_ROUTES, isPeerDeniedRoute } from "./peer-session-route-policy.js";

const source = fs.readFileSync(path.join(__dirname, "remote-server.ts"), "utf8");
const literals = new Set([...source.matchAll(/"(\/api\/[^"]*)"/g)].map((match) => match[1]!));

describe("peer route policy", () => {
  test("every denied route is a real route in remote-server.ts", () => {
    for (const route of PEER_DENIED_ROUTES) expect(literals.has(route), route).toBe(true);
  });

  test("every agent hook route except status is denied, so a new one needs a decision", () => {
    const hookRoutes = [...literals].filter((route) => /^\/api\/[a-z]+-hook\//.test(route));
    expect(hookRoutes.length).toBeGreaterThan(0);
    for (const route of hookRoutes) {
      expect(isPeerDeniedRoute(route), route).toBe(!route.endsWith("/status"));
    }
  });

  test("ordinary routes are not denied", () => {
    for (const route of ["/api/state", "/api/remote-client/profile/activate", "/api/claude-hook/status"]) {
      expect(isPeerDeniedRoute(route), route).toBe(false);
    }
  });
});

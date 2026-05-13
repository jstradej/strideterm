/**
 * Verifies that the remote transport routes profile/workspace/session
 * activations to the correct /api/remote-client/* endpoints.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRemoteTransport } from "./transport.js";

describe("remote transport endpoint routing", () => {
  let originalFetch: typeof globalThis.fetch;
  const capturedUrls: string[] = [];
  const capturedBodies: unknown[] = [];

  beforeEach(() => {
    capturedUrls.length = 0;
    capturedBodies.length = 0;
    originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      capturedUrls.push(String(url));
      try {
        capturedBodies.push(JSON.parse(init?.body || "{}"));
      } catch {
        capturedBodies.push({});
      }
      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("activateProfile calls /api/remote-client/profile/activate with profileId", async () => {
    const transport = createRemoteTransport();
    await transport.activateProfile!("p1").catch(() => {});
    expect(capturedUrls.some((u) => u.includes("/api/remote-client/profile/activate"))).toBe(true);
    expect(capturedBodies.some((b) => (b as { profileId?: string }).profileId === "p1")).toBe(true);
  });

  it("activateWorkspace calls /api/remote-client/workspace/activate with workspaceId", async () => {
    const transport = createRemoteTransport();
    await transport.activateWorkspace!("ws1").catch(() => {});
    expect(capturedUrls.some((u) => u.includes("/api/remote-client/workspace/activate"))).toBe(true);
    expect(capturedBodies.some((b) => (b as { workspaceId?: string }).workspaceId === "ws1")).toBe(true);
  });

  it("activateSession calls /api/remote-client/session/activate, derives workspaceId from sessionId", async () => {
    const transport = createRemoteTransport();
    await transport.activateSession!("ws1:panel1").catch(() => {});
    expect(capturedUrls.some((u) => u.includes("/api/remote-client/session/activate"))).toBe(true);
    const body = capturedBodies.find((b) => (b as { sessionId?: string }).sessionId === "ws1:panel1") as {
      workspaceId?: string;
      sessionId?: string;
    };
    expect(body?.workspaceId).toBe("ws1");
    expect(body?.sessionId).toBe("ws1:panel1");
  });
});

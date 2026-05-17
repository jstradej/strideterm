/**
 * Verifies that the remote transport routes profile/workspace/session
 * activations to the correct /api/remote-client/* endpoints.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRemoteTransport } from "./transport.js";

interface MockWebSocketEvent {
  code?: number;
  reason?: string;
  data?: string;
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private handlers = new Map<string, Set<(event: MockWebSocketEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  static instances: MockWebSocket[] = [];

  addEventListener(type: string, handler: (event: MockWebSocketEvent) => void) {
    const handlers = this.handlers.get(type) || new Set<(event: MockWebSocketEvent) => void>();
    handlers.add(handler);
    this.handlers.set(type, handlers);
  }

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  close(code = 1006, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  message(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: MockWebSocketEvent) {
    for (const handler of this.handlers.get(type) || []) handler(event);
  }
}

describe("remote transport endpoint routing", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebSocket: typeof globalThis.WebSocket;
  const capturedUrls: string[] = [];
  const capturedBodies: unknown[] = [];

  beforeEach(() => {
    capturedUrls.length = 0;
    capturedBodies.length = 0;
    MockWebSocket.instances.length = 0;
    originalFetch = globalThis.fetch;
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrls.push(String(url));
      try {
        capturedBodies.push(JSON.parse(String(init?.body || "{}")));
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
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
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

  it("reconnects websocket and refreshes state without restarting terminals", async () => {
    vi.useFakeTimers();
    const states: unknown[] = [];
    const connections: unknown[] = [];
    const transport = createRemoteTransport();
    transport.onStateUpdated((payload) => states.push(payload));
    transport.onConnectionState((payload) => connections.push(payload));

    const first = MockWebSocket.instances[0];
    first.open();
    first.close(1006);
    expect(connections).toContainEqual(expect.objectContaining({ connected: false, reconnecting: true, attempt: 1 }));

    vi.advanceTimersByTime(500);
    const second = MockWebSocket.instances[1];
    second.open();
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    expect(connections).toContainEqual(expect.objectContaining({ connected: true, reconnected: true }));
    expect(capturedUrls).toContain("/api/state");
    expect(states.length).toBeGreaterThan(0);
  });

  it("queues terminal messages while reconnecting and flushes them on open", () => {
    vi.useFakeTimers();
    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    first.close(1006);

    transport.resizeTerminal("ws:pane", { cols: 100, rows: 30 });
    transport.writeTerminal("ws:pane", "x");
    vi.advanceTimersByTime(500);
    const second = MockWebSocket.instances[1];
    second.open();

    expect(second.sent.map((raw) => JSON.parse(raw).type)).toEqual(["terminal:resize", "terminal:input"]);
  });
});

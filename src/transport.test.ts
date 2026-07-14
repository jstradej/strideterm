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

  it("subscribeTerminals sends the complete set over the socket when open", () => {
    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    first.open();
    transport.subscribeTerminals(["ws1:a", "ws1:b"]);
    const sub = first.sent.map((raw) => JSON.parse(raw)).find((m) => m.type === "terminal:subscribe");
    expect(sub).toEqual({ type: "terminal:subscribe", sessionIds: ["ws1:a", "ws1:b"] });
  });

  it("defers a subscription sent before open, then delivers it once on open", () => {
    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    // Socket is still CONNECTING here.
    transport.subscribeTerminals(["ws1:a"]);
    expect(first.sent.filter((raw) => JSON.parse(raw).type === "terminal:subscribe")).toHaveLength(0);
    first.open();
    const subs = first.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "terminal:subscribe");
    expect(subs).toEqual([{ type: "terminal:subscribe", sessionIds: ["ws1:a"] }]);
  });

  it("re-sends the terminal subscription verbatim after a reconnect", () => {
    vi.useFakeTimers();
    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    first.open();
    transport.subscribeTerminals(["ws1:a"]);
    first.close(1006);
    vi.advanceTimersByTime(500);
    const second = MockWebSocket.instances[1];
    second.open();
    const subs = second.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "terminal:subscribe");
    expect(subs).toContainEqual({ type: "terminal:subscribe", sessionIds: ["ws1:a"] });
  });

  it("does not send any subscription on connect until the client subscribes (legacy mode)", () => {
    const transport = createRemoteTransport();
    void transport;
    const first = MockWebSocket.instances[0];
    first.open();
    expect(first.sent.filter((raw) => JSON.parse(raw).type === "terminal:subscribe")).toHaveLength(0);
  });

  it("skips re-sending an identical subscription (review F10 — attention-sync noise)", () => {
    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    first.open();
    transport.subscribeTerminals(["ws1:a", "ws1:b"]);
    transport.subscribeTerminals(["ws1:a", "ws1:b"]); // identical → no wire traffic
    transport.subscribeTerminals(["ws1:a", "ws1:b"]);
    const subs = first.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "terminal:subscribe");
    expect(subs).toHaveLength(1);
    // A genuinely different set still goes out.
    transport.subscribeTerminals(["ws1:a"]);
    const after = first.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "terminal:subscribe");
    expect(after).toHaveLength(2);
    expect(after[1]).toEqual({ type: "terminal:subscribe", sessionIds: ["ws1:a"] });
  });

  it("terminal:removed forgets the id so an otherwise-identical re-subscribe is re-sent (finding 4)", () => {
    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    first.open();
    transport.subscribeTerminals(["ws1:a", "ws1:b"]);

    const removed: unknown[] = [];
    transport.onTerminalRemoved?.((payload) => removed.push(payload));

    // Server prunes ws1:a from this socket's routing and notifies. The client
    // must forget it AND fire the listener so the attention-sync layer resyncs.
    first.message({ type: "terminal:removed", payload: { sessionId: "ws1:a" } });
    expect(removed).toContainEqual({ sessionId: "ws1:a" });

    // Re-subscribing the SAME rendered set is no longer suppressed as identical:
    // the id was forgotten, so a recreated same-id pane streams again instead of
    // staying frozen behind the idempotence guard.
    transport.subscribeTerminals(["ws1:a", "ws1:b"]);
    const subs = first.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "terminal:subscribe");
    expect(subs).toEqual([
      { type: "terminal:subscribe", sessionIds: ["ws1:a", "ws1:b"] },
      { type: "terminal:subscribe", sessionIds: ["ws1:a", "ws1:b"] },
    ]);
  });

  it("dispatches terminal:replay messages to onTerminalReplay listeners", () => {
    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    first.open();
    const replays: unknown[] = [];
    transport.onTerminalReplay((payload) => replays.push(payload));
    first.message({ type: "terminal:replay", payload: { sessionId: "ws1:a", data: "R", throughSeq: 3 } });
    expect(replays).toContainEqual({ sessionId: "ws1:a", data: "R", throughSeq: 3 });
  });
});

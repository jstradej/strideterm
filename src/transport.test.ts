/**
 * Verifies that the remote transport routes profile/workspace/session
 * activations to the correct /api/remote-client/* endpoints.
 */
import { describe, it, expect, vi, beforeEach, afterEach, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("reconnect resync is single-path: WS ?rev= catch-up, never a duplicate /api/state fetch", async () => {
    vi.useFakeTimers();
    const states: unknown[] = [];
    const connections: unknown[] = [];
    const transport = createRemoteTransport();
    transport.onStateUpdated((payload) => states.push(payload));
    transport.onConnectionState((payload) => connections.push(payload));

    // First connect + a bootstrap revision handed over the WS (records rev=5).
    const first = MockWebSocket.instances[0];
    first.open();
    first.message({ type: "state:updated", payload: { coreRevision: 5 } });
    expect(states).toHaveLength(1);

    // Drop the socket → schedule a reconnect.
    first.close(1006);
    expect(connections).toContainEqual(expect.objectContaining({ connected: false, reconnecting: true, attempt: 1 }));

    vi.advanceTimersByTime(500);
    const second = MockWebSocket.instances[1];
    // The reconnect URL carries our last known revision — this is the ONE channel
    // the server uses to decide whether we still need a catch-up core.
    expect(second.url).toContain("rev=5");
    second.open();
    // Let any (unwanted) async HTTP settle.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    expect(connections).toContainEqual(expect.objectContaining({ connected: true, reconnected: true }));
    // Single-path: the reconnect must NOT ALSO fetch state over HTTP. The old
    // behaviour issued GET /api/state on every reconnect, so a stale reconnect
    // transferred the core twice (WS catch-up + HTTP). That path is gone.
    expect(capturedUrls).not.toContain("/api/state");
    // The server pushes exactly one catch-up core over the WS — that single body
    // is the only state transfer on resync.
    second.message({ type: "state:updated", payload: { coreRevision: 6 } });
    expect(states).toHaveLength(2);
  });

  it("sends state:sync with the bootstrap revision on first-connect open (closes the [bootstrap, open] window)", async () => {
    // The first WS is created synchronously at construction, before any bootstrap
    // — so its URL carries NO ?rev=. Bootstrap then records a revision; on the
    // first socket's open the client hands that revision off via state:sync so
    // the server catches it up on anything that changed in between.
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ coreRevision: 7 }),
          headers: { get: () => null },
        }) as unknown as Response,
    ) as unknown as typeof fetch;

    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    // First socket URL was frozen before the revision existed → no ?rev=.
    expect(first.url).not.toContain("rev=");

    await transport.getState(); // records lastCoreRevision = 7 (socket still CONNECTING)
    // Nothing sent yet — the socket isn't open.
    expect(first.sent.map((r) => JSON.parse(r)).some((m) => m.type === "state:sync")).toBe(false);

    first.open();
    const sync = first.sent.map((r) => JSON.parse(r)).find((m) => m.type === "state:sync");
    expect(sync).toEqual({ type: "state:sync", rev: 7 });
  });

  it("revalidates GETs with If-None-Match and reuses the cached body on 304", async () => {
    let call = 0;
    const sentIfNoneMatch: (string | null)[] = [];
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers || {}) as Record<string, string>;
      sentIfNoneMatch.push(headers["If-None-Match"] ?? null);
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ hello: "world", coreRevision: 1 }),
          headers: { get: (k: string) => (k.toLowerCase() === "etag" ? '"v1"' : null) },
        } as unknown as Response;
      }
      // Second GET carries If-None-Match — respond 304 (no body).
      return {
        ok: false,
        status: 304,
        json: async () => ({}),
        headers: { get: () => null },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const transport = createRemoteTransport();
    const first = await transport.getState();
    const second = await transport.getState();

    expect(sentIfNoneMatch[0]).toBeNull(); // first request has nothing to revalidate
    expect(sentIfNoneMatch[1]).toBe('"v1"'); // second request offers the stored ETag
    expect(second).toEqual(first); // 304 → the cached body is reused
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

  it("re-sends the resource-interest set verbatim after a reconnect (server drops per-socket interests)", () => {
    vi.useFakeTimers();
    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    first.open();
    transport.subscribeResources!(["git:ws1", "docker"]);
    expect(first.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: "resource:interest",
      resources: ["git:ws1", "docker"],
    });
    first.close(1006);
    vi.advanceTimersByTime(500);
    const second = MockWebSocket.instances[1];
    second.open();
    // The fresh socket has no interests server-side — the open handler must
    // re-declare the remembered set so invalidations are re-primed.
    const interests = second.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "resource:interest");
    expect(interests).toEqual([{ type: "resource:interest", resources: ["git:ws1", "docker"] }]);
  });

  it("sends no resource-interest on connect until a pane declares one", () => {
    const transport = createRemoteTransport();
    void transport;
    const first = MockWebSocket.instances[0];
    first.open();
    expect(first.sent.filter((raw) => JSON.parse(raw).type === "resource:interest")).toHaveLength(0);
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

/**
 * Regression guard for review-code-quality-2026-07.md finding 1.3 ("forgot the
 * remote mapping" bug class): a desktop preload method with no remote-transport
 * counterpart isn't a compile error, because `Transport` wraps `StridetermAPI`
 * in `Partial<>` for exactly this reason (some desktop methods legitimately
 * don't apply remotely). That means a genuinely missing mapping — like
 * gitCompareBranch, which HAD a working server route and desktop binding but
 * no remote fetchJson call — only ever surfaced as a runtime TypeError on a
 * real remote client.
 *
 * This test parses both object literals as text (no Electron import, so it
 * runs under plain jsdom) and asserts the only keys present in the desktop
 * API but absent from the remote transport are ones we've deliberately
 * decided don't apply remotely. Adding a new desktop-only preload method
 * requires a conscious addition to KNOWN_DESKTOP_ONLY_METHODS below — any
 * other gap fails the test instead of shipping silently.
 */
describe("remote transport API parity — no method silently missing its remote mapping", () => {
  // Keep in sync with any legitimately desktop-only additions. Each entry
  // documents WHY the remote transport doesn't (or doesn't yet) implement it.
  const KNOWN_DESKTOP_ONLY_METHODS = new Set([
    // Native OS integration with no remote-browser equivalent.
    "openTerminalPath",
    "pasteClipboardImageForTerminal",
    "showSystemNotification",
    "checkForUpdates",
    "browseDirectory",
    "browseFile",
    "saveFile",
    "getNotificationMetrics",
    "closeTerminal",
    "listPlugins",
    "getPluginWorkspaceTemplate",
    // Electron multi-window management — a remote client is a single browser
    // tab, there is no OS-level window to create/close/focus.
    "getWindowId",
    "focusWindow",
    "createWindow",
    "closeWindow",
    "respondConfirmClose",
    "openDiffPopout",
    "getDiffPopoutInit",
    "onNewWindowShortcut",
    "onConfirmCloseRequest",
    // Renderer-side logging writes into the Electron main-process log file,
    // which doesn't exist for a remote browser client. Always called via
    // optional chaining (api.logRenderer?.(...)) at every call site.
    "logRenderer",
    // Plain data, not an RPC method.
    "startupFlags",
    // review-code-quality-2026-07.md §1.3: agent prompts are a global (not
    // per-profile) resource; save/delete are intentionally desktop-IPC-only
    // (reset is the only remote-reachable prompt mutation). ReviewAgentTab
    // hides the edit/delete affordance when the transport is remote.
    "saveAgentPrompt",
    "deleteAgentPrompt",
    // review-code-quality-2026-07.md §2.2: DockerDetailShell/DockerDetail/
    // DockerPane call `window.strideterm.dockerShellOpen/Write/Resize/Close`
    // directly instead of going through the transport, so these have no
    // remote mapping yet and the shell silently no-ops on a remote client.
    // Tracked as a follow-up to route shell open/close through the transport.
    "dockerShellOpen",
    "dockerShellWrite",
    "dockerShellResize",
    "dockerShellClose",
    "onDockerShellData",
    "onDockerShellClose",
    // review-code-quality-2026-07.md §4.3: dead IPC channels — main.ts handles
    // Ctrl+1-9 directly and nothing ever sends shortcut:switch-*. Tracked for
    // removal from StridetermAPI entirely rather than remote mapping.
    "onSwitchWorkspace",
    "onSwitchProject",
    "onSwitchTab",
  ]);

  function extractDesktopApiKeys(): string[] {
    const preloadSrc = readFileSync(resolve(process.cwd(), "electron/preload.cts"), "utf8");
    const start = preloadSrc.indexOf('exposeInMainWorld("strideterm", {');
    const end = preloadSrc.indexOf("} satisfies StridetermAPI);", start);
    if (start < 0 || end < 0) throw new Error("Could not locate the strideterm API object literal in preload.cts");
    const body = preloadSrc.slice(start, end);
    const keys = new Set<string>();
    for (const m of body.matchAll(/^  ([a-zA-Z_$][\w$]*)[:,]/gm)) keys.add(m[1]);
    return [...keys];
  }

  it("every desktop API key is either remote-mapped or an acknowledged desktop-only method", () => {
    const desktopKeys = extractDesktopApiKeys();
    expect(desktopKeys.length).toBeGreaterThan(50); // sanity check the regex actually matched something

    const transport = createRemoteTransport() as unknown as Record<string, unknown>;
    const remoteKeys = new Set(Object.keys(transport));

    const unmapped = desktopKeys.filter((key) => !remoteKeys.has(key) && !KNOWN_DESKTOP_ONLY_METHODS.has(key));
    expect(unmapped).toEqual([]);
  });

  it("KNOWN_DESKTOP_ONLY_METHODS doesn't accumulate stale entries that are now mapped", () => {
    const transport = createRemoteTransport() as unknown as Record<string, unknown>;
    const remoteKeys = new Set(Object.keys(transport));
    const stale = [...KNOWN_DESKTOP_ONLY_METHODS].filter((key) => remoteKeys.has(key));
    expect(stale).toEqual([]);
  });
});

/**
 * Verifies that the remote transport routes profile/workspace/session
 * activations to the correct /api/remote-client/* endpoints.
 */
import { describe, it, expect, vi, beforeEach, afterEach, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRemoteTransport, createTransport } from "./transport.js";

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

  rawMessage(data: string) {
    this.emit("message", { data });
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
    // A transport is never disposed: it keeps its visibilitychange/pageshow/focus listeners for the
    // life of the page, and in a test file that is ONE page. So a transport left awake with an open
    // socket answers the events a LATER test dispatches — using that test's fetch mock. That is how
    // one test's 401 became another test's second `session-lost` report, and it made the file's
    // outcome depend on which tests happened to leave a socket open. Suspending is the closest thing
    // to disposal the bridge offers, and it is enough: a suspended transport ignores all three events.
    (window as unknown as Record<string, { suspend?: () => void } | undefined>).__stridetermRemote?.suspend?.();
    delete (window as unknown as Record<string, unknown>).StridetermHost;
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

  it("native profile selection reuses the socket and reports the confirmed selection", async () => {
    const postMessage = vi.fn();
    (window as unknown as Record<string, unknown>).StridetermHost = { postMessage };
    const payload = { remoteClient: { profileId: "other", activeWorkspaceId: "workspace-other" } };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => payload }) as Response);
    const transport = createRemoteTransport();
    const updated = vi.fn();
    transport.onStateUpdated(updated);
    const socketCount = MockWebSocket.instances.length;
    const bridge = (
      window as unknown as {
        __stridetermRemote: {
          selectTarget(profile: string, workspace: string | null, request: number, panelId?: string): Promise<void>;
        };
      }
    ).__stridetermRemote;
    await bridge.selectTarget("other", null, 7);
    expect(updated).toHaveBeenCalledWith(payload);
    expect(MockWebSocket.instances).toHaveLength(socketCount);
    expect(postMessage.mock.calls.map(([message]) => JSON.parse(message))).toContainEqual({
      type: "selection-changed",
      profileId: "other",
      workspaceId: "workspace-other",
    });
    expect(postMessage.mock.calls.map(([message]) => JSON.parse(message))).toContainEqual({
      type: "selection-result",
      requestId: 7,
      ok: true,
    });
  });

  it("native selection waits for the renderer to select the requested panel", async () => {
    const postMessage = vi.fn();
    const selectPanel = vi.fn();
    (window as unknown as Record<string, unknown>).StridetermHost = { postMessage };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response);
    const transport = createRemoteTransport();
    transport.onStateUpdated(vi.fn());
    window.addEventListener(
      "strideterm:remote-select-panel",
      ((event: CustomEvent<{ panelId: string; workspaceId: string; handled: boolean; resolve: () => void }>) => {
        event.detail.handled = true;
        selectPanel(event.detail);
        event.detail.resolve();
      }) as EventListener,
      { once: true },
    );
    const bridge = (
      window as unknown as {
        __stridetermRemote: {
          selectTarget(profile: string, workspace: string | null, request: number, panelId?: string): Promise<void>;
        };
      }
    ).__stridetermRemote;

    await bridge.selectTarget("other", "workspace-other", 8, "panel-codex");

    expect(selectPanel).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "other", workspaceId: "workspace-other", panelId: "panel-codex" }),
    );
    expect(postMessage.mock.calls.map(([message]) => JSON.parse(message))).toContainEqual({
      type: "selection-result",
      requestId: 8,
      ok: true,
      profileId: "other",
      workspaceId: "workspace-other",
      panelId: "panel-codex",
    });
  });

  it("native selection reports failure when the requested panel cannot be selected", async () => {
    const postMessage = vi.fn();
    (window as unknown as Record<string, unknown>).StridetermHost = { postMessage };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response);
    const transport = createRemoteTransport();
    transport.onStateUpdated(vi.fn());
    window.addEventListener(
      "strideterm:remote-select-panel",
      ((event: CustomEvent<{ handled: boolean; reject: (reason?: unknown) => void }>) => {
        event.detail.handled = true;
        event.detail.reject(new Error("Target panel is missing"));
      }) as EventListener,
      { once: true },
    );
    const bridge = (
      window as unknown as {
        __stridetermRemote: {
          selectTarget(profile: string, workspace: string | null, request: number, panelId?: string): Promise<void>;
        };
      }
    ).__stridetermRemote;

    await bridge.selectTarget("other", "workspace-other", 9, "missing-panel");

    expect(postMessage.mock.calls.map(([message]) => JSON.parse(message))).toContainEqual({
      type: "selection-result",
      requestId: 9,
      ok: false,
    });
  });

  it("native selection waits for the cold renderer to register its panel receiver", async () => {
    const postMessage = vi.fn();
    const selectPanel = vi.fn();
    (window as unknown as Record<string, unknown>).StridetermHost = { postMessage };
    const payload = { remoteClient: { profileId: "other", activeWorkspaceId: "workspace-other" } };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => payload }) as Response);
    const transport = createRemoteTransport();
    const firstAttempt = new Promise<void>((resolve) => {
      window.addEventListener("strideterm:remote-select-panel", () => resolve(), { once: true });
    });
    const bridge = (
      window as unknown as {
        __stridetermRemote: {
          selectTarget(profile: string, workspace: string | null, request: number, panelId?: string): Promise<void>;
        };
      }
    ).__stridetermRemote;

    const selection = bridge.selectTarget("other", "workspace-other", 10, "panel-codex");
    await firstAttempt;
    const updated = vi.fn();
    transport.onStateUpdated(updated);
    window.addEventListener(
      "strideterm:remote-select-panel",
      ((event: CustomEvent<{ panelId: string; handled: boolean; resolve: () => void }>) => {
        event.detail.handled = true;
        selectPanel(event.detail.panelId);
        event.detail.resolve();
      }) as EventListener,
      { once: true },
    );
    window.dispatchEvent(new Event("strideterm:remote-panel-selection-ready"));
    await selection;

    expect(updated).toHaveBeenCalledWith(payload);
    expect(selectPanel).toHaveBeenCalledWith("panel-codex");
    expect(postMessage.mock.calls.map(([message]) => JSON.parse(message))).toContainEqual({
      type: "selection-result",
      requestId: 10,
      ok: true,
      profileId: "other",
      workspaceId: "workspace-other",
      panelId: "panel-codex",
    });
  });

  it("activateWorkspace calls /api/remote-client/workspace/activate with workspaceId", async () => {
    const transport = createRemoteTransport();
    await transport.activateWorkspace!("ws1").catch(() => {});
    expect(capturedUrls.some((u) => u.includes("/api/remote-client/workspace/activate"))).toBe(true);
    expect(capturedBodies.some((b) => (b as { workspaceId?: string }).workspaceId === "ws1")).toBe(true);
  });

  it("lists and deletes workspace attachments through dedicated routes", async () => {
    const record = {
      transferId: "transfer-1",
      path: ".strideterm/attachments/transfer-1/file.txt",
      size: 12,
      sha256: "a".repeat(64),
      name: "file.txt",
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ attachments: [record] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response);
    const transport = createRemoteTransport();

    await expect(transport.attachmentList?.({ workspaceId: "ws1" })).resolves.toEqual([record]);
    await expect(
      transport.attachmentDelete?.({ workspaceId: "ws1", transferId: record.transferId, name: record.name }),
    ).resolves.toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/attachment/list",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ workspaceId: "ws1" }) }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "/api/attachment/delete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws1", transferId: record.transferId, name: record.name }),
      }),
    );
  });

  it("rejects a malformed attachment list from the remote server", async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, json: async () => ({ attachments: [{ bad: true }] }) }) as Response,
    );
    const transport = createRemoteTransport();
    await expect(transport.attachmentList?.({ workspaceId: "ws1" })).rejects.toThrow(
      "Invalid attachment list response",
    );
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

  it("suspend closes the socket and stops reconnecting; resume brings it back with a bounded catch-up", async () => {
    // Production hardening §5 "Session" 6. A WebView in a backgrounded Android app is not a hidden
    // tab: nothing suspends its JS or its sockets, so a streaming terminal keeps streaming over the
    // relay behind a dark screen. The host — which is the only party that knows the app went to the
    // background and how long ago — closes the transport, and the transport must then STAY closed.
    vi.useFakeTimers();
    const connections: { connected: boolean; reconnecting?: boolean; message?: string }[] = [];
    const transport = createRemoteTransport();
    transport.onConnectionState((payload) => connections.push(payload));

    const first = MockWebSocket.instances[0];
    first.open();
    // A revision, so the resumed socket has something to ask a bounded catch-up for. `coreRevision`
    // is the field the transport records (see `noteCoreRevision`).
    first.message({ type: "state:updated", payload: { coreRevision: 7 } });

    const bridge = (window as unknown as Record<string, { suspend(): void; resume(): void; isSuspended(): boolean }>)
      .__stridetermRemote;
    expect(bridge, "the host bridge must exist on a remote transport").toBeTruthy();
    expect(bridge.isSuspended()).toBe(false);

    bridge.suspend();
    expect(first.readyState).toBe(MockWebSocket.CLOSED);
    expect(bridge.isSuspended()).toBe(true);
    // The UI is told it is paused rather than reconnecting: a spinner that never resolves would be a
    // lie, and "stale terminal shown as live" is what the plan forbids.
    const paused = connections.at(-1)!;
    expect(paused.connected).toBe(false);
    expect(paused.reconnecting).toBe(false);
    expect(paused.message).toMatch(/background/i);

    // And it stays closed: no timer, no probe, no new socket, however long we wait.
    const socketsAfterSuspend = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances.length).toBe(socketsAfterSuspend);

    // Resume opens exactly one socket, and its URL carries the revision — so the server sends one
    // catch-up core rather than the client re-fetching everything over HTTP.
    bridge.resume();
    expect(MockWebSocket.instances.length).toBe(socketsAfterSuspend + 1);
    const resumed = MockWebSocket.instances.at(-1)!;
    expect(resumed.url).toContain("rev=7");
    expect(bridge.isSuspended()).toBe(false);
  });

  it("a resume onto a session that is gone reports it instead of reconnecting forever", async () => {
    // WHY A RESUME CANNOT JUST OPEN A SOCKET. The gap before a resume is arbitrary — a glance at a
    // notification, or a phone in a pocket overnight — so the session it reattaches to may be gone:
    // the desktop's idle deadline, the relay's viewer TTL, a desktop that restarted. A REJECTED
    // UPGRADE tells the page nothing a flaky network would not: a close event, no status, no body. So
    // it answers with a reconnect backoff and retries a session that will never come back, the host
    // is never told, and the phone says "reconnecting" until someone kills the screen. The request
    // the resume also sends is what has a status code.
    vi.useFakeTimers();
    const posted: string[] = [];
    (window as unknown as Record<string, unknown>).StridetermHost = {
      postMessage: (message: string) => posted.push(message),
    };
    const transport = createRemoteTransport();
    transport.onConnectionState(() => {});
    MockWebSocket.instances[0].open();

    const bridge = (
      window as unknown as Record<
        string,
        { suspend(): void; resume(): void; isSuspended(): boolean; isSessionLost(): boolean }
      >
    ).__stridetermRemote;
    bridge.suspend();

    // Away long enough that the session ended while nothing was watching.
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => "" }) as Response);
    bridge.resume();
    const socketsAfterResume = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(0);

    // The verdict is reached from the request, not from the socket — and it is the SAME verdict a
    // live page reaches on its own 401, so the host needs no second path to handle it.
    expect(bridge.isSessionLost()).toBe(true);
    expect(bridge.isSuspended()).toBe(true);
    expect(posted).toEqual([JSON.stringify({ type: "session-lost" })]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances.length).toBe(socketsAfterResume);
    delete (window as unknown as Record<string, unknown>).StridetermHost;
  });

  it("a resume that lands on a live session re-syncs the state it missed", async () => {
    // The other half of the same call: the request is not only a liveness check. A page that was away
    // has stale state and a socket catch-up it cannot be sure arrived, so what comes back is handed
    // to the ordinary state listeners.
    vi.useFakeTimers();
    const states: unknown[] = [];
    const transport = createRemoteTransport();
    transport.onStateUpdated((payload) => states.push(payload));
    MockWebSocket.instances[0].open();

    const bridge = (window as unknown as Record<string, { suspend(): void; resume(): void }>).__stridetermRemote;
    bridge.suspend();
    const before = states.length;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ coreRevision: 42 }) }) as Response);

    bridge.resume();
    await vi.advanceTimersByTimeAsync(0);

    expect(states.length).toBe(before + 1);
    expect(states.at(-1)).toEqual({ coreRevision: 42 });
    // And the revision it carried is now the one the NEXT socket asks its catch-up from.
    bridge.suspend();
    bridge.resume();
    expect(MockWebSocket.instances.at(-1)!.url).toContain("rev=42");
  });

  it("a resume asks for the state once, not once per foreground event", async () => {
    // A foreground fires visibilitychange, pageshow and focus within milliseconds of the host's
    // resume(), and `probeAfterResume` answers each of them with the same /api/state the resume
    // itself sends. The 2s throttle is what collapses those into one — and a resume has to claim
    // that window, or every return from the background costs two identical requests on a phone's
    // mobile data.
    vi.useFakeTimers();
    const transport = createRemoteTransport();
    transport.onStateUpdated(() => {});
    MockWebSocket.instances[0].open();

    const bridge = (window as unknown as Record<string, { suspend(): void; resume(): void }>).__stridetermRemote;
    bridge.suspend();
    const before = capturedUrls.filter((u) => u.includes("/api/state")).length;

    bridge.resume();
    // The resumed socket reaches OPEN, which is what makes the probe take its fetch path rather than
    // its reconnect path — the ordering a real foreground produces.
    MockWebSocket.instances.at(-1)!.open();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(100);

    expect(capturedUrls.filter((u) => u.includes("/api/state")).length).toBe(before + 1);
  });

  it("a 401 ends the session once: the transport goes quiet and the native host is told", async () => {
    // THE BUG THIS CLOSES. A phone returning from the background re-bootstraps, which takes a
    // control-plane round trip or two. Meanwhile the OLD page still had a cookie the host had just
    // cleared, and it kept polling: /api/state, /api/attention/sync, a reconnecting socket. Every one
    // came back 401, every 401 reached the host as an HTTP error, and the host tore down the
    // re-bootstrap that was in flight. Six tickets were minted for one open; one was ever redeemed.
    vi.useFakeTimers();
    const posted: string[] = [];
    (window as unknown as Record<string, unknown>).StridetermHost = {
      postMessage: (message: string) => posted.push(message),
    };
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => "" }) as Response);

    const connections: { connected: boolean; reconnecting?: boolean; message?: string }[] = [];
    const transport = createRemoteTransport();
    transport.onConnectionState((payload) => connections.push(payload));
    MockWebSocket.instances[0].open();

    await expect(transport.getState()).rejects.toThrow();

    const bridge = (
      window as unknown as Record<string, { resume(): void; isSuspended(): boolean; isSessionLost(): boolean }>
    ).__stridetermRemote;
    expect(bridge.isSessionLost()).toBe(true);
    // Quiet: socket closed, and no reconnect however long we wait or however many resume probes fire.
    expect(bridge.isSuspended()).toBe(true);
    const socketsAfter401 = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances.length).toBe(socketsAfter401);

    // Nor does pull-to-refresh punch through. That gesture is what a person does at a screen that
    // has gone quiet, and after a 401 that is every screen — so it is the one path most likely to
    // reopen the storm by hand.
    await transport.refresh!();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances.length).toBe(socketsAfter401);

    // The host hears it exactly once, however many requests were already in flight.
    await expect(transport.getState()).rejects.toThrow();
    expect(posted).toEqual([JSON.stringify({ type: "session-lost" })]);

    // And the banner says the session ended rather than "reconnecting" — the page is not coming back
    // on its own, the host is what brings it back, and with a host listening the banner may say so.
    const ended = connections.at(-1)!;
    expect(ended.connected).toBe(false);
    expect(ended.reconnecting).toBe(false);
    expect(ended.message).toMatch(/session ended/i);
    expect(ended.message).toMatch(/from the app/i);

    // A host that re-bootstraps onto this same document resumes it, and that un-latches the verdict.
    bridge.resume();
    expect(bridge.isSessionLost()).toBe(false);
    expect(MockWebSocket.instances.length).toBe(socketsAfter401 + 1);
    delete (window as unknown as Record<string, unknown>).StridetermHost;
  });

  it("with no native host the banner asks the person to reload, and promises no app", async () => {
    // The same 401, in a browser tab opened from a share URL. Nothing is going to re-bootstrap this
    // page: the reader IS the recovery mechanism, so a banner saying the app is reopening it would be
    // a promise with nobody behind it.
    expect((window as unknown as Record<string, unknown>).StridetermHost).toBeUndefined();
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => "" }) as Response);

    const connections: { connected: boolean; message?: string }[] = [];
    const transport = createRemoteTransport();
    transport.onConnectionState((payload) => connections.push(payload));
    MockWebSocket.instances[0].open();

    await expect(transport.getState()).rejects.toThrow();

    // Quiet all the same — the protection of the desktop does not depend on anyone listening.
    const bridge = (window as unknown as Record<string, { isSessionLost(): boolean; isSuspended(): boolean }>)
      .__stridetermRemote;
    expect(bridge.isSessionLost()).toBe(true);
    expect(bridge.isSuspended()).toBe(true);

    const ended = connections.at(-1)!;
    expect(ended.message).toMatch(/session ended/i);
    expect(ended.message).toMatch(/reload/i);
    expect(ended.message).not.toMatch(/from the app/i);
  });

  it("a close that arrives while suspended does not start a reconnect loop", async () => {
    // The ordering that actually happens on a phone: the socket is closing when the host suspends,
    // and the close event lands afterwards. Before the suspend flag existed, that close scheduled a
    // reconnect and the transport came back up behind a screen nobody was looking at.
    vi.useFakeTimers();
    const transport = createRemoteTransport();
    transport.onConnectionState(() => undefined);
    const first = MockWebSocket.instances[0];
    first.open();

    const bridge = (window as unknown as Record<string, { suspend(): void; isSuspended(): boolean }>)
      .__stridetermRemote;
    bridge.suspend();
    const socketsAfterSuspend = MockWebSocket.instances.length;
    // The late close, delivered on the socket the suspend already abandoned.
    first.close(1006, "network went away");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(MockWebSocket.instances.length).toBe(socketsAfterSuspend);
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

  // review-code-quality-2026-07.md finding §2.2 (src/transport.ts:417-418):
  // handleWsMessage's JSON.parse had no try/catch, so a tunnel/proxy injecting
  // a non-JSON frame (an HTML error body) crashed the message handler and
  // silently dropped that frame's state/terminal update with no log.
  it("a malformed (non-JSON) WS frame is dropped without throwing, and does not affect later valid frames", () => {
    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    first.open();
    const states: unknown[] = [];
    transport.onStateUpdated((payload) => states.push(payload));

    expect(() => first.rawMessage("{not valid json")).not.toThrow();
    expect(states).toHaveLength(0);

    // A subsequent, well-formed frame on the SAME socket still gets through.
    first.message({ type: "state:updated", payload: { coreRevision: 1 } });
    expect(states).toHaveLength(1);
  });

  // The forEach-based dispatch used to abort the rest of a listener set the
  // moment one listener threw. A throwing listener must not silence its
  // siblings registered for the same event.
  it("one throwing terminal:data listener does not prevent sibling listeners from firing", () => {
    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    first.open();
    const seenBySecond: unknown[] = [];
    transport.onTerminalData(() => {
      throw new Error("listener boom");
    });
    transport.onTerminalData((payload) => seenBySecond.push(payload));

    expect(() => first.message({ type: "terminal:data", payload: { sessionId: "ws1:a", data: "hi" } })).not.toThrow();
    expect(seenBySecond).toContainEqual({ sessionId: "ws1:a", data: "hi" });
  });

  // Docker interactive shell: open/close are infrequent (once per tab) so they
  // POST like the log-stream methods; write/resize are per-keystroke frequent
  // so they ride the WS socket exactly like writeTerminal/resizeTerminal do.
  it("dockerShellOpen calls /api/docker/shell/open with the session/container payload", async () => {
    const transport = createRemoteTransport();
    await transport.dockerShellOpen!({
      sessionId: "shell-1",
      containerId: "cnt-1",
      backendId: "host",
      contextName: "default",
      cols: 80,
      rows: 24,
    }).catch(() => {});
    expect(capturedUrls.some((u) => u.includes("/api/docker/shell/open"))).toBe(true);
    expect(capturedBodies).toContainEqual({
      sessionId: "shell-1",
      containerId: "cnt-1",
      backendId: "host",
      contextName: "default",
      cols: 80,
      rows: 24,
    });
  });

  it("dockerShellClose calls /api/docker/shell/close with the sessionId", async () => {
    const transport = createRemoteTransport();
    await transport.dockerShellClose!({ sessionId: "shell-2" }).catch(() => {});
    expect(capturedUrls.some((u) => u.includes("/api/docker/shell/close"))).toBe(true);
    expect(capturedBodies).toContainEqual({ sessionId: "shell-2" });
  });

  it("dockerShellWrite sends docker:shell:write over the WS socket instead of an HTTP POST", async () => {
    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    first.open();
    await transport.dockerShellWrite!({ sessionId: "shell-3", data: "ls\n" });
    expect(first.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: "docker:shell:write",
      sessionId: "shell-3",
      data: "ls\n",
    });
    expect(capturedUrls.some((u) => u.includes("/api/docker/shell"))).toBe(false);
  });

  it("dockerShellResize sends docker:shell:resize over the WS socket", async () => {
    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    first.open();
    await transport.dockerShellResize!({ sessionId: "shell-4", cols: 100, rows: 30 });
    expect(first.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: "docker:shell:resize",
      sessionId: "shell-4",
      cols: 100,
      rows: 30,
    });
  });

  it("dispatches docker:shell:data and docker:shell:close messages to their listeners", () => {
    const transport = createRemoteTransport();
    const first = MockWebSocket.instances[0];
    first.open();
    const dataEvents: unknown[] = [];
    const closeEvents: unknown[] = [];
    transport.onDockerShellData!((payload) => dataEvents.push(payload));
    transport.onDockerShellClose!((payload) => closeEvents.push(payload));

    first.message({ type: "docker:shell:data", payload: { sessionId: "shell-5", data: "$ " } });
    expect(dataEvents).toContainEqual({ sessionId: "shell-5", data: "$ " });

    first.message({ type: "docker:shell:close", payload: { sessionId: "shell-5", code: 0 } });
    expect(closeEvents).toContainEqual({ sessionId: "shell-5", code: 0 });
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
    // Stands in for the Page Visibility API, which Electron pins to "visible"
    // while backgroundThrottling is disabled. A remote browser client has a
    // working visibilitychange and doesn't need the push.
    "onWindowVisibility",
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
    // The approval trail is the accountability record for a bypass that runs
    // on the DESKTOP. Reading it remotely is allowed and useful (GET
    // /api/approvals/audit-log, scoped to the caller's profile); erasing it
    // from a phone is not, for the same reason a remote client may not arm
    // `autoApprovePermissions` in the first place. remote-server.ts registers
    // no delete route, and the Approvals tab hides the delete controls when
    // the transport does not provide this method.
    "deleteApprovalAuditEntries",
    // Performance diagnostics rely on Electron process metrics
    // (app.getAppMetrics) and the webContents CPU profiler, which have no
    // remote-browser equivalent. The Performance panel is gated on the
    // transport advertising these, so it stays hidden on remote clients.
    "getPerformanceSnapshot",
    "captureRendererCpuProfile",
    "revealCpuProfile",
    // Mobile pairing/device management (plan §10.5): Electron/desktop-only.
    // A remote HTTP client must never be able to pair/rename/revoke a mobile
    // device or read its own audit log/quota — that's the same boundary
    // remote-server.ts's sanitizeSettingsFromRemote already enforces for the
    // persisted mobile settings themselves. SettingsMobileTab.vue hides the
    // Mobile settings tab entirely when the transport doesn't advertise
    // createMobilePairingInvitation (the WorkspaceDialog browseDirectory
    // v-if precedent), rather than showing controls that would silently no-op.
    "createMobilePairingInvitation",
    "cancelMobilePairingInvitation",
    "listMobileDevices",
    "renameMobileDevice",
    "revokeMobileDevice",
    // Clearing a revoked row from the list. Desktop-only for the same reason as the rest: the list
    // it edits is this installation's own state blob, not anything a remote client holds.
    "forgetMobileDevice",
    // Review 3 §P0.1: the human decision that activates a pairing, and its refusal. Desktop-only for
    // the same reason the rest of this group is — the pairing code being compared is derived from this
    // installation's own key material, and a remote client is not the party doing the comparing.
    "approveMobileDevice",
    "rejectMobileDevice",
    "listMobileDevicesAwaitingApproval",
    "updateMobileDeviceAllowlist",
    "setMobileEnabled",
    "setMobileRelayEnabled",
    "getMobileRelayStatus",
    "refreshMobileConnectionHealth",
    "sendMobileTestPush",
    "queryMobileAuditLog",
    "onMobileStatus",
    "onMobilePairingProgress",
    "onMobileDeviceRevoked",
    // Account (plan §8.2). Every one of these is desktop-only on purpose, and the reason is not
    // "not yet": signing in, paying and revoking are acts whose consequences land at THIS machine,
    // and a credential crossing a remote HTTP hop is a credential in one more place than it needs to
    // be. It used to say "a password" here, and there is no longer one to say it about — what crosses
    // now is a live sign-in code, which is worse rather than better.
    // `remote-server.ts` routes none of them — asserted separately in remote-server.test.ts.
    "getAccountState",
    // The passwordless sign-in, which is desktop-only for a sharper reason than the rest: the flow
    // holds a live sign-in code and a claim secret in the backend for a few minutes, and the manual
    // fallback carries the whole email link across one IPC hop. None of that belongs on a remote HTTP
    // transport, and the confirmation that redeems the code has to happen at the machine being signed
    // in.
    "accountBeginSignIn",
    "accountConfirmSignIn",
    "accountResendSignIn",
    "accountCancelSignIn",
    "accountReleaseSignInFlow",
    "accountSubmitSignInLink",
    "accountChangeLoginEmail",
    "accountClearPendingEmailChange",
    "accountEnrolInstallation",
    "accountStartTrial",
    "accountRefreshOverview",
    "accountOpenCheckout",
    "accountOpenBillingPortal",
    "accountRevoke",
    "accountAcknowledgeNotice",
    "accountSignOut",
    "accountDelete",
    "accountSubmitDiagnostics",
    "accountExportDiagnostics",
  ]);

  function extractDesktopApiKeys(): string[] {
    const preloadSrc = readFileSync(resolve(process.cwd(), "electron/preload.cts"), "utf8");
    const start = preloadSrc.indexOf('exposeInMainWorld("strideterm", {');
    const end = preloadSrc.indexOf("} satisfies StridetermAPI);", start);
    if (start < 0 || end < 0) throw new Error("Could not locate the strideterm API object literal in preload.cts");
    const body = preloadSrc.slice(start, end);
    const keys = new Set<string>();
    for (const m of body.matchAll(/^ {2}([a-zA-Z_$][\w$]*)[:,]/gm)) keys.add(m[1]);
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

describe("electron transport — performance diagnostics validation", () => {
  const validSnapshot = {
    sampledAt: 1,
    intervalMs: 2000,
    warmingUp: false,
    currentRendererPid: 10,
    totalCpuPercent: 12,
    totalWorkingSetKb: 100,
    systemMemory: { totalKb: 16000, freeKb: 4000 },
    processes: [{ pid: 10, type: "Tab", creationTime: 5, cpuPercent: 12, workingSetKb: 100, isCurrentRenderer: true }],
  };

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).strideterm;
  });

  function stubElectron(overrides: Record<string, unknown>): void {
    (window as unknown as Record<string, unknown>).strideterm = overrides;
  }

  it("passes a valid snapshot through unchanged", async () => {
    stubElectron({ getPerformanceSnapshot: async () => validSnapshot });
    const transport = createTransport();
    expect(transport.isRemote).toBe(false);
    await expect(transport.getPerformanceSnapshot!()).resolves.toEqual(validSnapshot);
  });

  it("rejects a malformed snapshot with a controlled error", async () => {
    // Missing required `processes` / wrong types → schema.parse throws.
    stubElectron({ getPerformanceSnapshot: async () => ({ sampledAt: "nope" }) });
    const transport = createTransport();
    await expect(transport.getPerformanceSnapshot!()).rejects.toThrow();
  });

  it("validates the CPU profile capture result", async () => {
    stubElectron({
      captureRendererCpuProfile: async () => ({ ok: true, path: "/logs/x.cpuprofile", durationMs: 6000 }),
    });
    const transport = createTransport();
    await expect(transport.captureRendererCpuProfile!()).resolves.toEqual({
      ok: true,
      path: "/logs/x.cpuprofile",
      durationMs: 6000,
    });
  });
});

describe("notification:target-removed — transport boundary validation", () => {
  describe("remote transport", () => {
    let originalWebSocket: typeof globalThis.WebSocket;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      MockWebSocket.instances.length = 0;
      originalWebSocket = globalThis.WebSocket;
      originalFetch = globalThis.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
      globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response);
    });

    afterEach(() => {
      globalThis.WebSocket = originalWebSocket;
      globalThis.fetch = originalFetch;
    });

    function connected(): { transport: ReturnType<typeof createRemoteTransport>; socket: MockWebSocket } {
      const transport = createRemoteTransport();
      const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      socket.open();
      return { transport, socket };
    }

    it("dispatches a well-formed workspace removal", () => {
      const { transport, socket } = connected();
      const seen: unknown[] = [];
      transport.onNotificationTargetRemoved((event) => seen.push(event));

      socket.message({
        type: "notification:target-removed",
        payload: { target: "workspace", workspaceId: "ws-1", profileId: "default" },
      });

      expect(seen).toEqual([{ target: "workspace", workspaceId: "ws-1", profileId: "default" }]);
    });

    it("dispatches a well-formed view removal", () => {
      const { transport, socket } = connected();
      const seen: unknown[] = [];
      transport.onNotificationTargetRemoved((event) => seen.push(event));

      socket.message({
        type: "notification:target-removed",
        payload: { target: "view", workspaceId: "ws-1", viewId: "ws-1:a", profileId: "work" },
      });

      expect(seen).toEqual([{ target: "view", workspaceId: "ws-1", viewId: "ws-1:a", profileId: "work" }]);
    });

    // Dropping it here rather than downstream matters: a payload with an empty
    // or missing workspaceId reaching the store would delete the wrong history.
    it("drops a malformed payload instead of dispatching it", () => {
      const { transport, socket } = connected();
      const seen: unknown[] = [];
      transport.onNotificationTargetRemoved((event) => seen.push(event));

      socket.message({ type: "notification:target-removed", payload: { target: "workspace", workspaceId: "" } });
      socket.message({ type: "notification:target-removed", payload: { target: "view", workspaceId: "ws-1" } });
      socket.message({ type: "notification:target-removed", payload: null });

      expect(seen).toEqual([]);
    });
  });

  describe("electron transport", () => {
    afterEach(() => {
      delete (window as unknown as Record<string, unknown>).strideterm;
    });

    function stubElectron(): (payload: unknown) => void {
      let bridged: ((payload: unknown) => void) | null = null;
      (window as unknown as Record<string, unknown>).strideterm = {
        onNotificationTargetRemoved: (handler: (payload: unknown) => void) => {
          bridged = handler;
        },
      };
      return (payload: unknown) => bridged?.(payload);
    }

    it("subscribes through the preload bridge and dispatches a valid event", () => {
      const emitFromMain = stubElectron();
      const transport = createTransport();
      const seen: unknown[] = [];
      transport.onNotificationTargetRemoved((event) => seen.push(event));

      emitFromMain({ target: "workspace", workspaceId: "ws-1", profileId: "default" });

      expect(seen).toEqual([{ target: "workspace", workspaceId: "ws-1", profileId: "default" }]);
    });

    it("drops a malformed event", () => {
      const emitFromMain = stubElectron();
      const transport = createTransport();
      const seen: unknown[] = [];
      transport.onNotificationTargetRemoved((event) => seen.push(event));

      emitFromMain({ target: "workspace", workspaceId: "ws-1", profileId: "default", viewId: "extra" });
      emitFromMain("not an object");

      expect(seen).toEqual([]);
    });
  });
});

/**
 * What a failed remote request actually says to the person holding the phone.
 *
 * THE BUG THESE PIN. `request()` passed `await response.text()` — the whole HTTP response body — as
 * the error's `rawMessage`, and any status without its own branch fell through to
 * `message = rawMessage`. The server answers every failure as `{"error":"<sentence>"}` (see `json()`
 * in electron/backend/remote-server.ts), so the workspace banner rendered the raw envelope, braces
 * and quotes included, as a single unbreakable token. On a phone that is three faults at once: it
 * reads as leaked plumbing, it stretches the hero sideways because the token cannot wrap, and the
 * only actionable words in it are buried in punctuation.
 *
 * The case that surfaced it is the 403 below — the server refusing a profile switch inside a mobile
 * session, which is by design and is not a fault at all.
 */
describe("remote transport failure messages", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebSocket: typeof globalThis.WebSocket;

  function respondWith(status: number, body: string) {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: status >= 200 && status < 300,
          status,
          text: async () => body,
          json: async () => JSON.parse(body || "{}"),
          headers: { get: () => null },
        }) as unknown as Response,
    );
  }

  /** The error one request threw, with the fields the UI reads. */
  async function failureOf(status: number, body: string) {
    respondWith(status, body);
    const transport = createRemoteTransport();
    try {
      await transport.getState();
      throw new Error("expected the request to fail");
    } catch (error) {
      return error as Error & { statusCode: number; hint: string; rawMessage: string };
    }
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  it("unwraps the server's {error} envelope instead of showing it", async () => {
    const failure = await failureOf(409, '{"error":"That workspace is already open elsewhere."}');
    expect(failure.message).toBe("That workspace is already open elsewhere.");
    // The shape the banner used to render, and the reason it stretched the page.
    expect(failure.message).not.toContain("{");
    expect(failure.message).not.toContain('"error"');
  });

  it("turns the mobile profile-switch refusal into an instruction, not an error", async () => {
    const failure = await failureOf(403, '{"error":"Mobile sessions cannot switch profiles"}');
    // It is not a fault: a session's ticket is minted for one profile on purpose. So the banner says
    // what is true and where the switch actually lives, rather than reporting a failure.
    expect(failure.message).toBe("This session is tied to one profile.");
    expect(failure.hint).toContain("strIDEterm app");
  });

  it("keeps a hint attached to the statuses a person can act on", async () => {
    expect((await failureOf(401, '{"error":"no session"}')).hint).toContain("Open this terminal again");
    expect((await failureOf(503, "")).hint).toContain("come back on its own");
  });

  it("leaves a non-JSON body exactly as it was", async () => {
    // A proxy's HTML page, a plain-text body, a gateway's own words: none of those are the envelope
    // this unwraps, and mangling them would lose the only information there is.
    const failure = await failureOf(500, "upstream connect error");
    expect(failure.message).toBe("upstream connect error");
  });

  it("a body that starts like JSON and is not falls back to the raw text", async () => {
    const failure = await failureOf(500, '{"error": truncated');
    expect(failure.message).toBe('{"error": truncated');
  });

  it("an empty body still says something", async () => {
    const failure = await failureOf(418, "");
    expect(failure.message).toBe("Remote connection failed.");
  });

  it("carries the hint to the connection-state listeners the banner reads", async () => {
    respondWith(403, '{"error":"Mobile sessions cannot switch profiles"}');
    const transport = createRemoteTransport();
    const states: Array<{ connected: boolean; message?: string; hint?: string }> = [];
    transport.onConnectionState((state) => states.push(state));
    await transport.getState().catch(() => {});

    const failed = states.find((state) => !state.connected);
    expect(failed?.message).toBe("This session is tied to one profile.");
    // The store reads the hint from here — a message that arrived without one would leave the
    // banner saying what happened and not what to do, which is where this started.
    expect(failed?.hint).toContain("strIDEterm app");
  });
});

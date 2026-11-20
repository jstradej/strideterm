import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { peerDirectoryListSchema, type PeerDirectoryListing } from "../electron/shared/peers.js";
import {
  createPeerRemoteIo,
  createPeerTransport,
  createRemoteTransport,
  createTransport,
  type PeerBridge,
} from "./transport.js";

type WsState = { state: "open" } | { state: "closed"; code: number; reason: string };
type HttpRequest = Parameters<PeerBridge["http"]>[0];
type HttpReply = Awaited<ReturnType<PeerBridge["http"]>>;

const CLIENT_ID = "peer-window-0001";

function createFakeBridge(reply: (request: HttpRequest) => Promise<HttpReply> | HttpReply = () => json({})) {
  const stateHandlers = new Set<(state: WsState) => void>();
  const messageHandlers = new Set<(data: string) => void>();
  const bridge = {
    requests: [] as HttpRequest[],
    wsOpens: [] as Array<Record<string, string>>,
    wsSent: [] as string[],
    wsCloses: [] as Array<{ code?: number; reason?: string }>,
    reply,
    emitState: (state: WsState) => stateHandlers.forEach((handler) => handler(state)),
    emitMessage: (message: unknown) =>
      messageHandlers.forEach((handler) => handler(typeof message === "string" ? message : JSON.stringify(message))),
  };
  const api: PeerBridge = {
    clientId: CLIENT_ID,
    http: async (request) => {
      bridge.requests.push(request);
      return bridge.reply(request);
    },
    wsOpen: (query) => void bridge.wsOpens.push(query),
    wsSend: (data) => void bridge.wsSent.push(data),
    wsClose: (code, reason) => void bridge.wsCloses.push({ code, reason }),
    onWsState: (handler) => {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },
    onWsMessage: (handler) => {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
  };
  return Object.assign(bridge, { api });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): HttpReply {
  return { status, headers, body: JSON.stringify(body) };
}

describe("peer transport", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebSocket: typeof globalThis.WebSocket;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let webSocketSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebSocket = globalThis.WebSocket;
    fetchSpy = vi.fn(async () => new Response("{}"));
    webSocketSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    globalThis.WebSocket = webSocketSpy as unknown as typeof WebSocket;
    window.sessionStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).strideterm;
  });

  it("sends API calls through the bridge with the client headers, no Authorization and no fetch", async () => {
    const bridge = createFakeBridge(() => json({ coreRevision: 3 }));
    const transport = createPeerTransport(bridge.api);

    await expect(transport.getState()).resolves.toEqual({ coreRevision: 3 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(bridge.requests).toHaveLength(1);
    const request = bridge.requests[0];
    expect(request.method).toBe("GET");
    expect(request.pathname).toBe("/api/state");
    expect(request.headers["X-Strideterm-Client-Id"]).toBe(CLIENT_ID);
    expect(request.headers["X-Strideterm-State-Protocol"]).toBe("2");
    expect(request.headers["X-Strideterm-Capabilities"]).toBe("remote-core-v2,resource-details-v1");
    expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain("authorization");
  });

  it("revalidates a GET with the ETag the peer sent, whatever its header casing", async () => {
    const bridge = createFakeBridge((request) =>
      request.headers["If-None-Match"] ? { status: 304, headers: {}, body: "" } : json({ n: 1 }, 200, { etag: '"v1"' }),
    );
    const transport = createPeerTransport(bridge.api);

    await expect(transport.getState()).resolves.toEqual({ n: 1 });
    await expect(transport.getState()).resolves.toEqual({ n: 1 });
    expect(bridge.requests[1].headers["If-None-Match"]).toBe('"v1"');
  });

  it("posts a JSON body for a write", async () => {
    const bridge = createFakeBridge(() => json({ ok: true }));
    const transport = createPeerTransport(bridge.api);

    await transport.activateWorkspace("w1");

    const request = bridge.requests.at(-1)!;
    expect(request.method).toBe("POST");
    expect(request.pathname).toBe("/api/remote-client/workspace/activate");
    expect(JSON.parse(request.body!)).toEqual({ workspaceId: "w1" });
  });

  it("opens the socket through the bridge with clientId, sp and caps and no token", () => {
    const bridge = createFakeBridge();
    createPeerTransport(bridge.api);

    expect(webSocketSpy).not.toHaveBeenCalled();
    expect(bridge.wsOpens).toEqual([{ clientId: CLIENT_ID, sp: "2", caps: "remote-core-v2,resource-details-v1" }]);
    expect(Object.keys(bridge.wsOpens[0])).not.toContain("token");
  });

  it("delivers bridged socket messages to the same listeners as the web transport", () => {
    const bridge = createFakeBridge();
    const transport = createPeerTransport(bridge.api);
    const states: unknown[] = [];
    const data: unknown[] = [];
    const connections: Array<{ connected: boolean }> = [];
    transport.onStateUpdated((payload) => states.push(payload));
    transport.onTerminalData((payload) => data.push(payload));
    transport.onConnectionState((state) => connections.push(state));

    bridge.emitState({ state: "open" });
    bridge.emitMessage({ type: "state:updated", payload: { coreRevision: 7 } });
    bridge.emitMessage({ type: "terminal:data", payload: { sessionId: "s1", data: "hi" } });

    expect(connections.at(0)).toEqual(expect.objectContaining({ connected: true }));
    expect(states).toEqual([{ coreRevision: 7 }]);
    expect(data).toEqual([{ sessionId: "s1", data: "hi" }]);
  });

  it("sends what the transport writes only once the logical socket is open, then flushes", () => {
    const bridge = createFakeBridge();
    const transport = createPeerTransport(bridge.api);

    transport.subscribeTerminals(["s1"]);
    expect(bridge.wsSent).toEqual([]);

    bridge.emitState({ state: "open" });
    expect(bridge.wsSent.map((message) => JSON.parse(message))).toContainEqual({
      type: "terminal:subscribe",
      sessionIds: ["s1"],
    });
  });

  it("reconnects through the bridge after the socket closes, as the web transport does", async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    const transport = createPeerTransport(bridge.api);
    const connections: Array<{ connected: boolean; reconnecting?: boolean }> = [];
    transport.onConnectionState((state) => connections.push(state));

    bridge.emitState({ state: "open" });
    bridge.emitState({ state: "closed", code: 1006, reason: "" });

    expect(connections.at(-1)).toEqual(expect.objectContaining({ connected: false, reconnecting: true }));
    expect(bridge.wsOpens).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(bridge.wsOpens).toHaveLength(2);
    expect(webSocketSpy).not.toHaveBeenCalled();

    bridge.emitState({ state: "open" });
    expect(connections.at(-1)).toEqual(expect.objectContaining({ connected: true, reconnected: true }));
  });

  it("drops messages that arrive for a closed logical socket", () => {
    const bridge = createFakeBridge();
    const transport = createPeerTransport(bridge.api);
    const states: unknown[] = [];
    transport.onStateUpdated((payload) => states.push(payload));

    bridge.emitState({ state: "open" });
    bridge.emitState({ state: "closed", code: 1006, reason: "" });
    bridge.emitMessage({ type: "state:updated", payload: { coreRevision: 9 } });

    expect(states).toEqual([]);
  });

  it("treats a server close with 1008 as a lost session and does not reconnect", async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    const transport = createPeerTransport(bridge.api);
    const connections: Array<{ connected: boolean; reconnecting?: boolean }> = [];
    transport.onConnectionState((state) => connections.push(state));

    bridge.emitState({ state: "open" });
    bridge.emitState({ state: "closed", code: 1008, reason: "session expired" });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(connections.at(-1)).toEqual(expect.objectContaining({ connected: false, reconnecting: false }));
    expect(bridge.wsOpens).toHaveLength(1);
  });

  it("treats HTTP 401 as a lost session and stops talking", async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge(() => ({ status: 401, headers: {}, body: '{"error":"unauthorized"}' }));
    const transport = createPeerTransport(bridge.api);
    const connections: Array<{ connected: boolean; reconnecting?: boolean }> = [];
    transport.onConnectionState((state) => connections.push(state));
    bridge.emitState({ state: "open" });

    await expect(transport.getState()).rejects.toMatchObject({ statusCode: 401, isRemoteTransport: true });

    expect(connections.at(-1)).toEqual(expect.objectContaining({ connected: false, reconnecting: false }));
    expect(bridge.wsCloses).toEqual([{ code: 1000, reason: "suspended" }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bridge.wsOpens).toHaveLength(1);
  });

  it("reports a non-2xx status like a fetch Response and a rejected bridge call like a network error", async () => {
    const bridge = createFakeBridge(() => ({ status: 500, headers: {}, body: '{"error":"boom"}' }));
    const transport = createPeerTransport(bridge.api);
    await expect(transport.getState()).rejects.toMatchObject({ statusCode: 500, rawMessage: "boom" });

    bridge.reply = () => Promise.reject(new Error("ECONNREFUSED"));
    await expect(transport.getState()).rejects.toMatchObject({ kind: "network", statusCode: 0 });
  });

  it("rejects an aborted request like fetch does, without waiting for the bridge", async () => {
    const bridge = createFakeBridge(() => new Promise<HttpReply>(() => {}));
    const io = createPeerRemoteIo(bridge.api);
    const controller = new AbortController();

    const pending = io.request("/api/state", { method: "GET", headers: {}, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("has no token: nothing in sessionStorage, nothing in the URL, setRemoteToken is a no-op", () => {
    window.history.replaceState({}, "", "/?token=should-not-be-read");
    const bridge = createFakeBridge();
    const transport = createPeerTransport(bridge.api);
    const before = window.location.href;

    expect(transport.getRemoteToken()).toBe("");
    transport.setRemoteToken("abc");

    expect(transport.getRemoteToken()).toBe("");
    expect(window.sessionStorage.getItem("strideterm-token")).toBeNull();
    expect(window.sessionStorage.getItem("strideterm-remote-client-id")).toBeNull();
    expect(window.location.href).toBe(before);
    expect(JSON.stringify(bridge.wsOpens)).not.toContain("should-not-be-read");
    window.history.replaceState({}, "", "/");
  });

  it("is remote with a native shell and installs no mobile host bridge", () => {
    const postMessage = vi.fn();
    (window as unknown as Record<string, unknown>).StridetermHost = { postMessage };
    delete (window as unknown as Record<string, unknown>).__stridetermRemote;
    try {
      const bridge = createFakeBridge();
      const transport = createPeerTransport(bridge.api);
      bridge.emitState({ state: "open" });

      expect(transport.isRemote).toBe(true);
      expect(transport.hasNativeShell).toBe(true);
      expect(transport.browseDirectory).toBeUndefined();
      expect((window as unknown as Record<string, unknown>).__stridetermRemote).toBeUndefined();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      delete (window as unknown as Record<string, unknown>).StridetermHost;
    }
  });
});

describe("hasNativeShell", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).strideterm;
    delete (window as unknown as Record<string, unknown>).__stridetermRemote;
  });

  it("is true for the Electron transport", () => {
    (window as unknown as Record<string, unknown>).strideterm = {};
    const transport = createTransport();
    expect(transport.isRemote).toBe(false);
    expect(transport.hasNativeShell).toBe(true);
  });

  it("is false for the web remote transport", () => {
    class IdleWebSocket {
      static OPEN = 1;
      addEventListener() {}
      send() {}
      close() {}
      readyState = 0;
    }
    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = IdleWebSocket as unknown as typeof WebSocket;
    try {
      const transport = createRemoteTransport();
      (window as unknown as { __stridetermRemote?: { suspend?: () => void } }).__stridetermRemote?.suspend?.();
      expect(transport.isRemote).toBe(true);
      expect(transport.hasNativeShell).toBe(false);
      expect(transport.listHostDirectories).toBeUndefined();
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("has no host folder listing on the Electron transport", () => {
    (window as unknown as Record<string, unknown>).strideterm = {};
    expect(createTransport().listHostDirectories).toBeUndefined();
  });
});

describe("listHostDirectories on the peer transport", () => {
  const listing: PeerDirectoryListing = {
    path: "/srv",
    parent: null,
    separator: "/",
    entries: [{ name: "code" }],
    roots: ["/home/host", "/"],
    truncated: false,
  };

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).strideterm;
  });

  it("posts the exact payload to the host's folder route and returns the listing", async () => {
    const bridge = createFakeBridge(() => json(listing));
    const transport = createPeerTransport(bridge.api);
    expect(typeof transport.listHostDirectories).toBe("function");

    await expect(transport.listHostDirectories!({ path: "/srv" })).resolves.toEqual(listing);

    const request = bridge.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.pathname).toBe("/api/peer/fs/list");
    const body = JSON.parse(request.body ?? "");
    expect(body).toEqual({ path: "/srv" });
    expect(peerDirectoryListSchema.safeParse(body).success).toBe(true);
    expect(request.headers["X-Strideterm-Client-Id"]).toBe(CLIENT_ID);
  });

  it("sends an empty path for the home folder, and refuses an answer it cannot read", async () => {
    const bridge = createFakeBridge(() => json({ path: 5 }));
    const transport = createPeerTransport(bridge.api);
    await expect(transport.listHostDirectories!({ path: "" })).rejects.toThrow(/cannot read/);
    expect(JSON.parse(bridge.requests[0]!.body ?? "")).toEqual({ path: "" });
  });

  it("surfaces the host's sentence for a refused folder", async () => {
    const bridge = createFakeBridge(() => json({ error: "That folder was not found." }, 404));
    const transport = createPeerTransport(bridge.api);
    await expect(transport.listHostDirectories!({ path: "/nope" })).rejects.toThrow(/That folder was not found/);
  });
});

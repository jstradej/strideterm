/**
 * The phone's terminal-readiness handshake, end to end on the page side: the REAL remote transport and
 * the REAL terminal store, driven by messages shaped exactly as the phone build in the field shapes
 * them, with every answer held to the phone's own decoder.
 *
 * The phone side is the committed code of strideterm-mobile @ ae2993b:
 *  - the challenge: `remote_webview_controller.dart`, `_refreshTerminalReady` — `jsonEncode({requestId,
 *    documentEpoch, openAttempt, target: {profileId, workspaceId, panelId}, connectionGeneration})`
 *    evaluated as `window.__stridetermRemote?.requestTerminalReady?.($detail)`, where
 *    `connectionGeneration` is the last `connection-state` the page posted;
 *  - the answer: `remote_page_bridge.dart`, `decodeHostMessage`, case 'terminal-ready' — mirrored by
 *    `phoneDecodesTerminalReady` below, check for check. It reads named keys only, which is why the new
 *    `reason` field can ride on the existing message without a protocol bump.
 *
 * Only the xterm controller is replaced: it is where a replay is PARSED, and the test decides when that
 * happens by calling the `onParsed` the store handed it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const replayCalls = vi.hoisted(() => [] as Array<{ sessionId: string; onParsed?: () => void }>);
vi.mock("./app/terminal-controller.js", () => ({
  createTerminalController: () => ({
    syncFontSize: vi.fn(),
    syncTheme: vi.fn(),
    handleTerminalData: vi.fn(),
    handleTerminalReplay: (args: { sessionId: string; onParsed?: () => void }) => replayCalls.push(args),
    handleTerminalExit: vi.fn(),
    scheduleAllVisibleResize: vi.fn(),
  }),
}));

import { createRemoteTransport } from "./transport.js";
import { TERMINAL_READY_TARGET_GRACE_MS, useTerminalStore } from "./stores/terminal.js";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private handlers = new Map<string, Set<(event: { code?: number; reason?: string; data?: string }) => void>>();
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  addEventListener(type: string, handler: (event: { code?: number; reason?: string; data?: string }) => void) {
    const handlers = this.handlers.get(type) || new Set();
    handlers.add(handler);
    this.handlers.set(type, handlers);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1006, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }
  message(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
  private emit(type: string, event: { code?: number; reason?: string; data?: string }) {
    for (const handler of this.handlers.get(type) || []) handler(event);
  }
}

// ---------------------------------------------------------------------------------------------
// The phone's decoder for `terminal-ready` (remote_page_bridge.dart @ ae2993b). `null` is where the
// Dart returns InvalidHostMessage/MalformedHostMessage — a message the phone drops without a trace.
// ---------------------------------------------------------------------------------------------
interface PhoneTerminalReady {
  requestId: number;
  documentEpoch: number;
  openAttempt: number;
  profileId: string;
  workspaceId: string | null;
  panelId: string | null;
  connectionGeneration: number;
  ready: boolean;
  viewKind: string;
}

function phoneDecodesTerminalReady(raw: string): PhoneTerminalReady | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  // `decoded is! Map<String, dynamic>` → MalformedHostMessage.
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const d = decoded as Record<string, unknown>;
  if (d.type !== "terminal-ready") return null;
  // Dart's `is int`: a JSON number without a fraction.
  const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
  const target = d.target;
  const isMap = !!target && typeof target === "object" && !Array.isArray(target);
  const t = (isMap ? target : {}) as Record<string, unknown>;
  const { requestId, documentEpoch, openAttempt, connectionGeneration: generation, ready, viewKind } = d;
  if (
    !isInt(requestId) ||
    requestId < 1 ||
    requestId > 1_000_000 ||
    !isInt(documentEpoch) ||
    documentEpoch < 0 ||
    documentEpoch > 1_000_000 ||
    !isInt(openAttempt) ||
    openAttempt < 1 ||
    openAttempt > 1_000_000 ||
    !isMap ||
    typeof t.profileId !== "string" ||
    t.profileId.length === 0 ||
    (t.workspaceId != null && typeof t.workspaceId !== "string") ||
    (t.panelId != null && typeof t.panelId !== "string") ||
    !isInt(generation) ||
    generation < 1 ||
    generation > 1_000_000 ||
    typeof ready !== "boolean" ||
    typeof viewKind !== "string" ||
    !["terminal", "nonterminal", "empty-state"].includes(viewKind)
  ) {
    return null;
  }
  return {
    requestId,
    documentEpoch,
    openAttempt,
    profileId: t.profileId,
    workspaceId: (t.workspaceId as string | null | undefined) ?? null,
    panelId: (t.panelId as string | null | undefined) ?? null,
    connectionGeneration: generation,
    ready,
    viewKind,
  };
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

/** `remoteClient` + panels exactly as composePayload (remote-client-registry.ts) sends them. */
function serverState(activeWorkspaceId: string, activeSessionId: string) {
  return {
    remoteClient: { id: "client-1", profileId: "p1", activeWorkspaceId, activeSessionId, workspaceGrid: null },
    appState: {
      workspaces: [
        { id: "ws1", profileId: "p1", name: "One", panels: [{ id: "shell", title: "Shell" }] },
        { id: "ws2", profileId: "p1", name: "Two", panels: [{ id: "build", title: "Build" }] },
      ],
    },
  };
}

interface Page {
  posted: string[];
  socket: MockWebSocket;
  transport: ReturnType<typeof createRemoteTransport>;
  /** What the app store has applied — what the terminal store reads as `getPayload()`. */
  setAppPayload(payload: unknown): void;
  setActiveSession(sessionId: string | null): void;
  /** The phone's challenge, built as `_refreshTerminalReady` builds it. */
  challenge(requestId: number, target: { workspaceId: string | null; panelId: string | null }): void;
  answers(requestId: number): Array<{ raw: Record<string, unknown>; phone: PhoneTerminalReady | null }>;
  lastConnectionState(): Record<string, unknown> | undefined;
}

function openPage(): Page {
  const posted: string[] = [];
  (window as unknown as Record<string, unknown>).StridetermHost = { postMessage: (m: string) => posted.push(m) };
  const transport = createRemoteTransport();
  let appPayload: unknown = null;
  let activeSession: string | null = null;
  useTerminalStore().init(
    transport,
    {},
    {
      getActiveSessionId: () => activeSession,
      getOverlay: () => null,
      getPayload: () => appPayload as never,
    },
  );
  const socket = MockWebSocket.instances.at(-1)!;
  const parsed = () => posted.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  const lastConnectionState = () =>
    parsed()
      .filter((m) => m.type === "connection-state")
      .at(-1);
  return {
    posted,
    socket,
    transport,
    setAppPayload: (payload) => (appPayload = payload),
    setActiveSession: (sessionId) => (activeSession = sessionId),
    challenge(requestId, target) {
      // The phone reads the generation from the page's last `connection-state` (`_connectionGeneration`).
      const generation = lastConnectionState()?.connectionGeneration as number;
      const detail = JSON.stringify({
        requestId,
        documentEpoch: 1,
        openAttempt: 1,
        target: { profileId: "p1", workspaceId: target.workspaceId, panelId: target.panelId },
        connectionGeneration: generation,
      });
      (
        window as unknown as { __stridetermRemote: { requestTerminalReady(value: unknown): void } }
      ).__stridetermRemote.requestTerminalReady(JSON.parse(detail));
    },
    answers(requestId) {
      return posted
        .filter((raw) => (JSON.parse(raw) as { type?: string }).type === "terminal-ready")
        .map((raw) => ({ raw: JSON.parse(raw) as Record<string, unknown>, phone: phoneDecodesTerminalReady(raw) }))
        .filter(({ raw }) => raw.requestId === requestId);
    },
    lastConnectionState,
  };
}

/** The bootstrap a real page goes through: socket open, state over the socket, the visible panel subscribed. */
function bootstrap(page: Page, workspaceId: string, sessionId: string) {
  page.socket.open();
  const state = serverState(workspaceId, sessionId);
  page.socket.message({ type: "state:updated", payload: state });
  page.setAppPayload(state);
  page.setActiveSession(sessionId);
  page.transport.subscribeTerminals([sessionId]);
}

/** The server's replay frame, as remote-server.ts `handleTerminalSubscribe` sends it, parsed by "xterm". */
function serverReplays(page: Page, sessionId: string) {
  page.socket.message({ type: "terminal:replay", payload: { sessionId, data: "$ ", throughSeq: 3 } });
  const call = replayCalls.filter((entry) => entry.sessionId === sessionId).at(-1);
  call?.onParsed?.();
}

describe("terminal readiness as the phone sees it", () => {
  let originalWebSocket: typeof globalThis.WebSocket;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    replayCalls.length = 0;
    MockWebSocket.instances.length = 0;
    originalWebSocket = globalThis.WebSocket;
    originalFetch = globalThis.fetch;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
  });

  afterEach(() => {
    (window as unknown as Record<string, { suspend?: () => void } | undefined>).__stridetermRemote?.suspend?.();
    delete (window as unknown as Record<string, unknown>).StridetermHost;
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  test("the page still advertises terminal-ready protocol 1, the only value the phone does not treat as legacy", () => {
    const page = openPage();
    // remote_webview_controller.dart: `if (_terminalReadyProtocol != 1)` → legacy behaviour.
    expect(page.posted.map((raw) => JSON.parse(raw)).filter((m) => m.type === "bridge-ready")).toEqual([
      { type: "bridge-ready", terminalReadyProtocol: 1 },
    ]);
  });

  test("a target the app store has not applied yet is held, then answered ready once it has", async () => {
    const page = openPage();
    bootstrap(page, "ws1", "ws1:shell");
    serverReplays(page, "ws1:shell");
    // The server moves the selection; the transport records it at once, the app store a moment later
    // (it holds payloads while an activation is pending — stores/app.ts handleBroadcastPayload).
    const moved = serverState("ws2", "ws2:build");
    page.socket.message({ type: "state:updated", payload: moved });
    page.transport.subscribeTerminals(["ws2:build"]);

    page.challenge(7, { workspaceId: "ws2", panelId: "build" });
    await vi.advanceTimersByTimeAsync(600);
    // Old behaviour: an immediate, final `ready:false` here.
    expect(page.answers(7)).toEqual([]);

    page.setAppPayload(moved);
    page.setActiveSession("ws2:build");
    serverReplays(page, "ws2:build");
    await vi.advanceTimersByTimeAsync(300);

    const answers = page.answers(7);
    expect(answers).toHaveLength(1);
    expect(answers[0].phone).toEqual({
      requestId: 7,
      documentEpoch: 1,
      openAttempt: 1,
      profileId: "p1",
      workspaceId: "ws2",
      panelId: "build",
      connectionGeneration: 1,
      ready: true,
      viewKind: "terminal",
    });
    expect(answers[0].raw).not.toHaveProperty("reason");
  });

  test("a target the app store never applies is refused after the grace, with a reason the phone tolerates", async () => {
    const page = openPage();
    bootstrap(page, "ws1", "ws1:shell");
    serverReplays(page, "ws1:shell");
    page.socket.message({ type: "state:updated", payload: serverState("ws2", "ws2:build") });

    page.challenge(8, { workspaceId: "ws2", panelId: "build" });
    await vi.advanceTimersByTimeAsync(TERMINAL_READY_TARGET_GRACE_MS - 300);
    expect(page.answers(8)).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);

    const answers = page.answers(8);
    expect(answers).toHaveLength(1);
    expect(answers[0].raw).toMatchObject({ ready: false, viewKind: "empty-state", reason: "target-mismatch" });
    // The extra field does not make the phone drop the answer.
    expect(answers[0].phone).toMatchObject({ requestId: 8, ready: false, viewKind: "empty-state" });
  });

  test("every refusal names its reason, and every one still decodes on the phone", async () => {
    const page = openPage();
    // Before the socket opens: the phone may ask on the HTTP reply's `connected`.
    await page.transport.getState();
    page.challenge(20, { workspaceId: null, panelId: null });
    bootstrap(page, "ws1", "ws1:shell");
    // Then waiting for a replay that never comes.
    page.challenge(21, { workspaceId: "ws1", panelId: "shell" });
    await vi.advanceTimersByTimeAsync(25_000);

    const reasons = [20, 21].map((id) => page.answers(id).map(({ raw }) => raw.reason));
    expect(reasons[0]).toEqual(["socket-connecting"]);
    expect(reasons[1]).toEqual(["replay-timeout"]);
    for (const id of [20, 21]) {
      for (const answer of page.answers(id)) expect(answer.phone, JSON.stringify(answer.raw)).not.toBeNull();
    }
  });

  test("a route the desktop refuses is not a disconnect: the proof survives and the phone gets ready", async () => {
    const page = openPage();
    bootstrap(page, "ws1", "ws1:shell");
    serverReplays(page, "ws1:shell");
    const connectedBefore = page.lastConnectionState();
    expect(connectedBefore).toMatchObject({ connected: true });

    // The body the route gate answers a mobile session with (remote-server.ts evaluateMobileSessionRequest).
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ error: "Not available to a mobile session", reason: "profile" }),
        }) as Response,
    );
    await expect(page.transport.activateProfile("p2")).rejects.toThrow("Not available to a mobile session");

    // Old behaviour: `connection-state {connected:false}` to the phone, and the replay proof cleared.
    expect(page.lastConnectionState()).toEqual(connectedBefore);
    page.challenge(30, { workspaceId: "ws1", panelId: "shell" });
    expect(page.answers(30).map(({ phone }) => phone?.ready)).toEqual([true]);
  });

  test("a proof lost on a socket that stayed up asks the server for the replay again, once", async () => {
    const page = openPage();
    bootstrap(page, "ws1", "ws1:shell");
    serverReplays(page, "ws1:shell");

    // One request fails on the network while the socket stays open: a real `connected:false`.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(page.transport.getState()).rejects.toThrow();
    expect(page.lastConnectionState()).toMatchObject({ connected: false });
    // The socket speaks again; same socket, same generation.
    page.socket.message({ type: "state:updated", payload: serverState("ws1", "ws1:shell") });
    expect(page.lastConnectionState()).toMatchObject({ connected: true, connectionGeneration: 1 });

    const sentBefore = page.socket.sent.length;
    page.challenge(40, { workspaceId: "ws1", panelId: "shell" });
    await vi.advanceTimersByTimeAsync(900);
    const replayRequests = page.socket.sent.slice(sentBefore).map((raw) => JSON.parse(raw));
    // Exactly the message remote-server.test.ts holds the real server to.
    expect(replayRequests).toEqual([{ type: "terminal:subscribe", sessionIds: ["ws1:shell"], replay: ["ws1:shell"] }]);
    expect(page.answers(40)).toEqual([]);

    serverReplays(page, "ws1:shell");
    await vi.advanceTimersByTimeAsync(300);
    expect(page.answers(40).map(({ phone }) => phone?.ready)).toEqual([true]);
  });
});

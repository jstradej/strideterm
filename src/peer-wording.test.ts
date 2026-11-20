import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPeerTransport, createRemoteTransport, type PeerBridge, type Transport } from "./transport.js";

type HttpReply = Awaited<ReturnType<PeerBridge["http"]>>;
type WsState = { state: "open" } | { state: "closed"; code: number; reason: string };

// Phrases that only make sense for a browser tab or the phone app.
const WEB_ONLY =
  /token|reload|this page|open this terminal again|from the (strIDEterm )?app|argo|cloudflare|tunnel|phone|the desktop (app )?(refused|may)/i;

function bridge(reply: () => Promise<HttpReply>) {
  const stateHandlers = new Set<(state: WsState) => void>();
  const api: PeerBridge = {
    clientId: "peer-window-0001",
    http: reply,
    wsOpen: () => {},
    wsSend: () => {},
    wsClose: () => {},
    onWsState: (handler) => {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },
    onWsMessage: () => () => {},
  };
  return { api, emitState: (state: WsState) => stateHandlers.forEach((handler) => handler(state)) };
}

const reply = (status: number, body = ""): HttpReply => ({ status, headers: {}, body });

describe("peer window wording", () => {
  let transport: Transport | null = null;

  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    transport?.suspendConnection?.();
    transport = null;
    vi.useRealTimers();
  });

  async function failureOf(call: () => Promise<unknown>): Promise<{ message: string; hint: string }> {
    const error = (await call().then(
      () => null,
      (err: unknown) => err,
    )) as { message: string; hint: string } | null;
    expect(error).not.toBeNull();
    return { message: error!.message, hint: error!.hint };
  }

  it.each([
    ["a 401 from the host", () => Promise.resolve(reply(401, '{"error":"Remote token is missing or invalid."}'))],
    ["a 403", () => Promise.resolve(reply(403, ""))],
    ["a 502", () => Promise.resolve(reply(502, ""))],
    ["a 503", () => Promise.resolve(reply(503, ""))],
    ["a 530", () => Promise.resolve(reply(530, ""))],
    ["a 423 pause", () => Promise.resolve(reply(423, '{"error":"Remote access is temporarily paused"}'))],
    ["a link that cannot be opened", () => Promise.reject(new Error("ECONNREFUSED"))],
  ])("never uses web or phone wording for %s", async (_name, answer) => {
    const peer = bridge(answer);
    transport = createPeerTransport(peer.api);

    const { message, hint } = await failureOf(() => transport!.getState());

    expect(message).not.toMatch(WEB_ONLY);
    expect(hint).not.toMatch(WEB_ONLY);
    expect(message).toMatch(/other computer/i);
  });

  it("words the same failures for the web client as before", async () => {
    class IdleWebSocket {
      static OPEN = 1;
      addEventListener() {}
      send() {}
      close() {}
      readyState = 0;
    }
    const originalWebSocket = globalThis.WebSocket;
    const originalFetch = globalThis.fetch;
    globalThis.WebSocket = IdleWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    try {
      transport = createRemoteTransport();
      const { message, hint } = await failureOf(() => transport!.getState());
      expect(message).toBe("Remote token is missing or invalid.");
      expect(hint).toBe("Open this terminal again from the strIDEterm app to get a fresh one.");
    } finally {
      globalThis.WebSocket = originalWebSocket;
      globalThis.fetch = originalFetch;
    }
  });

  it("tells a session that the host closed in peer words, with nothing to reload", async () => {
    const peer = bridge(() => Promise.resolve(reply(200, "{}")));
    transport = createPeerTransport(peer.api);
    const states: Array<{ connected: boolean; message?: string; reconnecting?: boolean }> = [];
    transport.onConnectionState((state) => states.push(state));

    peer.emitState({ state: "open" });
    peer.emitState({ state: "closed", code: 1008, reason: "not-paired" });

    const gaveUp = states.filter((state) => state.connected === false && state.reconnecting === false);
    expect(gaveUp.length).toBeGreaterThan(0);
    for (const state of gaveUp) expect(state.message).not.toMatch(WEB_ONLY);
    expect(gaveUp.at(-1)?.message).toBe("The session on the other computer ended.");
  });

  it("stops reconnecting once the host closed the link as not paired", async () => {
    vi.useFakeTimers();
    const peer = bridge(() => Promise.resolve(reply(200, "{}")));
    const wsOpen = vi.spyOn(peer.api, "wsOpen");
    transport = createPeerTransport(peer.api);
    const opensAtStart = wsOpen.mock.calls.length;

    peer.emitState({ state: "closed", code: 1008, reason: "not-paired" });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(wsOpen.mock.calls.length).toBe(opensAtStart);
  });

  it("suspendConnection ends the retries of a link that is down", async () => {
    vi.useFakeTimers();
    const peer = bridge(() => Promise.resolve(reply(200, "{}")));
    const wsOpen = vi.spyOn(peer.api, "wsOpen");
    transport = createPeerTransport(peer.api);
    peer.emitState({ state: "closed", code: 1006, reason: "ECONNREFUSED" });
    await vi.advanceTimersByTimeAsync(1_000);
    const opens = wsOpen.mock.calls.length;
    expect(opens).toBeGreaterThan(1);

    transport.suspendConnection?.();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(wsOpen.mock.calls.length).toBe(opens);
  });
});

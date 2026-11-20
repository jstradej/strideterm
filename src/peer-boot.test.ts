import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPeerBridge, createTransport, type PeerBridge } from "./transport.js";
import { resolveWindowBackend } from "./boot-backend.js";
import type { WindowBackend } from "../electron/shared/peers.js";

const logRenderer = vi.fn();

const peerBackend: Extract<WindowBackend, { kind: "peer" }> = {
  kind: "peer",
  hostId: "host-0001",
  hostLabel: "Studio Mac",
  remoteProfileId: "work",
  clientId: "peer-window-0001",
  terminalFontSize: 15,
};

function setPreload(preload: Record<string, unknown> | undefined): void {
  (window as unknown as Record<string, unknown>).strideterm = preload;
}

function makePreload() {
  const stateHandlers = new Set<(state: unknown) => void>();
  const messageHandlers = new Set<(data: string) => void>();
  const preload = {
    logRenderer,
    peerHttp: vi.fn(async () => ({ status: 200, headers: {}, body: JSON.stringify({ coreRevision: 1 }) })),
    peerWsOpen: vi.fn(),
    peerWsSend: vi.fn(),
    peerWsClose: vi.fn(),
    onPeerWsState: vi.fn((handler: (state: unknown) => void) => {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    }),
    onPeerWsMessage: vi.fn((handler: (data: string) => void) => {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    }),
  };
  return preload;
}

describe("peer window boot", () => {
  beforeEach(() => {
    logRenderer.mockClear();
  });
  afterEach(() => {
    setPreload(undefined);
    vi.restoreAllMocks();
  });

  describe("createTransport", () => {
    it("builds the peer transport from a peer backend: remote with a native shell, talking through the preload", async () => {
      const preload = makePreload();
      setPreload(preload);

      const transport = createTransport(peerBackend);

      expect(transport.isRemote).toBe(true);
      expect(transport.hasNativeShell).toBe(true);
      await expect(transport.getState()).resolves.toEqual({ coreRevision: 1 });
      expect(preload.peerHttp).toHaveBeenCalledOnce();
      const request = (preload.peerHttp.mock.calls[0] as unknown[])[0] as { pathname: string; headers: object };
      expect(request.pathname).toBe("/api/state");
      expect(request.headers).toMatchObject({ "X-Strideterm-Client-Id": peerBackend.clientId });
      expect(preload.peerWsOpen).toHaveBeenCalled();
    });

    it("keeps the Electron transport for a local backend", () => {
      setPreload({ logRenderer });
      const transport = createTransport({ kind: "local" });
      expect(transport.isRemote).toBe(false);
      expect(transport.hasNativeShell).toBe(true);
    });

    it("keeps the Electron transport when called without a backend", () => {
      setPreload({ logRenderer });
      expect(createTransport().isRemote).toBe(false);
    });

    it("refuses a peer backend where there is no preload", () => {
      expect(() => createTransport(peerBackend)).toThrow(/desktop app/);
    });
  });

  describe("createPeerBridge", () => {
    it("satisfies PeerBridge and forwards every call to the matching preload method", () => {
      const preload = makePreload();
      const bridge: PeerBridge = createPeerBridge(peerBackend, preload as never);

      expect(bridge.clientId).toBe(peerBackend.clientId);
      const request = { method: "GET", pathname: "/api/state", headers: {} };
      void bridge.http(request);
      bridge.wsOpen({ sp: "2" });
      bridge.wsSend("x");
      bridge.wsClose(1000, "bye");
      const offState = bridge.onWsState(() => {});
      const offMessage = bridge.onWsMessage(() => {});

      expect(preload.peerHttp).toHaveBeenCalledWith(request);
      expect(preload.peerWsOpen).toHaveBeenCalledWith({ sp: "2" });
      expect(preload.peerWsSend).toHaveBeenCalledWith("x");
      expect(preload.peerWsClose).toHaveBeenCalledWith(1000, "bye");
      expect(typeof offState).toBe("function");
      expect(typeof offMessage).toBe("function");
    });
  });

  describe("resolveWindowBackend", () => {
    it("is local when the preload has no getWindowBackend (web client, older preload)", async () => {
      setPreload({ logRenderer });
      await expect(resolveWindowBackend()).resolves.toEqual({ kind: "local" });
      setPreload(undefined);
      await expect(resolveWindowBackend()).resolves.toEqual({ kind: "local" });
    });

    it("is local, and logs, when getWindowBackend rejects", async () => {
      setPreload({ logRenderer, getWindowBackend: vi.fn().mockRejectedValue(new Error("ipc gone")) });

      await expect(resolveWindowBackend()).resolves.toEqual({ kind: "local" });

      expect(logRenderer).toHaveBeenCalledWith("warn", expect.stringContaining("window backend"), {
        error: "ipc gone",
      });
    });

    it("is local, and logs, when the answer is not a backend", async () => {
      setPreload({ logRenderer, getWindowBackend: vi.fn().mockResolvedValue({ kind: "peer", hostId: 4 }) });

      await expect(resolveWindowBackend()).resolves.toEqual({ kind: "local" });
      expect(logRenderer).toHaveBeenCalled();
    });

    it("hands a peer backend through", async () => {
      setPreload({ logRenderer, getWindowBackend: vi.fn().mockResolvedValue(peerBackend) });
      await expect(resolveWindowBackend()).resolves.toEqual(peerBackend);
    });

    it("answers local for a local backend", async () => {
      setPreload({ logRenderer, getWindowBackend: vi.fn().mockResolvedValue({ kind: "local" }) });
      await expect(resolveWindowBackend()).resolves.toEqual({ kind: "local" });
    });
  });
});

import { describe, expect, test, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";

// vi.hoisted ensures the spy is created before the vi.mock factory runs.
const syncFontSizeMock = vi.hoisted(() => vi.fn());
const scheduleAllVisibleResizeMock = vi.hoisted(() => vi.fn());

const getSearchAddonMock = vi.hoisted(() => vi.fn());
const handleTerminalDataMock = vi.hoisted(() => vi.fn());
const handleTerminalReplayMock = vi.hoisted(() => vi.fn());
const handleTerminalExitMock = vi.hoisted(() => vi.fn());

vi.mock("../app/terminal-controller.js", () => ({
  createTerminalController: () => ({
    syncFontSize: syncFontSizeMock,
    syncTheme: vi.fn(),
    handleTerminalData: handleTerminalDataMock,
    handleTerminalReplay: handleTerminalReplayMock,
    handleTerminalExit: handleTerminalExitMock,
    attachTerminalPane: vi.fn(),
    focusActiveTerminal: vi.fn(),
    scheduleActiveResize: vi.fn(),
    scheduleAllVisibleResize: scheduleAllVisibleResizeMock,
    pruneTerminalViews: vi.fn(),
    exportTerminalTranscript: vi.fn(),
    clearTerminalViewport: vi.fn(),
    disconnectHiddenPaneObservers: vi.fn(),
    getSearchAddon: getSearchAddonMock,
  }),
}));

import { useTerminalStore } from "./terminal.js";
import { useAppStore } from "./app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

function makeApi(isRemote: boolean) {
  const connectionHandlers: Array<(payload: AnyRecord) => void> = [];
  const dataHandlers: Array<(payload: AnyRecord) => void> = [];
  const replayHandlers: Array<(payload: AnyRecord) => void> = [];
  const exitHandlers: Array<(payload: AnyRecord) => void> = [];
  return {
    isRemote,
    onTerminalData: vi.fn((handler: (payload: AnyRecord) => void) => {
      dataHandlers.push(handler);
    }),
    onTerminalReplay: vi.fn((handler: (payload: AnyRecord) => void) => {
      replayHandlers.push(handler);
    }),
    onTerminalExit: vi.fn((handler: (payload: AnyRecord) => void) => {
      exitHandlers.push(handler);
    }),
    onConnectionState: vi.fn((handler: (payload: AnyRecord) => void) => {
      connectionHandlers.push(handler);
    }),
    emitConnectionState: (payload: AnyRecord) => {
      for (const handler of connectionHandlers) handler(payload);
    },
    emitTerminalData: (payload: AnyRecord) => {
      for (const handler of dataHandlers) handler(payload);
    },
    emitTerminalReplay: (payload: AnyRecord) => {
      for (const handler of replayHandlers) handler(payload);
    },
    emitTerminalExit: (payload: AnyRecord) => {
      for (const handler of exitHandlers) handler(payload);
    },
  };
}

function initStore(isRemote: boolean) {
  const termStore = useTerminalStore();
  termStore.init(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makeApi(isRemote) as any,
    {},
    {
      getActiveSessionId: () => null,
      getOverlay: () => null,
      getPayload: () => null,
    },
  );
  return termStore;
}

describe("useTerminalStore — font size watch", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyRecord).strideterm = { startupFlags: { windowId: "" } };
    syncFontSizeMock.mockClear();
    scheduleAllVisibleResizeMock.mockClear();
    vi.useRealTimers();
  });

  test("desktop: calls syncFontSize when terminalFontSizeLocal changes", async () => {
    initStore(false);
    const appStore = useAppStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appStore.payload = { appState: { settings: { terminalFontSizeLocal: 18 } } } as any;
    await nextTick();
    expect(syncFontSizeMock).toHaveBeenCalledWith(18);
  });

  test("desktop: does not call syncFontSize when only terminalFontSizeRemote changes", async () => {
    initStore(false);
    const appStore = useAppStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appStore.payload = { appState: { settings: { terminalFontSizeRemote: 22 } } } as any;
    await nextTick();
    expect(syncFontSizeMock).not.toHaveBeenCalled();
  });

  test("remote: calls syncFontSize when terminalFontSizeRemote changes", async () => {
    initStore(true);
    const appStore = useAppStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appStore.payload = { appState: { settings: { terminalFontSizeRemote: 20 } } } as any;
    await nextTick();
    expect(syncFontSizeMock).toHaveBeenCalledWith(20);
  });

  test("remote: does not call syncFontSize when only terminalFontSizeLocal changes", async () => {
    initStore(true);
    const appStore = useAppStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appStore.payload = { appState: { settings: { terminalFontSizeLocal: 16 } } } as any;
    await nextTick();
    expect(syncFontSizeMock).not.toHaveBeenCalled();
  });

  test("remote: forces visible terminal resize after websocket reconnect", () => {
    vi.useFakeTimers();
    const termStore = useTerminalStore();
    const api = makeApi(true);
    termStore.init(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api as any,
      {},
      {
        getActiveSessionId: () => null,
        getOverlay: () => null,
        getPayload: () => null,
      },
    );

    api.emitConnectionState({ connected: true, reconnected: true });

    expect(scheduleAllVisibleResizeMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(150);
    expect(scheduleAllVisibleResizeMock).toHaveBeenCalledTimes(2);
  });
});

// Production wiring guard: the app boots through main.ts → terminalStore.init.
// These tests pin the replay/seq/intentional pass-through to the wiring that
// actually runs — the review's most severe finding was replay handling living
// only in an uncalled module (app/runtime-bindings.ts, since deleted).
describe("useTerminalStore — terminal event wiring (production path)", () => {
  beforeEach(() => {
    vi.useRealTimers();
    setActivePinia(createPinia());
    (window as AnyRecord).strideterm = { startupFlags: { windowId: "" } };
    handleTerminalDataMock.mockClear();
    handleTerminalReplayMock.mockClear();
    handleTerminalExitMock.mockClear();
  });

  function initWithApi(isRemote: boolean) {
    const termStore = useTerminalStore();
    const api = makeApi(isRemote);
    termStore.init(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api as any,
      {},
      { getActiveSessionId: () => null, getOverlay: () => null, getPayload: () => null },
    );
    return api;
  }

  test("init registers onTerminalReplay and forwards sessionId/data/throughSeq", () => {
    const api = initWithApi(true);
    expect(api.onTerminalReplay).toHaveBeenCalledTimes(1);
    api.emitTerminalReplay({ sessionId: "ws1:a", data: "REPLAY", throughSeq: 7 });
    expect(handleTerminalReplayMock).toHaveBeenCalledWith({ sessionId: "ws1:a", data: "REPLAY", throughSeq: 7 });
  });

  // `remoteClient` exactly as composePayload (electron/backend/remote-client-registry.ts) sends it:
  // there is no activeViewId, and activeSessionId is the server's record of the selection — "" after a
  // workspace switch, still the closed panel's id after that tab is closed. Panels are what the
  // transport checks the selection against before it reports a panel to the host.
  function serverPayload(activeSessionId: string, panelIds: string[]) {
    return {
      remoteClient: { id: "client-1", profileId: "p1", activeWorkspaceId: "ws1", activeSessionId, workspaceGrid: null },
      appState: { workspaces: [{ id: "ws1", profileId: "p1", panels: panelIds.map((id) => ({ id })) }] },
    };
  }

  function readyRequest(
    requestId: number,
    target: { profileId: string; workspaceId: string | null; panelId: string | null },
    respond: (ready: boolean, viewKind: string) => void,
    connectionGeneration = 1,
  ) {
    window.dispatchEvent(
      new CustomEvent("strideterm:remote-terminal-ready-request", {
        detail: { requestId, documentEpoch: 1, openAttempt: 1, connectionGeneration, target, respond },
      }),
    );
  }

  test("terminal readiness waits for the selected session replay callback and rejects stale generations", () => {
    const termStore = useTerminalStore();
    const api = makeApi(true);
    const payload = serverPayload("ws1:p1", ["p1"]);
    termStore.init(
      api as never,
      {},
      {
        getActiveSessionId: () => "ws1:p1",
        getOverlay: () => null,
        getPayload: () => payload as never,
      },
    );
    api.emitConnectionState({ connected: true, connectionGeneration: 5 });
    const respond = vi.fn();
    const request = (requestId: number, generation: number) =>
      window.dispatchEvent(
        new CustomEvent("strideterm:remote-terminal-ready-request", {
          detail: {
            requestId,
            documentEpoch: 2,
            openAttempt: 3,
            connectionGeneration: generation,
            target: { profileId: "p1", workspaceId: "ws1", panelId: "p1" },
            respond,
          },
        }),
      );

    request(21, 5);
    expect(respond).not.toHaveBeenCalled();
    api.emitTerminalReplay({ sessionId: "ws1:hidden", data: "WARM", throughSeq: 8, connectionGeneration: 5 });
    const warmReplay = handleTerminalReplayMock.mock.calls.at(-1)?.[0] as { onParsed?: () => void };
    warmReplay.onParsed?.();
    expect(respond).not.toHaveBeenCalled();
    api.emitTerminalReplay({ sessionId: "ws1:p1", data: "REPLAY", throughSeq: 9, connectionGeneration: 5 });
    const replay = handleTerminalReplayMock.mock.calls.at(-1)?.[0] as { onParsed?: () => void };
    expect(replay.onParsed).toBeTypeOf("function");
    replay.onParsed?.();
    expect(respond).toHaveBeenCalledWith(true, "terminal");

    respond.mockClear();
    window.dispatchEvent(new CustomEvent("strideterm:terminal-view-disposed", { detail: { sessionId: "ws1:p1" } }));
    request(22, 5);
    expect(respond).not.toHaveBeenCalled();
    api.emitTerminalReplay({ sessionId: "ws1:p1", data: "REPAINT", throughSeq: 10, connectionGeneration: 5 });
    const repaintReplay = handleTerminalReplayMock.mock.calls.at(-1)?.[0] as { onParsed?: () => void };
    repaintReplay.onParsed?.();
    expect(respond).toHaveBeenCalledWith(true, "terminal");

    respond.mockClear();
    api.emitConnectionState({ connected: false, connectionGeneration: 6 });
    api.emitConnectionState({ connected: true, connectionGeneration: 6 });
    request(23, 6);
    api.emitTerminalReplay({ sessionId: "ws1:p1", data: "OLD", throughSeq: 9, connectionGeneration: 5 });
    const staleReplay = handleTerminalReplayMock.mock.calls.at(-1)?.[0] as { onParsed?: () => void };
    staleReplay.onParsed?.();
    expect(respond).not.toHaveBeenCalled();
  });

  test("terminal readiness reports a selected nonterminal panel after the renderer tick", async () => {
    const termStore = useTerminalStore();
    const api = makeApi(true);
    // The server session still remembers the prior terminal while the selected
    // view is a file tab, so that terminal is the target the host names;
    // appStore's activeSessionId is null for this nonterminal view
    // (getActiveSessionId below models that contract).
    const payload = serverPayload("ws1:shell", ["shell", "files"]);
    termStore.init(
      api as never,
      {},
      { getActiveSessionId: () => null, getOverlay: () => null, getPayload: () => payload as never },
    );
    api.emitConnectionState({ connected: true, connectionGeneration: 4 });
    const respond = vi.fn();
    window.dispatchEvent(
      new CustomEvent("strideterm:remote-terminal-ready-request", {
        detail: {
          requestId: 30,
          documentEpoch: 2,
          openAttempt: 4,
          connectionGeneration: 4,
          target: { profileId: "p1", workspaceId: "ws1", panelId: "shell" },
          respond,
        },
      }),
    );
    await nextTick();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(respond).toHaveBeenCalledWith(true, "nonterminal");
  });

  // Regression: the host's target comes from the transport (server selection, panel must exist), and
  // the store used to resolve its own from the renderer's local view — so these answered "not ready"
  // for ever, and the phone sat on "connecting" until its 25 s deadline rebuilt the session.
  test("terminal readiness after a workspace switch, when the server has no session selected", () => {
    const api = makeApi(true);
    useTerminalStore().init(
      api as never,
      {},
      {
        // The renderer restored the workspace's own terminal locally (applyWorkspaceUIStateFromEntry).
        getActiveSessionId: () => "ws1:p1",
        getOverlay: () => null,
        getPayload: () => serverPayload("", ["p1", "p2"]) as never,
      },
    );
    api.emitConnectionState({ connected: true, connectionGeneration: 1 });
    const respond = vi.fn();
    readyRequest(41, { profileId: "p1", workspaceId: "ws1", panelId: null }, respond);
    expect(respond).not.toHaveBeenCalled();
    api.emitTerminalReplay({ sessionId: "ws1:p1", data: "REPLAY", throughSeq: 3, connectionGeneration: 1 });
    (handleTerminalReplayMock.mock.calls.at(-1)?.[0] as { onParsed?: () => void }).onParsed?.();
    expect(respond).toHaveBeenCalledWith(true, "terminal");

    // A target the server does not hold is refused, even though it is the panel on screen.
    const local = vi.fn();
    readyRequest(42, { profileId: "p1", workspaceId: "ws1", panelId: "p1" }, local);
    expect(local).toHaveBeenCalledWith(false, "empty-state");
  });

  test("terminal readiness after the active tab closed, when the server still names the closed panel", () => {
    const api = makeApi(true);
    useTerminalStore().init(
      api as never,
      {},
      {
        // closeTab moved the renderer to the next terminal locally; the server was never told.
        getActiveSessionId: () => "ws1:p2",
        getOverlay: () => null,
        getPayload: () => serverPayload("ws1:closed", ["p1", "p2"]) as never,
      },
    );
    api.emitConnectionState({ connected: true, connectionGeneration: 1 });
    api.emitTerminalReplay({ sessionId: "ws1:p2", data: "REPLAY", throughSeq: 3, connectionGeneration: 1 });
    (handleTerminalReplayMock.mock.calls.at(-1)?.[0] as { onParsed?: () => void }).onParsed?.();
    const respond = vi.fn();
    readyRequest(43, { profileId: "p1", workspaceId: "ws1", panelId: null }, respond);
    expect(respond).toHaveBeenCalledWith(true, "terminal");
  });

  test("init forwards seq on terminal data (dedup guard depends on it)", () => {
    const api = initWithApi(true);
    api.emitTerminalData({ sessionId: "ws1:a", data: "chunk", seq: 12 });
    expect(handleTerminalDataMock).toHaveBeenCalledWith({ sessionId: "ws1:a", data: "chunk", seq: 12 });
  });

  test("init forwards intentional on terminal exit", () => {
    const api = initWithApi(false);
    api.emitTerminalExit({ sessionId: "ws1:a", exitCode: 0, intentional: true });
    expect(handleTerminalExitMock).toHaveBeenCalledWith({ sessionId: "ws1:a", exitCode: 0, intentional: true });
  });

  test("init tolerates a transport without onTerminalReplay (Electron mock)", () => {
    const termStore = useTerminalStore();
    const api = makeApi(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (api as any).onTerminalReplay = undefined;
    expect(() =>
      termStore.init(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        api as any,
        {},
        { getActiveSessionId: () => null, getOverlay: () => null, getPayload: () => null },
      ),
    ).not.toThrow();
  });
});

describe("useTerminalStore — search", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyRecord).strideterm = { startupFlags: { windowId: "" } };
    getSearchAddonMock.mockReset();
  });

  test("requestSearch dispatches strideterm:terminal-search with sessionId", () => {
    const termStore = initStore(false);
    const captured: AnyRecord[] = [];
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent).detail;
      if (detail) captured.push(detail);
    };
    window.addEventListener("strideterm:terminal-search", listener);
    try {
      termStore.requestSearch("workspace-1:shell-7");
    } finally {
      window.removeEventListener("strideterm:terminal-search", listener);
    }
    expect(captured).toEqual([{ sessionId: "workspace-1:shell-7" }]);
  });

  test("getSearchAddon forwards to the controller", () => {
    const stub = { findNext: vi.fn() };
    getSearchAddonMock.mockReturnValue(stub);
    const termStore = initStore(false);
    expect(termStore.getSearchAddon("workspace-1:shell-1")).toBe(stub);
    expect(getSearchAddonMock).toHaveBeenCalledWith("workspace-1:shell-1");
  });
});

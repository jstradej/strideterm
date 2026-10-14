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

  test("terminal readiness waits for the selected session replay callback and rejects stale generations", () => {
    const termStore = useTerminalStore();
    const api = makeApi(true);
    const payload = {
      remoteClient: {
        profileId: "p1",
        activeWorkspaceId: "ws1",
        activeViewId: "ws1:p1",
        activeSessionId: "ws1:p1",
      },
    };
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
    const payload = {
      // The server session may still remember the prior terminal while the
      // selected view is a file tab; appStore's activeSessionId is null for
      // this nonterminal view (getActiveSessionId below models that contract).
      remoteClient: {
        profileId: "p1",
        activeWorkspaceId: "ws1",
        activeViewId: "ws1:files",
        activeSessionId: "ws1:shell",
      },
    };
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
          target: { profileId: "p1", workspaceId: "ws1", panelId: "files" },
          respond,
        },
      }),
    );
    await nextTick();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(respond).toHaveBeenCalledWith(true, "nonterminal");
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

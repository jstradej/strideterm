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

// Production wiring guard: the app boots through main.ts → terminalStore.init,
// NOT through app/runtime-bindings.ts (which has no callers). These tests pin
// the replay/seq/intentional pass-through to the wiring that actually runs —
// the review's most severe finding was replay handling living only in the
// uncalled module.
describe("useTerminalStore — terminal event wiring (production path)", () => {
  beforeEach(() => {
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

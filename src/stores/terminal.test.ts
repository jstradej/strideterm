import { describe, expect, test, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";

// vi.hoisted ensures the spy is created before the vi.mock factory runs.
const syncFontSizeMock = vi.hoisted(() => vi.fn());

vi.mock("../app/terminal-controller.js", () => ({
  createTerminalController: () => ({
    syncFontSize: syncFontSizeMock,
    syncTheme: vi.fn(),
    handleTerminalData: vi.fn(),
    handleTerminalExit: vi.fn(),
    attachTerminalPane: vi.fn(),
    focusActiveTerminal: vi.fn(),
    scheduleActiveResize: vi.fn(),
    scheduleAllVisibleResize: vi.fn(),
    pruneTerminalViews: vi.fn(),
    exportTerminalTranscript: vi.fn(),
    clearTerminalViewport: vi.fn(),
    disconnectHiddenPaneObservers: vi.fn(),
  }),
}));

import { useTerminalStore } from "./terminal.js";
import { useAppStore } from "./app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

function makeApi(isRemote: boolean) {
  return {
    isRemote,
    onTerminalData: vi.fn(),
    onTerminalExit: vi.fn(),
  };
}

function initStore(isRemote: boolean) {
  const termStore = useTerminalStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  termStore.init(
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
});

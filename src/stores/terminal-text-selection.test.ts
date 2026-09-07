/**
 * Store-level contract for opening the "Select text" panel.
 *
 * Every trigger — the long press inside the terminal, the TerminalPane control
 * and the MobileInputBar menu — goes through `requestTextSelection`, so the
 * profile check and the panel's identity are pinned here rather than once per
 * caller.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAppStore } from "./app.js";
import { useTerminalStore } from "./terminal.js";
import type { TerminalTextSnapshot } from "../app/terminal-text-snapshot.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const SESSION_ID = "ws-a:panel-shell";

const SNAPSHOT: TerminalTextSnapshot = {
  text: "hello",
  rowCount: 1,
  scrollbackRows: 0,
  startsMidLine: false,
  endsMidLine: false,
  truncated: false,
  alternateBuffer: false,
};

// The controller is the renderer's xterm layer; the store's job is what
// happens around it, so it is replaced wholesale.
const { controllerStub, controllerOptions } = vi.hoisted(() => ({
  controllerStub: {
    getTerminalTextSnapshot: vi.fn(),
    scheduleAllVisibleResize: vi.fn(),
    syncFontSize: vi.fn(),
    syncTheme: vi.fn(),
    handleTerminalData: vi.fn(),
    handleTerminalReplay: vi.fn(),
    handleTerminalExit: vi.fn(),
  },
  controllerOptions: { value: null as AnyApi },
}));
vi.mock("../app/terminal-controller.js", () => ({
  createTerminalController: (options: AnyApi) => {
    controllerOptions.value = options;
    return controllerStub;
  },
}));

function seedPayload(): void {
  useAppStore().payload = {
    appState: {
      activeWorkspaceId: "ws-a",
      profiles: [
        { id: "p1", name: "Work" },
        { id: "p2", name: "Other" },
      ],
      windowSlots: [{ id: "slot1", profileId: "p1" }],
      workspaces: [
        { id: "ws-a", name: "acme", profileId: "p1", panels: [{ id: "panel-shell", title: "Shell", command: "bash" }] },
        { id: "ws-b", name: "other", profileId: "p2", panels: [{ id: "panel-x", title: "X", command: "sh" }] },
      ],
      settings: {},
    },
  } as AnyApi;
}

function initStore(snapshot: TerminalTextSnapshot | null = SNAPSHOT) {
  const termStore = useTerminalStore();
  controllerStub.getTerminalTextSnapshot.mockReturnValue(snapshot as AnyApi);
  termStore.init(
    {
      isRemote: false,
      writeTerminal: vi.fn(),
      onTerminalData: vi.fn(),
      onTerminalExit: vi.fn(),
    } as AnyApi,
    {} as AnyApi,
    { getActiveSessionId: () => SESSION_ID, getOverlay: () => null, getPayload: () => useAppStore().payload },
  );
  return termStore;
}

describe("requestTextSelection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "slot1" } };
    controllerOptions.value = null;
    for (const fn of Object.values(controllerStub)) fn.mockReset();
    seedPayload();
  });

  it("opens the panel bound to the exact source session, with a resolved title", () => {
    const termStore = initStore();
    const app = useAppStore();

    expect(termStore.requestTextSelection(SESSION_ID)).toBe(true);

    expect(app.overlay).toBe("TerminalTextSelectionDialog");
    expect(app.overlayProps).toMatchObject({
      sessionId: SESSION_ID,
      workspaceId: "ws-a",
      panelId: "panel-shell",
      title: "acme — Shell",
    });
  });

  it("closes itself through the props callback the overlay already understands", () => {
    const termStore = initStore();
    const app = useAppStore();
    termStore.requestTextSelection(SESSION_ID);

    (app.overlayProps as AnyApi).onClose();

    expect(app.overlay).toBeNull();
  });

  it("refuses a session whose workspace is outside the viewer's profile", () => {
    const termStore = initStore();
    const app = useAppStore();

    expect(termStore.requestTextSelection("ws-b:panel-x")).toBe(false);
    expect(app.overlay).toBeNull();
  });

  it("refuses a session with no live terminal view", () => {
    const termStore = initStore(null);
    const app = useAppStore();

    expect(termStore.requestTextSelection(SESSION_ID)).toBe(false);
    expect(app.overlay).toBeNull();
  });

  it("refuses an empty session id without touching the buffer", () => {
    const termStore = initStore();

    expect(termStore.requestTextSelection("")).toBe(false);
    expect(controllerStub.getTerminalTextSnapshot).not.toHaveBeenCalled();
  });

  it("never falls back to another session when the requested one is unusable", () => {
    const termStore = initStore();
    const app = useAppStore();

    expect(termStore.requestTextSelection("ws-gone:panel-shell")).toBe(false);
    expect(app.overlay).toBeNull();
  });

  it("is the same path the terminal long press takes", () => {
    initStore();
    const app = useAppStore();

    // The controller only knows a callback; the store is what turns it into a
    // dialog, so a gesture and a button cannot drift apart.
    controllerOptions.value.onTextSelectionRequested(SESSION_ID);

    expect(app.overlay).toBe("TerminalTextSelectionDialog");
    expect(app.overlayProps).toMatchObject({ sessionId: SESSION_ID });
  });

  it("a long press in a terminal outside the viewer's profile opens nothing", () => {
    initStore();
    const app = useAppStore();

    controllerOptions.value.onTextSelectionRequested("ws-b:panel-x");

    expect(app.overlay).toBeNull();
  });
});

import { describe, expect, test, vi, afterEach } from "vitest";
import { createTerminalController } from "./terminal-controller.js";

// Mock xterm so ensureTerminal() can run in jsdom without a real canvas.
// vi.fn() can't be used with `new`, so we use classes with instance-level spies.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon = vi.fn();
    registerLinkProvider = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    attachCustomWheelEventHandler = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => "");
    clearSelection = vi.fn();
    paste = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    scrollLines = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    buffer = { active: { type: "normal", viewportY: 0, baseY: 0, length: 0 } };
    options = { fontSize: 13, lineHeight: 1 };
    cols = 80;
    rows = 24;
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    dispose = vi.fn();
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    dispose = vi.fn();
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = vi.fn();
  },
}));

function buildController({ getOverlay }: { getOverlay: () => unknown }) {
  const focus = vi.fn();
  const sessionId = "workspace-1:panel-1";
  const views = {
    value: new Map([
      [
        sessionId,
        {
          term: { focus },
          mount: document.createElement("div"),
        },
      ],
    ]),
  };

  const controller = createTerminalController({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    views: views as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buffers: { value: new Map() } as any,
    getActiveSessionId: () => sessionId,
    getOverlay,
    getPayload: () => null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appConfig: {} as any,
    openTerminalLink: vi.fn(),
    getWindowsPtyOptions: vi.fn(),
    shortcutTabDirection: () => 0,
    downloadTextFile: vi.fn(),
    safeFilenamePart: (value: unknown) => String(value),
  });

  return { controller, focus };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createTerminalController", () => {
  test("does not steal focus if an overlay opens before delayed terminal focus runs", () => {
    let overlay: unknown = null;
    let queuedFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 1;
    });
    const { controller, focus } = buildController({ getOverlay: () => overlay });

    controller.focusActiveTerminal();
    overlay = "WorkspaceDialog";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (queuedFrame as any)?.(0);

    expect(focus).not.toHaveBeenCalled();
  });
});

function buildTouchController() {
  const views = { value: new Map() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controller = createTerminalController({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    views: views as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buffers: { value: new Map() } as any,
    getActiveSessionId: () => null,
    getOverlay: () => null,
    getPayload: () => null,
    // isRemote: true skips WebGL, link provider, and openTerminalPath registration.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: { writeTerminal: vi.fn(), isRemote: true } as any,
    appConfig: {},
    openTerminalLink: vi.fn(),
    getWindowsPtyOptions: vi.fn(() => null),
    shortcutTabDirection: () => 0,
    downloadTextFile: vi.fn(),
    safeFilenamePart: (value: string) => value,
  });
  return { controller, views };
}

describe("touch tap-to-focus", () => {
  test("tap (movement < 10 px) calls term.focus() to restore mobile keyboard", () => {
    const { controller, views } = buildTouchController();
    const sessionId = "touch-tap:panel-1";
    controller.ensureTerminal(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId)!;
    const { mount, term } = view;

    mount.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [{ identifier: 1, target: mount, clientX: 100, clientY: 200 }],
        changedTouches: [{ identifier: 1, target: mount, clientX: 100, clientY: 200 }],
      }),
    );
    mount.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        touches: [],
        changedTouches: [{ identifier: 1, target: mount, clientX: 104, clientY: 203 }],
      }),
    );

    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  test("scroll (movement >= 10 px) does NOT call term.focus()", () => {
    const { controller, views } = buildTouchController();
    const sessionId = "touch-scroll:panel-1";
    controller.ensureTerminal(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId)!;
    const { mount, term } = view;

    mount.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [{ identifier: 1, target: mount, clientX: 100, clientY: 200 }],
        changedTouches: [{ identifier: 1, target: mount, clientX: 100, clientY: 200 }],
      }),
    );
    mount.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        touches: [],
        changedTouches: [{ identifier: 1, target: mount, clientX: 100, clientY: 260 }],
      }),
    );

    expect(term.focus).not.toHaveBeenCalled();
  });
});

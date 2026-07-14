import { describe, expect, test, vi, afterEach, beforeAll } from "vitest";
import { createTerminalController } from "./terminal-controller.js";

// jsdom doesn't implement ResizeObserver — stub it so attachTerminalPane tests pass.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = class ResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
  }
});

// Mock xterm so ensureTerminal() can run in jsdom without a real canvas.
// vi.fn() can't be used with `new`, so we use classes with instance-level spies.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon = vi.fn();
    registerLinkProvider = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    attachCustomWheelEventHandler = vi.fn();
    parser = { registerOscHandler: vi.fn() };
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => "");
    clearSelection = vi.fn();
    paste = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    write = vi.fn();
    writeln = vi.fn();
    reset = vi.fn();
    refresh = vi.fn();
    clearTextureAtlas = vi.fn();
    scrollLines = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = vi.fn();
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
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext = vi.fn(() => true);
    findPrevious = vi.fn(() => true);
    clearDecorations = vi.fn();
    onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }));
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appConfig: {} as any,
    openTerminalLink: vi.fn(),
    getWindowsPtyOptions: vi.fn(() => null),
    shortcutTabDirection: () => 0,
    downloadTextFile: vi.fn(),
    safeFilenamePart: (value: unknown) => String(value),
  });
  return { controller, views };
}

function touchPoint(target: EventTarget, clientX: number, clientY: number): Touch {
  return {
    identifier: 1,
    target,
    clientX,
    clientY,
    pageX: clientX,
    pageY: clientY,
    screenX: clientX,
    screenY: clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 0,
  } as Touch;
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
        touches: [touchPoint(mount, 100, 200)],
        changedTouches: [touchPoint(mount, 100, 200)],
      }),
    );
    mount.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        touches: [],
        changedTouches: [touchPoint(mount, 104, 203)],
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
        touches: [touchPoint(mount, 100, 200)],
        changedTouches: [touchPoint(mount, 100, 200)],
      }),
    );
    mount.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        touches: [],
        changedTouches: [touchPoint(mount, 100, 260)],
      }),
    );

    expect(term.focus).not.toHaveBeenCalled();
  });
});

function buildAttachController(
  apiOverrides: Record<string, unknown> = {},
  appConfigOverride: Record<string, unknown> = {},
) {
  const views = { value: new Map() };
  const buffers = { value: new Map() };
  const api = {
    resizeTerminal: vi.fn(),
    writeTerminal: vi.fn(),
    isRemote: true,
    ...apiOverrides,
  };
  const controller = createTerminalController({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    views: views as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buffers: buffers as any,
    getActiveSessionId: () => null,
    getOverlay: () => null,
    getPayload: () => null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: api as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appConfig: appConfigOverride as any,
    openTerminalLink: vi.fn(),
    getWindowsPtyOptions: vi.fn(() => null),
    shortcutTabDirection: () => 0,
    downloadTextFile: vi.fn(),
    safeFilenamePart: (value: unknown) => String(value),
  });
  return { controller, views, buffers, api };
}

function installFakeResizeObserver() {
  const instances: Array<{
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    trigger: (_width: number, _height: number) => void;
  }> = [];
  class FakeResizeObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(private readonly _callback: ResizeObserverCallback) {
      instances.push({
        observe: this.observe,
        disconnect: this.disconnect,
        trigger: (width: number, height: number) => {
          this._callback(
            [{ contentRect: { width, height } as DOMRectReadOnly } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        },
      });
    }
  }
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  return {
    instances,
    restore() {
      if (previous) {
        globalThis.ResizeObserver = previous;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any).ResizeObserver;
      }
    },
  };
}

describe("terminal pane reattach", () => {
  test("removes the previous terminal host when the pane rebinds to another session", () => {
    const resizeObserver = installFakeResizeObserver();
    try {
      const { controller, views } = buildAttachController();
      const paneBody = document.createElement("div");
      document.body.append(paneBody);

      controller.attachTerminalPane("workspace-1:shell-1", paneBody);
      const firstObserver = resizeObserver.instances.at(-1)!;
      controller.attachTerminalPane("workspace-1:shell-2", paneBody);

      const hosts = paneBody.querySelectorAll(".terminal-host");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const firstView = (views.value as any).get("workspace-1:shell-1")!;
      expect(hosts).toHaveLength(1);
      expect((hosts[0] as HTMLElement).dataset.sessionId).toBe("workspace-1:shell-2");
      expect(firstView.mount.isConnected).toBe(false);
      expect(firstObserver.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      resizeObserver.restore();
    }
  });

  test("detaches a terminal host without disposing the terminal view", () => {
    const resizeObserver = installFakeResizeObserver();
    try {
      const { controller, views } = buildAttachController();
      const sessionId = "workspace-1:shell-1";
      const paneBody = document.createElement("div");
      document.body.append(paneBody);

      controller.attachTerminalPane(sessionId, paneBody);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (views.value as any).get(sessionId)!;
      const observer = resizeObserver.instances.at(-1)!;

      controller.detachTerminalPane(sessionId, paneBody);

      expect(view.mount.isConnected).toBe(false);
      expect(observer.disconnect).toHaveBeenCalledTimes(1);
      expect(view.resizeObserver).toBeNull();
      expect(view.term.dispose).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((views.value as any).has(sessionId)).toBe(true);
    } finally {
      resizeObserver.restore();
    }
  });

  test("Electron: loads backend replay on first attach when no live terminal data was received", async () => {
    const resizeObserver = installFakeResizeObserver();
    try {
      const getTerminalReplay = vi.fn().mockResolvedValue({ data: "boot prompt\r\n" });
      const { controller, views } = buildAttachController({ getTerminalReplay, isRemote: false });
      const sessionId = "workspace-1:shell-1";
      const paneBody = document.createElement("div");
      document.body.append(paneBody);

      controller.attachTerminalPane(sessionId, paneBody);
      await Promise.resolve();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (views.value as any).get(sessionId)!;
      expect(getTerminalReplay).toHaveBeenCalledWith(sessionId);
      expect(view.term.write).toHaveBeenCalledWith("boot prompt\r\n");
    } finally {
      resizeObserver.restore();
    }
  });

  test("Electron: skips backend replay if live terminal data arrives before replay resolves", async () => {
    const resizeObserver = installFakeResizeObserver();
    try {
      let resolveReplay: (value: { data: string }) => void = () => {};
      const getTerminalReplay = vi.fn(
        () =>
          new Promise<{ data: string }>((resolve) => {
            resolveReplay = resolve;
          }),
      );
      const { controller, views } = buildAttachController({ getTerminalReplay, isRemote: false });
      const sessionId = "workspace-1:shell-1";
      const paneBody = document.createElement("div");
      document.body.append(paneBody);

      controller.attachTerminalPane(sessionId, paneBody);
      controller.handleTerminalData({ sessionId, data: "live\r\n" });
      resolveReplay({ data: "replay\r\n" });
      await Promise.resolve();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (views.value as any).get(sessionId)!;
      expect(view.term.write).toHaveBeenCalledTimes(1);
      expect(view.term.write).toHaveBeenCalledWith("live\r\n");
    } finally {
      resizeObserver.restore();
    }
  });

  test("remote: does NOT pull HTTP replay on attach (the server pushes terminal:replay instead)", async () => {
    const resizeObserver = installFakeResizeObserver();
    try {
      const getTerminalReplay = vi.fn().mockResolvedValue({ data: "should-not-be-used" });
      const { controller } = buildAttachController({ getTerminalReplay, isRemote: true });
      const paneBody = document.createElement("div");
      document.body.append(paneBody);

      controller.attachTerminalPane("workspace-1:shell-1", paneBody);
      await Promise.resolve();

      expect(getTerminalReplay).not.toHaveBeenCalled();
    } finally {
      resizeObserver.restore();
    }
  });

  test("remote: handleTerminalReplay resets an open terminal and writes replay before live frames", async () => {
    const resizeObserver = installFakeResizeObserver();
    try {
      const { controller, views } = buildAttachController({ isRemote: true });
      const sessionId = "workspace-1:shell-1";
      const paneBody = document.createElement("div");
      document.body.append(paneBody);
      controller.attachTerminalPane(sessionId, paneBody);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (views.value as any).get(sessionId)!;

      controller.handleTerminalReplay({ sessionId, data: "REPLAY", throughSeq: 5 });
      expect(view.term.reset).toHaveBeenCalledTimes(1);
      expect(view.term.write).toHaveBeenCalledWith("REPLAY");

      controller.handleTerminalData({ sessionId, data: "LIVE", seq: 6 });
      expect(view.term.write).toHaveBeenCalledWith("LIVE");
    } finally {
      resizeObserver.restore();
    }
  });

  test("remote: ignores a live frame with seq <= the replay throughSeq (defensive duplicate)", async () => {
    const resizeObserver = installFakeResizeObserver();
    try {
      const { controller, views } = buildAttachController({ isRemote: true });
      const sessionId = "workspace-1:shell-1";
      const paneBody = document.createElement("div");
      document.body.append(paneBody);
      controller.attachTerminalPane(sessionId, paneBody);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (views.value as any).get(sessionId)!;

      controller.handleTerminalReplay({ sessionId, data: "REPLAY", throughSeq: 5 });
      view.term.write.mockClear();

      controller.handleTerminalData({ sessionId, data: "dup", seq: 5 }); // <= throughSeq → dropped
      controller.handleTerminalData({ sessionId, data: "fresh", seq: 6 }); // > throughSeq → written
      expect(view.term.write).toHaveBeenCalledTimes(1);
      expect(view.term.write).toHaveBeenCalledWith("fresh");
    } finally {
      resizeObserver.restore();
    }
  });
});

// The mocked Terminal stores the registered custom key handler on the
// attachCustomKeyEventHandler vi.fn(). Pull it out so we can synthesize
// keyboard events without setting up a real xterm + DOM helper textarea.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getKeyHandler(view: any): (event: Partial<KeyboardEvent>) => boolean {
  const calls = view.term.attachCustomKeyEventHandler.mock.calls;
  if (calls.length === 0) throw new Error("attachCustomKeyEventHandler was never called");
  return calls[0][0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getOscHandler(view: any, ident: number): (data: string) => boolean | Promise<boolean> {
  const call = view.term.parser.registerOscHandler.mock.calls.find(
    ([registeredIdent]: [number]) => registeredIdent === ident,
  );
  if (!call) throw new Error(`OSC ${ident} handler was never registered`);
  return call[1];
}

describe("terminal clipboard interoperability", () => {
  test("writes UTF-8 OSC 52 clipboard payloads", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const previousClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    try {
      const { controller, views } = buildAttachController();
      const sessionId = "workspace-1:shell-1";
      controller.ensureTerminal(sessionId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (views.value as any).get(sessionId);
      const handler = getOscHandler(view, 52);
      const expected = "P\u0159\u00edli\u0161 \u017elu\u0165ou\u010dk\u00fd k\u016f\u0148";
      const bytes = new TextEncoder().encode(expected);
      const encoded = btoa(String.fromCharCode(...bytes));

      expect(handler(`c;${encoded}`)).toBe(true);
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledWith(expected);
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: previousClipboard, configurable: true });
    }
  });

  test("does not expose or overwrite the clipboard for OSC 52 queries and malformed payloads", () => {
    const writeText = vi.fn(() => Promise.resolve());
    const previousClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    try {
      const { controller, views } = buildAttachController();
      const sessionId = "workspace-1:shell-1";
      controller.ensureTerminal(sessionId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (views.value as any).get(sessionId);
      const handler = getOscHandler(view, 52);

      expect(handler("c;?")).toBe(true);
      expect(handler("c;not-valid-base64%%%")).toBe(true);
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: previousClipboard, configurable: true });
    }
  });

  test("right mousedown is not also delivered to a mouse-reporting terminal application", () => {
    const { controller, views } = buildAttachController();
    const sessionId = "workspace-1:shell-1";
    controller.ensureTerminal(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    const xtermScreen = document.createElement("div");
    const terminalMouseHandler = vi.fn();
    xtermScreen.addEventListener("mousedown", terminalMouseHandler);
    view.mount.appendChild(xtermScreen);

    xtermScreen.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true }));

    expect(terminalMouseHandler).not.toHaveBeenCalled();
  });
});

describe("search addon wiring", () => {
  test("ensureTerminal attaches a SearchAddon and getSearchAddon returns it", () => {
    const { controller, views } = buildAttachController();
    const sessionId = "workspace-1:shell-1";
    controller.ensureTerminal(sessionId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    expect(view.searchAddon).toBeDefined();
    expect(view.searchAddon.findNext).toBeTypeOf("function");
    expect(controller.getSearchAddon(sessionId)).toBe(view.searchAddon);
  });

  test("getSearchAddon returns null for an unknown session", () => {
    const { controller } = buildAttachController();
    expect(controller.getSearchAddon("does-not-exist")).toBeNull();
  });
});

describe("Ctrl/Cmd+F key handler", () => {
  test("Ctrl+F keydown fires onSearchRequested(sessionId) and swallows the event", () => {
    const onSearchRequested = vi.fn();
    const { controller, views } = buildAttachController({ onSearchRequested });
    const sessionId = "workspace-1:shell-1";
    controller.ensureTerminal(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    const handler = getKeyHandler(view);

    const result = handler({
      type: "keydown",
      key: "f",
      code: "KeyF",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    });

    expect(onSearchRequested).toHaveBeenCalledWith(sessionId);
    expect(result).toBe(false);
  });

  test("Ctrl+Shift+F does NOT fire onSearchRequested (preserves shell binding)", () => {
    const onSearchRequested = vi.fn();
    const { controller, views } = buildAttachController({ onSearchRequested });
    const sessionId = "workspace-1:shell-1";
    controller.ensureTerminal(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    const handler = getKeyHandler(view);

    handler({
      type: "keydown",
      key: "f",
      code: "KeyF",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    });

    expect(onSearchRequested).not.toHaveBeenCalled();
  });

  test("plain 'f' (no modifier) does NOT fire onSearchRequested", () => {
    const onSearchRequested = vi.fn();
    const { controller, views } = buildAttachController({ onSearchRequested });
    const sessionId = "workspace-1:shell-1";
    controller.ensureTerminal(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    const handler = getKeyHandler(view);

    handler({
      type: "keydown",
      key: "f",
      code: "KeyF",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    });

    expect(onSearchRequested).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Visual profile switch — terminal view retention
// ---------------------------------------------------------------------------

describe("visual profile switch — handleTerminalData and pruneTerminalViews", () => {
  test("detached (opened but DOM-removed) view still receives terminal:data via direct write", () => {
    const { controller, views } = buildAttachController();
    const sessionId = "ws-a:sh";
    controller.ensureTerminal(sessionId);

    const paneBody = document.createElement("div");
    document.body.appendChild(paneBody);
    controller.attachTerminalPane(sessionId, paneBody);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    const writeSpy = vi.spyOn(view.term, "write");

    // Detach — simulates profile switch removing DOM node; view.opened stays true.
    controller.detachTerminalPane(sessionId, paneBody);
    expect(view.opened).toBe(true); // sanity: opened flag unchanged after detach

    // Data arrives while hidden — must write directly to term (view.opened is true).
    controller.handleTerminalData({ sessionId, data: "background output" });

    expect(writeSpy).toHaveBeenCalledWith("background output");
  });

  test("unopened view buffers terminal:data and flushes it on attachTerminalPane", () => {
    const { controller, views, buffers } = buildAttachController();
    const sessionId = "ws-a:sh";
    controller.ensureTerminal(sessionId);

    // View exists but has not been opened yet — data must be buffered.
    controller.handleTerminalData({ sessionId, data: "queued data" });
    expect(buffers.value.get(sessionId)).toBe("queued data");

    // Open/attach — should flush the buffer.
    const paneBody = document.createElement("div");
    document.body.appendChild(paneBody);
    controller.attachTerminalPane(sessionId, paneBody);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    expect(view.term.write).toHaveBeenCalledWith("queued data");
    // Buffer cleared after flush.
    expect(buffers.value.get(sessionId)).toBeUndefined();
  });

  // Krok 4 — renderer buffer cap for unopened sessions.
  test("unopened buffer is trimmed from the left to session.replayMaxChars", () => {
    const cap = 100;
    const { controller, buffers } = buildAttachController({}, { session: { replayMaxChars: cap } });
    const sessionId = "ws-a:sh";
    controller.ensureTerminal(sessionId);

    // Push more than the cap across several chunks.
    for (let i = 0; i < 50; i++) controller.handleTerminalData({ sessionId, data: "0123456789" }); // 500 chars

    const buffered = buffers.value.get(sessionId)!;
    expect(buffered.length).toBe(cap);
    // Content is the most-recent suffix of the full stream.
    expect(buffered).toBe("0123456789".repeat(50).slice(-cap));
  });

  test("trimmed buffer flushes the trimmed content on attach, then clears", () => {
    const cap = 30;
    const { controller, views, buffers } = buildAttachController({}, { session: { replayMaxChars: cap } });
    const sessionId = "ws-a:sh";
    controller.ensureTerminal(sessionId);
    controller.handleTerminalData({ sessionId, data: "X".repeat(100) });
    expect(buffers.value.get(sessionId)!.length).toBe(cap);

    const paneBody = document.createElement("div");
    document.body.appendChild(paneBody);
    controller.attachTerminalPane(sessionId, paneBody);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    expect(view.term.write).toHaveBeenCalledWith("X".repeat(cap));
    expect(buffers.value.get(sessionId)).toBeUndefined();
  });

  test("buffer below the cap is byte-for-byte unchanged", () => {
    const { controller, buffers } = buildAttachController({}, { session: { replayMaxChars: 1000 } });
    const sessionId = "ws-a:sh";
    controller.ensureTerminal(sessionId);
    controller.handleTerminalData({ sessionId, data: "hello" });
    controller.handleTerminalData({ sessionId, data: " world" });
    expect(buffers.value.get(sessionId)).toBe("hello world");
  });

  test("pruneTerminalViews does NOT dispose views whose session is in the valid set", () => {
    const { controller, views } = buildAttachController();
    controller.ensureTerminal("ws-a:sh");
    controller.ensureTerminal("ws-b:sh");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewA = (views.value as any).get("ws-a:sh");
    const disposeSpy = vi.spyOn(viewA.term, "dispose");

    // Both sessions are valid (desktop all-profile retention).
    controller.pruneTerminalViews(new Set(["ws-a:sh", "ws-b:sh"]));

    expect(disposeSpy).not.toHaveBeenCalled();
  });

  test("pruneTerminalViews DOES dispose views whose session is NOT in the valid set", () => {
    const { controller, views } = buildAttachController();
    controller.ensureTerminal("ws-a:sh");
    controller.ensureTerminal("ws-b:sh");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewA = (views.value as any).get("ws-a:sh");
    const disposeSpy = vi.spyOn(viewA.term, "dispose");

    // Only ws-b:sh is valid — ws-a:sh (deleted workspace) must be pruned.
    controller.pruneTerminalViews(new Set(["ws-b:sh"]));

    expect(disposeSpy).toHaveBeenCalled();
  });
});

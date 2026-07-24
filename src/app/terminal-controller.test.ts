import { describe, expect, test, vi, afterEach, beforeAll } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { createTerminalController } from "./terminal-controller.js";

// Backing spy for the path-link providers' shared error-reporting helper
// (reportOpenPathError). Declared via vi.hoisted so it's safe to reference
// from the vi.mock factories below.
const { mockShowError, webglMockState } = vi.hoisted(() => ({
  mockShowError: vi.fn(),
  webglMockState: {
    failLoad: false,
    instances: [] as Array<{
      dispose: ReturnType<typeof vi.fn>;
      triggerContextLoss: () => void;
    }>,
  },
}));
vi.mock("../stores/notifications.js", () => ({
  useNotificationStore: () => ({ showError: mockShowError }),
}));
vi.mock("../stores/app.js", () => ({
  useAppStore: () => ({ activeProfile: { id: "test-profile" } }),
}));

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
    loadAddon = vi.fn((addon: { isWebglAddon?: boolean }) => {
      if (addon.isWebglAddon && webglMockState.failLoad) {
        throw new Error("WebGL2 unavailable");
      }
    });
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
    _renderHandler: ((e: { start: number; end: number }) => void) | null = null;
    onRender = vi.fn((handler: (e: { start: number; end: number }) => void) => {
      this._renderHandler = handler;
      return {
        dispose: vi.fn(() => {
          this._renderHandler = null;
        }),
      };
    });
    triggerRender = (start: number, end: number) => this._renderHandler?.({ start, end });
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
    isWebglAddon = true;
    private _contextLossHandler: (() => void) | null = null;
    onContextLoss = vi.fn((handler: () => void) => {
      this._contextLossHandler = handler;
      return { dispose: vi.fn() };
    });
    dispose = vi.fn();
    triggerContextLoss = () => this._contextLossHandler?.();
    constructor() {
      webglMockState.instances.push(this);
    }
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
  webglMockState.failLoad = false;
  webglMockState.instances.length = 0;
  document.body.innerHTML = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (document as any).fonts;
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

function installFontLoader(load: FontFaceSet["load"] = vi.fn(() => Promise.resolve([]))) {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load },
  });
  return load;
}

function installFakeAnimationFrames() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
    callbacks.delete(id);
  });
  return {
    flush() {
      while (callbacks.size) {
        const queued = [...callbacks.entries()];
        callbacks.clear();
        for (const [, callback] of queued) callback(performance.now());
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

describe("desktop WebGL renderer selection", () => {
  test("waits for the configured font and uses successful WebglAddon activation as the capability check", async () => {
    let resolveFont: (value: FontFace[]) => void = () => {};
    const fontPromise = new Promise<FontFace[]>((resolve) => {
      resolveFont = resolve;
    });
    const fontLoad = installFontLoader(vi.fn(() => fontPromise));
    const { controller, views } = buildAttachController({ isRemote: false });
    const sessionId = "workspace-1:shell-1";
    const paneBody = document.createElement("div");
    document.body.append(paneBody);

    controller.attachTerminalPane(sessionId, paneBody);
    expect(webglMockState.instances).toHaveLength(0);

    resolveFont([]);
    await flushPromises();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    expect(fontLoad).toHaveBeenCalledWith(expect.stringContaining('"JetBrainsMono NFM"'));
    expect(webglMockState.instances).toHaveLength(1);
    expect(view.term.loadAddon).toHaveBeenCalledWith(webglMockState.instances[0]);
    expect(view.webglAttached).toBe(true);
    expect(view.webglAddon).toBe(webglMockState.instances[0]);
  });

  test("does not attempt WebGL for remote clients or when explicitly disabled", async () => {
    installFontLoader();
    const remote = buildAttachController({ isRemote: true });
    const disabled = buildAttachController({
      isRemote: false,
      startupFlags: { disableWebgl: true },
    });
    const remotePane = document.createElement("div");
    const disabledPane = document.createElement("div");
    document.body.append(remotePane, disabledPane);

    remote.controller.attachTerminalPane("remote:shell", remotePane);
    disabled.controller.attachTerminalPane("disabled:shell", disabledPane);
    await flushPromises();

    expect(webglMockState.instances).toHaveLength(0);
  });

  test("does not activate WebGL until FitAddon reports positive pane dimensions", async () => {
    installFontLoader();
    const { controller, views } = buildAttachController({ isRemote: false });
    const sessionId = "workspace-1:shell-1";
    controller.ensureTerminal(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    view.fitAddon.proposeDimensions.mockReturnValue(undefined);
    const paneBody = document.createElement("div");
    document.body.append(paneBody);

    controller.attachTerminalPane(sessionId, paneBody);
    await flushPromises();

    expect(webglMockState.instances).toHaveLength(0);
    expect(view.webglAttachPending).toBe(false);
  });

  test("disposes a partially loaded addon and stays on DOM when activation throws", async () => {
    installFontLoader();
    webglMockState.failLoad = true;
    const logRenderer = vi.fn();
    const { controller, views } = buildAttachController({ isRemote: false, logRenderer });
    const sessionId = "workspace-1:shell-1";
    const paneBody = document.createElement("div");
    document.body.append(paneBody);

    controller.attachTerminalPane(sessionId, paneBody);
    await flushPromises();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    expect(webglMockState.instances).toHaveLength(1);
    expect(webglMockState.instances[0].dispose).toHaveBeenCalledTimes(1);
    expect(view.webglAttached).toBe(false);
    expect(view.webglAddon).toBeNull();
    expect(logRenderer).toHaveBeenCalledWith(
      "warn",
      "[webgl] unavailable; using DOM renderer",
      expect.objectContaining({ error: "WebGL2 unavailable" }),
    );
  });

  test("does not activate WebGL after the terminal view was pruned while its font was loading", async () => {
    let resolveFont: (value: FontFace[]) => void = () => {};
    installFontLoader(
      vi.fn(
        () =>
          new Promise<FontFace[]>((resolve) => {
            resolveFont = resolve;
          }),
      ),
    );
    const { controller } = buildAttachController({ isRemote: false });
    const paneBody = document.createElement("div");
    document.body.append(paneBody);

    controller.attachTerminalPane("workspace-1:shell-1", paneBody);
    controller.pruneTerminalViews(new Set());
    resolveFont([]);
    await flushPromises();

    expect(webglMockState.instances).toHaveLength(0);
  });

  test("falls back on context loss, retries once, and does not enter a retry loop", async () => {
    vi.useFakeTimers();
    installFontLoader();
    const { controller, views } = buildAttachController({ isRemote: false });
    const sessionId = "workspace-1:shell-1";
    const paneBody = document.createElement("div");
    document.body.append(paneBody);

    controller.attachTerminalPane(sessionId, paneBody);
    await flushPromises();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    const firstAddon = webglMockState.instances[0];

    firstAddon.triggerContextLoss();
    expect(firstAddon.dispose).toHaveBeenCalledTimes(1);
    expect(view.webglAttached).toBe(false);
    expect(view.webglAddon).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(webglMockState.instances).toHaveLength(2);
    expect(view.webglAttached).toBe(true);

    webglMockState.instances[1].triggerContextLoss();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(webglMockState.instances).toHaveLength(2);
    expect(view.webglAttached).toBe(false);
  });

  test("cancels a pending context-loss retry when the pane is detached", async () => {
    vi.useFakeTimers();
    installFontLoader();
    const { controller } = buildAttachController({ isRemote: false });
    const sessionId = "workspace-1:shell-1";
    const paneBody = document.createElement("div");
    document.body.append(paneBody);

    controller.attachTerminalPane(sessionId, paneBody);
    await flushPromises();
    webglMockState.instances[0].triggerContextLoss();
    controller.detachTerminalPane(sessionId, paneBody);

    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(webglMockState.instances).toHaveLength(1);
  });

  test("prunes the WebGL addon before disposing the terminal", async () => {
    installFontLoader();
    const { controller, views } = buildAttachController({ isRemote: false });
    const sessionId = "workspace-1:shell-1";
    const paneBody = document.createElement("div");
    document.body.append(paneBody);
    controller.attachTerminalPane(sessionId, paneBody);
    await flushPromises();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    const order: string[] = [];
    webglMockState.instances[0].dispose.mockImplementation(() => order.push("webgl"));
    view.term.dispose.mockImplementation(() => order.push("terminal"));

    controller.pruneTerminalViews(new Set());

    expect(order).toEqual(["webgl", "terminal"]);
  });
});

describe("terminal resize rendering", () => {
  test("does not full-refresh or send a PTY resize when fitted dimensions are unchanged", async () => {
    const resizeObserver = installFakeResizeObserver();
    const animationFrames = installFakeAnimationFrames();
    try {
      installFontLoader();
      const { controller, views, api } = buildAttachController();
      const sessionId = "workspace-1:shell-1";
      const paneBody = document.createElement("div");
      document.body.append(paneBody);
      controller.attachTerminalPane(sessionId, paneBody);
      await flushPromises();
      animationFrames.flush();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (views.value as any).get(sessionId);
      view.term.refresh.mockClear();
      api.resizeTerminal.mockClear();

      resizeObserver.instances.at(-1)!.trigger(800, 600);
      animationFrames.flush();

      expect(view.term.refresh).not.toHaveBeenCalled();
      expect(api.resizeTerminal).not.toHaveBeenCalled();
    } finally {
      resizeObserver.restore();
    }
  });

  test("relies on FitAddon repaint when dimensions change instead of forcing a second full refresh", async () => {
    const resizeObserver = installFakeResizeObserver();
    const animationFrames = installFakeAnimationFrames();
    try {
      installFontLoader();
      const { controller, views, api } = buildAttachController();
      const sessionId = "workspace-1:shell-1";
      const paneBody = document.createElement("div");
      document.body.append(paneBody);
      controller.attachTerminalPane(sessionId, paneBody);
      await flushPromises();
      animationFrames.flush();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (views.value as any).get(sessionId);
      view.term.refresh.mockClear();
      api.resizeTerminal.mockClear();
      view.fitAddon.fit.mockImplementationOnce(() => {
        view.term.cols = 100;
      });

      resizeObserver.instances.at(-1)!.trigger(1_000, 600);
      animationFrames.flush();

      expect(view.term.refresh).not.toHaveBeenCalled();
      expect(api.resizeTerminal).toHaveBeenCalledWith(sessionId, { cols: 100, rows: 24 });
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

  test("right-click paste logs (and does not throw) when clipboard.readText() rejects", async () => {
    // On the remote/web transport, navigator.clipboard.readText() is commonly
    // unavailable (insecure context / no permission) and rejects every time —
    // this must not surface as an unhandled promise rejection.
    const readText = vi.fn(() => Promise.reject(new Error("not allowed")));
    const previousClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      value: { readText },
      configurable: true,
    });
    try {
      const logRenderer = vi.fn();
      const { controller, views } = buildAttachController({ isRemote: true, logRenderer });
      const sessionId = "workspace-1:shell-1";
      controller.ensureTerminal(sessionId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (views.value as any).get(sessionId);

      expect(() => {
        view.mount.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      }).not.toThrow();

      // Flush the tryImagePasteToTerminal().then() chain and the
      // readText().then().catch() chain that follows it.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(readText).toHaveBeenCalled();
      expect(view.term.paste).not.toHaveBeenCalled();
      expect(logRenderer).toHaveBeenCalledWith(
        "warn",
        "[terminal-clipboard] right-click paste failed",
        expect.objectContaining({ error: "not allowed" }),
      );
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: previousClipboard, configurable: true });
    }
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

describe("path-link providers — shared error reporting (reportOpenPathError)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setLine(view: any, text: string) {
    view.term.buffer.active.getLine = () => ({ translateToString: () => text });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getProviders(view: any) {
    const calls = view.term.registerLinkProvider.mock.calls;
    // Registration order in ensureTerminal: file-path provider, then the
    // file:// URL provider.
    return { pathProvider: calls[0][0], fileUrlProvider: calls[1][0] };
  }

  test("path-link provider: a 'not ok' result routes through reportOpenPathError", async () => {
    mockShowError.mockClear();
    const openTerminalPath = vi.fn(async () => ({ ok: false, error: "boom" }));
    const { controller, views } = buildAttachController({ isRemote: false, openTerminalPath });
    const sessionId = "ws-a:sh";
    controller.ensureTerminal(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    setLine(view, "/usr/local/bin/mytool");
    const { pathProvider } = getProviders(view);

    const callback = vi.fn();
    pathProvider.provideLinks(1, callback);
    const links = callback.mock.calls[0][0];
    expect(links).toHaveLength(1);

    links[0].activate();
    await flushPromises();
    await flushPromises();

    expect(mockShowError).toHaveBeenCalledWith("Open path failed", "Couldn't open /usr/local/bin/mytool: boom", {
      profileId: "test-profile",
    });
  });

  test("path-link provider: a rejected openTerminalPath call routes through reportOpenPathError", async () => {
    mockShowError.mockClear();
    const openTerminalPath = vi.fn(async () => {
      throw new Error("network down");
    });
    const { controller, views } = buildAttachController({ isRemote: false, openTerminalPath });
    const sessionId = "ws-a:sh";
    controller.ensureTerminal(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    setLine(view, "/usr/local/bin/mytool");
    const { pathProvider } = getProviders(view);

    const callback = vi.fn();
    pathProvider.provideLinks(1, callback);
    const links = callback.mock.calls[0][0];

    links[0].activate();
    await flushPromises();
    await flushPromises();

    expect(mockShowError).toHaveBeenCalledWith(
      "Open path failed",
      "Couldn't open /usr/local/bin/mytool: network down",
      { profileId: "test-profile" },
    );
  });

  test("file:// URL provider: a 'not ok' result routes through reportOpenPathError", async () => {
    mockShowError.mockClear();
    const openTerminalPath = vi.fn(async () => ({ ok: false, error: "boom" }));
    const { controller, views } = buildAttachController({ isRemote: false, openTerminalPath });
    const sessionId = "ws-a:sh";
    controller.ensureTerminal(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    setLine(view, "see file:///usr/local/bin/mytool for details");
    const { fileUrlProvider } = getProviders(view);

    const callback = vi.fn();
    fileUrlProvider.provideLinks(1, callback);
    const links = callback.mock.calls[0][0];
    expect(links).toHaveLength(1);

    links[0].activate();
    await flushPromises();
    await flushPromises();

    expect(mockShowError).toHaveBeenCalledWith("Open path failed", "Couldn't open /usr/local/bin/mytool: boom", {
      profileId: "test-profile",
    });
  });

  test("file:// URL provider: a rejected openTerminalPath call routes through reportOpenPathError", async () => {
    mockShowError.mockClear();
    const openTerminalPath = vi.fn(async () => {
      throw new Error("network down");
    });
    const { controller, views } = buildAttachController({ isRemote: false, openTerminalPath });
    const sessionId = "ws-a:sh";
    controller.ensureTerminal(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    setLine(view, "see file:///usr/local/bin/mytool for details");
    const { fileUrlProvider } = getProviders(view);

    const callback = vi.fn();
    fileUrlProvider.provideLinks(1, callback);
    const links = callback.mock.calls[0][0];

    links[0].activate();
    await flushPromises();
    await flushPromises();

    expect(mockShowError).toHaveBeenCalledWith(
      "Open path failed",
      "Couldn't open /usr/local/bin/mytool: network down",
      { profileId: "test-profile" },
    );
  });

  test("all 4 sites route through exactly one shared implementation (identical title + options shape)", async () => {
    mockShowError.mockClear();
    const openTerminalPath = vi.fn(async () => ({ ok: false, error: "boom" }));
    const { controller, views } = buildAttachController({ isRemote: false, openTerminalPath });
    const sessionId = "ws-a:sh";
    controller.ensureTerminal(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    const { pathProvider, fileUrlProvider } = getProviders(view);

    setLine(view, "/usr/local/bin/mytool");
    const cb1 = vi.fn();
    pathProvider.provideLinks(1, cb1);
    cb1.mock.calls[0][0][0].activate();
    await flushPromises();

    setLine(view, "see file:///usr/local/bin/mytool for details");
    const cb2 = vi.fn();
    fileUrlProvider.provideLinks(1, cb2);
    cb2.mock.calls[0][0][0].activate();
    await flushPromises();

    expect(mockShowError).toHaveBeenCalledTimes(2);
    // Both providers' error paths produce the same title + { profileId }
    // shape — evidence they share the one reportOpenPathError implementation
    // rather than each formatting its own toast independently.
    for (const call of mockShowError.mock.calls) {
      expect(call[0]).toBe("Open path failed");
      expect(call[2]).toEqual({ profileId: "test-profile" });
    }
  });
});

describe("terminal performance diagnostics", () => {
  test("does not collect interval counters while diagnostics are disabled", () => {
    const { controller } = buildAttachController();
    const sessionId = "diag:shell-1";
    controller.handleTerminalData({ sessionId, data: "hello world" });
    const snap = controller.getDiagnosticsSnapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.intervalMs).toBeNull();
    expect(snap.dataChunks).toBe(0);
    expect(snap.dataBytes).toBe(0);
  });

  test("counts received data chunks and bytes, with per-session breakdown", () => {
    const { controller } = buildAttachController();
    controller.setDiagnosticsEnabled(true);
    controller.handleTerminalData({ sessionId: "diag:a", data: "abc" });
    controller.handleTerminalData({ sessionId: "diag:a", data: "de" });
    controller.handleTerminalData({ sessionId: "diag:b", data: "z" });
    const snap = controller.getDiagnosticsSnapshot();
    expect(snap.enabled).toBe(true);
    expect(snap.dataChunks).toBe(3);
    expect(snap.dataBytes).toBe(6);
    const a = snap.topSessions.find((s) => s.sessionId === "diag:a");
    expect(a).toMatchObject({ dataChunks: 2, dataBytes: 5 });
  });

  test("counts render events and rows exactly once (single onRender listener)", () => {
    const { controller, views } = buildAttachController();
    const sessionId = "diag:render";
    controller.ensureTerminal(sessionId);
    controller.setDiagnosticsEnabled(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const term = (views.value as any).get(sessionId)!.term;
    // A single onRender registration means one increment per render, not N.
    expect(term.onRender).toHaveBeenCalledTimes(1);
    term.triggerRender(0, 4); // 5 rows
    term.triggerRender(2, 2); // 1 row
    const snap = controller.getDiagnosticsSnapshot();
    expect(snap.renderEvents).toBe(2);
    expect(snap.renderedRows).toBe(6);
  });

  test("snapshot returns deltas then resets the interval", () => {
    const { controller } = buildAttachController();
    controller.setDiagnosticsEnabled(true);
    controller.handleTerminalData({ sessionId: "diag:a", data: "abcd" });
    const first = controller.getDiagnosticsSnapshot();
    expect(first.dataBytes).toBe(4);
    // Nothing new since the reset → the next snapshot starts clean.
    const second = controller.getDiagnosticsSnapshot();
    expect(second.dataChunks).toBe(0);
    expect(second.dataBytes).toBe(0);
  });

  test("disposing the terminal removes the diagnostic render listener", () => {
    const { controller, views } = buildAttachController();
    const sessionId = "diag:dispose";
    controller.ensureTerminal(sessionId);
    controller.setDiagnosticsEnabled(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const term = (views.value as any).get(sessionId)!.term;
    controller.pruneTerminalViews(new Set());
    // Handler was disposed → further renders on the (removed) term are ignored.
    term.triggerRender(0, 9);
    const snap = controller.getDiagnosticsSnapshot();
    expect(snap.renderEvents).toBe(0);
    expect(snap.liveViews).toBe(0);
  });

  test("distinguishes a resize callback without a size change from a real resize", async () => {
    const resizeObserver = installFakeResizeObserver();
    const animationFrames = installFakeAnimationFrames();
    try {
      installFontLoader();
      const { controller, views } = buildAttachController();
      const sessionId = "diag:resize";
      const paneBody = document.createElement("div");
      document.body.append(paneBody);
      controller.attachTerminalPane(sessionId, paneBody);
      await flushPromises();
      animationFrames.flush();
      controller.setDiagnosticsEnabled(true); // fresh baseline after attach

      // Same fitted size → callback fires but is not a real dimension change.
      resizeObserver.instances.at(-1)!.trigger(800, 600);
      animationFrames.flush();
      let snap = controller.getDiagnosticsSnapshot();
      expect(snap.resizeCallbacks).toBeGreaterThanOrEqual(1);
      expect(snap.resizeChanges).toBe(0);

      // Now the fitted dimensions actually change → counted as a real resize.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (views.value as any).get(sessionId)!.term.cols = 100;
      resizeObserver.instances.at(-1)!.trigger(1000, 600);
      animationFrames.flush();
      snap = controller.getDiagnosticsSnapshot();
      expect(snap.resizeChanges).toBe(1);
    } finally {
      resizeObserver.restore();
    }
  });

  test("increments WebGL attach-failure counter on the DOM fallback", async () => {
    installFontLoader();
    webglMockState.failLoad = true;
    const { controller } = buildAttachController({ isRemote: false });
    const sessionId = "diag:webgl-fail";
    const paneBody = document.createElement("div");
    document.body.append(paneBody);
    controller.setDiagnosticsEnabled(true);
    controller.attachTerminalPane(sessionId, paneBody);
    await flushPromises();
    const snap = controller.getDiagnosticsSnapshot();
    expect(snap.webglAttachFailures).toBe(1);
    expect(snap.domRenderers).toBe(1);
    expect(snap.webglRenderers).toBe(0);
  });

  test("increments context-loss and fallback counters when the GL context is lost", async () => {
    vi.useFakeTimers();
    installFontLoader();
    const { controller } = buildAttachController({ isRemote: false });
    const sessionId = "diag:webgl-loss";
    const paneBody = document.createElement("div");
    document.body.append(paneBody);
    controller.setDiagnosticsEnabled(true);
    controller.attachTerminalPane(sessionId, paneBody);
    await flushPromises();
    webglMockState.instances[0].triggerContextLoss();
    const snap = controller.getDiagnosticsSnapshot();
    expect(snap.webglContextLosses).toBe(1);
    expect(snap.webglFallbacks).toBe(1);
  });
});

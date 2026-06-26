/**
 * macOS-specific behaviour for the Ctrl/Cmd+F key handler. The main
 * terminal-controller.test.ts runs with jsdom's default user agent (which
 * doesn't contain "Mac"), so IS_MAC inside the controller is captured as
 * false there. This file pins the user agent to a Mac string BEFORE the
 * controller module loads (via vi.hoisted) so we can assert the Mac
 * branch — Cmd+F fires, Ctrl+F (which is the Win/Linux modifier) does
 * NOT, and the OS-specific Cmd+ArrowLeft / Cmd+Backspace handlers we
 * already had stay intact (sanity check that we didn't accidentally
 * shadow them with the new Cmd+F intercept).
 */
import { describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(globalThis.navigator, "userAgent", {
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    configurable: true,
  });
});

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
    resize = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
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

import { createTerminalController } from "./terminal-controller.js";

function buildMacController(api: Record<string, unknown> = {}) {
  const views = { value: new Map() };
  const controller = createTerminalController({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    views: views as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buffers: { value: new Map() } as any,
    getActiveSessionId: () => null,
    getOverlay: () => null,
    getPayload: () => null,
    api: { resizeTerminal: vi.fn(), writeTerminal: vi.fn(), isRemote: true, ...api } as Parameters<
      typeof createTerminalController
    >[0]["api"],
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getKeyHandler(view: any): (event: Partial<KeyboardEvent>) => boolean {
  return view.term.attachCustomKeyEventHandler.mock.calls[0][0];
}

describe("Cmd+F on macOS", () => {
  test("Cmd+F (meta only) fires onSearchRequested and swallows the event", () => {
    const onSearchRequested = vi.fn();
    const { controller, views } = buildMacController({ onSearchRequested });
    const sessionId = "workspace-1:shell-1";
    controller.ensureTerminal(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = (views.value as any).get(sessionId);
    const handler = getKeyHandler(view);

    const result = handler({
      type: "keydown",
      key: "f",
      code: "KeyF",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
    });

    expect(onSearchRequested).toHaveBeenCalledWith(sessionId);
    expect(result).toBe(false);
  });

  test("Ctrl+F (the Windows/Linux modifier) does NOT fire onSearchRequested on Mac", () => {
    // On Mac, Cmd is the platform-native "find" modifier. A bare Ctrl+F
    // is what readline / Emacs etc. use as forward-char and must reach
    // the shell unchanged.
    const onSearchRequested = vi.fn();
    const { controller, views } = buildMacController({ onSearchRequested });
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
      shiftKey: false,
    });

    expect(onSearchRequested).not.toHaveBeenCalled();
  });

  test("Cmd+Shift+F does NOT fire onSearchRequested (preserves user/shell binding)", () => {
    const onSearchRequested = vi.fn();
    const { controller, views } = buildMacController({ onSearchRequested });
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
      metaKey: true,
      altKey: false,
      shiftKey: true,
    });

    expect(onSearchRequested).not.toHaveBeenCalled();
  });
});

import { describe, expect, test, vi, afterEach } from "vitest";
import { createTerminalController } from "./terminal-controller.js";

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
    appConfig: {},
    openTerminalLink: vi.fn(),
    getWindowsPtyOptions: vi.fn(),
    shortcutTabDirection: () => 0,
    downloadTextFile: vi.fn(),
    safeFilenamePart: (value: string) => value,
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
    queuedFrame?.(0);

    expect(focus).not.toHaveBeenCalled();
  });
});

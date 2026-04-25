import { defineStore } from "pinia";
import { shallowRef } from "vue";
import { createTerminalController } from "../app/terminal-controller.js";
import { openTerminalLink, getWindowsPtyOptions, downloadTextFile, safeFilenamePart } from "../app/helpers.js";
import type { Transport } from "../transport.js";
import type { StatePayload } from "../../electron/shared/types/state.js";

function shortcutTabDirection(event: KeyboardEvent): number {
  const key = String(event?.key || "");
  const code = String(event?.code || "");
  if (key === "PageDown" || key === "Next" || code === "PageDown") return 1;
  if (key === "PageUp" || key === "Prior" || code === "PageUp") return -1;
  return 0;
}

interface TerminalView {
  mount: HTMLDivElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  term: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fitAddon: any;
  lastSizeKey: string | null;
  resizeFrame: number | null;
  resizeObserver: ResizeObserver | null;
  opened: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppConfig = any;

interface InitOptions {
  getActiveSessionId: () => string | null;
  getOverlay: () => unknown;
  getPayload: () => StatePayload | null | undefined;
}

export const useTerminalStore = defineStore("terminal", () => {
  // These Maps are imperative caches, not reactive state.
  // shallowRef makes them accessible via .value without deep tracking.
  const views = shallowRef(new Map<string, TerminalView>()); // sessionId → { mount, term, fitAddon, ... }
  const buffers = shallowRef(new Map<string, string>()); // sessionId → queued data string

  let controller: ReturnType<typeof createTerminalController> | null = null;

  function init(api: Transport, appConfig: AppConfig, { getActiveSessionId, getOverlay, getPayload }: InitOptions): void {
    controller = createTerminalController({
      views,
      buffers,
      getActiveSessionId,
      getOverlay,
      getPayload,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: api as any,
      appConfig,
      openTerminalLink,
      getWindowsPtyOptions,
      shortcutTabDirection,
      downloadTextFile,
      safeFilenamePart,
    });

    api.onTerminalData!(({ sessionId, data }) => {
      controller!.handleTerminalData({ sessionId, data });
    });

    api.onTerminalExit!(({ sessionId, exitCode }) => {
      controller!.handleTerminalExit({ sessionId, exitCode });
    });

    window.addEventListener("strideterm:theme-changed", () => controller?.syncTheme());
  }

  function attachTerminalPane(sessionId: string, paneBody: HTMLDivElement): unknown {
    return controller?.attachTerminalPane(sessionId, paneBody);
  }

  function focusActiveTerminal(): void {
    controller?.focusActiveTerminal();
  }

  function scheduleActiveResize(options?: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return controller?.scheduleActiveResize(options as any);
  }

  function scheduleAllVisibleResize(): void {
    return controller?.scheduleAllVisibleResize();
  }

  function pruneTerminalViews(validSessionIds: Set<string> | string[]): void {
    const ids = validSessionIds instanceof Set ? validSessionIds : new Set(validSessionIds);
    controller?.pruneTerminalViews(ids);
  }

  function exportTerminalTranscript(sessionId: string, options?: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controller?.exportTerminalTranscript(sessionId, options as any);
  }

  function clearTerminalViewport(sessionId: string): void {
    controller?.clearTerminalViewport(sessionId);
  }

  // Synthetic write — used when the renderer needs to surface a note in the
  // terminal (e.g. "Already disconnected") without a backend session to
  // produce real terminal:data events.
  function writeToTerminal(sessionId: string, data: string): void {
    controller?.handleTerminalData({ sessionId, data });
  }

  function disconnectHiddenPaneObservers(visibleSessionIds: string[]): void {
    const ids = new Set(visibleSessionIds);
    controller?.disconnectHiddenPaneObservers(ids);
  }

  function syncTheme(): void {
    return controller?.syncTheme();
  }

  return {
    views,
    buffers,
    init,
    attachTerminalPane,
    focusActiveTerminal,
    scheduleActiveResize,
    scheduleAllVisibleResize,
    pruneTerminalViews,
    exportTerminalTranscript,
    clearTerminalViewport,
    writeToTerminal,
    disconnectHiddenPaneObservers,
    syncTheme,
  };
});

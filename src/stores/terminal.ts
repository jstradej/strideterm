import { defineStore } from "pinia";
import { shallowRef, watch } from "vue";
import type { SearchAddon } from "@xterm/addon-search";
import { createTerminalController } from "../app/terminal-controller.js";
import type { TerminalView } from "../app/terminal-controller.js";
import {
  openTerminalLink,
  getWindowsPtyOptions,
  downloadTextFile,
  safeFilenamePart,
  shortcutTabDirection,
} from "../app/helpers.js";
import type { Transport } from "../transport.js";
import type { StatePayload } from "../../electron/shared/types/state.js";
import { useAppStore } from "./app.js";

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
  let reconnectFitTimer = 0;

  function init(
    api: Transport,
    appConfig: AppConfig,
    { getActiveSessionId, getOverlay, getPayload }: InitOptions,
  ): void {
    // The controller reads `api.onSearchRequested` from the key handler when
    // the user presses Ctrl/Cmd+F inside a terminal. We don't want to bolt
    // that onto the Transport interface (it has nothing to do with the
    // wire), so we wrap the api here and add a renderer-only callback that
    // re-broadcasts as a window CustomEvent. The corresponding TerminalPane
    // listens for "strideterm:terminal-search" and shows its overlay —
    // avoids threading refs through the layout tree.
    const apiWithSearch = {
      ...api,
      onSearchRequested: (sessionId: string) => {
        window.dispatchEvent(new CustomEvent("strideterm:terminal-search", { detail: { sessionId } }));
      },
    };
    controller = createTerminalController({
      views,
      buffers,
      getActiveSessionId,
      getOverlay,
      getPayload,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: apiWithSearch as any,
      appConfig,
      openTerminalLink,
      getWindowsPtyOptions,
      shortcutTabDirection,
      downloadTextFile,
      safeFilenamePart,
      // Pull-up-to-refresh on remote/mobile: when the user keeps swiping
      // past the bottom of the terminal buffer (no more newer content),
      // fetch a fresh /api/state. Local Electron transport doesn't expose
      // `refresh` because the desktop already gets push updates over IPC,
      // so the gesture is a no-op there.
      onOverscrollRefresh: api.refresh
        ? () => {
            window.dispatchEvent(new CustomEvent("strideterm:manual-refresh"));
            void api.refresh!();
          }
        : undefined,
    });

    api.onTerminalData!(({ sessionId, data, seq }) => {
      controller!.handleTerminalData({ sessionId, data, seq });
    });

    // Remote-only: the server pushes terminal:replay on (re)subscribe as the
    // ordered reset point for a session. `seq`/`throughSeq` flow through so
    // the controller can drop live frames already covered by the replay.
    api.onTerminalReplay?.(({ sessionId, data, throughSeq }) => {
      controller!.handleTerminalReplay({ sessionId: sessionId || "", data, throughSeq });
    });

    api.onTerminalExit!(({ sessionId, exitCode, intentional }) => {
      controller!.handleTerminalExit({ sessionId, exitCode, intentional });
    });

    api.onConnectionState?.((connection) => {
      if (!connection?.connected || !connection.reconnected) {
        return;
      }
      controller?.scheduleAllVisibleResize();
      window.clearTimeout(reconnectFitTimer);
      reconnectFitTimer = window.setTimeout(() => controller?.scheduleAllVisibleResize(), 150);
    });

    window.addEventListener("strideterm:theme-changed", () => controller?.syncTheme());

    const transportKey: "terminalFontSizeLocal" | "terminalFontSizeRemote" = api.isRemote
      ? "terminalFontSizeRemote"
      : "terminalFontSizeLocal";
    let lastFontSize: number | undefined;
    watch(
      () => {
        const s = useAppStore().payload?.appState?.settings as Record<string, unknown> | undefined;
        const v = s?.[transportKey];
        return typeof v === "number" ? v : undefined;
      },
      (next) => {
        if (typeof next === "number" && next !== lastFontSize) {
          lastFontSize = next;
          controller?.syncFontSize(next);
        }
      },
      { immediate: true },
    );
  }

  function attachTerminalPane(sessionId: string, paneBody: HTMLDivElement): unknown {
    return controller?.attachTerminalPane(sessionId, paneBody);
  }

  function detachTerminalPane(sessionId: string, paneBody?: Element | null): void {
    controller?.detachTerminalPane(sessionId, paneBody);
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

  function syncFontSize(size: number): void {
    controller?.syncFontSize(size);
  }

  function getSearchAddon(sessionId: string): SearchAddon | null {
    return controller?.getSearchAddon(sessionId) ?? null;
  }

  function getVisibleTerminalText(sessionId: string): string {
    return controller?.getVisibleTerminalText(sessionId) ?? "";
  }

  // Programmatic equivalent of pressing Ctrl/Cmd+F — used by the header
  // button and the "Find in terminal" context-menu entry. Routes through
  // the same window event so the overlay open path is single-sourced.
  function requestSearch(sessionId: string): void {
    window.dispatchEvent(new CustomEvent("strideterm:terminal-search", { detail: { sessionId } }));
  }

  return {
    views,
    buffers,
    init,
    attachTerminalPane,
    detachTerminalPane,
    focusActiveTerminal,
    scheduleActiveResize,
    scheduleAllVisibleResize,
    pruneTerminalViews,
    exportTerminalTranscript,
    clearTerminalViewport,
    writeToTerminal,
    disconnectHiddenPaneObservers,
    syncTheme,
    syncFontSize,
    getSearchAddon,
    getVisibleTerminalText,
    requestSearch,
  };
});

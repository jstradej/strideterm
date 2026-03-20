import { defineStore } from "pinia";
import { shallowRef } from "vue";
import { createTerminalController } from "../app/terminal-controller.js";
import {
  openTerminalLink,
  getWindowsPtyOptions,
  downloadTextFile,
  safeFilenamePart,
} from "../app/helpers.js";

function shortcutTabDirection(event) {
  const key = String(event?.key || "");
  const code = String(event?.code || "");
  if (key === "PageDown" || key === "Next" || code === "PageDown") return 1;
  if (key === "PageUp" || key === "Prior" || code === "PageUp") return -1;
  return 0;
}

export const useTerminalStore = defineStore("terminal", () => {
  // These Maps are imperative caches, not reactive state.
  // shallowRef makes them accessible via .value without deep tracking.
  const views = shallowRef(new Map());   // sessionId → { mount, term, fitAddon, ... }
  const buffers = shallowRef(new Map()); // sessionId → queued data string

  let controller = null;

  function init(api, appConfig, { getActiveSessionId, getOverlay, getPayload }) {
    controller = createTerminalController({
      views,
      buffers,
      getActiveSessionId,
      getOverlay,
      getPayload,
      api,
      appConfig,
      openTerminalLink,
      getWindowsPtyOptions,
      shortcutTabDirection,
      downloadTextFile,
      safeFilenamePart,
    });

    api.onTerminalData(({ sessionId, data }) => {
      controller.handleTerminalData({ sessionId, data });
    });

    api.onTerminalExit(({ sessionId, exitCode, intentional }) => {
      controller.handleTerminalExit({ sessionId, exitCode, intentional });
    });
  }

  function attachTerminalPane(sessionId, paneBody) {
    return controller?.attachTerminalPane(sessionId, paneBody);
  }

  function focusActiveTerminal() {
    return controller?.focusActiveTerminal();
  }

  function scheduleActiveResize(options) {
    return controller?.scheduleActiveResize(options);
  }

  function scheduleAllVisibleResize() {
    return controller?.scheduleAllVisibleResize();
  }

  function pruneTerminalViews(validSessionIds) {
    return controller?.pruneTerminalViews(validSessionIds);
  }

  function exportTerminalTranscript(sessionId, options) {
    return controller?.exportTerminalTranscript(sessionId, options);
  }

  function clearTerminalViewport(sessionId) {
    return controller?.clearTerminalViewport(sessionId);
  }

  function disconnectHiddenPaneObservers(visibleSessionIds) {
    return controller?.disconnectHiddenPaneObservers(visibleSessionIds);
  }

  function syncTheme() {
    return controller?.syncTheme();
  }

  return {
    views, buffers, init,
    attachTerminalPane, focusActiveTerminal,
    scheduleActiveResize, scheduleAllVisibleResize,
    pruneTerminalViews, exportTerminalTranscript,
    clearTerminalViewport, disconnectHiddenPaneObservers,
    syncTheme,
  };
});

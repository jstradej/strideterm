import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

export function createTerminalController({
  state,
  api,
  appConfig,
  openTerminalLink,
  getWindowsPtyOptions,
  shortcutTabDirection,
  downloadTextFile,
  safeFilenamePart,
}) {
  function focusActiveTerminal() {
    if (state.overlay) return;
    const activeView = state.activeSessionId ? state.terminalViews.get(state.activeSessionId) : null;
    if (!activeView) {
      return;
    }
    window.requestAnimationFrame(() => activeView.term.focus());
  }

  function pruneTerminalViews(validSessionIds) {
    for (const [sessionId, view] of state.terminalViews.entries()) {
      if (validSessionIds.has(sessionId)) {
        continue;
      }

      window.cancelAnimationFrame(view.resizeFrame || 0);
      view.resizeObserver?.disconnect();
      view.term.dispose();
      view.mount.remove();
      state.terminalViews.delete(sessionId);
      state.terminalBuffers.delete(sessionId);
    }
  }

  function scheduleSessionResize(sessionId, { force = false } = {}) {
    const view = state.terminalViews.get(sessionId);
    if (!view || !view.mount.isConnected) {
      return;
    }

    window.cancelAnimationFrame(view.resizeFrame || 0);
    view.resizeFrame = window.requestAnimationFrame(() => {
      if (!view.mount.isConnected) {
        return;
      }

      view.fitAddon.fit();
      const nextSizeKey = `${view.term.cols}x${view.term.rows}`;
      if (!force && nextSizeKey === view.lastSizeKey) {
        return;
      }

      view.lastSizeKey = nextSizeKey;
      api.resizeTerminal(sessionId, { cols: view.term.cols, rows: view.term.rows });
    });
  }

  function scheduleDeferredTerminalFits(sessionId) {
    window.requestAnimationFrame(() => {
      scheduleSessionResize(sessionId, { force: true });
      const view = state.terminalViews.get(sessionId);
      view?.term?.refresh?.(0, Math.max(0, view.term.rows - 1));
    });
    window.setTimeout(() => {
      scheduleSessionResize(sessionId, { force: true });
      const view = state.terminalViews.get(sessionId);
      view?.term?.refresh?.(0, Math.max(0, view.term.rows - 1));
    }, 120);

    document.fonts?.ready?.then(() => {
      scheduleSessionResize(sessionId, { force: true });
      const view = state.terminalViews.get(sessionId);
      view?.term?.refresh?.(0, Math.max(0, view.term.rows - 1));
    }).catch(() => {});
  }

  function scheduleActiveResize(options) {
    if (!state.activeSessionId) {
      return;
    }
    scheduleSessionResize(state.activeSessionId, options);
  }

  function scheduleAllVisibleResize() {
    for (const [sessionId, view] of state.terminalViews.entries()) {
      if (view.mount.isConnected) {
        scheduleSessionResize(sessionId, { force: true });
      }
    }
  }

  function ensureTerminal(sessionId) {
    if (state.terminalViews.has(sessionId)) {
      return state.terminalViews.get(sessionId);
    }

    const mount = document.createElement("div");
    mount.className = "terminal-host";
    mount.dataset.sessionId = sessionId;
    const windowsPty = getWindowsPtyOptions(state.payload);
    const isLight = document.documentElement.dataset.theme === "light";
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", monospace',
      fontSize: 13,
      scrollback: 6000,
      scrollSensitivity: 1.15,
      fastScrollModifier: "shift",
      fastScrollSensitivity: 4,
      cursorBlink: true,
      allowTransparency: false,
      smoothScrollDuration: 0,
      theme: isLight
        ? { background: "#f7f7f9", foreground: "#18181b", cursor: "#18181b", selectionBackground: "rgba(0,0,0,0.15)" }
        : { background: "#141416", foreground: "#d8e4f5", cursor: "#d8e4f5", selectionBackground: "rgba(255,255,255,0.15)" },
      ...(windowsPty ? { windowsPty } : {}),
      linkHandler: {
        activate: openTerminalLink,
        allowNonHttpProtocols: false,
      },
      theme: {
        background: "#071019",
        foreground: appConfig.ui.terminalForegroundColor,
        selectionBackground: "#264b6e",
        cursor: "#ffa424",
      },
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon(openTerminalLink);
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.attachCustomKeyEventHandler((event) => {
      if (!(event.ctrlKey || event.metaKey)) return true;
      if (!event.altKey && /^Digit[1-9]$/.test(event.code)) return false;
      if (event.key.toLowerCase() === "n" || event.key.toLowerCase() === "r") return false;
      if (shortcutTabDirection(event) !== 0) return false;
      return true;
    });
    term.onData((data) => api.writeTerminal(sessionId, data));
    state.terminalViews.set(sessionId, {
      mount,
      term,
      fitAddon,
      lastSizeKey: null,
      resizeFrame: null,
      resizeObserver: null,
      opened: false,
    });

    return state.terminalViews.get(sessionId);
  }

  function disconnectHiddenPaneObservers(visibleSessionIds) {
    for (const [sessionId, view] of state.terminalViews.entries()) {
      if (visibleSessionIds.has(sessionId)) {
        continue;
      }
      view.resizeObserver?.disconnect();
      view.resizeObserver = null;
    }
  }

  function attachTerminalPane(sessionId, paneBody) {
    const view = ensureTerminal(sessionId);
    paneBody.append(view.mount);
    if (!view.opened) {
      view.term.open(view.mount);
      view.opened = true;
      const queued = state.terminalBuffers.get(sessionId);
      if (queued) {
        view.term.write(queued);
        state.terminalBuffers.delete(sessionId);
      }
      scheduleDeferredTerminalFits(sessionId);
    } else {
      // Force fit + refresh after re-attach (pane may have changed size)
      scheduleDeferredTerminalFits(sessionId);
    }
    view.resizeObserver?.disconnect();
    view.resizeObserver = new ResizeObserver(() => {
      scheduleSessionResize(sessionId);
    });
    view.resizeObserver.observe(paneBody);
    scheduleSessionResize(sessionId, { force: true });
    return view;
  }

  function getTerminalTranscript(sessionId, { lineCount = 500 } = {}) {
    const view = state.terminalViews.get(sessionId);
    const buffer = view?.term?.buffer?.active;
    if (!buffer) {
      return "";
    }

    const lines = [];
    const start = Math.max(0, buffer.length - lineCount);
    for (let index = start; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (!line) {
        continue;
      }

      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) {
        lines[lines.length - 1] += text;
      } else {
        lines.push(text);
      }
    }

    return lines.join("\n").trimEnd();
  }

  function clearTerminalViewport(sessionId) {
    const view = state.terminalViews.get(sessionId);
    view?.term?.clear();
  }

  function exportTerminalTranscript(sessionId, { title = "Terminal", lineCount = 500 } = {}) {
    const transcript = getTerminalTranscript(sessionId, { lineCount });
    if (!transcript) {
      return false;
    }

    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const filename = `${safeFilenamePart(title, "terminal")}-${timestamp}.log`;
    downloadTextFile(filename, `# ${title}\n# Exported ${new Date().toISOString()}\n# Last ${lineCount} lines\n\n${transcript}\n`);
    return true;
  }

  function handleTerminalData({ sessionId, data }) {
    const view = state.terminalViews.get(sessionId);
    if (!view || !view.opened) {
      state.terminalBuffers.set(sessionId, `${state.terminalBuffers.get(sessionId) || ""}${data}`);
      return;
    }
    view.term.write(data);
  }

  function handleTerminalExit({ sessionId, exitCode, intentional }) {
    if (intentional) {
      return;
    }
    const view = state.terminalViews.get(sessionId);
    const line = `\r\n[process exited with code ${exitCode}]\r\n`;
    if (view?.opened) {
      view.term.writeln(line);
    } else {
      state.terminalBuffers.set(sessionId, `${state.terminalBuffers.get(sessionId) || ""}${line}`);
    }
  }

  return {
    attachTerminalPane,
    clearTerminalViewport,
    disconnectHiddenPaneObservers,
    ensureTerminal,
    exportTerminalTranscript,
    focusActiveTerminal,
    handleTerminalData,
    handleTerminalExit,
    pruneTerminalViews,
    scheduleActiveResize,
    scheduleAllVisibleResize,
    syncTheme() {
      const isLight = document.documentElement.dataset.theme === "light";
      const theme = isLight
        ? { background: "#f7f7f9", foreground: "#18181b", cursor: "#18181b", selectionBackground: "rgba(0,0,0,0.15)" }
        : { background: "#141416", foreground: "#d8e4f5", cursor: "#d8e4f5", selectionBackground: "rgba(255,255,255,0.15)" };
      for (const view of state.terminalViews.values()) {
        view.term.options.theme = theme;
      }
    },
  };
}

import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Ref } from "vue";
import type { APP_CONFIG } from "../../config/app-config.js";
import type { StatePayload } from "../../electron/shared/types/state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TerminalView {
  mount: HTMLDivElement;
  term: Terminal;
  fitAddon: FitAddon;
  lastSizeKey: string | null;
  resizeFrame: number | null;
  resizeObserver: ResizeObserver | null;
  opened: boolean;
}

interface TerminalControllerApi {
  resizeTerminal: (sessionId: string, size: { cols: number; rows: number }) => void;
  writeTerminal: (sessionId: string, data: string) => void;
}

type AppConfig = typeof APP_CONFIG;

// ---------------------------------------------------------------------------

function resolveTerminalTheme(appConfig: AppConfig): ITheme {
  const isLight = document.documentElement.dataset.theme === "light";
  return isLight
    ? { background: "#f7f7f9", foreground: "#18181b", cursor: "#18181b", selectionBackground: "rgba(0,0,0,0.15)" }
    : {
        background: "#141416",
        foreground: appConfig?.ui?.terminalForegroundColor || "#d8e4f5",
        cursor: "#ffa424",
        selectionBackground: "rgba(255,255,255,0.15)",
      };
}

export function createTerminalController({
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
}: {
  views: Ref<Map<string, TerminalView>>;
  buffers: Ref<Map<string, string>>;
  getActiveSessionId: () => string | null;
  getOverlay: () => unknown;
  getPayload: () => StatePayload | null | undefined;
  api: TerminalControllerApi;
  appConfig: AppConfig;
  openTerminalLink: (event: { preventDefault?: () => void } | null | undefined, uri: string) => void;
  getWindowsPtyOptions: (payload: StatePayload | null | undefined) => { backend: string; buildNumber: number } | null;
  shortcutTabDirection: (event: KeyboardEvent) => number;
  downloadTextFile: (filename: string, content: string) => void;
  safeFilenamePart: (value: unknown, fallback?: string) => string;
}) {
  function focusActiveTerminal(): void {
    if (getOverlay()) return;
    const activeSessionId = getActiveSessionId();
    const activeView = activeSessionId ? views.value.get(activeSessionId) : null;
    if (!activeView) {
      return;
    }
    window.requestAnimationFrame(() => activeView.term.focus());
  }

  function pruneTerminalViews(validSessionIds: Set<string>): void {
    for (const [sessionId, view] of views.value.entries()) {
      if (validSessionIds.has(sessionId)) {
        continue;
      }

      window.cancelAnimationFrame(view.resizeFrame || 0);
      view.resizeObserver?.disconnect();
      view.term.dispose();
      view.mount.remove();
      views.value.delete(sessionId);
      buffers.value.delete(sessionId);
    }
  }

  function scheduleSessionResize(sessionId: string, { force = false } = {}): void {
    const view = views.value.get(sessionId);
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

  function scheduleDeferredTerminalFits(sessionId: string): void {
    window.requestAnimationFrame(() => {
      scheduleSessionResize(sessionId, { force: true });
      const view = views.value.get(sessionId);
      view?.term?.refresh?.(0, Math.max(0, view.term.rows - 1));
    });
    window.setTimeout(() => {
      scheduleSessionResize(sessionId, { force: true });
      const view = views.value.get(sessionId);
      view?.term?.refresh?.(0, Math.max(0, view.term.rows - 1));
    }, 120);

    document.fonts?.ready
      ?.then(() => {
        scheduleSessionResize(sessionId, { force: true });
        const view = views.value.get(sessionId);
        view?.term?.refresh?.(0, Math.max(0, view.term.rows - 1));
      })
      .catch(() => {});
  }

  function scheduleActiveResize(options?: { force?: boolean }): void {
    const activeSessionId = getActiveSessionId();
    if (!activeSessionId) {
      return;
    }
    scheduleSessionResize(activeSessionId, options);
  }

  function scheduleAllVisibleResize(): void {
    for (const [sessionId, view] of views.value.entries()) {
      if (view.mount.isConnected) {
        scheduleSessionResize(sessionId, { force: true });
      }
    }
  }

  function ensureTerminal(sessionId: string): TerminalView {
    if (views.value.has(sessionId)) {
      return views.value.get(sessionId)!;
    }

    const mount = document.createElement("div");
    mount.className = "terminal-host";
    mount.dataset.sessionId = sessionId;
    const windowsPty = getWindowsPtyOptions(getPayload());
    const term = new Terminal({
      fontFamily:
        '"JetBrainsMono NFM", "CaskaydiaCove NFM", "MesloLGS NF", "FiraCode NFM", "Cascadia Mono NF", "Cascadia Code PL", "Cascadia Mono", "JetBrains Mono", "Fira Code", "Consolas", monospace',
      fontSize: 13,
      scrollback: appConfig.session?.scrollback ?? 3000,
      scrollSensitivity: 1.15,
      fastScrollModifier: "shift",
      fastScrollSensitivity: 4,
      cursorBlink: false,
      allowTransparency: false,
      smoothScrollDuration: 0,
      ...(windowsPty ? { windowsPty } : {}),
      linkHandler: {
        activate: openTerminalLink,
        allowNonHttpProtocols: false,
      },
      theme: resolveTerminalTheme(appConfig),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon(openTerminalLink);
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.attachCustomKeyEventHandler((event) => {
      if (!(event.ctrlKey || event.metaKey)) return true;
      if (!event.altKey && /^Digit[1-9]$/.test(event.code)) return false;
      if (event.key.toLowerCase() === "n" || event.key.toLowerCase() === "r") return false;
      if (shortcutTabDirection(event) !== 0) return false;
      // Ctrl+C copies when text is selected, otherwise let xterm send SIGINT
      if (event.type === "keydown" && event.key.toLowerCase() === "c" && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      // Ctrl+V — let browser handle natively (xterm picks up the paste event)
      if (event.key.toLowerCase() === "v") return false;
      return true;
    });
    // Right-click: copy selection or paste (PuTTY-style)
    mount.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
      } else {
        navigator.clipboard.readText().then((text) => {
          if (text) term.paste(text);
        });
      }
    });
    term.onData((data) => api.writeTerminal(sessionId, data));
    views.value.set(sessionId, {
      mount,
      term,
      fitAddon,
      lastSizeKey: null,
      resizeFrame: null,
      resizeObserver: null,
      opened: false,
    });

    return views.value.get(sessionId)!;
  }

  function disconnectHiddenPaneObservers(visibleSessionIds: Set<string>): void {
    for (const [sessionId, view] of views.value.entries()) {
      if (visibleSessionIds.has(sessionId)) {
        continue;
      }
      view.resizeObserver?.disconnect();
      view.resizeObserver = null;
    }
  }

  function attachTerminalPane(sessionId: string, paneBody: Element): TerminalView {
    const view = ensureTerminal(sessionId);
    paneBody.append(view.mount);
    if (!view.opened) {
      view.term.open(view.mount);
      view.opened = true;
      const queued = buffers.value.get(sessionId);
      if (queued) {
        view.term.write(queued);
        buffers.value.delete(sessionId);
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

  function getTerminalTranscript(sessionId: string, { lineCount = 500 } = {}): string {
    const view = views.value.get(sessionId);
    const buffer = view?.term?.buffer?.active;
    if (!buffer) {
      return "";
    }

    const lines: string[] = [];
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

  function clearTerminalViewport(sessionId: string): void {
    const view = views.value.get(sessionId);
    view?.term?.clear();
  }

  function exportTerminalTranscript(sessionId: string, { title = "Terminal", lineCount = 500 } = {}): boolean {
    const transcript = getTerminalTranscript(sessionId, { lineCount });
    if (!transcript) {
      return false;
    }

    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const filename = `${safeFilenamePart(title, "terminal")}-${timestamp}.log`;
    downloadTextFile(
      filename,
      `# ${title}\n# Exported ${new Date().toISOString()}\n# Last ${lineCount} lines\n\n${transcript}\n`,
    );
    return true;
  }

  function handleTerminalData({ sessionId, data }: { sessionId: string; data: string }): void {
    const view = views.value.get(sessionId);
    if (!view || !view.opened) {
      buffers.value.set(sessionId, `${buffers.value.get(sessionId) || ""}${data}`);
      return;
    }
    view.term.write(data);
  }

  function handleTerminalExit({
    sessionId,
    exitCode,
    intentional,
  }: {
    sessionId: string;
    exitCode: number;
    intentional?: boolean;
  }): void {
    if (intentional) {
      return;
    }
    const view = views.value.get(sessionId);
    const line = `\r\n[process exited with code ${exitCode}]\r\n`;
    if (view?.opened) {
      view.term.writeln(line);
    } else {
      buffers.value.set(sessionId, `${buffers.value.get(sessionId) || ""}${line}`);
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
      const theme = resolveTerminalTheme(appConfig);
      for (const view of views.value.values()) {
        view.term.options.theme = theme;
      }
    },
  };
}

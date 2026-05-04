import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
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

type LogLevel = "info" | "warn" | "error" | "debug";

interface TerminalControllerApi {
  resizeTerminal: (sessionId: string, size: { cols: number; rows: number }) => void;
  writeTerminal: (sessionId: string, data: string) => void;
  isRemote?: boolean;
  startupFlags?: {
    disableWebgl?: boolean;
  };
  logRenderer?: (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// WebGL pre-flight
// ---------------------------------------------------------------------------
// xterm.js's WebglAddon constructor only fails (throws) when WebGL2 context
// creation outright errors. On certain older Macs / Intel iGPUs the context
// is created successfully but rendering produces broken output (giant
// glyphs, blank canvas) — the addon never sees an error so we never fall
// back. Mitigation: probe WebGL2 capability ourselves before instantiating
// the addon. Probe runs once per session and is cached because the result
// can't change at runtime (context loss is handled separately via
// onContextLoss).
type WebglProbe = { ok: boolean; reason: string };
let cachedWebglProbe: WebglProbe | null = null;

function probeWebgl2(): WebglProbe {
  if (cachedWebglProbe) return cachedWebglProbe;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;

    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl2", {
        antialias: false,
        preserveDrawingBuffer: false,
        // Tell the driver to refuse the context if it would force software
        // rasterization. Catches a chunk of the broken-macOS cases without
        // needing a renderer-string heuristic.
        failIfMajorPerformanceCaveat: true,
      }) as WebGL2RenderingContext | null;
    } catch (err) {
      cachedWebglProbe = { ok: false, reason: `getContext-threw:${(err as Error)?.message || "unknown"}` };
      return cachedWebglProbe;
    }

    if (!gl) {
      cachedWebglProbe = { ok: false, reason: "no-webgl2-context" };
      return cachedWebglProbe;
    }

    // Software-renderer blacklist. Apple hides WEBGL_debug_renderer_info on
    // macOS so this branch is mostly a Windows/Linux safety net; on macOS
    // we rely on failIfMajorPerformanceCaveat + the shader-compile probe.
    let renderer = "";
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (dbg) {
      try {
        renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "");
      } catch {
        renderer = "";
      }
      if (renderer && /SwiftShader|llvmpipe|software|Microsoft Basic Render/i.test(renderer)) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        cachedWebglProbe = { ok: false, reason: `software-renderer:${renderer}` };
        return cachedWebglProbe;
      }
    }

    // Compile a trivial vertex shader. WebglAddon compiles its own shaders
    // on construction; if the GPU's shader compiler is broken (rare but
    // observed on some macOS setups) the addon's shaders fail too. Probing
    // here lets us short-circuit to DOM before the addon paints garbage.
    const vs = gl.createShader(gl.VERTEX_SHADER);
    if (!vs) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      cachedWebglProbe = { ok: false, reason: "shader-create-failed" };
      return cachedWebglProbe;
    }
    gl.shaderSource(vs, "#version 300 es\nvoid main(){ gl_Position = vec4(0); }");
    gl.compileShader(vs);
    const compiled = gl.getShaderParameter(vs, gl.COMPILE_STATUS);
    gl.deleteShader(vs);
    if (!compiled) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      cachedWebglProbe = { ok: false, reason: "vertex-shader-compile-failed" };
      return cachedWebglProbe;
    }

    gl.getExtension("WEBGL_lose_context")?.loseContext();
    cachedWebglProbe = { ok: true, reason: renderer ? `ok:${renderer}` : "ok" };
    return cachedWebglProbe;
  } catch (err) {
    cachedWebglProbe = { ok: false, reason: `probe-threw:${(err as Error)?.message || "unknown"}` };
    return cachedWebglProbe;
  }
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
      // Switch to the GPU renderer for smooth scrolling under heavy TUI traffic
      // (e.g. Claude Code) on the desktop. We skip it on remote clients (web,
      // mobile) because mobile WebGL is unreliable and we can't validate the
      // result. On the desktop we wait for fonts.ready + an initial fit before
      // loading the addon — WebglAddon caches glyph dimensions at load time, so
      // attaching it before the font is ready or while the canvas is 0×0
      // produces a permanently broken renderer (giant glyphs, blank screen)
      // with no automatic fallback.
      if (!api.isRemote) {
        const log = api.logRenderer ?? (() => {});
        const disabledByFlag = api.startupFlags?.disableWebgl ?? false;

        if (disabledByFlag) {
          log("info", "[webgl] skipped: disabled by --no-webgl / STRIDETERM_DISABLE_WEBGL");
        } else {
          const probe = probeWebgl2();
          if (!probe.ok) {
            log("warn", "[webgl] skipped: pre-flight failed, using DOM renderer", { reason: probe.reason });
          } else {
            const loadWebgl = () => {
              if (!view.mount.isConnected || view.term.cols === 0 || view.term.rows === 0) {
                return;
              }
              try {
                const webglAddon = new WebglAddon();
                webglAddon.onContextLoss(() => {
                  log("warn", "[webgl] context lost; disposing addon, falling back to DOM renderer");
                  webglAddon.dispose();
                });
                view.term.loadAddon(webglAddon);
                log("info", "[webgl] renderer enabled", { probe: probe.reason });
              } catch (err) {
                log("error", "[webgl] addon load threw; falling back to DOM renderer", {
                  error: (err as Error)?.message || String(err),
                });
              }
            };
            const ready = document.fonts?.ready ?? Promise.resolve();
            ready.then(() => window.setTimeout(loadWebgl, 50)).catch(() => {});
          }
        }
      }
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

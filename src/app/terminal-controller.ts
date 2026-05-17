import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import type { Ref } from "vue";
import type { APP_CONFIG } from "../../config/app-config.js";
import type { StatePayload, WorkspaceState } from "../../electron/shared/types/state.js";
import { detectPaths } from "./path-detector.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TerminalView {
  mount: HTMLDivElement;
  term: Terminal;
  fitAddon: FitAddon;
  lastSizeKey: string | null;
  resizeFrame: number | null;
  resizeObserver: ResizeObserver | null;
  opened: boolean;
  /**
   * True while a `WebglAddon` instance is live on this terminal. Flipped
   * back to false when xterm fires `onContextLoss` (and the addon disposes
   * itself), which lets the re-attach path know it needs to create a new
   * addon instance — without this, a workspace switch on macOS that loses
   * the GL context leaves the terminal silently stuck on the DOM
   * fallback (or worse, a black canvas) until the session is restarted.
   */
  webglAttached: boolean;
}

type LogLevel = "info" | "warn" | "error" | "debug";

const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("mac");

interface TerminalControllerApi {
  resizeTerminal: (sessionId: string, size: { cols: number; rows: number }) => void;
  writeTerminal: (sessionId: string, data: string) => void;
  /** Optional — desktop only. Path link clicks are no-ops in remote mode. */
  openTerminalPath?: (request: { path: string; workspaceCwd?: string; line?: number; column?: number }) => Promise<{
    ok: boolean;
    absPath?: string;
    error?: string;
    internal?: boolean;
    line?: number;
    column?: number;
  }>;
  isRemote?: boolean;
  startupFlags?: {
    disableWebgl?: boolean;
  };
  logRenderer?: (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;
  updateSettings?: (settings: Record<string, unknown>) => void;
}

/**
 * Recover the cwd of the workspace that owns a given session. Session IDs
 * are formatted `<workspaceId>:<panelId>`, so we split on the first colon
 * and look up the workspace in the current state. Returns the cwd or an
 * empty string when unknown — the backend `terminal:open-path` handler
 * falls back to process.cwd() in that case, which is right for paths the
 * user pastes into a terminal that's not bound to a worktree.
 */
function resolveWorkspaceCwdForSession(sessionId: string, payload: StatePayload | null | undefined): string {
  if (!sessionId || !payload) return "";
  const colonIdx = sessionId.indexOf(":");
  const workspaceId = colonIdx >= 0 ? sessionId.slice(0, colonIdx) : sessionId;
  const workspaces = (payload.appState?.workspaces || []) as WorkspaceState[];
  const ws = workspaces.find((w) => w.id === workspaceId);
  return ws?.cwd || "";
}

/**
 * Drive the in-app FileManager pane to a path resolved from a terminal
 * link. Used by the path-link `activate` handler when the user has chosen
 * the "internal" external-path-opener mode.
 *
 * Requires the active workspace to expose a Files tab (a panel with
 * `command: "__files__"`). If no Files tab exists or the path is outside
 * the workspace root, surfaces a hint toast and bails — the user can then
 * either open a Files tab or switch the opener mode in Settings.
 *
 * Imports are deferred so this module doesn't pull the renderer stores into
 * its own load graph (terminal-controller is loaded eagerly; the stores
 * shouldn't be).
 */
async function openInInternalViewer(absPath: string): Promise<void> {
  const [appMod, fmMod, notifMod] = await Promise.all([
    import("../stores/app.js"),
    import("../stores/file-manager.js"),
    import("../stores/notifications.js"),
  ]);
  const appStore = appMod.useAppStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profileId = ((appStore as any).activeProfile?.id as string) || "default";
  const ws = appStore.activeWorkspace;
  if (!ws) {
    notifMod
      .useNotificationStore()
      .showError("Open in Files failed", "No active workspace to open the file in.", { profileId });
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- workspace.panels is loosely typed in the store
  const filesPanel = ((ws.panels || []) as any[]).find((p) => p?.command === "__files__");
  if (!filesPanel) {
    notifMod
      .useNotificationStore()
      .showError(
        "Open in Files failed",
        "No Files tab in this workspace — open one first, or change the path-opener mode in Settings.",
        { profileId },
      );
    return;
  }
  await appStore.activateView(`files:${filesPanel.id}`);
  const fmStore = fmMod.useFileManagerStore();
  if (ws.cwd) {
    await fmStore.init(ws.cwd);
  }
  const ok = await fmStore.openFileAbsPath(absPath);
  if (!ok) {
    notifMod
      .useNotificationStore()
      .showError(
        "Open in Files failed",
        `Couldn't navigate to ${absPath} — the file may be outside the workspace root.`,
        { profileId },
      );
  }
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
        // Prefer the discrete GPU on multi-GPU systems (laptops with
        // integrated + discrete). We intentionally do NOT set
        // failIfMajorPerformanceCaveat:true — that flag is too aggressive in
        // Electron: it returns null for integrated GPUs that are perfectly
        // capable of hardware rendering, forcing the CPU-heavy DOM renderer.
        // Software renderers are caught below via the renderer-string
        // blacklist and the shader-compile probe.
        powerPreference: "high-performance",
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
    // the shader-compile probe below is the primary guard.
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
  // ---------------------------------------------------------------------------
  // Font size: per-transport zoom (Ctrl+wheel, Ctrl+0, pinch, Settings)
  // ---------------------------------------------------------------------------

  const FONT_SIZE_KEY = api.isRemote ? "terminalFontSizeRemote" : "terminalFontSizeLocal";

  function readFontSize(): number {
    const s = getPayload()?.appState?.settings as Record<string, unknown> | undefined;
    const raw = s?.[FONT_SIZE_KEY];
    return typeof raw === "number" ? raw : 13;
  }

  function setTerminalFontSize(view: TerminalView, size: number): void {
    const clamped = Math.min(32, Math.max(8, Math.round(size)));
    if ((view.term.options.fontSize ?? 13) === clamped) return;
    view.term.options.fontSize = clamped;
    const sid = view.mount.dataset.sessionId;
    if (sid) scheduleSessionResize(sid, { force: true });
  }

  function syncFontSize(size: number): void {
    for (const view of views.value.values()) {
      setTerminalFontSize(view, size);
    }
  }

  let applyFontSizeTimer: ReturnType<typeof setTimeout> | null = null;
  function applyFontSize(size: number): void {
    const clamped = Math.min(32, Math.max(8, Math.round(size)));
    syncFontSize(clamped);
    if (applyFontSizeTimer !== null) clearTimeout(applyFontSizeTimer);
    applyFontSizeTimer = setTimeout(() => {
      applyFontSizeTimer = null;
      api.updateSettings?.({ [FONT_SIZE_KEY]: clamped });
    }, 200);
  }

  // ---------------------------------------------------------------------------

  function focusActiveTerminal(): void {
    if (getOverlay()) return;
    const activeSessionId = getActiveSessionId();
    const activeView = activeSessionId ? views.value.get(activeSessionId) : null;
    if (!activeView) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (getOverlay()) return;
      activeView.term.focus();
    });
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
      // Force a repaint after fit(). fit() is a no-op when proposed
      // dimensions match the current ones (and FitAddon also no-ops on a
      // 0×0 container), so the internal xterm resize callback that would
      // normally render the buffer never fires. On mobile, a viewport
      // transition (orientation flip, iOS chrome bar toggle, breakpoint
      // cross) can briefly hide the host and leave it blank afterwards;
      // forcing refresh here is the standard xterm workaround for that
      // class of bug (xterm.js issues #3029, #3653).
      view.term.refresh(0, Math.max(0, view.term.rows - 1));
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
    mount.style.touchAction = "none";
    const windowsPty = getWindowsPtyOptions(getPayload());
    const term = new Terminal({
      fontFamily:
        '"JetBrainsMono NFM", "CaskaydiaCove NFM", "MesloLGS NF", "FiraCode NFM", "Cascadia Mono NF", "Cascadia Code PL", "Cascadia Mono", "JetBrains Mono", "Fira Code", "Consolas", monospace',
      fontSize: readFontSize(),
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
    // File-path link provider: scans each visible line for path-shaped text
    // (Unix /abs/path, Windows C:\..., relative ./..., compiler refs like
    // foo.ts:42:5) and surfaces them as clickable links. The detector lives
    // in path-detector.ts (see its tests for the full inclusion / exclusion
    // contract). Validation that the path actually resolves to a real file
    // happens in the backend `terminal:open-path` IPC, so a stale match
    // surfaces as a "File not found" toast instead of silently doing nothing.
    // Skipped on remote transports — the backend handler runs on the host
    // and would open files there, which is rarely what a remote user wants.
    if (!api.isRemote && typeof api.openTerminalPath === "function") {
      const openPath = api.openTerminalPath;
      term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const buffer = term.buffer.active;
          const line = buffer.getLine(bufferLineNumber - 1);
          const text = line ? line.translateToString(true) : "";
          if (!text) {
            callback(undefined);
            return;
          }
          const matches = detectPaths(text);
          if (matches.length === 0) {
            callback(undefined);
            return;
          }
          const workspaceCwd = resolveWorkspaceCwdForSession(sessionId, getPayload());
          const links = matches.map((m) => ({
            range: {
              start: { x: m.start + 1, y: bufferLineNumber },
              end: { x: m.start + m.length, y: bufferLineNumber },
            },
            text: text.substring(m.start, m.start + m.length),
            activate: () => {
              void openPath({ path: m.path, line: m.line, column: m.column, workspaceCwd })
                .then(async (result) => {
                  if (!result?.ok) {
                    const [{ useNotificationStore }, { useAppStore }] = await Promise.all([
                      import("../stores/notifications.js"),
                      import("../stores/app.js"),
                    ]);
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const profileId = ((useAppStore() as any).activeProfile?.id as string) || "default";
                    useNotificationStore().showError(
                      "Open path failed",
                      `Couldn't open ${m.path}: ${result?.error || "unknown error"}`,
                      { profileId },
                    );
                    return;
                  }
                  // Internal-mode response: backend resolved + validated the
                  // path but didn't open anything. Drive the in-app
                  // FileManager pane from here. Falls back to a toast hint if
                  // the workspace doesn't expose a Files tab yet.
                  if (result.internal === true && result.absPath) {
                    await openInInternalViewer(result.absPath);
                  }
                })
                .catch(async (err: unknown) => {
                  const [{ useNotificationStore }, { useAppStore }] = await Promise.all([
                    import("../stores/notifications.js"),
                    import("../stores/app.js"),
                  ]);
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const profileId = ((useAppStore() as any).activeProfile?.id as string) || "default";
                  useNotificationStore().showError(
                    "Open path failed",
                    `Couldn't open ${m.path}: ${(err as Error)?.message || String(err)}`,
                    { profileId },
                  );
                });
            },
          }));
          callback(links);
        },
      });
    }
    term.attachCustomKeyEventHandler((event) => {
      // Mac: translate Cmd / Option + arrows and Backspace into the escape
      // sequences readline-style CLIs (zsh, bash, Claude Code, fzf, …)
      // actually understand. xterm.js leaves these unmapped by default, so
      // without this Cmd+Left silently does nothing on macOS.
      if (IS_MAC && event.type === "keydown") {
        if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          switch (event.key) {
            case "ArrowLeft":
              api.writeTerminal(sessionId, "\x1b[H"); // Home
              return false;
            case "ArrowRight":
              api.writeTerminal(sessionId, "\x1b[F"); // End
              return false;
            case "Backspace":
              api.writeTerminal(sessionId, "\x15"); // Ctrl+U — kill to start of line
              return false;
            default:
              break;
          }
        }
        if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
          switch (event.key) {
            case "ArrowLeft":
              api.writeTerminal(sessionId, "\x1bb"); // ESC b — previous word
              return false;
            case "ArrowRight":
              api.writeTerminal(sessionId, "\x1bf"); // ESC f — next word
              return false;
            case "Backspace":
              api.writeTerminal(sessionId, "\x17"); // Ctrl+W — kill word backward
              return false;
            default:
              break;
          }
        }
      }
      if (!(event.ctrlKey || event.metaKey)) return true;
      if (
        !event.altKey &&
        !event.shiftKey &&
        (event.code === "Digit0" || event.code === "Numpad0") &&
        event.type === "keydown"
      ) {
        applyFontSize(13);
        return false;
      }
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
    // Ctrl/Cmd + wheel → zoom in/out; no modifier → let xterm scroll normally.
    term.attachCustomWheelEventHandler((e) => {
      const zoomMod = IS_MAC ? e.ctrlKey || e.metaKey : e.ctrlKey;
      if (!zoomMod) return true;
      e.preventDefault();
      e.stopPropagation();
      const cur = (term.options.fontSize ?? 13) as number;
      applyFontSize(cur + (e.deltaY < 0 ? 1 : -1));
      return false;
    });

    // Touch scroll (1 finger) + pinch zoom (2 fingers).
    const touch = {
      mode: "none" as "none" | "scroll" | "pinch",
      lastY: 0,
      scrollAccum: 0,
      startDist: 0,
      startFont: 0,
    };

    function getTouchDist(e: TouchEvent): number {
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    }

    mount.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        if (e.touches.length === 1) {
          touch.mode = "scroll";
          touch.lastY = e.touches[0].clientY;
          touch.scrollAccum = 0;
        } else if (e.touches.length === 2) {
          const dist = getTouchDist(e);
          if (dist < 40) {
            touch.mode = "scroll";
            touch.lastY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            touch.scrollAccum = 0;
          } else {
            touch.mode = "pinch";
            touch.startDist = dist;
            touch.startFont = (term.options.fontSize ?? 13) as number;
          }
        } else {
          touch.mode = "none";
        }
      },
      { passive: false },
    );

    mount.addEventListener(
      "touchmove",
      (e) => {
        e.preventDefault();
        if (touch.mode === "scroll" && e.touches.length >= 1) {
          const currentY = e.touches[0].clientY;
          const dy = touch.lastY - currentY;
          touch.lastY = currentY;
          touch.scrollAccum += dy;
          const fontSize = (term.options.fontSize ?? 13) as number;
          const lineHeight = Math.max(8, fontSize * ((term.options.lineHeight as number) || 1));
          const lines = Math.floor(Math.abs(touch.scrollAccum) / lineHeight);
          if (lines > 0) {
            const dir = touch.scrollAccum > 0 ? 1 : -1;
            touch.scrollAccum -= dir * lines * lineHeight;
            if (term.buffer.active.type === "alternate") {
              const seq = dir > 0 ? "\x1b[B" : "\x1b[A";
              for (let i = 0; i < lines; i++) api.writeTerminal(sessionId, seq);
            } else {
              term.scrollLines(dir * lines);
            }
          }
        } else if (touch.mode === "pinch" && e.touches.length >= 2) {
          const dist = getTouchDist(e);
          if (dist < 40 || touch.startDist < 40) return;
          applyFontSize(Math.round(touch.startFont * (dist / touch.startDist)));
        }
      },
      { passive: false },
    );

    const resetTouch = () => {
      touch.mode = "none";
    };
    mount.addEventListener("touchend", resetTouch, { passive: true });
    mount.addEventListener("touchcancel", resetTouch, { passive: true });

    term.onData((data) => api.writeTerminal(sessionId, data));
    views.value.set(sessionId, {
      mount,
      term,
      fitAddon,
      lastSizeKey: null,
      resizeFrame: null,
      resizeObserver: null,
      opened: false,
      webglAttached: false,
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

  /**
   * Best-effort attach of the WebGL renderer for one terminal view.
   * Idempotent — if `view.webglAttached` is already true the call is a
   * no-op. Used by both the first-open and re-attach paths so a
   * WebGL-context-lost terminal can recover after a workspace switch
   * without restarting the session (the macOS integrated-GPU symptom
   * where panes come back black after switching away).
   */
  function tryAttachWebglAddon(view: TerminalView, reason: "open" | "reattach"): void {
    if (view.webglAttached) return;
    if (api.isRemote) return;
    const log = api.logRenderer ?? (() => {});
    if (api.startupFlags?.disableWebgl) {
      if (reason === "open") log("info", "[webgl] skipped: disabled by --no-webgl / STRIDETERM_DISABLE_WEBGL");
      return;
    }
    const probe = probeWebgl2();
    if (!probe.ok) {
      if (reason === "open")
        log("warn", "[webgl] skipped: pre-flight failed, using DOM renderer", { reason: probe.reason });
      return;
    }
    const loadWebgl = (): void => {
      if (!view.mount.isConnected || view.term.cols === 0 || view.term.rows === 0) return;
      if (view.webglAttached) return;
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          log("warn", `[webgl] context lost (${reason}); disposing addon, will retry on next reattach`);
          webglAddon.dispose();
          view.webglAttached = false;
        });
        view.term.loadAddon(webglAddon);
        view.webglAttached = true;
        log("info", `[webgl] renderer enabled (${reason})`, { probe: probe.reason });
      } catch (err) {
        log("error", "[webgl] addon load threw; falling back to DOM renderer", {
          error: (err as Error)?.message || String(err),
        });
      }
    };
    // Wait for fonts on first open (WebglAddon caches glyph dimensions
    // at load time, so it has to see real font metrics). Reattach already
    // has the fonts ready and the term sized — but the same gated path is
    // safe and keeps the diff narrow.
    const ready = document.fonts?.ready ?? Promise.resolve();
    ready.then(() => window.setTimeout(loadWebgl, 50)).catch(() => {});
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
      tryAttachWebglAddon(view, "open");
    } else {
      // Re-attach after a workspace switch. The pane was removed from the
      // DOM (PaneStage v-for drops inactive articles) and is now back —
      // re-fit the terminal to the (possibly new) size, retry the WebGL
      // addon if the GL context was lost while we were away, and force a
      // redraw so any DOM-rendered terminal that didn't paint while
      // detached fills the canvas. Without the refresh, macOS terminals
      // sometimes come back as a black square until the user types or
      // resizes the window.
      scheduleDeferredTerminalFits(sessionId);
      tryAttachWebglAddon(view, "reattach");
      try {
        view.term.refresh(0, Math.max(0, view.term.rows - 1));
      } catch {
        // refresh throws if the renderer is in a transient bad state; the
        // resize that follows will paint the canvas anyway, so swallow.
      }
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
    syncFontSize,
    syncTheme() {
      const theme = resolveTerminalTheme(appConfig);
      for (const view of views.value.values()) {
        view.term.options.theme = theme;
      }
    },
  };
}

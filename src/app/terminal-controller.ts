import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
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
  searchAddon: SearchAddon;
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
  /** Live `WebglAddon` instance, or null on the DOM fallback. */
  webglAddon: WebglAddon | null;
  webglAttachPending: boolean;
  webglContextLosses: number;
  webglRetryTimer: number | null;
}

type LogLevel = "info" | "warn" | "error" | "debug";

const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("mac");
const OSC52_MAX_ENCODED_CHARS = 4 * 1024 * 1024;
const WEBGL_CONTEXT_LOSS_RETRY_MS = 1_000;
const WEBGL_CONTEXT_LOSS_RETRIES = 1;

function decodeOsc52Clipboard(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator < 0) return null;
  const encoded = data.slice(separator + 1);
  if (encoded === "?" || encoded.length > OSC52_MAX_ENCODED_CHARS) return null;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

interface TerminalControllerApi {
  resizeTerminal: (sessionId: string, size: { cols: number; rows: number }) => void;
  writeTerminal: (sessionId: string, data: string) => void;
  getTerminalReplay?: (sessionId: string) => Promise<{ data: string }>;
  /** Optional — desktop only. Path link clicks are no-ops in remote mode. */
  openTerminalPath?: (request: { path: string; workspaceCwd?: string; line?: number; column?: number }) => Promise<{
    ok: boolean;
    absPath?: string;
    error?: string;
    internal?: boolean;
    line?: number;
    column?: number;
  }>;
  /** Optional — desktop only. Resolves an image-in-clipboard paste to a file path. */
  pasteClipboardImageForTerminal?: () => Promise<
    { ok: true; path: string; source?: string } | { ok: false; reason?: string }
  >;
  isRemote?: boolean;
  startupFlags?: {
    disableWebgl?: boolean;
  };
  logRenderer?: (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;
  updateSettings?: (settings: Record<string, unknown>) => void;
  /** Fired when the user presses Ctrl/Cmd+F while a terminal is focused — the
   * renderer is expected to surface the per-pane search overlay. */
  onSearchRequested?: (sessionId: string) => void;
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
  onOverscrollRefresh,
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
  /** Called when the user does a long swipe past the bottom of the terminal
   * scroll buffer — i.e. they tried to scroll further toward newer content
   * but there's nothing more. Acts as a manual pull-up-to-refresh gesture
   * on mobile remote clients. Optional — desktop and tests don't wire it. */
  onOverscrollRefresh?: () => void;
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

  const sessionsWithRendererData = new Set<string>();
  // Per-session `throughSeq` from the most recent remote replay. A live
  // terminal:data frame whose seq <= this is a defensive duplicate (already
  // covered by the replay snapshot) and is dropped. Only ever set on the remote
  // transport; on Electron no replay arrives so the guard never engages.
  const throughSeqBySession = new Map<string, number>();

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

  function cancelWebglRetry(view: TerminalView): void {
    if (view.webglRetryTimer === null) return;
    window.clearTimeout(view.webglRetryTimer);
    view.webglRetryTimer = null;
  }

  function disposeWebglAddon(view: TerminalView, addon: WebglAddon): void {
    if (view.webglAddon === addon) {
      view.webglAddon = null;
      view.webglAttached = false;
    }
    try {
      addon.dispose();
    } catch (err) {
      api.logRenderer?.("warn", "[webgl] addon dispose failed", {
        error: (err as Error)?.message || String(err),
      });
    }
  }

  function pruneTerminalViews(validSessionIds: Set<string>): void {
    for (const [sessionId, view] of views.value.entries()) {
      if (validSessionIds.has(sessionId)) {
        continue;
      }

      window.cancelAnimationFrame(view.resizeFrame || 0);
      view.resizeObserver?.disconnect();
      cancelWebglRetry(view);
      // Dispose the WebGL addon explicitly, before term.dispose(), so the GL
      // context/canvas tears down in a controlled order. Disposing it implicitly
      // via term.dispose() during rapid workspace deletion is what historically
      // tripped a native GPU-driver access violation on Windows.
      if (view.webglAddon) {
        disposeWebglAddon(view, view.webglAddon);
      }
      view.term.dispose();
      view.mount.remove();
      views.value.delete(sessionId);
      buffers.value.delete(sessionId);
      sessionsWithRendererData.delete(sessionId);
      throughSeqBySession.delete(sessionId);
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

      // FitAddon already repaints when cols/rows change. A forced resize is
      // also used after attach and mobile viewport transitions where fit() can
      // be a no-op, so only that recovery path needs an explicit full redraw.
      if (force) {
        view.term.refresh(0, Math.max(0, view.term.rows - 1));
      }
      view.lastSizeKey = nextSizeKey;
      api.resizeTerminal(sessionId, { cols: view.term.cols, rows: view.term.rows });
    });
  }

  // Force xterm to re-measure its character cell size. On a terminal's first
  // open() the webfont ("JetBrainsMono NFM", declared font-display: swap in
  // base.css) may not have loaded yet, so xterm's CharSizeService measured the
  // *fallback* font's metrics and laid the buffer out on them — glyphs overlap
  // and rows misalign. Neither fit() nor refresh() re-measures the cell; only a
  // change to a font option does (which is exactly why a manual font-size tweak,
  // or a fresh open() on a tab switch, repaints correctly). Nudge fontSize off
  // by one and back to trigger the re-measure with the now-loaded font — both
  // writes land before the next render, so there's no visible size change.
  function forceCharRemeasure(view: TerminalView): void {
    const size = view.term.options.fontSize ?? 13;
    view.term.options.fontSize = size >= 32 ? size - 1 : size + 1;
    view.term.options.fontSize = size;
  }

  function loadTerminalFont(view: TerminalView): Promise<unknown> {
    const fontSize = Number(view.term.options.fontSize) || 13;
    const fontFamily = String(view.term.options.fontFamily || '"JetBrainsMono NFM"');
    try {
      return document.fonts?.load ? document.fonts.load(`${fontSize}px ${fontFamily}`) : Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function scheduleDeferredTerminalFits(sessionId: string): void {
    window.requestAnimationFrame(() => {
      scheduleSessionResize(sessionId, { force: true });
    });
    window.setTimeout(() => {
      scheduleSessionResize(sessionId, { force: true });
    }, 120);

    // Wait for the real terminal font to load, then re-measure + refit so the
    // buffer is laid out on the correct glyph geometry. We explicitly load the
    // font rather than await document.fonts.ready: `ready` can already be
    // resolved from page boot before open() has even triggered this font's
    // load, in which case the callback would run against the still-unloaded
    // fallback and the garble would persist. `.load()` resolves only once the
    // matching FontFace is actually available.
    const initialView = views.value.get(sessionId);
    const fontLoad = initialView ? loadTerminalFont(initialView).catch(() => []) : Promise.resolve([]);
    void fontLoad.then(() => {
      const view = views.value.get(sessionId);
      if (!view) return;
      forceCharRemeasure(view);
      scheduleSessionResize(sessionId, { force: true });
    });
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
      macOptionClickForcesSelection: true,
      // SearchAddon (and its decoration manager) reads/writes APIs xterm.js
      // still marks as "proposed" in v6; the addon throws on findNext until
      // this flag is set. No actual proposed APIs are used in this file
      // directly — the flag is only here for the addon's benefit.
      allowProposedApi: true,
      ...(windowsPty ? { windowsPty } : {}),
      linkHandler: {
        activate: openTerminalLink,
        allowNonHttpProtocols: false,
      },
      theme: resolveTerminalTheme(appConfig),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    term.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52Clipboard(data);
      if (text === null) return true;
      const writeText = navigator.clipboard?.writeText;
      if (!writeText) return true;
      void writeText.call(navigator.clipboard, text).catch((err: unknown) => {
        api.logRenderer?.("warn", "[terminal-clipboard] OSC 52 write failed", {
          error: (err as Error)?.message || String(err),
        });
      });
      return true;
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon(openTerminalLink);
    // Per-pane search. Each TerminalView owns one SearchAddon — the overlay
    // component (TerminalSearchOverlay.vue) drives findNext/findPrevious and
    // subscribes to onDidChangeResults for the match-count display. Decoration
    // colors pick up the xterm theme automatically; we don't override them.
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);
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
      // Shared error toast for both path-link providers below (file-path and
      // file:// URL) — each has a "backend responded but couldn't open it"
      // and a "the IPC call itself rejected" site, so 4 near-identical blocks
      // collapse to this one helper (mirrors reportImagePasteError's shape).
      async function reportOpenPathError(path: string, message: string): Promise<void> {
        const [{ useNotificationStore }, { useAppStore }] = await Promise.all([
          import("../stores/notifications.js"),
          import("../stores/app.js"),
        ]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const profileId = ((useAppStore() as any).activeProfile?.id as string) || "default";
        useNotificationStore().showError("Open path failed", `Couldn't open ${path}: ${message}`, { profileId });
      }
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
                    void reportOpenPathError(m.path, result?.error || "unknown error");
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
                .catch((err: unknown) => {
                  void reportOpenPathError(m.path, (err as Error)?.message || String(err));
                });
            },
          }));
          callback(links);
        },
      });

      // file:// URL link provider. WebLinksAddon (above) only matches
      // http(s); `shell:open-external` in the main process also rejects
      // file:// for security. We get clickability without that risk by
      // routing through the same terminal:open-path IPC the path
      // provider uses — it resolves + stats the path and respects the
      // user's externalPathOpener setting. Triggered when tools (Claude
      // Code, build scripts, …) print `file:///…` URLs into the
      // terminal — without this they'd just sit there as plain text.
      //
      // Trailing punctuation is stripped after the match so a path that
      // ends a sentence ("…ale-report.html.") doesn't carry the period
      // into the file lookup.
      const FILE_URL_RE = /file:\/\/[^\s<>"`'(){}[\]]+/gi;
      const FILE_URL_TRAILING_PUNCT_RE = /[.,;:!?'"]+$/;
      term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const buffer = term.buffer.active;
          const line = buffer.getLine(bufferLineNumber - 1);
          const text = line ? line.translateToString(true) : "";
          if (!text || !text.includes("file://")) {
            callback(undefined);
            return;
          }
          const workspaceCwd = resolveWorkspaceCwdForSession(sessionId, getPayload());
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const links: any[] = [];
          FILE_URL_RE.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = FILE_URL_RE.exec(text)) !== null) {
            let raw = match[0];
            const trailing = FILE_URL_TRAILING_PUNCT_RE.exec(raw);
            if (trailing) raw = raw.slice(0, raw.length - trailing[0].length);
            if (raw.length <= "file://".length) continue;
            let resolvedPath = "";
            try {
              const url = new URL(raw);
              if (url.protocol !== "file:") continue;
              // file:///C:/foo → pathname "/C:/foo"; strip the leading slash
              // on Windows-style absolute paths so path.resolve in the
              // backend gets the conventional "C:/foo" form.
              let pathname = decodeURIComponent(url.pathname || "");
              if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
              resolvedPath = pathname;
            } catch {
              continue;
            }
            if (!resolvedPath) continue;
            const matchStart = match.index;
            links.push({
              range: {
                start: { x: matchStart + 1, y: bufferLineNumber },
                end: { x: matchStart + raw.length, y: bufferLineNumber },
              },
              text: raw,
              activate: () => {
                void openPath({ path: resolvedPath, workspaceCwd })
                  .then(async (result) => {
                    if (!result?.ok) {
                      void reportOpenPathError(resolvedPath, result?.error || "unknown error");
                      return;
                    }
                    if (result.internal === true && result.absPath) {
                      await openInInternalViewer(result.absPath);
                    }
                  })
                  .catch((err: unknown) => {
                    void reportOpenPathError(resolvedPath, (err as Error)?.message || String(err));
                  });
              },
            });
          }
          callback(links.length ? links : undefined);
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
      // Ctrl+F (Windows/Linux) or Cmd+F (macOS) — open the per-pane search
      // overlay. We intercept here so the keystroke never reaches the shell
      // (which would otherwise see Ctrl+F as forward-char in readline, etc.).
      // Mac requires Cmd without Ctrl; Win/Linux requires Ctrl without Meta —
      // matches the platform-native shortcut convention.
      if (!event.altKey && !event.shiftKey && event.key.toLowerCase() === "f" && event.type === "keydown") {
        const findMod = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
        if (findMod) {
          api.onSearchRequested?.(sessionId);
          return false;
        }
      }
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
    // Image-aware paste shared between Ctrl/Cmd+V, Shift+Insert, and
    // right-click. When the clipboard holds a screenshot (or a file
    // path pointing at an image), xterm's text-only paste does nothing
    // and the user sees the keystroke vanish. The backend resolves the
    // clipboard to a path (existing file or freshly saved PNG) so a
    // CLI like Claude Code / Codex can read it off disk. Returns true
    // when an image was handled — callers fall back to plain text
    // paste otherwise. Desktop only; remote clients can't see the
    // host's filesystem.
    const pasteImage = api.pasteClipboardImageForTerminal;
    const canPasteImage = !api.isRemote && typeof pasteImage === "function";
    // Read the master switch live each time — the user can toggle it
    // in Settings without restarting, and the renderer's settings
    // payload is updated as soon as `settings:update` round-trips. We
    // default true so an unmigrated state file (pre-feature) doesn't
    // surprise the user by silently dropping image paste.
    function isImagePasteEnabled(): boolean {
      const s = getPayload()?.appState?.settings as Record<string, unknown> | undefined;
      return s?.clipboardImagePasteEnabled !== false;
    }
    async function reportImagePasteError(body: string): Promise<void> {
      try {
        const [{ useNotificationStore }, { useAppStore }] = await Promise.all([
          import("../stores/notifications.js"),
          import("../stores/app.js"),
        ]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const profileId = ((useAppStore() as any).activeProfile?.id as string) || "default";
        useNotificationStore().showError("Paste image failed", body, { profileId });
      } catch {
        // Notification store init failed — at this point we already
        // logged via api.logRenderer, so swallow to avoid recursing.
      }
    }
    async function tryImagePasteToTerminal(): Promise<boolean> {
      if (!canPasteImage || !pasteImage) return false;
      if (!isImagePasteEnabled()) return false;
      let result: Awaited<ReturnType<typeof pasteImage>>;
      try {
        result = await pasteImage();
      } catch (err) {
        const msg = (err as Error)?.message || String(err);
        api.logRenderer?.("error", "[clipboard-paste] IPC threw", { error: msg });
        void reportImagePasteError(`Couldn't paste image into terminal: ${msg}`);
        return false;
      }
      if (!result?.ok) {
        const reason = "reason" in result ? result.reason : undefined;
        // "no-image" is the expected path for right-click on a
        // text-only clipboard — stay silent so the caller can fall
        // back to text paste. Any other reason means the backend
        // actually tried to save and failed (mkdir / write); surface
        // it so the keystroke doesn't vanish without a trace.
        if (reason && reason !== "no-image") {
          api.logRenderer?.("error", "[clipboard-paste] backend reported error", { reason });
          void reportImagePasteError(
            `Couldn't save screenshot to the clipboard-image folder: ${reason}. ` +
              `Check Settings → General → Clipboard image paste folder.`,
          );
        }
        return false;
      }
      // Quote the path so spaces survive; double quotes inside a
      // path are illegal on Windows and rare elsewhere, but escape
      // them defensively.
      const quoted = `"${result.path.replace(/"/g, '\\"')}"`;
      api.writeTerminal(sessionId, quoted);
      return true;
    }

    // strIDEterm owns right-click as copy/paste. Keep xterm from also reporting
    // the same button press to mouse-aware TUIs before `contextmenu` fires.
    mount.addEventListener(
      "mousedown",
      (event) => {
        if (event.button === 2) event.stopPropagation();
      },
      { capture: true },
    );
    // Right-click: copy selection, paste image if present, else paste text (PuTTY-style)
    mount.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return;
      }
      void tryImagePasteToTerminal().then((handled) => {
        if (handled) return;
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch((err: unknown) => {
            api.logRenderer?.("warn", "[terminal-clipboard] right-click paste failed", {
              error: (err as Error)?.message || String(err),
            });
          });
      });
    });
    // Copy-on-select: a constantly repainting TUI (Claude Code's spinner and
    // status line, fzf, vim, …) makes xterm clear the visual selection on its
    // next redraw — usually before the user can press Ctrl+C — so a classic
    // select-then-copy flow silently loses the text. We capture the selection
    // the instant it forms and push it to the clipboard, so the copy survives
    // the repaint that wipes the highlight. The Ctrl+C / right-click handlers
    // above still work for the cases where the selection is stable, and Ctrl+C
    // with no live selection keeps sending SIGINT (correct: the copy already
    // happened here at selection time).
    //
    // The 50 ms trailing debounce coalesces the rapid onSelectionChange burst
    // during a drag into a single write of the final selection, and stays well
    // inside Chromium's ~5 s transient-activation window from the mouse gesture
    // so navigator.clipboard.writeText is also permitted on the remote web
    // client. Empty changes (the repaint's own clear) are ignored so they never
    // overwrite the clipboard or cancel a pending write.
    let copyOnSelectTimer: number | null = null;
    term.onSelectionChange(() => {
      const text = term.getSelection();
      if (!text) return;
      if (copyOnSelectTimer !== null) window.clearTimeout(copyOnSelectTimer);
      copyOnSelectTimer = window.setTimeout(() => {
        copyOnSelectTimer = null;
        navigator.clipboard.writeText(text).catch(() => {});
      }, 50);
    });
    // Keyboard paste (Ctrl/Cmd+V, Shift+Insert): the browser fires a
    // `paste` event on the focused xterm helper textarea. We intercept
    // during capture phase on `mount` so the inner xterm listener
    // never runs when we're handling an image — `stopImmediatePropagation`
    // keeps xterm from inserting the (empty) text payload.
    if (canPasteImage) {
      mount.addEventListener(
        "paste",
        (event) => {
          if (!isImagePasteEnabled()) return;
          const cd = event.clipboardData;
          if (!cd) return;
          let hasImage = false;
          for (let i = 0; i < cd.items.length; i += 1) {
            if (cd.items[i].type.startsWith("image/")) {
              hasImage = true;
              break;
            }
          }
          if (!hasImage) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          void tryImagePasteToTerminal();
        },
        { capture: true },
      );
    }
    // Ctrl/Cmd + wheel → zoom in/out; no modifier → let xterm scroll normally.
    //
    // We register a capture-phase listener on the mount in addition to xterm's
    // own `attachCustomWheelEventHandler`. The capture-phase listener fires
    // before any handler attached to inner xterm elements (viewport, screen,
    // canvas), and `stopImmediatePropagation()` keeps them from running at
    // all. Without this, Ctrl+wheel up could still hit xterm's scrollback path
    // and move through history while we were also zooming — the user-visible
    // "sometimes scrolls, sometimes zooms" flicker.
    mount.addEventListener(
      "wheel",
      (e) => {
        const zoomMod = IS_MAC ? e.ctrlKey || e.metaKey : e.ctrlKey;
        if (!zoomMod) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const cur = (term.options.fontSize ?? 13) as number;
        applyFontSize(cur + (e.deltaY < 0 ? 1 : -1));
      },
      { capture: true, passive: false },
    );
    term.attachCustomWheelEventHandler((e) => {
      const zoomMod = IS_MAC ? e.ctrlKey || e.metaKey : e.ctrlKey;
      return !zoomMod;
    });

    // Touch scroll (1 finger) + pinch zoom (2 fingers).
    // touchstart calls preventDefault() to take ownership of all touch
    // behaviour; that also suppresses the browser's tap-to-focus logic, so
    // we detect "tap" ourselves (single touch that moved < 10 px) and call
    // term.focus() manually to bring up the mobile keyboard.
    const touch = {
      mode: "none" as "none" | "scroll" | "pinch",
      lastY: 0,
      startY: 0,
      startX: 0,
      scrollAccum: 0,
      startDist: 0,
      startFont: 0,
      // Pull-up-to-refresh: when the user keeps swiping toward newer
      // content but viewportY can't go any further (already at bottom of
      // buffer), we accumulate the wasted pixels here. If the total
      // crosses OVERSCROLL_REFRESH_PX before touchend, we treat the
      // gesture as "refresh now" and call onOverscrollRefresh.
      overscrollAccum: 0,
    };
    // Distance threshold for the refresh gesture. ~100 px is large enough
    // that an accidental tail of a normal scroll won't trigger it but small
    // enough to be a comfortable single swipe on a phone.
    const OVERSCROLL_REFRESH_PX = 100;

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
          touch.startY = e.touches[0].clientY;
          touch.startX = e.touches[0].clientX;
          touch.scrollAccum = 0;
          touch.overscrollAccum = 0;
        } else if (e.touches.length === 2) {
          const dist = getTouchDist(e);
          if (dist < 40) {
            touch.mode = "scroll";
            touch.lastY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            touch.startY = touch.lastY;
            touch.startX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            touch.scrollAccum = 0;
            touch.overscrollAccum = 0;
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
              const oldViewportY = term.buffer.active.viewportY;
              term.scrollLines(dir * lines);
              const newViewportY = term.buffer.active.viewportY;
              // Pull-up-to-refresh detection. When the user keeps swiping
              // toward newer content (dir > 0 = swipe up in our inverted
              // touch model) but xterm refused to advance — i.e. we're
              // already pegged at buffer.baseY — count the unspent travel.
              // Reset on any successful scroll or any swipe in the opposite
              // direction, so a normal scroll back-and-forth never triggers
              // refresh by accident.
              if (dir > 0 && oldViewportY === newViewportY) {
                touch.overscrollAccum += lines * lineHeight;
              } else {
                touch.overscrollAccum = 0;
              }
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

    mount.addEventListener(
      "touchend",
      (e) => {
        // Pull-up-to-refresh: if the user travelled past the bottom of the
        // scroll buffer by more than the threshold during this gesture,
        // fire the refresh callback instead of (and before) any other
        // touchend interpretation.
        if (touch.overscrollAccum >= OVERSCROLL_REFRESH_PX && onOverscrollRefresh) {
          touch.overscrollAccum = 0;
          touch.mode = "none";
          onOverscrollRefresh();
          return;
        }
        if (touch.mode === "scroll" && e.changedTouches.length === 1) {
          const dx = Math.abs(e.changedTouches[0].clientX - touch.startX);
          const dy = Math.abs(e.changedTouches[0].clientY - touch.startY);
          if (dx < 10 && dy < 10) {
            // Tap: focus the terminal so the mobile keyboard reappears.
            term.focus();
          }
        }
        touch.mode = "none";
      },
      { passive: true },
    );
    mount.addEventListener(
      "touchcancel",
      () => {
        touch.mode = "none";
      },
      { passive: true },
    );

    term.onData((data) => api.writeTerminal(sessionId, data));
    views.value.set(sessionId, {
      mount,
      term,
      fitAddon,
      searchAddon,
      lastSizeKey: null,
      resizeFrame: null,
      resizeObserver: null,
      opened: false,
      webglAttached: false,
      webglAddon: null,
      webglAttachPending: false,
      webglContextLosses: 0,
      webglRetryTimer: null,
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

  function tryAttachWebglAddon(view: TerminalView, reason: "open" | "reattach" | "context-loss-retry"): void {
    if (view.webglAttached || view.webglAttachPending) return;
    if (api.isRemote) return;
    const log = api.logRenderer ?? (() => {});
    if (api.startupFlags?.disableWebgl) {
      if (reason === "open") log("info", "[webgl] skipped: disabled by --no-webgl / STRIDETERM_DISABLE_WEBGL");
      return;
    }
    const sessionId = view.mount.dataset.sessionId || "";
    const loadWebgl = (): void => {
      view.webglAttachPending = false;
      if (views.value.get(sessionId) !== view) return;
      if (!view.mount.isConnected) return;
      let webglAddon: WebglAddon | null = null;
      try {
        const proposed = view.fitAddon.proposeDimensions();
        if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) return;
        view.fitAddon.fit();
        if (view.webglAttached) return;
        const addon = new WebglAddon();
        webglAddon = addon;
        addon.onContextLoss(() => {
          if (view.webglAddon !== addon) return;
          view.webglContextLosses += 1;
          disposeWebglAddon(view, addon);
          if (
            view.webglContextLosses <= WEBGL_CONTEXT_LOSS_RETRIES &&
            views.value.get(sessionId) === view &&
            view.mount.isConnected
          ) {
            log("warn", "[webgl] context lost; using DOM renderer and scheduling one retry", {
              sessionId,
              attempt: view.webglContextLosses,
            });
            cancelWebglRetry(view);
            view.webglRetryTimer = window.setTimeout(() => {
              view.webglRetryTimer = null;
              tryAttachWebglAddon(view, "context-loss-retry");
            }, WEBGL_CONTEXT_LOSS_RETRY_MS);
            return;
          }
          log("warn", "[webgl] context lost; using DOM renderer until the pane is reattached", {
            sessionId,
            losses: view.webglContextLosses,
          });
        });
        view.term.loadAddon(addon);
        view.webglAttached = true;
        view.webglAddon = addon;
        log("info", `[webgl] renderer enabled (${reason})`);
      } catch (err) {
        if (webglAddon) disposeWebglAddon(view, webglAddon);
        log("warn", "[webgl] unavailable; using DOM renderer", {
          error: (err as Error)?.message || String(err),
        });
      }
    };

    view.webglAttachPending = true;
    void loadTerminalFont(view)
      .catch((err: unknown) => {
        log("warn", "[webgl] terminal font load failed; trying renderer with current metrics", {
          error: (err as Error)?.message || String(err),
        });
      })
      .then(loadWebgl);
  }

  function attachTerminalPane(sessionId: string, paneBody: Element): TerminalView {
    const view = ensureTerminal(sessionId);
    for (const [otherSessionId, otherView] of views.value.entries()) {
      if (otherSessionId === sessionId || otherView.mount.parentElement !== paneBody) {
        continue;
      }
      detachTerminalPane(otherSessionId, paneBody);
    }
    paneBody.append(view.mount);
    if (!view.opened) {
      view.term.open(view.mount);
      view.opened = true;
      const queued = buffers.value.get(sessionId);
      if (queued) {
        view.term.write(queued);
        buffers.value.delete(sessionId);
        sessionsWithRendererData.add(sessionId);
      } else if (!api.isRemote && api.getTerminalReplay && !sessionsWithRendererData.has(sessionId)) {
        // Electron only: pull replay over IPC to repaint a re-created view. On
        // the remote transport the server pushes terminal:replay on subscribe
        // (see handleTerminalReplay), so we must not also race an HTTP fetch.
        const expectedView = view;
        void api
          .getTerminalReplay(sessionId)
          .then((replay) => {
            if (sessionsWithRendererData.has(sessionId)) return;
            if (views.value.get(sessionId) !== expectedView || !expectedView.opened) return;
            const data = replay?.data || "";
            if (!data) return;
            expectedView.term.write(data);
            sessionsWithRendererData.add(sessionId);
          })
          .catch((err: unknown) => {
            api.logRenderer?.("warn", "[terminal] replay load failed", {
              sessionId,
              error: (err as Error)?.message || String(err),
            });
          });
      }
      scheduleDeferredTerminalFits(sessionId);
      // Switch to the GPU renderer for smooth scrolling under heavy TUI traffic
      // (e.g. Claude Code) on the desktop. We skip it on remote clients (web,
      // mobile) because mobile WebGL is unreliable and we can't validate the
      // result. On the desktop we explicitly load the configured font before
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

  function detachTerminalPane(sessionId: string, paneBody?: Element | null): void {
    const view = views.value.get(sessionId);
    if (!view) {
      return;
    }
    if (paneBody && view.mount.parentElement !== paneBody) {
      return;
    }
    window.cancelAnimationFrame(view.resizeFrame || 0);
    view.resizeFrame = null;
    cancelWebglRetry(view);
    view.resizeObserver?.disconnect();
    view.resizeObserver = null;
    view.mount.remove();
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

  // Text currently visible in the terminal viewport — i.e. exactly what's on
  // screen right now, trailing blank lines trimmed. Used by the remote/mobile
  // "copy screen" control: selecting text by hand is painful on touch, and the
  // visible screen is almost always the agent's latest answer. Reads xterm's
  // live buffer client-side (the remote web client runs its own xterm), so it
  // works on both transports.
  function getVisibleTerminalText(sessionId: string): string {
    const view = views.value.get(sessionId);
    const term = view?.term;
    const buffer = term?.buffer?.active;
    if (!term || !buffer) {
      return "";
    }
    const top = buffer.viewportY;
    const lines: string[] = [];
    for (let row = 0; row < term.rows; row += 1) {
      const line = buffer.getLine(top + row);
      lines.push(line ? line.translateToString(true) : "");
    }
    return lines.join("\n").replace(/\s+$/, "");
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

  // Krok 4: cap the per-session renderer queue for views that aren't open yet.
  // Backend replay is already capped at session.replayMaxChars; this buffer was
  // not, so a session a client never opens (e.g. 4 of 5 running agents) grew
  // without bound — a slow memory leak. Trim from the left to the same limit, so
  // an eventual attach flushes only the most recent scrollback (exactly like the
  // capped backend replay). Open/active terminals are untouched.
  const bufferMaxChars = Math.max(0, appConfig.session?.replayMaxChars ?? 0);
  function appendToSessionBuffer(sessionId: string, chunk: string): void {
    const next = `${buffers.value.get(sessionId) || ""}${chunk}`;
    buffers.value.set(
      sessionId,
      bufferMaxChars && next.length > bufferMaxChars ? next.slice(next.length - bufferMaxChars) : next,
    );
  }

  function handleTerminalData({ sessionId, data, seq }: { sessionId: string; data: string; seq?: number }): void {
    // Defensive duplicate guard: a live frame at or below the last replay's
    // throughSeq is already contained in the replay we wrote, so drop it.
    const through = throughSeqBySession.get(sessionId);
    if (typeof seq === "number" && typeof through === "number" && seq <= through) {
      return;
    }
    sessionsWithRendererData.add(sessionId);
    const view = views.value.get(sessionId);
    if (!view || !view.opened) {
      appendToSessionBuffer(sessionId, data);
      return;
    }
    view.term.write(data);
  }

  function handleTerminalReplay({
    sessionId,
    data,
    throughSeq,
  }: {
    sessionId: string;
    data?: string;
    throughSeq?: number;
  }): void {
    // Server-pushed on (re)subscribe. This is the ordered reset point for a
    // remote session: record throughSeq, then reset + rewrite so the replay is
    // the authoritative starting screen and later live frames append cleanly.
    if (typeof throughSeq === "number") throughSeqBySession.set(sessionId, throughSeq);
    const payload = data || "";
    const view = views.value.get(sessionId);
    if (view?.opened) {
      view.term.reset();
      if (payload) view.term.write(payload);
      sessionsWithRendererData.add(sessionId);
    } else {
      // Pane not opened yet — stage the replay as the pending buffer so attach
      // writes it onto the fresh terminal (replacing any queued live data).
      if (payload) {
        buffers.value.set(sessionId, payload);
      } else {
        buffers.value.delete(sessionId);
      }
      sessionsWithRendererData.delete(sessionId);
    }
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
      appendToSessionBuffer(sessionId, line);
    }
  }

  function getSearchAddon(sessionId: string): SearchAddon | null {
    return views.value.get(sessionId)?.searchAddon ?? null;
  }

  return {
    attachTerminalPane,
    clearTerminalViewport,
    detachTerminalPane,
    disconnectHiddenPaneObservers,
    ensureTerminal,
    exportTerminalTranscript,
    focusActiveTerminal,
    getSearchAddon,
    getVisibleTerminalText,
    handleTerminalData,
    handleTerminalReplay,
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

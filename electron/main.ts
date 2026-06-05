import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, safeStorage, Menu, screen } from "electron";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createRuntime } from "./backend/runtime.js";
import { registerIpc } from "./backend/ipc.js";
import { startRemoteServer } from "./backend/remote-server.js";
import { parseReviewBridgeMcpArgs, runReviewBridgeMcpServer } from "./backend/review-bridge-mcp.js";
import { createDefaultState, normalizeState, MIGRATION_WINDOW_SLOT_ID } from "./backend/default-state.js";
import { summarizeAttentionForProfile } from "./backend/runtime-utils.js";
import { inheritShellPath } from "./backend/fix-path.js";
import { startFreezeWatchdog } from "./backend/freeze-watchdog.js";
import { APP_CONFIG, getRendererDevUrl } from "../config/app-config.js";
import { getLogger, setLogDir, shutdownLogger } from "./backend/logger.js";
import type { WindowSlot, WorkspaceState } from "./shared/types/state.js";
import type { TaskExecutionState } from "./shared/types/task.js";

// --- Custom data directory (--data-dir <path> or STRIDETERM_DATA_DIR env) ---
function resolveDataDir(): string {
  const args = process.argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data-dir" && args[i + 1]) return path.resolve(args[i + 1]);
    if (args[i].startsWith("--data-dir=")) return path.resolve(args[i].slice("--data-dir=".length));
  }
  return process.env.STRIDETERM_DATA_DIR ? path.resolve(process.env.STRIDETERM_DATA_DIR) : "";
}

// --- WebGL terminal renderer opt-out (--no-webgl or STRIDETERM_DISABLE_WEBGL) ---
// CLI flag wins over env var; the renderer reads the resolved value through
// the preload bridge so a user can disable WebGL without rebuilding when
// their device's WebGL2 stack is broken (some older Macs, certain Intel iGPUs).
function resolveWebglDisabled(): boolean {
  if (process.argv.slice(1).some((arg) => arg === "--no-webgl")) {
    return true;
  }
  return APP_CONFIG.terminal.disableWebgl;
}

const customDataDir = resolveDataDir();
const userDataPath = customDataDir || path.join(os.homedir(), ".strideterm");
const webglDisabled = resolveWebglDisabled();

// Expose the resolved data dir via env so modules that read it lazily
// (DEFAULT_REVIEW_ROOT getters, strideDataDir() helper in default-state.js,
// runtime fallbacks) see the same path — including when the user passed
// --data-dir on the CLI rather than setting the env var manually.
if (customDataDir) {
  process.env.STRIDETERM_DATA_DIR = customDataDir;
}

// Resolve where extraResources live at runtime. In packaged apps that's
// `process.resourcesPath` (loose files next to app.asar — readable by
// external programs like bash/zsh/child processes). In dev we walk up to
// the repo root because process.resourcesPath there points to Electron's
// own resources dir, not ours.
//
// Anything passed to a shell or executed as a script (shell-integration
// rc files, plugin scripts) MUST come from this dir, not from app.asar/.
function resolveResourcesDir(): string {
  if (app.isPackaged) return process.resourcesPath;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return dir;
}
const resourcesDir = resolveResourcesDir();
process.env.STRIDETERM_RESOURCES_DIR = resourcesDir;

// When using a custom data dir, change the app name so Electron uses a
// separate single-instance lock and separate session data.
if (customDataDir) {
  const suffix = path.basename(customDataDir);
  app.name = `strideterm-${suffix}`;
  app.setPath("userData", path.join(customDataDir, "electron-data"));
  setLogDir(path.join(customDataDir, "logs"));
}

const log = getLogger("main");
// Use app.getVersion() instead of require("../package.json") to avoid
// path resolution issues after compilation to dist-electron/.
const packageVersion = app.getVersion();

// Diagnostic: trace every app.quit() / app.exit() caller. Multi-window debugging
// needs to know which code path triggers shutdown when only one of several
// windows is closed (Electron's before-quit handler runs async, so a callstack
// captured inside the handler doesn't reach the original caller — we have to
// snapshot it at the call site).
const _origQuit = app.quit.bind(app);
const _origExit = app.exit.bind(app);
app.quit = (() => {
  log.warn("app.quit() called", { stack: new Error("app.quit").stack });
  _origQuit();
}) as typeof app.quit;
app.exit = ((code?: number) => {
  log.warn("app.exit() called", { code, stack: new Error("app.exit").stack });
  _origExit(code);
}) as typeof app.exit;

// Suppress EPIPE errors that occur when the renderer disconnects during dev reload
process.on("uncaughtException", (error: NodeJS.ErrnoException) => {
  if (error?.code === "EPIPE" || error?.message?.includes("EPIPE")) {
    return;
  }
  // Don't quit on uncaughtException: a recoverable bug deep in some background
  // task (e.g. TDZ in runtime bootstrap, a stale event firing on a destroyed
  // BrowserWindow) used to shut down every window the user had open, losing
  // their work. Log loudly instead and let the user decide whether to restart.
  log.error("uncaughtException (NOT quitting)", {
    err: error?.message,
    code: error?.code,
    stack: error?.stack,
  });
  console.error("Uncaught exception (continuing):", error);
});

process.on("unhandledRejection", (reason: unknown) => {
  const err = reason as { message?: string; stack?: string; code?: string } | undefined;
  log.error("unhandledRejection", {
    err: err?.message ?? String(reason),
    code: err?.code,
    stack: err?.stack,
  });
});

const isDev = !app.isPackaged;
const rendererUrl = getRendererDevUrl();
const forceDist = process.env.STRIDETERM_FORCE_DIST === "1" || process.env.STRIDETERM_SMOKE_TEST === "1";

// --- Window registry ---
// Maps stable windowId (UUID) → BrowserWindow
const windowRegistry = new Map<string, BrowserWindow>();
// Maps webContents ID → windowId (for IPC source-window resolution)
const webContentsToWindowId = new Map<number, string>();
// Per-window focus timestamps (ms since epoch) for primary-window selection
const windowFocusedAt = new Map<string, number>();
// Per-window attention count (for flash logic)
const windowAttentionCount = new Map<string, number>();

// --- Close-confirmation flow ---
// Global gate: once the user has approved closing/quitting via the in-app
// ConfirmDialog, every subsequent close/quit path short-circuits to allow.
// Stays true for the rest of the process lifetime — there's no "undo quit."
let closeFlowConfirmed = false;
// In-flight confirmation. Coalesces concurrent close paths (last-window close
// races with Cmd+Q before-quit) onto a single dialog.
let closeFlowConfirmation: Promise<boolean> | null = null;
// Stops the freeze watchdog (heartbeat + worker thread) on shutdown.
let stopFreezeWatchdog: (() => void) | null = null;

// Set once runShutdownCleanupOnce has settled (or timed out) — the re-entrant
// before-quit then falls through and lets the quit proceed.
let shutdownCleanupComplete = false;

// Tracks the shutdown cleanup so it runs exactly once even if before-quit
// fires multiple times (it does — the second re-entry after app.quit() from
// the dialog callback would otherwise tear the runtime down twice).
let shutdownCleanupPromise: Promise<void> | null = null;
// `closingWindows` tracks windows whose `close` event has already fired in
// the current quit cascade. We need this because Electron's app.quit() loops
// over BrowserWindow.getAllWindows() calling .close() on each, and the
// `closed` cleanup (which removes from windowRegistry) is async — so a naive
// "is this the last window" check would see the still-undestroyed siblings
// and skip the dialog. Each close handler marks itself first so the genuine
// last window finds no unmarked peers.
const closingWindows = new Set<string>();
// Pending confirm-close promises keyed by windowId. The renderer's response
// IPC resolves the matching entry. Cleared on cancel, on resolve, or when
// the window vanishes (defensive — the close handler creates one only when
// it's about to await it).
const pendingCloseConfirmations = new Map<string, (confirmed: boolean) => void>();

type CloseConfirmSummary = {
  workspaceCount: number;
  runningTaskCount: number;
  runningTaskWorkspaceNames: string[];
};

// Task states that mean an agent is actively doing work and would be killed
// by a runtime shutdown. Keep in sync with TaskExecutionState — the union is
// open-ended so we enumerate the "live" states explicitly rather than
// inverting a "finished" set.
const RUNNING_TASK_STATES: ReadonlySet<TaskExecutionState> = new Set([
  "running",
  "evaluating",
  "judge-evaluating",
  "refreshing",
  "showering",
]);

function summarizeCloseRisk(): CloseConfirmSummary | null {
  const payload = runtimeState.runtime?.getPayload?.() as Record<string, unknown> | undefined;
  const appState = payload?.appState as AppState | undefined;
  const workspaces = (appState?.workspaces ?? []) as WorkspaceState[];
  const workspaceCount = workspaces.length;
  const runningTaskWorkspaceNames = workspaces
    .filter((ws) => ws.task && RUNNING_TASK_STATES.has(ws.task.state))
    .map((ws) => ws.name || ws.id);
  const runningTaskCount = runningTaskWorkspaceNames.length;
  if (workspaceCount === 0 && runningTaskCount === 0) return null;
  return { workspaceCount, runningTaskCount, runningTaskWorkspaceNames };
}

function requestConfirmClose(windowId: string, win: BrowserWindow, summary: CloseConfirmSummary): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Defensive: if a stale resolver lingers, reject it as "cancel" so we
    // never leak.
    const stale = pendingCloseConfirmations.get(windowId);
    if (stale) {
      pendingCloseConfirmations.delete(windowId);
      stale(false);
    }
    pendingCloseConfirmations.set(windowId, resolve);
    try {
      win.webContents.send("window:confirm-close-request", summary);
    } catch (err) {
      log.warn("requestConfirmClose: send failed", { windowId, err: (err as Error)?.message });
      pendingCloseConfirmations.delete(windowId);
      resolve(false);
    }
  });
}

/** Resolve windowId for a BrowserWindow by reverse-lookup in the registry. */
function findWindowId(win: BrowserWindow): string | null {
  for (const [wid, w] of windowRegistry) {
    if (w === win) return wid;
  }
  return null;
}

/**
 * Single confirmation entry point for both "close last window" and
 * "before-quit". Returns true if it's safe to proceed with shutdown
 * (either no risky state, or the user approved the dialog). Idempotent:
 * once confirmed, future calls short-circuit to true; concurrent calls
 * share the same in-flight promise.
 */
function confirmCloseFlow(): Promise<boolean> {
  if (closeFlowConfirmed) return Promise.resolve(true);
  if (closeFlowConfirmation) return closeFlowConfirmation;

  // Playwright drives `app.close()` and has no path to respond to the
  // renderer-side ConfirmDialog. Without this bypass, every e2e test
  // that closes the app hangs until the 25 min job timeout.
  if (process.env.STRIDETERM_E2E_SKIP_CLOSE_CONFIRM === "1") {
    closeFlowConfirmed = true;
    return Promise.resolve(true);
  }

  const summary = summarizeCloseRisk();
  if (!summary) {
    closeFlowConfirmed = true;
    return Promise.resolve(true);
  }
  const win = getPrimaryWindow();
  const windowId = win ? findWindowId(win) : null;
  if (!win || !windowId) {
    // No window to host the dialog. Don't deadlock the app — let it close.
    log.warn("confirmCloseFlow: no window available, allowing close", { summary });
    closeFlowConfirmed = true;
    return Promise.resolve(true);
  }

  closeFlowConfirmation = requestConfirmClose(windowId, win, summary).then((confirmed) => {
    closeFlowConfirmation = null;
    if (confirmed) closeFlowConfirmed = true;
    return confirmed;
  });
  return closeFlowConfirmation;
}

async function runShutdownCleanupOnce(): Promise<void> {
  if (shutdownCleanupPromise) return shutdownCleanupPromise;
  shutdownCleanupPromise = (async () => {
    log.info("app quitting", { quitTrigger: new Error("trigger-trace").stack });
    stopFreezeWatchdog?.();
    runtimeState.unsubscribeStateUpdated?.();
    runtimeState.unsubscribeRemoteConfig?.();
    runtimeState.disposeIpc?.();
    await runtimeState.remoteServer?.close?.();
    (await runtimeState.runtime?.stop?.()) as Promise<void>;
    await shutdownLogger();
  })();
  return shutdownCleanupPromise;
}

// --- Diff popout windows ---
// Lightweight secondary windows that just render MonacoDiffPanel for a single
// payload. Keyed by webContents.id so a reload (DevTools, accidental refresh)
// can re-fetch its init payload without us having to round-trip the parent.
interface DiffPopoutPayload {
  title?: string;
  filePath?: string;
  oldLabel?: string;
  newLabel?: string;
  language?: string;
  leftLabel?: string;
  rightLabel?: string;
  leftContent?: string;
  rightContent?: string;
  leftMissing?: boolean;
  rightMissing?: boolean;
  [key: string]: unknown;
}
const diffPopoutPayloads = new Map<number, DiffPopoutPayload>();
const diffPopoutWindows = new Set<BrowserWindow>();

/** Return the window that had focus most recently (non-minimized preferred). */
function getPrimaryWindow(): BrowserWindow | null {
  let best: BrowserWindow | null = null;
  let bestTime = -1;
  for (const [id, win] of windowRegistry) {
    if (win.isDestroyed()) continue;
    if (win.isMinimized()) continue;
    const t = windowFocusedAt.get(id) ?? 0;
    if (t > bestTime) {
      bestTime = t;
      best = win;
    }
  }
  if (!best) {
    // Fallback: first non-destroyed window
    for (const win of windowRegistry.values()) {
      if (!win.isDestroyed()) return win;
    }
  }
  return best;
}

interface RuntimeState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runtime: any;
  runtimeReady: Promise<void>;
  runtimeInteractive: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bootstrapPayload: any;
  desiredWorkspaceId: string;
  desiredSessionId: string;
  disposeIpc: (() => void) | null;
  remoteServer: { close?: () => Promise<void> } | null;
  remoteServerRestart: Promise<void>;
  unsubscribeRemoteConfig: (() => void) | null;
  unsubscribeStateUpdated: (() => void) | null;
  lastAttentionCount: number;
  /** Convenience getter – returns the last-focused non-minimized window. */
  readonly window: BrowserWindow | null;
}

const runtimeState: RuntimeState = {
  runtime: null,
  runtimeReady: Promise.resolve(),
  runtimeInteractive: false,
  bootstrapPayload: null,
  desiredWorkspaceId: "",
  desiredSessionId: "",
  disposeIpc: null,
  remoteServer: null,
  remoteServerRestart: Promise.resolve(),
  unsubscribeRemoteConfig: null,
  unsubscribeStateUpdated: null,
  lastAttentionCount: 0,
  get window() {
    return getPrimaryWindow();
  },
};

const mcpMode = parseReviewBridgeMcpArgs(process.argv.slice(1));
const gotSingleInstanceLock = !mcpMode && app.requestSingleInstanceLock();

function summarizeAttention(payload: Record<string, unknown>): { count: number; waitingCount: number } {
  const attention = payload?.attention as Record<string, unknown> | undefined;
  const byProject = (attention?.byProject || {}) as Record<string, { alerts?: Array<{ kind: string }> }>;
  const alerts = Object.values(byProject).flatMap((entry) => entry?.alerts || []);
  const count = alerts.length;
  const waitingCount = alerts.filter((alert) => alert.kind === "waiting").length;
  return { count, waitingCount };
}

function createOverlayIcon(count: number, waitingCount: number): Electron.NativeImage {
  const label = count > 9 ? "9+" : String(count);
  const fill = waitingCount > 0 ? "#ff6f8d" : "#ffb347";
  const fontSize = count > 9 ? 15 : 18;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="15" fill="${fill}" />
      <text
        x="16"
        y="21"
        text-anchor="middle"
        font-family="Segoe UI, Arial, sans-serif"
        font-size="${fontSize}"
        font-weight="700"
        fill="#09111b"
      >${label}</text>
    </svg>
  `;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function getWindowProfileId(windowId: string): string {
  const appState = runtimeState.runtime?.getPayload?.()?.appState as Record<string, unknown> | undefined;
  const windowSlots = (appState?.windowSlots as Array<{ id: string; profileId: string }> | undefined) || [];
  return windowSlots.find((s) => s.id === windowId)?.profileId || "default";
}

/** Find ALL live BrowserWindows currently showing a profile (a profile may be open in any number of windows). */
function findWindowsForProfile(profileId: string): { windowId: string; win: BrowserWindow }[] {
  const result: { windowId: string; win: BrowserWindow }[] = [];
  for (const [wid, win] of windowRegistry) {
    if (win.isDestroyed()) continue;
    if (getWindowProfileId(wid) === profileId) result.push({ windowId: wid, win });
  }
  return result;
}

/**
 * Pick the best window of a profile for a UI action:
 *  1. explicit `opts.windowId` when it's a live window of the profile;
 *  2. a window already showing `opts.workspaceId`;
 *  3. the most recently focused non-minimized window of the profile;
 *  4. any live window of the profile.
 * Returns null when the profile has no live window — callers that truly need
 * a desktop window create one via ensureWindowForProfile.
 */
function selectWindowForProfile(
  profileId: string,
  opts: { windowId?: string; workspaceId?: string } = {},
): { windowId: string; win: BrowserWindow } | null {
  const candidates = findWindowsForProfile(profileId);
  if (candidates.length === 0) return null;
  if (opts.windowId) {
    const explicit = candidates.find((c) => c.windowId === opts.windowId);
    if (explicit) return explicit;
  }
  const appState = runtimeState.runtime?.getPayload?.()?.appState as Record<string, unknown> | undefined;
  const slots =
    (appState?.windowSlots as Array<{ id: string; activeWorkspaceId?: string; lastFocusedAt?: number }> | undefined) ||
    [];
  const slotById = new Map(slots.map((s) => [s.id, s]));
  if (opts.workspaceId) {
    const visible = candidates.find((c) => slotById.get(c.windowId)?.activeWorkspaceId === opts.workspaceId);
    if (visible) return visible;
  }
  const byFocus = [...candidates].sort(
    (a, b) => (slotById.get(b.windowId)?.lastFocusedAt || 0) - (slotById.get(a.windowId)?.lastFocusedAt || 0),
  );
  return byFocus.find((c) => !c.win.isMinimized()) || byFocus[0];
}

/**
 * Ensure a desktop window exists for `profileId`. If one already does, focus
 * the best candidate (selectWindowForProfile) and return its id. Otherwise
 * create a new window slot in state, spawn a BrowserWindow for it, and wait
 * until the renderer is ready to receive IPC.
 *
 * Used by the runtime (Telegram dispatch, alert navigation) so a click on a
 * notification for a closed profile just opens the right window. Returns
 * null only when the underlying runtime isn't ready yet (very early startup).
 */
async function ensureWindowForProfile(profileId: string): Promise<string | null> {
  if (!profileId) return null;
  const existing = selectWindowForProfile(profileId);
  if (existing) {
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.focus();
    return existing.windowId;
  }
  if (!runtimeState.runtimeInteractive || !runtimeState.runtime) {
    log.warn("ensureWindowForProfile: runtime not ready", { profileId });
    return null;
  }
  let newSlot: { id?: string; profileId?: string } | null = null;
  try {
    newSlot = (await runtimeState.runtime.createWindowSlot?.(profileId)) ?? null;
  } catch (err) {
    log.error("ensureWindowForProfile: createWindowSlot threw", {
      profileId,
      err: (err as Error)?.message,
    });
  }
  const newWindowId = newSlot?.id ?? randomUUID();
  log.info("ensureWindowForProfile: spawning new window", { profileId, newWindowId });
  try {
    createWindow(newWindowId, newSlot ?? { profileId });
  } catch (err) {
    log.error("ensureWindowForProfile: createWindow threw", {
      profileId,
      newWindowId,
      err: (err as Error)?.message,
    });
    return null;
  }
  // Wait for the renderer to finish loading so the subsequent IPC actually
  // hits a live process. Without this, the first activateWorkspace / alert
  // navigation fires before the window registers its IPC listeners and the
  // event is silently dropped.
  const win = windowRegistry.get(newWindowId);
  if (win) {
    await new Promise<void>((resolve) => {
      if (!win.webContents.isLoading()) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      win.webContents.once("did-finish-load", finish);
      // Hard cap so a stuck renderer doesn't hang the Telegram dispatch.
      setTimeout(finish, 8_000);
    });
  }
  return newWindowId;
}

/**
 * Create a brand-new window for `profileId` — always a new slot, never the
 * focus-existing shortcut (that's ensureWindowForProfile's job). Shared by
 * the window:create IPC and the second-instance launch path.
 */
async function createWindowForProfile(
  profileId: string,
  options?: { cloneFromWindowId?: string },
): Promise<{ windowId?: string; error?: string }> {
  // Create the window slot in state first
  let newSlot: Awaited<ReturnType<typeof runtimeState.runtime.createWindowSlot>> | null = null;
  try {
    newSlot = (await runtimeState.runtime?.createWindowSlot?.(profileId, options)) ?? null;
  } catch (err) {
    log.error("createWindowForProfile: createWindowSlot threw", {
      profileId,
      err: (err as Error)?.message,
      stack: (err as Error)?.stack,
    });
  }
  const newWindowId = newSlot?.id ?? randomUUID();
  log.info("createWindowForProfile: invoking createWindow", { newWindowId, profileId, hasSlot: !!newSlot });
  try {
    createWindow(newWindowId, newSlot ?? { profileId });
  } catch (err) {
    log.error("createWindowForProfile: createWindow threw", {
      newWindowId,
      err: (err as Error)?.message,
      stack: (err as Error)?.stack,
    });
    return { error: `Failed to create window: ${(err as Error)?.message ?? "unknown"}` };
  }
  return { windowId: newWindowId };
}

function updateNativeAttention(payload: Record<string, unknown> | null | undefined): void {
  if (!payload) return;
  const { count, waitingCount } = summarizeAttention(payload);
  const appState = payload.appState as Record<string, unknown> | undefined;
  const profiles = (appState?.profiles as Array<{ id: string; name: string }> | undefined) || [];
  const dataDirSuffix = customDataDir ? ` (${path.basename(customDataDir)})` : "";

  // Global badge count = sum across all windows
  if (app.setBadgeCount) {
    app.setBadgeCount(count);
  }

  // Per-window title + overlay icon + flash (§4.2: route to every window
  // whose profile owns the alert — a profile may be open in several windows,
  // and each of them gets the same badge/flash).
  for (const [windowId, win] of windowRegistry) {
    if (win.isDestroyed()) continue;
    const profileId = getWindowProfileId(windowId);
    const activeProfile = profiles.find((p) => p.id === profileId);
    const profileSuffix = activeProfile && profileId !== "default" ? ` [${activeProfile.name}]` : "";

    // Alert count for this window = alerts in the window's profile.
    const { count: winCount, waitingCount: winWaitingCount } = summarizeAttentionForProfile(
      payload as Parameters<typeof summarizeAttentionForProfile>[0],
      profileId,
    );

    const baseTitle = APP_CONFIG.electron.title + profileSuffix + dataDirSuffix;
    const title = winCount > 0 ? `(${winCount}) ${baseTitle}` : baseTitle;
    win.setTitle(title);

    if (process.platform === "win32") {
      win.setOverlayIcon(
        winCount > 0 ? createOverlayIcon(winCount, winWaitingCount) : null,
        winCount > 0
          ? `${winCount} workspace alert${winCount === 1 ? "" : "s"}${winWaitingCount ? `, ${winWaitingCount} waiting for input` : ""}`
          : "",
      );
    }

    const prevCount = windowAttentionCount.get(windowId) ?? 0;
    const shouldFlash = winCount > prevCount && !win.isFocused();
    if (shouldFlash) {
      log.debug("flashing taskbar", { windowId, winCount, winWaitingCount, prevCount });
      win.flashFrame(true);
    } else if (winCount === 0 || win.isFocused()) {
      win.flashFrame(false);
    }
    windowAttentionCount.set(windowId, winCount);
  }

  if (count !== runtimeState.lastAttentionCount) {
    log.trace("attention count changed", { prevCount: runtimeState.lastAttentionCount, newCount: count, waitingCount });
  }
  runtimeState.lastAttentionCount = count;
}

function syncTitleBarTheme(): void {
  if (process.platform === "darwin") return;
  const isDark = nativeTheme.shouldUseDarkColors;
  for (const win of windowRegistry.values()) {
    if (win.isDestroyed()) continue;
    win.setTitleBarOverlay({
      color: isDark ? APP_CONFIG.electron.backgroundColor : "#f7f7f9",
      symbolColor: isDark ? "#dcdce0" : "#18181b",
    });
  }
}

const distIndexUrl = new URL(`file://${path.join(app.getAppPath(), "dist", "index.html").replace(/\\/g, "/")}`).href;

function isRendererOrigin(target: string): boolean {
  if (!target) return false;
  if (target.startsWith("file://")) {
    // Drop any query string / hash so the popout window (which appends
    // ?view=diff-popout) still passes the navigation guard on reload.
    const bare = target.split("?")[0].split("#")[0];
    return bare === distIndexUrl;
  }
  try {
    const url = new URL(target);
    const allowed = new URL(rendererUrl);
    return url.origin === allowed.origin;
  } catch {
    return false;
  }
}

/**
 * Resolve safe window bounds from a persisted slot.
 * If the saved display is gone or the bounds are mostly off-screen, fall back
 * to default size centered on the primary display.
 */
function resolveSafeBounds(slot?: Partial<WindowSlot>): { x?: number; y?: number; width: number; height: number } {
  const defaultW = APP_CONFIG.electron.windowWidth;
  const defaultH = APP_CONFIG.electron.windowHeight;
  if (!slot?.bounds) return { width: defaultW, height: defaultH };

  const { x, y, width, height } = slot.bounds;
  const w = Math.max(width || defaultW, APP_CONFIG.electron.minWindowWidth);
  const h = Math.max(height || defaultH, APP_CONFIG.electron.minWindowHeight);

  // If displayId is set, try to find that display first; fall back to display at (x,y)
  const displays = screen.getAllDisplays();
  let targetDisplay = slot.displayId ? displays.find((d) => d.id === slot.displayId) : undefined;
  if (!targetDisplay) {
    // Find the display containing most of the window's area
    targetDisplay = screen.getDisplayMatching({ x, y, width: w, height: h });
  }
  if (!targetDisplay) {
    targetDisplay = screen.getPrimaryDisplay();
  }

  const { bounds: db, workArea: wa } = targetDisplay;
  // Check if at least 100px of the window is visible on the target display
  const visibleX = Math.max(x, db.x) < Math.min(x + w, db.x + db.width);
  const visibleY = Math.max(y, db.y) < Math.min(y + h, db.y + db.height);
  if (visibleX && visibleY) {
    // Clamp so the title bar stays reachable
    const clampedX = Math.max(wa.x, Math.min(x, wa.x + wa.width - 100));
    const clampedY = Math.max(wa.y, Math.min(y, wa.y + wa.height - 40));
    return { x: clampedX, y: clampedY, width: Math.min(w, wa.width), height: Math.min(h, wa.height) };
  }

  // Saved display gone or window off-screen — center on the target display's work area
  const cx = wa.x + Math.max(0, Math.floor((wa.width - w) / 2));
  const cy = wa.y + Math.max(0, Math.floor((wa.height - h) / 2));
  return { x: cx, y: cy, width: Math.min(w, wa.width), height: Math.min(h, wa.height) };
}

function createWindow(windowId?: string, slot?: Partial<WindowSlot>): void {
  const id = windowId || randomUUID();
  const windowIconPath =
    process.platform === "win32"
      ? path.join(app.getAppPath(), "assets", "icon.ico")
      : path.join(app.getAppPath(), "assets", "icon.png");

  const safeBounds = resolveSafeBounds(slot);
  log.info("createWindow: starting", {
    windowId: id,
    profileId: slot?.profileId,
    bounds: safeBounds,
    existingWindowCount: windowRegistry.size,
  });
  const win = new BrowserWindow({
    width: safeBounds.width,
    height: safeBounds.height,
    x: safeBounds.x,
    y: safeBounds.y,
    minWidth: APP_CONFIG.electron.minWindowWidth,
    minHeight: APP_CONFIG.electron.minWindowHeight,
    title: APP_CONFIG.electron.title,
    icon: windowIconPath,
    backgroundColor: APP_CONFIG.electron.backgroundColor,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay: {
      color: APP_CONFIG.electron.backgroundColor,
      symbolColor: "#dcdce0",
      height: 32,
    },
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist-electron", "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
      spellcheck: false,
      additionalArguments: [...(webglDisabled ? ["--strideterm-disable-webgl"] : []), `--strideterm-window-id=${id}`],
    },
  });

  if (slot?.isMaximized) {
    win.maximize();
  }

  // Register in window registry. Capture webContents.id at construction time
  // so the `closed` handler can clean up the reverse-map entry even after
  // the BrowserWindow's webContents has been destroyed (accessing
  // `win.webContents.id` after destruction throws "Object has been destroyed").
  const webContentsId = win.webContents.id;
  windowRegistry.set(id, win);
  webContentsToWindowId.set(webContentsId, id);
  windowFocusedAt.set(id, Date.now());
  log.info("createWindow: BrowserWindow constructed", {
    windowId: id,
    webContentsId,
    registrySize: windowRegistry.size,
  });

  // Persist bounds debounced: Electron streams move/resize events during a
  // drag, and each immediate persist costs a full state write. The pending
  // update is flushed in the "close" handler so the final position survives.
  win.on("move", () => schedulePersistWindowSlot(id, win));
  win.on("resize", () => schedulePersistWindowSlot(id, win));

  win.on("focus", () => {
    windowFocusedAt.set(id, Date.now());
    win.flashFrame(false);
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    log.error("createWindow: did-fail-load", {
      windowId: id,
      errorCode,
      errorDescription,
      url: validatedUrl,
    });
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    log.error("createWindow: render-process-gone", { windowId: id, ...details });
  });

  win.on("unresponsive", () => log.warn("createWindow: window unresponsive", { windowId: id }));
  win.on("ready-to-show", () => log.debug("createWindow: ready-to-show", { windowId: id }));

  // Intercept close to prompt "Really close?" when closing the LAST main
  // window AND there are workspaces or running task agents that would be
  // lost on app shutdown. Closing a non-last window is always safe (other
  // windows + the shared runtime stay alive), so we let those through.
  win.on("close", (event) => {
    // A debounced bounds update may still be pending — persist it while the
    // window is alive so the final position isn't lost. Harmless when the
    // close ends up cancelled below.
    flushPersistWindowSlot(id, win);
    // Global flag short-circuits after the user has approved the flow.
    if (closeFlowConfirmed) {
      closingWindows.add(id);
      return;
    }
    // Mark this window as in-progress for the cascading-close detection.
    closingWindows.add(id);
    // How many main windows remain that haven't been asked to close yet?
    // (windowRegistry only holds main windows — diff popouts are tracked
    // separately and aren't counted here.)
    let othersOpen = 0;
    for (const [wid, w] of windowRegistry) {
      if (wid === id) continue;
      if (closingWindows.has(wid)) continue;
      if (w.isDestroyed()) continue;
      othersOpen++;
    }
    if (othersOpen > 0) {
      // Not the last → closing is harmless, allow through.
      return;
    }
    if (process.platform === "darwin") {
      // macOS keeps the app alive after the last window closes (see the
      // window-all-closed handler below), so the runtime + work persist.
      // The confirmation belongs on Cmd+Q (before-quit), not here.
      return;
    }
    // Last window on Windows/Linux. Need confirmation if there's risky
    // state; confirmCloseFlow resolves immediately when there isn't. Roll
    // back our closingWindows mark so a cancel + retry path starts fresh.
    event.preventDefault();
    closingWindows.delete(id);
    void confirmCloseFlow().then((confirmed) => {
      if (!confirmed) return;
      if (win.isDestroyed()) return;
      win.close();
    });
  });

  win.on("closed", () => {
    const remaining = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
    log.info("createWindow: window closed", {
      windowId: id,
      remainingBrowserWindows: remaining,
      registrySizeBefore: windowRegistry.size,
    });
    windowRegistry.delete(id);
    webContentsToWindowId.delete(webContentsId);
    windowFocusedAt.delete(id);
    windowAttentionCount.delete(id);
    closingWindows.delete(id);
    const pending = pendingCloseConfirmations.get(id);
    if (pending) {
      pendingCloseConfirmations.delete(id);
      pending(false);
    }
    // Remove slot from persistent state
    if (runtimeState.runtimeInteractive && runtimeState.runtime) {
      runtimeState.runtime.removeWindowSlot?.(id).catch(() => {});
    }
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!isRendererOrigin(url)) {
      log.warn("blocked main-window navigation away from renderer origin", { url: url.slice(0, 200) });
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { action: "deny" };
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const safeUrl = parsed.toString();
      void import("electron").then(({ shell }) => shell.openExternal(safeUrl));
    } else {
      log.warn("blocked openExternal for non-http(s) protocol", { protocol: parsed.protocol });
    }
    return { action: "deny" };
  });

  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- legacy preload key still honoured by Electron
    delete (webPreferences as any).preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;

    const src = params.src || "";
    if (!/^https?:\/\//i.test(src) && src !== "about:blank") {
      log.warn("blocked webview attach with non-http(s) src", { src: src.slice(0, 200) });
      event.preventDefault();
    }
  });

  win.webContents.once("dom-ready", () => {
    log.info("createWindow: dom-ready, showing window", { windowId: id });
    win.show();
  });

  // Intercept Ctrl+1-9 / Ctrl+Shift+N before Chromium/xterm can eat them
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    // Ctrl+1-9 — switch workspace in this window
    if (input.control && !input.alt && !input.shift) {
      const digit =
        input.code?.match(/^Digit([1-9])$/)?.[1] || (input.key >= "1" && input.key <= "9" ? input.key : null);
      if (digit) {
        event.preventDefault();
        const appState = runtimeState.runtime?.getPayload?.()?.appState as
          | {
              windowSlots?: Array<{ id: string; profileId: string }>;
              workspaces?: Array<{ id: string; profileId?: string }>;
            }
          | undefined;
        const slot = (appState?.windowSlots || []).find((s) => s.id === id);
        const profileId = slot?.profileId || "default";
        const workspaces = (appState?.workspaces || []).filter((w) => (w.profileId || "default") === profileId);
        const workspace = workspaces[parseInt(digit, 10) - 1];
        if (workspace) {
          runtimeState.runtime.activateWorkspaceInWindow(workspace.id, id).catch(() => {});
        }
        return;
      }
    }

    // Ctrl+Shift+N — open new window
    if (input.control && input.shift && (input.key === "N" || input.key === "n")) {
      event.preventDefault();
      win.webContents.send("shortcut:new-window");
      return;
    }
  });

  updateNativeAttention(runtimeState.runtime?.getPayload?.() as Record<string, unknown> | undefined);

  if (process.env.STRIDETERM_SMOKE_TEST === "1") {
    win.webContents.once("did-finish-load", () => {
      setTimeout(() => app.exit(0), APP_CONFIG.electron.smokeReadyExitMs);
    });
    setTimeout(() => app.exit(0), APP_CONFIG.electron.smokeHardExitMs);
  }

  const distIndexPath = path.join(app.getAppPath(), "dist", "index.html");

  if (isDev && !forceDist) {
    let fellBackToDist = false;
    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || fellBackToDist || validatedUrl !== rendererUrl) {
        return;
      }

      fellBackToDist = true;
      console.warn(`Renderer URL failed (${errorCode}: ${errorDescription}). Falling back to dist build.`);
      log.warn("createWindow: dev renderer failed, falling back to dist", {
        windowId: id,
        errorCode,
        errorDescription,
      });
      win.loadFile(distIndexPath);
    });

    log.debug("createWindow: loadURL (dev)", { windowId: id, url: rendererUrl });
    win.loadURL(rendererUrl);
    win.webContents.openDevTools({ mode: "detach" });
    return;
  }

  log.debug("createWindow: loadFile (prod/dist)", { windowId: id, file: distIndexPath });
  win.loadFile(distIndexPath);
}

/**
 * Lightweight secondary window that renders just the Monaco diff for a
 * single payload — same renderer bundle, but `?view=diff-popout` query
 * makes src/main.ts mount `DiffPopoutApp` instead of the full app. Useful
 * for parking a diff on a second monitor while you keep navigating in the
 * main window.
 */
function createDiffPopoutWindow(payload: DiffPopoutPayload): BrowserWindow {
  const windowIconPath =
    process.platform === "win32"
      ? path.join(app.getAppPath(), "assets", "icon.ico")
      : path.join(app.getAppPath(), "assets", "icon.png");
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 640,
    minHeight: 360,
    title: payload.title || "Diff",
    icon: windowIconPath,
    backgroundColor: APP_CONFIG.electron.backgroundColor,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist-electron", "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
      additionalArguments: [...(webglDisabled ? ["--strideterm-disable-webgl"] : []), "--strideterm-popout=diff"],
    },
  });

  diffPopoutPayloads.set(win.webContents.id, payload);
  diffPopoutWindows.add(win);
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    diffPopoutPayloads.delete(win.webContents.id);
    diffPopoutWindows.delete(win);
  });

  // Navigation safety: same guard as the main window — the popout must
  // stay on the renderer origin.
  win.webContents.on("will-navigate", (event, url) => {
    if (!isRendererOrigin(url)) {
      log.warn("blocked diff-popout navigation away from renderer origin", { url: url.slice(0, 200) });
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { action: "deny" };
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      void import("electron").then(({ shell }) => shell.openExternal(parsed.toString()));
    }
    return { action: "deny" };
  });

  const distIndexPath = path.join(app.getAppPath(), "dist", "index.html");
  const popoutDevUrl = `${rendererUrl}?view=diff-popout`;
  if (isDev) {
    // Same fallback as createWindow: if the Vite dev URL refuses to load
    // (process not running yet, port conflict, …) the popout window would
    // sit on a blank page forever. Catch did-fail-load and recover with
    // the prod dist build, keeping the ?view=diff-popout query so the
    // renderer still mounts DiffPopoutApp instead of the full app.
    let fellBackToDist = false;
    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || fellBackToDist || validatedUrl !== popoutDevUrl) return;
      fellBackToDist = true;
      log.warn("diff-popout: dev renderer failed, falling back to dist", { errorCode, errorDescription });
      win.loadFile(distIndexPath, { query: { view: "diff-popout" } });
    });
    win.loadURL(popoutDevUrl);
  } else {
    win.loadFile(distIndexPath, { query: { view: "diff-popout" } });
  }
  log.info("diff-popout window created", {
    webContentsId: win.webContents.id,
    title: payload.title || "",
  });
  return win;
}

function persistWindowSlot(windowId: string, win: BrowserWindow): void {
  if (!runtimeState.runtimeInteractive || !runtimeState.runtime || win.isDestroyed()) return;
  if (win.isMinimized() || win.isMaximized()) return;
  const b = win.getBounds();
  const [wx, wy] = win.getPosition();
  const display = screen.getDisplayNearestPoint({ x: wx, y: wy });
  const displayId = display?.id;
  runtimeState.runtime.updateWindowSlotBounds?.(windowId, b, displayId).catch(() => {});
}

const windowSlotPersistTimers = new Map<string, NodeJS.Timeout>();
const WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 300;

function schedulePersistWindowSlot(windowId: string, win: BrowserWindow): void {
  clearTimeout(windowSlotPersistTimers.get(windowId));
  const timer = setTimeout(() => {
    windowSlotPersistTimers.delete(windowId);
    persistWindowSlot(windowId, win);
  }, WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS);
  windowSlotPersistTimers.set(windowId, timer);
}

function flushPersistWindowSlot(windowId: string, win: BrowserWindow): void {
  const timer = windowSlotPersistTimers.get(windowId);
  if (!timer) return;
  clearTimeout(timer);
  windowSlotPersistTimers.delete(windowId);
  persistWindowSlot(windowId, win);
}

function emitToWindow(windowId: string, channel: string, payload: unknown): void {
  const win = windowRegistry.get(windowId);
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    if (err?.code === "EPIPE" || err?.message?.includes("EPIPE")) return;
    throw error;
  }
}

function emitToRenderer(channel: string, payload: unknown): void {
  for (const win of windowRegistry.values()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      if (err?.code === "EPIPE" || err?.message?.includes("EPIPE")) continue;
      throw error;
    }
  }
}

// Expose for IPC handler access
function getWindowIdByWebContentsId(webContentsId: number): string | undefined {
  return webContentsToWindowId.get(webContentsId);
}

interface Panel {
  id?: string;
  title?: string;
  command?: string;
  launch?: unknown;
  startup?: unknown;
}

interface Workspace {
  id: string;
  panels?: Panel[];
  activePanelId?: string;
}

interface AppState {
  workspaces?: Workspace[];
  activeWorkspaceId?: string;
  activeProjectId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profiles?: any[];
}

function isBrowserPanel(panel: Panel = {}): boolean {
  return /^https?:\/\//i.test(String(panel.command || "").trim());
}

function createBootstrapWorkspacePayload(appState: AppState): Record<string, unknown> | null {
  const workspace = (appState.workspaces || []).find((entry) => entry.id === appState.activeWorkspaceId) || null;
  if (!workspace) {
    return null;
  }

  return {
    workspace,
    project: workspace,
    sessions: (workspace.panels || [])
      .filter((panel) => !isBrowserPanel(panel))
      .map((panel) => ({
        sessionId: `${workspace.id}:${panel.id}`,
        panelId: panel.id,
        title: panel.title,
        command: panel.command,
        launch: panel.launch,
        startup: panel.startup,
        status: "idle",
      })),
  };
}

function updateBootstrapWorkspaceSelection(
  workspaceId: string,
  { sessionId = "" }: { sessionId?: string } = {},
): Record<string, unknown> | null {
  if (!runtimeState.bootstrapPayload?.appState) {
    return null;
  }

  const appState = runtimeState.bootstrapPayload.appState as AppState;
  const workspace = (appState.workspaces || []).find((entry) => entry.id === workspaceId) || null;
  if (!workspace) {
    return null;
  }

  appState.activeWorkspaceId = workspaceId;
  appState.activeProjectId = workspaceId;
  runtimeState.desiredWorkspaceId = workspaceId;
  runtimeState.desiredSessionId = sessionId || "";

  if (sessionId) {
    const panelId = String(sessionId).split(":").slice(1).join(":");
    if (panelId && (workspace.panels || []).some((panel) => panel.id === panelId)) {
      workspace.activePanelId = panelId;
    }
  }

  runtimeState.bootstrapPayload = {
    ...runtimeState.bootstrapPayload,
    appState,
    workspace: createBootstrapWorkspacePayload(appState),
  };
  return runtimeState.bootstrapPayload as Record<string, unknown>;
}

async function invokeRuntimeMethod(methodName: string, ...args: unknown[]): Promise<unknown> {
  await runtimeState.runtimeReady;
  if (!runtimeState.runtime || typeof runtimeState.runtime[methodName] !== "function") {
    throw new Error(`Runtime method '${methodName}' is not available.`);
  }
  return runtimeState.runtime[methodName](...args);
}

function registerBootstrapIpcHandlers(): void {
  ipcMain.handle("state:get", async () => {
    if (runtimeState.runtimeInteractive && runtimeState.runtime) {
      return runtimeState.runtime.getInitialState();
    }
    return loadBootstrapPayload();
  });
  ipcMain.handle("workspace:activate", async (_event, workspaceId: string) => {
    if (runtimeState.runtimeInteractive && runtimeState.runtime) {
      return invokeRuntimeMethod("activateWorkspace", workspaceId);
    }
    await loadBootstrapPayload();
    const payload = updateBootstrapWorkspaceSelection(workspaceId);
    if (payload) {
      emitToRenderer("state:updated", payload);
      return payload;
    }
    return runtimeState.bootstrapPayload;
  });
  ipcMain.handle("project:activate", async (_event, projectId: string) => {
    if (runtimeState.runtimeInteractive && runtimeState.runtime) {
      return invokeRuntimeMethod("activateProject", projectId);
    }
    await loadBootstrapPayload();
    const payload = updateBootstrapWorkspaceSelection(projectId);
    if (payload) {
      emitToRenderer("state:updated", payload);
      return payload;
    }
    return runtimeState.bootstrapPayload;
  });
  ipcMain.handle("session:activate", async (_event, sessionId: string) => {
    if (runtimeState.runtimeInteractive && runtimeState.runtime) {
      return invokeRuntimeMethod("activateSession", sessionId);
    }
    await loadBootstrapPayload();
    const workspaceId = String(sessionId || "").split(":")[0] || "";
    const payload = updateBootstrapWorkspaceSelection(workspaceId, { sessionId });
    if (payload) {
      emitToRenderer("state:updated", payload);
      return payload;
    }
    return runtimeState.bootstrapPayload;
  });
  ipcMain.handle("attention:sync", async (_event, payload) => {
    if (runtimeState.runtimeInteractive && runtimeState.runtime) {
      return invokeRuntimeMethod("syncAttentionContext", payload);
    }
    return runtimeState.bootstrapPayload || (await loadBootstrapPayload());
  });
  // SSH book lists are fetched by every window's renderer during App setup
  // (sshStore.load()). Windows restored at startup race registerIpc() — the
  // real handlers appear only after createRuntime() finishes, so the early
  // invoke rejected with "No handler registered" (a renderer pageerror the
  // e2e harness rightly fails on). Park the call on runtimeReady instead:
  // invokeRuntimeMethod resolves with real data once services are up.
  for (const channel of ["ssh:hosts:list", "ssh:keys:list", "ssh:certs:list"]) {
    ipcMain.handle(channel, () => invokeRuntimeMethod(channel));
  }
}

function unregisterBootstrapIpcHandlers(): void {
  ipcMain.removeHandler("state:get");
  ipcMain.removeHandler("workspace:activate");
  ipcMain.removeHandler("project:activate");
  ipcMain.removeHandler("session:activate");
  ipcMain.removeHandler("attention:sync");
  ipcMain.removeHandler("ssh:hosts:list");
  ipcMain.removeHandler("ssh:keys:list");
  ipcMain.removeHandler("ssh:certs:list");
}

async function loadBootstrapPayload(): Promise<Record<string, unknown>> {
  if (runtimeState.bootstrapPayload) {
    return runtimeState.bootstrapPayload as Promise<Record<string, unknown>>;
  }

  runtimeState.bootstrapPayload = (async () => {
    // MUST use userDataPath — hardcoding ~/.strideterm here was the root cause
    // of dev instances ("dev.ps1" / --data-dir) briefly showing prod workspaces
    // in the renderer before the runtime came up.
    const statePath = path.join(userDataPath, "strideterm-state.json");
    let appState: AppState = createDefaultState() as AppState;

    try {
      const raw = await readFile(statePath, "utf8");
      if (raw.trim()) {
        appState = normalizeState(JSON.parse(raw)) as AppState;
      }
    } catch {
      // Fall back to defaults when the state file is missing or temporarily unreadable.
    }

    const activeWorkspace = createBootstrapWorkspacePayload(appState);
    return {
      meta: {
        appVersion: packageVersion,
        repositoryUrl: APP_CONFIG.app.repositoryUrl,
        bootstrap: true,
        platform: process.platform,
      },
      appState,
      workspace: activeWorkspace,
      attention: {
        byWorkspace: {},
        byProject: {},
        activeWorkspace: null,
        activeProject: null,
      },
      docker: {
        containers: [],
        projects: [],
      },
      git: {
        workspaces: {},
        projects: {},
        activeWorkspace: null,
        activeProject: null,
      },
      azureDevops: {
        connections: [],
        inbox: {
          needsMyReview: [],
          myPullRequests: [],
          needsAttention: [],
        },
        pullRequests: {},
      },
      reviewBridge: {
        pullRequests: {},
      },
      plugins: [],
      environment: {},
      themeSource: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      remoteAccess: {
        enabled: Boolean(appState.settings?.remoteAccess?.enabled),
        host: (appState.settings?.remoteAccess?.host as string | undefined) || "0.0.0.0",
        port: (appState.settings?.remoteAccess?.port as number | undefined) || 43123,
        urls: [],
        tunnel: {
          status: "idle",
          publicUrl: "",
        },
      },
    };
  })();

  return runtimeState.bootstrapPayload as Promise<Record<string, unknown>>;
}

async function restartRemoteServer(): Promise<void> {
  runtimeState.remoteServerRestart = runtimeState.remoteServerRestart
    .catch(() => {})
    .then(async () => {
      await runtimeState.remoteServer?.close?.();
      runtimeState.remoteServer = await startRemoteServer({
        runtime: runtimeState.runtime,
        staticRoot: path.join(app.getAppPath(), "dist"),
      });
    });

  await runtimeState.remoteServerRestart;
}

async function startServices(): Promise<void> {
  runtimeState.runtimeInteractive = false;
  runtimeState.runtime = await createRuntime({
    userDataPath,
    builtinPluginsDir: path.join(resourcesDir, "plugins"),
    getThemeSource: () => (nativeTheme.shouldUseDarkColors ? "dark" : "light"),
    deferInitialRefresh: true,
    dependencies: {
      safeStorage,
      // Telegram `📸 Screenshot` uses this to grab a PNG of the live
      // BrowserWindow. Only the renderer view is captured (not surrounding
      // OS chrome / other windows) which is exactly what the user asked
      // for. Returns Buffer; the runtime hands it off to TelegramManager
      // which uploads via sendPhoto.
      captureMainWindowPng: async (windowId?: string): Promise<Buffer> => {
        let win: BrowserWindow | null = null;
        if (windowId) {
          win = windowRegistry.get(windowId) ?? null;
        }
        if (!win || win.isDestroyed()) {
          win = getPrimaryWindow();
        }
        if (!win || win.isDestroyed()) {
          throw new Error("No available window for screenshot.");
        }
        const image = await win.webContents.capturePage();
        return image.toPNG();
      },
      ensureWindowForProfile,
    },
  });

  unregisterBootstrapIpcHandlers();
  runtimeState.disposeIpc = registerIpc(runtimeState.runtime, emitToRenderer, {
    includeStateGet: true,
    getWindowIdByWebContentsId,
    emitToWindow,
  });
  runtimeState.unsubscribeRemoteConfig = runtimeState.runtime.on("remote:config-changed", async () => {
    await restartRemoteServer().catch((error: Error) => {
      console.warn(`Remote access server restart failed: ${error.message}`);
    });
  });
  runtimeState.unsubscribeStateUpdated = runtimeState.runtime.on(
    "state:updated",
    (payload: Record<string, unknown>) => {
      const themeSetting =
        ((payload?.appState as Record<string, unknown> | undefined)?.settings as Record<string, unknown> | undefined)
          ?.theme || "dark";
      nativeTheme.themeSource = (themeSetting === "system" ? "system" : themeSetting) as "system" | "dark" | "light";
      updateNativeAttention(payload);
      syncTitleBarTheme();
    },
  );
  nativeTheme.on("updated", () => syncTitleBarTheme());
  await restartRemoteServer();
  const desiredWorkspaceId =
    runtimeState.desiredWorkspaceId ||
    (runtimeState.bootstrapPayload?.appState as AppState | undefined)?.activeWorkspaceId ||
    "";
  const runtimeWorkspaceId =
    (runtimeState.runtime.getPayload?.()?.appState as AppState | undefined)?.activeWorkspaceId || "";
  if (desiredWorkspaceId && desiredWorkspaceId !== runtimeWorkspaceId) {
    await runtimeState.runtime.activateWorkspace(desiredWorkspaceId).catch(() => {});
  }
  if (runtimeState.desiredSessionId) {
    await runtimeState.runtime.activateSession(runtimeState.desiredSessionId).catch(() => {});
  }
  runtimeState.runtimeInteractive = true;
  emitToRenderer("state:updated", runtimeState.runtime.getPayload());
}

if (mcpMode) {
  runReviewBridgeMcpServer(mcpMode)
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
} else if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Off-main-thread freeze detector — see freeze-watchdog.ts. Not started in
  // mcp mode (short-lived headless process, no UI to freeze).
  stopFreezeWatchdog = startFreezeWatchdog();

  registerBootstrapIpcHandlers();

  // IPC: renderer requests its own windowId
  ipcMain.handle("window:get-id", (event) => {
    return webContentsToWindowId.get(event.sender.id) ?? "";
  });

  ipcMain.handle("window:focus-current", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  });

  // IPC: renderer creates a new window for a given profileId. A profile may
  // be open in any number of windows — no exclusivity. Optional
  // cloneFromWindowId makes the new window start with the caller window's
  // workspace/session/grid ("Duplicate current window").
  ipcMain.handle("window:create", async (event, profileId: string, options?: { cloneFromWindowId?: string }) => {
    log.info("window:create IPC received", { profileId, registrySize: windowRegistry.size });
    if (!profileId || typeof profileId !== "string") {
      log.warn("window:create: rejected, profileId required");
      return { error: "profileId required" };
    }
    const cloneFromWindowId =
      options && typeof options.cloneFromWindowId === "string" ? options.cloneFromWindowId : undefined;
    return createWindowForProfile(profileId, cloneFromWindowId ? { cloneFromWindowId } : undefined);
  });

  // IPC: renderer closes its own window
  ipcMain.handle("window:close", (event) => {
    const windowId = webContentsToWindowId.get(event.sender.id);
    if (windowId) {
      const win = windowRegistry.get(windowId);
      win?.close();
    }
  });

  // IPC: renderer responds to a confirm-close-request shown via ConfirmDialog.
  // Resolves the pending promise so the close handler can decide whether to
  // re-trigger win.close() with the closeConfirmed flag set.
  ipcMain.handle("window:confirm-close-response", (event, confirmed: boolean) => {
    const windowId = webContentsToWindowId.get(event.sender.id);
    if (!windowId) return;
    const resolver = pendingCloseConfirmations.get(windowId);
    if (!resolver) return;
    pendingCloseConfirmations.delete(windowId);
    resolver(!!confirmed);
  });

  // IPC: renderer requests a new "diff popout" window. The payload is a
  // self-contained MonacoDiffPanel.payload plus a title — we cache it
  // keyed by the new window's webContents.id so the popout (which loads
  // the same renderer bundle) can pull it via diff:popout:get-init.
  ipcMain.handle("diff:popout:open", (event, payload: DiffPopoutPayload) => {
    if (!payload || typeof payload !== "object") {
      return { error: "payload required" };
    }
    try {
      const win = createDiffPopoutWindow(payload);
      return { ok: true, webContentsId: win.webContents.id };
    } catch (err) {
      log.error("diff:popout:open failed", { err: (err as Error)?.message });
      return { error: (err as Error)?.message || "Failed to open diff popout" };
    }
  });

  // IPC: the popout renderer asks for its initial payload. Returns the
  // entry we stashed at create time (or null after the window has been
  // closed and reopened from a stale handle).
  ipcMain.handle("diff:popout:get-init", (event) => {
    return diffPopoutPayloads.get(event.sender.id) ?? null;
  });

  app.on("second-instance", (_event, argv) => {
    // Launching the exe while the app is already running means "give me
    // another window", not just "focus what's there". With a single profile
    // there is nothing to choose — open a new window of it directly; with
    // several, surface the profile picker (the same NewWindowModal as
    // Ctrl/Cmd+Shift+N) in the primary window.
    log.info("second-instance fired", {
      argv: argv.slice(0, 10),
      registrySize: windowRegistry.size,
      runtimeInteractive: runtimeState.runtimeInteractive,
    });
    const primary = getPrimaryWindow();
    if (!primary || primary.isDestroyed()) {
      log.warn("second-instance: no primary window to focus");
      return;
    }
    if (primary.isMinimized()) primary.restore();
    primary.show();
    primary.focus();
    if (!runtimeState.runtimeInteractive) {
      // Still booting — focusing the primary window is all we can offer.
      return;
    }
    const appState = runtimeState.runtime?.getPayload?.()?.appState as { profiles?: Array<{ id: string }> } | undefined;
    const profiles = appState?.profiles || [];
    if (profiles.length === 1) {
      void createWindowForProfile(profiles[0].id);
    } else if (profiles.length > 1) {
      primary.webContents.send("shortcut:new-window");
    }
  });

  app.whenReady().then(async () => {
    // Inherit PATH from the user's login shell on macOS/Linux so child
    // processes (Claude/Codex/Gemini/Copilot/OpenCode detection, Docker, git,
    // btm, etc.) see the same binaries the user has in Terminal. Without
    // this, GUI launches from Finder/Dock get a degraded PATH that misses
    // brew, mise, nvm, pnpm, ~/.local/bin, etc. — every "is X installed"
    // probe then returns false even when the binary is right there.
    await inheritShellPath();
    runtimeState.runtimeReady = startServices().catch((error: unknown) => {
      console.error(`Startup services failed: ${(error as Error)?.message || error}`);
    });

    // Build application menu. On macOS, replacing the default menu (which is
    // what we do here so "New Window" gets a proper accelerator) also
    // disables the OS-supplied Edit → Copy/Paste/Cut/SelectAll bindings —
    // Cmd+V then silently does nothing in the terminal because the
    // keystroke never reaches the renderer. Adding an Edit submenu with the
    // standard roles restores Cmd+C / Cmd+V / Cmd+X / Cmd+Z / Cmd+A on Mac
    // and the equivalent Ctrl chord on Windows/Linux.
    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "Window",
        submenu: [
          {
            label: "New Window",
            accelerator: process.platform === "darwin" ? "Cmd+Shift+N" : "Ctrl+Shift+N",
            click: () => {
              const primary = getPrimaryWindow();
              if (primary) {
                primary.webContents.send("shortcut:new-window");
              }
            },
          },
          {
            role: "close",
            label: "Close Window",
            accelerator: process.platform === "darwin" ? "Cmd+Shift+W" : "Ctrl+Shift+W",
          },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

    // Restore windows from windowSlots persisted in state
    const statePath = path.join(userDataPath, "strideterm-state.json");
    let slotsToRestore: Array<{
      id: string;
      profileId: string;
      bounds?: { x: number; y: number; width: number; height: number };
      isMaximized?: boolean;
    }> = [];
    try {
      const raw = await readFile(statePath, "utf8");
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (Array.isArray(parsed.windowSlots) && parsed.windowSlots.length > 0) {
          slotsToRestore = parsed.windowSlots as typeof slotsToRestore;
        }
      }
    } catch {
      // Fall back to creating a single default window
    }

    log.info("startup: restoring windows from state", {
      count: slotsToRestore.length,
      slotIds: slotsToRestore.map((s) => s.id),
    });
    if (slotsToRestore.length > 0) {
      for (const slot of slotsToRestore) {
        createWindow(slot.id, slot);
      }
    } else {
      // No slots in raw state — the backend's normalizeState will create a
      // migration slot with this exact id, so the boot window and its slot
      // agree (slot cleanup on close, "Duplicate current window", per-window
      // bookkeeping all key on windowId === slot.id).
      createWindow(MIGRATION_WINDOW_SLOT_ID);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        // Same reasoning as boot: with every window closed the slots were
        // removed too, so normalizeState recreates the migration slot.
        createWindow(MIGRATION_WINDOW_SLOT_ID);
      }
    });
  });
}

app.on("window-all-closed", () => {
  const live = Array.from(windowRegistry.values()).filter((w) => !w.isDestroyed());
  log.info("window-all-closed fired", {
    platform: process.platform,
    registrySize: windowRegistry.size,
    liveWindows: live.length,
  });
  // Safety net: if our registry still holds live BrowserWindows, do NOT quit.
  // This guards against Electron firing window-all-closed when a hidden/destroyed
  // window vanishes from getAllWindows() while a visible sibling is still up.
  if (live.length > 0) {
    log.warn("window-all-closed: registry still has live windows, suppressing quit", {
      liveIds: live.map((w) => [...windowRegistry.entries()].find(([, v]) => v === w)?.[0]),
    });
    return;
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", (event) => {
  log.info("will-quit fired", { defaultPrevented: event.defaultPrevented });
});

app.on("quit", (_event, exitCode) => {
  log.info("quit fired", { exitCode });
});

app.on("before-quit", (event) => {
  // Cmd+Q / menubar Quit / OS shutdown all funnel through before-quit. If
  // the user hasn't approved the close flow yet, gate cleanup behind the
  // ConfirmDialog so a "Keep open" reply doesn't leave the app with a
  // torn-down runtime while a window is still up.
  if (!closeFlowConfirmed) {
    event.preventDefault();
    void confirmCloseFlow().then((confirmed) => {
      if (!confirmed) return;
      // closeFlowConfirmed is now true; re-entering will fall through to
      // cleanup + natural shutdown.
      app.quit();
    });
    return;
  }
  // Confirmed (or no risky state). Hold the quit until cleanup has finished —
  // without preventDefault Electron exits while the cleanup (runtime.stop,
  // the in-flight state persist it flushes, shutdownLogger) is still running.
  // That truncation is how quit-time persists were getting cut between
  // tmp-write and rename (full-content orphan .tmp + stale state file).
  // Time-capped so a hung cleanup can't make the app unquittable.
  if (!shutdownCleanupComplete) {
    event.preventDefault();
    void Promise.race([runShutdownCleanupOnce(), new Promise<void>((resolve) => setTimeout(resolve, 10000))]).finally(
      () => {
        shutdownCleanupComplete = true;
        app.quit();
      },
    );
  }
});

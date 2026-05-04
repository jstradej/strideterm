import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, safeStorage } from "electron";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRuntime } from "./backend/runtime.js";
import { registerIpc } from "./backend/ipc.js";
import { startRemoteServer } from "./backend/remote-server.js";
import { parseReviewBridgeMcpArgs, runReviewBridgeMcpServer } from "./backend/review-bridge-mcp.js";
import { createDefaultState, normalizeState } from "./backend/default-state.js";
import { inheritShellPath } from "./backend/fix-path.js";
import { APP_CONFIG, getRendererDevUrl } from "../config/app-config.js";
import { getLogger, setLogDir, shutdownLogger } from "./backend/logger.js";

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

// Suppress EPIPE errors that occur when the renderer disconnects during dev reload
process.on("uncaughtException", (error: NodeJS.ErrnoException) => {
  if (error?.code === "EPIPE" || error?.message?.includes("EPIPE")) {
    return;
  }
  console.error("Uncaught exception:", error);
  app.quit();
});

const isDev = !app.isPackaged;
const rendererUrl = getRendererDevUrl();
const forceDist = process.env.STRIDETERM_FORCE_DIST === "1" || process.env.STRIDETERM_SMOKE_TEST === "1";

interface RuntimeState {
  window: BrowserWindow | null;
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
}

const runtimeState: RuntimeState = {
  window: null,
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

function updateNativeAttention(payload: Record<string, unknown> | null | undefined): void {
  if (!payload) return;
  const { count, waitingCount } = summarizeAttention(payload);
  const appState = payload.appState as Record<string, unknown> | undefined;
  const activeProfileId = (appState?.activeProfileId as string | undefined) || "default";
  const profiles = (appState?.profiles as Array<{ id: string; name: string }> | undefined) || [];
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const profileSuffix = activeProfile && activeProfileId !== "default" ? ` [${activeProfile.name}]` : "";
  const dataDirSuffix = customDataDir ? ` (${path.basename(customDataDir)})` : "";
  const baseTitle = APP_CONFIG.electron.title + profileSuffix + dataDirSuffix;
  const title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle;

  if (app.setBadgeCount) {
    app.setBadgeCount(count);
  }

  if (!runtimeState.window || runtimeState.window.isDestroyed()) {
    runtimeState.lastAttentionCount = count;
    return;
  }

  runtimeState.window.setTitle(title);

  if (process.platform === "win32") {
    runtimeState.window.setOverlayIcon(
      count > 0 ? createOverlayIcon(count, waitingCount) : null,
      count > 0
        ? `${count} workspace alert${count === 1 ? "" : "s"}${waitingCount ? `, ${waitingCount} waiting for input` : ""}`
        : "",
    );
  }

  const shouldFlash = count > runtimeState.lastAttentionCount && !runtimeState.window.isFocused();
  if (shouldFlash) {
    log.debug("flashing taskbar", { count, waitingCount, prevCount: runtimeState.lastAttentionCount });
    runtimeState.window.flashFrame(true);
  } else if (count === 0 || runtimeState.window.isFocused()) {
    runtimeState.window.flashFrame(false);
  }

  if (count !== runtimeState.lastAttentionCount) {
    log.trace("attention count changed", { prevCount: runtimeState.lastAttentionCount, newCount: count, waitingCount });
  }
  runtimeState.lastAttentionCount = count;
}

function syncTitleBarTheme(): void {
  if (!runtimeState.window || runtimeState.window.isDestroyed() || process.platform === "darwin") return;
  const isDark = nativeTheme.shouldUseDarkColors;
  runtimeState.window.setTitleBarOverlay({
    color: isDark ? APP_CONFIG.electron.backgroundColor : "#f7f7f9",
    symbolColor: isDark ? "#dcdce0" : "#18181b",
  });
}

function createWindow(): void {
  const windowIconPath =
    process.platform === "win32"
      ? path.join(app.getAppPath(), "assets", "icon.ico")
      : path.join(app.getAppPath(), "assets", "icon.png");
  runtimeState.window = new BrowserWindow({
    width: APP_CONFIG.electron.windowWidth,
    height: APP_CONFIG.electron.windowHeight,
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
      preload: path.join(app.getAppPath(), "dist-electron", "electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // SEC-008 follow-up: would like `sandbox: true` but the e2e Electron
      // suite proves that Electron 41 loads sandboxed preloads as
      // CommonJS — the ESM `import { contextBridge, ipcRenderer } from
      // "electron"` in our compiled preload.js fails with
      // `SyntaxError: Cannot use import statement outside a module`,
      // window.strideterm never gets exposed, and every IPC-driven test
      // breaks. Smoke (which only checks the app boots) didn't catch it.
      // To turn this back on we need to ship preload as CJS — either a
      // dedicated `tsconfig.preload.json` emitting `.cjs`, or an esbuild
      // pass that bundles preload.ts to CommonJS. Tracked as the only
      // open security-review item; mitigated for now by
      // `contextIsolation: true` + `nodeIntegration: false` + the
      // `will-attach-webview` lockdown below.
      sandbox: false,
      webviewTag: true,
      // Keep requestAnimationFrame running when the window is occluded so the
      // xterm.js WebGL renderer doesn't stall mid-scroll on macOS.
      backgroundThrottling: false,
      // Pass startup flags into the preload process via process.argv so the
      // bridge can expose them synchronously without an IPC round-trip on
      // every terminal mount.
      additionalArguments: webglDisabled ? ["--strideterm-disable-webgl"] : [],
    },
  });

  // The strideterm renderer is single-page and never expects to navigate
  // anywhere except its own bundle (Vite dev URL or the local dist/
  // file). If something inside the renderer (or a buggy plugin) tries to
  // navigate to an external origin, that almost always means a hijack
  // attempt — the safe answer is to send the user to their default
  // browser instead. The Electron security checklist calls this out as
  // a required hardening step for `webviewTag: true` apps.
  const distIndexUrl = new URL(`file://${path.join(app.getAppPath(), "dist", "index.html").replace(/\\/g, "/")}`).href;
  const isRendererOrigin = (target: string): boolean => {
    if (!target) return false;
    // Production: only the bundled index.html is allowed. Refuse any
    // other file:// URL so a hijack cannot pivot to e.g.
    // `file:///c:/Users/.../secrets.txt`.
    if (target.startsWith("file://")) {
      return target === distIndexUrl;
    }
    try {
      const url = new URL(target);
      const allowed = new URL(rendererUrl);
      return url.origin === allowed.origin;
    } catch {
      return false;
    }
  };

  runtimeState.window.webContents.on("will-navigate", (event, url) => {
    if (!isRendererOrigin(url)) {
      log.warn("blocked main-window navigation away from renderer origin", { url: url.slice(0, 200) });
      event.preventDefault();
    }
  });

  runtimeState.window.webContents.setWindowOpenHandler(({ url }) => {
    // Open external links in the user's default browser instead of a new
    // BrowserWindow that would inherit our preload + Node access.
    //
    // The bare `^https?://` regex prefix-matches but doesn't reject
    // schemes that *contain* http (e.g. some platforms register
    // `https-everywhere://`-style protocol handlers, or a malicious
    // payload encodes `https://attacker/#javascript:…` to coax the user
    // into running arbitrary JS via `shell.openExternal`). Parse the URL
    // through WHATWG and assert the protocol is exactly http: or https:
    // before handing it off; everything else (file:, ftp:, custom
    // schemes) is dropped. We don't allowlist domains because legitimate
    // outbound links span Azure DevOps, GitHub, user docs, Confluence,
    // npm — too broad to enumerate and too easy to be wrong.
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

  // Lock down every <webview> the renderer attaches.
  //
  // BrowserPane uses the webview tag to embed arbitrary user-supplied
  // URLs (Confluence, Azure Devops Wiki, etc). By default a webview can
  // turn nodeIntegration back on or load a custom preload — that would
  // give attacker-controlled web pages full Node access. We strip every
  // dangerous webPreference at attach time and refuse to load anything
  // that isn't a regular http/https URL. Without this handler, the
  // upstream Electron security checklist explicitly flags `webviewTag:
  // true` as unsafe.
  runtimeState.window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
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

  // Show window as soon as the DOM is ready (splash screen HTML is visible),
  // rather than waiting for ready-to-show which includes JS module loading.
  runtimeState.window.webContents.once("dom-ready", () => {
    runtimeState.window!.show();
  });

  runtimeState.window.on("focus", () => {
    if (runtimeState.window && !runtimeState.window.isDestroyed()) {
      runtimeState.window.flashFrame(false);
    }
  });

  // Intercept Ctrl+1-9 before Chromium/xterm can eat them
  runtimeState.window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    // Ctrl+1-9 — switch workspace
    if (input.control && !input.alt && !input.shift) {
      const digit =
        input.code?.match(/^Digit([1-9])$/)?.[1] || (input.key >= "1" && input.key <= "9" ? input.key : null);
      if (digit) {
        event.preventDefault();
        const appState = runtimeState.runtime?.getPayload?.()?.appState as
          | { activeProfileId?: string; workspaces?: Array<{ id: string; profileId?: string }> }
          | undefined;
        const activeProfileId = appState?.activeProfileId || "default";
        const workspaces = (appState?.workspaces || []).filter((w) => (w.profileId || "default") === activeProfileId);
        const workspace = workspaces[parseInt(digit, 10) - 1];
        if (workspace) {
          runtimeState.runtime.activateWorkspace(workspace.id).catch(() => {});
        }
        return;
      }
    }
  });

  updateNativeAttention(runtimeState.runtime?.getPayload?.() as Record<string, unknown> | undefined);

  if (process.env.STRIDETERM_SMOKE_TEST === "1") {
    runtimeState.window.webContents.once("did-finish-load", () => {
      setTimeout(() => app.exit(0), APP_CONFIG.electron.smokeReadyExitMs);
    });
    setTimeout(() => app.exit(0), APP_CONFIG.electron.smokeHardExitMs);
  }

  const distIndexPath = path.join(app.getAppPath(), "dist", "index.html");

  if (isDev && !forceDist) {
    let fellBackToDist = false;
    runtimeState.window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || fellBackToDist || validatedUrl !== rendererUrl) {
          return;
        }

        fellBackToDist = true;
        console.warn(`Renderer URL failed (${errorCode}: ${errorDescription}). Falling back to dist build.`);
        runtimeState.window!.loadFile(distIndexPath);
      },
    );

    runtimeState.window.loadURL(rendererUrl);
    runtimeState.window.webContents.openDevTools({ mode: "detach" });
    return;
  }

  runtimeState.window.loadFile(distIndexPath);
}

function emitToRenderer(channel: string, payload: unknown): void {
  if (!runtimeState.window || runtimeState.window.isDestroyed()) {
    return;
  }

  try {
    runtimeState.window.webContents.send(channel, payload);
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    if (err?.code === "EPIPE" || err?.message?.includes("EPIPE")) {
      return;
    }
    throw error;
  }
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
}

function unregisterBootstrapIpcHandlers(): void {
  ipcMain.removeHandler("state:get");
  ipcMain.removeHandler("workspace:activate");
  ipcMain.removeHandler("project:activate");
  ipcMain.removeHandler("session:activate");
  ipcMain.removeHandler("attention:sync");
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
      captureMainWindowPng: async (): Promise<Buffer> => {
        const win = runtimeState.window;
        if (!win || win.isDestroyed()) {
          throw new Error("Main window is not available for screenshot.");
        }
        const image = await win.webContents.capturePage();
        return image.toPNG();
      },
    },
  });

  unregisterBootstrapIpcHandlers();
  runtimeState.disposeIpc = registerIpc(runtimeState.runtime, emitToRenderer, { includeStateGet: true });
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
  registerBootstrapIpcHandlers();

  app.on("second-instance", () => {
    if (!runtimeState.window || runtimeState.window.isDestroyed()) {
      return;
    }
    if (runtimeState.window.isMinimized()) {
      runtimeState.window.restore();
    }
    runtimeState.window.show();
    runtimeState.window.focus();
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
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  log.info("app quitting");
  runtimeState.unsubscribeStateUpdated?.();
  runtimeState.unsubscribeRemoteConfig?.();
  runtimeState.disposeIpc?.();
  await runtimeState.remoteServer?.close?.();
  (await runtimeState.runtime?.stop?.()) as Promise<void>;
  await shutdownLogger();
});

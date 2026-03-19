import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, safeStorage } from "electron";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createRuntime } from "./backend/runtime.js";
import { registerIpc } from "./backend/ipc.js";
import { startRemoteServer } from "./backend/remote-server.js";
import { parseReviewBridgeMcpArgs, runReviewBridgeMcpServer } from "./backend/review-bridge-mcp.js";
import { createDefaultState, normalizeState } from "./backend/default-state.js";
import { APP_CONFIG, getRendererDevUrl } from "../config/app-config.js";

const require = createRequire(import.meta.url);
const { version: packageVersion = "0.0.0" } = require("../package.json");

const isDev = !app.isPackaged;
const rendererUrl = getRendererDevUrl();
const forceDist = process.env.STRIDETERM_FORCE_DIST === "1" || process.env.STRIDETERM_SMOKE_TEST === "1";

const runtimeState = {
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

function summarizeAttention(payload) {
  const alerts = Object.values(payload?.attention?.byProject || {})
    .flatMap((entry) => entry?.alerts || []);
  const count = alerts.length;
  const waitingCount = alerts.filter((alert) => alert.kind === "waiting").length;
  return { count, waitingCount };
}

function createOverlayIcon(count, waitingCount) {
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

function updateNativeAttention(payload) {
  const { count, waitingCount } = summarizeAttention(payload);
  const activeProfileId = payload?.appState?.activeProfileId || "default";
  const activeProfile = (payload?.appState?.profiles || []).find((p) => p.id === activeProfileId);
  const profileSuffix = activeProfile && activeProfileId !== "default" ? ` [${activeProfile.name}]` : "";
  const baseTitle = APP_CONFIG.electron.title + profileSuffix;
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
    runtimeState.window.flashFrame(true);
  } else if (count === 0 || runtimeState.window.isFocused()) {
    runtimeState.window.flashFrame(false);
  }

  runtimeState.lastAttentionCount = count;
}

function syncTitleBarTheme() {
  if (!runtimeState.window || runtimeState.window.isDestroyed() || process.platform === "darwin") return;
  const isDark = nativeTheme.shouldUseDarkColors;
  runtimeState.window.setTitleBarOverlay({
    color: isDark ? APP_CONFIG.electron.backgroundColor : "#f7f7f9",
    symbolColor: isDark ? "#dcdce0" : "#18181b",
  });
}

function createWindow() {
  const windowIconPath = process.platform === "win32"
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
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay: {
      color: APP_CONFIG.electron.backgroundColor,
      symbolColor: "#dcdce0",
      height: 32,
    },
    webPreferences: {
      preload: path.join(app.getAppPath(), "electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
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
      const digit = input.code?.match(/^Digit([1-9])$/)?.[1] || (input.key >= "1" && input.key <= "9" ? input.key : null);
      if (digit) {
        event.preventDefault();
        const appState = runtimeState.runtime?.getPayload()?.appState;
        const activeProfileId = appState?.activeProfileId || "default";
        const workspaces = (appState?.workspaces || []).filter(
          (w) => (w.profileId || "default") === activeProfileId,
        );
        const workspace = workspaces[parseInt(digit, 10) - 1];
        if (workspace) {
          runtimeState.runtime.activateWorkspace(workspace.id).catch(() => {});
        }
        return;
      }
    }


  });

  updateNativeAttention(runtimeState.runtime?.getPayload?.());

  if (process.env.STRIDETERM_SMOKE_TEST === "1") {
    runtimeState.window.webContents.once("did-finish-load", () => {
      setTimeout(() => app.exit(0), APP_CONFIG.electron.smokeReadyExitMs);
    });
    setTimeout(() => app.exit(0), APP_CONFIG.electron.smokeHardExitMs);
  }

  const distIndexPath = path.join(app.getAppPath(), "dist", "index.html");

  if (isDev && !forceDist) {
    let fellBackToDist = false;
    runtimeState.window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || fellBackToDist || validatedUrl !== rendererUrl) {
        return;
      }

      fellBackToDist = true;
      console.warn(`Renderer URL failed (${errorCode}: ${errorDescription}). Falling back to dist build.`);
      runtimeState.window.loadFile(distIndexPath);
    });

    runtimeState.window.loadURL(rendererUrl);
    runtimeState.window.webContents.openDevTools({ mode: "detach" });
    return;
  }

  runtimeState.window.loadFile(distIndexPath);
}

function emitToRenderer(channel, payload) {
  if (!runtimeState.window || runtimeState.window.isDestroyed()) {
    return;
  }

  runtimeState.window.webContents.send(channel, payload);
}

function isBrowserPanel(panel = {}) {
  return /^https?:\/\//i.test(String(panel.command || "").trim());
}

function createBootstrapWorkspacePayload(appState) {
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

function updateBootstrapWorkspaceSelection(workspaceId, { sessionId = "" } = {}) {
  if (!runtimeState.bootstrapPayload?.appState) {
    return null;
  }

  const appState = runtimeState.bootstrapPayload.appState;
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
  return runtimeState.bootstrapPayload;
}

async function invokeRuntimeMethod(methodName, ...args) {
  await runtimeState.runtimeReady;
  if (!runtimeState.runtime || typeof runtimeState.runtime[methodName] !== "function") {
    throw new Error(`Runtime method '${methodName}' is not available.`);
  }
  return runtimeState.runtime[methodName](...args);
}

function registerBootstrapIpcHandlers() {
  ipcMain.handle("state:get", async () => {
    if (runtimeState.runtimeInteractive && runtimeState.runtime) {
      return runtimeState.runtime.getInitialState();
    }
    return loadBootstrapPayload();
  });
  ipcMain.handle("workspace:activate", async (_event, workspaceId) => {
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
  ipcMain.handle("project:activate", async (_event, projectId) => {
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
  ipcMain.handle("session:activate", async (_event, sessionId) => {
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
    return runtimeState.bootstrapPayload || await loadBootstrapPayload();
  });
}

function unregisterBootstrapIpcHandlers() {
  ipcMain.removeHandler("state:get");
  ipcMain.removeHandler("workspace:activate");
  ipcMain.removeHandler("project:activate");
  ipcMain.removeHandler("session:activate");
  ipcMain.removeHandler("attention:sync");
}

async function loadBootstrapPayload() {
  if (runtimeState.bootstrapPayload) {
    return runtimeState.bootstrapPayload;
  }

  runtimeState.bootstrapPayload = (async () => {
    const statePath = path.join(os.homedir(), ".strideterm", "strideterm-state.json");
    let appState = createDefaultState();

    try {
      const raw = await readFile(statePath, "utf8");
      if (raw.trim()) {
        appState = normalizeState(JSON.parse(raw));
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
        host: appState.settings?.remoteAccess?.host || "0.0.0.0",
        port: appState.settings?.remoteAccess?.port || 43123,
        urls: [],
        tunnel: {
          status: "idle",
          publicUrl: "",
        },
      },
    };
  })();

  return runtimeState.bootstrapPayload;
}

async function restartRemoteServer() {
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

async function startServices() {
  runtimeState.runtimeInteractive = false;
  const userDataPath = path.join(os.homedir(), ".strideterm");
  runtimeState.runtime = await createRuntime({
    userDataPath,
    builtinPluginsDir: path.join(app.getAppPath(), "plugins"),
    getThemeSource: () => (nativeTheme.shouldUseDarkColors ? "dark" : "light"),
    deferInitialRefresh: true,
    dependencies: {
      safeStorage,
    },
  });

  unregisterBootstrapIpcHandlers();
  runtimeState.disposeIpc = registerIpc(runtimeState.runtime, emitToRenderer, { includeStateGet: false });
  runtimeState.unsubscribeRemoteConfig = runtimeState.runtime.on("remote:config-changed", async () => {
    await restartRemoteServer().catch((error) => {
      console.warn(`Remote access server restart failed: ${error.message}`);
    });
  });
  runtimeState.unsubscribeStateUpdated = runtimeState.runtime.on("state:updated", (payload) => {
    const themeSetting = payload?.appState?.settings?.theme || "dark";
    nativeTheme.themeSource = themeSetting === "system" ? "system" : themeSetting;
    updateNativeAttention(payload);
    syncTitleBarTheme();
  });
  nativeTheme.on("updated", () => syncTitleBarTheme());
  await restartRemoteServer();
  const desiredWorkspaceId = runtimeState.desiredWorkspaceId
    || runtimeState.bootstrapPayload?.appState?.activeWorkspaceId
    || "";
  const runtimeWorkspaceId = runtimeState.runtime.getPayload()?.appState?.activeWorkspaceId || "";
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
    .catch((error) => {
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
    runtimeState.runtimeReady = startServices().catch((error) => {
      console.error(`Startup services failed: ${error?.message || error}`);
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
  runtimeState.unsubscribeStateUpdated?.();
  runtimeState.unsubscribeRemoteConfig?.();
  runtimeState.disposeIpc?.();
  await runtimeState.remoteServer?.close?.();
  await runtimeState.runtime?.stop?.();
});

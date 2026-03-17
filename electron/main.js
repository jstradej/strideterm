import { app, BrowserWindow, nativeImage, nativeTheme } from "electron";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "./backend/runtime.js";
import { registerIpc } from "./backend/ipc.js";
import { startRemoteServer } from "./backend/remote-server.js";
import { APP_CONFIG, getRendererDevUrl } from "../config/app-config.js";

const isDev = !app.isPackaged;
const rendererUrl = getRendererDevUrl();
const forceDist = process.env.STRIDETERM_FORCE_DIST === "1" || process.env.STRIDETERM_SMOKE_TEST === "1";

const runtimeState = {
  window: null,
  runtime: null,
  disposeIpc: null,
  remoteServer: null,
  remoteServerRestart: Promise.resolve(),
  unsubscribeRemoteConfig: null,
  unsubscribeStateUpdated: null,
  lastAttentionCount: 0,
};

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
  const userDataPath = path.join(os.homedir(), ".strideterm");
  runtimeState.runtime = await createRuntime({
    userDataPath,
    builtinPluginsDir: path.join(app.getAppPath(), "plugins"),
    getThemeSource: () => (nativeTheme.shouldUseDarkColors ? "dark" : "light"),
  });

  runtimeState.disposeIpc = registerIpc(runtimeState.runtime, emitToRenderer);
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
}

app.whenReady().then(async () => {
  await startServices();
  createWindow();


  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

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

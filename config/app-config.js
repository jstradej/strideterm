function envString(name, fallback) {
  const env = typeof process !== "undefined" ? process.env || {} : {};
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function envNumber(name, fallback) {
  const value = Number.parseInt(envString(name, ""), 10);
  return Number.isFinite(value) ? value : fallback;
}

function envBoolean(name, fallback) {
  const value = envString(name, "");
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export const APP_CONFIG = {
  renderer: {
    devHost: envString("STRIDETERM_RENDERER_HOST", "127.0.0.1"),
    devPort: envNumber("STRIDETERM_RENDERER_PORT", 1420),
    previewHost: envString("STRIDETERM_PREVIEW_HOST", "127.0.0.1"),
    previewPort: envNumber("STRIDETERM_PREVIEW_PORT", 4173),
    waitTimeoutMs: envNumber("STRIDETERM_RENDERER_WAIT_TIMEOUT_MS", 30000),
    waitPollMs: envNumber("STRIDETERM_RENDERER_WAIT_POLL_MS", 250),
  },
  electron: {
    title: envString("STRIDETERM_WINDOW_TITLE", "strIDEterm"),
    backgroundColor: envString("STRIDETERM_BACKGROUND_COLOR", "#09111b"),
    windowWidth: envNumber("STRIDETERM_WINDOW_WIDTH", 1560),
    windowHeight: envNumber("STRIDETERM_WINDOW_HEIGHT", 940),
    minWindowWidth: envNumber("STRIDETERM_MIN_WINDOW_WIDTH", 1100),
    minWindowHeight: envNumber("STRIDETERM_MIN_WINDOW_HEIGHT", 720),
    smokeReadyExitMs: envNumber("STRIDETERM_SMOKE_READY_EXIT_MS", 1200),
    smokeHardExitMs: envNumber("STRIDETERM_SMOKE_HARD_EXIT_MS", 5000),
    smokeAliveMs: envNumber("STRIDETERM_SMOKE_ALIVE_MS", 8000),
  },
  app: {
    repositoryUrl: envString("STRIDETERM_REPOSITORY_URL", "https://github.com/jstradej/strideterm"),
  },
  runtime: {
    dockerPollMs: envNumber("STRIDETERM_DOCKER_POLL_MS", 15000),
    gitPollMs: envNumber("STRIDETERM_GIT_POLL_MS", 20000),
    projectAlertLimit: envNumber("STRIDETERM_PROJECT_ALERT_LIMIT", 6),
  },
  remoteAccess: {
    enabled: envBoolean("STRIDETERM_REMOTE_ENABLED", true),
    host: envString("STRIDETERM_REMOTE_HOST", "0.0.0.0"),
    port: envNumber("STRIDETERM_REMOTE_PORT", 43123),
  },
  session: {
    termName: envString("STRIDETERM_TERM_NAME", "xterm-color"),
    termProgram: envString("STRIDETERM_TERM_PROGRAM", "strideterm"),
    forceColor: envString("STRIDETERM_FORCE_COLOR", "1"),
    defaultCols: envNumber("STRIDETERM_TERM_COLS", 120),
    defaultRows: envNumber("STRIDETERM_TERM_ROWS", 34),
    minCols: envNumber("STRIDETERM_TERM_MIN_COLS", 20),
    minRows: envNumber("STRIDETERM_TERM_MIN_ROWS", 8),
    shellLaunchDelayMs: envNumber("STRIDETERM_SHELL_LAUNCH_DELAY_MS", 50),
    windowsShellFile: envString("STRIDETERM_WINDOWS_SHELL", "pwsh.exe"),
    windowsShellArgs: Object.freeze(["-NoLogo"]),
    posixShellFile: envString("STRIDETERM_POSIX_SHELL", "/bin/bash"),
    posixShellArgs: Object.freeze(["-l"]),
  },
  git: {
    recentLogLimit: envNumber("STRIDETERM_GIT_LOG_LIMIT", 18),
    lazygitWingetPackagePrefix: envString("STRIDETERM_LAZYGIT_WINGET_PREFIX", "JesseDuffield.lazygit_"),
  },
  tunnel: {
    mode: envString("STRIDETERM_TUNNEL_MODE", "quick"),
    connectTimeoutMs: envNumber("STRIDETERM_TUNNEL_CONNECT_TIMEOUT_MS", 20000),
    binaries: Object.freeze(
      envString("STRIDETERM_TUNNEL_BINARIES", "").split(",").filter(Boolean).length > 0
        ? envString("STRIDETERM_TUNNEL_BINARIES", "").split(",").map((s) => s.trim())
        : ["cloudflared"],
    ),
  },
  ui: {
    defaultTheme: envString("STRIDETERM_DEFAULT_THEME", "dark"),
    sidebarWidth: envNumber("STRIDETERM_SIDEBAR_WIDTH", 288),
    sidebarCollapsed: envBoolean("STRIDETERM_SIDEBAR_COLLAPSED", false),
    defaultViewLayout: envString("STRIDETERM_DEFAULT_VIEW_LAYOUT", "solo"),
    sidebarResizeMin: envNumber("STRIDETERM_SIDEBAR_RESIZE_MIN", 180),
    sidebarResizeMax: envNumber("STRIDETERM_SIDEBAR_RESIZE_MAX", 500),
    defaultProjectIcon: envString("STRIDETERM_DEFAULT_PROJECT_ICON", "PR"),
    defaultProjectColor: envString("STRIDETERM_DEFAULT_PROJECT_COLOR", "#ffa424"),
    defaultProjectKind: envString("STRIDETERM_DEFAULT_PROJECT_KIND", "terminal"),
    defaultPanelTitle: envString("STRIDETERM_DEFAULT_PANEL_TITLE", "Shell"),
    numberedPanelTitlePrefix: envString("STRIDETERM_NUMBERED_PANEL_TITLE_PREFIX", "Shell"),
    newPanelTitle: envString("STRIDETERM_NEW_PANEL_TITLE", "New Tab"),
    defaultPanelStartup: envString("STRIDETERM_DEFAULT_PANEL_STARTUP", "default"),
    manualPanelStartup: envString("STRIDETERM_MANUAL_PANEL_STARTUP", "manual"),
    defaultProjectCwdPlaceholder: envString("STRIDETERM_PROJECT_CWD_PLACEHOLDER", "~/projects/my-app"),
    recentGitEntriesVisible: envNumber("STRIDETERM_GIT_ENTRIES_VISIBLE", 18),
    terminalForegroundColor: envString("STRIDETERM_TERMINAL_FOREGROUND", "#d8e4f5"),
    qrForegroundColor: envString("STRIDETERM_QR_FOREGROUND", "#d8e4f5"),
    projectAlertTitle: envString("STRIDETERM_PROJECT_ALERT_TITLE", "Completed terminal task"),
  },
};

export function getRendererDevUrl() {
  return `http://${APP_CONFIG.renderer.devHost}:${APP_CONFIG.renderer.devPort}`;
}

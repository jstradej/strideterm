/// <reference types="node" />

function envString(name: string, fallback: string): string {
  const env = typeof process !== "undefined" ? (process.env ?? {}) : {};
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function envNumber(name: string, fallback: number): number {
  const value = Number.parseInt(envString(name, ""), 10);
  return Number.isFinite(value) ? value : fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = envString(name, "");
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const isWindows = typeof process !== "undefined" && process.platform === "win32";

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
    dockerPollMs: envNumber("STRIDETERM_DOCKER_POLL_MS", 30000),
    gitPollMs: envNumber("STRIDETERM_GIT_POLL_MS", 60000),
    projectAlertLimit: envNumber("STRIDETERM_PROJECT_ALERT_LIMIT", 6),
  },
  notifications: {
    promptQuietMs: envNumber("STRIDETERM_PROMPT_QUIET_MS", 2500),
    agentQuietMs: envNumber("STRIDETERM_AGENT_QUIET_MS", 45_000),
    agentQuietFastMs: envNumber("STRIDETERM_AGENT_QUIET_FAST_MS", 25_000),
    alertCooldownMs: envNumber("STRIDETERM_ALERT_COOLDOWN_MS", 15_000),
    userInteractionGraceMs: envNumber("STRIDETERM_USER_INTERACTION_GRACE_MS", 10_000),
    shellIntegration: envBoolean("STRIDETERM_SHELL_INTEGRATION", true),
    agentHook: envBoolean("STRIDETERM_AGENT_HOOK", true),
    debug: envBoolean("STRIDETERM_NOTIFICATIONS_DEBUG", false),
    // Suppress shell-completion alerts globally, leaving agent alerts on.
    // Users opt back in per-panel via PanelState.alertsForceOn.
    agentsOnly: envBoolean("STRIDETERM_NOTIFY_AGENTS_ONLY", true),
    // Opt-in pings when a sub-agent finishes mid-turn (Claude Code
    // SubagentStop). Off by default — only the end-of-turn Stop notifies.
    subagentCompletion: envBoolean("STRIDETERM_NOTIFY_SUBAGENT_COMPLETION", false),
  },
  logging: {
    level: envString("STRIDETERM_LOG_LEVEL", "warn"),
    maxSizeMb: envNumber("STRIDETERM_LOG_MAX_SIZE_MB", 5),
    maxFiles: envNumber("STRIDETERM_LOG_MAX_FILES", 3),
  },
  remoteAccess: {
    // Off by default. Binding the LAN port the moment the app launches means
    // every machine on the user's network can poke at the auth-protected
    // endpoint without the user opting in. Toggle from Settings or via the
    // env var to enable explicitly.
    enabled: envBoolean("STRIDETERM_REMOTE_ENABLED", false),
    host: envString("STRIDETERM_REMOTE_HOST", "0.0.0.0"),
    port: envNumber("STRIDETERM_REMOTE_PORT", 43123),
  },
  session: {
    scrollback: envNumber("STRIDETERM_TERM_SCROLLBACK", 3000),
    termName: envString("STRIDETERM_TERM_NAME", "xterm-color"),
    termProgram: envString("STRIDETERM_TERM_PROGRAM", "strideterm"),
    forceColor: envString("STRIDETERM_FORCE_COLOR", "1"),
    defaultCols: envNumber("STRIDETERM_TERM_COLS", 120),
    defaultRows: envNumber("STRIDETERM_TERM_ROWS", 34),
    minCols: envNumber("STRIDETERM_TERM_MIN_COLS", 20),
    minRows: envNumber("STRIDETERM_TERM_MIN_ROWS", 8),
    replayMaxChars: envNumber("STRIDETERM_TERM_REPLAY_MAX_CHARS", 200_000),
    shellLaunchDelayMs: envNumber("STRIDETERM_SHELL_LAUNCH_DELAY_MS", 50),
    windowsShellFile: envString("STRIDETERM_WINDOWS_SHELL", "pwsh.exe"),
    windowsShellArgs: Object.freeze(["-NoLogo"] as const),
    posixShellFile: envString("STRIDETERM_POSIX_SHELL", "/bin/bash"),
    posixShellArgs: Object.freeze(["-l"] as const),
  },
  terminal: {
    // Windows GPU drivers have produced native Electron access violations
    // while disposing xterm's WebGL renderer during rapid workspace deletion.
    // Keep the safer DOM renderer by default on Windows; users can opt back
    // in with STRIDETERM_DISABLE_WEBGL=0. Other platforms keep WebGL enabled
    // unless the env var or --no-webgl disables it.
    disableWebgl: envBoolean("STRIDETERM_DISABLE_WEBGL", isWindows),
  },
  ssh: {
    defaultKeepaliveMs: envNumber("STRIDETERM_SSH_KEEPALIVE_MS", 30000),
    defaultConnectTimeoutMs: envNumber("STRIDETERM_SSH_CONNECT_TIMEOUT_MS", 20000),
    agentPath: envString("STRIDETERM_SSH_AGENT", ""),
    preferAgent: envBoolean("STRIDETERM_SSH_PREFER_AGENT", true),
    certExpiryWarnHours: envNumber("STRIDETERM_SSH_CERT_WARN_HOURS", 2),
    systemSshPath: envString("STRIDETERM_SSH_BINARY", ""),
    wslDefaultDistro: envString("STRIDETERM_SSH_WSL_DISTRO", ""),
    wslSshExec: envString("STRIDETERM_SSH_WSL_EXEC", "ssh"),
    requireEncryptedStorage: envBoolean("STRIDETERM_SSH_REQUIRE_ENCRYPTED_STORAGE", true),
  },
  git: {
    recentLogLimit: envNumber("STRIDETERM_GIT_LOG_LIMIT", 100),
    logPageSize: envNumber("STRIDETERM_GIT_LOG_PAGE_SIZE", 100),
    lazygitWingetPackagePrefix: envString("STRIDETERM_LAZYGIT_WINGET_PREFIX", "JesseDuffield.lazygit_"),
    // Min interval between shell-triggered (OSC 133;D) git refreshes per
    // workspace. Leading-edge: a human typing commands after a pause never
    // waits; an agent's mid-turn OSC storm is squashed to ≤1 refresh/interval.
    // Set to 0 to restore the old per-OSC behavior without a code change.
    shellRefreshMinIntervalMs: envNumber("STRIDETERM_SHELL_GIT_REFRESH_MIN_INTERVAL_MS", 10_000),
  },
  tunnel: {
    mode: envString("STRIDETERM_TUNNEL_MODE", "quick"),
    connectTimeoutMs: envNumber("STRIDETERM_TUNNEL_CONNECT_TIMEOUT_MS", 20000),
    binaries: Object.freeze(
      envString("STRIDETERM_TUNNEL_BINARIES", "").split(",").filter(Boolean).length > 0
        ? envString("STRIDETERM_TUNNEL_BINARIES", "")
            .split(",")
            .map((s) => s.trim())
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

export function getRendererDevUrl(): string {
  return `http://${APP_CONFIG.renderer.devHost}:${APP_CONFIG.renderer.devPort}`;
}

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

/** Like [envNumber], but says whether the variable was SET rather than substituting a default. */
function envOptionalNumber(name: string): number | null {
  const raw = envString(name, "");
  if (!raw) {
    return null;
  }

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 && value < 65536 ? value : null;
}

function envBoolean(name: string, fallback: boolean): boolean {
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
    // Answer Claude Code permission prompts automatically. OFF by default —
    // this is equivalent to running the agent without permission prompts, and
    // arming it must always be an explicit act by the local user.
    autoApprovePermissions: envBoolean("STRIDETERM_NOTIFY_AUTO_APPROVE", false),
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
    // The same variable again, kept separately because the two answer different questions: `port`
    // above is the default a FRESH settings file is seeded with, while this says the variable was
    // set explicitly and must win over whatever a settings file already holds. See
    // `resolveRemoteAccessPort` for why that distinction turned out to matter.
    portOverride: envOptionalNumber("STRIDETERM_REMOTE_PORT"),
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
    // WebGL terminal renderer, enabled by default on every platform. It offloads
    // glyph rendering to the GPU; the DOM-renderer fallback runs on the renderer's
    // main thread and its per-row cost scales with live terminals — long-running /
    // many concurrent agents can saturate a core and jank the whole UI. The real
    // xterm WebglAddon activation is the capability check and falls back to DOM
    // when it fails; remote/mobile clients skip WebGL separately (isRemote guard).
    // Opt out with STRIDETERM_DISABLE_WEBGL=1 / --no-webgl.
    // The historical Windows access violation on rapid workspace deletion is
    // mitigated by disposing the addon in a controlled order (see pruneTerminalViews).
    disableWebgl: envBoolean("STRIDETERM_DISABLE_WEBGL", false),
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

/**
 * The port the remote server should actually bind, given whatever the settings file holds.
 *
 * WHY THIS IS NOT JUST `settings.remoteAccess.port`. `STRIDETERM_REMOTE_PORT` was read in exactly
 * one place: as the default for a settings file that does not exist yet. So it worked on a first
 * run and silently did nothing ever after — while `dev.ps1` sets it to 43124 precisely so a dev
 * build can run beside a production install, and the tunnel's own failure message tells the user to
 * "change STRIDETERM_REMOTE_PORT, then restart". Both promised an override that was not there.
 *
 * Observed for real: a production install held 0.0.0.0:43123, the dev build's settings file (its own
 * data dir, from an earlier run) also said 43123, and the dev build's remote server bound nothing at
 * all — the paired phone got `desktopRefused` with `EADDRINUSE: address already in use
 * 0.0.0.0:43123` and no way to act on it, because the documented lever was inert.
 *
 * The variable now wins. It is deliberately NOT written back into the settings file: an override
 * that persists is one a user cannot undo by unsetting it, and this one exists to be temporary.
 */
export function resolveRemoteAccessPort(saved?: number | null): number {
  if (APP_CONFIG.remoteAccess.portOverride !== null) {
    return APP_CONFIG.remoteAccess.portOverride;
  }

  return typeof saved === "number" && Number.isFinite(saved) && saved > 0 ? saved : APP_CONFIG.remoteAccess.port;
}

/// <reference types="node" />
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { watch, existsSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFile, writeFile, mkdir, readdir, access, rm, rename, lstat, realpath, cp } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";
import * as fm from "./file-manager.js";
import { SessionManager } from "./session-manager.js";
import { TerminalReplayStore } from "./terminal-replay-buffer.js";
import {
  createAccessToken,
  createSessionId,
  normalizeWorkspace,
  normalizeWorkspaceGrid,
  parseSessionId,
} from "./default-state.js";
import { parseRemoteViewerId } from "./viewer-id.js";
import {
  NOTIFICATION_TARGET_REMOVED_CHANNEL,
  type NotificationTargetRemoved,
} from "../shared/notification-lifecycle.js";
import { APPROVAL_RECORDED_CHANNEL, type ApprovalRecorded } from "../shared/approval-events.js";
import { filterConnectionsByOpenProfiles } from "./shared/runtime-provider-guards.js";
import { execFileText } from "./process-utils.js";
import { DockerManager } from "./docker-manager.js";
import { DockerLogManager } from "./docker-log-streamer.js";
import { DockerShellManager } from "./docker-shell-streamer.js";
import { GitManager } from "./git-manager.js";
import { CloudflareTunnelManager, canReconnectTunnel } from "./tunnel-manager.js";
import { createPluginManager } from "./plugin-loader.js";
import { createCredentialStore } from "./credential-store.js";
import { createAzureReviewStore } from "./azure-review-store.js";
import { createReviewBridgeStore } from "./review-bridge-store.js";
import { createAzureAuditLogStore } from "./azure-audit-log-store.js";
import { createGitAuditLogStore } from "./git-audit-log-store.js";
import { buildReviewAgentLaunch, buildMcpServerSpec } from "./review-bridge-agent-launch.js";
import { AzureDevOpsManager } from "./azure-devops-manager.js";
import { GitHubManager } from "./github-manager.js";
import { createGitHubAuditLogStore } from "./github-audit-log-store.js";
import { TelegramManager } from "./telegram-manager.js";
import { createTelegramAuditLogStore } from "./telegram-audit-log-store.js";
import { createApprovalAuditLogStore } from "./approval-audit-log-store.js";
import { MobileManager, type PairingRejectionReason } from "./mobile/mobile-manager.js";
import { createMobilePairing } from "./mobile/mobile-pairing.js";
import {
  createMobileDeviceStore,
  deviceAllowsProfile as mobileDeviceAllowsProfile,
  deviceHasCapability as mobileDeviceHasCapability,
  isDeviceUsable as isMobileDeviceUsable,
} from "./mobile/mobile-device-store.js";
import { createMobileIdempotencyStore } from "./mobile/mobile-idempotency-store.js";
import { createMobileAuditLogStore } from "./mobile/mobile-audit-log-store.js";
import { createMobileCommandDispatcher, type MobileCommandRuntime } from "./mobile/mobile-command-dispatch.js";
import { createMobileNotificationOriginStore } from "./mobile/mobile-notification-origin-store.js";
import { createMobileWebSessionTicketStore } from "./mobile/mobile-web-session-ticket-store.js";
import { createFirebaseMobileTransport } from "./mobile/mobile-firebase-transport-rest.js";
import { createMobileFirebaseRestClient } from "./mobile/mobile-firebase-rest.js";
import { createInstallationTokenRefreshListener } from "./account/installation-token-refresh.js";
import { loadRelayInstallationIdentity } from "./mobile/mobile-relay-identity.js";
import { AccountManager } from "./account/account-manager.js";
import {
  newIdentityIsRefused,
  parseInstallationBinding,
  type InstallationBindingMarker,
  type InstallationBindingState,
} from "./account/account-binding.js";
import { applyEpochTransition } from "./mobile/epoch-transition.js";
import type { AccountUiState } from "./account/account-state.js";
import { createAccountClient } from "./account/account-client.js";
import { resolveAuthLinkConfig } from "./account/authlink-config.js";
import { EmailSignInBroker, type SignInPurpose } from "./account/email-signin-broker.js";
import { AccountCallableError, createAccountTransport } from "./account/account-transport.js";
import { resolveMobileFirebaseConfig, type MobileFirebaseConfig } from "./mobile/mobile-firebase-config.js";
import { resolveBootstrapFirebaseConfig, createControlPlaneBootstrapClient } from "./mobile/bootstrap-client.js";
import { BOOTSTRAP_ENV_VARS, bootstrapEnvironmentFor, bootstrapTrustSet } from "./mobile/bootstrap-trust.js";
import type { BootstrapEnvironment } from "./mobile/control-plane-bootstrap.js";
import { bindDataDirToEnvironment } from "./mobile/data-dir-environment.js";
import { FUNCTIONS_REGION } from "./mobile/mobile-rtdb-paths.js";
import type { MobileFirebaseTransport } from "./mobile/mobile-firebase-transport.js";
import {
  createMobileRelayManager,
  type MobileRelayManager,
  type MobileRelayStatus,
  type RelayOriginStarter,
} from "./mobile/mobile-relay-manager.js";
import {
  computeKeyProof,
  decodeCanonicalPublicKey,
  deriveSessionKey,
  exportRawPublicKey,
  generateX25519KeyPair,
  exportPrivateKeyPem,
  importPrivateKeyPem,
  keyProofsEqual,
  publicKeyFromRaw,
} from "./mobile/mobile-crypto.js";
import { PROTOCOL_VERSION, SESSION_KEY_HKDF_INFO, type MobileDeviceRecord } from "./mobile/mobile-schemas.js";
import { buildExternalNotificationEvent } from "./notifications/external-notification-event.js";
import {
  buildNotificationBody,
  notificationSummary,
  recentTerminalExcerpt,
} from "./notifications/notification-context.js";
import { startNotifyServer, generateNotifySecret, buildNotifyUrl } from "./notify-server.js";
import { createNotifyUrlRegistry } from "./notify-url-registry.js";
import {
  ensureNotifyScript,
  configureClaudeHook,
  removeClaudeHook,
  detectClaudeHookStatus,
} from "./claude-hook-config.js";
import { configureGeminiHook, removeGeminiHook, detectGeminiHookStatus } from "./gemini-hook-config.js";
import { configureCodexHook, removeCodexHook, detectCodexHookStatus } from "./codex-hook-config.js";
import { configureCopilotHook, removeCopilotHook, detectCopilotHookStatus } from "./copilot-hook-config.js";
import {
  configureOpencodeHook,
  removeOpencodeHook,
  detectOpencodeHookStatus,
  migrateLegacyOpencodeHooks,
} from "./opencode-hook-config.js";
import { AgentTaskRunner, COMPANION_ROLE_DISPLAY_NAMES } from "./agent-task-runner.js";
import type { RecoveryCandidate } from "../shared/types/state.js";
import { getProvider } from "./providers/provider-registry.js";
import { classifyHookEvent } from "./notifications/classifier.js";
import { CodexTerminalNotifications } from "./notifications/codex-terminal-notifications.js";
import { decideAutoApprove, summarizePermissionRequestParts } from "./notifications/auto-approve.js";
import type { RemoteClientRegistry } from "./remote-client-registry.js";
import {
  classifyCommand,
  allowT3ForCommandClass,
  allowExitAlertForCommandClass,
} from "./notifications/command-classifier.js";
import { hasRecentAnimation } from "./notifications/detector-signals.js";
import {
  recordInteraction as adaptiveRecordInteraction,
  recordDismissed as adaptiveRecordDismissed,
  forget as adaptiveForget,
  adaptiveMultiplier,
  isT3Disabled,
} from "./notifications/adaptive.js";
import {
  recordAlert as metricsRecordAlert,
  recordHook as metricsRecordHook,
  recordDismissedWithoutInteraction as metricsRecordDismissed,
  getMetrics,
} from "./notifications/metrics.js";
import { createProviderHandlers } from "./runtime-provider-handlers.js";
import { createGitHandlers } from "./runtime-git-handlers.js";
import { createDockerHandlers } from "./runtime-docker-handlers.js";
import { createGridHandlers } from "./runtime-grid-handlers.js";
import { createTelegramDispatch } from "./runtime-telegram-dispatch.js";
import { createTaskHandlers } from "./runtime-task-handlers.js";
import { createProviderLifecycle } from "./runtime-provider-lifecycle.js";
import { insertWorkspace } from "./workspace-order.js";
import { createSshHandlers } from "./ssh/runtime-ssh-handlers.js";
import { SshManager } from "./ssh/ssh-manager.js";
import {
  clone,
  findWorkspace,
  markWorkspaceWorked,
  createAttentionContext,
  stripAnsi,
  lastNonEmptyLine,
  matchesPrompt,
  matchesShellPromptStrict,
  matchesAgentIdle,
  matchesWaitingPattern,
  looksLikeShellPrompt,
  createSessionSignal,
  PENDING_PERMISSION_TTL_MS,
  MAX_PENDING_PERMISSIONS,
  type PendingPermission,
  detectTerminalEnvironment as detectTerminalEnvironmentImpl,
  OSC133_COMMAND_FINISHED_RE,
  OSC133_COMMAND_START_RE,
  AGENT_NAME_RE,
  AGENT_OUTPUT_RE,
  AGENT_OUTPUT_BURST_THRESHOLD,
  detectRateLimit,
  HOOK_FALLBACK_SILENCE_MS,
  ATTENTION_MIN_DISPLAY_MS,
  ATTENTION_VISIBILITY_GRACE_MS,
  waitForHandleRelease,
  shouldRefreshNow,
  createIntervalGate,
} from "./runtime-utils.js";
import { APP_CONFIG, resolveRemoteAccessPort } from "../../config/app-config.js";
// @ts-ignore — version-checker.js will be migrated in a later phase
import { createVersionChecker } from "./version-checker.js";
import { initLogger, getLogger, setLogLevel, reconfigureLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { createRuntimeAttentionManager } from "./runtime-attention.js";
import type { AppState, WorkspaceState } from "../shared/types/state.js";
import { formatWorkspaceDisplayName } from "../shared/workspace-display.js";
import { isCompanionPrimaryHosted } from "../shared/companion-primary.js";
import { sessionIdFor } from "../shared/task-states.js";
import { hasMeaningfulUserInput } from "../shared/terminal-input.js";
import type { NotifyServerHandle } from "./notify-server.js";

const log = getLogger("runtime");

const require = createRequire(import.meta.url);
// Walk up from this file to the nearest package.json. The relative depth differs
// between the TS source (electron/backend/) and the compiled output
// (dist-electron/electron/backend/), so a fixed "../../package.json" only works
// in one of those layouts.
function resolvePackageJsonPath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Could not locate package.json from runtime.ts");
    dir = parent;
  }
}
const { version: packageVersion = "0.0.0" } = require(resolvePackageJsonPath());
const reviewBridgeCliPath = fileURLToPath(new URL("./review-bridge-cli.js", import.meta.url));

// Utilities imported from runtime-utils.js

// `hasMeaningfulUserInput` lives in electron/shared so the renderer can apply
// the exact same "did the user actually type here?" rule when deciding whether
// a write acknowledges a session's notification. Re-exported here because
// existing importers (and runtime.test.ts) pull it from runtime.js.
export { hasMeaningfulUserInput };

/**
 * The loopback URL of the remote server this process is running: what the tunnel publishes and what
 * the reachability probe checks.
 *
 * Exported for its own test. The PORT goes through `resolveRemoteAccessPort`, and that is not
 * cosmetic: with `STRIDETERM_REMOTE_PORT` set, the port in settings and the port actually bound are
 * different numbers, and a tunnel built from the stored one publishes SOMEBODY ELSE'S SERVER.
 * Observed end to end — a dev build bound 43124, built its tunnel for 127.0.0.1:43123, and 43123 was
 * the production install; the paired phone therefore opened a remote session against a server that
 * had never issued its cookie, and every session ended the instant it opened ("This session has
 * ended", ST-RMT-04). Fixed here rather than at the two call sites so a third one cannot get it
 * wrong.
 */
export function createTunnelOriginUrl(remoteConfig: { host?: string; port?: number } = {}): string {
  const rawHost = String(remoteConfig.host || "").trim();
  const host =
    !rawHost || rawHost === "0.0.0.0" ? "127.0.0.1" : rawHost === "::" || rawHost === "[::]" ? "::1" : rawHost;
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${resolveRemoteAccessPort(remoteConfig.port)}`;
}

// Re-export for consumers that import from runtime.js
export { detectTerminalEnvironmentImpl as detectTerminalEnvironment };

function probeRemoteOrigin(originUrl: string, timeoutMs = 1200): Promise<number> {
  const target = new URL(originUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: "/",
        method: "GET",
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode || 0));
      },
    );

    request.once("timeout", () => {
      request.destroy(new Error("timed out"));
    });
    request.once("error", reject);
    request.end();
  });
}

async function checkRemoteOrigin(
  originUrl: string,
  { attempts = 16, delayMs = 250, timeoutMs = 1200 }: { attempts?: number; delayMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const probeLog = getLogger("runtime");
  let lastError: unknown = null;

  probeLog.debug("checkRemoteOrigin: probing origin", { originUrl, attempts, delayMs, timeoutMs });

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const statusCode = await probeRemoteOrigin(originUrl, timeoutMs);
      probeLog.debug("checkRemoteOrigin: origin reachable", { originUrl, attempt, statusCode });
      return originUrl;
    } catch (error) {
      lastError = error;
      const errCode = (error as NodeJS.ErrnoException)?.code;
      probeLog.trace("checkRemoteOrigin: attempt failed", {
        originUrl,
        attempt,
        errCode,
        errMessage: (error as Error)?.message,
      });
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  const lastErrCode = (lastError as NodeJS.ErrnoException)?.code;
  const lastErrMessage = (lastError as Error)?.message;
  probeLog.warn("checkRemoteOrigin: all probe attempts failed", {
    originUrl,
    attempts,
    lastErrCode,
    lastErrMessage,
  });

  throw new Error(
    `Remote access origin ${originUrl} is not responding${lastErrMessage ? ` (${lastErrMessage})` : ""}.`,
  );
}

const WINDOWS_RESERVED_DIRECTORY_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);
export function isValidNativeDirectoryName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    !value.includes("\\") &&
    !value.includes("/") &&
    !value.includes("\0") &&
    !value.includes(":") &&
    value !== "." &&
    value !== ".." &&
    !/[. ]$/.test(value) &&
    !WINDOWS_RESERVED_DIRECTORY_NAMES.has(value.split(".", 1)[0].toLowerCase())
  );
}

function assertProfileExists(state: AppState, profileId: string): void {
  if (!profileId || !(state.profiles || []).some((profile) => profile.id === profileId)) {
    throw new Error("Profile not found");
  }
}

function assertContainedPath(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the managed directory");
  }
  return resolved;
}

function assertNativePath(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    /^[a-zA-Z]:[^\\/]/.test(value) ||
    value.startsWith("\\\\.\\")
  ) {
    throw new Error("Invalid absolute path");
  }
  return path.resolve(value);
}

interface RuntimeDependencies {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createStore?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCredentialStore?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createAzureReviewStore?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createReviewBridgeStore?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SessionManager?: new (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DockerManager?: new (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GitManager?: new (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CloudflareTunnelManager?: new (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AzureDevOpsManager?: new (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GitHubManager?: new (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MobileManager?: new (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createMobileFirebaseTransport?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createPluginManager?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execFileText?: (...args: any[]) => any;
  /**
   * Starts the managed relay's loopback-only internal origin.
   *
   * Injected rather than imported so this module never pulls in remote-server.ts (which would be a
   * cycle), and so a build that has not wired one simply HAS no relay: without this dependency the
   * relay manager is not constructed at all, whatever the setting says.
   */
  startRelayOrigin?: RelayOriginStarter;
  rmPath?: (dirPath: string) => Promise<void>;
  checkRemoteOrigin?: typeof checkRemoteOrigin;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTerminalEnvironment?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  safeStorage?: any;

  fetchImpl?: typeof fetch;

  /**
   * Returns a PNG buffer of the current Electron window. Wired in main.ts via
   * `mainWindow.webContents.capturePage().toPNG()`. Optional — Telegram
   * `📸 Screenshot` falls back to an error message if not provided (e.g. in
   * the headless remote-only build or in tests). Workspace-targeted captures
   * just call activateWorkspace before invoking this.
   */
  captureMainWindowPng?: (windowId?: string) => Promise<Buffer>;

  /**
   * Ensure a desktop window exists for `profileId`, returning its `windowId`.
   * Implementation contract (see main.ts):
   *  - If a window already owns the profile, focus it and return its id.
   *  - Otherwise create a new window slot for the profile, spawn its
   *    BrowserWindow, wait for the renderer to finish loading, and return
   *    the new id.
   *
   * Used by Telegram command dispatch so a click on a notification for a
   * profile that isn't currently open just-works instead of erroring out.
   * Returns null when window creation fails (e.g. headless / test runtime
   * without the Electron dep injected) — callers fall back to the legacy
   * "abort with chat error" path.
   */
  ensureWindowForProfile?: (profileId: string) => Promise<string | null>;
}

export async function createRuntime({
  userDataPath,
  builtinPluginsDir,
  deferInitialRefresh = false,
  dependencies = {},
}: {
  userDataPath: string;
  builtinPluginsDir?: string;
  deferInitialRefresh?: boolean;
  dependencies?: RuntimeDependencies;
}) {
  // Logger must init before anything else logs
  initLogger();
  log.info("createRuntime starting", { userDataPath, deferInitialRefresh });

  // Forward reference populated at the end of createRuntime() so async
  // handlers (e.g. Telegram command dispatch) can call runtime methods.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _rt: any = null;

  // Injected by startRemoteServer after the HTTP server starts.
  //
  // There can be MORE THAN ONE, and that is the whole reason this is a set rather than a reference.
  // The user's LAN/tunnel listener and the managed relay's internal loopback origin are two
  // instances of the same server on one runtime, and each keeps its OWN RemoteClientRegistry —
  // which is what gives a mobile viewer its own profile/workspace/tab state (relay plan §4). So
  // every per-client operation has to be routed to the registry that actually holds that client:
  // resolving it through one global reference sent a relay viewer's activation to the browser's
  // registry, or — with no LAN listener enabled, which is the ordinary case for a relay user — to
  // nothing at all, and `getWindowProfileId` then answered "unknown viewer", which every
  // `assertWorkspaceInViewerProfile` reads as "no guard to apply".
  const _remoteClientRegistries = new Set<RemoteClientRegistry>();
  /** The primary (LAN/tunnel) server's registry, replaced rather than accumulated when it restarts. */
  let _primaryRemoteClientRegistry: RemoteClientRegistry | null = null;

  /** The registry holding `clientId`, or null when no live remote client has that id. */
  function registryOwning(clientId: string | undefined | null): RemoteClientRegistry | null {
    if (!clientId) return null;
    for (const registry of _remoteClientRegistries) {
      if (registry.get(clientId)) return registry;
    }
    return null;
  }

  /**
   * Same, for the operations that cannot proceed without one. The message names the SESSION rather
   * than the registry: with more than one server, "no registry" is never the interesting case — an
   * id no live registry knows is a client that has expired or never existed.
   */
  function requireRemoteClientRegistry(clientId: string): RemoteClientRegistry {
    const registry = registryOwning(clientId);
    if (!registry) throw new Error("Remote client session not found");
    return registry;
  }

  // Injected by the IPC layer (setExternalUrlOpener), because `shell.openExternal` is Electron's
  // and the runtime is constructed before the IPC layer registers. Absent it, a checkout simply does
  // not open — which is what a headless test wants, and is never a silent success.
  let _externalUrlOpener: ((url: string) => Promise<void>) | null = null;

  // Injected by startRemoteServer (setMobileRemoteSessionRevoker) once the
  // remote HTTP server's session registry exists. remote-server.ts isn't
  // constructed until after createRuntime() returns (main.ts starts it
  // afterwards), so MobileManager.revokeDevice() reaches it through this
  // mutable indirection instead of a direct reference — same forward-
  // reference shape as `_rt` above.
  let _mobileRemoteSessionRevoker: ((deviceId: string) => void) | null = null;

  // --- Terminal input lease (multi-viewer sessions) ---
  // A PTY session may be VIEWED by any number of windows / remote clients,
  // but typed input has a single runtime-only owner: the last viewer that
  // typed. The lease has a short TTL renewed on every meaningful keystroke;
  // another viewer's typing is blocked (the UI offers "Take control?")
  // instead of silently interleaving two users' keystrokes into the same
  // terminal — which a task agent could misread as user intervention.
  // Internal writers (task runner prompts) bypass the lease entirely.
  const INPUT_LEASE_TTL_MS = 45_000;
  const sessionInputLeases = new Map<string, { viewerId: string; expiresAt: number }>();

  // --- Work stamping from real typing ---
  // Typing into a session is the strongest "the user works here" signal there
  // is, so accepted viewer input stamps `lastWorkedAt`. Activation does NOT:
  // you can leave a workspace open for hours in another window while actually
  // typing in this one. Every keystroke goes through writeToSession and every
  // store.mutate persists the state file, so the stamp is throttled per
  // workspace. A minute of granularity is invisible in a sidebar that renders
  // ages in whole minutes and cuts off at 24 hours.
  const TYPING_STAMP_INTERVAL_MS = 60_000;
  const lastTypingStampAt = new Map<string, number>();

  const createStoreImpl = dependencies.createStore || createStore;
  const createCredentialStoreImpl = dependencies.createCredentialStore || createCredentialStore;
  const createAzureReviewStoreImpl = dependencies.createAzureReviewStore || createAzureReviewStore;
  const createReviewBridgeStoreImpl = dependencies.createReviewBridgeStore || createReviewBridgeStore;
  const SessionManagerImpl = dependencies.SessionManager || SessionManager;
  const DockerManagerImpl = dependencies.DockerManager || DockerManager;
  const GitManagerImpl = dependencies.GitManager || GitManager;
  const TunnelManagerImpl = dependencies.CloudflareTunnelManager || CloudflareTunnelManager;
  const AzureDevOpsManagerImpl = dependencies.AzureDevOpsManager || AzureDevOpsManager;
  const GitHubManagerImpl = dependencies.GitHubManager || GitHubManager;
  const createPluginManagerImpl = dependencies.createPluginManager || createPluginManager;
  const execFileTextImpl = dependencies.execFileText || execFileText;
  const rmPathImpl = dependencies.rmPath ?? null;

  // Forward-declare plugin manager so getPayload() can read it safely even
  // when broadcastState() fires via queueMicrotask during the createRuntime
  // bootstrap (e.g. "logger reconfigured from stored settings" triggers a
  // broadcast while the `await createPluginManagerImpl(...)` below is still
  // pending). Declaring as `const` further down causes a TDZ ReferenceError
  // in those microtasks; a `let` initialized to null lets the nullish check
  // in getPayload do its job until the real manager is assigned.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pluginManager: any = null;

  // Platform-optimized recursive directory removal.
  // On Windows, Node's fs.rm is slow on NTFS due to per-file stat calls. The
  // built-in `rd /s /q` operates at the filesystem driver level and is much
  // faster for large trees.  Falls back to fs.rm on other platforms and when
  // `rd` fails (e.g. path too long, permissions).
  async function rmPath(dirPath: string): Promise<void> {
    if (rmPathImpl) return rmPathImpl(dirPath);
    // On Windows, try the fast native path first (once — if it fails due to
    // locked files, retrying it won't help; let the retry loop use fs.rm which
    // gives us proper EBUSY/EPERM error codes for the backoff logic).
    if (process.platform === "win32") {
      const t0 = Date.now();
      try {
        await execFileTextImpl("cmd.exe", ["/c", "rd", "/s", "/q", dirPath], { timeout: 30_000 });
        log.debug("rmPath: rd /s /q succeeded", { dirPath, ms: Date.now() - t0 });
        return;
      } catch (err) {
        // rd failed (e.g. locked files, long paths) — fall through to fs.rm with retries
        log.debug("rmPath: rd /s /q failed, falling back to fs.rm", {
          dirPath,
          ms: Date.now() - t0,
          err: (err as Error)?.message?.slice(0, 200) || String(err),
        });
      }
    }

    const retryDelays = [300, 600, 1200];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      const t0 = Date.now();
      try {
        await rm(dirPath, { recursive: true, force: true });
        log.debug("rmPath: fs.rm succeeded", { dirPath, attempt, ms: Date.now() - t0 });
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt < retryDelays.length && (code === "EBUSY" || code === "EPERM")) {
          log.debug("rmPath: fs.rm hit lock, retrying", {
            dirPath,
            attempt,
            code,
            ms: Date.now() - t0,
            backoffMs: retryDelays[attempt],
          });
          await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        log.debug("rmPath: fs.rm gave up", {
          dirPath,
          attempt,
          code,
          ms: Date.now() - t0,
          err: (err as Error)?.message?.slice(0, 200),
        });
        throw err;
      }
    }
  }

  const checkRemoteOriginImpl = dependencies.checkRemoteOrigin || checkRemoteOrigin;
  const getTerminalEnvironmentImpl = dependencies.getTerminalEnvironment || detectTerminalEnvironmentImpl;
  const statePath = path.join(userDataPath, "strideterm-state.json");
  const credentialsPath = path.join(userDataPath, "credentials.json");
  const azureReviewPath = path.join(userDataPath, "azure-review.json");
  const reviewBridgeRoot = path.join(userDataPath, "review-bridge");
  const processInfo = {
    execPath: process.execPath,
    argv: process.argv,
    defaultApp: (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp,
  };
  const pluginsDir = path.join(userDataPath, "plugins");
  const [store, credentialStore, azureReviewStore, reviewBridgeStore] = await Promise.all([
    createStoreImpl(statePath),
    createCredentialStoreImpl(credentialsPath, {
      safeStorage: dependencies.safeStorage || null,
    }),
    createAzureReviewStoreImpl(azureReviewPath),
    createReviewBridgeStoreImpl(reviewBridgeRoot),
  ]);

  // Apply persisted log level from stored user config — unless an explicit
  // STRIDETERM_LOG_LEVEL env var is set (explicit ENV > user setting > default
  // "warn"). dev.ps1 exports trace; letting a persisted "error" silently
  // downgrade it left whole debugging sessions without a single log line.
  // A live change via the Settings UI (setLogLevel below) still always applies.
  const storedLogLevel = store.getState().settings?.logLevel;
  if (storedLogLevel && !process.env.STRIDETERM_LOG_LEVEL) {
    reconfigureLogger({ level: storedLogLevel });
    log.info("logger reconfigured from stored settings", { level: storedLogLevel });
  }

  // Populated after taskRunner.init() — see below.
  let _recoveryCandidates: RecoveryCandidate[] = [];

  // ---------------------------------------------------------------------------
  // Notify URL registration.
  //
  // A command hook DOES inherit the environment of the shell it was started
  // from, but that environment is frozen at spawn time: it cannot describe a
  // notify server that later restarted on a different port, and an agent the
  // user launched outside a strIDEterm PTY has none of it. The registry is the
  // live map — notify.mjs prefers the env URL, which names one panel exactly,
  // and falls back here when nothing could be delivered over it.
  //
  // Several installations (exe + dev) share the registry directory, so each
  // one writes only its OWN file; see notify-url-registry.ts for why a single
  // shared document could not be written safely.
  // ---------------------------------------------------------------------------
  const notifyUrlsPath = path.join(userDataPath, "hooks", "notify-urls.json");
  // `STRIDETERM_HOOKS_DIR` relocates the shared registry. It exists so a test
  // (and a sandboxed run) can point both sides of the hook at a scratch
  // directory instead of the developer's real home; nothing in production
  // sets it, and notify.mjs honours the same variable.
  const sharedNotifyHooksDir = process.env.STRIDETERM_HOOKS_DIR || path.join(os.homedir(), ".strideterm-hooks");
  // Stable identity of THIS installation, derived from its data dir. It names
  // the registry file this instance owns, so an instance replaces its own
  // entries on restart without ever touching another installation's — `sid`
  // alone cannot tell two installations apart.
  const instanceId = createHash("sha256").update(userDataPath).digest("hex").slice(0, 12);
  const notifyUrlRegistry = createNotifyUrlRegistry({
    sharedDir: sharedNotifyHooksDir,
    localPath: notifyUrlsPath,
    instanceId,
  });
  // Sweep shards left behind by installations that are gone — a crashed run, a
  // deleted dev data dir, an uninstalled portable copy. Nobody but their owner
  // ever writes them, so without this every hook keeps POSTing at their dead
  // ports for the rest of the machine's life.
  notifyUrlRegistry.pruneExpiredShards();
  // …and keep our own lease current. Writes renew it, but an instance can run
  // for weeks without opening or closing a panel, and a live installation must
  // never look abandoned. Well under the lease TTL, unref'd so it cannot hold
  // the process open.
  const NOTIFY_LEASE_RENEWAL_MS = 6 * 60 * 60_000;
  let notifyLeaseTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    notifyUrlRegistry.renewLease();
  }, NOTIFY_LEASE_RENEWAL_MS);
  notifyLeaseTimer.unref?.();

  // Hook events resolve PRIMARILY via the session id embedded in each notify
  // URL (sid=workspaceId:panelId → workspace → profile). The cwd key below is
  // only the lookup FALLBACK for hook processes whose inherited env cannot be
  // trusted to be current: notify.mjs resolves URLs by project dir and POSTs
  // to each, but every URL still carries its own session id, so two workspaces
  // with the same cwd in different profiles each route to their own workspace
  // — never to the other profile's.
  function registerNotifyUrl(cwd: string, url: string): void {
    notifyUrlRegistry.register(cwd, url);
  }

  /**
   * Drop this instance's registry entry for one session.
   *
   * Without this a closed panel's URL lives on until the whole app stops, and
   * a hook arriving over it would create a fresh signal — and, with
   * auto-approve armed, offer to answer — for a panel the user already
   * removed. Called wherever a session ends: closed panel, deleted workspace,
   * PTY exit.
   */
  function unregisterNotifyUrl(sessionId: string): void {
    notifyUrlRegistry.unregister(sessionId);
  }

  /**
   * Re-register notify URLs for every live PTY session. Called right after
   * the notify server starts: entries are otherwise only written at session
   * spawn (getSessionEnv), so a server (re)start — app restart with a new
   * port, or the agentHook setting toggled off/on — would leave hooks
   * POSTing to a dead port until each session happened to respawn. Claude
   * Code's notify.mjs reads the registry per event and merges it with the
   * (now stale) env URL, so refreshing here heals those sessions immediately,
   * without restarting the terminal.
   */
  function refreshNotifyUrls(): void {
    const port = notifyServerHandle?.port;
    if (!port) return;
    const state = getState();
    let count = 0;
    for (const sessionId of sessions.sessions.keys()) {
      const descriptor = parseSessionId(sessionId);
      if (!descriptor) continue;
      const workspace = findWorkspace(state, descriptor.workspaceId) as WorkspaceState | null;
      if (!workspace?.cwd) continue;
      registerNotifyUrl(workspace.cwd, buildNotifyUrl(port, sessionId, notifySecret));
      count += 1;
    }
    if (count > 0) {
      log.info("notify-urls refreshed for live sessions", { count, port });
    }
  }

  /** Remove all URLs belonging to our notify server port (called on shutdown). */
  function cleanupNotifyUrls(port: number): void {
    notifyUrlRegistry.cleanupPort(port);
  }

  /**
   * Per-PTY ownership tokens.
   *
   * Hook routing is by project directory, which proves nothing: a `claude` the
   * user started in a plain terminal inside the same repository, a second
   * panel with the same `cwd`, and a dev instance running beside prod all
   * reach the same responder. The token closes that gap — it is minted here,
   * injected into the terminal strIDEterm spawns as `STRIDETERM_SESSION_TOKEN`,
   * and a hook process that inherited that environment can echo it back. Only
   * a request carrying the right token for the session it addresses is allowed
   * to be auto-approved.
   *
   * Nothing else depends on it: alerts keep working over plain cwd routing,
   * because getting a notification for the wrong panel is a cosmetic problem
   * and answering a permission prompt for the wrong panel is not.
   */
  const sessionOwnershipTokens = new Map<string, string>();

  function getSessionOwnershipToken(sessionId: string): string {
    let token = sessionOwnershipTokens.get(sessionId);
    if (!token) {
      token = randomUUID();
      sessionOwnershipTokens.set(sessionId, token);
    }
    return token;
  }

  /**
   * Everything that must happen when a session stops existing: its alert
   * signal goes, its ownership token goes, and — the part that used to be
   * missing — its notify URL leaves the registry. A stale URL would otherwise
   * survive until the whole app stopped, letting a hook re-create a signal for
   * a panel the user already closed.
   */
  function retireSession(sessionId: string): void {
    deleteSessionSignal(sessionId);
    sessionOwnershipTokens.delete(sessionId);
    unregisterNotifyUrl(sessionId);
    // An offer this panel made is void the moment the panel stops existing.
    discardPermissionOffers((record) => record.sessionId === sessionId, "session-retired");
  }

  const sshManager = new SshManager({ store, credentialStore, logger: log });

  const sessions = new SessionManagerImpl({
    sshManager,
    getSessionEnv: ({
      workspace,
      sessionId,
    }: {
      workspace: WorkspaceState | null | undefined;
      sessionId: string | null | undefined;
    }) => {
      const env: Record<string, string> = {};

      // Set provider-specific environment variables for task workspace sessions.
      // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS is Claude-specific — only inject it
      // for Claude provider sessions, not Codex or Gemini.
      if (workspace?.kind === "task" && workspace.task) {
        const panelId = sessionId ? sessionId.split(":").pop() : "";
        const isWorker = panelId === workspace.task.workerPanelId;
        const providerConfig = isWorker
          ? workspace.task.workerProviderConfig || { providerId: "claude" }
          : workspace.task.judgeProviderConfig || { providerId: "claude" };
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const provider = getProvider(providerConfig.providerId as any);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          Object.assign(env, provider.getEnvironment(providerConfig as any));
        } catch {
          // Unknown provider — fall back to Claude defaults for backward compat
          env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
        }
      }

      // Ownership proof for the auto-approve path — see sessionOwnershipTokens.
      //
      // Minted whether or not the notify server happens to be running. A PTY
      // spawned while the agent-hook setting was off would otherwise never
      // carry a token, and turning the hook on afterwards cannot change the
      // environment of a shell that already started: the registry would route
      // its hooks correctly and `decideAutoApprove` would then refuse every
      // one of them as `unproven-session` until the user restarted the
      // terminal — a failure with no visible cause. The token proves identity;
      // it grants nothing on its own.
      if (sessionId) {
        env.STRIDETERM_SESSION_TOKEN = getSessionOwnershipToken(sessionId);
      }

      // Agent notification hook URL — set in env (for agents that read it
      // directly, e.g. the OpenCode plugin) AND written to the notify-URL
      // registry, which is what notify.mjs merges with the env value. The env
      // copy is a snapshot; the registry is the live map.
      if (notifyServerHandle?.port && sessionId) {
        const notifyUrl = buildNotifyUrl(notifyServerHandle.port, sessionId, notifySecret);
        env.STRIDETERM_NOTIFY_URL = notifyUrl;
        log.debug("injected STRIDETERM_NOTIFY_URL", { sessionId, port: notifyServerHandle.port });
        if (workspace?.cwd) {
          registerNotifyUrl(workspace.cwd, notifyUrl);
        }
      } else if (sessionId) {
        // Not a dead end: refreshNotifyUrls() registers this session the
        // moment the server starts, and the hook resolves it from there.
        log.debug("STRIDETERM_NOTIFY_URL not injected (notify server not running)", { sessionId });
      }

      if (!["azure-devops", "github"].includes(workspace?.review?.provider ?? "") || !workspace?.review?.prKey) {
        return env;
      }

      const context = reviewBridgeStore.getPullRequestContext?.(workspace.review!.prKey!);
      if (!context) {
        return env;
      }

      return {
        ...env,
        STRIDETERM_REVIEW_PROVIDER: context.provider || workspace.review!.provider || "azure-devops",
        STRIDETERM_REVIEW_PR_KEY: context.prKey,
        STRIDETERM_REVIEW_ROOT: context.rootPath,
        STRIDETERM_REVIEW_DB: context.databasePath,
        STRIDETERM_REVIEW_STORE_DIR: context.exportDir,
        STRIDETERM_REVIEW_EXPORT_DIR: context.exportDir,
        STRIDETERM_REVIEW_BRIEF_MD: context.briefMarkdownPath,
        STRIDETERM_REVIEW_BRIEF_JSON: context.briefJsonPath,
        STRIDETERM_REVIEW_CLI: reviewBridgeCliPath,
        STRIDETERM_REVIEW_WORKSPACE_ID: workspace.id,
      };
    },
    getSessionLaunch: ({ workspace, panel }: { workspace: WorkspaceState | null | undefined; panel: unknown }) => {
      // --- Review workspace: inject MCP bridge ---
      if (!["azure-devops", "github"].includes(workspace?.review?.provider ?? "")) {
        return null;
      }

      let context = workspace!.review!.prKey
        ? reviewBridgeStore.getPullRequestContext?.(workspace!.review!.prKey)
        : null;

      if (!context) {
        const rootPath = reviewBridgeStore.getRootPath?.() || "";
        if (!rootPath) return null;
        context = { rootPath, workspaceId: workspace!.id, prKey: "" };
      }

      return buildReviewAgentLaunch({
        workspace: workspace as WorkspaceState,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        panel: panel as any,
        context,
        processInfo,
      });
    },
  });

  // sessions.ensureSession(...) is fire-and-forget at several call sites
  // (activating a session/workspace, opening a lazydocker/lazygit/docker-shell
  // panel). A rejection there — bad SSH args, a launch callback throwing —
  // otherwise only reaches the global unhandled-rejection handler with no
  // sessionId context, and the affected panel silently shows "0 running"
  // with no diagnostic trail. Mirrors the pattern already used by
  // ensureVisibleSession in runtime-attention.ts.
  function ensureSessionSafe(sessionId: string): void {
    sessions.ensureSession(getState(), sessionId).catch((err: unknown) => {
      log.error("ensureSession failed", { sessionId, err: (err as Error)?.message || String(err) });
    });
  }

  const auditLogDbPath = path.join(reviewBridgeRoot, "azure-audit-log.db");
  const auditLogStore = createAzureAuditLogStore(auditLogDbPath);
  const gitAuditLogDbPath = path.join(reviewBridgeRoot, "git-audit-log.db");
  const gitAuditLogStore = createGitAuditLogStore(gitAuditLogDbPath);

  const docker = new DockerManagerImpl();
  const dockerLogManager = new DockerLogManager();
  const dockerShellManager = new DockerShellManager();
  const git = new GitManagerImpl({ credentialStore, auditLogStore, gitAuditLogStore });
  const tunnel = new TunnelManagerImpl();
  const azure = new AzureDevOpsManagerImpl({
    credentialStore,
    reviewStore: azureReviewStore,
    reviewBridgeStore,
    auditLogStore,
    fetchImpl: dependencies.fetchImpl || globalThis.fetch,
    execFileTextImpl,
  });
  const githubAuditLogDbPath = path.join(reviewBridgeRoot, "github-audit-log.db");
  const githubAuditLogStore = createGitHubAuditLogStore(githubAuditLogDbPath);
  const github = new GitHubManagerImpl({
    credentialStore,
    reviewStore: azureReviewStore,
    reviewBridgeStore,
    auditLogStore: githubAuditLogStore,
    fetchImpl: dependencies.fetchImpl || globalThis.fetch,
    execFileTextImpl,
  });
  const events = new EventEmitter();
  // Transport-neutral notification source (plan §10.1) — raiseAlert() and the
  // PR/pipeline forwarders below emit ExternalNotificationEvent here, once,
  // alongside their existing (unchanged) direct telegramManager.forwardAlert()
  // call. MobileManager is this event source's second subscriber; Telegram
  // itself is never rewired to consume it, so its formatting/behavior can't
  // regress from adding a mobile listener (see runtime.test.ts's
  // "external notification event" regression test).
  const externalNotificationEvents = new EventEmitter();
  // Forward SSH events onto the runtime event bus so Electron IPC and the
  // remote WebSocket relay can pick them up via runtime.on("ssh:*", …).
  for (const channel of [
    "ssh:auth-prompt",
    "ssh:auth-prompt-cancel",
    "ssh:host-key-change",
    "ssh:connection-state",
    "ssh:state",
  ]) {
    sshManager.on(channel, (payload) => events.emit(channel, payload));
  }
  const terminalEnvironment = getTerminalEnvironmentImpl();
  let remoteInfo: Record<string, unknown> | null = null;
  // One-shot guard so the startup auto-tunnel restoration only triggers
  // on the FIRST setRemoteInfo (i.e. the boot-time bind result). Subsequent
  // toggles of remote access (user Disable → Enable) restart the server
  // and call setRemoteInfo again, but we don't want those to re-spawn a
  // tunnel — that matches the previous "fires once at app startup"
  // behavior of runInitialRefresh.
  let autoTunnelBootstrapped = false;
  let dockerPoll: ReturnType<typeof setInterval> | null = null;
  let gitPoll: ReturnType<typeof setInterval> | null = null;
  const attentionContext = createAttentionContext();
  const terminalReplay = new TerminalReplayStore(APP_CONFIG.session.replayMaxChars || 0);

  /** Record a chunk and return the sequence number assigned to it. */
  function appendTerminalReplay(sessionId: string, data: string): number {
    return terminalReplay.append(sessionId, data);
  }

  /**
   * Clear replay output but keep the per-session sequence counter. Used on an
   * intentional restart so the next process generation continues the counter
   * (an old client throughSeq can't shadow fresh output as a duplicate).
   */
  function clearTerminalReplay(sessionId: string): void {
    terminalReplay.clear(sessionId);
  }

  /** Drop replay and its sequence counter entirely (session/panel destroy). */
  function destroyTerminalReplay(sessionId: string): void {
    terminalReplay.delete(sessionId);
  }

  function clearWorkspaceTerminalReplay(workspaceId: string): void {
    terminalReplay.deleteWorkspace(workspaceId);
  }

  // --- Claude CLI availability (persisted; only re-checked when not yet found) ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let claudeAvailableCache = (getState().settings as any)?.claudeAvailable === true;
  if (!claudeAvailableCache) {
    void recheckClaudeAvailability().catch((err) => {
      log.warn("recheckClaudeAvailability (bootstrap) failed", { err: (err as Error)?.message });
    });
  }

  async function recheckClaudeAvailability() {
    try {
      await execFileTextImpl("claude", ["--version"], { timeout: 5000 });
      claudeAvailableCache = true;
    } catch {
      try {
        const which = process.platform === "win32" ? "where" : "which";
        await execFileTextImpl(which, ["claude"], { timeout: 5000 });
        claudeAvailableCache = true;
      } catch {
        claudeAvailableCache = false;
      }
    }
    if (claudeAvailableCache) {
      await store.mutate((draft: AppState) => {
        draft.settings = draft.settings || {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (draft.settings as any).claudeAvailable = true;
      });
    }
    log.info("recheckClaudeAvailability", { available: claudeAvailableCache });
    return claudeAvailableCache;
  }

  // Permission auto-approval trail. Lives in the data dir like every other
  // audit DB, so dev and prod keep separate logs.
  const approvalAuditLogStore = createApprovalAuditLogStore(path.join(reviewBridgeRoot, "approval-audit-log.db"));

  // --- Telegram integration ---
  const telegramAuditLogDbPath = path.join(reviewBridgeRoot, "telegram-audit-log.db");
  const telegramAuditLogStore = createTelegramAuditLogStore(telegramAuditLogDbPath);
  const telegramManager = new TelegramManager({ credentialStore, auditLogStore: telegramAuditLogStore });
  telegramManager.setWorkspacesGetter(() =>
    getState().workspaces.map((ws: WorkspaceState) => {
      // Worktree children (created via "Open as worktree") look top-level in
      // the state model — they have no parentWorkspaceId and a kind that's
      // not "task"/"review" — but they are semantically children of their
      // base workspace and live inside its `.strideterm/tree/<branch>` dir.
      // For Telegram /task purposes we treat them like other children so
      // they don't show up as task parent candidates (worktree-of-worktree
      // nesting is confusing and almost never desired).
      const isWorktreeChild = (ws.notes || "").startsWith("Worktree of ");
      return {
        id: ws.id,
        name: ws.name,
        cwd: ws.cwd || "",
        kind: ws.kind || "workspace",
        profileId: ws.profileId || "default",
        notes: ws.notes || "",
        parentWorkspaceId:
          ws.task?.parentWorkspaceId ||
          ws.review?.parentWorkspaceId ||
          ws.quickfix?.parentWorkspaceId ||
          (isWorktreeChild ? "__worktree__" : ""),
        panels: (ws.panels || []).map((p) => ({ id: p.id, title: p.title || p.id })),
        task: ws.task ? { state: ws.task.state || "unknown", description: ws.task.description || "" } : null,
        starred: !!ws.starred,
      };
    }),
  );
  // Last-resort default profile for unbound chats: the most recently focused
  // window's profile (NOT blindly windowSlots[0] — slot order is creation
  // order, while the user's "current" profile is the focused window's),
  // falling back to the first existing profile.
  telegramManager.setActiveProfileGetter(() => {
    const slots = getState().windowSlots || [];
    const lastFocused = [...slots].sort((a, b) => (b.lastFocusedAt || 0) - (a.lastFocusedAt || 0))[0];
    return lastFocused?.profileId || (getState().profiles || [])[0]?.id || "default";
  });
  telegramManager.setProfilesGetter(() =>
    (getState().profiles || []).map((p) => ({ id: p.id, name: p.name, color: p.color })),
  );
  telegramManager.setWindowSlotsGetter(() =>
    (getState().windowSlots || []).map((s) => ({
      id: s.id,
      profileId: s.profileId,
      activeWorkspaceId: s.activeWorkspaceId,
      lastFocusedAt: s.lastFocusedAt,
    })),
  );
  telegramManager.setPrInfosGetter(() => {
    const state = getState();
    const resolveProviderPrWorkspace = (
      provider: "azure" | "github",
      pr: { profileId?: string; reviewWorkspaceId?: string; existingWorkspaceId?: string },
    ) => {
      const explicitWorkspaceId = pr.reviewWorkspaceId || pr.existingWorkspaceId || "";
      const explicitWorkspace = explicitWorkspaceId
        ? state.workspaces.find((w: WorkspaceState) => w.id === explicitWorkspaceId)
        : undefined;
      const profileId = pr.profileId || explicitWorkspace?.profileId || "";
      const providerWorkspace = profileId
        ? state.workspaces.find((w: WorkspaceState) => w.kind === provider && (w.profileId || "default") === profileId)
        : undefined;
      return {
        profileId,
        workspaceId: explicitWorkspaceId || providerWorkspace?.id || "",
      };
    };
    const azurePrs = Object.entries(azure.getSnapshot()?.pullRequests || {}).map(
      ([prKey, summary]: [string, unknown]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pr = summary as any;
        const target = resolveProviderPrWorkspace("azure", pr || {});
        return {
          prKey,
          provider: "azure-devops" as const,
          connectionId: pr?.connectionId || "",
          profileId: target.profileId,
          workspaceId: target.workspaceId,
          title: pr?.pullRequest?.title || prKey,
          hasAttention: !!pr?.hasAttention,
          attentionReason: pr?.attentionReason || "",
          checksFailedCount: pr?.checks?.failedCount || 0,
          checksPendingCount: pr?.checks?.pendingCount || 0,
          webUrl: pr?.pullRequest?.url || "",
        };
      },
    );
    const githubPrs = Object.entries(github.getSnapshot()?.pullRequests || {}).map(
      ([prKey, summary]: [string, unknown]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pr = summary as any;
        const target = resolveProviderPrWorkspace("github", pr || {});
        return {
          prKey,
          provider: "github" as const,
          connectionId: pr?.connectionId || "",
          profileId: target.profileId,
          workspaceId: target.workspaceId,
          title: pr?.pullRequest?.title || prKey,
          hasAttention: !!pr?.hasAttention,
          attentionReason: pr?.attentionReason || "",
          checksFailedCount: pr?.checks?.failedCount || 0,
          checksPendingCount: pr?.checks?.pendingCount || 0,
          webUrl: pr?.pullRequest?.webUrl || "",
        };
      },
    );
    return [...azurePrs, ...githubPrs];
  });

  // Expose the live LAN/Cloudflare URLs to the Telegram /tunnel command. The
  // remote server pushes URL snapshots via setRemoteInfo as it (re)binds, and
  // tunnel.getSnapshot() carries the current Cloudflare quick-tunnel state.
  // Both are read on demand so /tunnel always reports the latest state.
  telegramManager.setTunnelInfoGetter(() => {
    const state = getState();
    const remote = state.settings?.remoteAccess || {};
    const tunnelSnap = tunnel.getSnapshot();
    const remoteUrls: string[] = Array.isArray(remoteInfo?.urls) ? (remoteInfo!.urls as string[]) : [];
    return {
      remoteEnabled: !!remote.enabled,
      lanUrls: remoteUrls.filter((u) => typeof u === "string" && u.length > 0),
      cloudflareUrl: tunnelSnap?.publicUrl || "",
      remoteToken: remote.token || "",
      cloudflareStatus: tunnelSnap?.status || "idle",
      tunnelMode: APP_CONFIG.tunnel?.mode || "off",
      // Telegram may only re-establish a tunnel the user already configured
      // (remote access on + autoTunnel persisted) — never create new exposure.
      // Same gate MobileCommandDispatcher reuses for remote.endpoint.request /
      // remote.tunnel.reconnect — see tunnel-manager.ts's canReconnectTunnel().
      canReconnect: canReconnectTunnel(remote),
    };
  });

  // --- Mobile integration ---
  // Desktop's own device identity: a stable device id + long-lived X25519
  // keypair, persisted via credential-store (never in state.json/Firebase —
  // plan §5.1/§10.4). Generated once on first run, then reused every start.
  const MOBILE_DEVICE_ID_REF = "mobile:desktop-device-id";
  const MOBILE_PRIVATE_KEY_REF = "mobile:desktop-device-private-key";
  let mobileDeviceId = credentialStore.getSecret(MOBILE_DEVICE_ID_REF);
  if (!mobileDeviceId) {
    mobileDeviceId = randomUUID();
    await credentialStore.setSecret(MOBILE_DEVICE_ID_REF, mobileDeviceId);
  }
  const existingMobilePrivateKeyPem = credentialStore.getSecret(MOBILE_PRIVATE_KEY_REF);
  const mobileOwnKeyPair = existingMobilePrivateKeyPem
    ? importPrivateKeyPem(existingMobilePrivateKeyPem)
    : generateX25519KeyPair();
  if (!existingMobilePrivateKeyPem) {
    await credentialStore.setSecret(MOBILE_PRIVATE_KEY_REF, exportPrivateKeyPem(mobileOwnKeyPair.privateKey));
  }
  const mobileOwnPublicKeyBase64 = exportRawPublicKey(mobileOwnKeyPair.publicKey).toString("base64");

  const mobileIdempotencyDbPath = path.join(reviewBridgeRoot, "mobile-idempotency.db");
  const mobileIdempotencyStore = createMobileIdempotencyStore(mobileIdempotencyDbPath);
  const mobileAuditLogDbPath = path.join(reviewBridgeRoot, "mobile-audit-log.db");
  const mobileAuditLogStore = createMobileAuditLogStore(mobileAuditLogDbPath);

  const mobileDeviceStore = createMobileDeviceStore({
    getDevices: () => getState().settings.integrations.mobile.devices,
    mutateDevices: async (fn) => {
      await store.mutate("mobile:devices", (draft: AppState) => {
        draft.settings.integrations.mobile.devices = fn(draft.settings.integrations.mobile.devices);
      });
      return getState().settings.integrations.mobile.devices;
    },
  });

  // Runtime business methods MobileCommandDispatcher calls — the exact same
  // methods Telegram/IPC/remote-server already call (runtime-task-handlers.ts,
  // createCloudflareTunnel/getPayload below). Resolved lazily via _rt (not yet
  // assigned to the final runtime object at this point in createRuntime) —
  // same forward-reference pattern createTelegramDispatch's getRt() uses.
  const mobileRuntimeAdapter: MobileCommandRuntime = {
    pauseTask: (workspaceId) => _rt.pauseTask(workspaceId),
    resumeTask: (workspaceId) => _rt.resumeTask(workspaceId),
    stopTask: (workspaceId) => _rt.stopTask(workspaceId),
    resetTask: (workspaceId) => _rt.resetTask(workspaceId),
    updateTaskDescription: (workspaceId, description) => _rt.updateTaskDescription(workspaceId, description),
    resendTaskInstruction: (workspaceId, role) => _rt.resendTaskInstruction(workspaceId, role),
    createCloudflareTunnel: () => _rt.createCloudflareTunnel(),
    getPayload: () => _rt.getPayload(),
    clearAlertForSession: (sessionId, options) => _rt.clearAlertForSession(sessionId, options),
  };

  // Single shared instance (plan §9.2/§10.6): the dispatcher issues tickets
  // from it below; remote-server.ts consumes/revokes from the SAME instance
  // via runtime.consumeMobileWebSessionTicket / MobileManager's revoke hook —
  // never a separate store, or an issued ticket would never be found.
  const mobileWebSessionTicketStore = createMobileWebSessionTicketStore();

  // Single shared instance for the same reason the ticket store is one: MobileManager records an
  // event's origin as it sends it and the dispatcher reads that record when the acknowledgement
  // comes back, so two instances would mean every ack finding nothing to clear.
  const mobileNotificationOrigins = createMobileNotificationOriginStore();

  // Forward reference: the relay manager needs the transport, which is built below this point, so
  // the dispatcher reads its status through a closure rather than a value. A build with no relay
  // answers "off" here forever, which is exactly what makes the Cloudflare path the only one it
  // offers.
  let mobileRelayManager: MobileRelayManager | null = null;
  const RELAY_OFF: MobileRelayStatus = {
    enabled: false,
    state: "off",
    relayOrigin: "",
    internalPort: 0,
    lastError: "",
  };

  const mobileCommandDispatcher = createMobileCommandDispatcher({
    getState,
    runtime: mobileRuntimeAdapter,
    idempotencyStore: mobileIdempotencyStore,
    auditLogStore: mobileAuditLogStore,
    ticketIssuer: mobileWebSessionTicketStore,
    notificationOrigins: mobileNotificationOrigins,
    relay: { status: () => mobileRelayManager?.status() ?? RELAY_OFF },
    // Read at mint time, not at dispatch time: a ticket outlives the authorisation that produced it
    // by a minute, so the record is re-read immediately before it is issued (production hardening §5
    // "Ticket" 5).
    currentDevice: (deviceId: string) => mobileDeviceStore.getDevice(deviceId),
  });

  // The real, Firebase-backed transport (mobile-firebase-transport-rest.ts). Its configuration
  // comes from the environment — no project id, API key or database URL is compiled in — and an
  // install with none set still gets the real transport: it simply reports a
  // MobileFirebaseNotConfiguredError from connect(), which surfaces in Settings -> Mobile as
  // `lastError` alongside the exact variable names to set. The in-memory fake is a test double
  // only; tests inject it through `dependencies.createMobileFirebaseTransport`.
  //
  // The Auth refresh token is the one piece of session material that has to outlive the process
  // (Firebase Auth's own persistence does not work headlessly — strideterm-mobile ADR 0009), so
  // it goes into the same credential store as the device private key above, never onto disk in
  // the clear.
  const MOBILE_FIREBASE_REFRESH_TOKEN_REF = "mobile:firebase-refresh-token";
  /**
   * The DURABLE, LOCAL record that this installation is enrolled in an account.
   *
   * F12. `isAccountBound` used to read `accountManager.state().installationRegistered`, which starts
   * false and is only ever learned from the server overview — read with the very refresh token whose
   * validity is in question. On the one start-up that matters, the one where that token has been
   * rejected, the guard therefore answered "not bound" and the REST client signed in anonymously,
   * minting a NEW uid: the value the account's `installations` row, every pair membership and the
   * server's `accountByUid` index are keyed by. An ordinary network outage produced the same false
   * answer. Beside the credential it protects, in the same store, because that is the only place that
   * survives a restart without asking anybody.
   */
  const MOBILE_ACCOUNT_BINDING_REF = "mobile:account-binding";
  /**
   * The marker as a STATE, not a boolean (G13 — see `account-binding.ts`). A store that cannot be
   * read answers `unknown`, which the guard below treats exactly like `absent`: the identity is kept
   * and the recovery path is offered. The old read answered `false` here and called that conservative;
   * in the guard it consumes, `false` was the one answer that released the identity.
   */
  const readInstallationBinding = (): InstallationBindingState => {
    try {
      return parseInstallationBinding(credentialStore.getSecret(MOBILE_ACCOUNT_BINDING_REF));
    } catch {
      return "unknown";
    }
  };
  /**
   * Writes a marker. `none` is WRITTEN, never a deletion: an absent marker means "the server has never
   * answered", and that is not the same fact as "the server said this machine is not bound".
   */
  const writeInstallationBinding = async (marker: InstallationBindingMarker): Promise<void> => {
    await credentialStore.setSecret(MOBILE_ACCOUNT_BINDING_REF, marker);
  };
  const configuredFirebase = resolveMobileFirebaseConfig(process.env, FUNCTIONS_REGION);

  // THE SIGNED BOOTSTRAP (plan §8.1). An already-installed build has to be able to follow a recovery
  // into a different Firebase project without waiting for a new release, so a verified envelope wins
  // over what this build was configured with.
  //
  // ORDER, AND WHY IT IS THIS WAY ROUND. The envelope is signed by a key this build contains and
  // carries a monotonically increasing epoch, so it is the more authoritative of the two — an
  // operator who has published one is saying "the endpoints have moved", and an install that
  // preferred its own environment would be the one install that never got the message. A build with
  // no bootstrap configured, or one that has never accepted an envelope, is unchanged: it uses the
  // configuration it has, which is exactly today's behaviour.
  //
  // THE ENVIRONMENT IS DECLARED, NOT INFERRED FROM WHERE THE FILES ARE (F11). `bootstrapEnvironmentFor`
  // reads `STRIDETERM_ENV` and nothing else; it no longer answers `dev` merely because
  // `STRIDETERM_DATA_DIR` is set, which is a statement about this installation's own directory and not
  // about which remote backend it talks to, and it no longer derives anything from a project id.
  const declaredEnvironment = bootstrapEnvironmentFor(process.env);
  if (configuredFirebase.refusal) {
    // A COMPLETE AND CONTRADICTORY configuration (R06): nothing mobile is built on it, and a new
    // owner sign-in is unavailable with this as its reason. The line names the variables, not values.
    log.warn(`account: the mobile Firebase configuration is refused — ${configuredFirebase.refusal.detail}`);
  }
  if (declaredEnvironment === "unresolved") {
    log.warn(
      `account: ${BOOTSTRAP_ENV_VARS.environment} names an environment this build does not know; a new owner sign-in is unavailable and this desktop keeps whatever enrolment it already has`,
    );
  }
  // THE DATA DIRECTORY IS BOUND TO ONE ENVIRONMENT (plan §3.3). Checked only for a RESOLVED
  // declaration — `"unresolved"` is not a real environment, and binding a fresh directory to the
  // fail-closed prod substitute below over a transient misconfiguration would lock it there
  // permanently. See `data-dir-environment.ts` for why the binding is never healed automatically.
  const dataDirBinding =
    declaredEnvironment === "unresolved" ? null : bindDataDirToEnvironment(userDataPath, declaredEnvironment);
  const environmentMismatch = dataDirBinding?.mismatch ?? null;
  if (environmentMismatch) {
    log.warn(
      `account: this data directory is bound to '${environmentMismatch.boundTo}'; ${BOOTSTRAP_ENV_VARS.environment}='${declaredEnvironment}' is refused rather than reusing its bootstrap state or mobile credentials — use a separate --data-dir for a '${declaredEnvironment}' profile`,
    );
  }
  // AN UNRESOLVED DECLARATION IS TREATED AS PROD FOR THE TRUST SET, which is the strictest of the
  // four and the fail-closed direction: the prod trust set is the one that ignores the environment
  // entirely, so a misconfigured install cannot inject its own bootstrap keys. The auth broker is
  // refused outright (see `resolveAuthLinkConfig`), so nothing signs in either.
  const bootstrapEnvironment: BootstrapEnvironment =
    declaredEnvironment === "unresolved" ? "prod" : declaredEnvironment;
  const bootstrapTrust = bootstrapTrustSet(bootstrapEnvironment, process.env);
  // NO CLIENT AT ALL ON A MISMATCH. Constructing one would read `control-plane-bootstrap.json` —
  // the OTHER environment's epoch floor — from this very directory; skipping it entirely is what
  // makes "never inherits ... epoch floor" (plan §3.3) true by construction rather than by a check
  // somebody has to remember to add at every read site.
  const bootstrapClient = environmentMismatch
    ? null
    : createControlPlaneBootstrapClient({
        stateDir: userDataPath,
        environment: bootstrapEnvironment,
        url: bootstrapTrust.url,
        trust: bootstrapTrust,
      });
  // RE-VERIFIED, not merely read. `current()` used to hand back whatever was on disk, and the
  // runtime believed it as configuration — so an envelope written by an older build, under a key
  // since retired, for a different environment, or at an epoch the floor has moved past, was adopted
  // without any of those being checked again. The signature is the cheap part; the epoch floor is the
  // one that matters, because it is what makes a rollback impossible rather than merely unlikely.
  if (bootstrapClient && bootstrapTrust.url && bootstrapTrust.keys.size > 0) {
    const result = await bootstrapClient.refresh();
    if (result.changed) {
      log.info(`control-plane bootstrap: adopted epoch ${result.envelope?.payload.configEpoch}`);
    } else if (result.refusal && result.refusal !== "epoch-not-newer" && result.refusal !== "not-configured") {
      log.warn(`control-plane bootstrap: refused (${result.refusal}); keeping the current configuration`);
    }
  }
  const bootstrapEnvelope = bootstrapClient?.currentVerified() ?? null;
  const mobileFirebase = environmentMismatch
    ? {
        config: null,
        missing: [] as string[],
        refusal: {
          reason: "environment-mismatch" as const,
          detail:
            `this data directory is bound to '${environmentMismatch.boundTo}', and ${BOOTSTRAP_ENV_VARS.environment} ` +
            `declares '${declaredEnvironment}' — a data directory holds one environment's state (plan §3.3). ` +
            `Use a separate data directory for a '${declaredEnvironment}' profile.`,
        },
      }
    : resolveBootstrapFirebaseConfig(configuredFirebase, bootstrapEnvelope, FUNCTIONS_REGION);

  // THE EPOCH TRANSITION, CARRIED OUT — here, before a single client is built (F14).
  //
  // Apply a verified project's transition before constructing clients with its configuration.
  // Persisting the transition separately also makes an interrupted startup resumable.
  //
  // ONLY WHEN THE PROJECT CHANGES: an epoch that rotates a key or moves an endpoint is not a reason
  // to sign anybody out. And the marker is written LAST, AND ONLY IF EVERY STEP SUCCEEDED (G06) — the
  // old code logged a failed cleanup as "it stays pending" and then marked it applied on the very next
  // line. `applyEpochTransition` owns that ordering; see `mobile/epoch-transition.ts`.
  const pendingTransition = bootstrapClient?.pendingTransition(configuredFirebase.config?.projectId) ?? null;
  if (pendingTransition && bootstrapClient && mobileFirebase.config) {
    await applyEpochTransition(pendingTransition, {
      credentialStore,
      refreshTokenRef: MOBILE_FIREBASE_REFRESH_TOKEN_REF,
      bindingRef: MOBILE_ACCOUNT_BINDING_REF,
      deviceStore: mobileDeviceStore,
      markApplied: (epoch, projectId) => bootstrapClient.markEpochApplied(epoch, projectId),
      log,
    });
  }
  // ONE REST client over the credential slot, and one only.
  //
  // There used to be two — this one and a second built for the account transport's installation leg —
  // both reading and writing the SAME persisted refresh token from separate in-memory caches. A
  // shared token is not a shared state machine: on a cold start with no stored token both would sign
  // in anonymously and produce TWO uids, of which one becomes the installation identity and the other
  // is an orphan the account never sees; and a rejection handled by one left the other holding a
  // session for a credential that had just been deleted.
  //
  // Held in a `let` because the account manager is constructed after this and needs to answer
  // "is this installation bound to an account" for the anonymous-fallback guard — a forward reference
  // in the same style as `_externalUrlOpener` and `_mobileRemoteSessionRevoker` above.
  let installationRestClient: ReturnType<typeof createMobileFirebaseRestClient> | null = null;
  /**
   * Forward reference to the account manager, which is constructed further down.
   *
   * Two things need it from up here: the anonymous-fallback guard (an account-bound installation must
   * not answer a rejected refresh token by minting a new uid) and the token-refresh listener. Same
   * shape as `_externalUrlOpener` and `_mobileRemoteSessionRevoker`.
   */
  let accountManagerRef: AccountManager | null = null;
  // Installed after the first real Firebase client use. Keeping this lazy avoids creating an
  // anonymous session on desktops that never use the hosted control plane.
  let startInstallationTokenRefresh: (() => void) | null = null;
  /**
   * The installation's own Firebase session, created once and shared.
   *
   * IT IS NOT A MOBILE FEATURE, AND TYING IT TO ONE WAS A BUG. This client used to be born only
   * inside the pairing transport's lazy `createClient`, which the transport reaches on its first
   * real use — that is, when somebody turns Mobile ON. But `beginInstallationRegistration` and
   * `completeInstallationRegistration` authenticate as the INSTALLATION, never as the owner, so
   * registering this computer needed a session that only existed if an unrelated checkbox happened
   * to be ticked. With Mobile off, enrolment reached `installationIdToken()`, found `null`, and threw
   * a bare `Error` — which nothing maps, so the account flow reported `unknown` and the UI said
   * nothing at all.
   *
   * Memoised rather than eager: the account flow is what brings it up, on the first call that needs
   * it, so a desktop that never signs in still opens no Firebase session. The pairing transport gets
   * the SAME instance, because two anonymous sessions would be two uids for one machine — and that
   * uid is what the account's `installations` row and every pair membership are keyed by.
   */
  const ensureInstallationRestClient = (config: MobileFirebaseConfig) => {
    installationRestClient ??= createMobileFirebaseRestClient({
      config,
      credentialStore,
      refreshTokenRef: MOBILE_FIREBASE_REFRESH_TOKEN_REF,
      // The guard on the anonymous fallback: an account-bound installation must not answer a
      // rejected refresh token by minting a new uid, because that uid is what the account's
      // `installations` row and every pair membership are keyed by.
      //
      // THE DURABLE MARKER FIRST (F12), AND IT FAILS CLOSED (G13). The manager's state starts false
      // and is learned from a server read that this very failure prevents, so on a cold start with a
      // rejected token it could only ever answer "not bound". The marker is the one answer that does
      // not depend on the credential being asked about — and only a marker that positively says
      // `none` (the server answered "not bound", or the machine was signed out) releases the
      // identity. An intent left by a crashed enrolment, a marker that could not be read, or one an
      // older build never wrote all KEEP it. See `account-binding.ts`.
      isAccountBound: () =>
        newIdentityIsRefused(readInstallationBinding(), accountManagerRef?.state().installationRegistered === true),
    });
    startInstallationTokenRefresh?.();
    return installationRestClient;
  };
  const createMobileFirebaseTransportImpl =
    dependencies.createMobileFirebaseTransport ||
    (() =>
      createFirebaseMobileTransport({
        config: mobileFirebase.config,
        missingConfig: mobileFirebase.missing,
        configRefusal: mobileFirebase.refusal,
        // ONE CLIENT, WHICHEVER SIDE ASKS FIRST. The pairing transport and the account flow share a
        // single anonymous session by construction: two would be two uids for one machine.
        createClient: (config) => ensureInstallationRestClient(config),
      }));
  const mobileTransport: MobileFirebaseTransport = createMobileFirebaseTransportImpl();

  const mobilePairing = createMobilePairing({
    transport: mobileTransport,
    deviceStore: mobileDeviceStore,
    auditLogStore: mobileAuditLogStore,
    identity: {
      deviceId: mobileDeviceId,
      label: os.hostname() || "strIDEterm Desktop",
      publicKeyBase64: mobileOwnPublicKeyBase64,
    },
    // The claim-time key proof, recomputed with THIS installation's private key (review 3 §P0.1).
    //
    // Wired here rather than inside mobile-pairing.ts because the private key lives with the runtime,
    // and pairing has never needed it for anything else. This is the check an attacker cannot pass: the
    // proof is an HMAC under a session key derived from this key and the record's public key, over a
    // transcript containing a challenge that only ever existed in the QR — so a device record inserted
    // straight into the database, with any public key its author likes, cannot produce one.
    verifyKeyProof: ({ device, pairingId, challengeBase64Url }) => {
      try {
        const sessionKey = deriveSessionKey(
          mobileOwnKeyPair.privateKey,
          publicKeyFromRaw(decodeCanonicalPublicKey(device.publicKey)),
          Buffer.from(device.pairId),
          Buffer.from(SESSION_KEY_HKDF_INFO),
        );
        const expected = computeKeyProof(sessionKey, {
          protocolVersion: PROTOCOL_VERSION,
          pairId: mobileDeviceId,
          pairingId,
          desktopDeviceId: mobileDeviceId,
          desktopPublicKeyBase64: mobileOwnPublicKeyBase64,
          mobileDeviceId: device.deviceId,
          mobilePublicKeyBase64: device.publicKey,
          challengeBase64Url,
        });
        return keyProofsEqual(expected, device.keyProof);
      } catch {
        // A malformed key or challenge is a failed proof, not a crash: the claim is refused and the
        // reason is the fixed `key-proof-failed` code.
        return false;
      }
    },
  });

  const MobileManagerImpl = dependencies.MobileManager || MobileManager;
  const mobileManager = new MobileManagerImpl({
    getProfileIds: () => (getState().profiles || []).map((profile) => profile.id),
    transport: mobileTransport,
    pairing: mobilePairing,
    deviceStore: mobileDeviceStore,
    auditLogStore: mobileAuditLogStore,
    commandDispatcher: mobileCommandDispatcher,
    externalNotificationEvents,
    ownDeviceId: mobileDeviceId,
    ownPrivateKey: mobileOwnKeyPair.privateKey,
    ticketStore: mobileWebSessionTicketStore,
    notificationOrigins: mobileNotificationOrigins,
    // Stable wrapper closure over the mutable _mobileRemoteSessionRevoker ref
    // (set later by startRemoteServer) — same forward-reference trick as
    // mobileRuntimeAdapter's _rt calls above.
    revokeRemoteSessions: (deviceId: string) => {
      _mobileRemoteSessionRevoker?.(deviceId);
      // The relay is a second place a revoked device may still have a live session: the relay's own
      // loopback origin, and the relay's record of the device. Both end here.
      mobileRelayManager?.revokeDevice(deviceId);
    },
  });

  // THE ACCOUNT MANAGER (plan §8.1). Built once, like MobileManager, and for the same reason: one
  // per installation whatever the window count, so every window renders the same derived state
  // rather than each computing its own.
  //
  // `openExternal` is injected rather than imported: `shell.openExternal` is Electron's and lives in
  // the main process, and the runtime is constructed before the IPC layer registers. The indirection
  // is the same forward-reference trick `setMobileRemoteSessionRevoker` uses, and it means a test
  // drives the checkout flow without an Electron shell.
  // The SAME Ed25519 installation key the relay connector proves possession of. One key per data
  // directory, one identity: a second key would make "which installation is this" a question with
  // two answers, and the account cap counts keys.
  const accountInstallationIdentity = await loadRelayInstallationIdentity({
    installationId: mobileDeviceId,
    credentialStore,
  });
  // The installation session's own id token, for the ONE account call that must be made as the
  // installation rather than as the owner. It shares the persisted refresh token with the mobile
  // transport by construction: the two ARE the same identity, and a second refresh token would be a
  // second installation as far as the account cap is concerned.
  // THE SAME client the mobile transport uses — see the comment where it is created. A second one
  // over the same credential slot is a second state machine over one token, and on a cold start it is
  // a second anonymous uid.
  const installationIdToken = async (): Promise<string> => {
    // A NAMED REFUSAL, NOT A BARE `Error`. `codeOf` in `account-manager.ts` maps exactly three error
    // types and answers `unknown` for everything else — so a plain `Error` here surfaced as the one
    // code the UI has no sentence for, on the one screen where the person is waiting to be told what
    // to do. `not-configured` is a real code with real copy: this build has no hosted control plane.
    const config = mobileFirebase.config;
    if (!config) throw new AccountCallableError("not-configured", 0);
    return (await ensureInstallationRestClient(config).currentSession()).idToken;
  };

  // ONE account client, shared by the manager and the sign-in broker. The broker asks Firebase to
  // SEND the link; the manager redeems it. Two clients over one configuration would be two places to
  // change when the configuration moves.
  const accountClient = mobileFirebase.config ? createAccountClient({ config: mobileFirebase.config }) : null;

  /**
   * Where this build's sign-in links come back to.
   *
   * The environment is `bootstrapEnvironmentFor`'s answer — the same one the bootstrap trust set is
   * chosen with, DECLARED by `STRIDETERM_ENV` and otherwise derived from the configured Firebase
   * project — so the broker origin and the Firebase project cannot come from two different decisions.
   * A build with no answer, or with a contradictory one, gets NO broker, which blocks a new owner
   * sign-in and touches nothing else: an enrolled desktop keeps its installation credential, its
   * pairings and its device list.
   */
  const authLink = resolveAuthLinkConfig({
    firebase: mobileFirebase.config ?? null,
    // THE DECLARED answer, not the fail-closed substitute above: an unresolved declaration must
    // REFUSE a sign-in, and handing this `production` would have started one against the production
    // broker — the exact fallback F11 forbids.
    environment: declaredEnvironment,
    env: process.env,
    firebaseRefusal: mobileFirebase.refusal,
  });
  if (authLink.config === null && mobileFirebase.config) {
    log.warn(
      `account: passwordless sign-in is unavailable (${authLink.refusal}); this desktop keeps whatever enrolment it already has`,
    );
  }
  /**
   * The broker, holding an IMMUTABLE SNAPSHOT of the configuration it was built with.
   *
   * An attempt started against one Firebase project and one broker origin must not finish against
   * another, so the snapshot is the unit: when the configuration changes, the runtime disposes the
   * manager (which cancels the attempt) rather than mutating what the attempt is working against.
   *
   * NOT SHARED WITH THE RELAY TRANSPORT and not shared between instances: it is constructed here, per
   * runtime, and a second data directory gets its own.
   */
  const emailSignInBroker =
    authLink.config && accountClient
      ? new EmailSignInBroker({ authlink: authLink.config, client: accountClient })
      : null;

  /**
   * The window that OWNS the sign-in attempt in flight, if any.
   *
   * Plan §8, Fáze 3: "zavření vlastníka přihlašovacího dialogu zruší tok, zavření jiného okna jej
   * neruší." Every window sees the same attempt — that is what one derived state buys — but only the
   * one that STARTED it is the one whose closing means "never mind". Closing a second window while a
   * sign-in is waiting must not throw away a link somebody is about to open.
   */
  let signInOwnerWindowId: string | null = null;

  const accountManager: AccountManager = new AccountManager({
    client: accountClient,
    broker: emailSignInBroker,
    authLinkRefusal: authLink.refusal,
    transport: mobileFirebase.config
      ? createAccountTransport({
          config: mobileFirebase.config,
          tokenFor: async (kind, signal): Promise<string> => {
            // THE OPERATION'S SIGNAL GOES WITH THE ASK (S02): an owner refresh for an operation that has
            // ended answers with a refusal, never with whichever session the manager holds by then.
            if (kind === "owner") return accountManager.tokenFor("owner", signal);
            // The challenge leg runs as the INSTALLATION session, so the server records that uid on
            // the challenge and the owner leg cannot choose which installation it is registering.
            // The installation session is one shared refresh for every caller, so the signal cannot
            // be threaded into it; the transport re-checks the signal after this await instead.
            return installationIdToken();
          },
        })
      : null,
    identity: {
      installationId: accountInstallationIdentity.installationId,
      publicKeyBase64Url: accountInstallationIdentity.publicKeyBase64Url,
      signChallenge: (transcript: Buffer) => accountInstallationIdentity.signChallenge(transcript),
    },
    openExternal: async (url: string) => {
      await _externalUrlOpener?.(url);
    },
    // THE SIGNED ALLOWLIST, read at the moment a URL is about to be opened rather than captured at
    // construction: a recovery can replace the envelope while this process is running, and an
    // allowlist captured once would be the old merchant's.
    billingHosts: () => mobileFirebase.config?.billingCheckoutHosts ?? [],
    // The pairs this machine already has, as adoption LOCATORS for an enrolment. The server proves
    // ownership from each pair's own `publicMeta.desktopUid`; a hint is not evidence. Without them a
    // desktop that paired before it had an account enrolled with its phones left behind.
    knownPairIds: () => [
      ...new Set(
        mobileDeviceStore
          .listDevices()
          .filter((device) => !device.revoked)
          .map((device) => device.pairId),
      ),
    ],
    // Invariant 12: the credential goes only AFTER the server revocation has completed. The manager
    // owns the ordering; this is the one thing it cannot do itself, because it must not own a
    // credential store.
    forgetInstallationCredential: async () => {
      await installationRestClient?.forgetSession();
    },
    // The durable local binding marker — see `MOBILE_ACCOUNT_BINDING_REF`. A seam rather than a
    // credential-store import for the same reason `forgetInstallationCredential` is one: the manager
    // owns the ORDERING and must not own the store.
    readInstallationBinding,
    writeInstallationBinding,
    installationLabel: os.hostname() || "strIDEterm Desktop",
    // The mobile subsystem's own bounded rows, so a report about "my phone will not pair" carries
    // the pairing attempts and not only the account calls. Read through a seam rather than imported,
    // because the account module must not reach into a SQLite store.
    //
    // SUFFIXES, not ids: eight characters is enough for support to match a row against the device
    // list the account page already shows by suffix, and it is not a copy of the identifier graph.
    // `detail` is a fixed code from the mobile subsystem's own vocabulary, never payload text — the
    // store has no column that could hold one.
    collectExtraDiagnostics: () => {
      try {
        return mobileAuditLogStore.query({ limit: 200 }).entries.map((row) => ({
          at: Date.parse(String(row.timestamp)) || 0,
          event: `mobile.${String(row.action)}`,
          status: String(row.status),
          level: String(row.status) === "failure" ? "error" : "info",
          fields: {
            ...(row.detail ? { detail: String(row.detail) } : {}),
            ...(row.deviceId ? { device: String(row.deviceId).slice(-8) } : {}),
            ...(row.pairId ? { pair: String(row.pairId).slice(-8) } : {}),
            actor: String(row.actor),
          },
        }));
      } catch {
        // A diagnostics report must not fail because the diagnostics store did.
        return [];
      }
    },
    appInfo: {
      versionName: packageVersion,
      platform: process.platform,
      osVersion: os.release(),
      // Which data directory this is, which is what actually separates dev from prod here — see
      // `dev.ps1`. A report from the dev instance must not be read as one from the shipped app.
      buildMode: process.env.STRIDETERM_DATA_DIR ? "development" : "release",
    },
  });
  accountManagerRef = accountManager;
  accountManager.on("state", (state: AccountUiState) => {
    // One event, one payload, every window. The renderer subscribes to this and computes nothing.
    events.emit("account:updated", state);
  });

  // WHAT THIS MACHINE ALREADY IS, restored from its PERSISTENT installation session.
  //
  // The owner session is transient (plan §2), so after a restart there is none — and before this
  // call the account page showed "signed out" on a desktop that was enrolled, entitled and working,
  // until somebody signed in again. The overview is a `bound-account-recovery` door: an installation
  // uid resolves it, which is exactly the credential this machine is supposed to have.
  void accountManager.restoreFromInstallation();

  // THE SERVER-SIDE TOKEN-REFRESH LISTENER (plan §6.4). `v2/tokenRefresh/{uid}` is the issuer saying
  // "your claims changed, ask again now", and until now nothing in the desktop was subscribed to it:
  // an IPC method a renderer could call is not a listener, so the only thing that ever picked up a
  // claim change was the next token expiry — up to an hour of a paid account being refused, and up to
  // an hour of a revoked one still being served on its long-lived RTDB stream.
  let installationTokenRefresh: ReturnType<typeof createInstallationTokenRefreshListener> | null = null;
  startInstallationTokenRefresh = () => {
    if (installationTokenRefresh || !installationRestClient) return;
    installationTokenRefresh = createInstallationTokenRefreshListener({
      client: installationRestClient,
      // A stream authenticates ONCE, at connect. Refreshing the token and leaving the stream up is
      // the half-fix that looks like it worked, so the manager's streams are torn down and re-opened.
      restartStreams: async () => {
        await mobileManager.stop();
        if (getState().settings.integrations.mobile.enabled && !getState().settings.remoteAccess.paused)
          mobileManager.start();
      },
      refreshAccount: () => accountManager.onClaimsChanged(),
      onError: (error) => {
        log.warn("installation token-refresh listener failed", { error: String(error) });
      },
    });
    void installationTokenRefresh.start().catch((error: unknown) => {
      // A listener that cannot subscribe is a staler client, not a broken one: the token still expires
      // on its own hour, and every foreground action re-reads. Never a failed launch.
      log.warn("could not subscribe to the installation token-refresh marker", { error: String(error) });
    });
  };

  startInstallationTokenRefresh();

  // The managed relay (relay plan §10). Built once, like MobileManager and for the same reason: one
  // per installation, whatever the window count. Absent when this build wired no origin starter,
  // which is what makes "no relay" the default rather than a setting that could be missed.
  mobileRelayManager = dependencies.startRelayOrigin
    ? createMobileRelayManager({
        installationId: mobileDeviceId,
        credentialStore,
        transport: mobileTransport,
        startOrigin: dependencies.startRelayOrigin,
        // Both flags: a relay without the mobile integration has no control plane to ask for a
        // grant, and a relay the user did not switch on must not exist at all.
        isEnabled: () =>
          getState().settings.integrations.mobile.enabled &&
          getState().settings.integrations.mobile.relay.enabled &&
          !getState().settings.remoteAccess.paused,
        // The relay's revocation sync reads the PERSISTENT device list, not anything the relay
        // accumulated while it happened to be running (plan §3.3). This closure is that wiring: the
        // same atomically-written state file the rest of the mobile integration reads, so a revoke
        // performed by the phone or by the cloud while this desktop was shut down is replayed to the
        // relay before the first viewer request after the next start is answered.
        listRevocations: () =>
          mobileDeviceStore
            .listDevices()
            .filter((device) => device.revoked)
            .map((device) => ({ deviceId: device.deviceId, revokedAt: device.revokedAt })),
      })
    : null;

  /** Mirrors reconfigureTelegram()'s stop-then-conditionally-start shape. */
  async function reconfigureMobile(state = getState()) {
    await mobileManager.stop();
    if (state.settings.integrations.mobile.enabled && !state.settings.remoteAccess.paused) mobileManager.start();
    // AFTER the manager, not before: the relay's first act is to ask the control plane for a
    // connector grant, and the transport carrying that call is the one `start()` connects. The
    // manager retries on its own if the sign-in has not landed yet, but starting it into a
    // guaranteed failure would burn the first attempt every time. It reads the flags itself rather
    // than being told, so it and this function cannot disagree about whether a relay is wanted.
    return mobileRelayManager?.reconfigure().catch(() => undefined);
  }

  // Forward MobileManager's status/pairing events onto the runtime event bus
  // so Electron IPC can pick them up via runtime.on("mobile:*", …) — same
  // generic forwarding as the SSH events loop above. Status/pairing-progress
  // ONLY (plan §10.3 "neposílat přes ně secret") — MobileManager's own emit()
  // call sites are what enforce that, not this loop.
  for (const channel of ["mobile:status", "mobile:pairing-progress", "mobile:device-revoked"]) {
    mobileManager.on(channel, (payload: unknown) => events.emit(channel, payload));
  }

  // --- Agent notification hook server ---
  const notifySecret = generateNotifySecret();
  let notifyServerHandle: NotifyServerHandle | null = null;
  let notifyServerStarting = false;

  // --- Agent Task Runner ---
  const taskRunner = new AgentTaskRunner();

  // --- Broadcast coalescing ---
  let broadcastScheduled = false;

  function getState(): AppState {
    return store.getState() as AppState;
  }

  // Tell the file-manager which `rootPath` values are legitimate. Without
  // this hook safePath() rejects every fs request, which is the right
  // default — but here we expose the set of paths the user has actually
  // opened (workspace cwds + any git/review/quickfix roots tied to those
  // workspaces). Anything outside is refused even with a valid token.
  fm.setAllowedRootsResolver(() => {
    const roots: string[] = [];
    for (const ws of getState().workspaces || []) {
      if (ws.cwd) roots.push(ws.cwd);
      if (Array.isArray(ws.gitRoots)) roots.push(...ws.gitRoots.filter(Boolean));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const review = (ws as any).review?.checkout?.rootPath;
      if (review) roots.push(review);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const quickfix = (ws as any).quickfix?.rootPath;
      if (quickfix) roots.push(quickfix);
    }
    return roots;
  });

  function getNotificationConfig(state = getState()) {
    return state.settings?.notifications || APP_CONFIG.notifications;
  }

  /**
   * Decide whether a shell-completion alert (OSC 133;D, prompt-pattern, shell
   * exit) should reach the user. Agent sessions always pass — this gate only
   * filters non-agent paths. The user can opt back in per-panel via
   * `panel.alertsForceOn` for cases like a long-running build script in a
   * shell tab where they DO want the "command finished" ping.
   */
  function isShellAlertAllowed(
    signal: { agentLike?: boolean } | null | undefined,

    panel: { alertsForceOn?: boolean } | null | undefined,
    state = getState(),
  ): boolean {
    if (signal?.agentLike) return true;
    if (panel?.alertsForceOn) return true;
    return !getNotificationConfig(state).agentsOnly;
  }

  // One-shot listeners used by testClaudeHook() to confirm end-to-end
  // round-trip: notify.mjs → notify-server → dispatcher.
  // Key = probe_id, value = resolve callback.  Cleared on resolution or timeout.
  const hookProbeListeners = new Map();

  /**
   * Dispatch a Claude Code hook event (Phase 0 § 3.2.b).
   *
   * Pipeline:
   *   1. Record on session signal (hookCapable, lastHookAt, lastHookType).
   *   2. Task runner first dibs (onHookEvent) — task workspaces own their
   *      sessions and must not be alerted through the user pipeline.
   *   3. Classify via classifyHookEvent → user-facing or system-only.
   *   4. Side-effects (e.g. UserPromptSubmit resets busy, lastPromptAt).
   *   5. User-level gating: hasUserInput, visibility, cooldown (urgent bypasses).
   *   6. Raise T1 alert at classified urgency.
   *
   * Accepts the new shape {sessionId, hook, subtype, payload} plus the legacy
   * {sessionId, notificationType} for back-compat with the IPC helper.
   */
  async function dispatchAgentHookEvent(
    event:
      | {
          sessionId?: string;
          hook?: string;
          subtype?: string;
          notificationType?: string;
          payload?: Record<string, unknown>;
        }
      | null
      | undefined,
  ) {
    const sessionId = event?.sessionId || "";
    const hook = event?.hook || "Notification";
    // The back-compat `notificationType` field is `subtype || "idle_prompt"`
    // (notify-server.ts), so falling back to it unconditionally made every
    // Stop / SubagentStop / UserPromptSubmit event log a bogus
    // `subtype: "idle_prompt"`. Only `Notification` carries a meaningful
    // subtype, so only it may consult the legacy field.
    const subtype = event?.subtype || (hook === "Notification" ? event?.notificationType || "" : "");
    // Claude sends a human sentence with Notification hooks ("Claude needs
    // your permission to use Bash"). It is the only thing that says WHAT the
    // agent is asking about until a PermissionRequest summary is available.
    const hookMessage = typeof event?.payload?.message === "string" ? event.payload.message : "";

    log.debug("agent hook event received", { sessionId, hook, subtype });
    metricsRecordHook(hook);

    // --- Short-circuit: probe events from testClaudeHook() ---
    // These never reach task runner or user pipeline.  They exist only to
    // confirm that notify.mjs can successfully POST to notify-server and
    // be dispatched.  Payload carries { probe_id: "<uuid>" }.
    const probeId = event?.payload?.probe_id;
    if (probeId && hookProbeListeners.has(probeId)) {
      const resolve = hookProbeListeners.get(probeId);
      hookProbeListeners.delete(probeId);
      log.debug("hook probe received", { probeId, sessionId });
      try {
        resolve({ ok: true, sessionId, hook, subtype });
      } catch (err) {
        log.warn("probe resolver threw", { err: (err as Error).message });
      }
      return;
    }

    if (!sessionId) {
      log.debug("hook ignored: no sessionId");
      return;
    }

    const descriptor = parseSessionId(sessionId);
    if (!descriptor) {
      log.debug("hook ignored: unparseable sessionId", { sessionId });
      return;
    }

    // --- 1. Record on signal (for hook gating in detector) ---
    const state = getState();
    const project = findWorkspace(state, descriptor.workspaceId) as WorkspaceState | null;
    const panel = project?.panels.find((p) => p.id === descriptor.panelId) || null;
    const signal = getSessionSignal(sessionId, project, panel);
    signal.hookCapable = true;
    if (hook === "Notification" || hook === "Stop" || hook === "SubagentStop") {
      signal.completionHookCapable = true;
    }
    signal.lastHookAt = Date.now();
    signal.lastHookType = subtype ? `${hook}:${subtype}` : hook;

    // --- 2. Task runner first dibs ---
    try {
      const consumed = taskRunner.onHookEvent({ sessionId, hook, subtype });
      if (consumed) {
        log.info("hook consumed by task runner", { sessionId, hook, subtype });
        signal.lastHookAlertAt = Date.now();
        cancelPromptTimer(signal);
        return;
      }
    } catch (err) {
      log.warn("taskRunner.onHookEvent threw", { sessionId, hook, subtype, err: (err as Error).message });
      // Fall through to user pipeline — task runner errors must not eat events.
    }

    // --- 3. Classify ---
    const classification = classifyHookEvent(hook, subtype, {
      subagentCompletion: state.settings?.notifications?.subagentCompletion === true,
    });

    // --- 4. Side-effects for system-only events (applied regardless of gating) ---
    // Task workspaces run their own state machine (taskState) and are excluded
    // from the agent-activity dot, so the subagent counter must not touch them —
    // they also consume SubagentStop before this point, which would strand the
    // count. Interactive (non-task) agent sessions get the full treatment.
    applyHookSideEffects(signal, hook, subtype, event?.payload, project?.kind === "task");

    if (!classification.userFacing) {
      log.trace("hook system-only — no user alert", { sessionId, hook, subtype });
      return;
    }

    // --- 5. User-level gating ---
    if (!signal.hasUserInput) {
      log.debug("hook ignored: no user input yet", { sessionId, hook, subtype });
      return;
    }
    // A `question` always gets through: the latch exists to stop a generic
    // `idle_prompt` from piling on top of an alert the user already has, not
    // to swallow a blocking question that arrived after one.
    if (signal.waitingRaised && classification.urgency !== "urgent" && classification.kind !== "question") {
      log.debug("hook ignored: waiting already raised (not urgent)", { sessionId, hook });
      return;
    }
    if (isSessionVisible(sessionId)) {
      log.trace("hook: session visible, resetting signal", { sessionId });
      resetSessionSignal(sessionId);
      return;
    }

    const notifConfig = getNotificationConfig(state);
    const now = Date.now();
    const cooldownMs = notifConfig.alertCooldownMs;
    const urgentCooldownMs = 3_000; // urgent has its own short cooldown, see plan § 3.2.c
    const effectiveCooldown = classification.urgency === "urgent" ? urgentCooldownMs : cooldownMs;
    const inCooldown = signal.lastAlertAt > 0 && now - signal.lastAlertAt < effectiveCooldown;
    if (inCooldown) {
      log.debug("hook ignored: cooldown active", {
        sessionId,
        urgency: classification.urgency,
        remainingMs: effectiveCooldown - (now - signal.lastAlertAt),
      });
      return;
    }

    // Repeat idle_prompt suppression: Claude Code occasionally re-fires
    // `Notification:idle_prompt` for the SAME waiting state (e.g. on focus
    // changes, periodic heartbeats, statusline redraws). If nothing the user
    // cares about has happened since the last alert, the second hook is
    // redundant noise.
    //
    // "Nothing happened" means ALL of:
    //   1. User has not submitted a new prompt to Claude since the last
    //      alert (`lastPromptAt <= lastAlertAt`). UserPromptSubmit is the
    //      authoritative "user sent work" signal — if they haven't, Claude
    //      is still in the same waiting state.
    //   2. Claude has not emitted substantial output since last alert
    //      (`outputBursts < 10`). Tiny status-line heartbeats bump bursts
    //      by 1-2, but a real new response is 20+ chunks; threshold of 10
    //      distinguishes them.
    //
    // Gated by `agentLike` so non-agent sessions (which don't track
    // outputBursts in the detector) aren't affected.
    //
    // Urgent (permission_prompt) always bypasses — those are blockers.
    const userSubmittedSinceAlert = signal.lastPromptAt > 0 && signal.lastPromptAt > signal.lastAlertAt;
    const substantialOutputSinceAlert = signal.outputBursts >= 10;
    if (
      hook === "Notification" &&
      subtype === "idle_prompt" &&
      classification.urgency !== "urgent" &&
      signal.agentLike &&
      signal.everAlerted &&
      !userSubmittedSinceAlert &&
      !substantialOutputSinceAlert
    ) {
      log.debug("hook ignored: repeat idle_prompt with no intervening activity", {
        sessionId,
        lastAlertAgeMs: now - signal.lastAlertAt,
        outputBursts: signal.outputBursts,
        userSubmittedSinceAlert,
      });
      return;
    }

    signal.lastHookAlertAt = now;
    cancelPromptTimer(signal);

    // --- 6. Raise T1 alert ---
    // A PermissionRequest summary (`Bash: chmod +x deploy.sh`) beats Claude's
    // own sentence: it carries the exact tool name and its key argument, while
    // the hook message may be the bare "Claude needs your permission".
    const alertMessage = takePendingPermissionSummary(signal, hook, subtype, event?.payload) || hookMessage;
    log.info("agent hook raising alert", {
      sessionId,
      hook,
      subtype,
      urgency: classification.urgency,
      detail: classification.detail,
      // Promoted to info (alongside the alert itself) so verifying the
      // question pipeline by hand doesn't require switching to trace.
      message: alertMessage,
    });
    raiseAlert({
      sessionId,
      projectId: descriptor.workspaceId,
      panelId: descriptor.panelId,
      title: panel?.title || descriptor.panelId,
      kind: classification.kind,
      tier: classification.tier ?? 1,
      urgency: classification.urgency,
      detail: classification.detail,
      message: alertMessage,
    });
  }

  /**
   * Consume the summary parked by the `PermissionRequest` hook, if one belongs
   * to THIS event.
   *
   * Only `Notification:permission_prompt` may take one. Elicitations and
   * `agent_needs_input` share the `question` kind but are a different
   * question entirely, and lending them a `Bash: …` line from an unrelated
   * request is how a notification comes to describe something that is not
   * being asked.
   *
   * Matching uses every identity both events carry: Claude Code's own
   * `session_id` first, then `prompt_id` and `agent_id` to separate the turns
   * and the subagents inside it. The main agent and a subagent can have
   * permission requests outstanding at the same moment in ONE session, so
   * "newest wins" would routinely hand a notification the other one's tool.
   * Unless exactly one candidate is PROVEN — none contradicting, none left
   * over — nothing is claimed: the alert falls back to Claude's own sentence,
   * which is vague but never wrong.
   *
   * Entries are dropped once consumed (one summary, one alert) and once older
   * than PENDING_PERMISSION_TTL_MS.
   */
  function takePendingPermissionSummary(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signal: any,
    hook: string,
    subtype: string,
    payload?: Record<string, unknown>,
  ): string {
    const queue = (signal?.pendingPermissions || []) as PendingPermission[];
    if (!queue.length) return "";
    const now = Date.now();
    const fresh = queue.filter((entry) => now - entry.at <= PENDING_PERMISSION_TTL_MS);
    if (fresh.length !== queue.length) signal.pendingPermissions = fresh;
    if (hook !== "Notification" || subtype !== "permission_prompt") return "";
    if (!fresh.length) return "";

    const claudeSessionId = typeof payload?.session_id === "string" ? payload.session_id : "";
    const promptId = typeof payload?.prompt_id === "string" ? payload.prompt_id : "";
    const agentId = typeof payload?.agent_id === "string" ? payload.agent_id : "";

    // An entry that names a different Claude session provably belongs
    // elsewhere; one that names none can only answer a notification that names
    // none either.
    let candidates = fresh.filter((entry) => (entry.claudeSessionId || "") === claudeSessionId);
    // Narrow by the finer identities when the notification carries them, and
    // fail closed: a candidate that does not prove the same turn (or the same
    // subagent) is discarded rather than kept as a wider fallback.
    candidates = narrowPendingPermissions(candidates, promptId, (entry) => entry.promptId);
    candidates = narrowPendingPermissions(candidates, agentId, (entry) => entry.agentId);

    // Exactly one, or nothing. Guessing between two indistinguishable requests
    // — or reaching for one whose identity contradicts the notification's — is
    // how a notification comes to describe a command that is not the one being
    // asked about.
    if (candidates.length !== 1) {
      log.debug("permission summary not proven — using Claude's own message", {
        candidates: candidates.length,
        claudeSessionId,
        promptId,
        agentId,
      });
      return "";
    }
    const match = candidates[0];
    signal.pendingPermissions = fresh.filter((entry) => entry !== match);
    return String(match.summary || "");
  }

  /**
   * Keep only the candidates whose `field` equals `value`.
   *
   * An empty `value` — the notification did not carry this identity at all —
   * leaves the list untouched: a comparison that cannot be made must not
   * decide anything.
   *
   * A non-empty `value` with no match empties the list, and that is the whole
   * point. Falling back to the unnarrowed candidates conflated "this side does
   * not say" with "the two sides say different things": one pending request
   * `(session=S, prompt=P1)` against a notification `(session=S, prompt=P2)`
   * survived the session filter, failed the prompt narrowing, was handed back
   * as the sole candidate and described P2 with P1's command. Same for a main
   * agent's request against a subagent notification whose own
   * `PermissionRequest` never arrived. A dropped hook or a subagent running
   * alongside makes that an ordinary state, so an unproven candidate is no
   * candidate: the caller then falls back to Claude's own sentence, which is
   * vague but never describes the wrong tool.
   */
  function narrowPendingPermissions(
    candidates: PendingPermission[],
    value: string,
    field: (entry: PendingPermission) => string,
  ): PendingPermission[] {
    if (!value) return candidates;
    return candidates.filter((entry) => field(entry) === value);
  }

  /** Drop a parked summary once its request has been answered for the user. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function dropPendingPermission(signal: any, requestId: string): void {
    if (!signal?.pendingPermissions) return;
    signal.pendingPermissions = (signal.pendingPermissions as PendingPermission[]).filter(
      (entry) => entry.requestId !== requestId,
    );
  }

  /**
   * An offer this instance has made but not yet committed, plus the offers it
   * already committed (so a retry answers identically instead of writing a
   * second audit row and firing a second notification).
   */
  interface PermissionOfferRecord {
    requestId: string;
    /** The delivery id `notify.mjs` minted for this hook run. */
    requestKey: string;
    /**
     * The delivery id as PRESENTED, empty when the script sent none. Kept
     * apart from `requestKey` (which falls back to a fresh uuid so the dedup
     * map always has a key) because the commit leg is checked against exactly
     * what the offer leg presented: "" must match "", and never a real id.
     */
    deliveryId: string;
    sessionId: string;
    toolName: string;
    /**
     * Digest of the tool name and its arguments. Two requests that share a
     * delivery id but not this are two different questions, and the second one
     * must never inherit the first one's decision.
     */
    fingerprint: string;
    /** The ownership token the offer was proven with; the commit must repeat it. */
    ownershipToken: string;
    summary: string;
    detail: string;
    claudeSessionId: string;
    promptId: string;
    agentId: string;
    reason: string;
    at: number;
    committed: boolean;
    /** The exact stdout document returned on commit, replayed for a retry. */
    output: Record<string, unknown> | null;
  }
  const permissionOffers = new Map<string, PermissionOfferRecord>();
  const permissionOffersByKey = new Map<string, string>();
  const PERMISSION_OFFER_TTL_MS = 10 * 60_000;
  const MAX_PERMISSION_OFFERS = 200;

  /**
   * Translate a `profileId` filter into the audit store's provider-column
   * filter, and drop it from the top level so the store never sees a key it
   * does not understand.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function withApprovalProfileFilter(filters: any = {}): Record<string, unknown> {
    const { profileId, ...rest } = filters || {};
    if (!profileId) return rest;
    return {
      ...rest,
      providerFilters: { ...(rest.providerFilters || {}), profile_id: String(profileId) },
    };
  }

  /**
   * What makes two permission requests the same request: the tool and the
   * exact arguments it was called with. Cheap, and the only thing the
   * `PermissionRequest` input offers — it carries no `tool_use_id`.
   */
  function permissionRequestFingerprint(toolName: string, toolInput: unknown): string {
    let serialized: string;
    try {
      serialized = JSON.stringify(toolInput ?? null) ?? "null";
    } catch {
      serialized = String(toolInput);
    }
    // JSON.stringify of the pair, so no tool name can spell out the start of
    // another one's arguments.
    return createHash("sha256")
      .update(JSON.stringify([toolName, serialized]))
      .digest("hex")
      .slice(0, 32);
  }

  /**
   * Throw away offers that have not been committed yet.
   *
   * An offer says "I would answer this, ask me again in a moment". Everything
   * that revokes the right to answer — the setting going off, the turn ending,
   * the panel closing — has to revoke the outstanding offers too, or a commit
   * arriving a second later would still be honoured against a world that no
   * longer permits it. Committed records are left alone: they are the replay
   * trail for a decision already issued, and `commitPermissionDecision()`
   * re-runs every guard before replaying one, so a stale trail cannot answer.
   */
  function discardPermissionOffers(match: (record: PermissionOfferRecord) => boolean, reason: string): void {
    for (const [requestId, record] of [...permissionOffers]) {
      if (record.committed || !match(record)) continue;
      permissionOffers.delete(requestId);
      if (permissionOffersByKey.get(record.requestKey) === requestId) {
        permissionOffersByKey.delete(record.requestKey);
      }
      log.debug("permission offer discarded", { requestId, sessionId: record.sessionId, reason });
    }
  }

  function prunePermissionOffers(now = Date.now()): void {
    for (const [requestId, record] of [...permissionOffers]) {
      if (now - record.at <= PERMISSION_OFFER_TTL_MS) continue;
      permissionOffers.delete(requestId);
      if (permissionOffersByKey.get(record.requestKey) === requestId) {
        permissionOffersByKey.delete(record.requestKey);
      }
    }
    while (permissionOffers.size > MAX_PERMISSION_OFFERS) {
      const oldest = permissionOffers.keys().next().value as string | undefined;
      if (!oldest) break;
      const record = permissionOffers.get(oldest);
      permissionOffers.delete(oldest);
      if (record && permissionOffersByKey.get(record.requestKey) === oldest) {
        permissionOffersByKey.delete(record.requestKey);
      }
    }
  }

  /**
   * PHASE 1 of Claude Code's `PermissionRequest` handshake — "would you answer
   * this?".
   *
   * Runs synchronously inside the notify-server request so the answer can go
   * back in the HTTP response. Returning null means "no opinion": the prompt
   * is shown to the user exactly as it would be without the hook.
   *
   * Nothing irreversible happens here, and that is the whole point. The hook
   * fans out to every strIDEterm registered for the project directory, and
   * `notify.mjs` only knows how many offered once every one of them has
   * replied. Writing the audit row, raising the Notification Center entry or
   * sending the Telegram message at this stage would record an approval that
   * arbitration may then throw away — which is exactly what "2 instances
   * answered, so nobody's decision is used" looks like from the log's side.
   *
   * Deliberately does NOT raise an alert either. A permission request may be
   * settled within milliseconds by a hook of the user's own, and alerting here
   * would pop a question nobody ever had to answer. The alert comes from the
   * `Notification:permission_prompt` Claude fires ~6 s later if the dialog is
   * still up — by which time this summary is waiting on the signal for it.
   */
  function offerPermissionDecision(event: {
    sessionId?: string;
    payload?: Record<string, unknown>;
  }): { requestId: string } | null {
    const sessionId = event.sessionId || "";
    const payload = event.payload || {};
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
    const parts = summarizePermissionRequestParts(toolName, payload.tool_input);
    const claudeSessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id : "";
    const agentId = typeof payload.agent_id === "string" ? payload.agent_id : "";
    // Identity of one hook DELIVERY, minted by notify.mjs and repeated on the
    // commit leg. A script too old to send one gets a fresh uuid here, which
    // costs it nothing but the (unused) ability to replay: what it must never
    // get is its `request_key`, which was `session_id|prompt_id` and therefore
    // the same value for every tool of one turn.
    const deliveryId = String(payload.strideterm_delivery_id || "");
    const requestKey = deliveryId || randomUUID();
    const fingerprint = permissionRequestFingerprint(toolName || "tool", payload.tool_input);

    prunePermissionOffers();

    const descriptor = sessionId ? parseSessionId(sessionId) : null;
    const signal = descriptor ? sessionSignals.get(sessionId) || null : null;

    // An earlier offer under this delivery id is only ever THIS request again:
    // same panel, same tool, same arguments. Anything else that reaches the
    // same key is a different question and starts with a clean identity — the
    // alternative is a second tool inheriting the first one's `allow`.
    const existingId = permissionOffersByKey.get(requestKey);
    const previous = existingId ? permissionOffers.get(existingId) : undefined;
    const isSameRequest = Boolean(
      previous &&
      previous.sessionId === sessionId &&
      previous.toolName === (toolName || "tool") &&
      previous.fingerprint === fingerprint,
    );
    const requestId: string = isSameRequest && previous ? previous.requestId : randomUUID();

    // Park the summary regardless of the decision: if we don't approve, the
    // permission_prompt that follows is exactly when the user needs to be told
    // WHAT is being asked. Keyed by requestId so a redelivery updates its own
    // entry instead of queueing a duplicate.
    if (signal) {
      const queue = (signal.pendingPermissions || []) as PendingPermission[];
      const deduped = queue.filter((entry) => entry.requestId !== requestId);
      deduped.push({
        toolName: toolName || "tool",
        summary: parts.summary,
        detail: parts.detail,
        requestId,
        requestKey,
        claudeSessionId,
        promptId,
        agentId,
        at: Date.now(),
      });
      signal.pendingPermissions = deduped.slice(-MAX_PENDING_PERMISSIONS);
    }

    const state = getState();
    const workspace = descriptor ? (findWorkspace(state, descriptor.workspaceId) as WorkspaceState | null) : null;

    // Ownership proof: the hook echoed back the token strIDEterm injected into
    // the PTY it spawned. Cwd routing alone cannot establish which panel — or
    // which installation — an agent belongs to.
    const presentedToken = typeof payload.strideterm_session_token === "string" ? payload.strideterm_session_token : "";
    const expectedToken = sessionId ? sessionOwnershipTokens.get(sessionId) || "" : "";
    const ownershipProven = Boolean(expectedToken) && presentedToken === expectedToken;

    const decision = decideAutoApprove({
      enabled: getNotificationConfig(state).autoApprovePermissions === true,
      toolName,
      workspace: workspace ? { kind: workspace.kind, hasTask: Boolean(workspace.task) } : null,
      signal,
      ownershipProven,
    });

    if (!decision.approve) {
      // The quiet, normal case: Claude shows its prompt and the user answers
      // it. Debug-level, with the reason, so "why didn't it auto-approve?" has
      // an answer in the log rather than requiring a guess.
      log.debug("permission request not auto-approved", {
        sessionId,
        toolName,
        requestId,
        reason: decision.reason,
      });
      return null;
    }

    // Only NOW may a decision already taken be replayed. Every guard above —
    // the setting, the never-list, the workspace, the ownership token, the
    // active turn — has just been re-evaluated against the request in hand, so
    // a replay can never carry an old `allow` past a rule that would refuse
    // the new one.
    if (isSameRequest && previous?.committed) {
      log.debug("permission request already decided — replaying", { sessionId, requestId, requestKey });
      return previous.output ? { requestId } : null;
    }

    permissionOffers.set(requestId, {
      requestId,
      requestKey,
      deliveryId,
      sessionId,
      toolName: toolName || "tool",
      fingerprint,
      ownershipToken: expectedToken,
      summary: parts.summary,
      detail: parts.detail,
      claudeSessionId,
      promptId,
      agentId,
      reason: decision.reason,
      at: Date.now(),
      committed: false,
      output: null,
    });
    permissionOffersByKey.set(requestKey, requestId);
    log.debug("permission request offered", { sessionId, toolName, requestId, requestKey });
    return { requestId };
  }

  /**
   * PHASE 2 — `notify.mjs` counted the offers, this instance was the only one,
   * and the decision may now be issued.
   *
   * The commit is first proven to describe the offered request — same
   * session, same delivery id, same tool, same arguments — and only then are
   * all the offer's guards re-checked, against the state as it is NOW. Both
   * blocks run for a replayed commit too; see below.
   *
   * Only then is the audit row written, and it is a precondition rather than a
   * side-effect. An approval nobody can look up afterwards is exactly what
   * makes a bypass indefensible, so if the row cannot be written the prompt is
   * shown instead — the user loses convenience, never the trail.
   *
   * The row records `outcome: "decision-issued"`, not "approved". strIDEterm
   * knows it handed a decision to the hook's stdout; whether Claude Code acted
   * on it is not something any part of this flow observes, and a log that
   * claimed otherwise would be claiming knowledge it does not have.
   */
  function commitPermissionDecision(
    event: { sessionId?: string; payload?: Record<string, unknown> },
    requestId: string,
  ): Record<string, unknown> | null {
    prunePermissionOffers();
    const record = permissionOffers.get(requestId);
    if (!record) {
      log.debug("permission commit for an unknown or expired offer", { requestId });
      return null;
    }

    // The commit has to BE the request the offer was made for.
    //
    // A request id is a lookup key, not an identity: it says which offer to
    // read, and nothing about which question the stdout we are about to return
    // will answer. Without binding the two, a commit carrying an
    // `AskUserQuestion` payload could be answered out of a record written for
    // `Bash` — past the never-list, and audited as the Bash call it never was.
    // The generated notify.mjs builds both legs from one payload and does not
    // cross them, but "the only client is well behaved" is not a safety
    // boundary; this is.
    const commitPayload = event.payload || {};
    const commitToolName = typeof commitPayload.tool_name === "string" ? commitPayload.tool_name : "";
    const commitDeliveryId = String(commitPayload.strideterm_delivery_id || "");
    const commitFingerprint = permissionRequestFingerprint(commitToolName || "tool", commitPayload.tool_input);
    const mismatch =
      (event.sessionId || "") !== record.sessionId
        ? "session"
        : commitDeliveryId !== record.deliveryId
          ? "delivery"
          : (commitToolName || "tool") !== record.toolName
            ? "tool"
            : commitFingerprint !== record.fingerprint
              ? "input"
              : "";
    if (mismatch) {
      log.warn("permission commit does not describe the offered request", {
        requestId,
        sessionId: event.sessionId || "",
        toolName: commitToolName,
        mismatch,
      });
      return null;
    }

    const sessionId = record.sessionId;
    const descriptor = sessionId ? parseSessionId(sessionId) : null;
    const state = getState();
    const workspace = descriptor ? (findWorkspace(state, descriptor.workspaceId) as WorkspaceState | null) : null;

    // Re-validate before recording — and before replaying. The offer is a
    // statement about the world at the moment it was made, and the commit is a
    // separate round trip: the user may have unticked auto-approve, the turn
    // may have ended, the panel may have been closed. An offer nobody revoked
    // is not the same thing as an offer that is still valid, so every guard
    // runs again here — over the CURRENT state, not the one the offer was
    // written against. A committed record is no exception: re-issuing a stored
    // `allow` for a request the rules would now refuse is the same bypass as
    // issuing it fresh.
    const presentedToken =
      typeof commitPayload.strideterm_session_token === "string" ? commitPayload.strideterm_session_token : "";
    const expectedToken = sessionId ? sessionOwnershipTokens.get(sessionId) || "" : "";
    const ownershipProven =
      Boolean(expectedToken) && presentedToken === expectedToken && expectedToken === record.ownershipToken;
    const recheck = decideAutoApprove({
      // Decided on the request in hand. It has just been proven identical to
      // the record — same session, delivery, tool and arguments — so the two
      // cannot disagree; reading it off the payload is what keeps that true
      // if the proof above is ever loosened.
      enabled: getNotificationConfig(state).autoApprovePermissions === true,
      toolName: commitToolName,
      workspace: workspace ? { kind: workspace.kind, hasTask: Boolean(workspace.task) } : null,
      signal: sessionId ? sessionSignals.get(sessionId) || null : null,
      ownershipProven,
    });
    if (!recheck.approve) {
      log.info("permission decision withdrawn before commit", {
        sessionId,
        requestId,
        toolName: record.toolName,
        reason: recheck.reason,
      });
      discardPermissionOffers((candidate) => candidate.requestId === requestId, `commit-${recheck.reason}`);
      return null;
    }

    // Idempotent replay, and only now: the guards above have just re-approved
    // this exact request, so what comes back is the same decision rather than
    // an old one waved through. No second audit row, no second Notification
    // Center entry, no second Telegram message — this is the "server wrote the
    // row and the socket died before the reply" case.
    if (record.committed) {
      log.debug("permission commit replayed", { requestId, requestKey: record.requestKey });
      return record.output;
    }

    const panel = workspace?.panels.find((entry) => entry.id === descriptor?.panelId) || null;
    const profileId = workspace?.profileId || "default";
    const workspaceName = formatWorkspaceDisplayName(workspace) || descriptor?.workspaceId || "";
    const panelTitle = panel?.title || descriptor?.panelId || "";

    const at = new Date().toISOString();
    const recorded = approvalAuditLogStore.logEntry({
      timestamp: at,
      workspaceId: descriptor?.workspaceId || "",
      sessionId,
      toolName: record.toolName,
      // Claude Code's own session id, so an approval can be found in the
      // agent transcript (~/.claude/projects/<project>/<session_id>.jsonl).
      claudeSessionId: record.claudeSessionId,
      decisionReason: record.reason,
      profileId,
      workspaceName,
      panelTitle,
      requestKey: record.requestKey,
      outcome: "decision-issued",
      operation: "auto-approve",
      category: "write",
      method: "HOOK",
      resourceType: "permission-request",
      resourceId: requestId,
      summary: record.summary,
      success: true,
      userInitiated: false,
    });
    if (!recorded) {
      log.warn("permission auto-approval blocked: audit write failed", {
        sessionId,
        toolName: record.toolName,
        requestId,
      });
      return null;
    }

    const output = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
    record.committed = true;
    record.output = output;

    // No prompt will follow a decision we issued, so the parked summary would
    // only sit there waiting to decorate an unrelated question later.
    dropPendingPermission(sessionSignals.get(sessionId), requestId);

    log.info("permission decision issued", {
      sessionId,
      workspaceId: descriptor?.workspaceId || "",
      workspaceName,
      toolName: record.toolName,
      requestId,
      summary: record.summary,
    });

    const approvalEvent: ApprovalRecorded = {
      requestId,
      workspaceId: descriptor?.workspaceId || "",
      viewId: sessionId,
      workspaceName,
      panelTitle,
      profileId,
      toolName: record.toolName,
      summary: record.summary,
      detail: record.detail,
      at,
    };
    events.emit(APPROVAL_RECORDED_CHANNEL, approvalEvent);

    telegramManager
      .forwardAlert({
        alertId: requestId,
        workspaceId: descriptor?.workspaceId || "",
        panelId: descriptor?.panelId || "",
        workspaceName,
        panelTitle,
        kind: "auto_approved",
        urgency: "normal",
        title: "Approval sent",
        message: record.summary,
        workspaceProfileId: profileId,
        workspaceProfileName: resolveProfileDisplayName(profileId),
      })
      .catch((err) => {
        log.warn("telegram auto_approved forward failed", { requestId, err: (err as Error).message });
      });

    return output;
  }

  /**
   * Side-effects applied to a session signal based on hook type.
   * Runs whether the event is user-facing or system-only.
   *
   * `isTaskWorkspace` gates the subagent-activity counter off for task
   * workspaces (they have their own state machine and consume SubagentStop
   * upstream, which would otherwise leave the count stranded).
   */
  function applyHookSideEffects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signal: any,
    hook: string,
    subtype: string,
    payload?: Record<string, unknown>,
    isTaskWorkspace = false,
  ) {
    if (!signal) return;
    if (hook === "UserPromptSubmit") {
      // User started new work — prior idle state is stale.
      signal.agentLike = true;
      signal.hasUserInput = true;
      signal.lastPromptAt = Date.now();
      signal.lastUserInteractionAt = signal.lastPromptAt;
      signal.busy = false;
      signal.outputBursts = 0;
      signal.waitingRaised = false;
      // Fresh turn. Drop any leftover subagent count so a SubagentStop that
      // never arrived (crashed agent, dropped hook) can't strand the session
      // in "running" forever — the new turn re-counts its own subagents.
      signal.turnActive = true;
      signal.activeSubagents = 0;
      // Any permission request from the previous turn is settled by now —
      // the user typed, so they saw (and answered) whatever dialog there was.
      signal.pendingPermissions = [];
      cancelPromptTimer(signal);
      setSessionActivity(signal, "running");
      log.trace("UserPromptSubmit: reset busy/waitingRaised", { sessionId: signal.sessionId });
    } else if (hook === "Stop") {
      // The turn is over, so a permission request that never produced a
      // permission_prompt is moot — drop it rather than let it decorate a
      // later, unrelated question. An uncommitted offer goes with it: outside
      // an active turn the request would be refused outright, and a commit
      // arriving late must not be answered on the strength of a turn that has
      // since ended.
      signal.pendingPermissions = [];
      if (signal.sessionId) {
        discardPermissionOffers((record) => record.sessionId === signal.sessionId, "turn-ended");
      }
      // Agent finished its turn. But a BACKGROUND subagent launched this turn
      // keeps working after Stop (Claude sits at its prompt "waiting for N
      // background agents") — keep the "running" chip/dot until the last
      // SubagentStop instead of flashing "done" while work is still happening.
      signal.turnActive = false;
      if (!isTaskWorkspace && signal.activeSubagents > 0) {
        setSessionActivity(signal, "running");
      } else {
        setSessionActivity(signal, "done", { exitCode: 0 });
      }
    } else if (!isTaskWorkspace && hook === "PreToolUse") {
      // Our PreToolUse hook is registered with a matcher scoped to the
      // subagent-launching tool ("Agent" in current Claude Code, "Task" in
      // older builds), so any PreToolUse reaching us is a subagent start. The
      // tool_name check is defensive for the case a broader matcher is ever
      // installed. Reflects the subagent as "running" — including background
      // agents that outlive the turn's Stop (handled above).
      const toolName = typeof payload?.tool_name === "string" ? payload.tool_name : "";
      if (!toolName || toolName === "Agent" || toolName === "Task") {
        signal.activeSubagents = (signal.activeSubagents || 0) + 1;
        setSessionActivity(signal, "running");
      }
    } else if (!isTaskWorkspace && hook === "SubagentStop") {
      // A subagent finished. When the last one ends AND the turn is already
      // over, flash "done"; if the turn is still active, leave the chip as the
      // turn's own "running" — a mid-turn subagent finishing is not a turn
      // boundary (preserves the "SubagentStop does not mark the main agent
      // session done" behavior).
      signal.activeSubagents = Math.max(0, (signal.activeSubagents || 0) - 1);
      if (signal.activeSubagents === 0 && !signal.turnActive) {
        setSessionActivity(signal, "done", { exitCode: 0 });
      }
    }
    // Notification is informational only — leave chip state untouched; it
    // typically means "waiting for input" mid-turn, not a turn boundary.
    void subtype;
  }

  // Back-compat alias for IPC helper `notifyAgentHook`. dispatchAgentHookEvent
  // is async, but notify-server.ts invokes onNotification synchronously
  // (typed `(n) => void`) inside its own try/catch — that catch can only ever
  // see a SYNCHRONOUS throw, so a rejection from the async body would
  // otherwise become an unhandled rejection with no trace. Wrap so failures
  // are logged instead of silently vanishing.
  const handleAgentHookNotification = (event: Parameters<typeof dispatchAgentHookEvent>[0]): void => {
    void dispatchAgentHookEvent(event).catch((err: unknown) => {
      log.warn("hook dispatch failed", {
        sessionId: event?.sessionId,
        hook: event?.hook,
        err: (err as Error)?.message || String(err),
      });
    });
  };

  async function startAgentNotifyServer() {
    const state = getState();
    const enabled = state.settings?.notifications?.agentHook !== false;
    if (!enabled) {
      log.debug("notify server disabled by settings");
      return;
    }
    if (notifyServerHandle || notifyServerStarting) {
      log.trace("notify server already running/starting");
      return;
    }
    notifyServerStarting = true;
    try {
      notifyServerHandle = await startNotifyServer({
        secret: notifySecret,
        onNotification: handleAgentHookNotification,
        onPermissionOffer: (event) => {
          try {
            return offerPermissionDecision(event);
          } catch (err) {
            // Never let a decision failure become a hung hook: silence means
            // "show the prompt", which is always a safe answer.
            log.warn("permission request handling failed", {
              sessionId: event.sessionId,
              err: (err as Error)?.message || String(err),
            });
            return null;
          }
        },
        onPermissionCommit: (event, requestId) => {
          try {
            return commitPermissionDecision(event, requestId);
          } catch (err) {
            log.warn("permission commit failed", {
              sessionId: event.sessionId,
              requestId,
              err: (err as Error)?.message || String(err),
            });
            return null;
          }
        },
      });
      log.info("notify server started", { port: notifyServerHandle.port });
      // Purge leftovers claiming our port (previous run that crashed without
      // cleanup — the port is ours now, so anything else on it is stale),
      // then re-point every live session at the fresh server.
      cleanupNotifyUrls(notifyServerHandle.port);
      refreshNotifyUrls();
    } catch (error) {
      log.warn("notify server failed to start (silence detection still active)", {
        err: (error as Error).message,
        stack: (error as Error).stack,
      });
      notifyServerHandle = null;
    } finally {
      notifyServerStarting = false;
    }
  }

  async function stopAgentNotifyServer() {
    if (notifyServerHandle) {
      const port = notifyServerHandle.port;
      log.info("stopping notify server", { port });
      cleanupNotifyUrls(port);
      try {
        await notifyServerHandle.close();
      } catch (error) {
        log.warn("notify server close error", { err: (error as Error).message });
      }
      notifyServerHandle = null;
    }
  }

  function getAzureSettings(state = getState()) {
    return (
      state.settings?.integrations?.azureDevops || {
        enabled: true,
        reviewRoot: path.join(userDataPath, "azure-pr"),
        defaultPollSeconds: 120,
        connections: [],
      }
    );
  }

  function getAzureConnections(state = getState()) {
    const all = getAzureSettings(state).connections || [];
    // Include connections for every profile that is open in some window —
    // see shared/runtime-provider-guards.ts#filterConnectionsByOpenProfiles.
    return filterConnectionsByOpenProfiles(all, state.windowSlots);
  }

  function getGitHubSettings(state = getState()) {
    return (
      state.settings?.integrations?.github || {
        enabled: true,
        reviewRoot: path.join(userDataPath, "github-pr"),
        defaultPollSeconds: 120,
        connections: [],
      }
    );
  }

  function getGitHubConnections(state = getState()) {
    const all = getGitHubSettings(state).connections || [];
    // See getAzureConnections for why we union over all open windowSlot
    // profiles rather than just slot[0].
    return filterConnectionsByOpenProfiles(all, state.windowSlots);
  }

  function getTelegramSettings(state = getState()) {
    return (
      state.settings?.integrations?.telegram || {
        enabled: true,
        defaultPollSeconds: 5,
        connections: [],
      }
    );
  }

  function getTelegramConnections(state = getState()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getTelegramSettings(state).connections || []) as any[];
  }

  function reconfigureTelegram(state = getState()) {
    const settings = getTelegramSettings(state);
    telegramManager.stop();
    if (!settings.enabled) {
      telegramManager.configure([]);
      return;
    }
    telegramManager.configure(getTelegramConnections(state));
    telegramManager.start();
  }

  /**
   * Return all provider connections (Azure DevOps, GitHub, and future GitLab)
   * visible to any profile currently open in some window. Used for the
   * payload's connection listing — the renderer filters this further by
   * its own window's profile when building the picker.
   *
   * Do NOT use for resolving the connection for a specific workspace's git
   * op — use getProviderConnectionsForProfile(workspace.profileId) instead.
   * Filtering by windowSlots[0]?.profileId (the previous behavior) silently
   * dropped connections that belonged to a non-primary window's profile.
   */
  function getAllProviderConnections(state = getState()) {
    return [...getAzureConnections(state), ...getGitHubConnections(state)];
  }

  /**
   * Return provider connections owned by `profileId`. Right scope for
   * authenticated git operations: a workspace's connection must come from
   * the SAME profile as the workspace, never from "whichever profile happens
   * to be in windowSlots[0]".
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getProviderConnectionsForProfile(state: AppState, profileId: string): any[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = (c: any) => (c.profileId || "default") === profileId;
    const azureConns = (getAzureSettings(state).connections || []).filter(match);
    const githubConns = (getGitHubSettings(state).connections || []).filter(match);
    return [...azureConns, ...githubConns];
  }

  /**
   * Resolve the provider connection for a workspace's git operations.
   * Returns `null` when the workspace has no connectionId assigned or the
   * connection cannot be found (falls back to system git credentials).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function resolveGitConnection(workspace: any) {
    const connectionId =
      workspace?.connectionId || workspace?.review?.connectionId || workspace?.quickfix?.connectionId;
    if (!connectionId) {
      return null;
    }
    const profileId = String(workspace?.profileId || "default");
    const connections = getProviderConnectionsForProfile(getState(), profileId);
    return connections.find((c) => c.id === connectionId && c.enabled !== false) || null;
  }

  function normalizeFsPath(value: string): string {
    const resolved = path.resolve(String(value || "").trim() || ".");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function parseAzureReviewWorkspaceHint(workspace: any) {
    const cwd = String(workspace?.cwd || "");
    const cwdMatch = cwd.match(/[\\/]pr-(\d+)(?:[\\/]|$)/i);
    const nameMatch = String(workspace?.name || "").match(/\bPR\s*#(\d+)\b/i);
    const prId = Number.parseInt(cwdMatch?.[1] || nameMatch?.[1] || "", 10);
    const connectionPathKey = cwdMatch ? path.basename(path.dirname(cwd)) : "";
    return {
      prId: Number.isInteger(prId) ? prId : null,
      connectionPathKey: String(connectionPathKey || "")
        .trim()
        .toLowerCase(),
    };
  }

  function getReviewBridgeSnapshot(state = getState()) {
    try {
      const prKeys = new Set([
        ...Object.keys(azure.getSnapshot().pullRequests || {}),
        ...Object.keys(github.getSnapshot().pullRequests || {}),
        ...(state.workspaces || [])
          .map((workspace: WorkspaceState) =>
            ["azure-devops", "github"].includes(workspace.review?.provider ?? "") ? workspace.review!.prKey : "",
          )
          .filter(Boolean),
      ]);
      const pullRequests: Record<string, unknown> = {};
      const processInfo = {
        execPath: process.execPath,
        platform: process.platform,
        defaultApp: Boolean((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp),
      };
      for (const prKey of prKeys) {
        const context = reviewBridgeStore.getPullRequestContext?.(prKey);
        if (context) {
          let mcpSpec = null;
          try {
            mcpSpec = buildMcpServerSpec({ context, processInfo });
          } catch {}
          pullRequests[prKey] = {
            ...context,
            cliPath: reviewBridgeCliPath,
            mcpServerSpec: mcpSpec,
          };
        }
      }
      return {
        rootPath: reviewBridgeStore.getRootPath?.() || reviewBridgeRoot,
        databasePath: reviewBridgeStore.getDatabasePath?.() || "",
        pullRequests,
        agentPrompts: reviewBridgeStore.getAgentPrompts?.() || [],
      };
    } catch {
      // Store may be closed during shutdown
      return { rootPath: reviewBridgeRoot, databasePath: "", pullRequests: {}, agentPrompts: [] };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function createAzureWorkspaceReviewPanels(tabTemplates: any[] = []) {
    const preferredTemplates = ["shell", "claude", "codex"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const selected: any[] = [];

    for (const templateId of preferredTemplates) {
      const template = tabTemplates.find((entry) => entry.id === templateId);
      if (template) {
        selected.push(template);
      }
    }
    if (!selected.length) {
      selected.push(...tabTemplates.slice(0, 3));
    }
    if (!selected.length) {
      selected.push(
        { title: "Shell", command: "" },
        { title: "Claude Code", command: "claude" },
        { title: "Codex", command: "codex" },
      );
    }

    return selected.map((template, index) => ({
      id: `panel-${randomUUID()}`,
      title: template.title || (index === 0 ? "Shell" : `Panel ${index + 1}`),
      command: template.command || "",
      shell: true,
      startup: template.startup || (index === 0 ? APP_CONFIG.ui.defaultPanelStartup : APP_CONFIG.ui.manualPanelStartup),
    }));
  }

  // --- Provider workspace lifecycle (extracted to runtime-provider-lifecycle.js) ---
  const providerLifecycle = createProviderLifecycle({
    getState,
    store,
    azure,
    github,
    git,
    azureReviewStore,
    getAzureSettings,
    getAzureConnections,
    getGitHubSettings,
    getGitHubConnections,
    parseAzureReviewWorkspaceHint,
    normalizeFsPath,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createAzureWorkspaceReviewPanels: createAzureWorkspaceReviewPanels as (templates: any[]) => any[],
    findWorkspace: findWorkspace as unknown as (state: AppState, workspaceId: string) => WorkspaceState | null,
  });
  const {
    ensureAzureWorkspace,
    refreshAzure,
    scheduleAzurePolling,
    ensureGitHubWorkspace,
    refreshGitHub,
    scheduleGitHubPolling,
  } = providerLifecycle;

  tunnel.setBinaryPreference?.(getState().settings.remoteAccess.cloudflaredPath || "");

  const versionChecker = createVersionChecker({
    currentVersion: packageVersion,
    repositoryUrl: APP_CONFIG.app.repositoryUrl,
    userDataPath,
  });

  const {
    projectAlerts,
    sessionSignals,
    getAttentionSnapshot,
    cancelPromptTimer,
    resetSessionSignal,
    deleteSessionSignal,
    clearProjectAlerts,
    clearAlertSession,
    getSessionSignal,
    raiseAlert: raiseAlertBase,
    raiseWaitingAlert,
    ensureVisibleSession,
    syncSessionSignalsWithState,
    shouldTrackProjectAlert,
    updateVisibleSessions,
    dropViewerVisibility,
    isSessionVisible,
    markSessionPromptInjected,
  } = createRuntimeAttentionManager({
    log,
    getState,
    sessions,
    createSessionId,
    parseSessionId,
    getNotificationConfig,
    createSessionSignal,
    adaptiveForget,
    metricsRecordAlert,
    APP_CONFIG,
    AGENT_NAME_RE,
    ATTENTION_VISIBILITY_GRACE_MS,
    attentionContext,
    broadcastState,
    isKnownPluginProject,
    getRecoveryCandidateIds: () => new Set(_recoveryCandidates.map((c) => c.workspaceId)),
  });

  /**
   * Resolve a profile's display name from its id. Returns the id as fallback
   * so the Telegram alert text always shows *something* — even for profile
   * records that have lost their `name` (e.g. stale state from a renamed
   * profile). The "default" profile gets a capitalised label so the alert
   * doesn't display the raw string "default".
   */
  function resolveProfileDisplayName(profileId: string | undefined): string {
    const id = profileId || "default";
    const state = getState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profile = (state.profiles || []).find((p: any) => p.id === id);
    if (profile?.name) return profile.name;
    if (id === "default") return "Default";
    return id;
  }

  // Wrap raiseAlert to forward to Telegram and route §4.2 alert navigation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function raiseAlert(opts: any): boolean {
    const raised = raiseAlertBase(opts);
    if (raised) {
      const state = getState();
      const workspace = state.workspaces.find((w) => w.id === opts.projectId);
      const panel = workspace?.panels.find((p) => p.id === opts.panelId);
      const profileId = (workspace as { profileId?: string } | undefined)?.profileId || "default";
      const signal = opts.sessionId ? sessionSignals.get(opts.sessionId) : undefined;
      const message = String(opts.message || "").trim();
      const excerpt = opts.sessionId ? recentTerminalExcerpt(terminalReplay.snapshot(String(opts.sessionId)).data) : "";
      const body = buildNotificationBody({
        kind: String(opts.kind || "info"),
        detail: String(opts.detail || ""),
        message,
        exitCode: opts.exitCode,
        recentOutput: excerpt,
      });
      const activity = String(signal?.currentCommand || "").trim();
      const title = notificationSummary(String(opts.kind || "info"), String(opts.detail || ""), opts.exitCode);
      telegramManager
        .forwardAlert({
          alertId: opts.sessionId || `${opts.projectId}:${opts.panelId}`,
          workspaceId: opts.projectId || "",
          panelId: opts.panelId || "",
          workspaceName: formatWorkspaceDisplayName(workspace) || undefined,
          panelTitle: panel?.title || opts.panelId || "",
          kind: opts.kind || "info",
          urgency: opts.urgency || "normal",
          title: opts.title || "",
          detail: opts.detail || "",
          message: opts.message || "",
          workspaceProfileId: profileId,
          workspaceProfileName: resolveProfileDisplayName(profileId),
        })
        .catch((err) => {
          log.warn("telegram forwardAlert from raiseAlert failed", {
            kind: opts.kind,
            workspaceId: opts.projectId,
            err: (err as Error).message,
          });
        });
      // Transport-neutral event (plan §10.1) — same local data as the
      // Telegram payload above, built exactly once. MobileManager is the
      // only current second subscriber; Telegram's own send above is
      // untouched by this emit (no listeners attached when mobile is
      // disabled, so this is a no-op EventEmitter#emit in that case).
      externalNotificationEvents.emit(
        "event",
        buildExternalNotificationEvent({
          eventId: randomUUID(),
          profileId,
          workspaceId: opts.projectId || "",
          sessionId: opts.sessionId || null,
          panelId: opts.panelId || null,
          kind: opts.kind || "info",
          urgency: opts.urgency === "urgent" ? "urgent" : "normal",
          title,
          detail: body,
          workspaceName: formatWorkspaceDisplayName(workspace) || opts.projectId || "",
          tab: panel?.title || undefined,
          activity: activity || undefined,
          exitCode: typeof opts.exitCode === "number" ? opts.exitCode : undefined,
        }),
      );
    }
    return raised;
  }

  // --- Tab activity chip state ----------------------------------------
  // Drives the small status label on each tab. Independent from signal.busy
  // (which governs notifications). Transitions:
  //   idle  --OSC133;C / UserPromptSubmit-->   running
  //   running --OSC133;D / Stop-->              done (+exit code)
  //   done  --after ACTIVITY_FADE_MS-->         idle
  // Sessions without shell integration and no hooks simply stay "idle" —
  // showing no chip is preferable to a misleading permanent "running" label.
  const ACTIVITY_FADE_MS = 3000;
  const activityFadeTimers = new Map();

  function scheduleActivityFade(sessionId: string): void {
    const prior = activityFadeTimers.get(sessionId);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      activityFadeTimers.delete(sessionId);
      const signal = sessionSignals.get(sessionId);
      if (!signal) return;
      if (signal.activity === "done") {
        signal.activity = "idle";
        // Writes `activity` directly, bypassing setSessionActivity — so the
        // run-start stamp has to be cleared here too, otherwise a faded-out
        // session would keep a non-zero start and show a growing elapsed.
        signal.activityStartedAt = 0;
        broadcastState();
      }
    }, ACTIVITY_FADE_MS);
    activityFadeTimers.set(sessionId, timer);
  }

  function clearActivityFade(sessionId: string): void {
    const prior = activityFadeTimers.get(sessionId);
    if (prior) {
      clearTimeout(prior);
      activityFadeTimers.delete(sessionId);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setSessionActivity(signal: any, activity: string, { exitCode = null as number | null } = {}): void {
    if (!signal) return;
    if (signal.activity === activity && activity !== "done") return;
    signal.activity = activity;
    // Run-start stamp for elapsed. The early return above means a repeated
    // running → running never re-stamps, so a long run keeps its original
    // start; every non-running state clears it.
    signal.activityStartedAt = activity === "running" ? Date.now() : 0;
    if (activity === "done") {
      signal.lastExitCode = exitCode;
      signal.lastCommandFinishedAt = Date.now();
      scheduleActivityFade(signal.sessionId);
    } else {
      clearActivityFade(signal.sessionId);
    }
    broadcastState();
  }

  function getPayload() {
    const state = getState();
    return {
      meta: {
        appVersion: packageVersion,
        repositoryUrl: APP_CONFIG.app.repositoryUrl,
        versionCheck: versionChecker.getCachedResult(),
        platform: process.platform,
        recoveryCandidates: _recoveryCandidates,
      },
      appState: (() => {
        const cloned = clone(state);
        // Filter connections to active profile only
        if (cloned.settings?.integrations?.azureDevops) {
          cloned.settings.integrations.azureDevops.connections = getAzureConnections(state);
        }
        if (cloned.settings?.integrations?.github) {
          cloned.settings.integrations.github.connections = getGitHubConnections(state);
        }
        // Drop the legacy `projects` alias — it duplicates the entire
        // `workspaces` array in every broadcast (≈131 KB in a 59-workspace
        // install) and no renderer reads it. `workspaces` is the single source
        // of truth; the persisted-state alias (default-state) stays for
        // downgrade compatibility, this only strips it from the payload.
        delete cloned.projects;
        return cloned;
      })(),
      workspace: (() => {
        const ws = sessions.getWorkspace(state);
        if (ws?.sessions) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ws.sessions = ws.sessions.map((s: any) => {
            const signal = sessionSignals.get(s.sessionId);
            if (!signal) return s;
            return {
              ...s,
              activity: signal.activity || "idle",
              lastExitCode: signal.lastExitCode,
              lastCommandFinishedAt: signal.lastCommandFinishedAt || 0,
            };
          });
        }
        return ws;
      })(),
      attention: getAttentionSnapshot(),
      docker: docker.getSnapshot(),
      git: {
        // `projects` (alias of `workspaces`, ≈2.2 MB in a 59-workspace install)
        // and `activeProject` (alias of `activeWorkspace`) were byte-identical
        // duplicates that no renderer reads — renderer fallbacks like
        // `git?.projects?.[id]` simply fall through to `workspaces`. Dropped to
        // shrink every broadcast; the desktop UI is unchanged.
        workspaces: git.getProjectMap(),
        activeWorkspace: git.getSnapshot(state.activeWorkspaceId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        connections: getAllProviderConnections(state).map((c: any) => ({
          id: c.id,
          label: c.label || c.id,
          provider: c.provider || "azure-devops",
          enabled: c.enabled !== false,
          // profileId is required so the renderer can scope the connection
          // picker to the window's own profile — without it, every window
          // sees the same flat list and a user in profile B could pick a
          // profile-A connection that then fails to resolve at op time.
          profileId: String(c.profileId || "default"),
        })),
      },
      azureDevops: azure.getSnapshot(),
      github: github.getSnapshot(),
      telegram: telegramManager.getSnapshot(),
      reviewBridge: getReviewBridgeSnapshot(state),
      plugins: pluginManager ? pluginManager.getPlugins() : [],
      environment: { ...terminalEnvironment, claudeAvailable: claudeAvailableCache },
      remoteAccess: {
        ...(remoteInfo || {
          enabled: false,
          host: state.settings.remoteAccess.host,
          port: resolveRemoteAccessPort(state.settings.remoteAccess.port),
          urls: [],
        }),
        tunnel: tunnel.getSnapshot(),
      },
      taskRunner: taskRunner.getTaskSnapshot(),
      // Surface OS-keychain availability so Settings can show a banner when
      // we're falling back to base64-on-disk for credentials. The user
      // needs to *see* the downgrade — a one-shot log warning isn't enough,
      // because most users never tail strideterm.log.
      secureStorage: {
        available:
          typeof credentialStore.isEncryptionAvailable === "function" ? credentialStore.isEncryptionAvailable() : true,
      },
    };
  }

  // Telegram PR alerts mirror the same reviewActivity stream that feeds the
  // renderer notification center. Seed the current rolling history once per
  // process so app startup doesn't replay old PR activity into Telegram.
  const forwardedReviewActivityEventIds = new Map<string, number>();
  let seededReviewActivityForTelegram = false;

  function markReviewActivityForwarded(eventId: string): void {
    forwardedReviewActivityEventIds.set(eventId, Date.now());
    if (forwardedReviewActivityEventIds.size > 1000) {
      const first = forwardedReviewActivityEventIds.keys().next().value;
      if (first !== undefined) forwardedReviewActivityEventIds.delete(first);
    }
  }

  function checkAndForwardPrNotificationsToTelegram(): void {
    // Telegram is never a precondition for Mobile (plan §1/§10.1): only skip
    // this scan when NEITHER adapter has anyone to forward to.
    if (telegramManager.getSnapshot().connections.length === 0 && !mobileManager.isRunning()) return;
    const state = getState();
    const azureSnapshot = azure.getSnapshot();
    const githubSnapshot = github.getSnapshot();

    function forwardReviewActivity(provider: "azure-devops" | "github", events: unknown[]): void {
      if (!Array.isArray(events) || events.length === 0) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const ev of events as any[]) {
        const eventId = String(ev?.id || "");
        if (!eventId) continue;
        if (ev?.kind === "connection-error") continue;
        if (!ev?.prKey) continue;

        if (!seededReviewActivityForTelegram) {
          markReviewActivityForwarded(eventId);
          continue;
        }
        if (forwardedReviewActivityEventIds.has(eventId)) continue;
        markReviewActivityForwarded(eventId);

        const profileId = String(ev.profileId || "");
        if (!profileId) continue;
        const providerKind = provider === "azure-devops" ? "azure" : "github";
        const providerLabel = provider === "azure-devops" ? "Azure DevOps" : "GitHub";
        const workspaceId = String(ev.reviewWorkspaceId || ev.existingWorkspaceId || "");
        const workspace =
          (workspaceId ? state.workspaces.find((w) => w.id === workspaceId) : undefined) ||
          state.workspaces.find(
            (w: WorkspaceState) => w.kind === providerKind && (w.profileId || "default") === profileId,
          );
        const targetWorkspaceId = workspaceId || workspace?.id || providerKind;

        log.info("telegram: forwarding review activity notification", {
          eventId,
          prKey: ev.prKey,
          provider,
          connectionId: ev.connectionId,
        });
        telegramManager
          .forwardAlert({
            alertId: eventId,
            workspaceId: targetWorkspaceId,
            panelId: "inbox",
            workspaceName: workspace?.name || providerLabel,
            panelTitle: "Inbox",
            kind: "review",
            urgency: ev.urgency === "urgent" ? "urgent" : "normal",
            title: String(ev.title || "Pull request update"),
            detail: String(ev.body || ev.pullRequestTitle || ""),
            prKey: String(ev.prKey || ""),
            provider,
            connectionId: String(ev.connectionId || ""),
            workspaceProfileId: profileId,
            workspaceProfileName: resolveProfileDisplayName(profileId),
          })
          .catch((err) => {
            log.warn("telegram: review activity forward failed", {
              eventId,
              prKey: ev.prKey,
              err: (err as Error).message,
            });
          });
        externalNotificationEvents.emit(
          "event",
          buildExternalNotificationEvent({
            eventId,
            profileId,
            workspaceId: targetWorkspaceId,
            kind: "review",
            urgency: ev.urgency === "urgent" ? "urgent" : "normal",
            title: String(ev.title || "Pull request update"),
            detail: String(ev.body || ev.pullRequestTitle || ""),
          }),
        );
      }
    }

    forwardReviewActivity("azure-devops", azureSnapshot?.reviewActivity || []);
    forwardReviewActivity("github", githubSnapshot?.reviewActivity || []);
    if (!seededReviewActivityForTelegram) {
      seededReviewActivityForTelegram = true;
    }
  }

  // Track check states per PR for pipeline completion forwarding to Telegram
  const forwardedPipelineChecks = new Map<string, string>(); // prKey:checkId → last forwarded state
  const PIPELINE_CHECK_SEED_MS = 10_000; // don't forward checks that complete in the first 10s (startup)
  const pipelineCheckStartedAt = Date.now();

  function checkAndForwardPipelineNotificationsToTelegram(): void {
    // Telegram is never a precondition for Mobile (plan §1/§10.1): only skip
    // this scan when NEITHER adapter has anyone to forward to.
    if (telegramManager.getSnapshot().connections.length === 0 && !mobileManager.isRunning()) return;
    const azureSnapshot = azure.getSnapshot();
    const githubSnapshot = github.getSnapshot();
    const inStartupGrace = Date.now() - pipelineCheckStartedAt < PIPELINE_CHECK_SEED_MS;

    function processPrChecks(
      prs: Record<string, unknown>,
      provider: "azure-devops" | "github",
      workspaceFinder: () => WorkspaceState | undefined,
    ) {
      const state = getState();
      const inboxKind = provider === "azure-devops" ? "azure" : "github";
      for (const [prKey, summary] of Object.entries(prs)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pr = summary as any;
        const checks: Array<{ id?: string; state?: string; name?: string }> = pr?.checks?.items || [];
        const prTitle: string = pr?.pullRequest?.title || prKey;
        // Mirror the PR-attention dispatch: prefer the connection's profile
        // (now carried on the summary as pr.profileId) over the first-match
        // inbox lookup. When the PR has no review/existing workspace yet,
        // the old fallback to workspaceFinder() returned whichever inbox
        // sorted first in state.workspaces — silently routing pipeline
        // alerts under the wrong profile.
        const prProfileIdHint = (pr?.profileId as string | undefined) || "";
        const inboxForProfile = prProfileIdHint
          ? state.workspaces.find(
              (w: WorkspaceState) => w.kind === inboxKind && (w.profileId || "default") === prProfileIdHint,
            )
          : undefined;
        const fallbackInbox = workspaceFinder();
        const prWorkspaceId: string =
          pr?.reviewWorkspaceId || pr?.existingWorkspaceId || inboxForProfile?.id || fallbackInbox?.id || provider;
        const prWs = state.workspaces.find((w) => w.id === prWorkspaceId);
        const prProfileId =
          prProfileIdHint ||
          (prWs as { profileId?: string } | undefined)?.profileId ||
          (inboxForProfile as { profileId?: string } | undefined)?.profileId ||
          (fallbackInbox as { profileId?: string } | undefined)?.profileId ||
          "default";

        for (const check of checks) {
          if (!check?.id) continue;
          const key = `${provider}:${prKey}:${check.id}`;
          const prevState = forwardedPipelineChecks.get(key);
          const curState = check.state || "";
          forwardedPipelineChecks.set(key, curState);

          if (inStartupGrace) continue;
          if (prevState === undefined) continue; // first time seeing this check
          const wasRunning = prevState === "pending" || prevState === "";
          const isTerminal = curState === "succeeded" || curState === "failed";
          if (!wasRunning || !isTerminal) continue;

          const checkName = (check as { name?: string; displayName?: string }).name || "Check";
          const icon = curState === "succeeded" ? "✅" : "❌";
          const detail = curState === "succeeded" ? "Passed" : "Failed";
          log.info("telegram: forwarding pipeline check completion", {
            prKey,
            checkName,
            state: curState,
            provider,
          });
          telegramManager
            .forwardAlert({
              alertId: `pipeline:${prKey}:${check.id}`,
              workspaceId: prWorkspaceId,
              panelId: "pipelines",
              workspaceName: prTitle,
              panelTitle: "Pipelines",
              kind: "pipeline",
              urgency: curState === "failed" ? "urgent" : "normal",
              title: `${icon} ${checkName} — ${prTitle}`,
              detail,
              workspaceProfileName: resolveProfileDisplayName(prProfileId),
              prKey,
              provider,
              connectionId: pr?.connectionId || "",
              workspaceProfileId: prProfileId,
            })
            .catch((err) => {
              log.warn("telegram: pipeline check forward failed", { prKey, err: (err as Error).message });
            });
          externalNotificationEvents.emit(
            "event",
            buildExternalNotificationEvent({
              eventId: key,
              profileId: prProfileId,
              workspaceId: prWorkspaceId,
              kind: "pipeline",
              urgency: curState === "failed" ? "urgent" : "normal",
              title: `${icon} ${checkName} — ${prTitle}`,
              detail,
            }),
          );
        }
      }
    }

    processPrChecks(azureSnapshot?.pullRequests || {}, "azure-devops", () =>
      getState().workspaces.find((w: WorkspaceState) => w.kind === "azure"),
    );
    processPrChecks(githubSnapshot?.pullRequests || {}, "github", () =>
      getState().workspaces.find((w: WorkspaceState) => w.kind === "github"),
    );
  }

  function broadcastState() {
    if (broadcastScheduled) return;
    broadcastScheduled = true;
    queueMicrotask(() => {
      broadcastScheduled = false;
      // A throw here (e.g. from getPayload()) has no promise/caller to reject
      // into — it becomes an uncaughtException (worse than an unhandled
      // rejection) and silently drops this broadcast tick. Catch and log.
      try {
        const payload = getPayload();
        events.emit("state:updated", payload);
        void mobileManager.syncProfileAccess().catch((err: unknown) => {
          log.warn("profile access sync failed", { code: (err as Error)?.name });
        });
        checkAndForwardPrNotificationsToTelegram();
        checkAndForwardPipelineNotificationsToTelegram();
      } catch (err) {
        log.error("broadcastState tick failed", { err: (err as Error)?.message || String(err) });
      }
    });
  }

  // Debounced persistence — coalesces a burst of in-memory mutations (mostly
  // from agent-task-runner.setTaskState) into a single store.save() so the
  // disk file isn't rewritten dozens of times per second. Used to make task
  // lifecycle transitions durable without paying for atomic writes on every
  // hook event.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePersist(): void {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      store.save().catch((err: unknown) => {
        log.warn("schedulePersist: save failed", { err: (err as Error)?.message });
      });
    }, 250);
  }

  // --- Telegram command dispatch (extracted to runtime-telegram-dispatch.js) ---
  const { dispatchTelegramCommand } = createTelegramDispatch({
    log,
    getState,
    telegramManager,
    getRt: () => _rt,
    sessions,
    clearAlertSession,
    broadcastState,
    worktreeTreePath,
    captureMainWindowPng: dependencies.captureMainWindowPng,
    ensureWindowForProfile: dependencies.ensureWindowForProfile,
  });
  telegramManager.on("command", (cmd: unknown) => {
    void dispatchTelegramCommand(cmd);
  });

  // --- Task runner init (needs broadcastState and sessions) ---
  taskRunner.init({
    writeToSession(sessionId, data) {
      sessions.writeToSession(sessionId, data);
      markSessionPromptInjected(sessionId);
    },
    getState,
    broadcastState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raiseAlert({ projectId, panelId, sessionId, title, kind, detail, tier, urgency, exitCode }: any) {
      // Task runner completions/failures are authoritative — always T1.
      // `failed` variants are urgent so the user notices a broken task.
      const inferredUrgency = urgency || (kind === "waiting" || kind === "completed" ? "normal" : "urgent");
      raiseAlert({
        projectId,
        panelId,
        sessionId,
        title,
        kind,
        detail,
        tier: tier ?? 1,
        urgency: inferredUrgency,
        exitCode,
      });
    },
    async restartSession(sessionId) {
      clearTerminalReplay(String(sessionId || ""));
      await sessions.restartSession(getState(), sessionId);
      resetSessionSignal(sessionId);
    },
    // Debounced persistence trigger. taskRunner mutates state in-memory and
    // relies on opportunistic store.mutate() calls elsewhere to flush to
    // disk. That's flaky for crash recovery: a task that flips to "running"
    // and is then killed before any unrelated mutation runs would never have
    // its active state persisted, so reconcileOnStartup wouldn't see it as a
    // candidate. Schedule an async save so lifecycle transitions reach disk.
    saveState() {
      schedulePersist();
    },
    // Krok 2/9 — is the session provably still working? busy flag plus recent
    // output (last 30s) or an active sub-agent burst. Used to avoid giving up
    // on the judge while it's mid-evaluation.
    isSessionBusy(sessionId: string) {
      const signal = sessionSignals.get(sessionId);
      if (!signal) return false;
      const recentOutput = signal.lastOutputAt > 0 && Date.now() - signal.lastOutputAt < 30_000;
      return Boolean(signal.busy) && recentOutput;
    },
    // Krok 1 — has this session proven it emits completion/UserPromptSubmit
    // hooks? Only then can we wait for a submit confirmation.
    isSessionHookCapable(sessionId: string) {
      const signal = sessionSignals.get(sessionId);
      return Boolean(signal?.completionHookCapable);
    },
    // Dropout detection — last output looks like a bare shell prompt, i.e. the
    // agent CLI exited back to its parent shell mid-task (forced update / crash)
    // without the PTY dying. Lets the task runner restart the agent.
    isAgentDroppedToShell(sessionId: string) {
      const signal = sessionSignals.get(sessionId);
      return Boolean(signal?.lastOutputLine && looksLikeShellPrompt(signal.lastOutputLine));
    },
  });

  // Collect tasks that were active when the app last closed.
  // taskRunner.init() ran #reconcileOnStartup, which paused those tasks
  // and built the candidate list. We surface the list to the renderer via
  // meta.recoveryCandidates (see getMeta below) so the dialog can open.
  // The dialog is the only resume path — silent auto-resume was unreliable
  // (the freshly-spawned agent's first idle event sometimes never reached
  // the runner, leaving the task stuck on "running" forever).
  _recoveryCandidates = taskRunner.getStartupRecoveryCandidates();
  if (_recoveryCandidates.length > 0) {
    log.info("startup: found tasks active at last close", {
      count: _recoveryCandidates.length,
    });
  }

  async function ensureRemoteOriginReady(remoteConfig: { host?: string; port?: number }): Promise<string> {
    const originUrl = createTunnelOriginUrl(remoteConfig);
    await checkRemoteOriginImpl(originUrl);
    return originUrl;
  }

  /**
   * Phase 2 § 3.2.4. Accumulate typed characters and, on Enter, classify
   * the completed command.  Simple heuristic — handles printable keystrokes
   * and basic backspace; ignores arrow keys / escape sequences (they don't
   * change the command text for classification purposes).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function updateCommandClassFromInput(signal: any, data: any) {
    if (!signal || !data) return;
    for (const ch of String(data)) {
      if (ch === "\r" || ch === "\n") {
        const cmd = signal.inputBuffer.trim();
        signal.inputBuffer = "";
        if (cmd) {
          const cls = classifyCommand(cmd);
          signal.commandClass = cls;
          signal.currentCommand = cmd.slice(0, 120);
          log.debug("command classified", { sessionId: signal.sessionId, cls, cmd: signal.currentCommand });
        }
      } else if (ch === "\u007f" || ch === "\b") {
        // Backspace / DEL — trim last char
        signal.inputBuffer = signal.inputBuffer.slice(0, -1);
      } else if (ch === "\u0003" || ch === "\u0004") {
        // Ctrl-C / Ctrl-D — abandon buffer and reset class
        signal.inputBuffer = "";
        signal.commandClass = "";
        signal.currentCommand = "";
      } else if (ch >= " " && ch !== "\u001b") {
        // Printable ASCII + beyond (printable). Skip ESC sequences.
        signal.inputBuffer += ch;
        // Hard cap — we don't need more than 200 chars for classification
        if (signal.inputBuffer.length > 200) signal.inputBuffer = signal.inputBuffer.slice(-200);
      }
    }
  }

  /**
   * Plan Phase 1 § 4.7 / Phase 2 § 3.2.5.
   * Was the user actively typing in this session within the grace window?
   * Used to suppress silence-based (T3) alerts — if the user interacted
   * seconds ago, they are obviously present and don't need a notification.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function isInInteractionGrace(signal: any, notifConfig: any) {
    if (!signal?.lastUserInteractionAt) return false;
    const graceMs = notifConfig?.userInteractionGraceMs ?? 10_000;
    return Date.now() - signal.lastUserInteractionAt < graceMs;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function isKnownPluginProject(project: any) {
    if (!project) {
      return false;
    }
    if (project.source === "plugin" || project.pluginId) {
      return true;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return pluginManager.getPlugins().some((plugin: any) => {
      if (plugin.error || !plugin.workspaceDefaults) {
        return false;
      }
      const template = plugin.workspaceDefaults;
      const templateName = template.name || plugin.name;
      const templateIcon = template.icon || plugin.icon || APP_CONFIG.ui.defaultProjectIcon;
      const templateKind = template.kind || plugin.kind || APP_CONFIG.ui.defaultProjectKind;
      return templateName === project.name && templateIcon === project.icon && templateKind === project.kind;
    });
  }

  // perf-3: per-workspace debounce map for git refresh triggered by OSC 133;D
  const gitRefreshDebounceMap = new Map<string, ReturnType<typeof setTimeout>>();
  // Krok 3: last time a shell-triggered refresh actually ran, per workspace —
  // drives the leading-edge rate limit so an agent OSC storm doesn't spawn
  // ~15 git.exe per OSC, ~1x/sec for the whole turn.
  const lastShellRefreshAt = new Map<string, number>();
  const SHELL_GIT_REFRESH_MIN_INTERVAL_MS = Math.max(0, APP_CONFIG.git.shellRefreshMinIntervalMs || 0);

  function runShellGitRefresh(workspaceId: string) {
    gitRefreshDebounceMap.delete(workspaceId);
    lastShellRefreshAt.set(workspaceId, Date.now());
    refreshGit(workspaceId).catch((err: unknown) => {
      log.debug("shell git refresh failed", { workspaceId, err: (err as Error)?.message || String(err) });
    });
    broadcastState();
  }

  function scheduleGitRefreshFromShell(workspaceId: string) {
    const existing = gitRefreshDebounceMap.get(workspaceId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      gitRefreshDebounceMap.delete(workspaceId);
      const decision = shouldRefreshNow(
        Date.now(),
        lastShellRefreshAt.get(workspaceId) ?? -Infinity,
        SHELL_GIT_REFRESH_MIN_INTERVAL_MS,
      );
      if (decision.refresh) {
        runShellGitRefresh(workspaceId);
      } else {
        // Within the min interval: coalesce — re-arm a timer for the remaining
        // time so the LAST state is always eventually refreshed (an OSC arriving
        // before it fires just resets the 1s debounce again, deferring further).
        const reTimer = setTimeout(() => runShellGitRefresh(workspaceId), decision.deferMs);
        gitRefreshDebounceMap.set(workspaceId, reTimer);
      }
    }, 1000);
    gitRefreshDebounceMap.set(workspaceId, timer);
  }

  // Per-session dedup for rate-limit alerts. The same banner can scroll
  // multiple times in the agent's output and we only want one alert per
  // window. Also covers redrawn TUIs (Claude's prompt-limit dialog repaints).
  const lastRateLimitAlertAt = new Map<string, number>();
  const RATE_LIMIT_ALERT_DEDUP_MS = 60_000;

  // Krok 7: throttle the per-PTY-chunk bell/trace log lines. An agent emitting
  // BEL on every chunk produced ~17.5k log lines/day in dev (trace+debug per
  // chunk), drowning the log. Gate to ≤1 line / 10s / session; the bell
  // detection itself is unchanged.
  const bellLogGate = createIntervalGate(10_000);

  /**
   * Raise an urgent waiting-alert when ANY agent (task worker or plain
   * terminal) hits its provider's rate limit. The detail string format
   * `rate-limited:<provider>[, resumes <time>]` is what the frontend
   * notification capture parses to render the user-facing message.
   */
  function raiseRateLimitAlert(
    sessionId: string,
    workspaceId: string,
    panelId: string,
    panelTitle: string,
    match: import("./runtime-utils.js").RateLimitMatch,
  ): void {
    const now = Date.now();
    const last = lastRateLimitAlertAt.get(sessionId) || 0;
    if (now - last < RATE_LIMIT_ALERT_DEDUP_MS) return;
    lastRateLimitAlertAt.set(sessionId, now);

    const resetSuffix = match.resetAt ? `, resumes ${match.resetAt.toLocaleTimeString()}` : "";
    const detail = `rate-limited:${match.providerHint}${resetSuffix}`;

    log.warn("rate-limit alert raised", {
      sessionId,
      workspaceId,
      providerHint: match.providerHint,
      needsConfirm: match.needsConfirm,
      resetAt: match.resetAt?.toISOString() || null,
    });

    raiseAlert({
      sessionId,
      projectId: workspaceId,
      panelId,
      title: panelTitle,
      kind: "waiting",
      tier: 1,
      urgency: "urgent",
      detail,
      exitCode: null,
    });
  }

  // Two-stage rate-limit confirmation. Regex matching against agent output
  // is inherently fragile — the worker editing rate-limit-related code emits
  // diff lines, comments, and test output that contain the exact phrases the
  // detectors look for. Stage 1 marks the session as "suspected" without
  // raising any alert or setting task.rateLimitedUntil. Stage 2 fires after
  // a confirmation window and checks whether the agent actually went quiet
  // (real rate limit) or kept producing output (false positive).
  //
  // The alternative — firing immediately on first match — locked up a real
  // task run when the worker's own diff scrolled "the runner was rate-limited"
  // through stdout. The user explicitly chose latency over premature action.
  interface RateLimitSuspicion {
    match: import("./runtime-utils.js").RateLimitMatch;
    workspaceId: string;
    panelId: string;
    panelTitle: string;
    suspectedAt: number;
    lastOutputAt: number;
    timer: ReturnType<typeof setTimeout>;
  }
  const rateLimitSuspicions = new Map<string, RateLimitSuspicion>();
  // Window after a match during which the session is observed before the
  // alert fires. 60 s outlasts even long extended-thinking pauses (Claude's
  // deeper reasoning modes routinely sit silent 30–45 s mid-turn) — anything
  // shorter false-confirmed when the worker happened to pause right after
  // emitting code that mentioned rate-limit terms. Latency cost on a real
  // rate-limit (which lasts hours) is negligible.
  const RATE_LIMIT_CONFIRM_WINDOW_MS = 60_000;
  // Output is allowed to trail the match for this long (TUI repaint, the
  // tail end of the same buffer) without flipping to "agent kept working".
  const RATE_LIMIT_TRAILING_TOLERANCE_MS = 5_000;

  function trackRateLimitOutput(sessionId: string, now: number): void {
    const suspicion = rateLimitSuspicions.get(sessionId);
    if (suspicion) suspicion.lastOutputAt = now;
  }

  function clearRateLimitSuspicion(sessionId: string): void {
    const suspicion = rateLimitSuspicions.get(sessionId);
    if (!suspicion) return;
    clearTimeout(suspicion.timer);
    rateLimitSuspicions.delete(sessionId);
  }

  function suspectRateLimit(
    sessionId: string,
    workspaceId: string,
    panelId: string,
    panelTitle: string,
    match: import("./runtime-utils.js").RateLimitMatch,
  ): void {
    if (rateLimitSuspicions.has(sessionId)) return; // already observing this session
    const now = Date.now();
    const timer = setTimeout(() => {
      void (async () => {
        // Whole body wrapped in try/catch (mirrors scheduleBackgroundDeleteRetry):
        // without it, a throw from raiseRateLimitAlert/onAgentRateLimited (or
        // anything else below) is an unhandled rejection and the rate-limit
        // handoff silently vanishes with no diagnostic trail.
        try {
          const s = rateLimitSuspicions.get(sessionId);
          if (!s) return;
          rateLimitSuspicions.delete(sessionId);
          const trailingMs = s.lastOutputAt - s.suspectedAt;
          if (trailingMs > RATE_LIMIT_TRAILING_TOLERANCE_MS) {
            log.debug("rate-limit suspicion dropped: agent kept working past silence window", {
              sessionId,
              trailingMs,
              providerHint: s.match.providerHint,
            });
            return;
          }

          // Silence detected — but verify with WORK_LOCK before declaring it
          // a rate-limit. If the worker has already deleted WORK_LOCK, the
          // silence is "task finished", not "quota hit", and we must not
          // raise an alert or set rateLimitedUntil (which would block the
          // judge from running). Run the existing idle pipeline instead.
          try {
            // The WORK_LOCK-absence override only makes sense for the WORKER:
            // for a judge session, WORK_LOCK is absent by definition (the worker
            // finished — that's why the judge is running), so applying it there
            // would mistake a real judge rate-limit for "task finished" (incident
            // C). Only short-circuit for the worker panel.
            const taskState = taskRunner.getTaskState(s.workspaceId);
            const isWorkerPanel = !taskState || s.panelId === taskState.workerPanelId;
            if (isWorkerPanel && (await taskRunner.isWorkerCompleted(s.workspaceId))) {
              log.warn("rate-limit suspicion overridden by WORK_LOCK absence on confirm", {
                sessionId,
                providerHint: s.match.providerHint,
              });
              taskRunner.onAgentIdle(sessionId, "rate-limit-override-on-confirm");
              return;
            }
          } catch (err) {
            // isWorkerCompleted is best-effort; on error fall through to the
            // original alert path so we don't silently lose a real rate-limit.
            log.debug("isWorkerCompleted threw on confirm — proceeding with alert", {
              sessionId,
              err: (err as Error)?.message,
            });
          }

          log.warn("rate-limit confirmed after silence window", {
            sessionId,
            trailingMs,
            providerHint: s.match.providerHint,
          });
          raiseRateLimitAlert(sessionId, s.workspaceId, s.panelId, s.panelTitle, s.match);
          // Hand off to the task runner only AFTER confirmation. For non-task
          // sessions this is a no-op; for task workers it sets rateLimitedUntil
          // and schedules the auto-resume timer; for the judge it presses Enter on
          // the dialog and sets a judge-specific hold. Deferring this is the whole
          // point of the two-stage check — premature handoff is what blocks
          // the judge when the original match was a false positive.
          taskRunner.onAgentRateLimited(sessionId, s.match, "output-detect-confirmed");
        } catch (err) {
          log.warn("rate-limit confirm-timer failed", {
            sessionId,
            workspaceId,
            panelId,
            err: (err as Error)?.message,
          });
        }
      })();
    }, RATE_LIMIT_CONFIRM_WINDOW_MS);
    rateLimitSuspicions.set(sessionId, {
      match,
      workspaceId,
      panelId,
      panelTitle,
      suspectedAt: now,
      lastOutputAt: now,
      timer,
    });
    log.debug("rate-limit suspected, waiting for confirmation", {
      sessionId,
      providerHint: match.providerHint,
      windowMs: RATE_LIMIT_CONFIRM_WINDOW_MS,
    });
  }

  const codexTerminalNotifications = new Map<string, CodexTerminalNotifications>();

  // New process generation under an existing sessionId (fresh spawn, implicit
  // ensureSession respawn, or SSH reconnect). Clear the previous generation's
  // replay so a later attach/subscribe doesn't prepend a dead process's screen
  // to the new prompt. clearTerminalReplay keeps the sequence counter, so a
  // client still holding the old throughSeq can't mistake new output for
  // duplicates. Fires before the new generation's first output (data events
  // dispatch async after the spawn).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions.on("terminal:spawned", (payload: any) => {
    codexTerminalNotifications.delete(String(payload.sessionId || ""));
    clearTerminalReplay(String(payload.sessionId || ""));
  });

  // A panel removed from state (e.g. saveWorkspace → sessions.syncWithState)
  // permanently drops its session. Destroy its replay so removed panels don't
  // leak replay memory and their stale output can't be re-served on a later
  // subscribe. (Restart uses clearTerminalReplay above, which keeps the counter;
  // destroy drops it entirely.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions.on("terminal:removed", (payload: any) => {
    const sessionId = String(payload.sessionId || "");
    codexTerminalNotifications.delete(sessionId);
    destroyTerminalReplay(sessionId);
    // A removed panel's attention alert has nothing left to point at. Workspace
    // deletion clears alerts wholesale via cleanupWorkspaceRuntimeState, but a
    // panel removed on its own only reached syncSessionSignalsWithState, which
    // drops the signal and leaves the raised alert behind.
    if (sessionId) clearAlertSession(sessionId);
    // Forward to remote clients so the remote-server can prune the id from every
    // socket's live subscription set. Without this a socket keeps the removed id
    // subscribed: a recreated same-id panel would stream live frames with no
    // fresh replay handshake, and a resubscribe would skip replay entirely.
    events.emit("terminal:removed", payload);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions.on("terminal:data", (payload: any) => {
    const descriptor = parseSessionId(payload.sessionId);
    const state = getState();
    const project = descriptor ? (findWorkspace(state, descriptor.workspaceId) as WorkspaceState | null) : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const panel = (project as any)?.panels?.find((item: any) => item.id === descriptor?.panelId) || null;
    const rawText = String(payload.data || "");
    const cleanText = rawText ? stripAnsi(rawText) : "";
    // Assign the monotonic per-session sequence and stamp it on the payload
    // before re-emitting, so both the Electron IPC relay and the remote WS
    // relay forward an ordered stream. Remote clients use it to order replay
    // against live frames; Electron ignores it.
    payload.seq = appendTerminalReplay(String(payload.sessionId || ""), rawText);

    if (descriptor && project && panel && state.settings?.notifications?.agentHook !== false) {
      let parser = codexTerminalNotifications.get(payload.sessionId);
      if (!parser) {
        parser = new CodexTerminalNotifications();
        codexTerminalNotifications.set(payload.sessionId, parser);
      }
      for (const message of parser.feed(rawText)) {
        const signal = getSessionSignal(payload.sessionId, project, panel);
        cancelPromptTimer(signal);
        // OSC questions can be hidden behind the TUI's queued-input overlay even in a visible tab.
        raiseAlert({
          sessionId: payload.sessionId,
          projectId: descriptor.workspaceId,
          panelId: descriptor.panelId,
          title: panel.title || descriptor.panelId,
          kind: "question",
          tier: 1,
          urgency: "urgent",
          detail: "terminal:codex:question",
          message,
        });
      }
    }

    // Rate-limit detection runs for ANY agent in ANY tab — Docker shells,
    // plugin panels, plain terminals, task workers. Hitting a provider limit
    // is a user-visible event regardless of where the agent is running, and
    // the existing `shouldTrackProjectAlert` gate (further down) excludes
    // some of those panel kinds. Detection happens before the gate so all
    // sessions are covered. A match here is only a SUSPICION — confirmation
    // happens after a silence window so a banner scrolled through during
    // unrelated work doesn't fire an alert and lock up the task runner.
    trackRateLimitOutput(payload.sessionId, Date.now());
    if (descriptor && project && panel && cleanText) {
      const rateLimitMatch = detectRateLimit(cleanText);
      if (rateLimitMatch) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const panelTitle = ((panel as any).title as string) || descriptor.panelId;
        suspectRateLimit(payload.sessionId, descriptor.workspaceId, descriptor.panelId, panelTitle, rateLimitMatch);
      }
    }

    if (descriptor && shouldTrackProjectAlert(project, panel)) {
      const signal = getSessionSignal(payload.sessionId, project, panel);
      const notifConfig = getNotificationConfig(state);
      const lastLine = lastNonEmptyLine(cleanText);

      if (AGENT_OUTPUT_RE.test(cleanText)) {
        signal.agentLike = true;
      }

      // Phase 2 § 3.2.7 bullet 1: if the session has been genuinely silent
      // for longer than 5× agentQuietMs, reset the busy latch. The next burst
      // starts fresh, so a stale "busy" from hours ago can't piggy-back a
      // false positive onto a small, unrelated output blip.
      if (signal.busy && signal.lastOutputAt > 0) {
        const idleFor = Date.now() - signal.lastOutputAt;
        const staleThreshold = 5 * notifConfig.agentQuietMs;
        if (idleFor > staleThreshold) {
          log.debug("resetting stale busy latch after long silence", {
            sessionId: payload.sessionId,
            idleMs: idleFor,
            thresholdMs: staleThreshold,
          });
          cancelPromptTimer(signal);
          signal.busy = false;
          signal.outputBursts = 0;
          signal.waitingRaised = false;
        }
      }

      // Phase 3 § 3.2.2: track animation activity for T3 suppression
      if (hasRecentAnimation(rawText)) {
        signal.lastAnimationAt = Date.now();
      }

      // --- OSC 133;C: command submitted (shell-integration) ---
      // Mark the tab as "running". No alert semantics, no interaction with
      // signal.busy — this is purely the UI chip.
      if (OSC133_COMMAND_START_RE.test(rawText)) {
        setSessionActivity(signal, "running");
      }

      // --- OSC 133;D: shell integration command-finished signal ---
      // When a shell with integration (bash/zsh/PowerShell) emits OSC 133;D,
      // the previous command has finished and the shell prompt has returned.
      // This gives us instant, reliable detection for shell-hosted agents.
      const osc133FinishedMatch = rawText.match(OSC133_COMMAND_FINISHED_RE);
      if (osc133FinishedMatch) {
        const exitCode = osc133FinishedMatch[1] != null ? Number(osc133FinishedMatch[1]) : 0;
        setSessionActivity(signal, "done", { exitCode });
        log.debug("OSC 133;D detected", {
          sessionId: payload.sessionId,
          busy: signal.busy,
          hasUserInput: signal.hasUserInput,
        });
        // Refresh lastOutputLine before the task-runner intercept: OSC chunks
        // skip the agent branches below that normally update it (see comment at
        // the end of this branch), but the task runner's dropout guard reads
        // lastOutputLine right now to tell "agent idle" from "agent exited to a
        // shell prompt". Without this it would see the pre-exit line and miss
        // the dropout. Only touches freshness on this path; the alert/silence
        // consumers run on non-OSC chunks.
        if (lastLine) signal.lastOutputLine = lastLine;
        // Agent exited back to its host shell? agentLike is otherwise sticky,
        // which would leave the shell without completion alerts forever (the
        // agent branches below swallow everything). OSC 133;D plus an
        // unambiguous shell prompt (PS / drive / $ / # — NOT ❯/›/➜, which
        // agent TUI status lines also use) is reliable evidence the shell
        // owns the terminal again. AGENT_OUTPUT_RE re-promotes on the next
        // agent launch, and getSessionSignal re-promotes panels whose command
        // itself is an agent.
        if (signal.agentLike && lastLine && matchesShellPromptStrict(lastLine)) {
          log.debug("agent session demoted to shell (shell prompt after OSC 133;D)", {
            sessionId: payload.sessionId,
            lastLine,
          });
          signal.agentLike = false;
          signal.hookCapable = false;
          signal.completionHookCapable = false;
        }
        // Task runner intercept FIRST — bypass hasUserInput/cooldown guards
        if (taskRunner.onAgentIdle(payload.sessionId, "osc133")) {
          log.debug("OSC 133;D: task runner handled idle", { sessionId: payload.sessionId });
          cancelPromptTimer(signal);
        } else if (signal.hasUserInput && !signal.agentLike) {
          // OSC 133;D as an alert source is reliable ONLY for real shells
          // (bash / zsh / pwsh / cmd with shell-integration), where the
          // sequence marks a true command-finished boundary. Agent TUIs
          // (Claude Code, Codex, Gemini) emit OSC 133;D multiple times
          // within a single turn — once per UI prompt, tool-permission ask,
          // or status update between tool uses — so treating it as
          // "command finished" produced false-positive "waiting for input"
          // alerts whenever the user briefly looked away mid-turn (the 5s
          // visibility grace expired before the next OSC arrived, then the
          // next OSC fired the alert from the not-visible branch below).
          //
          // For agent sessions, end-of-turn detection flows through hooks
          // (Stop event → classifier → raiseAlert) and the 2-min silence
          // fallback in the agent branches further down. The same long-turn
          // false-positive reasoning the original author already applied to
          // silence detection (see comment in the completion-hook branch below)
          // applies equally to OSC 133;D — extending the guard here closes
          // that gap.
          const now = Date.now();
          const inCooldown = signal.lastAlertAt > 0 && now - signal.lastAlertAt < notifConfig.alertCooldownMs;
          if (signal.busy && !inCooldown) {
            cancelPromptTimer(signal);
            if (isSessionVisible(payload.sessionId)) {
              log.trace("OSC 133;D: session visible, resetting", { sessionId: payload.sessionId });
              resetSessionSignal(payload.sessionId);
            } else if (!isShellAlertAllowed(signal, panel, state)) {
              log.trace("OSC 133;D: shell-only alert suppressed by agentsOnly setting", {
                sessionId: payload.sessionId,
              });
              cancelPromptTimer(signal);
            } else {
              log.debug("OSC 133;D triggering alert", { sessionId: payload.sessionId });
              raiseWaitingAlert({
                sessionId: payload.sessionId,
                projectId: descriptor.workspaceId,
                panelId: descriptor.panelId,
                title: panel?.title || descriptor.panelId,
                detail: "osc133-finished",
              });
            }
          } else if (inCooldown) {
            log.trace("OSC 133;D: cooldown active, skipping", {
              sessionId: payload.sessionId,
              remainingMs: notifConfig.alertCooldownMs - (now - signal.lastAlertAt),
            });
          }
        }
        // For shells, OSC 133;D is authoritative — the agent branches below
        // are skipped via the `else if` chain. For agents we entered this
        // block too (status update, task-runner intercept, git refresh) but
        // skipped the alert path above; the `else if` chain still skips the
        // agent branches for OSC chunks, which means busy/output tracking
        // misses chunks that contain OSC. That matches pre-existing behavior
        // and is acceptable because the next non-OSC chunk catches up; if
        // that ever turns out to be observable, refactor to run the agent
        // branches independently of OSC.
        // perf-3: schedule a debounced git refresh if this session is in a git workspace
        if (descriptor?.workspaceId) {
          const wsSnapshot = git.getSnapshot?.(descriptor.workspaceId);
          if (wsSnapshot?.available) {
            scheduleGitRefreshFromShell(descriptor.workspaceId);
          }
        }
      } else if (signal.agentLike && signal.completionHookCapable) {
        // --- Agent sessions with proven hooks: trust them exclusively ---
        // Phase 0 § 3.2.d — a session that has fired a completion/waiting hook
        // uses hooks as its ONLY alert source. Silence-based fallback is
        // off — it's the primary source of false positives during long
        // Claude Code turns. OSC 133;D is no longer an alert source for
        // agents either (see guard in the OSC block above), and BEL is only
        // tracked for diagnostics because agent TUIs can emit it while still
        // working.
        const hasBell = rawText.includes("\u0007");

        // Still track busy so task runner sees activity; still update
        // lastOutputLine so any future hook-fallback logic has context.
        if (cleanText.trim()) {
          signal.busy = true;
          signal.outputBursts += 1;
        }
        if (lastLine) {
          signal.lastOutputLine = lastLine;
        }
        signal.lastOutputAt = Date.now();

        if (hasBell) {
          const gate = bellLogGate.allow(`bell:${payload.sessionId}`);
          if (gate.allow)
            log.trace("agent hook-capable bell ignored", { sessionId: payload.sessionId, suppressed: gate.suppressed });
        }
        // No silence timer, no hook-fallback: hooks are the source of truth.
      } else if (signal.agentLike) {
        // --- Agent sessions without proven hooks: fallback path ---
        // Either hooks haven't fired yet (first turn) or config is broken.
        // We keep bell + silence detection as safety net.
        const now = Date.now();
        const inCooldown = signal.lastAlertAt > 0 && now - signal.lastAlertAt < notifConfig.alertCooldownMs;
        const hasBell = rawText.includes("\u0007");
        const hooksEnabled = notifyServerHandle != null;

        if (hasBell) {
          const gate = bellLogGate.allow(`bell:${payload.sessionId}`);
          if (gate.allow)
            log.debug("bell character detected in agent session", {
              sessionId: payload.sessionId,
              hooksEnabled,
              suppressed: gate.suppressed,
            });
        }

        // Track output activity regardless of detection mode.
        if (cleanText.trim()) {
          signal.busy = true;
          signal.outputBursts += 1;
        }
        if (lastLine) {
          signal.lastOutputLine = lastLine;
        }

        // Log a one-shot warning if an agent session has been busy for a long
        // time with no hook ever arriving — almost always a config issue.
        // Anchored on lastUserInteractionAt (PTY input, hook-independent):
        // the previous anchor was lastAlertAt, which never gets set now that
        // hook-primary mode raises no fallback alerts — the warning would be
        // dead exactly when it matters (broken hook delivery). The 5-minute
        // threshold keeps it quiet during ordinary long agent turns.
        if (
          signal.busy &&
          !signal.completionHookCapable &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          !(signal as any)._hookMissingWarned &&
          signal.lastOutputAt > 0 &&
          Date.now() - signal.lastOutputAt < 30_000 &&
          signal.lastUserInteractionAt > 0 &&
          Date.now() - signal.lastUserInteractionAt > 300_000
        ) {
          log.warn(
            "agent session active >5min since last input with no completion hook event — hook may be misconfigured",
            {
              sessionId: payload.sessionId,
              agentLike: signal.agentLike,
            },
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (signal as any)._hookMissingWarned = true;
        }

        if (hooksEnabled) {
          // --- Hook-primary mode: hooks are the only user-facing alert source ---
          // The 2-min silence timer no longer raises a fallback "waiting"
          // alert. When the user runs with the notify server on, a session
          // whose hooks don't deliver stays silent instead of producing false
          // positives — e.g. Claude Code sitting at an idle prompt while a
          // background agent is still working looked exactly like "waiting
          // for input" to the silence heuristic. Hook delivery problems are
          // visible in hook.log and the one-shot misconfig warning above.
          // Record output time; the self-rescheduling timer checks this lazily
          // instead of cancel+restart on every PTY chunk.
          signal.lastOutputAt = Date.now();

          // Task sessions still need the silence timer: the runner has its
          // own state machine and must get the idle tick even if nothing has
          // been typed into the PTY yet (e.g. task started with no
          // description, waiting for the first idle so we can inject
          // "read TASK.md").
          const isTaskSession = taskRunner.getIdleTimeout(payload.sessionId) != null;
          if (signal.busy && !inCooldown && isTaskSession && !signal.promptTimer) {
            const sid = payload.sessionId;
            signal.promptTimer = setTimeout(function hookFallbackCheck() {
              const silentFor = Date.now() - (signal.lastOutputAt || 0);
              if (silentFor < HOOK_FALLBACK_SILENCE_MS) {
                // Output arrived recently — reschedule for the remaining silence window
                signal.promptTimer = setTimeout(hookFallbackCheck, HOOK_FALLBACK_SILENCE_MS - silentFor);
                return;
              }
              signal.promptTimer = null;
              // Task workspaces have their own validation (WORK_LOCK, TODO
              // checks) so they don't need the idle-pattern guard.  Claude
              // Code's statusbar line doesn't match AGENT_IDLE_PATTERNS,
              // which would block task detection otherwise.
              if (taskRunner.onAgentIdle(sid, "hook-fallback")) {
                log.info("hook-fallback silence: task runner handled idle", { sessionId: sid });
              }
            }, HOOK_FALLBACK_SILENCE_MS);
          }
        } else {
          // --- No-hook fallback: bell + silence detection (original behavior) ---
          if (hasBell && !inCooldown && signal.hasUserInput) {
            cancelPromptTimer(signal);
            if (isSessionVisible(payload.sessionId)) {
              log.trace("bell: session visible, resetting", { sessionId: payload.sessionId });
              resetSessionSignal(payload.sessionId);
            } else {
              raiseWaitingAlert({
                sessionId: payload.sessionId,
                projectId: descriptor.workspaceId,
                panelId: descriptor.panelId,
                title: panel?.title || descriptor.panelId,
                detail: "explicit-input",
              });
            }
          } else {
            // Record output time; the self-rescheduling timer checks this lazily
            // instead of cancel+restart on every PTY chunk.
            signal.lastOutputAt = Date.now();

            const hookActive = signal.lastHookAlertAt > 0 && Date.now() - signal.lastHookAlertAt < 60_000;

            // Task sessions bypass hasUserInput — runner needs the idle tick
            // even without prior PTY input (e.g. description-less task waiting
            // for first idle to inject "read TASK.md").
            const providerIdleMs = taskRunner.getIdleTimeout(payload.sessionId);
            const isTaskSession = providerIdleMs != null;
            if (
              signal.busy &&
              !inCooldown &&
              (signal.hasUserInput || isTaskSession) &&
              !hookActive &&
              !signal.promptTimer
            ) {
              // Phase 3 § 3.2.6: adaptive multiplier reduces noise for
              // sessions the user keeps dismissing.
              // For task sessions, use the provider's idleTimeoutMs (e.g. 8s for
              // Codex/Gemini vs the global 20s agentQuietMs).
              const baseQuietMs =
                providerIdleMs != null
                  ? providerIdleMs
                  : signal.outputBursts >= AGENT_OUTPUT_BURST_THRESHOLD
                    ? notifConfig.agentQuietFastMs
                    : notifConfig.agentQuietMs;
              const quietMs = baseQuietMs * adaptiveMultiplier(payload.sessionId);
              const sid = payload.sessionId;
              signal.promptTimer = setTimeout(function silenceCheck() {
                const silentFor = Date.now() - (signal.lastOutputAt || 0);
                if (silentFor < quietMs) {
                  // Output arrived recently — reschedule for the remaining silence window
                  signal.promptTimer = setTimeout(silenceCheck, quietMs - silentFor);
                  return;
                }
                signal.promptTimer = null;
                // Task runner intercept FIRST (same rationale as hook-fallback path)
                if (taskRunner.onAgentIdle(sid, "silence")) {
                  log.info("agent silence: task runner handled idle", { sessionId: sid });
                  return;
                }
                if (signal.lastOutputLine && !matchesAgentIdle(signal.lastOutputLine)) {
                  log.trace("agent silence expired but last line not idle", {
                    sessionId: sid,
                    lastOutputLine: signal.lastOutputLine,
                  });
                  return;
                }
                if (isSessionVisible(sid)) {
                  log.trace("agent silence: session visible, resetting", { sessionId: sid });
                  resetSessionSignal(sid);
                  return;
                }
                if (isInInteractionGrace(signal, notifConfig)) {
                  log.trace("agent silence: user interacted recently, suppressing T3", { sessionId: sid });
                  return;
                }
                if (!allowT3ForCommandClass(signal.commandClass)) {
                  log.trace("agent silence: command class suppresses T3", {
                    sessionId: sid,
                    commandClass: signal.commandClass,
                  });
                  return;
                }
                if (isT3Disabled(sid)) {
                  log.trace("agent silence: T3 disabled by adaptive suppression", { sessionId: sid });
                  return;
                }
                // Phase 3 § 3.2.2: program was animating recently — not idle
                if (signal.lastAnimationAt > 0 && Date.now() - signal.lastAnimationAt < 2_000) {
                  log.trace("agent silence: animation still active, suppressing T3", { sessionId: sid });
                  return;
                }
                log.debug("agent silence timer triggering T3 alert", {
                  sessionId: sid,
                  quietMs,
                  lastOutputLine: signal.lastOutputLine,
                });
                raiseAlert({
                  sessionId: sid,
                  projectId: descriptor.workspaceId,
                  panelId: descriptor.panelId,
                  title: panel?.title || descriptor.panelId,
                  kind: "waiting",
                  tier: 3,
                  urgency: "normal",
                  detail: "prompt-returned",
                });
              }, quietMs);
            }
          }
        }
      } else if (!isShellAlertAllowed(signal, panel, state)) {
        // --- Non-agent shell session, agentsOnly suppresses ---
        // Skip prompt-pattern / WAITING_PATTERNS detection entirely. The user
        // doesn't want shell-completion pings on this panel. Still track
        // busy/output bookkeeping so exit-alert gating works correctly —
        // only alert raising is gated.
        if (cleanText.trim()) {
          signal.busy = true;
          cancelPromptTimer(signal);
        }
      } else {
        // --- Non-agent sessions: prompt-pattern detection ---
        // Plan Phase 1 § 4.1: end-of-line anchored WAITING_PATTERNS only.
        // Use the raw lastLine (with case) — patterns are /i anyway, and
        // lowercasing was belt-and-braces that hid nothing useful.
        const explicitWaiting = rawText.includes("\u0007") || matchesWaitingPattern(lastLine);
        const promptLike = matchesPrompt(lastLine);
        const onlyPrompt = promptLike && cleanText.trim() === lastLine.trim();

        if (cleanText.trim() && !onlyPrompt) {
          signal.busy = true;
          cancelPromptTimer(signal);
        }

        const now = Date.now();
        const inCooldown = signal.lastAlertAt > 0 && now - signal.lastAlertAt < notifConfig.alertCooldownMs;

        if (explicitWaiting && !inCooldown && signal.hasUserInput) {
          log.debug("explicit waiting pattern detected", { sessionId: payload.sessionId, lastLine });
          cancelPromptTimer(signal);
          if (isSessionVisible(payload.sessionId)) {
            resetSessionSignal(payload.sessionId);
          } else {
            // T2: pattern confirmation, not a silence heuristic.
            raiseAlert({
              sessionId: payload.sessionId,
              projectId: descriptor.workspaceId,
              panelId: descriptor.panelId,
              title: panel?.title || descriptor.panelId,
              kind: "waiting",
              tier: 2,
              urgency: "normal",
              detail: "explicit-input",
            });
          }
        } else if (promptLike && signal.busy && !inCooldown && signal.hasUserInput) {
          log.trace("prompt-like pattern detected, starting quiet timer", {
            sessionId: payload.sessionId,
            promptQuietMs: notifConfig.promptQuietMs,
            lastLine,
          });
          cancelPromptTimer(signal);
          const sid = payload.sessionId;
          signal.promptTimer = setTimeout(() => {
            signal.promptTimer = null;
            if (isSessionVisible(sid)) {
              log.trace("prompt quiet expired: session visible, resetting", { sessionId: sid });
              resetSessionSignal(sid);
              return;
            }
            if (isInInteractionGrace(signal, notifConfig)) {
              log.trace("prompt quiet: user interacted recently, suppressing T3", { sessionId: sid });
              return;
            }
            if (!allowT3ForCommandClass(signal.commandClass)) {
              log.trace("prompt quiet: command class suppresses T3", {
                sessionId: sid,
                commandClass: signal.commandClass,
              });
              return;
            }
            if (isT3Disabled(sid)) {
              log.trace("prompt quiet: T3 disabled by adaptive suppression", { sessionId: sid });
              return;
            }
            if (signal.lastAnimationAt > 0 && Date.now() - signal.lastAnimationAt < 2_000) {
              log.trace("prompt quiet: animation still active, suppressing T3", { sessionId: sid });
              return;
            }
            log.debug("prompt quiet timer triggering T3 alert", { sessionId: sid });
            raiseAlert({
              sessionId: sid,
              projectId: descriptor.workspaceId,
              panelId: descriptor.panelId,
              title: panel?.title || descriptor.panelId,
              kind: "waiting",
              tier: 3,
              urgency: "normal",
              detail: "prompt-returned",
            });
          }, notifConfig.promptQuietMs);
        }
      }
    }

    events.emit("terminal:data", payload);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions.on("terminal:exit", (payload: any) => {
    log.debug("terminal:exit", {
      sessionId: payload.sessionId,
      exitCode: payload.exitCode,
      intentional: payload.intentional,
    });
    // Notify task runner of session exit
    taskRunner.onSessionExit(payload.sessionId);
    const descriptor = parseSessionId(payload.sessionId);
    const state = getState();
    const project = descriptor ? (findWorkspace(state, descriptor.workspaceId) as WorkspaceState | null) : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const panel = (project as any)?.panels?.find((item: any) => item.id === descriptor?.panelId) || null;
    const signal = descriptor ? sessionSignals.get(payload.sessionId) : null;
    // Phase 2 § 3.2.4: exit alerts suppressed for shell class — shells exit
    // when the user types `exit` themselves; alerting is noise.
    const classAllowsExit = allowExitAlertForCommandClass(signal?.commandClass || "");
    const shouldRaiseAlert =
      !payload.intentional &&
      descriptor &&
      shouldTrackProjectAlert(project, panel) &&
      signal?.hasUserInput &&
      !isSessionVisible(payload.sessionId) &&
      classAllowsExit &&
      isShellAlertAllowed(signal, panel, state);
    if (shouldRaiseAlert) {
      raiseAlert({
        projectId: descriptor.workspaceId,
        panelId: descriptor.panelId,
        sessionId: payload.sessionId,
        title: panel?.title || descriptor.panelId,
        exitCode: payload.exitCode,
        kind: "completed",
        tier: 1,
        urgency: "normal",
        detail: `exit:${signal?.commandClass || "shell"}`,
      });
    }
    clearActivityFade(payload.sessionId);
    retireSession(payload.sessionId);
    // Keep replay after an UNEXPECTED exit so a client that connects afterwards
    // can still see why the process died. Only an intentional exit (a restart)
    // clears it — and clearTerminalReplay keeps the sequence counter so the new
    // generation's frames can't be mistaken for duplicates. Destroying the
    // session/panel drops the buffer via destroyTerminalReplay elsewhere.
    if (payload.intentional) {
      clearTerminalReplay(payload.sessionId);
    } else {
      // Fold the exit notice INTO the replay so it survives a later
      // subscribe/replay (which resets the xterm buffer). Without this the
      // renderer's live-synthesized "[process exited]" line is wiped by the next
      // term.reset() and a crashed background pane looks alive again. Text and
      // format must match the renderer's handleTerminalExit banner.
      appendTerminalReplay(String(payload.sessionId || ""), `\r\n[process exited with code ${payload.exitCode}]\r\n`);
    }
    lastRateLimitAlertAt.delete(payload.sessionId);
    clearRateLimitSuspicion(payload.sessionId);
    events.emit("terminal:exit", payload);
    broadcastState();
  });

  docker.on("updated", () => {
    broadcastState();
  });

  git.on("updated", () => {
    broadcastState();
  });

  azure.on("updated", () => {
    broadcastState();
  });

  github.on("updated", () => {
    broadcastState();
  });

  tunnel.on("updated", () => {
    broadcastState();
  });

  // Detect external review bridge changes (MCP agents writing drafts).
  // Uses fs.watch for instant notification + PRAGMA data_version polling as reliable fallback.
  let reviewBridgeWatcher: FSWatcher | null = null;
  let reviewBridgeDebounce: ReturnType<typeof setTimeout> | null = null;
  let reviewBridgeDataVersion = reviewBridgeStore.getDataVersion?.() || 0;

  function onReviewBridgeChange() {
    if (reviewBridgeDebounce) clearTimeout(reviewBridgeDebounce);
    reviewBridgeDebounce = setTimeout(() => {
      reviewBridgeDebounce = null;
      reviewBridgeDataVersion = reviewBridgeStore.getDataVersion?.() || 0;
      broadcastState();
    }, 100);
  }

  // 1. fs.watch on signal file — instant but unreliable on Windows
  const reviewBridgeSignalPath = reviewBridgeStore.getSignalPath?.() || "";
  if (reviewBridgeSignalPath) {
    writeFile(reviewBridgeSignalPath, "0").catch(() => {});
    try {
      reviewBridgeWatcher = watch(reviewBridgeSignalPath, () => onReviewBridgeChange());
      reviewBridgeWatcher.on("error", (err: unknown) => {
        // Degrades to the PRAGMA data_version polling backstop below —
        // silent otherwise, so log to leave a trace of the degradation.
        log.debug("review bridge signal watcher error", {
          reviewBridgeSignalPath,
          err: (err as Error)?.message || String(err),
        });
      });
    } catch {
      // fs.watch not available
    }
  }

  // 2. PRAGMA data_version polling — reliable fallback, catches anything the watcher misses.
  // 15 s is plenty for a backstop; the fs.watch above covers real-time updates.
  let reviewBridgePoll: ReturnType<typeof setInterval> | null = setInterval(() => {
    const currentVersion = reviewBridgeStore.getDataVersion?.() || 0;
    if (currentVersion !== reviewBridgeDataVersion) {
      onReviewBridgeChange();
    }
  }, 15000);

  async function refreshDocker() {
    return docker.refresh();
  }

  async function refreshGit(projectId: string | null = null, options: { useCache?: boolean } = {}) {
    // useCache=true skips invalidation so refreshWorkspaces' internal
    // snapshotCache (8 s TTL by default) can short-circuit when a recent
    // snapshot already exists. Used by the startup background warmup so a
    // first-time refresh populates the cache and re-entries within the TTL
    // are essentially free — without this the loop blindly re-spawned ~14
    // git processes per workspace even though the data hadn't changed.
    if (!options.useCache) {
      git.invalidateSnapshotCache?.(projectId || null);
    }
    const state = getState();
    const workspaces = state.workspaces.filter(
      (workspace) => (!projectId || workspace.id === projectId) && workspace.kind !== "azure",
    );
    return git.refreshWorkspaces(workspaces);
  }

  function resolveGitWorkspace(
    workspaceId: string | null = null,
    projectId: string | null = null,
    windowId?: string,
  ): WorkspaceState {
    const targetWorkspaceId = workspaceId || projectId || getState().activeWorkspaceId || getState().activeProjectId;
    const workspace = findWorkspace(getState(), targetWorkspaceId as string) as WorkspaceState | null;
    if (!workspace?.cwd) {
      throw new Error("Workspace not found or has no working directory.");
    }
    // When the caller's window is known, refuse cross-profile git ops.
    // A remote client on profile B passing workspaceId from profile A would
    // otherwise drive git fetch/push/checkout on a repo it has no
    // visibility of (and possibly using profile-A's credentials).
    assertWorkspaceInViewerProfile(workspace.id, windowId);
    return workspace;
  }

  function resolveGitRootPath(workspace: WorkspaceState, rootPath: string): string | null {
    const roots = workspace.gitRoots || [];
    if (!rootPath) {
      return roots[0] || "";
    }
    if (!roots.length) return rootPath; // single-repo, accept any rootPath
    if (roots.includes(rootPath)) return rootPath;
    // normalize comparison
    const normalized = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const match = roots.find((r: string) => r.replace(/\\/g, "/").replace(/\/+$/, "") === normalized);
    if (match) return match;
    return null; // rootPath not in gitRoots — reject
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function runGitWorkspaceAction(workspace: WorkspaceState, actionPromise: Promise<any>) {
    const result = await actionPromise;
    await refreshGit(workspace.id);
    return {
      payload: getPayload(),
      result,
    };
  }

  const pendingWorktreeDeletions = new Set(); // paths being deleted — skip in syncWorktrees
  const nativeWorkspaceOperations = new Map<string, Promise<unknown>>();
  function withNativeWorkspaceLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = nativeWorkspaceOperations.get(workspaceId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    nativeWorkspaceOperations.set(workspaceId, current);
    void current.then(
      () => {
        if (nativeWorkspaceOperations.get(workspaceId) === current) nativeWorkspaceOperations.delete(workspaceId);
      },
      () => {
        if (nativeWorkspaceOperations.get(workspaceId) === current) nativeWorkspaceOperations.delete(workspaceId);
      },
    );
    return current;
  }

  // Krok 6: background retry after a failed disk delete. When a worktree stays
  // locked longer than the foreground probe + rm retries (~7.5s — e.g. an
  // orphaned agent child or AV scan), the foreground delete gives up, shows the
  // error toast, and the directory used to stay on disk forever. We keep the
  // path in pendingWorktreeDeletions (so syncWorktrees doesn't resurrect it as a
  // workspace) and retry rmPath in the background with backoff. Touches ONLY the
  // already-failed branch — the happy path is unchanged.
  const BACKGROUND_DELETE_RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000];
  const backgroundDeleteRetries = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> }>();

  function finishBackgroundDeleteRetry(diskPath: string): void {
    backgroundDeleteRetries.delete(diskPath);
    pendingWorktreeDeletions.delete(diskPath);
  }

  function cancelBackgroundDeleteRetry(diskPath: string): void {
    const existing = backgroundDeleteRetries.get(diskPath);
    if (existing) {
      clearTimeout(existing.timer);
      backgroundDeleteRetries.delete(diskPath);
    }
  }

  function scheduleBackgroundDeleteRetry(diskPath: string, gitCwd: string): void {
    if (backgroundDeleteRetries.has(diskPath)) return; // one sequence per path
    const pruneIfPossible = () => {
      if (gitCwd) execFileTextImpl("git", ["worktree", "prune"], { cwd: gitCwd }).catch(() => {});
    };
    const armAttempt = (attempt: number) => {
      const timer = setTimeout(() => {
        void (async () => {
          try {
            await rmPath(diskPath);
            log.info("deleteWorkspace: background retry removed worktree", { diskPath, attempt: attempt + 1 });
            pruneIfPossible();
            finishBackgroundDeleteRetry(diskPath);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT") {
              // Someone (lazygit/CLI) already cleaned it up — treat as success.
              log.info("deleteWorkspace: background retry — path already gone", { diskPath });
              pruneIfPossible();
              finishBackgroundDeleteRetry(diskPath);
              return;
            }
            const next = attempt + 1;
            if (next < BACKGROUND_DELETE_RETRY_DELAYS_MS.length) {
              armAttempt(next);
            } else {
              // Exhausted — release the hold; state now matches the old behavior
              // (directory remains, user already got the toast).
              log.warn("deleteWorkspace: background retry exhausted, directory remains on disk", {
                diskPath,
                err: (err as Error)?.message?.slice(0, 200),
              });
              finishBackgroundDeleteRetry(diskPath);
            }
          }
        })();
      }, BACKGROUND_DELETE_RETRY_DELAYS_MS[attempt]);
      // Never keep the process alive for a cleanup retry.
      if (typeof timer.unref === "function") timer.unref();
      backgroundDeleteRetries.set(diskPath, { attempt, timer });
    };
    armAttempt(0);
  }

  // Task workspaces currently being deleted, keyed by `${profileId} ${normalizedCwd}`.
  // The guard window covers:
  //   - the synchronous state lookup → store.mutate gap (workspace still in
  //     state but flagged for deletion); and
  //   - the asynchronous PTY tear-down inside sessions.removeWorkspaceSessions
  //     (the old worker/judge processes may still hold file handles in the cwd
  //     even after store.mutate has removed the workspace from state).
  // We release the key in a finally block AFTER awaiting sessionsExited so a
  // new task workspace at the same cwd cannot start until the OS has actually
  // released the previous task's resources. Composite key keeps the guard
  // profile-scoped — two profiles legitimately sharing a monorepo do not
  // block each other.
  const pendingTaskWorkspaceDeletions = new Set<string>();
  function pendingTaskKey(profileId: string, normalizedCwd: string): string {
    if (!normalizedCwd) return "";
    return `${profileId || "default"} ${normalizedCwd}`;
  }
  // Subset of TaskStateKind values that indicate a task is actively touching
  // the worktree. Other states (idle/paused/completed/failed) leave the
  // filesystem inert, so multiple inert tasks at the same cwd are allowed to
  // coexist — the guard only fires when one of them is doing real work.
  // "capturing-context" is attached-mode-only (Companion loop) — included so
  // the same-cwd guard treats a mid-capture attached task as active, exactly
  // like the runner's own #setTaskState ACTIVE set.
  const ACTIVE_TASK_STATES: ReadonlySet<string> = new Set([
    "running",
    "evaluating",
    "judge-evaluating",
    "refreshing",
    "capturing-context",
  ]);
  // An attached companion task never owns its Primary — it only references
  // it via workerWorkspaceId/workerPanelId (plan section 3, 8.6). Deleting that
  // source workspace, or removing the panel that hosts it, would silently
  // orphan the loop with no way back short of recreating the companion task —
  // and while the loop is live the Primary tab is PRESENTED inside the task
  // workspace, so the deletion would also make a tab the user is looking at
  // vanish from under them.
  //
  // The predicate is the shared hosting one (shared/companion-primary.ts), the
  // very same function the renderer uses to decide where to draw the tab: what
  // is on screen and what may be deleted can therefore never disagree. It is
  // wider than the old "actively executing" set — idle / brief-ready /
  // awaiting-user / paused all host the Primary and all refuse the delete.
  // After completed/failed the tab has returned home and the existing inactive
  // semantics apply again (delete allowed, task flagged primaryMissing).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function findActiveCompanionSource(state: any, sourceWorkspaceId: string, sourcePanelId?: string): any {
    return (state.workspaces || []).find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ws: any) =>
        ws.kind === "task" &&
        ws.task?.workerWorkspaceId === sourceWorkspaceId &&
        (!sourcePanelId || ws.task.workerPanelId === sourcePanelId) &&
        isCompanionPrimaryHosted(ws.task),
    );
  }
  // Every attached companion task bound to this source workspace/panel,
  // regardless of task state. findActiveCompanionSource above only *refuses*
  // deletion while the loop is actively working; an idle/paused/awaiting-user
  // one is legitimately deletable, but it still loses its Primary — and a
  // companion task whose Primary silently vanished would flip to "running" on
  // Continue and inject into a dead session. Callers that go through with the
  // deletion use this to mark those tasks instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function findAttachedCompanionsFor(state: any, sourceWorkspaceId: string, sourcePanelId?: string): any[] {
    return (state.workspaces || []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ws: any) =>
        ws.kind === "task" &&
        ws.task?.mode === "attached" &&
        ws.task.workerWorkspaceId === sourceWorkspaceId &&
        (!sourcePanelId || ws.task.workerPanelId === sourcePanelId) &&
        !ws.task.primaryMissing,
    );
  }
  function normalizeTaskCwd(cwd: string | undefined | null): string {
    return String(cwd || "")
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  }
  // Resolve the profile the caller is acting under. Used by every same-cwd
  // guard so a task in profile A cannot block creation in profile B.
  //   - windowId path: pick from windowSlots (Electron desktop / remote per
  //     window). Same lookup the rest of the runtime uses.
  //   - Telegram / API path: inherit from the parent workspace's profile, so
  //     a task created from a remote command lands in the right profile and
  //     is checked against the right set of in-profile conflicts.
  //   - Last-resort fallback to "default" — matches how state normalization
  //     fills missing profileId values elsewhere.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function resolveCallerProfileId(state: any, windowId: string | undefined, parentWorkspaceId?: string): string {
    if (windowId) {
      // Viewer-aware: resolves desktop slot ids AND remote viewer ids.
      const viewerProfileId = getWindowProfileId(windowId);
      if (viewerProfileId) return viewerProfileId;
    }
    if (parentWorkspaceId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parent = (state.workspaces || []).find((w: any) => w.id === parentWorkspaceId);
      if (parent?.profileId) return parent.profileId;
    }
    // Last-resort fallback aligned with taskRunner.createTaskWorkspace: when
    // neither windowId nor parentWorkspaceId resolves, the workspace lands
    // deterministically in "default" (never windowSlots[0], which is
    // arbitrary in a multi-window install). The guard must check the same
    // profile, otherwise a legacy/programmatic create (e.g. an internal
    // caller without window context) would consult the wrong profile and
    // either false-allow or false-block.
    return "default";
  }
  // Same-cwd guard shared by createTaskWorkspace, startTask, and resumeTask.
  // Throws the user-facing message that bubbles up to the dialog's inline
  // error banner (and Telegram bot replies). `selfWorkspaceId` is the
  // workspace the caller already "owns" — start/resume must exempt their own
  // workspace from the conflict check.
  function assertNoConflictingActiveTask(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state: any,
    intendedCwd: string,
    callerProfileId: string,
    selfWorkspaceId: string | null = null,
  ): void {
    const normalizedCwd = normalizeTaskCwd(intendedCwd);
    if (!normalizedCwd) return;
    if (pendingTaskWorkspaceDeletions.has(pendingTaskKey(callerProfileId, normalizedCwd))) {
      log.warn("task guard: cwd is pending deletion of another task workspace", {
        cwd: intendedCwd,
        callerProfileId,
      });
      throw new Error(
        "The previous task agent for this directory is still finishing cleanup. Wait a moment and try again.",
      );
    }

    const conflicting = (state.workspaces || []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ws: any) =>
        ws.kind === "task" &&
        ws.task &&
        ws.id !== selfWorkspaceId &&
        (ws.profileId || "default") === callerProfileId &&
        ACTIVE_TASK_STATES.has(ws.task.state) &&
        normalizeTaskCwd(ws.cwd) === normalizedCwd,
    );
    if (conflicting.length > 0) {
      log.warn("task guard: duplicate cwd detected (active task)", {
        cwd: intendedCwd,
        callerProfileId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        conflictingWorkspaces: conflicting.map((ws: any) => ws.id),
      });
      throw new Error(
        `Another task agent ("${conflicting[0].name}") is currently running in this directory. ` +
          "Stop or delete it first, or pick a different location.",
      );
    }
  }
  let syncWorktreesRunning = false;
  async function syncWorktrees() {
    if (syncWorktreesRunning) return false;
    syncWorktreesRunning = true;
    try {
      return await syncWorktreesImpl();
    } finally {
      syncWorktreesRunning = false;
    }
  }

  /**
   * Remove `removeIds` from `draft.workspaces` and repoint anything that
   * referenced one of them: each window slot's `activeWorkspaceId` falls
   * back to a sibling in that slot's OWN profile (picking from
   * windowSlots[0]'s profile would push a wrong-profile workspace into the
   * other window's pane), and the legacy global `draft.activeWorkspaceId`
   * mirrors the most-recently-focused slot's pick so it tracks user
   * activity rather than slot order. Shared by pruneOrphanedWorkspaces and
   * syncWorktreesImpl, whose removal semantics are otherwise identical.
   */
  function removeWorkspacesFromDraft(draft: AppState, removeIds: Set<string>): void {
    if (removeIds.size === 0) return;
    draft.workspaces = draft.workspaces.filter((w) => !removeIds.has(w.id));
    for (const slot of draft.windowSlots || []) {
      if (removeIds.has(slot.activeWorkspaceId)) {
        const sibling = draft.workspaces.find((w) => (w.profileId || "default") === slot.profileId);
        slot.activeWorkspaceId = sibling?.id || "";
      }
    }
    if (removeIds.has(draft.activeWorkspaceId)) {
      const primarySlot = [...(draft.windowSlots || [])].sort(
        (a, b) => (b.lastFocusedAt || 0) - (a.lastFocusedAt || 0),
      )[0];
      const fallbackProfileId = primarySlot?.profileId || "default";
      const fallback = draft.workspaces.find((w) => (w.profileId || "default") === fallbackProfileId);
      draft.activeWorkspaceId = fallback?.id || draft.workspaces[0]?.id || "";
    }
  }

  /**
   * Tear down a removed workspace's live runtime state: end its PTY
   * sessions, drop its terminal replay buffer, clear its project alerts,
   * and cancel any pending shell-triggered git refresh for it (so the timer
   * can't outlive the removal and so git.exe never runs inside a worktree
   * that's about to disappear). Shared by deleteWorkspace and
   * pruneOrphanedWorkspaces. Returns the same "sessions fully exited"
   * promise sessions.removeWorkspaceSessions does — deleteWorkspace awaits
   * it before releasing its pending-delete flag; pruneOrphanedWorkspaces
   * discards it, matching its original fire-and-forget behavior.
   */
  function cleanupWorkspaceRuntimeState(workspaceId: string): Promise<void> {
    const sessionsExited = sessions.removeWorkspaceSessions(workspaceId);
    clearWorkspaceTerminalReplay(workspaceId);
    const pendingGitRefresh = gitRefreshDebounceMap.get(workspaceId);
    if (pendingGitRefresh) clearTimeout(pendingGitRefresh);
    gitRefreshDebounceMap.delete(workspaceId);
    lastShellRefreshAt.delete(workspaceId);
    clearProjectAlerts(workspaceId);
    return sessionsExited;
  }

  /**
   * Post-commit teardown for a workspace that has just been removed from
   * authoritative state: run the full runtime cleanup AND tell every connected
   * renderer to drop the workspace's notification history.
   *
   * Every workspace-removal path goes through here so the two can no longer
   * drift apart — the reason syncWorktreesImpl used to clear only the replay
   * buffer while direct deletion cleared sessions, timers and alerts too.
   *
   * Call it only AFTER `store.mutate` resolves. A mutation refused or thrown
   * before commit leaves the workspace in place, and a renderer that had
   * already purged its history could never recover it. Failures that happen
   * after the commit (disk cleanup, a git refresh) do not retract the removal.
   *
   * The descriptor must be captured BEFORE the mutation: afterwards the
   * workspace is gone from state and its owning profile is unresolvable, which
   * is exactly why `profileId` travels in the event payload.
   *
   * Returns the same "sessions fully exited" promise cleanupWorkspaceRuntimeState
   * does, so callers keep their existing await / fire-and-forget semantics.
   */
  function finalizeWorkspaceRemoval(workspace: Pick<WorkspaceState, "id" | "profileId">): Promise<void> {
    const sessionsExited = cleanupWorkspaceRuntimeState(workspace.id);
    emitNotificationTargetRemoved({
      target: "workspace",
      workspaceId: workspace.id,
      profileId: workspace.profileId || "default",
    });
    return sessionsExited;
  }

  /**
   * Single typed emit site for the notification-lifecycle event, so every
   * removal path produces the same shape. Receivers validate at their own
   * transport boundary.
   */
  function emitNotificationTargetRemoved(event: NotificationTargetRemoved): void {
    events.emit(NOTIFICATION_TARGET_REMOVED_CHANNEL, event);
  }

  /**
   * Drop workspaces whose `cwd` no longer exists on disk. Covers the orphan
   * case: user nuked the worktree externally (or a previous deleteFromDisk
   * left only stragglers behind), and the sidebar entry is now useless —
   * nothing in the workspace can be activated when its working directory
   * is gone. `syncWorktrees` already handles this for `notes: "Worktree of"`
   * children; this function extends the same hygiene to task-agent
   * workspaces and any other top-level entry whose cwd has gone missing.
   *
   * Skipped: inbox-only kinds (azure / github), workspaces with no cwd at
   * all, paths currently being deleted by another flow, and any workspace
   * referenced by `_recoveryCandidates` (the user gets the recovery dialog
   * first; resolveTaskRecovery clears the candidate, after which the next
   * prune pass removes it).
   */
  async function pruneOrphanedWorkspaces(): Promise<number> {
    const state = getState();
    const recoveryIds = new Set(_recoveryCandidates.map((c) => c.workspaceId));
    const toRemove: WorkspaceState[] = [];
    for (const ws of state.workspaces) {
      if (!ws.cwd) continue;
      if (ws.kind === "azure" || ws.kind === "github") continue;
      if (recoveryIds.has(ws.id)) continue;
      const resolvedCwd = path.resolve(ws.cwd);
      if (pendingWorktreeDeletions.has(resolvedCwd)) continue;
      try {
        await access(ws.cwd);
      } catch {
        toRemove.push(ws);
      }
    }
    if (toRemove.length === 0) return 0;
    const removeIds = new Set(toRemove.map((w) => w.id));
    await store.mutate((draft: AppState) => {
      removeWorkspacesFromDraft(draft, removeIds);
    });
    for (const ws of toRemove) {
      if (ws.kind === "task" && ws.task?.taskId) {
        try {
          taskRunner.stopTask(ws.id);
        } catch {
          /* best-effort; task may already be stopped */
        }
      }
      // Krok 2: same runtime-state cleanup as deleteWorkspace, plus the
      // notification-removal event. Discarded (not awaited) — matches this
      // function's original fire-and-forget behavior, per
      // cleanupWorkspaceRuntimeState's own doc comment.
      void finalizeWorkspaceRemoval(ws);
    }
    log.info("pruneOrphanedWorkspaces removed orphans", {
      count: toRemove.length,
      removed: toRemove.map((w) => ({ id: w.id, name: w.name, cwd: w.cwd, kind: w.kind })),
    });
    ensureVisibleSession();
    broadcastState();
    return toRemove.length;
  }

  async function syncWorktreesImpl() {
    const state = getState();
    const parents = state.workspaces.filter(
      (workspace) =>
        !(workspace.notes || "").startsWith("Worktree of ") &&
        workspace.kind !== "azure" &&
        workspace.review?.provider !== "azure-devops",
    );
    const worktrees = state.workspaces.filter((w) => (w.notes || "").startsWith("Worktree of "));

    const toAdd: WorkspaceState[] = [];
    // Full descriptors, not ids: the removal event needs the workspace's
    // effective profile, which is unresolvable once the mutation has dropped it
    // from state.
    const toRemove: WorkspaceState[] = [];
    const toRepair: Array<{ id: string; profileId: string }> = [];

    // 6a: pre-build lookup indexes to avoid O(n²) find/some inside the scan loop.
    const worktreeByProfileAndCwd = new Map<string, WorkspaceState>();
    for (const wt of worktrees) {
      worktreeByProfileAndCwd.set(`${wt.profileId || "default"}|${wt.cwd}`, wt);
    }
    const taskCwdSet = new Set<string>();
    for (const ws of state.workspaces) {
      if (ws.kind === "task" && ws.cwd) taskCwdSet.add(`${ws.profileId || "default"}|${ws.cwd}`);
    }
    const toAddKeySet = new Set<string>();

    // Each parent is an independent observer of its own treeDir on disk.
    // When two profiles both have a workspace at the same cwd, both scan the
    // same directory and each gets its own worktree entries — profiles do
    // not compete for ownership of on-disk worktrees.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const treeDirsScanned = new Map<string, any[]>();
    for (const parent of parents) {
      if (!parent.cwd) continue;
      const treeDir = path.join(parent.cwd, ".strideterm", "tree");
      let entries = treeDirsScanned.get(treeDir);
      if (entries === undefined) {
        try {
          entries = (await readdir(treeDir, { withFileTypes: true })) as unknown as typeof entries;
        } catch {
          entries = [];
        }
        treeDirsScanned.set(treeDir, entries || []);
      }
      const parentProfileId = parent.profileId || "default";
      for (const entry of entries || []) {
        if (!entry.isDirectory()) continue;
        const treePath = path.join(treeDir, entry.name);
        if (pendingWorktreeDeletions.has(path.resolve(treePath))) continue;
        const existing = worktreeByProfileAndCwd.get(`${parentProfileId}|${treePath}`);
        if (existing) {
          // Repair profileId if it drifted from parent
          if ((existing.profileId || "default") !== parentProfileId) {
            toRepair.push({ id: existing.id, profileId: parentProfileId });
          }
          continue;
        }
        const toAddKey = `${parentProfileId}|${treePath}`;
        if (toAddKeySet.has(toAddKey)) continue;
        // Skip directories already owned by a task workspace — the task entry takes priority.
        if (taskCwdSet.has(toAddKey)) continue;
        toAddKeySet.add(toAddKey);
        toAdd.push(
          normalizeWorkspace({
            id: `workspace-${randomUUID()}`,
            name: `${parent.name} / ${entry.name}`,
            icon: parent.icon,
            color: parent.color,
            kind: parent.kind,
            source: parent.source,
            pluginId: parent.pluginId,
            profileId: parent.profileId,
            cwd: treePath,
            notes: `Worktree of ${parent.name}`,
            activePanelId: "",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            panels: parent.panels.map((p: any) => ({
              ...p,
              id: `panel-${randomUUID()}`,
            })),
          }),
        );
      }
    }

    // Remove worktrees whose directories no longer exist on disk
    for (const wt of worktrees) {
      if (!wt.cwd) continue;
      try {
        await access(wt.cwd);
      } catch {
        toRemove.push(wt);
      }
    }

    if (toAdd.length === 0 && toRemove.length === 0 && toRepair.length === 0) return false;

    await store.mutate((draft: AppState) => {
      removeWorkspacesFromDraft(draft, new Set(toRemove.map((wt) => wt.id)));
      for (const repair of toRepair) {
        const ws = draft.workspaces.find((w) => w.id === repair.id);
        if (ws) ws.profileId = repair.profileId;
      }
      for (const workspace of toAdd) {
        draft.workspaces.push(workspace);
      }
    });
    // Previously this cleared only the replay buffer, leaving the removed
    // worktree's sessions, timers and attention alerts behind — a lifecycle
    // that silently diverged from direct deletion and orphan pruning. Fire-and-
    // forget, matching this function's existing non-awaiting behavior.
    for (const workspace of toRemove) {
      void finalizeWorkspaceRemoval(workspace);
    }

    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function hasActiveDockerConsumer(state: any): boolean {
    // Predicate 1: a docker workspace is the active workspace (globally or in any window slot).

    const dockerIds = new Set<string>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (state.workspaces ?? []).filter((w: any) => w.kind === "docker").map((w: any) => w.id),
    );
    if (dockerIds.size === 0) return false;
    if (dockerIds.has(state.activeWorkspaceId)) return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((state.windowSlots ?? []).some((s: any) => dockerIds.has(s.activeWorkspaceId))) return true;
    // Predicate 2: an active docker log or shell stream exists.
    return dockerLogManager.hasAnySessions() || dockerShellManager.hasAnySessions();
  }

  // Docker data has exactly one consumer — the "Docker" tab chip built in
  // selectors.ts for an active docker workspace (plus open logs/shell streams,
  // which pin the same predicate). With nobody looking there is nothing to
  // keep fresh, so we stop polling outright rather than falling back to a
  // slower interval: every probe pays a `wsl.exe`/`docker version` spawn that
  // blocks the main thread for seconds when the backend is cold.
  // Restart is covered by the call sites — startup, both directions of
  // activateWorkspace, window-slot removal, and log/shell open+close — and
  // activateWorkspace additionally fires an immediate refresh, so opening the
  // tab never shows stale data while waiting for the first tick.
  function ensureDockerPolling() {
    const wanted = hasActiveDockerConsumer(getState());
    if (wanted === (dockerPoll !== null)) return;

    if (!wanted) {
      clearInterval(dockerPoll!);
      dockerPoll = null;
      return;
    }
    dockerPoll = setInterval(() => {
      refreshDocker().catch((error: Error) => {
        log.warn("docker poll error", { err: error.message });
      });
    }, APP_CONFIG.runtime.dockerPollMs);
  }

  function ensureGitPolling() {
    if (gitPoll) {
      return;
    }

    gitPoll = setInterval(() => {
      void (async () => {
        try {
          if (await syncWorktrees()) {
            sessions.syncWithState(getState());
            broadcastState();
          }
        } catch (error) {
          log.warn("worktree sync error", { err: (error as Error).message });
        }
      })();
    }, APP_CONFIG.runtime.gitPollMs);
  }

  // perf-4: fs.watch on .strideterm/tree/ per parent workspace
  // Debounced watcher map: treeDir → { watcher, debounceTimer }
  const treeDirWatchers = new Map();
  const TREE_WATCH_DEBOUNCE_MS = 500;

  function startTreeDirWatcher(treeDir: string) {
    if (treeDirWatchers.has(treeDir)) return;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const watcher = watch(treeDir, { persistent: false }, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void (async () => {
            try {
              if (await syncWorktrees()) {
                sessions.syncWithState(getState());
                broadcastState();
              }
            } catch {
              // Non-fatal
            }
          })();
        }, TREE_WATCH_DEBOUNCE_MS);
      });
      watcher.on("error", (err: unknown) => {
        // Degrades to the gitPoll interval backstop — silent otherwise, so
        // log to leave a trace of the degradation.
        log.debug("tree dir watcher error", { treeDir, err: (err as Error)?.message || String(err) });
        treeDirWatchers.delete(treeDir);
      });
      treeDirWatchers.set(treeDir, {
        watcher,
        get debounceTimer() {
          return debounceTimer;
        },
      });
    } catch {
      // treeDir may not exist yet — polling backstop will catch it
    }
  }

  function stopTreeDirWatcher(treeDir: string) {
    const entry = treeDirWatchers.get(treeDir);
    if (entry) {
      try {
        entry.watcher.close();
      } catch {
        /* ignore */
      }
      treeDirWatchers.delete(treeDir);
    }
  }

  function syncTreeDirWatchers() {
    const state = getState();
    const parents = state.workspaces.filter(
      (ws) =>
        !(ws.notes || "").startsWith("Worktree of ") &&
        ws.kind !== "azure" &&
        ws.review?.provider !== "azure-devops" &&
        ws.cwd,
    );
    const activeDirs = new Set(parents.map((ws) => path.join(ws.cwd, ".strideterm", "tree")));
    // Stop watchers for removed parents
    for (const dir of treeDirWatchers.keys()) {
      if (!activeDirs.has(dir)) stopTreeDirWatcher(dir);
    }
    // Start watchers for new parents
    for (const dir of activeDirs) {
      if (!treeDirWatchers.has(dir)) startTreeDirWatcher(dir);
    }
  }

  pluginManager = await createPluginManagerImpl({
    pluginsDir,
    builtinPluginsDir: builtinPluginsDir || null,
    runtime: null, // Will be set after construction
  });

  async function runInitialRefresh() {
    // Same demand predicate as the poll: probing docker on a launch that never
    // opens a docker workspace costs a cold `wsl.exe` spawn (seconds of blocked
    // main thread) for a snapshot nothing reads. activateWorkspace refreshes on
    // its own when the user does open one.
    if (hasActiveDockerConsumer(getState())) {
      await refreshDocker();
    }
    // perf-1: eager refresh only the active workspace; background-refresh the rest
    const activeId = getState().activeWorkspaceId;
    if (activeId) {
      await refreshGit(activeId);
    } else {
      await refreshGit();
    }
    await refreshAzure();
    scheduleAzurePolling();
    await refreshGitHub();
    scheduleGitHubPolling();
    await syncWorktrees();
    await tunnel.refreshAvailability();

    // Auto-tunnel restoration was here previously, but it ran BEFORE the
    // remote-access server had reported back via setRemoteInfo whether it
    // actually bound its port. When another strideterm instance (commonly
    // dev running alongside prod) was already holding port 43123, the
    // probe would silently succeed against THAT process, cloudflared
    // would tunnel into the wrong instance, and the user would only
    // notice once the other instance shut down. Auto-tunnel now fires
    // from setRemoteInfo on the first reported state — see the one-shot
    // guard `autoTunnelBootstrapped` below.

    // Background: inspect remaining workspaces so they don't block first render.
    //
    // Two scoping decisions that keep startup CPU bounded:
    //   1. Only workspaces in the SAME profile as the active workspace. The user
    //      can only see one profile at a time, so eagerly refreshing the other
    //      profiles' workspaces is pure CPU burn — they'll be activated lazily
    //      anyway. Cut this from "every git workspace across every profile" to
    //      "every git workspace in this profile" (often ~halves the work).
    //   2. useCache=true so the first pass populates each workspace's snapshot
    //      cache without an explicit invalidation. A second startup refresh
    //      within the cache TTL (8 s) becomes a no-op instead of re-spawning
    //      14+ git processes per workspace.
    if (activeId) {
      const initialState = getState();
      const activeProfileId = initialState.workspaces.find((w) => w.id === activeId)?.profileId || "default";
      queueMicrotask(() => {
        void (async () => {
          const others = getState().workspaces.filter(
            (ws) =>
              ws.id !== activeId &&
              ws.kind !== "azure" &&
              ws.kind !== "github" &&
              (ws.profileId || "default") === activeProfileId,
          );
          for (const ws of others) {
            try {
              await refreshGit(ws.id, { useCache: true });
              broadcastState();
            } catch {
              // Non-fatal — background refresh; user can click Refresh if needed
            }
            await new Promise((r) => setImmediate(r));
          }
        })();
      });
    }
  }

  // ensureNotifyScript never rejects — it swallows its own fs errors and
  // resolves { ok: false, error }. High blast radius: if writing notify.mjs
  // fails, ALL agent hooks silently stop working (no idle/permission-prompt
  // detection) with zero trace unless the resolved failure is logged.
  const notifyScriptResult = await ensureNotifyScript(userDataPath);
  if (!notifyScriptResult.ok) {
    log.error("ensureNotifyScript failed — agent hooks may not work", {
      userDataPath,
      err: notifyScriptResult.error,
    });
  }
  // strIDEterm <= 2.4.20 wrote a Claude-style `hooks` block into the OpenCode
  // config. OpenCode rejects the unrecognized key and refuses to start, so a
  // user hit by this can't reach the Settings dialog's Remove button through
  // a working opencode — heal it here instead, and move anyone who had opted
  // in over to the plugin. No-op for everyone else.
  await migrateLegacyOpencodeHooks();
  await startAgentNotifyServer();
  ensureDockerPolling();
  ensureGitPolling();
  syncTreeDirWatchers();
  reconfigureTelegram();
  void reconfigureMobile();
  if (deferInitialRefresh) {
    scheduleAzurePolling();
    scheduleGitHubPolling();
    // Spawn PTYs for the active workspace BEFORE the slow refreshes so the
    // first paint doesn't sit at "0 running" while Docker/Git/Azure/GitHub
    // refresh — and so a hang in one of those refreshes doesn't strand
    // the user with empty panes for the whole session.
    ensureVisibleSession();
    broadcastState();
    runInitialRefresh()
      .then(() => broadcastState())
      .catch((error) => {
        log.warn("initial refresh error", { err: error.message });
        broadcastState();
      });
  } else {
    ensureVisibleSession();
    await runInitialRefresh();
  }

  // Deferred version check — runs 10s after startup, non-blocking.
  setTimeout(() => {
    versionChecker
      .checkForUpdates()
      .then(() => broadcastState())
      .catch((err: unknown) => {
        // A permanently-failing check would otherwise be invisible forever —
        // it silently retries in the background with no diagnostic trail.
        log.debug("startup version check failed", { err: (err as Error)?.message || String(err) });
      });
  }, 10_000);

  // Deferred orphan prune — runs ~5s after startup, non-blocking. Removes
  // workspaces whose cwd is gone (e.g. worktree dirs the user nuked
  // externally, or a previous deleteFromDisk that bailed mid-way and left
  // a state entry pointing at nothing). Delayed so external drives /
  // network mounts have a chance to come up first; skipped while a task
  // recovery dialog is still pending.
  //
  // Gated behind deferInitialRefresh so it only fires in production (Electron
  // main passes deferInitialRefresh: true). Tests run with fake timers and
  // would otherwise advance past the 5s deadline mid-test, prune workspaces
  // whose fixture cwd doesn't exist on disk (e.g. `/tmp/idletask`), and
  // throw off attention/runtime assertions.
  if (deferInitialRefresh) {
    setTimeout(() => {
      pruneOrphanedWorkspaces().catch((err) => {
        log.warn("pruneOrphanedWorkspaces failed", { err: (err as Error)?.message });
      });
    }, 5_000);
  }

  // --- Extracted handler groups ---
  const gitHandlers = createGitHandlers({
    git,
    store,
    getPayload,
    broadcastState,
    refreshGit,
    resolveGitWorkspace,
    resolveGitConnection,
    resolveGitRootPath,
    runGitWorkspaceAction,
    recordWorkspaceWork,
    emitGitProgress: (payload) => events.emit("git:push-progress", payload),
    syncWorktrees: async () => {
      await syncWorktrees();
    },
  });

  const sshHandlers = createSshHandlers({ sshManager, store, credentialStore, broadcastState });

  const dockerHandlers = createDockerHandlers({
    docker,
    dockerLogManager,
    dockerShellManager,
    getPayload,
    refreshDocker,
    ensureDockerPolling,
  });

  const providerHandlers = createProviderHandlers({
    log,
    getState,
    store,
    azure,
    github,
    git,
    sessions,
    credentialStore,
    auditLogStore,
    githubAuditLogStore,
    azureReviewStore,
    reviewBridgeStore,
    getPayload,
    broadcastState,
    refreshAzure,
    refreshGitHub,
    refreshGit,
    ensureAzureWorkspace,
    ensureGitHubWorkspace,
    ensureVisibleSession,
    scheduleAzurePolling,
    scheduleGitHubPolling,
    resolveGitWorkspace,
    resolveGitRootPath,
    getAzureSettings,
    getAzureConnections,
    getGitHubSettings,
    getGitHubConnections,
    assertWorkspaceInViewerProfile,
    assertPrInViewerProfile,
    getViewerProfileId: getWindowProfileId,
    getViewerActiveWorkspaceId,
    mirrorRemoteViewerWorkspace,
    recordWorkspaceWork,
  });

  const gridHandlers = createGridHandlers({
    store,
    getState,
    getPayload,
    broadcastState,
    getRemoteClientRegistry: (remoteSessionId: string) => registryOwning(remoteSessionId),
  });

  const taskHandlers = createTaskHandlers({
    log,
    getState,
    getPayload,
    broadcastState,
    store,
    taskRunner,
    sessions,
    execFileTextImpl,
    recheckClaudeAvailability,
    assertWorkspaceInViewerProfile,
    recordWorkspaceWork,
    resolveCallerProfileId,
    assertNoConflictingActiveTask,
    worktreeTreePath,
    ensureWorktree,
    getRecoveryCandidates: () => _recoveryCandidates,
    setRecoveryCandidates: (next) => {
      _recoveryCandidates = next;
    },
    finalizeWorkspaceRemoval,
  });

  // Restore invariant: a valid saved session is the authority, and the
  // workspace follows that session. This keeps windowSlots from restoring a
  // workspace/session pair that belongs to different workspaces.
  function resolveProfileRestoreTarget(state: AppState, profileId: string): { workspaceId: string; sessionId: string } {
    const profile = state.profiles.find((p) => p.id === profileId);
    const profileWorkspaces = state.workspaces.filter((w) => (w.profileId || "default") === profileId);
    const profileWsIds = new Set(profileWorkspaces.map((w) => w.id));

    const savedSessionId = profile?.lastActiveSessionId || "";
    if (savedSessionId) {
      const descriptor = parseSessionId(savedSessionId);
      const sessionWs = descriptor ? profileWorkspaces.find((w) => w.id === descriptor.workspaceId) : null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const panelExists = sessionWs && (sessionWs as any).panels?.some((p: any) => p.id === descriptor?.panelId);
      if (descriptor && panelExists) {
        return { workspaceId: descriptor.workspaceId, sessionId: savedSessionId };
      }
    }

    const savedWorkspaceId =
      profile?.lastActiveWorkspaceId && profileWsIds.has(profile.lastActiveWorkspaceId)
        ? profile.lastActiveWorkspaceId
        : profileWorkspaces[0]?.id || "";
    return { workspaceId: savedWorkspaceId, sessionId: "" };
  }

  /**
   * Return the profile a given VIEWER is bound to, or null when the id can't
   * be resolved (legacy / pre-init callers). Accepts both viewer id forms:
   * a desktop window slot id, or a remote client id (`remote:<sessionId>`)
   * resolved through the RemoteClientRegistry — so every profile guard works
   * for remote/mobile callers even when their profile has no desktop window.
   */
  function getWindowProfileId(windowId: string | undefined): string | null {
    if (!windowId) return null;
    const remoteSessionId = parseRemoteViewerId(windowId);
    if (remoteSessionId) {
      const client = registryOwning(remoteSessionId)?.get(remoteSessionId);
      return client ? client.profileId || "default" : null;
    }
    const slot = (getState().windowSlots || []).find((s) => s.id === windowId);
    return slot ? slot.profileId : null;
  }

  function getViewerActiveWorkspaceId(viewerId: string | undefined): string {
    const remoteSessionId = parseRemoteViewerId(viewerId);
    if (remoteSessionId) {
      return registryOwning(remoteSessionId)?.get(remoteSessionId)?.activeWorkspaceId || "";
    }
    if (viewerId) {
      return (getState().windowSlots || []).find((slot) => slot.id === viewerId)?.activeWorkspaceId || "";
    }
    return getState().activeWorkspaceId || "";
  }

  /**
   * Refuse an operation when its target workspace lives in a different
   * profile than the calling VIEWER (desktop window slot id or remote
   * viewer id — both resolve through getWindowProfileId). Previously these
   * handlers only skipped the slot mirror on cross-profile, but the side
   * effect (new worktree on disk, new task workspace, etc.) still happened
   * in the foreign profile. The viewer contract is "operate on the profile
   * your viewer is bound to" — silently writing to another one is a bug,
   * not a UX issue.
   *
   * No-op when no viewer id is supplied (legacy in-process callers / tests
   * that don't model windows).
   */
  function assertWorkspaceInViewerProfile(workspaceId: string, windowId: string | undefined): void {
    const slotProfileId = getWindowProfileId(windowId);
    if (!slotProfileId) return;
    const ws = getState().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return; // the surrounding op will fail on its own
    const wsProfileId = ws.profileId || "default";
    if (wsProfileId !== slotProfileId) {
      throw new Error(
        `Cross-profile refused: workspace ${workspaceId} is in profile ${wsProfileId}, window ${windowId} is bound to ${slotProfileId}.`,
      );
    }
  }

  /**
   * Provider-agnostic version of the Azure/GitHub handlers' PR guard, for
   * review-bridge sync (which mutates a PR by key without knowing its provider).
   * The prKey maps to exactly one provider PR; refuse when that PR is not in the
   * calling viewer's profile. No-op for desktop IPC (no viewer id).
   */
  function assertPrInViewerProfile(prKey: string, windowId: string | undefined): void {
    const callerProfileId = getWindowProfileId(windowId);
    if (!callerProfileId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = getPayload() as any;
    const pr = (payload?.azureDevops?.pullRequests?.[prKey] || payload?.github?.pullRequests?.[prKey]) as
      { profileId?: string } | undefined;
    if (pr && String(pr.profileId || "default") !== callerProfileId) {
      throw new Error(`Cross-profile refused: pull request ${prKey} is not in profile ${callerProfileId}.`);
    }
  }

  /** Human label for a viewer id — used in "controlled from …" prompts. */
  function describeViewer(viewerId: string): string {
    if (parseRemoteViewerId(viewerId)) return "a remote client";
    const slots = getState().windowSlots || [];
    const idx = slots.findIndex((s) => s.id === viewerId);
    return idx >= 0 ? `Window ${idx + 1}` : "another window";
  }

  /**
   * Acquire/renew the input lease for `viewerId` on `sessionId`. Returns
   * ok:false with the current owner when a DIFFERENT viewer holds a live
   * lease — the caller surfaces the take-control prompt instead of writing.
   */
  function acquireSessionInputLease(
    sessionId: string,
    viewerId: string,
  ): { ok: true } | { ok: false; ownerViewerId: string; ownerLabel: string } {
    const now = Date.now();
    const lease = sessionInputLeases.get(sessionId);
    if (lease && lease.viewerId !== viewerId && lease.expiresAt > now) {
      return { ok: false, ownerViewerId: lease.viewerId, ownerLabel: describeViewer(lease.viewerId) };
    }
    sessionInputLeases.set(sessionId, { viewerId, expiresAt: now + INPUT_LEASE_TTL_MS });
    return { ok: true };
  }

  /**
   * Stamp `lastWorkedAt` because the user typed into this workspace. Throttled
   * (see TYPING_STAMP_INTERVAL_MS) and fire-and-forget: writeToSession is
   * synchronous and must never wait on a state persist. Only viewer-originated
   * meaningful input that the input lease accepted reaches here — never
   * task-runner writes, PTY output, or focus/mouse escape sequences.
   */
  function stampWorkspaceWorkedByTyping(workspaceId: string): void {
    const now = Date.now();
    if (now - (lastTypingStampAt.get(workspaceId) ?? 0) < TYPING_STAMP_INTERVAL_MS) return;
    lastTypingStampAt.set(workspaceId, now);
    store
      .mutate((draft: AppState) => markWorkspaceWorked(draft, workspaceId))
      .then(() => broadcastState())
      .catch((error: unknown) => {
        log.warn("lastWorkedAt typing stamp failed", { workspaceId, err: (error as Error)?.message });
      });
  }

  /**
   * Which workspace owns a terminal write.
   *
   * Usually the workspace that owns the panel. An ATTACHED task (Companion
   * loop) breaks that assumption: its Primary tab is presented inside the task
   * workspace while the physical session id still names the source workspace,
   * so a user typing in the task card would otherwise bump the SOURCE
   * workspace's recency. The viewer therefore declares the workspace whose UI
   * it typed in (`originWorkspaceId`) and this function validates the claim —
   * an unvalidated claim is ignored, never trusted.
   *
   * Accepted when the session is
   *   (a) directly a panel of the claimed workspace, or
   *   (b) that workspace's attached worker/"Primary" or judge/"Companion"
   *       session (`sessionIdFor`, the same helper every task write path uses).
   *
   * Branch (a) is the very workspace that owns the session. Branch (b) is
   * additionally required to be in the SAME profile as the session's owner —
   * an attached binding is already refused across profiles at create time, so
   * this only makes the invariant true by code rather than by upstream
   * convention. Anything else falls back to the session's own workspace.
   */
  function resolveWorkOriginWorkspaceId(sessionId: string, claimedWorkspaceId?: string): string {
    const descriptor = parseSessionId(sessionId);
    const owner = descriptor?.workspaceId || "";
    const claimed = String(claimedWorkspaceId || "");
    if (!claimed || claimed === owner) return owner;
    const state = getState();
    const workspace = findWorkspace(state, claimed);
    const ownerWorkspace = findWorkspace(state, owner);
    const sameProfile =
      !!workspace && !!ownerWorkspace && (workspace.profileId || "default") === (ownerWorkspace.profileId || "default");
    if (sameProfile && workspace.kind === "task" && workspace.task) {
      if (sessionIdFor(workspace, "worker") === sessionId || sessionIdFor(workspace, "judge") === sessionId) {
        return workspace.id;
      }
    }
    log.debug("terminal input: ignoring unvalidated originWorkspaceId", { sessionId, claimed });
    return owner;
  }

  /**
   * Persist "the user worked here" for one of the allowlisted actions
   * (see markWorkspaceWorked's doc block for the closed list). Called only
   * AFTER the action succeeded — a failed or refused action is not work.
   *
   * `viewerId` is the window slot / remote viewer that requested the action.
   * Every allowlisted call site already ran its own cross-profile guard, so
   * this is a belt-and-braces check: a mismatch skips the stamp rather than
   * throwing, because the action itself has already succeeded and must not be
   * reported as failed.
   */
  async function recordWorkspaceWork(workspaceId: string, viewerId?: string): Promise<void> {
    const id = String(workspaceId || "");
    if (!id) return;
    const workspace = findWorkspace(getState(), id);
    if (!workspace) return;
    if (viewerId) {
      const viewerProfileId = getWindowProfileId(viewerId);
      if (viewerProfileId && (workspace.profileId || "default") !== viewerProfileId) {
        log.debug("recordWorkspaceWork: skipping cross-profile stamp", { workspaceId: id, viewerId });
        return;
      }
    }
    try {
      await store.mutate((draft: AppState) => markWorkspaceWorked(draft, id));
      broadcastState();
    } catch (error: unknown) {
      log.warn("lastWorkedAt stamp failed", { workspaceId: id, err: (error as Error)?.message });
    }
  }

  /**
   * Mirror an activation into a remote viewer's context: when a viewer-id
   * names a remote client and the workspace lives in its profile, the
   * client's own active workspace follows the operation (e.g. opening a PR
   * review from mobile shows the review on mobile). Desktop window ids and
   * cross-profile targets are a no-op — desktop slots have their own mirror
   * path and never follow remote actions.
   */
  function mirrorRemoteViewerWorkspace(viewerId: string | undefined, workspaceId: string): void {
    const remoteSessionId = parseRemoteViewerId(viewerId);
    const registry = registryOwning(remoteSessionId);
    if (!remoteSessionId || !registry || !workspaceId) return;
    try {
      registry.activateWorkspace(remoteSessionId, workspaceId, getState());
    } catch {
      // Cross-profile or stale client — skip the mirror, same as the slot path.
    }
  }

  /**
   * Same as assertWorkspaceInViewerProfile but for provider connections
   * (Azure / GitHub). The connection's profileId determines which inbox
   * the PR review / quickfix workspace will land under; honouring a
   * request from a different-profile window means the caller is asking
   * us to mutate state in a profile they don't own.
   */
  function assertConnectionInWindowProfile(
    connection: { profileId?: string; id?: string } | null | undefined,
    windowId: string | undefined,
  ): void {
    const slotProfileId = getWindowProfileId(windowId);
    if (!slotProfileId) return;
    if (!connection) return;
    const connProfileId = connection.profileId || "default";
    if (connProfileId !== slotProfileId) {
      throw new Error(
        `Cross-profile refused: connection ${connection.id || "?"} is in profile ${connProfileId}, window ${windowId} is bound to ${slotProfileId}.`,
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function resolveDeleteRefreshTargets(deletedWorkspace: any, allWorkspaces: any[]): string[] {
    const targets = new Set<string>();

    // Explicit parentWorkspaceId fields
    for (const id of [
      deletedWorkspace.review?.parentWorkspaceId,
      deletedWorkspace.quickfix?.parentWorkspaceId,
      deletedWorkspace.task?.parentWorkspaceId,
    ]) {
      if (id) targets.add(id);
    }

    // Legacy "Worktree of <name>" — find the workspace with the same name in the same profile
    const notes = String(deletedWorkspace.notes || "");
    if (notes.startsWith("Worktree of ")) {
      const parentName = notes.slice("Worktree of ".length);
      const profileId = deletedWorkspace.profileId || "default";
      const parent = allWorkspaces.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (w: any) => w.name === parentName && (w.profileId || "default") === profileId,
      );
      if (parent) targets.add(parent.id);
    }

    // Workspaces sharing the same parent git repo (same cwd as the derived gitCwd)
    const cacheRepoPath = deletedWorkspace.review?.checkout?.cacheRepoPath || "";
    const taskWorktreeBase = deletedWorkspace.task?.worktreeBase || "";
    const mainWorktreePath = deletedWorkspace.cwd ? path.resolve(deletedWorkspace.cwd, "..", "..", "..") : "";
    const deletedGitCwd = cacheRepoPath || taskWorktreeBase || mainWorktreePath;
    if (deletedGitCwd) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const ws of allWorkspaces as any[]) {
        if (!ws.cwd || ws.kind === "azure") continue;
        if (path.resolve(String(ws.cwd)) === deletedGitCwd) targets.add(ws.id);
      }
    }

    // Filter to IDs that actually exist in the current workspace list
    const existingIds = new Set(allWorkspaces.map((w: any) => w.id)); // eslint-disable-line @typescript-eslint/no-explicit-any
    return [...targets].filter((id) => existingIds.has(id));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function resolveManagedDeletePath(workspace: any, requestedPath: string): string | null {
    if (!requestedPath || !path.isAbsolute(requestedPath)) return null;
    const res = (p: unknown) => path.resolve(String(p || "").trim());

    // Review managed-worktree
    if (workspace.review?.checkout?.mode === "managed-worktree" && workspace.review.checkout.rootPath) {
      if (requestedPath === res(workspace.review.checkout.rootPath)) return requestedPath;
    }

    // Quickfix — cwd is the managed checkout directory (quickfix.rootPath is not persisted)
    if (workspace.quickfix && workspace.cwd) {
      if (requestedPath === res(workspace.cwd)) return requestedPath;
    }

    // Task worktree: only the task's own checkout is managed. worktreeBase is
    // the parent repo and must never be deleted by workspace cleanup.
    if (workspace.task && workspace.task.worktreeBase && workspace.cwd) {
      const base = res(workspace.task.worktreeBase);
      const cwd = res(workspace.cwd);
      const underBase = cwd === base || cwd.startsWith(base + path.sep);
      if (underBase && requestedPath === cwd) {
        return requestedPath;
      }
    }

    // Legacy "Worktree of ..." — cwd is always inside .strideterm/tree/
    if ((workspace.notes || "").startsWith("Worktree of ") && workspace.cwd) {
      const cwd = res(workspace.cwd);
      if (requestedPath === cwd && cwd.includes(`.strideterm${path.sep}tree${path.sep}`)) return requestedPath;
    }

    return null;
  }

  /**
   * Shared tail for openDockerSession/openLazydockerSession/openLazygitSession:
   * create or update `panelId` on the target workspace with the caller's
   * launch spec, activate it, and re-sync sessions/alerts. Each caller keeps
   * only its own launch-construction specifics (and "not found" wording).
   */
  async function openLaunchPanel(
    targetWorkspaceId: string,
    panelId: string,
    panelSpec: { title: string; command: string; launch: unknown; notFoundMessage: string },
  ) {
    await store.mutate((draft: AppState) => {
      const workspace = findWorkspace(draft, targetWorkspaceId);
      if (!workspace) {
        throw new Error(panelSpec.notFoundMessage);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = (workspace as any).panels?.find((panel: any) => panel.id === panelId);
      const nextPanel = {
        id: panelId,
        title: panelSpec.title,
        command: panelSpec.command,
        launch: panelSpec.launch,
        shell: true,
        startup: APP_CONFIG.ui.manualPanelStartup,
      };

      if (existing) {
        Object.assign(existing, nextPanel);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (workspace as any).panels?.push(nextPanel);
      }

      draft.activeWorkspaceId = targetWorkspaceId;
      workspace.activePanelId = panelId;
    });

    sessions.syncWithState(getState());
    ensureSessionSafe(createSessionId(targetWorkspaceId, panelId));
    clearProjectAlerts(targetWorkspaceId, panelId);
    broadcastState();
    return getPayload();
  }

  /**
   * Compute the on-disk path a `.strideterm/tree/` worktree for
   * `branchOrName` would live at under `repoPath`. Pure — no disk access.
   * Shared by ensureWorktree and any caller that needs to know the path
   * before (or without) actually creating the worktree (e.g. the Telegram
   * start-task dispatch, which only needs it to show the user a preview).
   */
  function worktreeTreePath(repoPath: string, branchOrName: string): string {
    return path.join(repoPath, ".strideterm", "tree", branchOrName.replace(/\//g, "-"));
  }

  /**
   * Create a git worktree for `branchOrName` under `repoPath`'s
   * `.strideterm/tree/` directory: ensure `.strideterm/` is gitignored,
   * create the parent directory, then `git worktree add`. Returns the
   * worktree's path.
   *
   * createWorktree and createTaskWorkspace had drifted on failure handling
   * before this extraction — createTaskWorkspace retries against an
   * existing branch and rewrites common git failures into friendlier
   * messages, createWorktree does neither. `richErrorHandling` preserves
   * both original behaviors verbatim rather than silently merging them.
   */
  async function ensureWorktree(
    repoPath: string,
    branchOrName: string,
    { richErrorHandling = false }: { richErrorHandling?: boolean } = {},
  ): Promise<string> {
    const treePath = worktreeTreePath(repoPath, branchOrName);

    // Ensure .strideterm/ in .gitignore (inside the chosen repo)
    const gitignorePath = path.join(repoPath, ".gitignore");
    let gitignoreContent = "";
    try {
      gitignoreContent = await readFile(gitignorePath, "utf-8");
    } catch {}
    if (!gitignoreContent.split(/\r?\n/).some((line) => line.trim() === ".strideterm/")) {
      const separator = gitignoreContent.length && !gitignoreContent.endsWith("\n") ? "\n" : "";
      await writeFile(gitignorePath, gitignoreContent + separator + ".strideterm/\n", "utf-8");
    }

    // Ensure directory exists for worktree
    await mkdir(path.dirname(treePath), { recursive: true });

    if (!richErrorHandling) {
      // git worktree add — run inside the chosen repo root, not the workspace parent
      await execFileTextImpl("git", ["worktree", "add", treePath, "-b", branchOrName], { cwd: repoPath });
      return treePath;
    }

    try {
      await execFileTextImpl("git", ["worktree", "add", treePath, "-b", branchOrName], { cwd: repoPath });
    } catch (err) {
      // execFileText rejects with { error, stdout, stderr } — the useful
      // message lives in stderr. err.message is undefined here, so don't
      // rely on it for either the branch-exists fallback or the user error.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stderr = (err as any)?.stderr?.trim() || (err as any)?.error?.message || (err as Error).message || "";
      if (stderr.includes("already exists")) {
        await execFileTextImpl("git", ["worktree", "add", treePath, branchOrName], { cwd: repoPath });
      } else if (stderr.includes("not a git repository")) {
        // Most common user mistake — surface a clear, actionable message.
        throw new Error(
          `"${repoPath}" is not a git repository. Initialize with \`git init\` there, or disable "Use git worktree" in the task dialog.`,
          { cause: err },
        );
      } else {
        throw new Error(`Failed to create git worktree: ${stderr || "unknown error"}`, { cause: err });
      }
    }
    return treePath;
  }

  /**
   * End-to-end probe of a notification hook pipeline (Claude, Gemini, Codex,
   * Copilot, or Opencode).
   *
   * Spawns the installed notify.mjs with synthetic stdin containing a
   * probe UUID. Waits up to 2s for the dispatcher to receive it.
   * Returns { ok, elapsedMs?, reason?, logTail? }.
   *
   * Provider-neutral — every provider uses the same notify.mjs; this helper
   * just needs a detect/configure pair for the requested provider.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function runHookProbe({ detectStatus, configure }: { detectStatus: any; configure: any }) {
    const status = await detectStatus(userDataPath);
    if (status.status === "error") {
      return { ok: false, reason: "config-error", detail: status.error };
    }
    if (status.status !== "configured") {
      const cfg = await configure(userDataPath);
      if (!cfg.ok) return { ok: false, reason: "configure-failed", detail: cfg.error };
    }

    if (!notifyServerHandle) await startAgentNotifyServer();
    if (!notifyServerHandle) return { ok: false, reason: "notify-server-unavailable" };

    const probeId = randomUUID();
    const probeSessionId = `probe:${probeId}`;
    const probeUrl = buildNotifyUrl(notifyServerHandle.port, probeSessionId, notifySecret);

    const receivedPromise = new Promise((resolve) => {
      hookProbeListeners.set(probeId, resolve);
      setTimeout(() => {
        if (hookProbeListeners.has(probeId)) {
          hookProbeListeners.delete(probeId);
          resolve({ ok: false, reason: "timeout" });
        }
      }, 2000);
    });

    // Override STRIDETERM_NOTIFY_URL so the probe doesn't rely on
    // CLAUDE_PROJECT_DIR / notify-urls.json resolution.
    const scriptPath = path.join(userDataPath, "hooks", "notify.mjs");
    const startedAt = Date.now();
    let spawnError: Error | null = null;
    try {
      const child = spawn(process.execPath, [scriptPath, "Notification"], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          STRIDETERM_NOTIFY_URL: probeUrl,
          CLAUDE_PROJECT_DIR: "",
        },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", (err) => {
        spawnError = err;
      });
      child.stdin.write(JSON.stringify({ notification_type: "probe", probe_id: probeId }));
      child.stdin.end();
    } catch (err) {
      hookProbeListeners.delete(probeId);
      return { ok: false, reason: "spawn-failed", detail: (err as Error).message };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: untyped probe result from dynamic hook spawn
    const result = (await receivedPromise) as any;
    const elapsedMs = Date.now() - startedAt;

    if (result?.ok) return { ok: true, elapsedMs };
    if (spawnError) {
      return { ok: false, reason: "spawn-error", detail: (spawnError as Error).message, elapsedMs };
    }

    // Timeout — surface hook.log tail so the user can see what happened.
    let logTail = "";
    try {
      const logPath = path.join(userDataPath, "logs", "hook.log");
      const raw = await readFile(logPath, "utf8");
      logTail = raw.split("\n").slice(-10).join("\n");
    } catch {
      /* no log yet */
    }
    return { ok: false, reason: "timeout", elapsedMs, logTail };
  }

  /**
   * One entry per agent hook-config provider. Generates the
   * configure/remove/status/test quartet below instead of 20 hand-written
   * one-liners — each provider module (claude/gemini/codex/copilot/opencode
   * -hook-config.js) exports the same configure/remove/detectStatus shape.
   */
  interface HookProviderTableEntry {
    id: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configure: (userDataPath: string) => Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    remove: () => Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detectStatus: (userDataPath: string) => Promise<any>;
  }
  const HOOK_PROVIDERS = [
    { id: "Claude", configure: configureClaudeHook, remove: removeClaudeHook, detectStatus: detectClaudeHookStatus },
    { id: "Gemini", configure: configureGeminiHook, remove: removeGeminiHook, detectStatus: detectGeminiHookStatus },
    { id: "Codex", configure: configureCodexHook, remove: removeCodexHook, detectStatus: detectCodexHookStatus },
    {
      id: "Copilot",
      configure: configureCopilotHook,
      remove: removeCopilotHook,
      detectStatus: detectCopilotHookStatus,
    },
    {
      id: "Opencode",
      configure: configureOpencodeHook,
      remove: removeOpencodeHook,
      detectStatus: detectOpencodeHookStatus,
    },
  ] as const satisfies readonly HookProviderTableEntry[];
  type HookProviderId = (typeof HOOK_PROVIDERS)[number]["id"];
  // Method names are derived from HOOK_PROVIDERS' ids so the public runtime
  // API surface (relied on by ipc.ts / remote-server.ts) stays fully typed
  // even though the implementations below are generated from the table.
  type HookProviderHandlers = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [Id in HookProviderId as `configure${Id}Hook`]: () => Promise<any>;
  } & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [Id in HookProviderId as `remove${Id}Hook`]: () => Promise<any>;
  } & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [Id in HookProviderId as `get${Id}HookStatus`]: () => Promise<any>;
  } & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [Id in HookProviderId as `test${Id}Hook`]: () => Promise<any>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hookProviderHandlers: Record<string, (...args: any[]) => any> = {};
  for (const provider of HOOK_PROVIDERS) {
    hookProviderHandlers[`configure${provider.id}Hook`] = () => provider.configure(userDataPath);
    hookProviderHandlers[`remove${provider.id}Hook`] = () => provider.remove();
    hookProviderHandlers[`get${provider.id}HookStatus`] = () => provider.detectStatus(userDataPath);
    hookProviderHandlers[`test${provider.id}Hook`] = () =>
      runHookProbe({ detectStatus: provider.detectStatus, configure: provider.configure });
  }
  const typedHookProviderHandlers = hookProviderHandlers as unknown as HookProviderHandlers;

  /**
   * Delete a workspace's on-disk worktree, called from deleteWorkspace when
   * `options.deleteFromDisk` is set. Validates `requestedPath` is actually a
   * path this workspace manages (resolveManagedDeletePath), waits for its
   * PTY sessions to fully exit (Windows file-handle release probe), removes
   * the directory (rmPath, falling back to `git worktree remove --force`),
   * and arms a background retry on failure. Returns "" on success, or a
   * user-facing error string.
   */
  async function deleteWorkspaceFromDisk(
    workspace: WorkspaceState,
    workspaceId: string,
    requestedPath: string,
    sessionsExited: Promise<void> | null,
  ): Promise<string> {
    const diskPath = resolveManagedDeletePath(workspace, requestedPath) ?? "";
    if (!diskPath) {
      return `Refused to delete unmanaged workspace path: ${requestedPath || "(empty)"}`;
    }
    let diskDeleteError = "";
    if (diskPath && path.isAbsolute(diskPath)) {
      pendingWorktreeDeletions.add(diskPath);
      // Krok 6: a fresh delete on this exact path supersedes any armed
      // background retry — cancel it and take the synchronous path.
      cancelBackgroundDeleteRetry(diskPath);
      const tDelete0 = Date.now();
      log.debug("deleteWorkspace: starting disk delete", {
        workspaceId,
        workspaceName: workspace.name,
        diskPath,
        kind: workspace.kind,
        isReview: !!workspace.review,
        isTask: !!workspace.task,
        isQuickfix: !!workspace.quickfix,
      });
      // Resolve the git cwd up front (depends only on the workspace) so the
      // catch branch can prune / arm a background retry after a failure.
      const cacheRepoPath = workspace.review?.checkout?.cacheRepoPath || "";
      const taskWorktreeBase = workspace.task?.worktreeBase || "";
      const mainWorktreePath = workspace.cwd ? path.resolve(workspace.cwd, "..", "..", "..") : "";
      const gitCwd = cacheRepoPath || taskWorktreeBase || mainWorktreePath;
      try {
        const tWait0 = Date.now();
        await sessionsExited;
        log.debug("deleteWorkspace: PTY sessions exited", {
          workspaceId,
          waitMs: Date.now() - tWait0,
        });
        // On Windows, agent children (claude.exe, codex.exe, …) spawned by
        // the killed PTY shell may outlive their parent for hundreds of
        // milliseconds while still holding file handles inside the
        // worktree. fs/rd will fail with EBUSY/EPERM until those handles
        // are released. We don't taskkill the tree (too brutal — risks
        // truncated agent state), instead we wait by probing: try to
        // rename diskPath onto itself; on Windows this fails while any
        // handle is open and succeeds once they're all released. Cap the
        // wait at 5s; if it still locks, rmPath's own retry loop will
        // either eventually succeed or the git fallback will run.
        if (process.platform === "win32") {
          const tProbe0 = Date.now();
          // Krok 1: ENOENT short-circuits instead of spinning the full
          // timeout on an already-gone directory.
          const probe = await waitForHandleRelease(diskPath, { renameImpl: rename });
          log.debug("deleteWorkspace: handle-release probe finished", {
            workspaceId,
            diskPath,
            probeMs: Date.now() - tProbe0,
            released: probe.released,
            reason: probe.reason,
          });
        }

        log.debug("deleteWorkspace: resolved git cwd", { workspaceId, gitCwd, cacheRepoPath, taskWorktreeBase });
        // Fast path: nuke the directory at the filesystem level, then ask
        // git to prune stale metadata. `git worktree remove --force` walks
        // the tree itself with per-file stat calls — markedly slower than
        // platform-native `rd /s /q` (Windows) or fs.rm (POSIX) when the
        // worktree has a fat node_modules / build dir. The previous order
        // (git first, fs fallback) made every successful delete take the
        // slow path. Only fall back to `git worktree remove --force` if
        // rmPath couldn't finish (e.g. locked files held by AV).
        let rmFailed = false;
        let rmErr: unknown = null;
        const tRm0 = Date.now();
        try {
          await rmPath(diskPath);
          log.debug("deleteWorkspace: rmPath succeeded", { workspaceId, diskPath, ms: Date.now() - tRm0 });
        } catch (err) {
          rmFailed = true;
          rmErr = err;
          log.debug("deleteWorkspace: rmPath failed, trying git worktree remove --force", {
            workspaceId,
            diskPath,
            ms: Date.now() - tRm0,
            err: (err as Error)?.message?.slice(0, 200),
          });
        }
        if (gitCwd) {
          let gitFallbackErr: unknown = null;
          if (rmFailed) {
            const tGit0 = Date.now();
            try {
              await execFileTextImpl("git", ["worktree", "remove", "--force", diskPath], { cwd: gitCwd });
              log.debug("deleteWorkspace: git worktree remove --force succeeded", {
                workspaceId,
                diskPath,
                ms: Date.now() - tGit0,
              });
            } catch (err) {
              gitFallbackErr = err;
              log.warn("deleteWorkspace: git worktree remove --force also failed", {
                workspaceId,
                diskPath,
                ms: Date.now() - tGit0,
                err: (err as Error)?.message?.slice(0, 200),
                rmErr: (rmErr as Error)?.message?.slice(0, 200),
              });
            }
          }
          // Prune the .git/worktrees admin entry. Doesn't need to block
          // the response — it's just metadata cleanup.
          execFileTextImpl("git", ["worktree", "prune"], { cwd: gitCwd }).catch(() => {});
          if (rmFailed && gitFallbackErr) {
            const rmMsg = (rmErr as Error)?.message?.slice(0, 200) ?? String(rmErr);
            const gitMsg = (gitFallbackErr as Error)?.message?.slice(0, 200) ?? String(gitFallbackErr);
            throw new Error(`Failed to remove ${diskPath}: rm: ${rmMsg}; git: ${gitMsg}`);
          }
        } else if (rmFailed) {
          // No git cwd to prune from — surface the rm failure.
          throw new Error(`Failed to remove ${diskPath}`);
        }
        log.debug("deleteWorkspace: disk delete complete", {
          workspaceId,
          diskPath,
          totalMs: Date.now() - tDelete0,
          rmFailed,
        });
      } catch (err) {
        diskDeleteError = `Could not delete ${diskPath}: ${(err as any)?.message || err}`; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: unknown catch shape
        log.warn("workspace disk delete failed", { diskPath, err: diskDeleteError });
        // Krok 6: the foreground attempt gave up (likely a lock held by an
        // orphaned agent child / AV). Keep the path held in
        // pendingWorktreeDeletions and retry in the background with backoff
        // (10s/30s/60s/120s); the retry owns the eventual release.
        scheduleBackgroundDeleteRetry(diskPath, gitCwd);
      } finally {
        // On success no retry was armed → release the hold now. On failure
        // the background retry holds it until it succeeds or exhausts.
        if (!backgroundDeleteRetries.has(diskPath)) pendingWorktreeDeletions.delete(diskPath);
      }
    }
    return diskDeleteError;
  }

  const returnObj = {
    ...providerHandlers,
    ...gitHandlers,
    ...sshHandlers,
    ...dockerHandlers,
    ...gridHandlers,
    ...taskHandlers,
    ...typedHookProviderHandlers,
    async listWorkspaceDirectories(
      profileId: string,
      requestedPath?: string,
      options: { query?: string; sort?: "nameAsc" | "nameDesc" } = {},
    ) {
      const state = getState();
      assertProfileExists(state, profileId);
      const home = await realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
      const target = requestedPath ? assertNativePath(requestedPath) : path.resolve(home);
      const info = await lstat(target).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("Directory not found");
      const directoryEntries = (await readdir(target, { withFileTypes: true })).filter(
        (entry) => entry.isDirectory() && !entry.isSymbolicLink(),
      );
      const query = options.query?.toLocaleLowerCase() || "";
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      const matchingEntries = directoryEntries
        .filter((entry) => !query || entry.name.toLocaleLowerCase().includes(query))
        .map((entry) => ({ name: entry.name, path: path.join(target, entry.name) }))
        .sort((a, b) => collator.compare(a.name, b.name) || a.path.localeCompare(b.path));
      if (options.sort === "nameDesc") matchingEntries.reverse();
      const entries = matchingEntries.slice(0, 500);
      const roots: Array<{ name: string; path: string }> = [{ name: "Home", path: home }];
      if (process.platform === "win32") {
        for (let code = 65; code <= 90; code++) {
          const drive = `${String.fromCharCode(code)}:\\`;
          if (
            await access(drive)
              .then(() => true)
              .catch(() => false)
          )
            roots.push({ name: drive, path: drive });
        }
      } else if (!roots.some((root) => root.path === path.parse(target).root)) roots.push({ name: "/", path: "/" });
      const canonicalTemp = await realpath(os.tmpdir()).catch(() => os.tmpdir());
      const shortcutCandidates = [
        { name: "Home", path: home },
        { name: "Temp", path: canonicalTemp },
        { name: "Desktop", path: path.join(home, "Desktop") },
        { name: "Documents", path: path.join(home, "Documents") },
        { name: "Downloads", path: path.join(home, "Downloads") },
      ];
      const shortcuts: Array<{ name: string; path: string }> = [];
      const shortcutPaths = new Set<string>();
      for (const shortcut of shortcutCandidates) {
        const shortcutInfo = await lstat(shortcut.path).catch(() => null);
        if (!shortcutInfo?.isDirectory() || shortcutInfo.isSymbolicLink()) continue;
        const key = path.normalize(shortcut.path);
        if (shortcutPaths.has(key)) continue;
        shortcutPaths.add(key);
        shortcuts.push(shortcut);
      }
      return {
        path: target,
        parentPath: path.dirname(target) === target ? null : path.dirname(target),
        roots,
        shortcuts,
        supportsQuery: true,
        entries,
        truncated: matchingEntries.length > 500,
      };
    },
    async createWorkspaceFromDirectory(profileId: string, cwd: string, name?: string, viewerId?: string) {
      const state = getState();
      assertProfileExists(state, profileId);
      const resolved = assertNativePath(cwd);
      const info = await lstat(resolved).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("Directory not found");
      const panelId = `panel-${randomUUID()}`;
      const workspace = {
        id: `workspace-${randomUUID()}`,
        name: (name || path.basename(resolved) || "Workspace").trim().slice(0, 120),
        icon: "📁",
        color: "#ffa424",
        kind: "terminal",
        source: "manual",
        pluginId: "",
        cwd: resolved,
        profileId,
        notes: "",
        activePanelId: panelId,
        panels: [{ id: panelId, title: "Shell", command: "", shell: true, startup: "" }],
      };
      await this.saveWorkspace(workspace, viewerId);
      const saved = findWorkspace(getState(), workspace.id);
      return {
        workspaceId: workspace.id,
        profileId,
        name: saved?.name || workspace.name,
        path: saved?.cwd || resolved,
      };
    },
    async createWorkspaceDirectory(profileId: string, parentPath: string, name: string) {
      assertProfileExists(getState(), profileId);
      if (!isValidNativeDirectoryName(name)) throw new Error("Invalid directory name");
      const parent = assertNativePath(parentPath);
      const info = await lstat(parent).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("Parent directory not found");
      const target = path.join(parent, name);
      if (
        await access(target)
          .then(() => true)
          .catch(() => false)
      )
        throw new Error("Directory already exists");
      await mkdir(target);
      return { path: target };
    },
    async listScratchpadWorkspaces(profileId: string) {
      assertProfileExists(getState(), profileId);
      return {
        scratchpads: (getState().scratchpads || []).filter((record) => record.profileId === profileId),
      };
    },
    async createScratchpadWorkspace(profileId: string, viewerId?: string) {
      assertProfileExists(getState(), profileId);
      const root = path.join(userDataPath, "scratchpads");
      await mkdir(root, { recursive: true });
      const dir = path.join(root, randomUUID());
      await mkdir(dir);
      const scratchName = `Scratchpad ${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const workspaceId = `workspace-${randomUUID()}`;
      const panelId = `panel-${randomUUID()}`;
      const record = {
        workspaceId,
        profileId,
        name: scratchName,
        path: dir,
        createdAt: new Date().toISOString(),
      };
      try {
        await store.mutate((draft: AppState) => {
          assertProfileExists(draft, profileId);
          const normalized = normalizeWorkspace({
            id: workspaceId,
            name: scratchName,
            icon: "📁",
            color: "#ffa424",
            kind: "terminal",
            source: "manual",
            pluginId: "",
            cwd: dir,
            profileId,
            notes: "",
            activePanelId: panelId,
            panels: [{ id: panelId, title: "Shell", command: "", shell: true, startup: "" }],
          });
          insertWorkspace(draft.workspaces, normalized, getViewerActiveWorkspaceId(viewerId));
          markWorkspaceWorked(draft, workspaceId);
          draft.scratchpads = [...(draft.scratchpads || []).filter((item) => item.workspaceId !== workspaceId), record];
          if (!draft.activeWorkspaceId) draft.activeWorkspaceId = workspaceId;
        });
      } catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      sessions.syncWithState(getState());
      syncSessionSignalsWithState();
      broadcastState();
      syncTreeDirWatchers();
      return record;
    },
    keepScratchpadWorkspace(
      profileId: string,
      workspaceId: string,
      options: { name?: string; parentPath?: string; directoryName?: string } = {},
    ) {
      return withNativeWorkspaceLock(workspaceId, () =>
        this.keepScratchpadWorkspaceUnsafe(profileId, workspaceId, options),
      );
    },
    async keepScratchpadWorkspaceUnsafe(
      profileId: string,
      workspaceId: string,
      options: { name?: string; parentPath?: string; directoryName?: string } = {},
    ) {
      assertProfileExists(getState(), profileId);
      const record = (getState().scratchpads || []).find(
        (item) => item.workspaceId === workspaceId && item.profileId === profileId,
      );
      const workspace = findWorkspace(getState(), workspaceId);
      if (!record || !workspace) throw new Error("Scratchpad not found");
      if ((workspace.profileId || "default") !== profileId) throw new Error("Scratchpad profile mismatch");
      if (path.resolve(record.path) !== path.resolve(workspace.cwd || ""))
        throw new Error("Scratchpad metadata no longer matches workspace");
      if (options.parentPath) {
        if (!isValidNativeDirectoryName(options.directoryName || options.name || record.name))
          throw new Error("Invalid directory name");
        const parent = assertNativePath(options.parentPath);
        const parentInfo = await lstat(parent).catch(() => null);
        if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink())
          throw new Error("Destination directory not found");
        const destination = path.join(parent, options.directoryName || options.name || record.name);
        const sourceRoot = path.join(userDataPath, "scratchpads");
        assertContainedPath(sourceRoot, record.path);
        const sourceInfo = await lstat(record.path).catch(() => null);
        if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink())
          throw new Error("Scratchpad directory is unsafe");
        const sourceRealRoot = await realpath(sourceRoot);
        const sourceRealPath = await realpath(record.path);
        assertContainedPath(sourceRealRoot, sourceRealPath);
        const sourceToDestination = path.relative(record.path, destination);
        if (sourceToDestination && !sourceToDestination.startsWith("..") && !path.isAbsolute(sourceToDestination)) {
          throw new Error("Destination cannot be inside the scratchpad");
        }
        if (
          await access(destination)
            .then(() => true)
            .catch(() => false)
        )
          throw new Error("Destination already exists");
        await sessions.removeWorkspaceSessions(workspaceId);
        let moveMode: "rename" | "copy" = "rename";
        try {
          await rename(record.path, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          moveMode = "copy";
          await cp(record.path, destination, {
            recursive: true,
            force: false,
            errorOnExist: true,
            verbatimSymlinks: true,
          });
        }
        const sourceAbsolute = path.resolve(record.path);
        const remap = (value?: string) => {
          if (!value) return value;
          const absolute = path.resolve(value);
          const relative = path.relative(sourceAbsolute, absolute);
          if (!relative) return destination;
          if (!relative.startsWith("..") && !path.isAbsolute(relative)) return path.join(destination, relative);
          return value;
        };
        const updatedWorkspace = {
          ...workspace,
          cwd: destination,
          name: options.name || workspace.name,
          gitRoots: (workspace.gitRoots || []).map((root: string) => remap(root)),
          activeRootPath: remap(workspace.activeRootPath),
          panels: workspace.panels.map((panel: { cwd?: string }) => ({
            ...panel,
            cwd: remap(panel.cwd),
          })),
        };
        try {
          await store.mutate((draft: AppState) => {
            const index = draft.workspaces.findIndex((item) => item.id === workspaceId);
            if (index < 0) throw new Error("Scratchpad workspace disappeared");
            draft.workspaces[index] = normalizeWorkspace(updatedWorkspace);
            draft.scratchpads = (draft.scratchpads || []).filter((item) => item.workspaceId !== workspaceId);
          });
        } catch (error) {
          if (moveMode === "rename") await rename(destination, record.path).catch(() => {});
          else await rm(destination, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        if (moveMode === "copy") {
          try {
            await rm(record.path, { recursive: true, force: false });
          } catch (error) {
            log.warn("scratchpad keep: source cleanup failed after commit", {
              workspaceId,
              source: record.path,
              destination,
              err: (error as Error).message,
            });
          }
        }
        record.path = destination;
        record.name = options.name || workspace.name;
      } else if (options.name && options.name !== workspace.name) {
        await store.mutate((draft: AppState) => {
          const index = draft.workspaces.findIndex((item) => item.id === workspaceId);
          if (index < 0) throw new Error("Scratchpad workspace disappeared");
          draft.workspaces[index] = normalizeWorkspace({ ...workspace, name: options.name });
          draft.scratchpads = (draft.scratchpads || []).filter((item) => item.workspaceId !== workspaceId);
        });
        record.name = options.name;
      } else {
        await store.mutate((draft: AppState) => {
          draft.scratchpads = (draft.scratchpads || []).filter((item) => item.workspaceId !== workspaceId);
        });
      }
      sessions.syncWithState(getState());
      syncSessionSignalsWithState();
      broadcastState();
      syncTreeDirWatchers();
      void refreshGit(workspaceId).catch(() => {});
      return { workspaceId, profileId, name: record.name, path: record.path };
    },
    discardScratchpadWorkspace(profileId: string, workspaceId: string, confirmed: boolean) {
      return withNativeWorkspaceLock(workspaceId, () =>
        this.discardScratchpadWorkspaceUnsafe(profileId, workspaceId, confirmed),
      );
    },
    async discardScratchpadWorkspaceUnsafe(profileId: string, workspaceId: string, confirmed: boolean) {
      assertProfileExists(getState(), profileId);
      if (!confirmed) throw new Error("Discard requires explicit confirmation");
      const record = (getState().scratchpads || []).find(
        (item) => item.workspaceId === workspaceId && item.profileId === profileId,
      );
      const workspace = findWorkspace(getState(), workspaceId);
      if (!record || !workspace) throw new Error("Scratchpad not found");
      if ((workspace.profileId || "default") !== profileId) throw new Error("Scratchpad profile mismatch");
      const root = path.join(userDataPath, "scratchpads");
      const target = assertContainedPath(root, record.path);
      if (path.resolve(workspace.cwd || "") !== target)
        throw new Error("Scratchpad metadata no longer matches workspace");
      const targetInfo = await lstat(target).catch(() => null);
      if (!targetInfo) {
        await this.deleteWorkspace(workspaceId, {}, undefined);
        await store.mutate((draft: AppState) => {
          draft.scratchpads = (draft.scratchpads || []).filter((item) => item.workspaceId !== workspaceId);
        });
        return { ok: true, workspaceId, profileId, alreadyAbsent: true };
      }
      if (!targetInfo?.isDirectory() || targetInfo.isSymbolicLink()) throw new Error("Scratchpad directory is unsafe");
      const realRoot = await realpath(root);
      const realTarget = await realpath(target);
      assertContainedPath(realRoot, realTarget);
      if (findActiveCompanionSource(getState(), workspaceId)) {
        throw new Error("Cannot discard a workspace with an active companion task");
      }
      await sessions.removeWorkspaceSessions(workspaceId);
      await rm(target, { recursive: true, force: false });
      await this.deleteWorkspace(workspaceId, {}, undefined);
      await store.mutate((draft: AppState) => {
        draft.scratchpads = (draft.scratchpads || []).filter((item) => item.workspaceId !== workspaceId);
      });
      return { ok: true, workspaceId, profileId };
    },
    /**
     * Re-scan parent workspaces for new/removed `.strideterm/tree/*` worktrees
     * and reconcile workspace state. Normally called from the git poll timer;
     * exposed so tests can drive the reconciliation deterministically instead
     * of racing `vi.advanceTimersByTimeAsync` against real fs I/O.
     */
    syncWorktrees: async (): Promise<void> => {
      await syncWorktrees();
    },
    /**
     * perf-3 / Krok 2-3 — arm the debounced, leading-edge-rate-limited git
     * refresh that an OSC 133;D command-finished marker triggers. Normally
     * driven from the `terminal:data` handler; exposed so tests can exercise
     * the debounce + 10s leading-edge coalescing + delete-cancellation
     * deterministically with fake timers and a `refreshWorkspaces` spy, instead
     * of decoding raw OSC byte streams through the whole data pipeline.
     */
    scheduleGitRefreshFromShell: (workspaceId: string): void => {
      scheduleGitRefreshFromShell(workspaceId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(channel: any, handler: any) {
      events.on(channel, handler);
      return () => events.off(channel, handler);
    },
    getPayload,
    getRemoteInfo() {
      return remoteInfo;
    },
    getTerminalReplay(sessionId: string) {
      return { data: terminalReplay.snapshot(String(sessionId || "")).data };
    },
    /**
     * Sequence-aware snapshot for the remote subscribe handshake: returns the
     * stored output plus the `throughSeq` a client uses to drop duplicate live
     * frames. The plain HTTP/IPC `getTerminalReplay` above stays `{ data }` so
     * the Electron attach path is unchanged.
     */
    getTerminalReplaySnapshot(sessionId: string) {
      return terminalReplay.snapshot(String(sessionId || ""));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setRemoteInfo(nextRemoteInfo: any) {
      remoteInfo = nextRemoteInfo;
      broadcastState();

      // Boot-time auto-tunnel: re-establish a Cloudflare quick-tunnel if
      // the user had one running before the last shutdown. Gated on the
      // remote-access server reporting its bind result so we never start
      // cloudflared while THIS instance's server is dead (which would
      // either probe-fail or — worse — quietly tunnel into a competing
      // process that owns the port, e.g. a dev build running alongside).
      if (autoTunnelBootstrapped) {
        return;
      }
      autoTunnelBootstrapped = true;

      const remoteConfig = getState().settings.remoteAccess;
      if (!remoteConfig.enabled || !remoteConfig.autoTunnel || remoteConfig.paused) {
        log.debug("autoTunnel: skipped — disabled or not requested", {
          remoteEnabled: !!remoteConfig.enabled,
          autoTunnel: !!remoteConfig.autoTunnel,
        });
        return;
      }

      const serverBound = nextRemoteInfo?.enabled === true;
      if (!serverBound) {
        const bindError =
          typeof nextRemoteInfo?.error === "string" && nextRemoteInfo.error
            ? nextRemoteInfo.error
            : "Remote access server is not running";
        const msg = `Cloudflare auto-tunnel skipped — ${bindError}. Stop the conflicting process (commonly a dev build of strideterm) or change STRIDETERM_REMOTE_PORT, then restart.`;
        log.warn("autoTunnel: server did not bind, refusing to start cloudflared", {
          bindError,
          port: remoteConfig.port,
          host: remoteConfig.host,
        });
        tunnel.applyExternalError(msg);
        return;
      }

      log.info("autoTunnel: server bound, restoring tunnel", {
        host: remoteConfig.host,
        port: remoteConfig.port,
      });
      tunnel.applyExternalConnecting();
      ensureRemoteOriginReady(remoteConfig)
        .then((origin) => tunnel.startQuickTunnel(origin))
        .then(() => {
          log.info("autoTunnel: tunnel restored", { publicUrl: tunnel.getSnapshot().publicUrl });
          broadcastState();
        })
        .catch((err: unknown) => {
          const message = (err as Error)?.message || String(err);
          log.warn("autoTunnel: failed to re-establish tunnel on startup", { err: message });
          tunnel.applyExternalError(message);
        });
    },

    /**
     * Called by the PRIMARY (LAN/tunnel) server to hand its registry handle to the runtime.
     *
     * Replaces the previous primary rather than accumulating: that server is stopped and restarted
     * whenever the user changes the remote settings, and each start brings a new registry.
     */
    setRemoteClientRegistry(registry: RemoteClientRegistry): void {
      if (_primaryRemoteClientRegistry) _remoteClientRegistries.delete(_primaryRemoteClientRegistry);
      _primaryRemoteClientRegistry = registry;
      _remoteClientRegistries.add(registry);
    },

    /**
     * Called by a SECONDARY server — today only the managed relay's internal loopback origin — to
     * add its own registry without displacing the primary's, and returns the handle that removes it
     * again when that server closes.
     *
     * Without this, a relay viewer's `remote:<sessionId>` resolves to no client, and every
     * per-viewer operation either fails ("registry not initialised") or, worse, silently skips a
     * profile guard that reads an unresolvable viewer as "not a viewer".
     */
    addRemoteClientRegistry(registry: RemoteClientRegistry): () => void {
      _remoteClientRegistries.add(registry);
      return () => {
        _remoteClientRegistries.delete(registry);
      };
    },

    /**
     * Called by startRemoteServer once its session registry exists, so
     * MobileManager.revokeDevice() can close a revoked device's active
     * remote HTTP/WS session(s) (plan §9.2/§10.6) without remote-server.ts
     * and mobile-manager.ts referencing each other directly.
     */
    /**
     * Whether a mobile session's device may still hold it — asked per request by remote-server.ts.
     *
     * Three conditions, all read from the persistent device store rather than from anything the
     * session remembers: the device is still usable (active and not revoked), it still holds
     * `remote.webSession`, and the profile the session is bound to is still on its allowlist. The
     * first is also covered by the revoke path closing sessions immediately; the other two are not
     * revokes, so nothing pushes them and the only way they take effect is by being asked
     * (production hardening §5 "Session" 2/4).
     */
    isMobileSessionStillAuthorized(deviceId: string, profileId: string): boolean {
      const device = mobileDeviceStore.getDevice(deviceId);
      if (!isMobileDeviceUsable(device)) return false;
      if (!mobileDeviceHasCapability(device, "remote.webSession")) return false;
      return mobileDeviceAllowsProfile(device, profileId);
    },

    getMobileAttachmentContext(deviceId: string) {
      return {
        desktopDeviceId: mobileDeviceId,
        privateKey: mobileOwnKeyPair.privateKey,
        device: mobileDeviceStore.getDevice(deviceId),
      };
    },

    setMobileRemoteSessionRevoker(fn: (deviceId: string) => void): void {
      _mobileRemoteSessionRevoker = fn;
    },

    /** Wired by the IPC layer, which owns Electron's `shell`. See `_externalUrlOpener`. */
    setExternalUrlOpener(fn: (url: string) => Promise<void>): void {
      _externalUrlOpener = fn;
    },

    // --- account (plan §8.1) ---------------------------------------------------------------------
    //
    // Thin: every decision is the AccountManager's, and every one of these returns either nothing or
    // a small, already-safe value. Notably NOT among them: anything that returns a URL, a token or a
    // password.
    getAccountState() {
      return accountManager.state();
    },
    /**
     * Starts a passwordless sign-in and RETURNS QUICKLY.
     *
     * Deliberately not a long-running IPC call that resolves when the person opens the link (plan §8,
     * Fáze 3): a call held open for fifteen minutes cannot be cancelled, cannot be resent, and dies
     * with the window that made it. What continues the flow is the account-state event every window
     * already subscribes to.
     */
    accountBeginSignIn(email: string, purpose: SignInPurpose, offerId?: string, windowId?: string) {
      // The owner is recorded BEFORE the attempt starts, so a window that closes while the request is
      // still in flight is still recognised as the one that owns it.
      signInOwnerWindowId = windowId ?? null;
      return accountManager.beginEmailSignIn(email, purpose, offerId);
    },
    accountConfirmSignIn() {
      return accountManager.confirmEmailSignIn();
    },
    accountResendSignIn() {
      return accountManager.resendEmailSignIn();
    },
    accountCancelSignIn() {
      signInOwnerWindowId = null;
      accountManager.cancelEmailSignIn();
    },
    /**
     * The OWNING account panel has been closed — end its flow, and nobody else's (F09).
     *
     * Distinct from `accountCancelSignIn` because the two are different acts by different parties.
     * A cancel is a person pressing a button and is about whatever is on screen; this is a dialog
     * going away, and it must only end the flow that dialog STARTED. Every window renders the same
     * attempt, so closing a second window — or a panel that never began a sign-in — leaves the link
     * somebody may be about to open on their phone exactly where it was.
     *
     * The window id is the ownership key, the same one `removeWindowSlot` compares: only one account
     * panel exists per window, so its closing and the window's closing name the same owner.
     */
    accountReleaseSignInFlow(windowId?: string) {
      if (signInOwnerWindowId === null || windowId === undefined || signInOwnerWindowId !== windowId) return;
      // THE OWNERSHIP IS NOT CONSUMED WHEN A LINK IS STILL WAITING. It used to be cleared here
      // unconditionally, which was right while this call ended the flow: the flow was over, so there
      // was nothing left to own. Now that a waiting attempt survives the panel, clearing it would
      // mean the panel could be reopened and closed again without ever releasing the retention that
      // the eventual confirmation creates — the one thing F09 is for.
      if (accountManager.state().auth === undefined) signInOwnerWindowId = null;
      // `releaseSignInPanel` releases the retention and every in-flight operation, and KEEPS an
      // attempt that is still waiting for somebody to open its link. Reading the link means leaving
      // this dialog, so cancelling here made the flow unfinishable by doing what it asks.
      accountManager.releaseSignInPanel();
    },
    /**
     * The manual fallback. The link text reaches this ONE method and goes no further: it is not
     * broadcast, not persisted and not logged (see `logger.ts`'s redaction, which covers it in case
     * something else ever passes it on).
     */
    accountSubmitSignInLink(link: string) {
      accountManager.submitSignInLink(link);
    },
    accountChangeLoginEmail(email: string) {
      return accountManager.requestLoginEmailChange(email);
    },
    accountClearPendingEmailChange() {
      accountManager.clearPendingEmailChange();
    },
    accountEnrolInstallation(mode: "register" | "recover-uid", pairHints: string[]) {
      return accountManager.enrolThisInstallation(mode, pairHints);
    },
    accountStartTrial() {
      return accountManager.startTrial();
    },
    accountRefreshOverview() {
      return accountManager.refreshOverview();
    },
    /** Answers only whether it opened or is pending — never the URL it opened. */
    accountOpenCheckout(offerId: string) {
      return accountManager.openCheckout(offerId);
    },
    accountOpenBillingPortal() {
      return accountManager.openBillingPortal();
    },
    accountRevoke(kind: "installation" | "mobile-device" | "pair" | "account-wide", targetId?: string) {
      return accountManager.revoke(kind, targetId);
    },
    accountAcknowledgeNotice(noticeId: string) {
      return accountManager.acknowledgeNotice(noticeId);
    },
    accountSignOutInstallation(disconnect: boolean) {
      return accountManager.signOutInstallation({ disconnect });
    },
    accountDelete(confirmationPhrase: string) {
      return accountManager.deleteAccount(confirmationPhrase);
    },
    /** Opt-in. Answers with the reference to quote; the report itself never comes back. */
    accountSubmitDiagnostics(note?: string) {
      return accountManager.submitDiagnostics(note);
    },
    /**
     * The same document, for when the upload is not available: no account bound yet, no network, or
     * a refusal. The renderer saves it through the existing native save dialog.
     */
    accountExportDiagnostics(note?: string) {
      return accountManager.exportDiagnostics(note);
    },
    /** Called when the server's token-refresh marker moves: new token, then re-read the page. */
    accountClaimsChanged() {
      return accountManager.onClaimsChanged();
    },

    /**
     * Single-use WebView session ticket exchange (plan §9.2): called by
     * remote-server.ts's unauthenticated bootstrap route. Delegates to the
     * SAME store instance mobile-command-dispatch.ts issues tickets from —
     * see mobileWebSessionTicketStore above. Returns null on any failure
     * (unknown/expired ticket, wrong secret) without distinguishing why.
     */
    consumeMobileWebSessionTicket(
      ticketId: string,
      secret: string,
      context: { transport: "relay" | "legacy"; origins: readonly string[] },
    ) {
      // The context comes from the SERVER, not from the request: whichever remote-server instance is
      // asking knows which kind it is and which origins it answers on, and a ticket is redeemable only
      // at the one it was minted for (production hardening §5 "Ticket" 2-4).
      return mobileWebSessionTicketStore.consumeTicket(ticketId, secret, context);
    },

    /**
     * Managed-relay diagnostics: state, counters and the origin — never a grant, a cookie or a
     * payload.
     *
     * Read by the Settings UI and by the local MVP harness. Same shape whether a relay exists or
     * not, so a caller never has to know which kind of build it is talking to.
     */
    getMobileRelayStatus() {
      return {
        ...(mobileRelayManager?.status() ?? RELAY_OFF),
        stats: mobileRelayManager?.stats() ?? null,
      };
    },

    // --- Mobile integration handlers (plan §10.5) ---
    // Desktop-only IPC surface — remote-server.ts's sanitizeSettingsFromRemote/
    // sanitizeIntegrationsMobileFromRemote already block `settings.integrations.
    // mobile` writes from remote HTTP clients, and none of these methods are
    // routed through remote-server.ts at all. Mutating methods mirror the
    // Telegram handlers above: broadcastState() + return getPayload() so the
    // renderer picks up the fresh device list from
    // settings.integrations.mobile.devices without a separate round trip.

    /** Creates a pairing invitation (QR payload) — plan §5.2. Returned directly (not via getPayload): the invitation/secret is ephemeral and never persisted to state.json. */
    async createMobilePairingInvitation(options: { profileAllowlist: string[]; capabilities: string[] }) {
      return mobileManager.createInvitation(options);
    },

    async cancelMobilePairingInvitation() {
      await mobileManager.cancelInvitation();
    },

    listMobileDevices() {
      return mobileManager.listDevices();
    },

    async renameMobileDevice(deviceId: string, label: string) {
      await mobileManager.renameDevice(deviceId, label);
      broadcastState();
      return getPayload();
    },

    async revokeMobileDevice(deviceId: string) {
      await mobileManager.revokeDevice(deviceId);
      broadcastState();
      return getPayload();
    },

    /**
     * Removes a REVOKED device from the local list. Housekeeping, not a security action.
     *
     * Returns the outcome alongside the payload, like `approveMobileDevice` does and unlike
     * `revokeMobileDevice`: this one can legitimately refuse (an active device, or one whose cloud
     * revocation is still owed), and the dialog has to be able to say which.
     */
    async forgetMobileDevice(deviceId: string) {
      const outcome = await mobileManager.removeRevokedDevice(deviceId);
      broadcastState();
      return { ...outcome, payload: getPayload() };
    },

    /**
     * The human compared the pairing codes and they match (review 3 §P0.1).
     *
     * Returns the outcome AND the fresh payload, because both matter to the caller: the dialog has to
     * know whether the activation actually landed (the cloud can refuse, or be unreachable, and the
     * device then stays inert in `userApproved`), and the device list has to re-render.
     */
    async approveMobileDevice(deviceId: string) {
      const outcome = await mobileManager.approveDevice(deviceId);
      broadcastState();
      return { ...outcome, payload: getPayload() };
    },

    /** The human said the codes do not match, or dismissed the dialog. Runs the full revocation. */
    async rejectMobileDevice(deviceId: string, reason: PairingRejectionReason) {
      await mobileManager.rejectDevice(deviceId, reason);
      broadcastState();
      return getPayload();
    },

    /**
     * Devices waiting for that decision, each with the pairing code recomputed from the transcript.
     *
     * Recomputed rather than remembered: the code is never persisted (it is derived from both public
     * keys, both device ids, the pair and the invitation), so a desktop that restarted mid-approval can
     * still show the same value — which is what makes review 3 §P0.1's restart case recoverable instead
     * of a pairing nobody can finish or reject.
     */
    listMobileDevicesAwaitingApproval() {
      return mobileManager.listDevicesAwaitingApproval().map((device: MobileDeviceRecord) => ({
        deviceId: device.deviceId,
        label: device.label,
        fingerprint: device.fingerprint,
        state: device.state,
        sas: mobileManager.sasForPendingDevice(device.deviceId),
      }));
    },

    async updateMobileDeviceAllowlist(
      deviceId: string,
      update: { capabilities?: string[]; profileAllowlist?: string[]; excludedProfileIds?: string[] },
    ) {
      await mobileManager.updateDeviceAllowlist(deviceId, update);
      broadcastState();
      return getPayload();
    },

    /** Toggles the whole mobile feature — mirrors reconfigureMobile()'s existing settings:update reactivity, exposed as its own dedicated action (plan §10.5) rather than requiring a full settings payload. */
    async setMobileEnabled(enabled: boolean) {
      await store.mutate("mobile:enabled", (draft: AppState) => {
        draft.settings.integrations.mobile.enabled = enabled;
      });
      await reconfigureMobile(getState());
      broadcastState();
      return getPayload();
    },

    /**
     * Turns the managed relay on or off — the second, independent decision (relay plan §10).
     *
     * Its own action rather than a `settings:update`, for the same reason `setMobileEnabled` is: the
     * flag has a RUNTIME consequence (a connector, an outbound socket and a loopback origin start or
     * stop) that a generic settings write would leave to whoever remembered to call
     * `reconfigureMobile`. It goes through that same reconfigure, so the relay is running exactly
     * when both flags say it should be.
     *
     * Until this existed the flag was reachable only by hand-editing state.json, while
     * `docs/RELAY-MVP.md` §3 told the user to "turn the managed relay on in Settings → Mobile" — a
     * feature with no way in (dev-environment finding 6).
     */
    async setMobileRelayEnabled(enabled: boolean) {
      await store.mutate("mobile:relay:enabled", (draft: AppState) => {
        draft.settings.integrations.mobile.relay.enabled = enabled;
      });
      await reconfigureMobile(getState());
      broadcastState();
      return getPayload();
    },

    /** Status snapshot + best-effort reconnect attempt (plan §10.5 "refresh connection health"). Not wrapped in getPayload(): connection health/quota are runtime-only, never persisted. */
    async refreshMobileConnectionHealth() {
      const health = await mobileManager.refreshConnectionHealth();
      return { health, quota: mobileManager.getQuotaSnapshot() };
    },

    /** Same outbox path a real push uses, visibly flagged as a test, counted against the same quota (plan §10.5). */
    async sendMobileTestPush(deviceId: string) {
      return mobileManager.sendTestPush(deviceId);
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryMobileAuditLog(filters: any = {}) {
      return mobileManager.queryAuditLog(filters);
    },

    /** Test hook: dispatch a Telegram command and await its full handling. */
    _dispatchTelegramCommandForTest(cmd: unknown): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return dispatchTelegramCommand(cmd as any);
    },

    /** Test hook: the internal Telegram manager (for spying on prompts). */
    _telegramManagerForTest() {
      return telegramManager;
    },

    /** Test hook: the internal Mobile manager (for spying on event routing). */
    _mobileManagerForTest() {
      return mobileManager;
    },

    /**
     * Test hook: the shared transport-neutral notification event source
     * (plan §10.1) — lets a test attach an additional listener to prove
     * adding a second (Mobile) subscriber doesn't duplicate/alter what
     * Telegram's own forwardAlert() receives.
     */
    _externalNotificationEventsForTest() {
      return externalNotificationEvents;
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateProfileForRemoteClient(clientId: string, profileId: any): Promise<unknown> {
      const registry = requireRemoteClientRegistry(clientId);
      // The remote client is an independent viewer — switching its profile
      // mutates only its own context; desktop windows are untouched. Any
      // EXISTING profile is valid, even one with no desktop window.
      registry.activateProfile(clientId, profileId, getState());
      // Spawn PTYs for the workspace the client landed on so the remote UI
      // paints live terminals instead of "0 running".
      const restoredWorkspaceId = registry.get(clientId)?.activeWorkspaceId || "";
      if (restoredWorkspaceId) ensureVisibleSession(restoredWorkspaceId);
      broadcastState();
      return registry.composePayload(clientId, getPayload());
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateWorkspaceForRemoteClient(clientId: string, workspaceId: any): Promise<unknown> {
      const registry = requireRemoteClientRegistry(clientId);
      // Throws on an unknown/cross-profile workspace.
      registry.activateWorkspace(clientId, workspaceId, getState());
      if (workspaceId) {
        // No `lastWorkedAt` stamp: activation is navigation, not work.
        ensureVisibleSession(String(workspaceId));
      }
      broadcastState();
      return registry.composePayload(clientId, getPayload());
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateSessionForRemoteClient(clientId: string, workspaceId: any, sessionId: any): Promise<unknown> {
      const registry = requireRemoteClientRegistry(clientId);
      registry.activateSession(clientId, workspaceId, sessionId, getState());
      if (sessionId) {
        // No `lastWorkedAt` stamp: opening a tab is navigation, not work.
        ensureSessionSafe(String(sessionId));
      }
      broadcastState();
      return registry.composePayload(clientId, getPayload());
    },

    composeStatePayloadForRemoteClient(clientId: string): unknown {
      return registryOwning(clientId)?.composePayload(clientId, getPayload()) ?? getPayload();
    },
    /**
     * Agent-notify HTTP hook status. Previously surfaced as
     * `payload.agentNotifyHook`, which no renderer consumed — dropped from the
     * broadcast to save bytes. Kept as an explicit accessor so the notify-server
     * lifecycle stays observable (used by tests and any future diagnostics).
     */
    getNotifyServerInfo(): { enabled: boolean; port: number | null } {
      return { enabled: notifyServerHandle != null, port: notifyServerHandle?.port || null };
    },
    async getInitialState() {
      try {
        // Spawn PTYs first so the renderer can paint live terminals while the
        // heavier refreshes (docker, git, worktrees) run. Without this, the
        // panes sit empty for the seconds it takes those refreshes to finish
        // — or forever if one of them hangs (network, broken git repo).
        ensureVisibleSession();
        // Return the current core IMMEDIATELY (plan §11 / Phase 4): a bootstrap
        // or reconnect must not block on git/docker/worktree refreshes. Fire
        // them in the background — git and docker emit "updated" → broadcastState
        // on their own, and we broadcast once more after worktrees settle — so
        // the client receives the fresher revisions as WS deltas / resource
        // invalidations rather than waiting for them here.
        const activeWorkspaceId = getState().activeWorkspaceId;
        void (async () => {
          try {
            if (findWorkspace(getState(), activeWorkspaceId)?.kind === "docker") {
              await refreshDocker();
            }
            await refreshGit(activeWorkspaceId);
            await syncWorktrees();
            broadcastState();
          } catch (err) {
            log.warn("getInitialState: background refresh failed", { err: (err as Error)?.message });
          }
        })();
        const payload = getPayload();
        log.info("initial state ready (core immediate, refreshes async)", {
          workspaceCount: payload.appState?.workspaces?.length ?? 0,
        });
        return payload;
      } catch (error) {
        log.error("getInitialState failed", { err: (error as Error).message });
        throw error;
      }
    },
    // Exposed for tests and explicit maintenance flows. Removes workspaces
    // whose cwd no longer exists on disk and rewires per-window activeWorkspaceId
    // to a sibling in the same profile.
    async pruneOrphanedWorkspaces(): Promise<number> {
      return pruneOrphanedWorkspaces();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateWorkspace(workspaceId: any, windowId?: string) {
      // Refuse cross-profile activation. The IPC layer prefers
      // activateWorkspaceInWindow when a windowId resolves; this legacy
      // path is reached by remote /api/workspace/activate and a few
      // internal code paths. Without the guard, a remote bound to
      // profile B can activate a profile-A workspace globally and the
      // primary slot also flips.
      assertWorkspaceInViewerProfile(String(workspaceId), windowId);
      const remoteCallerSessionId = parseRemoteViewerId(windowId);
      await store.mutate((draft: AppState) => {
        if (draft.workspaces.some((workspace) => workspace.id === workspaceId)) {
          draft.activeWorkspaceId = workspaceId;
          // Also update the first window slot (primary window compat) — but
          // never for remote viewers: a remote activation must not flip any
          // desktop window's view.
          if (!remoteCallerSessionId) {
            const firstSlot = (draft.windowSlots || [])[0];
            if (firstSlot) firstSlot.activeWorkspaceId = workspaceId;
          }
        }
      });
      // Remote viewer: the activation lands on the caller's own context.
      if (remoteCallerSessionId) mirrorRemoteViewerWorkspace(windowId, String(workspaceId));
      // Proactively update visible sessions BEFORE starting terminals,
      // so terminal startup output doesn't trigger false alerts
      const workspace = findWorkspace(getState(), workspaceId);
      if (workspace) {
        updateVisibleSessions(
          workspace.kind === "azure" || workspace.kind === "github"
            ? []
            : // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: panel type is widened in this workspace variant
              workspace.panels.map((panel: any) => createSessionId(workspaceId, panel.id)),
          windowId,
        );
      }
      ensureVisibleSession(workspaceId);
      ensureDockerPolling();
      // Kick off refreshes BEFORE broadcastState so refresh() is already called
      // when the first state:updated event fires (stale-data ordering guarantee).
      if (workspace?.kind === "docker") {
        refreshDocker().catch((err: unknown) => {
          log.warn("activateWorkspace: docker refresh failed", { err: (err as Error)?.message });
        });
      }
      refreshGit(workspaceId).catch((err: unknown) => {
        log.warn("activateWorkspace: git refresh failed", { err: (err as Error)?.message });
      });
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateProject(projectId: any, windowId?: string) {
      return this.activateWorkspace(projectId, windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateSession(sessionId: any) {
      const descriptor = parseSessionId(sessionId);
      if (!descriptor) {
        return getPayload();
      }

      await store.mutate((draft: AppState) => {
        const workspace = findWorkspace(draft, descriptor.workspaceId);
        if (!workspace) {
          return;
        }

        draft.activeWorkspaceId = descriptor.workspaceId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((workspace as any).panels?.some((panel: any) => panel.id === descriptor.panelId)) {
          workspace.activePanelId = descriptor.panelId;
          workspace.activeViewId = sessionId;
        }
      });

      ensureSessionSafe(sessionId);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async setWorkspaceUIState(workspaceId: any, uiState: any, windowId?: string) {
      if (!workspaceId || !uiState || typeof uiState !== "object") {
        return getPayload();
      }
      // Cross-profile guard: UI state mutations target a specific workspace
      // and must not be honoured from a window bound to another profile.
      assertWorkspaceInViewerProfile(String(workspaceId), windowId);
      const { activeViewId, splitLayout, splitViewIds, activeRootPath } = uiState;
      let changed = false;
      await store.mutate((draft: AppState) => {
        const workspace = findWorkspace(draft, workspaceId);
        if (!workspace) return;
        if (typeof activeViewId === "string") {
          workspace.activeViewId = activeViewId;
          const sessionPrefix = `${workspaceId}:`;
          if (activeViewId.startsWith(sessionPrefix)) {
            const panelId = activeViewId.slice(sessionPrefix.length);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((workspace as any).panels?.some((panel: any) => panel.id === panelId)) {
              workspace.activePanelId = panelId;
            }
          }
          changed = true;
        }
        if (splitLayout === null || typeof splitLayout === "string") {
          workspace.splitLayout = splitLayout || null;
          workspace.splitViewIds = Array.isArray(splitViewIds) ? [...splitViewIds] : [];
          changed = true;
        }
        if (typeof activeRootPath === "string") {
          workspace.activeRootPath = activeRootPath;
          changed = true;
        }
      });
      if (changed) broadcastState();
      return getPayload();
    },
    // enableWorkspaceGrid/disableWorkspaceGrid/setGridLayout/setGridCell/
    // swapGridCells provided by gridHandlers (spread above)

    // --- Per-window activation methods ---

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateWorkspaceInWindow(workspaceId: any, windowId: string) {
      const preState = getState();
      const preSlot = (preState.windowSlots || []).find((s) => s.id === windowId);
      const targetWs = preState.workspaces.find((ws) => ws.id === workspaceId);
      const isCrossProfile = !!(targetWs && preSlot) && (targetWs.profileId || "default") !== preSlot.profileId;
      log.debug("activateWorkspaceInWindow: entry", {
        workspaceId,
        windowId,
        targetWsKind: targetWs?.kind || null,
        targetWsProfileId: targetWs?.profileId || null,
        slotProfileId: preSlot?.profileId || null,
        slotPrevActiveWsId: preSlot?.activeWorkspaceId || null,
        crossProfile: isCrossProfile,
      });
      // Refuse cross-profile activation. The whole purpose of the per-window
      // API is to switch the slot — if the workspace lives in another profile,
      // honouring the request would silently push a foreign-profile workspace
      // into the calling slot. Remote callers can hit this with a crafted /
      // stale workspaceId; the guard converts a silent corruption into an
      // explicit error the caller can catch (see createTaskWorkspace below).
      if (isCrossProfile) {
        throw new Error(
          `Workspace ${workspaceId} (profile ${targetWs?.profileId || "default"}) does not belong to window ${windowId}'s profile (${preSlot?.profileId || "default"}).`,
        );
      }
      await store.mutate((draft: AppState) => {
        const targetWorkspace = draft.workspaces.find((ws) => ws.id === workspaceId);
        if (!targetWorkspace) return;
        // Update per-window slot
        const slot = (draft.windowSlots || []).find((s) => s.id === windowId);
        if (slot) {
          slot.activeWorkspaceId = workspaceId;
          if (slot.activeSessionId && !slot.activeSessionId.startsWith(`${workspaceId}:`)) {
            slot.activeSessionId = "";
          }
          // Mirror to the owning profile so switching back restores this workspace.
          const profile = draft.profiles.find((p) => p.id === slot.profileId);
          if (profile) {
            profile.lastActiveWorkspaceId = workspaceId;
            if (profile.lastActiveSessionId && !profile.lastActiveSessionId.startsWith(`${workspaceId}:`)) {
              profile.lastActiveSessionId = undefined;
            }
          }
        }
        // ALSO mirror to global activeWorkspaceId. `getPayload()` builds the
        // `payload.workspace` snapshot from `sessions.getWorkspace(state)`,
        // which defaults to `state.activeWorkspaceId`. Without this mirror the
        // main pane (and any consumer reading the global field) stays on the
        // previously-active workspace even though slot.activeWorkspaceId moved
        // — the user clicks a card, the slot updates, but the renderer's
        // payload.workspace is still the old one, so nothing visually changes.
        // In multi-window setups this makes the global "track last-activated";
        // each window still drives its own pane via slot.activeWorkspaceId.
        draft.activeWorkspaceId = workspaceId;
      });
      const workspace = findWorkspace(getState(), workspaceId);
      if (workspace) {
        updateVisibleSessions(
          workspace.kind === "azure" || workspace.kind === "github"
            ? []
            : // eslint-disable-next-line @typescript-eslint/no-explicit-any
              workspace.panels.map((panel: any) => createSessionId(workspaceId, panel.id)),
          windowId,
        );
      }
      ensureVisibleSession(workspaceId);
      ensureDockerPolling();
      // Kick off refreshes BEFORE broadcastState so refresh() is already called
      // when the first state:updated event fires (stale-data ordering guarantee).
      if (workspace?.kind === "docker") {
        refreshDocker().catch((err: unknown) => {
          log.warn("activateWorkspaceInWindow: docker refresh failed", { err: (err as Error)?.message });
        });
      }
      refreshGit(workspaceId).catch((err: unknown) => {
        log.warn("activateWorkspaceInWindow: git refresh failed", { err: (err as Error)?.message });
      });
      broadcastState();
      return getPayload();
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateSessionInWindow(sessionId: any, windowId: string) {
      const descriptor = parseSessionId(sessionId);
      if (!descriptor) return getPayload();
      // Cross-profile refuse: the session belongs to a workspace, which has
      // a profile. A remote/IPC caller binding window B must not be able to
      // point slot-B at a session whose workspace lives in profile A.
      assertWorkspaceInViewerProfile(descriptor.workspaceId, windowId);
      await store.mutate((draft: AppState) => {
        const workspace = findWorkspace(draft, descriptor.workspaceId);
        if (!workspace) return;
        const slot = (draft.windowSlots || []).find((s) => s.id === windowId);
        if (slot) {
          slot.activeWorkspaceId = descriptor.workspaceId;
          slot.activeSessionId = sessionId;
          // Mirror to the owning profile so switching back restores this session.
          const profile = draft.profiles.find((p) => p.id === slot.profileId);
          if (profile) {
            profile.lastActiveWorkspaceId = descriptor.workspaceId;
            profile.lastActiveSessionId = sessionId;
          }
        } else {
          draft.activeWorkspaceId = descriptor.workspaceId;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((workspace as any).panels?.some((panel: any) => panel.id === descriptor.panelId)) {
          workspace.activePanelId = descriptor.panelId;
          workspace.activeViewId = sessionId;
        }
      });
      // Remote viewer: the session activation lands on the caller's own
      // context — no desktop slot exists for a remote viewer id.
      const remoteSessionViewerId = parseRemoteViewerId(windowId);
      const remoteViewerRegistry = registryOwning(remoteSessionViewerId);
      if (remoteSessionViewerId && remoteViewerRegistry) {
        try {
          remoteViewerRegistry.activateSession(remoteSessionViewerId, descriptor.workspaceId, sessionId, getState());
        } catch {
          // Cross-profile or stale client — already guarded above; skip.
        }
      }
      ensureSessionSafe(sessionId);
      broadcastState();
      return getPayload();
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateProfileInWindow(profileId: any, windowId: string) {
      // No exclusivity: any number of windows may show the same profile.
      // Switching only retargets THIS window's slot; other windows keep
      // their own view state.
      await store.mutate((draft: AppState) => {
        const targetProfile = draft.profiles.find((p) => p.id === profileId);
        if (!targetProfile) return;
        const slot = (draft.windowSlots || []).find((s) => s.id === windowId);

        // Save current profile's view state before switching away. The
        // profile fields are a legacy mirror of the last deactivation — they
        // seed the default view when a viewer opens the profile next.
        if (slot) {
          const currentProfile = draft.profiles.find((p) => p.id === slot.profileId);
          if (currentProfile) {
            currentProfile.lastActiveWorkspaceId = slot.activeWorkspaceId || undefined;
            currentProfile.lastActiveSessionId = slot.activeSessionId || undefined;
            if (slot.workspaceGrid !== undefined) {
              currentProfile.workspaceGrid = slot.workspaceGrid;
            }
          }
        }

        // Resolve the target profile's restore candidate.
        const restoreTarget = resolveProfileRestoreTarget(draft, profileId);

        if (slot) {
          slot.profileId = profileId;
          slot.activeWorkspaceId = restoreTarget.workspaceId;
          slot.activeSessionId = restoreTarget.sessionId;
          // Seed this window's grid from the profile's legacy/default grid —
          // re-validated against the new profile so no foreign cells survive.
          slot.workspaceGrid = targetProfile.workspaceGrid
            ? normalizeWorkspaceGrid(targetProfile.workspaceGrid, draft.workspaces, profileId)
            : null;
        }
        // Legacy mirror of the last activation — viewers read their own slot.
        draft.activeWorkspaceId = restoreTarget.workspaceId;
      });
      // PTY spawn must not wait on FS/network refreshes — otherwise the new
      // profile's active workspace sits at "0 running" while syncWorktrees
      // scans disks and Azure does network. Spawn first, then refresh.
      sessions.syncWithState(getState());
      ensureVisibleSession();
      broadcastState();
      syncWorktrees().catch((err: unknown) => {
        log.warn("activateProfileInWindow: syncWorktrees failed", { err: (err as Error)?.message });
      });
      refreshAzure()
        .catch((err: unknown) => {
          log.warn("activateProfileInWindow: refreshAzure failed", { err: (err as Error)?.message });
        })
        .finally(() => broadcastState());
      scheduleAzurePolling();
      return getPayload();
    },

    // --- Window slot management ---

    async createWindowSlot(
      profileId: string,
      options?: { cloneFromWindowId?: string },
    ): Promise<{ id: string; profileId: string; bounds: { x: number; y: number; width: number; height: number } }> {
      const newId = randomUUID();
      // Cascade offset new windows so they don't stack exactly on top of
      // existing ones. Step of 32px is enough to expose the title bar of the
      // window underneath without pushing the new window off-screen for
      // typical 6-slot scenarios. resolveSafeBounds (main.ts) will clamp /
      // re-center if the cascade walks past the work area.
      const existingCount = (getState().windowSlots || []).length;
      const baseX = 100;
      const baseY = 100;
      const step = 32;
      const defaultBounds = {
        x: baseX + existingCount * step,
        y: baseY + existingCount * step,
        width: 1280,
        height: 800,
      };
      // "Duplicate current window": when the source window shows the same
      // profile, the new window starts on the same workspace/session/grid.
      // The clone is a one-time copy — afterwards the two windows are
      // independent viewers.
      const cloneSource = options?.cloneFromWindowId
        ? (getState().windowSlots || []).find((s) => s.id === options.cloneFromWindowId && s.profileId === profileId)
        : undefined;
      const restoreTarget = cloneSource
        ? { workspaceId: cloneSource.activeWorkspaceId || "", sessionId: cloneSource.activeSessionId || "" }
        : resolveProfileRestoreTarget(getState(), profileId);
      const newActiveWorkspaceId = restoreTarget.workspaceId;
      await store.mutate((draft: AppState) => {
        if (!Array.isArray(draft.windowSlots)) draft.windowSlots = [];
        const profile = draft.profiles.find((p) => p.id === profileId);
        const seedGrid = cloneSource ? cloneSource.workspaceGrid : profile?.workspaceGrid;
        draft.windowSlots.push({
          id: newId,
          profileId,
          activeWorkspaceId: newActiveWorkspaceId,
          activeSessionId: restoreTarget.sessionId,
          workspaceGrid: seedGrid ? normalizeWorkspaceGrid(seedGrid, draft.workspaces, profileId) : null,
          bounds: { ...defaultBounds },
          lastFocusedAt: Date.now(),
        });
      });
      // Spawn PTYs for the new window's active workspace. Without this the
      // freshly opened window paints terminal panes with "0 running" — the
      // backend has no clue it needs to start anything, because nothing in
      // the per-window flow calls ensureSession until the user navigates a
      // workspace tab. (activeWorkspaceId at the global level may belong to
      // a different window's profile, so the implicit-default path is
      // wrong here.)
      if (newActiveWorkspaceId) {
        ensureVisibleSession(newActiveWorkspaceId);
      }
      broadcastState();
      return { id: newId, profileId, bounds: defaultBounds };
    },

    async removeWindowSlot(windowId: string) {
      // The window that started the sign-in is closing, so the person who started it is gone. Any
      // OTHER window closing leaves the attempt alone — the link may be open on a phone right now.
      if (signInOwnerWindowId !== null && signInOwnerWindowId === windowId) {
        signInOwnerWindowId = null;
        accountManager.cancelEmailSignIn();
      }
      await store.mutate((draft: AppState) => {
        if (!Array.isArray(draft.windowSlots)) return;
        const closing = draft.windowSlots.find((s) => s.id === windowId);
        // Mirror the closing window's view into the profile's legacy/default
        // fields so reopening the profile later restores where the user left
        // off — the slot (and its viewer-owned grid) is gone after this.
        if (closing) {
          const profile = draft.profiles.find((p) => p.id === closing.profileId);
          if (profile) {
            profile.lastActiveWorkspaceId = closing.activeWorkspaceId || undefined;
            profile.lastActiveSessionId = closing.activeSessionId || undefined;
            if (closing.workspaceGrid !== undefined) {
              profile.workspaceGrid = closing.workspaceGrid;
            }
          }
        }
        draft.windowSlots = draft.windowSlots.filter((s) => s.id !== windowId);
      });
      // The window is gone — drop its visible-session contribution so its
      // panels stop counting as visible (otherwise their alerts stay suppressed).
      dropViewerVisibility(windowId);
      // The closing window may have been the only one showing a docker
      // workspace; without this the poll would keep spawning probes for a view
      // that no longer exists.
      ensureDockerPolling();
      broadcastState();
    },

    async updateWindowSlotBounds(
      windowId: string,
      bounds: { x: number; y: number; width: number; height: number },
      displayId?: number,
    ) {
      await store.mutate((draft: AppState) => {
        const slot = (draft.windowSlots || []).find((s) => s.id === windowId);
        if (slot) {
          slot.bounds = bounds;
          if (displayId !== undefined) slot.displayId = displayId;
        }
      });
      // No broadcast needed for bounds update (not UI-visible)
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveWorkspace(workspace: any, windowId?: string) {
      log.debug("saveWorkspace: called", {
        workspaceId: workspace?.id,
        name: workspace?.name,
        kind: workspace?.kind,
        incomingProfileId: workspace?.profileId || null,
        callerProfileId: getWindowProfileId(windowId) || null,
        stateProfileIds: (getState().profiles || []).map((p) => p.id),
      });

      // Cross-profile validation. saveWorkspace covers two paths:
      // (1) edit existing — the workspace must already live in the caller
      //     window's profile, AND the incoming profileId must match (no
      //     stealth "move to another profile" via this endpoint);
      // (2) create new — the incoming profileId must match the caller's
      //     profile (no creating in someone else's profile).
      const slotProfileId = getWindowProfileId(windowId);
      if (slotProfileId) {
        const incomingProfileId = workspace?.profileId || "default";
        if (workspace?.id) {
          assertWorkspaceInViewerProfile(workspace.id, windowId);
        }
        if (incomingProfileId !== slotProfileId) {
          throw new Error(
            `Cross-profile refused: saveWorkspace payload targets profile ${incomingProfileId}, window ${windowId} is bound to ${slotProfileId}.`,
          );
        }
      }

      // A panel that disappears from workspace.panels gets its live session
      // torn down by sessions.syncWithState below. If that panel is the
      // Primary of an active attached companion task, closing/removing it
      // would silently orphan the loop — refuse the same way deleteWorkspace
      // does for the whole workspace.
      const priorWorkspace = workspace?.id ? findWorkspace(getState(), workspace.id) : null;
      const orphanedCompanionIds: string[] = [];
      if (Array.isArray(priorWorkspace?.panels) && Array.isArray(workspace?.panels)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nextPanelIds = new Set(workspace.panels.map((p: any) => p.id));
        const priorPanels = priorWorkspace!.panels as Array<{ id: string }>;
        const removedPanelIds = priorPanels.map((p) => p.id).filter((id: string) => !nextPanelIds.has(id));
        for (const removedPanelId of removedPanelIds) {
          const activeCompanionSource = findActiveCompanionSource(getState(), workspace.id, removedPanelId);
          if (activeCompanionSource) {
            const roleLabel =
              COMPANION_ROLE_DISPLAY_NAMES[
                activeCompanionSource.task.companionRole as keyof typeof COMPANION_ROLE_DISPLAY_NAMES
              ] || "Companion";
            throw new Error(
              `Cannot close this tab: its Primary conversation is currently shown in the ${roleLabel} loop "${formatWorkspaceDisplayName(activeCompanionSource)}". Finish or delete that companion task first.`,
            );
          }
          // Inactive companion loops don't block the close, but they do lose
          // their Primary — collected now, flagged after the save lands.
          for (const ws of findAttachedCompanionsFor(getState(), workspace.id, removedPanelId)) {
            orphanedCompanionIds.push(ws.id);
          }
        }
      }

      // Ensure the working directory exists (create if needed)
      if (workspace.cwd && workspace.kind !== "docker") {
        await mkdir(workspace.cwd, { recursive: true }).catch(() => {});
      }

      // Panel removal is what a closed tab actually is, and this is the only
      // authoritative place it happens. Read from the pre-mutation snapshot the
      // companion guard above already took, and compared against committed
      // state afterwards — so any refusal that throws before the commit emits
      // nothing and the renderer keeps its history.
      const savedWorkspaceId = String(workspace.id || "");
      const priorPanelIds = ((priorWorkspace?.panels as Array<{ id: string }> | undefined) || []).map(
        (panel) => panel.id,
      );

      await store.mutate((draft: AppState) => {
        const normalized = normalizeWorkspace(workspace);
        log.debug("saveWorkspace: normalized", {
          workspaceId: normalized.id,
          normalizedProfileId: normalized.profileId,
          incomingProfileId: workspace.profileId || null,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const index = draft.workspaces.findIndex((item: any) => item.id === normalized.id);
        if (index >= 0) {
          // Editing a workspace is not work — and `lastWorkedAt` is a
          // BACKEND-OWNED field on an existing workspace, so the incoming
          // value is discarded entirely rather than merely used as a fallback.
          // A long-open editor round-trips whatever stamp it loaded, and an
          // older-but-truthy value used to overwrite newer work (V3 review,
          // §4 P2). No client has a legitimate reason to move this timestamp.
          const priorWorkedAt = draft.workspaces[index]?.lastWorkedAt;
          if (priorWorkedAt) normalized.lastWorkedAt = priorWorkedAt;
          else delete normalized.lastWorkedAt;
          draft.workspaces[index] = normalized;
        } else {
          insertWorkspace(draft.workspaces, normalized, getViewerActiveWorkspaceId(windowId));
          // Creating a workspace IS work (V2 plan allowlist).
          markWorkspaceWorked(draft, normalized.id);
        }

        if (!draft.activeWorkspaceId) {
          draft.activeWorkspaceId = normalized.id;
        }
      });

      if (priorPanelIds.length > 0) {
        const committed = findWorkspace(getState(), savedWorkspaceId) as WorkspaceState | null;
        const survivingPanelIds = new Set((committed?.panels || []).map((panel) => panel.id));
        for (const panelId of priorPanelIds) {
          if (survivingPanelIds.has(panelId)) continue;
          emitNotificationTargetRemoved({
            target: "view",
            workspaceId: savedWorkspaceId,
            // Same helper session ids are built with everywhere else, and the
            // same value notification capture stamps on a thread's viewId.
            viewId: createSessionId(savedWorkspaceId, panelId),
            profileId: committed?.profileId || "default",
          });
        }
      }

      // Losing the review marker also has to release the PR's tracked review
      // workspace. The inbox row resolves its target through that tracked id as
      // a fallback (azure-devops-pr-summary.ts / github-pr-summary.ts), and the
      // poll re-persists it as `summary.reviewWorkspaceId || tracked...`, so a
      // marker-only detach leaves the row offering "Open" on a workspace that is
      // no longer attached — and blocks a fresh review workspace for that PR.
      // Same cleanup the post-merge auto-detach does in
      // runtime-provider-lifecycle.ts; every manual detach path (sidebar menu,
      // Git tab, workspace editor, remote client) lands here.
      const priorReviewPrKey = String(priorWorkspace?.review?.prKey || "");
      const nextReviewPrKey = String(workspace?.review?.prKey || "");
      if (priorReviewPrKey && priorReviewPrKey !== nextReviewPrKey) {
        const tracked = azureReviewStore.getTrackedPullRequest(priorReviewPrKey);
        // Only release a link that still points at THIS workspace — the PR may
        // already have been re-attached elsewhere.
        if (String(tracked?.reviewWorkspaceId || "") === savedWorkspaceId) {
          try {
            await azureReviewStore.upsertTrackedPullRequest(priorReviewPrKey, { reviewWorkspaceId: "" });
            log.info("saveWorkspace: released the tracked review workspace after a detach", {
              workspaceId: savedWorkspaceId,
              prKey: priorReviewPrKey,
            });
          } catch (error) {
            log.warn("saveWorkspace: could not release the tracked review workspace", {
              prKey: priorReviewPrKey,
              err: (error as Error)?.message,
            });
          }
          // refreshAzure() already runs at the end of this handler; GitHub needs
          // its own nudge so the inbox row recomputes without waiting for the
          // next poll.
          if (priorWorkspace?.review?.provider === "github") {
            refreshGitHub().catch((err: unknown) => {
              log.warn("saveWorkspace: refreshGitHub failed", { err: (err as Error)?.message });
            });
          }
        }
      }

      for (const companionId of orphanedCompanionIds) {
        taskRunner.markAttachedSourceMissing(companionId);
      }

      sessions.syncWithState(getState());
      syncSessionSignalsWithState();
      await refreshGit(workspace.id || null);
      // Spawn default-startup panels for the workspace the CALLER is looking at,
      // not the global `activeWorkspaceId`. A remote/mobile viewer sits on its
      // own workspace; adding a tab there used to ensure sessions in whatever
      // the desktop had open, so the new panel never got a PTY and the pane
      // stayed black until the user switched tabs (which routes through
      // activateSession → ensureSessionSafe). Falls back to the global id when
      // no viewer is supplied (in-process/legacy callers), so desktop behaviour
      // is unchanged.
      ensureVisibleSession(getViewerActiveWorkspaceId(windowId) || undefined);
      broadcastState();
      syncTreeDirWatchers(); // 6b: keep watcher set consistent after workspace add/edit
      refreshAzure().catch((err: unknown) => {
        log.warn("saveWorkspace: refreshAzure failed", { err: (err as Error)?.message });
      });
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveProject(project: any, windowId?: string) {
      return this.saveWorkspace(project, windowId);
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async deleteWorkspace(workspaceId: any, options: any = {}, windowId?: string) {
      const state = getState();
      const workspace = findWorkspace(state, workspaceId);
      const deletedScratchpadId = (state.scratchpads || []).some((item) => item.workspaceId === String(workspaceId))
        ? String(workspaceId)
        : "";
      // Cross-profile delete is data loss in another profile. Refuse it.
      assertWorkspaceInViewerProfile(String(workspaceId), windowId);

      const activeCompanionSource = findActiveCompanionSource(state, String(workspaceId));
      if (activeCompanionSource) {
        const roleLabel =
          COMPANION_ROLE_DISPLAY_NAMES[
            activeCompanionSource.task.companionRole as keyof typeof COMPANION_ROLE_DISPLAY_NAMES
          ] || "Companion";
        throw new Error(
          `Cannot delete: the Primary conversation is currently shown in the ${roleLabel} loop "${formatWorkspaceDisplayName(activeCompanionSource)}". Finish or delete that companion task first.`,
        );
      }
      // Inactive companion loops attached to this workspace are allowed to
      // outlive it, but must be told their Primary is gone — captured before
      // the deletion mutate, flagged after it.
      const orphanedCompanionIds = findAttachedCompanionsFor(state, String(workspaceId)).map((ws) => ws.id as string);

      // For task workspaces, mark (profile, cwd) as "being deleted" so a
      // parallel createTaskWorkspace in the SAME profile over the same
      // directory refuses with a clear "previous task still cleaning up"
      // message instead of racing into a half-broken duplicate. The flag is
      // held in a finally block all the way through sessions.removeWorkspaceSessions
      // — releasing it earlier would leak file handles to a fresh task agent
      // because the old worker/judge PTY processes outlive store.mutate.
      const taskProfileId = workspace?.kind === "task" ? workspace.profileId || "default" : "";
      const pendingKey =
        workspace?.kind === "task" && workspace.cwd
          ? pendingTaskKey(taskProfileId, normalizeTaskCwd(workspace.cwd))
          : "";
      if (pendingKey) pendingTaskWorkspaceDeletions.add(pendingKey);

      // Krok 5: remember the task-file target now — after store.mutate the
      // workspace is gone from state, but this local ref survives. cleanupTaskFiles
      // is deferred to the finally block, run only AFTER the worker/judge PTYs
      // have exited, so we don't race the still-running agent (re-created files /
      // EBUSY on Windows).
      const taskCleanup =
        workspace?.kind === "task" && workspace.task?.taskId && workspace.cwd
          ? { cwd: workspace.cwd, taskId: workspace.task.taskId }
          : null;

      // Holds the session-removal promise across the try/finally. For task
      // workspaces, the finally awaits it before releasing the pending flag,
      // so the cwd stays locked until OS-level file handles are released.
      let sessionsExited: Promise<void> | null = null;

      try {
        // stopTask is synchronous (just flips state) and stays before mutate. A
        // throw here used to skip store.mutate entirely, leaving the workspace
        // stuck in state with no way to remove it short of restarting the app —
        // and blocking every future task workspace at the same cwd. Catch and
        // log so state is always cleared.
        if (taskCleanup) {
          try {
            taskRunner.stopTask(workspaceId);
          } catch (err) {
            log.warn("deleteWorkspace: stopTask failed, continuing with state cleanup", {
              workspaceId,
              err: (err as Error)?.message,
            });
          }
        }

        await store.mutate((draft: AppState) => {
          const ws = draft.workspaces.find((item) => item.id === workspaceId);
          draft.workspaces = draft.workspaces.filter((item) => item.id !== workspaceId);
          if (deletedScratchpadId) {
            draft.scratchpads = (draft.scratchpads || []).filter((item) => item.workspaceId !== deletedScratchpadId);
          }
          if (draft.activeWorkspaceId === workspaceId) {
            // Pick next-best in same profile
            const profileId = ws ? ws.profileId || "default" : "default";
            const sibling = draft.workspaces.find((w) => (w.profileId || "default") === profileId);
            draft.activeWorkspaceId = sibling?.id || draft.workspaces[0]?.id || "";
          }
          // Clear workspace from all window slots
          for (const slot of draft.windowSlots || []) {
            if (slot.activeWorkspaceId === workspaceId) {
              const profileId = slot.profileId;
              const sibling = draft.workspaces.find((w) => (w.profileId || "default") === profileId);
              slot.activeWorkspaceId = sibling?.id || "";
            }
          }
          // Clear workspace from per-profile grids and restore references
          for (const profile of draft.profiles) {
            if (profile.lastActiveWorkspaceId === workspaceId) {
              profile.lastActiveWorkspaceId = undefined;
              profile.lastActiveSessionId = undefined;
            } else if (profile.lastActiveSessionId?.startsWith(`${workspaceId}:`)) {
              profile.lastActiveSessionId = undefined;
            }
            if (!profile.workspaceGrid) continue;
            const ids = profile.workspaceGrid.cellWorkspaceIds;
            for (let i = 0; i < ids.length; i++) {
              if (ids[i] === workspaceId) ids[i] = null;
            }
            if (ids.every((id) => id === null)) profile.workspaceGrid = null;
          }
          // Clear from deprecated global grid
          if (draft.workspaceGrid) {
            const ids = draft.workspaceGrid.cellWorkspaceIds;
            for (let i = 0; i < ids.length; i++) {
              if (ids[i] === workspaceId) ids[i] = null;
            }
            if (ids.every((id) => id === null)) draft.workspaceGrid = null;
          }
        });

        for (const companionId of orphanedCompanionIds) {
          taskRunner.markAttachedSourceMissing(companionId);
        }

        sessionsExited = finalizeWorkspaceRemoval({
          id: String(workspaceId),
          profileId: workspace?.profileId || "default",
        });
        for (const sessionId of [...sessionSignals.keys()]) {
          if (sessionId.startsWith(`${workspaceId}:`)) {
            clearActivityFade(sessionId);
            retireSession(sessionId);
          }
        }
        ensureVisibleSession();
        broadcastState();

        // Delete worktree files from disk if requested
        let diskDeleteError = "";
        if (options.deleteFromDisk && workspace) {
          const primaryPath =
            workspace.review?.checkout?.rootPath || workspace.cwd || workspace.quickfix?.rootPath || "";
          const requestedPath = path.resolve(String(options.diskPath || primaryPath || "").trim());
          diskDeleteError = await deleteWorkspaceFromDisk(
            workspace,
            String(workspaceId),
            requestedPath,
            sessionsExited,
          );
        }

        const refreshTargets = resolveDeleteRefreshTargets(workspace, getState().workspaces);
        if (refreshTargets.length > 0) {
          for (const targetId of refreshTargets) {
            await refreshGit(targetId);
          }
        } else {
          await refreshGit(null, { useCache: true });
        }
        ensureVisibleSession();
        broadcastState();
        syncTreeDirWatchers(); // 6b: remove watcher for deleted parent's tree dir
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = getPayload();
        if (diskDeleteError) {
          result.deleteWorkspaceError = diskDeleteError;
        }
        return result;
      } finally {
        // Release the pending-delete flag only after the OS has finished
        // tearing down the worker/judge PTY processes. Without the await,
        // a fresh task at the same cwd could acquire it before claude.exe
        // / codex.exe released their file handles — exactly the symptom
        // the guard exists to prevent.
        if (sessionsExited) {
          try {
            await sessionsExited;
          } catch {
            // Session-removal failure shouldn't keep the cwd locked
            // forever; the workspace is already gone from state, so
            // releasing the flag is the safer choice (user can retry).
          }
        }
        // Krok 5: now the agents are gone — safe to remove their task files.
        // Best-effort; a failure here must not break the (already-completed)
        // delete. Runs in finally so it still happens if store.mutate threw,
        // matching the previous pre-mutate placement's "always runs" semantics.
        if (taskCleanup) {
          try {
            await taskRunner.cleanupTaskFiles(taskCleanup.cwd, taskCleanup.taskId);
          } catch (err) {
            log.warn("deleteWorkspace: cleanupTaskFiles failed", {
              workspaceId,
              err: (err as Error)?.message,
            });
          }
        }
        // Held the cwd locked across session teardown AND task-file cleanup, so
        // a fresh task at the same cwd can't appear until everything is gone.
        if (pendingKey) pendingTaskWorkspaceDeletions.delete(pendingKey);
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async deleteProject(projectId: any, options: any = {}, windowId?: string) {
      return this.deleteWorkspace(projectId, options, windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async reorderWorkspaces(workspaceIds: any, windowId?: string) {
      // Omitting a workspace from the submitted order REMOVES it (scoped to the
      // caller's profile, or globally in the legacy no-viewer fallback below).
      // Diff against committed state rather than trying to predict which branch
      // ran, so both paths get the same cleanup and removal event.
      const beforeWorkspaces = new Map(getState().workspaces.map((ws) => [ws.id, ws]));
      await store.mutate((draft: AppState) => {
        // Scope the reorder to the caller viewer's profile. The old logic
        // replaced the entire workspaces array with whatever IDs the caller
        // sent — a profile-scoped frontend or mobile client would then
        // accidentally drop every workspace in OTHER profiles whose IDs it
        // never knew about. Preserve other-profile workspaces in their
        // original positions and only reorder within the caller's profile.
        const callerProfileId = windowId ? getWindowProfileId(windowId) : null;
        if (!callerProfileId) {
          // Legacy fallback: no window context known — old global behavior.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          draft.workspaces = (workspaceIds as any[])
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((id: any) => draft.workspaces.find((workspace) => workspace.id === id))
            .filter(Boolean) as typeof draft.workspaces;
          return;
        }
        // Reorder only within callerProfileId. Other-profile workspaces
        // stay where they were (preserve original slots in draft.workspaces).
        const requested = new Set<string>(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (workspaceIds as any[]).filter((id) => {
            const ws = draft.workspaces.find((w) => w.id === id);
            return ws && (ws.profileId || "default") === callerProfileId;
          }),
        );
        const orderedScoped = (workspaceIds as string[])
          .map((id) => draft.workspaces.find((w) => w.id === id))
          .filter((w): w is (typeof draft.workspaces)[number] => !!w && requested.has(w.id));
        // Preserve workspaces NOT in callerProfileId in their original
        // sequence, and slot the reordered-scoped workspaces into the
        // positions originally held by callerProfile workspaces.
        let scopedCursor = 0;
        const next: typeof draft.workspaces = [];
        for (const ws of draft.workspaces) {
          if ((ws.profileId || "default") === callerProfileId) {
            if (scopedCursor < orderedScoped.length) {
              next.push(orderedScoped[scopedCursor++]);
            }
            // If callerProfile had more workspaces than the caller listed,
            // the remainder is dropped (caller's intent) — but they were
            // still in callerProfileId, so the caller had visibility.
          } else {
            next.push(ws);
          }
        }
        draft.workspaces = next;
      });

      const survivingIds = new Set(getState().workspaces.map((ws) => ws.id));
      for (const [workspaceId, workspace] of beforeWorkspaces) {
        if (survivingIds.has(workspaceId)) continue;
        void finalizeWorkspaceRemoval(workspace);
      }

      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async reorderProjects(projectIds: any, windowId?: string) {
      return this.reorderWorkspaces(projectIds, windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async updateSettings(settings: any) {
      const previousConfig = getState().settings.remoteAccess;
      let autoApproveDisarmed = false;
      await store.mutate((draft: AppState) => {
        if (settings.tabTemplates) {
          draft.tabTemplates = settings.tabTemplates;
        }
        draft.settings = {
          ...draft.settings,
          ...settings,
          remoteAccess: {
            ...draft.settings.remoteAccess,
            ...(settings.remoteAccess || {}),
          },
          notifications: {
            ...draft.settings.notifications,
            ...(settings.notifications || {}),
          },
          git: {
            ...draft.settings.git,
            ...(settings.git || {}),
            ui: {
              ...(draft.settings.git?.ui || {}),
              ...(settings.git?.ui || {}),
            },
          },
        };
        // Keep tabTemplates out of the settings object
        delete (draft.settings as any).tabTemplates; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: immer draft index signature

        // Auto-approve is armed by a deliberate act AT THE DESKTOP, and it is
        // only meaningful while the agent hook is running. Turning the hook
        // off must therefore disarm it rather than leave a `true` parked in
        // the state file: a remote client is allowed to switch `agentHook`
        // back on, and a parked `true` would make that switch silently
        // re-enable the bypass — an approval the user never gave from this
        // machine. Disarming here means re-arming always costs another
        // desktop-side tick of the box.
        const nextNotifications = draft.settings.notifications;
        if (nextNotifications && nextNotifications.agentHook === false && nextNotifications.autoApprovePermissions) {
          nextNotifications.autoApprovePermissions = false;
          autoApproveDisarmed = true;
        }
      });
      if (autoApproveDisarmed) {
        log.info("auto-approve disarmed: the agent hook it depends on was turned off");
      }
      // Unticking the box has to take effect on the requests already in
      // flight, not just the next ones: an offer made a second ago would
      // otherwise still be committed — and audited — after the user turned the
      // bypass off.
      if (getState().settings?.notifications?.autoApprovePermissions !== true) {
        discardPermissionOffers(() => true, "auto-approve-off");
      }

      const nextConfig = getState().settings.remoteAccess;
      tunnel.setBinaryPreference?.(nextConfig.cloudflaredPath || "");
      const remoteAccessChanged = JSON.stringify(previousConfig) !== JSON.stringify(nextConfig);
      const tunnelTargetChanged = previousConfig.port !== nextConfig.port || previousConfig.host !== nextConfig.host;
      if (previousConfig.paused && !nextConfig.paused) autoTunnelBootstrapped = false;
      if (remoteAccessChanged) {
        events.emit("remote:config-changed", clone(nextConfig));
      }
      if (!nextConfig.enabled || nextConfig.paused) {
        await tunnel.stop({ preserveAvailability: true, quiet: true });
      } else if (tunnel.getSnapshot().status === "connected" && tunnelTargetChanged) {
        await tunnel.startQuickTunnel(await ensureRemoteOriginReady(nextConfig));
      }
      if (
        previousConfig.cloudflaredPath !== nextConfig.cloudflaredPath &&
        tunnel.getSnapshot().status !== "connected"
      ) {
        await tunnel.refreshAvailability();
      }

      // Apply log level change at runtime
      const newLogLevel = getState().settings?.logLevel;
      if (newLogLevel) {
        setLogLevel(newLogLevel);
      }

      // Start/stop notify server based on agentHook setting
      const agentHookEnabled = getState().settings?.notifications?.agentHook !== false;
      if (agentHookEnabled && !notifyServerHandle) {
        await startAgentNotifyServer();
      } else if (!agentHookEnabled && notifyServerHandle) {
        await stopAgentNotifyServer();
      }

      // Reconfigure Telegram if integrations changed
      reconfigureTelegram(getState());
      await reconfigureMobile(getState());

      // Invalidate docker backend-detection cache on any settings change so that
      // future docker-related settings (or any proxy/env change affecting docker)
      // force a re-probe on the next docker refresh.
      docker.invalidateBackendDetectionCache();

      broadcastState();
      return { payload: getPayload(), remoteAccessChanged };
    },

    // --- Telegram integration handlers ---

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async verifyTelegramConnection(connection: any) {
      const chatId = String(connection.chatId || "").trim();
      if (!chatId) {
        throw new Error("Chat ID is required.");
      }
      // Edit mode: an empty botToken means "keep the existing one". Fall back
      // to the stored credential keyed by either the explicit botTokenRef or
      // the conventional `cred:<id>` reference.
      let botToken = String(connection.botToken || "").trim();
      if (!botToken) {
        const ref = connection.botTokenRef || (connection.id ? `cred:${connection.id}` : "");
        if (ref) {
          botToken = credentialStore.getSecret(ref) || "";
        }
      }
      if (!botToken) {
        throw new Error("Bot token is required.");
      }
      return telegramManager.verifyConnection({ botToken, chatId });
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async detectTelegramChats(connection: any) {
      // Same edit-mode token fallback as verify.
      let botToken = String(connection.botToken || "").trim();
      if (!botToken) {
        const ref = connection.botTokenRef || (connection.id ? `cred:${connection.id}` : "");
        if (ref) {
          botToken = credentialStore.getSecret(ref) || "";
        }
      }
      if (!botToken) {
        throw new Error("Bot token is required.");
      }
      return telegramManager.detectChats({ botToken });
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveTelegramConnection(connection: any) {
      log.info("telegram saveTelegramConnection called", {
        id: connection?.id,
        chatId: connection?.chatId,
        hasBotToken: Boolean(connection?.botToken),
        forwardKindsType: Object.prototype.toString.call(connection?.forwardKinds),
      });
      const connectionId = connection.id || `tg-${randomUUID()}`;
      const botTokenRef = connection.botTokenRef || `cred:${connectionId}`;
      const botToken = connection.botToken || credentialStore.getSecret(botTokenRef);
      const chatId = String(connection.chatId || "").trim();

      if (!chatId) throw new Error("Chat ID is required.");
      if (!botToken && !credentialStore.hasSecret(botTokenRef)) {
        throw new Error("Bot token is required.");
      }

      // Verify the connection works
      const verification = await telegramManager.verifyConnection({
        botToken: botToken || credentialStore.getSecret(botTokenRef),
        chatId,
      });

      if (botToken) {
        await credentialStore.setSecret(botTokenRef, botToken);
      }

      const normalizedConnection = {
        id: connectionId,
        label: String(connection.label || `Telegram ${connectionId}`).trim(),
        botTokenRef,
        chatId,
        enabled: connection.enabled !== false,
        pollSeconds: Number(connection.pollSeconds) || getTelegramSettings().defaultPollSeconds || 5,
        profileId: typeof connection.profileId === "string" ? connection.profileId.trim() : "",
        forwardKinds: Array.isArray(connection.forwardKinds) ? [...connection.forwardKinds] : [],
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await store.mutate((draft: any) => {
        if (!draft.settings.integrations.telegram) {
          draft.settings.integrations.telegram = { enabled: true, defaultPollSeconds: 5, connections: [] };
        }
        const connections = draft.settings.integrations.telegram.connections;
        const index = connections.findIndex((c: any) => c.id === connectionId); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (index >= 0) {
          connections[index] = normalizedConnection;
        } else {
          connections.push(normalizedConnection);
        }
      });

      reconfigureTelegram(getState());
      broadcastState();

      // Preflight: structured-clone the response we hand back to IPC. If
      // something is non-cloneable (Vue Proxy, Map, function, etc.), this
      // throws here with a stack we can log instead of the renderer's
      // opaque "An object could not be cloned." error.
      const response = { payload: getPayload(), verification };
      try {
        structuredClone(response);
      } catch (err) {
        log.warn("telegram saveTelegramConnection: response not cloneable", {
          err: (err as Error).message,
          verificationKeys: Object.keys(verification ?? {}),
        });
        // Fall through with a defensively-cloned response (drops anything
        // structuredClone can't handle by serialising via JSON).
        return JSON.parse(JSON.stringify(response));
      }
      return response;
    },

    async deleteTelegramConnection(connectionId: string) {
      const conn = getTelegramConnections().find((c: any) => c.id === connectionId); // eslint-disable-line @typescript-eslint/no-explicit-any
      if (conn?.botTokenRef) {
        await credentialStore.deleteSecret(conn.botTokenRef).catch(() => {});
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await store.mutate((draft: any) => {
        if (!draft.settings.integrations.telegram) return;
        draft.settings.integrations.telegram.connections =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          draft.settings.integrations.telegram.connections.filter((c: any) => c.id !== connectionId);
      });
      reconfigureTelegram(getState());
      broadcastState();
      return getPayload();
    },

    async refreshTelegramState() {
      reconfigureTelegram(getState());
      broadcastState();
      return getPayload();
    },

    // Azure, GitHub, and Review Bridge handlers provided by providerHandlers (spread above)

    async regenerateRemoteToken() {
      await store.mutate((draft: AppState) => {
        draft.settings.remoteAccess.token = createAccessToken();
      });

      events.emit("remote:config-changed", clone(getState().settings.remoteAccess));
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    closeSession(sessionId: any) {
      clearAlertSession(sessionId);
      clearActivityFade(sessionId);
      retireSession(String(sessionId || ""));
      // "Disconnect SSH" keeps the panel in state — only the process/connection
      // goes away — so CLEAR the replay (drop the dead generation's screen) but
      // KEEP the sequence counter. destroyTerminalReplay would reset seq to 0,
      // and a renderer/remote client still holding the pre-disconnect throughSeq
      // would then drop every reconnect frame (seq restarts low) as a duplicate.
      // The counter is dropped only when the panel is actually removed
      // (terminal:removed → destroyTerminalReplay). Clear BEFORE removeSession so
      // the "── Disconnected by user" banner it emits lands in the (kept) replay
      // instead of re-creating a just-destroyed entry.
      clearTerminalReplay(String(sessionId || ""));
      sessions.removeSession(sessionId);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resizeSession(sessionId: any, size: any) {
      sessions.resizeSession(sessionId, size.cols, size.rows);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeToSession(sessionId: any, data: any, viewerId?: string, originWorkspaceId?: string) {
      const isUserTyping = hasMeaningfulUserInput(data);
      // Input lease: only viewer-originated MEANINGFUL typing participates —
      // mouse-reporting escapes from a viewer that merely clicked to watch
      // neither grab nor get blocked by the lease, and internal writers
      // (no viewerId — task runner, tests) always pass through.
      if (viewerId && isUserTyping) {
        const verdict = acquireSessionInputLease(String(sessionId), viewerId);
        if (!verdict.ok) {
          log.info("terminal input blocked by input lease", {
            sessionId,
            viewerId,
            ownerViewerId: verdict.ownerViewerId,
          });
          return { blocked: true, ownerViewerId: verdict.ownerViewerId, ownerLabel: verdict.ownerLabel };
        }
      }
      resetSessionSignal(sessionId);
      const signal = sessionSignals.get(sessionId);
      if (signal && !signal.hasUserInput) {
        log.debug("first user input recorded", { sessionId });
      }
      if (signal) {
        signal.hasUserInput = true;
        // Plan Phase 1 § 4.7: records the moment of active user engagement
        // with THIS session. Detector uses it to suppress T3 alerts within
        // the grace window (userInteractionGraceMs).
        signal.lastUserInteractionAt = Date.now();
        // Phase 2 § 3.2.4: accumulate keystrokes so we can classify the
        // command when Enter is pressed. Filter control characters — we
        // only care about the command text itself.
        updateCommandClassFromInput(signal, data);
        // Phase 3 § 3.2.6: active user interaction resets adaptive counter
        adaptiveRecordInteraction(sessionId);
      }
      // Pause task runner only on real typing — mouse clicks and focus events
      // emit escape sequences too (e.g. \x1b[<0;x;yM) and would otherwise pause
      // the task just because the user clicked into the panel to watch.
      if (isUserTyping) {
        taskRunner.onUserInput(sessionId);
      }
      const descriptor = parseSessionId(sessionId);
      if (descriptor) {
        // Same rule as the lease: a viewer typing is the user working here.
        // An internal writer (no viewerId) is the task runner driving an
        // agent, which must never look like manual use. The workspace credited
        // is the one whose UI the viewer typed in, not blindly the session's
        // owner — see resolveWorkOriginWorkspaceId for the attached-task case.
        if (viewerId && isUserTyping) {
          stampWorkspaceWorkedByTyping(resolveWorkOriginWorkspaceId(String(sessionId), originWorkspaceId));
        }
        const current = projectAlerts.get(descriptor.workspaceId);
        const alert = current?.alerts?.find((a) => a.panelId === descriptor.panelId);
        if (alert && Date.now() - new Date(alert.at).getTime() >= ATTENTION_MIN_DISPLAY_MS) {
          clearProjectAlerts(descriptor.workspaceId, descriptor.panelId);
          broadcastState();
        }
      }
      sessions.writeToSession(sessionId, data);
      return { ok: true };
    },

    /**
     * Explicit take-over of a session's input lease ("Take control?"
     * confirmation). Task dashboard lifecycle buttons are NOT gated by the
     * lease — only raw terminal typing is.
     */
    takeSessionControl(sessionId: string, viewerId: string): { ok: boolean } {
      if (!sessionId || !viewerId) return { ok: false };
      sessionInputLeases.set(String(sessionId), {
        viewerId,
        expiresAt: Date.now() + INPUT_LEASE_TTL_MS,
      });
      log.info("terminal input lease taken over", { sessionId, viewerId });
      return { ok: true };
    },

    /** Test hook: raw input-lease map. */
    _sessionInputLeasesForTest() {
      return sessionInputLeases;
    },
    /**
     * Test hook: the `PermissionRequest` decision path. In production this is
     * reached only through the notify-server's `onDecision`, which needs a
     * live HTTP round-trip; the decision logic itself is worth testing without
     * one.
     */
    _handlePermissionRequestForTest(event: { sessionId?: string; payload?: Record<string, unknown> }) {
      const offer = offerPermissionDecision(event);
      if (!offer) return null;
      return commitPermissionDecision(event, offer.requestId);
    },
    /** Test hook: phase 1 only — an offer must have no observable side effects. */
    _offerPermissionDecisionForTest(event: { sessionId?: string; payload?: Record<string, unknown> }) {
      return offerPermissionDecision(event);
    },
    /** Test hook: phase 2, the leg that records and answers. */
    _commitPermissionDecisionForTest(
      event: { sessionId?: string; payload?: Record<string, unknown> },
      requestId: string,
    ) {
      return commitPermissionDecision(event, requestId);
    },
    /** Test hook: the per-PTY ownership token a hook has to echo back. */
    _sessionOwnershipTokenForTest(sessionId: string) {
      return getSessionOwnershipToken(sessionId);
    },
    /** Test hook: this instance's own notify-URL registry file. */
    _notifyUrlRegistryForTest() {
      return notifyUrlRegistry;
    },
    /** Test hook: the session signal map (pendingPermission, waitingRaised, …). */
    _sessionSignalsForTest() {
      return sessionSignals;
    },
    /** Test hook: the approval audit store, so a failing write can be simulated. */
    _approvalAuditLogStoreForTest() {
      return approvalAuditLogStore;
    },
    notifyAgentHook(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionId: any,
      notificationType = "idle_prompt",
      hook = "Notification",
      payload: Record<string, unknown> = {},
    ) {
      log.debug("notifyAgentHook called", { sessionId, hook, notificationType });
      // dispatchAgentHookEvent is async; this IPC handler is sync (fire-and-
      // forget), so an unguarded rejection here would be an unhandled
      // rejection with no sessionId context.
      void dispatchAgentHookEvent({
        sessionId,
        hook,
        subtype: notificationType,
        notificationType,
        payload,
      }).catch((err: unknown) => {
        log.warn("hook dispatch failed", { sessionId, hook, err: (err as Error)?.message || String(err) });
      });
    },
    runHookProbe,
    /**
     * Read the permission auto-approval trail. Pure read, which is why the
     * remote transport is allowed to call it (GET /api/approvals/audit-log)
     * even though it may never FLIP the setting that produces the entries.
     *
     * `filters.profileId` narrows the answer to one profile, and the remote
     * server passes the profile its caller's session is bound to — the same
     * scoping the live `approval:recorded` event already applies. Desktop IPC
     * omits it: the Settings viewer is a local, whole-installation view.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryApprovalAuditLog(filters: any = {}) {
      return approvalAuditLogStore.query(withApprovalProfileFilter(filters));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getApprovalAuditStats(filters: any = {}) {
      return approvalAuditLogStore.getStats(withApprovalProfileFilter(filters));
    },
    /**
     * Delete rows from the approval trail — the user forgetting approvals they
     * have read, from the dock's Approvals tab.
     *
     * Reachable from desktop IPC only; there is deliberately no remote route.
     * The deletion itself is logged, because a trail that can be emptied
     * without leaving any mark is not much of a trail: the rows are gone, but
     * `strideterm.log` still says how many and when.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteApprovalAuditEntries(payload: any = {}) {
      const { ids, all, ...rest } = payload || {};
      const scoped = withApprovalProfileFilter(rest);
      const deleted = approvalAuditLogStore.deleteEntries({
        ids,
        all: Boolean(all),
        providerFilters: scoped.providerFilters as Record<string, string> | undefined,
      });
      if (deleted > 0) {
        log.info("approval audit rows deleted", {
          deleted,
          scope: all ? "all" : "selection",
          profileId: rest?.profileId || "",
        });
      }
      return { deleted };
    },
    /**
     * Expose notification-pipeline metrics for the About dialog / diagnostics.
     * Pure read — returns a snapshot.
     */
    getNotificationMetrics() {
      return getMetrics();
    },
    /**
     * Clear a single session's alert entry. Called from the notification
     * center when the user clicks Jump or Dismiss — without this, the tab
     * badge stays lit after the UI-side notification is removed.
     * Plan § 3.3.3.
     *
     * @param {string} sessionId
     * @param {Object} [options]
     * @param {boolean} [options.dismissed=false]
     *   true  → user clicked "Dismiss" (no engagement). Feeds adaptive
     *           suppression (§ 3.2.6) so a session that keeps getting
     *           dismissed without interaction goes quieter on its own.
     *   false → user clicked "Jump" or alert auto-cleared. Treated as
     *           engagement — resets the adaptive dismiss counter.
     */
    clearAlertForSession(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionId: any,
      { dismissed = false, windowId = null }: { dismissed?: boolean; windowId?: string | null } = {},
    ) {
      if (!sessionId) return getPayload();
      const descriptor = parseSessionId(sessionId);
      if (!descriptor) return getPayload();
      // Refuse cross-profile clears. Without this, a remote client bound to
      // profile B could clear alerts on a workspace in profile A by sending
      // any sessionId — same class of leak as the (now scoped) clear-all.
      // windowId === null preserves the legacy unscoped path for in-process
      // callers that don't carry a window context.
      if (windowId !== null) {
        const state = getState();
        // Viewer-aware: resolves desktop slot ids AND remote viewer ids.
        const scopeProfileId: string = getWindowProfileId(windowId || undefined) || "default";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const workspace = (state.workspaces || []).find((w: any) => w.id === descriptor.workspaceId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const owning = workspace ? (workspace as any).profileId || "default" : null;
        // Workspace deleted (owning === null) is allowed — the alert can't
        // surface in any profile anyway.
        if (owning !== null && owning !== scopeProfileId) {
          log.debug("clearAlertForSession refused (cross-profile)", { sessionId, scopeProfileId, owning });
          return getPayload();
        }
      }
      log.debug("clearAlertForSession", { sessionId, dismissed });
      clearProjectAlerts(descriptor.workspaceId, descriptor.panelId);
      resetSessionSignal(sessionId);
      if (dismissed) {
        adaptiveRecordDismissed(sessionId);
        metricsRecordDismissed();
      } else {
        adaptiveRecordInteraction(sessionId);
      }
      broadcastState();
      return getPayload();
    },
    clearAllAttention(windowId: string | null = null) {
      // Resolve the caller's profile from windowId. When supplied, only
      // alerts whose workspace lives in that profile are cleared — without
      // this scoping, "Clear all" from a window viewing profile B would
      // wipe profile A's attention alerts too (the per-profile bell badges
      // on other open windows would silently fall to zero). When windowId
      // is null (legacy / no-context callers) the old global behavior is
      // preserved.
      const state = getState();

      // Viewer-aware: resolves desktop slot ids AND remote viewer ids.
      const scopeProfileId: string | null = windowId ? getWindowProfileId(windowId) : null;

      log.debug("clearing all attention alerts", { windowId, scopeProfileId });

      if (scopeProfileId !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const workspaces = (state.workspaces || []) as any[];
        const profileByWs = new Map<string, string>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const ws of workspaces) profileByWs.set(ws.id, (ws as any).profileId || "default");

        // Drop alerts whose workspace belongs to the caller's profile (or
        // whose workspace was already deleted — those have no owner and
        // can't show in any profile, so they're safe to clear from the
        // caller's "Clear all" without leaking).
        for (const wsId of Array.from(projectAlerts.keys())) {
          const owning = profileByWs.get(wsId);
          if (owning === undefined || owning === scopeProfileId) {
            projectAlerts.delete(wsId);
          }
        }

        const now = Date.now();
        for (const [sessionId, signal] of sessionSignals) {
          const descriptor = parseSessionId(sessionId);
          const owning = descriptor ? profileByWs.get(descriptor.workspaceId) : undefined;
          if (owning !== undefined && owning !== scopeProfileId) continue;
          cancelPromptTimer(signal);
          const wasActive = signal.waitingRaised || signal.everAlerted;
          signal.busy = false;
          signal.waitingRaised = false;
          signal.lastOutputAt = 0;
          if (wasActive) signal.lastAlertAt = now;
        }
      } else {
        projectAlerts.clear();
        const now = Date.now();
        for (const [, signal] of sessionSignals) {
          cancelPromptTimer(signal);
          // Only carry the post-clear cooldown on signals that were actually
          // alerting — otherwise a stale buffer replay could re-alert. Fresh
          // signals (never alerted, not waiting) have nothing to suppress, so
          // applying lastAlertAt to them just silences valid future hooks for
          // the next ~15s. Use `everAlerted` (not `lastAlertAt > 0`) because
          // signals are seeded with lastAlertAt=createTime for warmup.
          const wasActive = signal.waitingRaised || signal.everAlerted;
          signal.busy = false;
          signal.waitingRaised = false;
          signal.lastOutputAt = 0;
          if (wasActive) signal.lastAlertAt = now;
        }
      }
      broadcastState();
      return getPayload();
    },
    // Drop a viewer's visible-session contribution when its transport goes
    // away (remote socket fully closed). Desktop windows are cleaned up via
    // removeWindowSlot; the remote server calls this on WebSocket close.
    dropViewerVisibility(viewerKey: string) {
      dropViewerVisibility(viewerKey);
    },
    syncAttentionContext({
      visibleSessionIds = [],
      windowFocused = true,
      windowId = null,
    }: { visibleSessionIds?: string[]; windowFocused?: boolean; windowId?: string | null } = {}) {
      // When called with a windowId, drop any session that doesn't belong
      // to the caller's profile before doing anything else — otherwise a
      // remote client on profile B could mark profile A's sessions as
      // visible/interacted and after ATTENTION_MIN_DISPLAY_MS even clear
      // their alerts. Workspace deleted → no profile, no scope leak: keep
      // as a legacy/cleanup case (the alert can't surface anywhere).
      const state = getState();
      // Viewer-aware: resolves desktop slot ids AND remote viewer ids.
      const scopeProfileId: string | null = windowId ? getWindowProfileId(windowId) : null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsList = (state.workspaces || []) as any[];
      const profileByWs = new Map<string, string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const ws of wsList) profileByWs.set(ws.id, (ws as any).profileId || "default");

      const sessionInScope = (sid: string): boolean => {
        if (scopeProfileId === null) return true;
        const descriptor = parseSessionId(sid);
        if (!descriptor) return false;
        const owning = profileByWs.get(descriptor.workspaceId);
        if (owning === undefined) return true; // workspace deleted — harmless
        return owning === scopeProfileId;
      };

      const nextIds = (Array.isArray(visibleSessionIds) ? visibleSessionIds : [])
        .map((sessionId) => String(sessionId || "").trim())
        .filter(Boolean)
        .filter(sessionInScope);
      // Key by the caller's viewer (desktop slot id or remote viewer id) so
      // each viewer's visible set is tracked independently and unioned — two
      // concurrent viewers no longer overwrite one another (the mobile
      // workspace/tab flip-flop). Anonymous callers fall back to the default
      // bucket inside updateVisibleSessions.
      updateVisibleSessions(nextIds, windowId || undefined);

      // Phase 2 § 3.2.5: if the window is focused, a visible session counts
      // as active user interaction — updates lastUserInteractionAt so
      // silence timers for other (also visible) sessions don't fire as the
      // user scrolls between tabs.
      if (windowFocused) {
        const now = Date.now();
        for (const sid of nextIds) {
          const signal = sessionSignals.get(sid);
          if (signal) signal.lastUserInteractionAt = now;
        }
      }

      // Clear alerts for visible sessions that have been shown long enough
      const now = Date.now();
      let changed = false;
      for (const sessionId of attentionContext.visibleSessionIds) {
        const descriptor = parseSessionId(sessionId);
        if (!descriptor) continue;
        // updateVisibleSessions may have retained sessions from previous
        // syncs that belonged to a different profile; double-check here.
        if (!sessionInScope(sessionId)) continue;
        const current = projectAlerts.get(descriptor.workspaceId);
        const alert = current?.alerts?.find((a) => a.panelId === descriptor.panelId);
        if (alert && now - new Date(alert.at).getTime() >= ATTENTION_MIN_DISPLAY_MS) {
          clearProjectAlerts(descriptor.workspaceId, descriptor.panelId);
          resetSessionSignal(sessionId);
          changed = true;
        }
      }
      if (changed) broadcastState();

      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async restartSession(sessionId: any) {
      const descriptor = parseSessionId(sessionId);
      clearTerminalReplay(String(sessionId || ""));
      await store.mutate((draft: AppState) => {
        if (!descriptor) {
          return;
        }

        const workspace = findWorkspace(draft, descriptor.workspaceId);
        if (!workspace) {
          return;
        }

        draft.activeWorkspaceId = descriptor.workspaceId;
        workspace.activePanelId = descriptor.panelId;
      });

      await sessions.restartSession(getState(), sessionId);
      if (descriptor) {
        clearProjectAlerts(descriptor.workspaceId, descriptor.panelId);
      }
      resetSessionSignal(sessionId);
      broadcastState();
      return getPayload();
    },
    // Docker handlers provided by dockerHandlers (spread above)
    // Git handlers provided by gitHandlers (spread above)

    async refreshTunnelState() {
      await tunnel.refreshAvailability();
      return getPayload();
    },
    async createCloudflareTunnel() {
      const remoteConfig = getState().settings.remoteAccess;
      if (remoteConfig.paused) throw new Error("Remote access is paused. Resume it from Remote Access first.");
      const originUrl = createTunnelOriginUrl(remoteConfig);
      log.info("createCloudflareTunnel: requested", {
        enabled: !!remoteConfig.enabled,
        host: remoteConfig.host,
        port: remoteConfig.port,
        originUrl,
      });

      if (!remoteConfig.enabled) {
        const msg = "Enable LAN remote access before creating a Cloudflare tunnel.";
        log.warn("createCloudflareTunnel: aborted — remote access disabled");
        tunnel.applyExternalError(msg);
        throw new Error(msg);
      }

      // If the remote-access server failed to bind its port (typical cause:
      // another strideterm instance — usually a dev build — already owns
      // the port), don't pretend the tunnel can work. The origin probe
      // would either time out, or worse, succeed against the competing
      // process and silently route traffic into the wrong instance.
      if (remoteInfo && remoteInfo.enabled === false) {
        const bindError =
          typeof remoteInfo.error === "string" && remoteInfo.error
            ? remoteInfo.error
            : "Remote access server is not running on this instance";
        const msg = `Cannot create Cloudflare tunnel — ${bindError}. Stop the conflicting process (commonly a dev build of strideterm) or change STRIDETERM_REMOTE_PORT, then restart.`;
        log.warn("createCloudflareTunnel: aborted — remote-access server not bound", {
          bindError,
          port: remoteConfig.port,
          host: remoteConfig.host,
        });
        tunnel.applyExternalError(msg);
        throw new Error(msg);
      }

      // Flip the UI chip to "connecting" before the ~4s origin probe so
      // the user sees progress immediately. The renderer also tracks its
      // own `creating` ref for the spinner; this covers concurrent UIs.
      tunnel.applyExternalConnecting();

      try {
        log.info("createCloudflareTunnel: probing local origin", { originUrl });
        const resolvedOrigin = await ensureRemoteOriginReady(remoteConfig);
        log.info("createCloudflareTunnel: origin reachable, starting cloudflared", { originUrl: resolvedOrigin });
        await tunnel.startQuickTunnel(resolvedOrigin);
        await store.mutate((draft: AppState) => {
          draft.settings.remoteAccess.autoTunnel = true;
        });
        const snap = tunnel.getSnapshot();
        log.info("createCloudflareTunnel: success", { publicUrl: snap.publicUrl, localUrl: snap.localUrl });
        return getPayload();
      } catch (err) {
        const message = (err as Error)?.message || String(err);
        log.error("createCloudflareTunnel: failed", { err: message, originUrl });
        tunnel.applyExternalError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    async stopCloudflareTunnel() {
      await tunnel.stop({ preserveAvailability: true });
      // Clear auto-start preference — user explicitly stopped the tunnel.
      await store.mutate((draft: AppState) => {
        draft.settings.remoteAccess.autoTunnel = false;
      });
      return getPayload();
    },
    async openDockerSession({
      workspaceId,
      projectId,
      containerId,
      mode,
      backendId,
      contextName,
    }: {
      workspaceId?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      projectId: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      containerId: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      mode: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      backendId?: string;
      contextName?: string;
    }) {
      const targetWorkspaceId = workspaceId || projectId;
      await refreshDocker();
      const container = docker.findContainer(containerId);
      if (!container) {
        throw new Error("Docker container not found.");
      }

      const launch =
        mode === "logs"
          ? docker.createLogsLaunch(containerId, backendId, contextName)
          : docker.createShellLaunch(containerId, backendId, contextName);
      if (!launch) {
        throw new Error("Docker backend is not available.");
      }

      const panelId = `${mode}-${containerId}`;
      const title = mode === "logs" ? `${container.Names} logs` : `${container.Names} shell`;
      const command = mode === "logs" ? `docker logs -f ${container.Names}` : `docker exec -it ${container.Names} sh`;

      return openLaunchPanel(targetWorkspaceId, panelId, {
        title,
        command,
        launch,
        notFoundMessage: "Docker workspace not found.",
      });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async openLazydockerSession({ workspaceId, projectId }: { workspaceId?: any; projectId: any }) {
      const targetWorkspaceId = workspaceId || projectId;
      await refreshDocker();
      const launch = docker.createLazydockerLaunch();
      if (!launch) {
        throw new Error("Lazydocker is not available in the active Docker environment.");
      }

      return openLaunchPanel(targetWorkspaceId, "lazydocker", {
        title: "Lazydocker",
        command: "lazydocker",
        launch,
        notFoundMessage: "Docker workspace not found.",
      });
    },
    async openLazygitSession({
      workspaceId,
      projectId,
      rootPath,
    }: {
      workspaceId?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      projectId: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      rootPath: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
    }) {
      const targetWorkspaceId = workspaceId || projectId;
      await refreshGit(targetWorkspaceId);
      const launch = git.createLazygitLaunch(targetWorkspaceId, rootPath || null);
      if (!launch) {
        throw new Error("Lazygit is not available for this workspace.");
      }

      return openLaunchPanel(targetWorkspaceId, "lazygit", {
        title: "Lazygit",
        command: "lazygit",
        launch,
        notFoundMessage: "Workspace not found.",
      });
    },
    async createWorktree(
      {
        workspaceId,
        projectId,
        name,
        rootPath,
      }: {
        workspaceId?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
        projectId: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
        name: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
        rootPath?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      },
      windowId?: string,
    ) {
      const targetWorkspaceId = workspaceId || projectId;
      if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new Error("Worktree name must contain only alphanumeric characters, dots, hyphens, or underscores.");
      }
      const project = findWorkspace(getState(), targetWorkspaceId);
      if (!project?.cwd) throw new Error("Workspace has no working directory");
      // Refuse upfront if the parent lives in a profile the caller's window
      // isn't bound to — a remote/mobile client must not be able to spawn
      // a worktree on disk in another profile just by passing its ID.
      assertWorkspaceInViewerProfile(targetWorkspaceId, windowId);

      // Multi-repo: a rootPath must be chosen. Single-repo: fall back to workspace cwd.
      const normalizePath = (p: string) =>
        String(p || "")
          .replace(/\\/g, "/")
          .replace(/\/+$/, "");
      const gitRoots = Array.isArray(project.gitRoots) ? project.gitRoots.filter(Boolean) : [];
      let repoPath = rootPath || "";
      if (gitRoots.length >= 2) {
        if (!repoPath) {
          throw new Error("Multi-repo workspace requires a repository to be selected for the worktree.");
        }
        const normRepo = normalizePath(repoPath);
        const normRoots = gitRoots.map(normalizePath);
        if (!normRoots.includes(normRepo) && normRepo !== normalizePath(project.cwd)) {
          throw new Error(`Selected repository ${repoPath} is not part of this workspace.`);
        }
      } else if (!repoPath) {
        repoPath = project.cwd;
      }

      const treePath = await ensureWorktree(repoPath, name);

      // Create subproject cloning parent panels
      const newProject = normalizeWorkspace({
        id: `workspace-${randomUUID()}`,
        name: `${project.name} / ${name}`,
        icon: project.icon,
        color: project.color,
        kind: project.kind,
        source: project.source,
        pluginId: project.pluginId,
        profileId: project.profileId,
        connectionId: project.connectionId || "",
        cwd: treePath,
        notes: `Worktree of ${project.name}`,
        activePanelId: "",
        panels:
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: project is server state JSON, typed migration pending
          (project as any).panels?.map((p: any) => ({
            ...p,
            id: `panel-${randomUUID()}`,
          })) || [],
      });

      await store.mutate((draft: AppState) => {
        insertWorkspace(draft.workspaces, newProject, getViewerActiveWorkspaceId(windowId));
        draft.activeWorkspaceId = newProject.id;
        // Creating a worktree workspace is work (V2 plan allowlist).
        markWorkspaceWorked(draft, newProject.id);
        // Entry check (assertWorkspaceInViewerProfile) already refused any
        // cross-profile request, so the mirror here is always in-profile.
        if (windowId) {
          const slot = (draft.windowSlots || []).find((s) => s.id === windowId);
          if (slot) slot.activeWorkspaceId = newProject.id;
        }
      });
      // Remote viewer: show the new worktree in the caller's remote context.
      mirrorRemoteViewerWorkspace(windowId, newProject.id);

      sessions.syncWithState(getState());
      await refreshGit(newProject.id);
      ensureVisibleSession();
      broadcastState();
      refreshAzure().catch((err: unknown) => {
        log.warn("createWorktree: refreshAzure failed", { err: (err as Error)?.message });
      });
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveProfile(profile: any) {
      await store.mutate((draft: AppState) => {
        const index = draft.profiles.findIndex((p) => p.id === profile.id);
        const normalized = {
          id: profile.id || `profile-${randomUUID()}`,
          name: profile.name || "Unnamed",
          color: profile.color || "#ffa424",
          workspaceIds: Array.isArray(profile.workspaceIds)
            ? profile.workspaceIds
            : Array.isArray(profile.projectIds)
              ? profile.projectIds
              : [],
          ...(profile.sidebarWorkspaceViewMode === "tree" || profile.sidebarWorkspaceViewMode === "recent"
            ? { sidebarWorkspaceViewMode: profile.sidebarWorkspaceViewMode }
            : {}),
        };
        if (index >= 0) {
          // Merge over the existing entry: rename/recolor must not wipe the
          // profile's legacy grid seed or lastActive restore ids.
          draft.profiles[index] = { ...draft.profiles[index], ...normalized };
        } else {
          draft.profiles.push(normalized);
        }
      });
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async deleteProfile(profileId: any, options: { taskAction?: "pause" | "stop" } = {}) {
      const state = getState();
      // Refuse if profile is open in any window slot
      const openSlot = (state.windowSlots || []).find((s) => s.profileId === profileId);
      if (openSlot) {
        const slots = state.windowSlots || [];
        const idx = slots.findIndex((s) => s.id === openSlot.id);
        throw new Error(`Profile is open in Window ${idx + 1}. Close that window first.`);
      }
      // Tasks keep running when their profile is merely not shown anywhere —
      // but DELETING the profile with live task agents must be an explicit
      // decision: pause them, stop them, or cancel. No silent stop, no
      // silent move to another profile.
      const activeTasks = state.workspaces.filter(
        (w) =>
          (w.profileId || "default") === profileId &&
          w.kind === "task" &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ACTIVE_TASK_STATES.has(String((w as any).task?.state || "")),
      );
      if (activeTasks.length > 0) {
        const action = options?.taskAction;
        if (action !== "pause" && action !== "stop") {
          throw new Error(
            `Profile has ${activeTasks.length} running task agent${activeTasks.length === 1 ? "" : "s"}. ` +
              `Pass taskAction "pause" or "stop" to confirm what should happen to them.`,
          );
        }
        for (const task of activeTasks) {
          try {
            if (action === "pause") taskRunner.pauseTask(task.id);
            else taskRunner.stopTask(task.id);
          } catch (err) {
            log.warn("deleteProfile: task action failed, continuing", {
              workspaceId: task.id,
              action,
              err: (err as Error)?.message,
            });
          }
        }
      }
      await store.mutate((draft: AppState) => {
        draft.profiles = draft.profiles.filter((p) => p.id !== profileId);
        if (draft.profiles.length === 0) {
          draft.profiles.push({ id: "default", name: "Default", color: "#6366f1", workspaceIds: [] });
        }
      });
      // Fallback any remote clients that were on the deleted profile — in EVERY registry, because a
      // browser viewer and a mobile relay viewer can both be sitting on the profile being deleted.
      for (const registry of _remoteClientRegistries) registry.fallbackDeletedProfile(profileId, getState());
      broadcastState();
      return getPayload();
    },
    getPlugins() {
      return pluginManager.getPlugins();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getPluginWorkspaceTemplate(pluginId: any) {
      return pluginManager.getWorkspaceTemplate(pluginId);
    },
    async stop() {
      log.info("runtime shutting down");
      // Stop the notify server first so no new callbacks arrive
      // while we clear session signals below.
      await stopAgentNotifyServer();
      for (const signal of sessionSignals.values()) {
        cancelPromptTimer(signal);
      }
      sessionSignals.clear();
      codexTerminalNotifications.clear();
      dockerLogManager.closeAll();
      dockerShellManager.closeAll();
      if (dockerPoll) {
        clearInterval(dockerPoll);
        dockerPoll = null;
      }
      if (gitPoll) {
        clearInterval(gitPoll);
        gitPoll = null;
      }
      // Krok 6: cancel any armed background disk-delete retries. They're
      // unref()'d so they can't hold the process open, but clear them anyway so
      // a retry can't fire mid-shutdown.
      for (const { timer } of backgroundDeleteRetries.values()) clearTimeout(timer);
      backgroundDeleteRetries.clear();
      // Krok 2/3: cancel pending shell-triggered git refresh timers too.
      for (const timer of gitRefreshDebounceMap.values()) clearTimeout(timer);
      gitRefreshDebounceMap.clear();
      if (reviewBridgeWatcher) {
        reviewBridgeWatcher.close();
        reviewBridgeWatcher = null;
      }
      if (reviewBridgePoll) {
        clearInterval(reviewBridgePoll);
        reviewBridgePoll = null;
      }
      if (notifyLeaseTimer) {
        clearInterval(notifyLeaseTimer);
        notifyLeaseTimer = null;
      }
      azure.stopPolling();
      github.stopPolling();
      telegramManager.stop();
      await mobileManager.stop();
      // The account's own timers: a poll waiting on a sign-in link, and the retention timer that
      // would otherwise fire into a manager whose process is going away. Neither can hold the process
      // open (both are unref'd), but a shutdown that leaves an attempt "in progress" is a shutdown
      // that resumes into a stale one — plan §9: "Restart, shutdown a změna konfigurace uklidí pending
      // flow, časovače i owner retenci."
      accountManager.dispose();
      startInstallationTokenRefresh = null;
      installationTokenRefresh?.stop();
      emailSignInBroker?.dispose();
      // The relay's own listener and outbound socket are not the mobile manager's to close, and a
      // process that exits with either still open leaves a bound loopback port behind.
      await mobileRelayManager?.stop().catch(() => undefined);
      await tunnel.stop({ preserveAvailability: true, quiet: true });
      await pluginManager.stopAll();
      sessions.stopAll();
      await reviewBridgeStore.close?.();
      auditLogStore.close?.();
      githubAuditLogStore.close?.();
      gitAuditLogStore.close?.();
      telegramAuditLogStore.close?.();
      approvalAuditLogStore.close?.();
      mobileAuditLogStore.close?.();
      mobileIdempotencyStore.close?.();
      // State is already persisted on each mutate/replace operation.
      // Avoid rewriting the file on shutdown, which can overwrite newer
      // on-disk state if another instance touched it more recently.
      // DO wait for any in-flight persist though — exiting between its
      // tmp-write and rename leaves a full-content orphan .tmp file and a
      // stale state file (observed on quit in production). Time-capped so
      // a stuck persist queue can't hold the quit hostage.
      let flushed = false;
      await Promise.race([
        store.flush().then(() => {
          flushed = true;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
      if (!flushed) {
        log.warn("state flush did not settle within 5s on shutdown — persist queue stuck?");
      }
      return undefined;
    },
    listRemoteUrls() {
      return remoteInfo?.urls || [];
    },

    /**
     * Every origin a mobile WebView ticket may be redeemed at on the LAN/tunnel server right now.
     *
     * Three sources, because a desktop can be reachable through all three at once: the URLs the
     * server actually bound, the live quick-tunnel URL, and the operator's configured custom public
     * URL. Only the ORIGIN of each is kept — a ticket is bound to an origin, not to a path or a
     * `?token=` query — and the list is recomputed per call, which is the property that matters: a
     * quick tunnel that has been replaced drops out of it, so a ticket minted for the old one stops
     * being redeemable instead of working against the new one (production hardening §5 "Ticket" 4).
     */
    listMobileTicketOrigins() {
      const remoteAccess = getState().settings.remoteAccess;
      // `remoteInfo` is the loosely-typed bag `setRemoteInfo` last wrote, so the URL list is narrowed
      // here rather than assumed — a bag that lost its shape must produce no origins, not a crash.
      const bound = Array.isArray(remoteInfo?.["urls"]) ? (remoteInfo["urls"] as unknown[]) : [];
      const candidates = [
        ...bound.filter((entry): entry is string => typeof entry === "string"),
        tunnel.getSnapshot().publicUrl || "",
        remoteAccess.customPublicUrl || "",
      ];
      const origins = new Set<string>();
      for (const candidate of candidates) {
        if (!candidate) continue;
        try {
          origins.add(new URL(candidate).origin);
        } catch {
          // Not a URL: it cannot be an origin a browser reached, so it cannot match one either.
        }
      }
      return [...origins];
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSessionId(workspaceId: any, panelId: any) {
      return createSessionId(workspaceId, panelId);
    },
    async checkForUpdates() {
      const result = await versionChecker.checkForUpdates(true);
      broadcastState();
      return result;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async checkCommand(command: any) {
      try {
        const cmd = process.platform === "win32" ? "where" : "which";
        await execFileText(cmd, [command], { timeout: 5000 });
        return true;
      } catch (err) {
        log.debug("checkCommand: not found", {
          command,
          err: (err as any)?.error?.message || (err as Error).message || "unknown", // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: error shape is unknown at catch boundary
        });
        return false;
      }
    },

    // Task runner API (recheckClaude, checkProviders, checkIsGitRepo,
    // probeDirectory, createTaskWorkspace, start/stop/pause/resume/reset-task,
    // updateTaskDescription, rejectTaskVerdict, resendTaskInstruction,
    // getTaskStatus, resolveTaskRecovery) provided by taskHandlers (spread above)
  };

  // Telegram "Reconnect tunnel" (🔁 button / `/tunnel reconnect`). Re-uses the
  // exact createCloudflareTunnel flow the desktop UI calls (bind-check, origin
  // probe, error surfacing), but is additionally gated on autoTunnel so a chat
  // can only re-establish a tunnel the user already had running — never turn
  // on brand-new public exposure. The manager checks `canReconnect` from the
  // tunnel-info getter before offering the button; this re-check covers stale
  // buttons and the typed-command path.
  telegramManager.setTunnelReconnectHandler(async () => {
    const remoteConfig = getState().settings.remoteAccess;
    if (!canReconnectTunnel(remoteConfig)) {
      throw new Error("Tunnel reconnect is only available after a Cloudflare tunnel was started from the desktop.");
    }
    await returnObj.createCloudflareTunnel();
  });

  _rt = returnObj;
  return returnObj;
}

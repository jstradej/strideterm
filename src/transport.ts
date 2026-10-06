import type {
  StridetermAPI,
  StatePayload,
  TerminalSize,
  TerminalDataPayload,
  TerminalReplayPayload,
  TerminalExitPayload,
  GitPushProgressPayload,
} from "../electron/shared/ipc-bridge.js";
import type { RemoteStateV2, RecoveryResult } from "../electron/shared/types/state.js";
import type { ProfilePayload } from "../electron/backend/ipc-schemas.js";
import type {
  SshAuthRequest,
  SshAuthPromptCancel,
  SshConnectionState,
  SshConnectionTestState,
  SshKey,
  SshKeyTransferState,
} from "../electron/shared/types/ssh.js";
import type { SshRuntimeCapabilities } from "../electron/shared/ssh-connection.js";
import {
  APPROVAL_RECORDED_CHANNEL,
  approvalRecordedSchema,
  type ApprovalRecorded,
} from "../electron/shared/approval-events.js";
import { mobileSessionStartedSchema, type MobileSessionStarted } from "../electron/shared/mobile-session-events.js";
import {
  NOTIFICATION_TARGET_REMOVED_CHANNEL,
  notificationTargetRemovedSchema,
  type NotificationTargetRemoved,
} from "../electron/shared/notification-lifecycle.js";
import {
  performanceSnapshotSchema,
  cpuProfileCaptureResultSchema,
  revealResultSchema,
} from "../electron/shared/performance.js";
import { rlog } from "./lib/renderer-log.js";
import {
  normalizeAttachmentList,
  type AttachmentDeleteRequest,
  type AttachmentDeleteResult,
  type AttachmentWorkspaceRequest,
  type AttachmentRecord,
} from "./attachments.js";

/**
 * The state shape a client actually receives: the full desktop `StatePayload`
 * over Electron IPC / a legacy remote page, OR the slim `RemoteStateV2` core over
 * the protocol-2 remote transport. The remote transport is honest about this —
 * it does NOT cast the slim core to `StatePayload`; the app store adapts either
 * shape through its transport-aware accessors (one adaptive renderer).
 */
export type CoreState = StatePayload | RemoteStateV2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Handler<T> = (payload: T) => void;

interface ConnectionStatePayload {
  connected: boolean;
  message?: string;
  /** What to do about it, when there is something to do. See `createRemoteIssue`. */
  hint?: string;
  code?: number;
  reconnecting?: boolean;
  reconnected?: boolean;
  attempt?: number;
  /** Epoch ms when the scheduled reconnect attempt will begin. */
  reconnectAt?: number;
}

export interface RemotePanelSelectionDetail {
  profileId: string;
  workspaceId: string;
  panelId: string;
  handled: boolean;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

export type SshTestStatus = SshConnectionTestState["status"];
export type SshTestStatePayload = SshConnectionTestState;

const REMOTE_PANEL_SELECTION_EVENT = "strideterm:remote-select-panel";
const REMOTE_PANEL_SELECTION_READY_EVENT = "strideterm:remote-panel-selection-ready";
const REMOTE_PANEL_SELECTION_READY_TIMEOUT_MS = 5_000;

/** A slim-core detail resource fetched on demand (git snapshot, docker state,
 *  provider inbox / PR detail, review-bridge context). */
export interface ResourceDetail {
  resource: string;
  revision: string;
  data: unknown;
}

/** Server push: an interested detail resource changed to `revision`. */
export interface ResourceInvalidate {
  resource: string;
  revision: string;
}

interface EventHub {
  stateUpdated: Set<Handler<CoreState>>;
  terminalData: Set<Handler<TerminalDataPayload>>;
  terminalReplay: Set<Handler<TerminalReplayPayload>>;
  terminalExit: Set<Handler<TerminalExitPayload>>;
  terminalRemoved: Set<Handler<{ sessionId: string }>>;
  gitPushProgress: Set<Handler<GitPushProgressPayload>>;
  connectionState: Set<Handler<ConnectionStatePayload>>;
  sshAuthPrompt: Set<Handler<SshAuthRequest>>;
  sshAuthPromptCancel: Set<Handler<SshAuthPromptCancel>>;
  sshHostKeyChange: Set<Handler<Record<string, unknown>>>;
  sshState: Set<Handler<Record<string, unknown>>>;
  sshConnectionState: Set<Handler<SshConnectionState>>;
  sshTestState: Set<Handler<SshTestStatePayload>>;
  sshKeyTransferState: Set<Handler<SshKeyTransferState>>;
  dockerLogsWrite: Set<Handler<{ sessionId: string; data: string }>>;
  dockerLogsClose: Set<Handler<{ sessionId: string; code: number | null }>>;
  dockerShellData: Set<Handler<{ sessionId: string; data: string }>>;
  dockerShellClose: Set<Handler<{ sessionId: string; code: number | null }>>;
  terminalInputBlocked: Set<Handler<{ sessionId: string; ownerLabel: string }>>;
  resourceInvalidate: Set<Handler<ResourceInvalidate>>;
  notificationTargetRemoved: Set<Handler<NotificationTargetRemoved>>;
  approvalRecorded: Set<Handler<ApprovalRecorded>>;
}

/** Extended transport interface covering both Electron and remote modes.
 *  Intentionally a superset of StridetermAPI where both transports overlap;
 *  Electron-only methods (browseDirectory, showSystemNotification, etc.) are
 *  not present in the remote transport and are therefore excluded.
 */
export interface Transport extends Partial<
  Omit<StridetermAPI, "onConnectionState" | "getState" | "onStateUpdated" | "attachmentList" | "attachmentDelete">
> {
  isRemote: boolean;
  /** Runtime platform and SSH administration capabilities. */
  sshCapabilitiesGet?: () => Promise<SshRuntimeCapabilities>;
  sshTestStart?: (payload: { profileId: string; draft: Record<string, unknown> }) => Promise<{
    sessionId: string;
    mode: SshTestStatePayload["mode"];
    status: SshTestStatus;
  }>;
  sshTestStop?: (payload: { sessionId: string }) => Promise<{ ok: boolean }>;
  onSshTestState?: (handler: Handler<SshTestStatePayload>) => void;
  /** Native mobile host directory picker. Absent in ordinary browser tabs. */
  browseDirectory?: (initialPath?: string) => Promise<unknown>;
  /** Manual state refresh — refetches /api/state and broadcasts the result.
   * Provided by the remote transport (no-op or absent for the Electron one,
   * where state is push-updated). Used by the mobile pull-up-to-refresh
   * gesture. */
  refresh?: () => Promise<void>;
  getRemoteToken: () => string;
  setRemoteToken: (token: string) => void;
  onConnectionState: (handler: Handler<ConnectionStatePayload>) => void;
  /** Legacy reset method not yet promoted to StridetermAPI */
  resetAgentPrompts?: () => Promise<unknown>;
  // Core required methods:
  getState: () => Promise<CoreState>;
  onStateUpdated: (handler: (payload: CoreState) => void) => void;
  onTerminalData: (handler: (payload: TerminalDataPayload) => void) => void;
  /** Server-pushed replay for a newly subscribed session (remote only). */
  onTerminalReplay: (handler: (payload: TerminalReplayPayload) => void) => void;
  onTerminalExit: (handler: (payload: TerminalExitPayload) => void) => void;
  /** Server-pushed notice that an id was dropped from this socket's live routing
   *  set (panel removed). Remote-only; lets the client forget the id and
   *  re-subscribe if a same-id panel is recreated. Absent on the Electron
   *  transport (IPC streams everything). */
  onTerminalRemoved?: (handler: (payload: { sessionId: string }) => void) => void;
  /** Declare the complete set of terminal sessions this client renders.
   *  Idempotent; remote-only (a no-op on the Electron transport). */
  subscribeTerminals: (sessionIds: string[]) => void;
  /** Declare the complete set of slim-core DETAIL resources this client renders
   *  (mounted git/docker/inbox/review panes). Idempotent; remote-only. The
   *  server pushes resource:invalidate for changed/new ones. */
  subscribeResources?: (resources: string[]) => void;
  /** Server-pushed notice that an interested detail resource changed. Remote-only. */
  onResourceInvalidate?: (handler: Handler<ResourceInvalidate>) => void;
  /** Fetch one detail resource on demand ({ resource, revision, data }). Remote-only. */
  fetchResourceDetail?: (resource: string) => Promise<ResourceDetail | null>;
  resizeTerminal: (sessionId: string, size: TerminalSize) => void;
  /**
   * `originWorkspaceId` names the workspace whose UI the user typed in — a
   * hint the backend validates against the session before crediting it with
   * work (an attached task's Primary tab lives in the task workspace while
   * its session id names the source workspace).
   */
  writeTerminal: (sessionId: string, data: string, originWorkspaceId?: string) => void;
  /** Take over the per-session input lease ("Take control?" confirmation). */
  takeSessionControl: (sessionId: string) => Promise<{ ok: boolean }>;
  /** Fired when typed input was blocked because another viewer holds the input lease. */
  onTerminalInputBlocked: (handler: Handler<{ sessionId: string; ownerLabel: string }>) => void;
  activateWorkspace: (workspaceId: string) => Promise<unknown>;
  restartTerminal: (sessionId: string) => Promise<unknown>;
  getTerminalReplay: (sessionId: string) => Promise<TerminalReplayPayload>;
  regenerateRemoteToken: () => Promise<unknown>;
  saveProfile: (profile: ProfilePayload) => Promise<unknown>;
  deleteProfile: (profileId: string, options?: { taskAction?: "pause" | "stop" }) => Promise<unknown>;
  activateProfile: (profileId: string) => Promise<unknown>;
  /** Authoritative notice that a workspace or panel was removed from state, so
   *  its notification history can be dropped. Validated at this boundary, so a
   *  handler only ever sees a well-formed payload. */
  onNotificationTargetRemoved: (handler: Handler<NotificationTargetRemoved>) => void;
  /** strIDEterm approved a permission prompt on the user's behalf. Validated at
   *  this boundary too, so a handler only ever sees a well-formed payload. */
  onApprovalRecorded: (handler: Handler<ApprovalRecorded>) => void;
  /** A paired phone opened a session (desktop only). Validated at this boundary. */
  onMobileSessionStarted?: (handler: Handler<MobileSessionStarted>) => void;
  attachmentList?: (payload: AttachmentWorkspaceRequest) => Promise<AttachmentRecord[]>;
  attachmentDelete?: (payload: AttachmentDeleteRequest) => Promise<AttachmentDeleteResult>;
}

/** The transport as the stores call it: every method treated as present. A
 *  missing method still throws at the call site, as the `AnyApi` casts this
 *  replaces did, but payloads are now checked against the IPC bridge types —
 *  so a payload the main process's zod schema refuses (a vote sent as "10")
 *  fails the typecheck instead of failing silently at runtime. */
export type CallableTransport = Required<Transport>;

/** First argument of a transport method — for store actions that forward a
 *  payload unchanged, so their parameter is the IPC contract itself. */
export type TransportPayload<K extends keyof CallableTransport> = CallableTransport[K] extends (
  ...args: infer A
) => unknown
  ? A[0]
  : never;

// ---------------------------------------------------------------------------

function createEventHub(): EventHub {
  return {
    stateUpdated: new Set(),
    terminalData: new Set(),
    terminalReplay: new Set(),
    terminalExit: new Set(),
    terminalRemoved: new Set(),
    gitPushProgress: new Set(),
    connectionState: new Set(),
    sshAuthPrompt: new Set(),
    sshAuthPromptCancel: new Set(),
    sshHostKeyChange: new Set(),
    sshState: new Set(),
    sshConnectionState: new Set(),
    sshTestState: new Set(),
    sshKeyTransferState: new Set(),
    dockerLogsWrite: new Set(),
    dockerLogsClose: new Set(),
    dockerShellData: new Set(),
    dockerShellClose: new Set(),
    terminalInputBlocked: new Set(),
    resourceInvalidate: new Set(),
    notificationTargetRemoved: new Set(),
    approvalRecorded: new Set(),
  };
}

function createRemoteClientId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
      .slice(8, 10)
      .join("")}-${hex.slice(10, 16).join("")}`;
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Map a slim-core resource key to the HTTP detail endpoint that serves it.
 * Mirrors the DETAIL_ROUTES table in remote-server.ts. Returns null for an
 * unknown key. prKeys may contain colons, so only the leading segment is the
 * type.
 */
function detailEndpointFor(resource: string): string | null {
  if (resource === "docker") return "/api/docker/detail";
  if (resource === "azure-inbox") return "/api/azure/inbox";
  if (resource === "github-inbox") return "/api/github/inbox";
  if (resource === "agent-prompts") return "/api/review-bridge/agent-prompts";
  const idx = resource.indexOf(":");
  if (idx < 0) return null;
  const type = resource.slice(0, idx);
  const id = resource.slice(idx + 1);
  if (!id) return null;
  const q = encodeURIComponent(id);
  switch (type) {
    case "git":
      return `/api/git/workspace-detail?workspaceId=${q}`;
    case "azure-pr":
      return `/api/azure/pull-request-detail?prKey=${q}`;
    case "github-pr":
      return `/api/github/pull-request-detail?prKey=${q}`;
    case "review-bridge":
      return `/api/review-bridge/pull-request?prKey=${q}`;
    default:
      return null;
  }
}

function bindElectronTransport(): Transport {
  const electronAttachments = window.strideterm as unknown as {
    attachmentList: (payload: AttachmentWorkspaceRequest) => Promise<unknown>;
    attachmentDelete: (payload: AttachmentDeleteRequest) => Promise<unknown>;
  };
  return {
    ...window.strideterm,
    isRemote: false,
    getRemoteToken: () => "",
    setRemoteToken: () => {},
    regenerateRemoteToken: () => window.strideterm.regenerateRemoteToken(),
    saveProfile: (profile: ProfilePayload) => window.strideterm.saveProfile(profile),
    deleteProfile: (profileId: string, options?: { taskAction?: "pause" | "stop" }) =>
      window.strideterm.deleteProfile(profileId, options),
    activateProfile: (profileId: string) => window.strideterm.activateProfile(profileId),
    attachmentList: async (payload) => normalizeAttachmentList(await electronAttachments.attachmentList(payload)),
    attachmentDelete: async (payload) => {
      const result = await electronAttachments.attachmentDelete(payload);
      if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true) {
        throw new Error("Invalid attachment delete response");
      }
      return { ok: true };
    },
    onConnectionState: () => {},
    // Performance diagnostics: validate the main-process response at the IPC
    // boundary so a malformed snapshot surfaces as a controlled error instead
    // of a runtime crash deep in the panel's chart code.
    getPerformanceSnapshot: async () =>
      performanceSnapshotSchema.parse(await window.strideterm.getPerformanceSnapshot()),
    captureRendererCpuProfile: async () =>
      cpuProfileCaptureResultSchema.parse(await window.strideterm.captureRendererCpuProfile()),
    revealCpuProfile: async (filePath: string) =>
      revealResultSchema.parse(await window.strideterm.revealCpuProfile(filePath)),
    // Electron streams every session over IPC and repaints on attach via the
    // IPC getTerminalReplay; the WS subscribe/replay handshake is remote-only.
    onTerminalReplay: () => {},
    subscribeTerminals: () => {},
    // Validated here for the same reason the remote transport validates it: a
    // malformed payload must be dropped at the boundary rather than reaching a
    // store action that would delete the wrong history.
    onNotificationTargetRemoved: (handler: Handler<NotificationTargetRemoved>) => {
      window.strideterm.onNotificationTargetRemoved((payload: unknown) => {
        const parsed = notificationTargetRemovedSchema.safeParse(payload);
        if (!parsed.success) {
          rlog("warn", "notification:target-removed ignored: malformed payload");
          return;
        }
        handler(parsed.data);
      });
    },
    onApprovalRecorded: (handler: Handler<ApprovalRecorded>) => {
      window.strideterm.onApprovalRecorded?.((payload: unknown) => {
        const parsed = approvalRecordedSchema.safeParse(payload);
        if (!parsed.success) {
          rlog("warn", "approval:recorded ignored: malformed payload");
          return;
        }
        handler(parsed.data);
      });
    },
    onMobileSessionStarted: (handler: Handler<MobileSessionStarted>) => {
      window.strideterm.onMobileSessionStarted?.((payload: unknown) => {
        const parsed = mobileSessionStartedSchema.safeParse(payload);
        if (!parsed.success) {
          rlog("warn", "mobile:session-started ignored: malformed payload");
          return;
        }
        handler(parsed.data);
      });
    },
  };
}

export function createRemoteTransport(): Transport {
  const listeners = createEventHub();
  const query = new URLSearchParams(window.location.search);
  let token = query.get("token") || window.sessionStorage.getItem("strideterm-token") || "";
  const clientIdStorageKey = "strideterm-remote-client-id";
  let remoteClientId = window.sessionStorage.getItem(clientIdStorageKey) || "";
  if (!remoteClientId) {
    remoteClientId = createRemoteClientId();
    window.sessionStorage.setItem(clientIdStorageKey, remoteClientId);
  }

  function persistToken(nextToken: string): void {
    token = String(nextToken || "").trim();
    if (token) {
      window.sessionStorage.setItem("strideterm-token", token);
      query.set("token", token);
      window.history.replaceState({}, "", `${window.location.pathname}?${query.toString()}`);
      return;
    }

    window.sessionStorage.removeItem("strideterm-token");
    query.delete("token");
    window.history.replaceState({}, "", window.location.pathname);
  }

  if (token) {
    persistToken(token);
  }

  const mobileHost = (window as unknown as Record<string, unknown>).StridetermHost as
    { postMessage?: (message: string) => void } | undefined;

  type SessionLostReason = "expired" | "revoked" | "superseded" | "unauthorized" | "unknown";
  let lastPostedConnectionState = "";
  function emitConnectionState(payload: ConnectionStatePayload): void {
    listeners.connectionState.forEach((handler) => handler(payload));
    const hostPayload = {
      type: "connection-state",
      connected: payload.connected,
      reconnecting: Boolean(payload.reconnecting),
      ...(typeof payload.attempt === "number" && Number.isFinite(payload.attempt)
        ? { attempt: Math.max(0, Math.min(1_000, Math.trunc(payload.attempt))) }
        : {}),
      ...(typeof payload.code === "number" && Number.isFinite(payload.code) ? { code: Math.trunc(payload.code) } : {}),
    };
    const serialized = JSON.stringify(hostPayload);
    if (serialized !== lastPostedConnectionState) {
      lastPostedConnectionState = serialized;
      postHost(hostPayload);
    }
  }

  interface RemoteIssueOptions {
    kind?: string;
    statusCode?: number;
    rawMessage?: string;
    recoverable?: boolean;
  }

  interface RemoteError extends Error {
    isRemoteTransport: boolean;
    statusCode: number;
    kind: string;
    recoverable: boolean;
    rawMessage: string;
    /** What to do about it, when there is something to do. Empty when there is not. */
    hint: string;
  }

  /**
   * The server answers every failure as `{"error":"<sentence>"}` — see `json()` in
   * `electron/backend/remote-server.ts`. This pulls the sentence out.
   *
   * WHY IT HAS TO. The HTTP path passes `await response.text()` as `rawMessage`, i.e. the whole
   * response BODY, and any status without its own branch below fell straight through to
   * `message = rawMessage`. So the banner rendered the raw envelope —
   * `{"error":"Mobile sessions cannot switch profiles"}` — braces, quotes and all, as one unbroken
   * token that a phone-width column cannot wrap. Three problems in one string: it looks like the app
   * leaked its plumbing, it stretches the layout, and the one part a person can act on is buried in
   * punctuation.
   *
   * Anything that is not that shape is returned unchanged, so a plain-text body, a proxy's HTML
   * error page or an empty body all behave exactly as before.
   */
  function unwrapServerError(rawBody: string): string {
    const trimmed = String(rawBody || "").trim();
    if (!trimmed.startsWith("{")) return trimmed;
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
      const sentence = parsed?.error ?? parsed?.message;
      return typeof sentence === "string" && sentence.trim() ? sentence.trim() : trimmed;
    } catch {
      // Body that starts like JSON and is not. Better the raw text than nothing.
      return trimmed;
    }
  }

  /**
   * Turns a transport failure into something a person can read and act on.
   *
   * Two fields, deliberately. `message` says what happened; `hint` says what to do about it, and is
   * empty when there is genuinely nothing — a banner that ends every failure with advice is a banner
   * whose advice stops being read. The 403 below is the case that prompted all of this: it is the
   * server refusing a profile switch inside a mobile session (by design — the ticket is minted for
   * one profile), and the phone's own menu is where that switch actually lives.
   */
  function createRemoteIssue({
    kind,
    statusCode = 0,
    rawMessage = "",
    recoverable = true,
  }: RemoteIssueOptions = {}): RemoteError {
    const normalizedMessage = unwrapServerError(rawMessage);
    let message = normalizedMessage;
    let hint = "";

    if (statusCode === 401) {
      message = "Remote token is missing or invalid.";
      hint = "Open this terminal again from the strIDEterm app to get a fresh one.";
    } else if (statusCode === 403 && /cannot switch profiles/i.test(normalizedMessage)) {
      // Not a fault, and the old banner made it look like one. Each mobile session is scoped to the
      // profile its ticket was minted for, so the switch is a new session rather than a request.
      message = "This session is tied to one profile.";
      hint = "Pick the other profile in the strIDEterm app — pull down the handle at the top of the screen.";
    } else if (statusCode === 403) {
      message = normalizedMessage || "The desktop refused that.";
      hint = "This phone may not be approved for it. Check the pairing on the desktop.";
    } else if (statusCode === 530 || /origin has been unregistered from argo tunnel/i.test(normalizedMessage)) {
      message = "Cloudflare tunnel is no longer connected to the desktop app.";
      hint = "Recreate the tunnel from the desktop app.";
    } else if ([502, 503, 504].includes(statusCode)) {
      message = "Remote workspace is temporarily unavailable. The desktop app or its local server may be restarting.";
      hint = "It should come back on its own. Reconnect if it does not.";
    } else if (kind === "ws-closed" || kind === "ws-error") {
      message = "Remote connection was lost. The desktop app or tunnel may have stopped.";
    } else if (kind === "network") {
      message = "Cannot reach the desktop right now.";
      hint = "Check that strIDEterm is running there and that this device is online.";
    } else if (!message) {
      message = "Remote connection failed.";
    }

    const error = new Error(message) as RemoteError;
    error.isRemoteTransport = true;
    error.statusCode = statusCode;
    error.kind = kind || "request-failed";
    error.recoverable = recoverable;
    error.rawMessage = normalizedMessage;
    error.hint = hint;
    return error;
  }

  interface WsMessage {
    type: string;
    sessionId?: string;
    cols?: number;
    rows?: number;
    data?: string;
    sessionIds?: string[];
    resources?: string[];
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const reconnectBaseDelayMs = 500;
  const reconnectMaxDelayMs = 10_000;
  const webSocketConnectTimeoutMs = 10_000;
  const maxConsecutiveConnectTimeouts = 3;
  // An upgrade the server refuses can still look like a socket that OPENED: behind the phone's e2e
  // proxy the upgrade is accepted locally and closed afterwards ("unauthorized"). So "open" is not
  // evidence of a healthy connection. A socket counts as healthy once the server has said something
  // or it has stayed up this long; only then is the reconnect backoff / auth-close count forgiven.
  const webSocketStableMs = 5_000;
  const maxConsecutiveAuthCloses = 3;
  const pendingWsMessages: WsMessage[] = [];
  let ws: WebSocket | null = null;
  let reconnectTimer = 0;
  let webSocketConnectTimer = 0;
  let reconnectAttempt = 0;
  let consecutiveConnectTimeouts = 0;
  let consecutiveAuthCloses = 0;
  let openedOnce = false;
  const WAKE_PROBE_ATTEMPTS = 3;
  const WAKE_PROBE_TIMEOUT_MS = 2_500;
  const WAKE_PROBE_RETRY_DELAYS_MS = [250, 500];
  let wakeProbeEpoch = 0;
  let activeWakeProbe: { epoch: number; controller: AbortController | null } | null = null;
  // The complete set of terminal sessions this client currently renders. We
  // remember it so the subscription can be re-sent verbatim after every
  // reconnect (the server drops per-socket subscriptions on close). Empty until
  // the visibility owner sends the first set, so the socket stays in the
  // server's legacy (full-broadcast) mode until then.
  let lastTerminalSubscription: string[] = [];
  let hasSubscribedTerminals = false;
  // The complete set of slim-core detail resources this client currently
  // renders — re-sent verbatim after every reconnect (the server drops
  // per-socket interests on close), so a fresh socket re-primes its
  // invalidations. Empty until the first pane declares interest.
  let lastResourceInterest: string[] = [];
  let hasDeclaredInterest = false;

  // Slim-core protocol version this client speaks. Advertised on the WS upgrade
  // (?sp=) and every HTTP request (X-Strideterm-State-Protocol), so the server
  // serves this tab the RemoteStateV2 core + detail resources rather than a full
  // desktop payload.
  const STATE_PROTOCOL = 2;
  // Capabilities this client can use. Advertised alongside the protocol version
  // (WS `?caps=`, HTTP `X-Strideterm-Capabilities`); the server intersects them
  // with what it supports and selects the response contract accordingly.
  const STATE_CAPABILITIES = ["remote-core-v2", "resource-details-v1"];
  // Highest coreRevision this client has received (bootstrap or WS). Echoed back
  // on the WS `?rev=` so a reconnecting socket only gets a catch-up when the
  // server has newer state (bootstrap→WS handoff). -1 until the first snapshot.
  let lastCoreRevision = -1;
  let selectedProfileId: string | null = null;
  let selectedWorkspaceId: string | null = null;
  let cancelActiveBrowse: (() => void) | null = null;
  // The FIRST WS is created synchronously at construction — before the HTTP
  // bootstrap has recorded a revision — so its URL cannot carry `?rev=` and the
  // server holds bootstrap-once. Once we DO have a revision we send it as a
  // `state:sync` message so the server catches us up on anything that changed in
  // the [bootstrap, WS-open] window (no missed-update gap). Reconnects carry
  // `?rev=` in the URL, so this one-shot handoff only covers the first socket.
  let firstSocketNeedsSync = true;
  function maybeSendStateSync(): void {
    if (!firstSocketNeedsSync || lastCoreRevision < 0) return;
    const current = ws;
    if (current?.readyState !== WebSocket.OPEN) return;
    firstSocketNeedsSync = false;
    current.send(JSON.stringify({ type: "state:sync", rev: lastCoreRevision }));
  }
  function postHost(message: Record<string, unknown>): void {
    const host = (window as unknown as Record<string, unknown>).StridetermHost as
      { postMessage?: (message: string) => void } | undefined;
    try {
      host?.postMessage?.(JSON.stringify(message));
    } catch {
      /* The native viewer may have closed. */
    }
  }

  function noteCoreRevision(state: unknown): void {
    const selection = (
      state as {
        remoteClient?: {
          profileId?: string;
          activeWorkspaceId?: string;
          activeViewId?: string | null;
          activeSessionId?: string | null;
        };
      }
    )?.remoteClient;
    const nextProfileId = typeof selection?.profileId === "string" && selection.profileId ? selection.profileId : null;
    const nextWorkspaceId =
      typeof selection?.activeWorkspaceId === "string" && selection.activeWorkspaceId
        ? selection.activeWorkspaceId
        : null;
    if (cancelActiveBrowse && (nextProfileId !== selectedProfileId || nextWorkspaceId !== selectedWorkspaceId)) {
      cancelActiveBrowse();
    }
    selectedProfileId = nextProfileId;
    selectedWorkspaceId = nextWorkspaceId;
    const appState = (state as { appState?: { workspaces?: unknown } })?.appState;
    const workspaces = Array.isArray(appState?.workspaces) ? appState.workspaces : [];
    const activeWorkspace = selection?.activeWorkspaceId
      ? (workspaces.find((workspace) => {
          const candidate = workspace as { id?: unknown };
          return candidate?.id === selection.activeWorkspaceId;
        }) as { name?: unknown; panels?: unknown[] } | undefined)
      : undefined;
    const workspaceName =
      typeof activeWorkspace?.name === "string" && activeWorkspace.name.trim()
        ? activeWorkspace.name.trim()
        : undefined;
    const activeViewId =
      typeof selection?.activeViewId === "string" && selection.activeViewId
        ? selection.activeViewId
        : typeof selection?.activeSessionId === "string"
          ? selection.activeSessionId
          : "";
    const candidatePanelId =
      nextWorkspaceId && activeViewId.startsWith(`${nextWorkspaceId}:`)
        ? activeViewId.slice(nextWorkspaceId.length + 1)
        : "";
    const activePanel = candidatePanelId
      ? (activeWorkspace?.panels?.find((panel) => (panel as { id?: unknown }).id === candidatePanelId) as
          { title?: unknown } | undefined)
      : undefined;
    const panelId = activePanel ? candidatePanelId : "";
    const panelName =
      typeof activePanel?.title === "string" && activePanel.title.trim() ? activePanel.title.trim() : undefined;
    if (selection?.profileId)
      postHost({
        type: "selection-changed",
        profileId: selection.profileId,
        workspaceId: selection.activeWorkspaceId || null,
        ...(workspaceName ? { workspaceName } : {}),
        ...(panelId ? { panelId } : {}),
        ...(panelName ? { panelName } : {}),
      });
    const rev = (state as { coreRevision?: unknown })?.coreRevision;
    if (typeof rev === "number" && rev > lastCoreRevision) lastCoreRevision = rev;
    // A freshly-recorded revision may be the one the first socket was waiting to
    // hand off (bootstrap completed after the socket opened).
    maybeSendStateSync();
  }
  // Per-path ETag cache for GET revalidation (bootstrap /api/state + detail
  // refetches). We send If-None-Match and, on a 304, reuse the cached body — the
  // server skips re-serializing/re-sending an unchanged resource. Supplementary:
  // correctness never depends on it (a cache miss just refetches in full).
  const etagCache = new Map<string, { etag: string; body: unknown }>();

  function buildWsUrl(): string {
    // After the share-URL bootstrap, the token is gone from the URL and a
    // session cookie has taken over (server: SESSION_COOKIE_NAME). The
    // browser attaches that cookie to WS upgrade requests automatically,
    // so dropping the `?token=` segment is enough to keep working without
    // re-emitting the master token. External callers that still hold the
    // token (e.g. API clients) keep the old `?token=` form.
    const wsQuery = new URLSearchParams();
    if (token) wsQuery.set("token", token);
    wsQuery.set("clientId", remoteClientId);
    wsQuery.set("sp", String(STATE_PROTOCOL));
    wsQuery.set("caps", STATE_CAPABILITIES.join(","));
    // Only once we have a bootstrap revision — the first connect omits it so the
    // server holds bootstrap-once (no redundant initial frame) and lets the HTTP
    // /api/state bootstrap deliver the first snapshot.
    if (lastCoreRevision >= 0) wsQuery.set("rev", String(lastCoreRevision));
    const wsSuffix = wsQuery.toString();
    return `${protocol}//${window.location.host}/ws${wsSuffix ? `?${wsSuffix}` : ""}`;
  }

  function flushPendingWsMessages(): void {
    const current = ws;
    if (!current || current.readyState !== WebSocket.OPEN) {
      return;
    }
    while (pendingWsMessages.length > 0 && current.readyState === WebSocket.OPEN) {
      current.send(JSON.stringify(pendingWsMessages.shift()));
    }
  }

  /** The server explicitly ended this session (`closeSessionSockets`/idle expiry send 1008). */
  function isExplicitAuthClose(event: CloseEvent): boolean {
    return event.code === 1008;
  }

  /**
   * Maps the server's close reason (see `closeSessionSockets`/`endMobileSession`) onto the allowlist the
   * host is told. Unrecognised text collapses to `unknown` so nothing else crosses the channel.
   */
  function sessionLostReasonFromClose(reason: string | undefined): SessionLostReason {
    const text = reason || "";
    if (/revoked/i.test(text)) return "revoked";
    if (/superseded/i.test(text)) return "superseded";
    if (/expired/i.test(text)) return "expired";
    if (/unauthori[sz]ed/i.test(text)) return "unauthorized";
    return "unknown";
  }

  /** The upgrade was refused for lack of a session; the relay proxy reports it as a close reason. */
  function isUnauthorizedClose(event: CloseEvent): boolean {
    return /unauthori[sz]ed/i.test(event.reason || "");
  }

  function scheduleReconnect(error: RemoteError, code = 0): void {
    if (reconnectTimer) {
      return;
    }
    // A suspended client does not reconnect, and that is the whole point of suspending it: the mobile
    // app puts this page to sleep when it has been in the background past its grace period, and a
    // reconnect loop would keep the relay stream — and the mobile data — alive behind a screen nobody
    // is looking at (production hardening §5 "Session" 6).
    if (suspended) {
      emitConnectionState({ connected: false, reconnecting: false, message: SUSPENDED_MESSAGE, code });
      return;
    }
    reconnectAttempt += 1;
    const delay = Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * 2 ** Math.min(reconnectAttempt - 1, 5));
    const reconnectAt = Date.now() + delay;
    if (!activeWakeProbe) {
      emitConnectionState({
        connected: false,
        reconnecting: true,
        message: `${error.message} Reconnecting in ${Math.round(delay / 1000)}s...`,
        code,
        attempt: reconnectAttempt,
        reconnectAt,
      });
    }
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = 0;
      connectWebSocket();
    }, delay);
  }

  /** Invoke every listener for one event, isolating each call — a listener
   *  that throws must not stop the remaining listeners for the same event
   *  from running (Set#forEach would otherwise abort mid-iteration). */
  function safeDispatch<T>(handlers: Set<Handler<T>>, payload: T, label: string): void {
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        rlog("warn", `transport listener threw (${label})`, { err: (err as Error)?.message || String(err) });
      }
    }
  }

  function handleWsMessage(event: MessageEvent): void {
    let message: { type: string; payload: unknown };
    try {
      message = JSON.parse(event.data as string) as { type: string; payload: unknown };
    } catch (err) {
      // A tunnel/proxy in front of the WS can inject a non-JSON frame (e.g. an
      // HTML error body) — drop it instead of throwing and losing every
      // subsequent frame's listeners on this socket.
      rlog("warn", "WS message ignored: malformed JSON", { err: (err as Error)?.message || String(err) });
      return;
    }
    if (message.type === "state:updated") {
      emitConnectionState({ connected: true, message: "" });
      noteCoreRevision(message.payload);
      safeDispatch(listeners.stateUpdated, message.payload as CoreState, "stateUpdated");
    }
    if (message.type === "terminal:replay") {
      safeDispatch(listeners.terminalReplay, message.payload as TerminalReplayPayload, "terminalReplay");
    }
    if (message.type === "terminal:data") {
      safeDispatch(listeners.terminalData, message.payload as TerminalDataPayload, "terminalData");
    }
    if (message.type === "terminal:exit") {
      safeDispatch(listeners.terminalExit, message.payload as TerminalExitPayload, "terminalExit");
    }
    if (message.type === "git:push-progress") {
      safeDispatch(listeners.gitPushProgress, message.payload as GitPushProgressPayload, "gitPushProgress");
    }
    if (message.type === "terminal:removed") {
      const removedId = (message.payload as { sessionId?: string })?.sessionId || "";
      if (removedId) {
        // Forget it from our subscription memory BEFORE notifying listeners, so
        // the resync they trigger isn't suppressed by subscribeTerminals' own
        // idempotence guard (which compares against lastTerminalSubscription).
        lastTerminalSubscription = lastTerminalSubscription.filter((id) => id !== removedId);
        safeDispatch(listeners.terminalRemoved, { sessionId: removedId }, "terminalRemoved");
      }
    }
    if (message.type === NOTIFICATION_TARGET_REMOVED_CHANNEL) {
      const parsed = notificationTargetRemovedSchema.safeParse(message.payload);
      if (parsed.success) {
        safeDispatch(listeners.notificationTargetRemoved, parsed.data, "notificationTargetRemoved");
      } else {
        rlog("warn", "notification:target-removed ignored: malformed payload");
      }
    }
    if (message.type === APPROVAL_RECORDED_CHANNEL) {
      const parsed = approvalRecordedSchema.safeParse(message.payload);
      if (parsed.success) {
        safeDispatch(listeners.approvalRecorded, parsed.data, "approvalRecorded");
      } else {
        rlog("warn", "approval:recorded ignored: malformed payload");
      }
    }
    if (message.type === "ssh:auth-prompt") {
      safeDispatch(listeners.sshAuthPrompt, message.payload as SshAuthRequest, "sshAuthPrompt");
    }
    if (message.type === "ssh:auth-prompt-cancel") {
      safeDispatch(listeners.sshAuthPromptCancel, message.payload as SshAuthPromptCancel, "sshAuthPromptCancel");
    }
    if (message.type === "ssh:host-key-change") {
      safeDispatch(listeners.sshHostKeyChange, message.payload as Record<string, unknown>, "sshHostKeyChange");
    }
    if (message.type === "ssh:state") {
      safeDispatch(listeners.sshState, message.payload as Record<string, unknown>, "sshState");
    }
    if (message.type === "ssh:connection-state") {
      safeDispatch(listeners.sshConnectionState, message.payload as SshConnectionState, "sshConnectionState");
    }
    if (message.type === "ssh:test:state") {
      safeDispatch(listeners.sshTestState, message.payload as SshTestStatePayload, "sshTestState");
    }
    if (message.type === "docker:logs:write") {
      safeDispatch(
        listeners.dockerLogsWrite,
        message.payload as { sessionId: string; data: string },
        "dockerLogsWrite",
      );
    }
    if (message.type === "docker:logs:close") {
      safeDispatch(
        listeners.dockerLogsClose,
        message.payload as { sessionId: string; code: number | null },
        "dockerLogsClose",
      );
    }
    if (message.type === "docker:shell:data") {
      safeDispatch(
        listeners.dockerShellData,
        message.payload as { sessionId: string; data: string },
        "dockerShellData",
      );
    }
    if (message.type === "docker:shell:close") {
      safeDispatch(
        listeners.dockerShellClose,
        message.payload as { sessionId: string; code: number | null },
        "dockerShellClose",
      );
    }
    if (message.type === "terminal:input-blocked") {
      // Sent flat (no payload wrapper) — { type, sessionId, ownerLabel }.
      const blocked = message as unknown as { sessionId: string; ownerLabel: string };
      safeDispatch(
        listeners.terminalInputBlocked,
        { sessionId: blocked.sessionId || "", ownerLabel: blocked.ownerLabel || "another window" },
        "terminalInputBlocked",
      );
    }
    if (message.type === "resource:invalidate") {
      const payload = (message.payload || {}) as { resource?: string; revision?: string };
      if (payload.resource) {
        safeDispatch(
          listeners.resourceInvalidate,
          { resource: payload.resource!, revision: String(payload.revision || "") },
          "resourceInvalidate",
        );
      }
    }
  }

  function connectWebSocket(): void {
    const nextWs = new WebSocket(buildWsUrl());
    ws = nextWs;
    const connectTimeout = window.setTimeout(() => {
      if (ws !== nextWs || nextWs.readyState !== WebSocket.CONNECTING) return;
      webSocketConnectTimer = 0;
      consecutiveConnectTimeouts += 1;
      const error = createRemoteIssue({ kind: "ws-error", rawMessage: "WebSocket handshake timed out" });
      // Detach before close: browsers may deliver `close` synchronously or much later, and neither
      // path may schedule another reconnect on top of this timeout's single verdict.
      ws = null;
      try {
        nextWs.close();
      } catch {
        // Already gone.
      }
      if (consecutiveConnectTimeouts >= maxConsecutiveConnectTimeouts) {
        emitConnectionState({
          connected: false,
          reconnecting: false,
          message: error.message,
          code: 0,
          attempt: consecutiveConnectTimeouts,
        });
        return;
      }
      scheduleReconnect(error);
    }, webSocketConnectTimeoutMs);
    webSocketConnectTimer = connectTimeout;

    const clearConnectTimeout = () => {
      window.clearTimeout(connectTimeout);
      if (webSocketConnectTimer === connectTimeout) webSocketConnectTimer = 0;
    };

    let stableTimer = 0;
    const clearStableTimer = () => {
      if (stableTimer) window.clearTimeout(stableTimer);
      stableTimer = 0;
    };
    // The connection proved itself: forgive the backoff and the auth-close count.
    const markHealthy = () => {
      if (ws !== nextWs) return;
      clearStableTimer();
      reconnectAttempt = 0;
      consecutiveAuthCloses = 0;
    };

    nextWs.addEventListener("open", () => {
      if (ws !== nextWs) return;
      clearConnectTimeout();
      cancelWakeProbe();
      const reconnected = openedOnce;
      openedOnce = true;
      // reconnectAttempt is deliberately NOT reset here — see `webSocketStableMs`.
      consecutiveConnectTimeouts = 0;
      clearStableTimer();
      stableTimer = window.setTimeout(markHealthy, webSocketStableMs);
      emitConnectionState({ connected: true, message: "", reconnected });
      flushPendingWsMessages();
      // Re-send the full terminal subscription so the server rebuilds this
      // socket's filtered routing + replays each session. Only after the
      // visibility owner has subscribed at least once, so a fresh connection
      // stays in legacy mode until the app knows what's visible.
      if (hasSubscribedTerminals && nextWs.readyState === WebSocket.OPEN) {
        nextWs.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: lastTerminalSubscription }));
      }
      // Re-declare detail-resource interest so the server re-primes invalidations
      // for this fresh socket (interests are per-socket and dropped on close).
      if (hasDeclaredInterest && nextWs.readyState === WebSocket.OPEN) {
        nextWs.send(JSON.stringify({ type: "resource:interest", resources: lastResourceInterest }));
      }
      // First-connect bootstrap handoff: if we already hold a bootstrap revision,
      // tell the server so it catches us up on any change in the [bootstrap, open]
      // window that the rev-less first WS URL couldn't advertise.
      //
      // Reconnect resync is SINGLE-PATH: the fresh socket's URL already carries
      // `?rev=lastCoreRevision` (buildWsUrl, since we've bootstrapped), so the
      // server sends exactly one catch-up core when — and only when — its
      // revision differs from ours (newer state, OR a lower revision after a
      // server restart). We deliberately do NOT also `GET /api/state` here: that
      // would transfer the core a second time over HTTP on a stale reconnect
      // (plan success-criterion: "transferred once, not through both paths").
      // A no-change reconnect therefore transfers zero state bytes.
      maybeSendStateSync();
    });

    nextWs.addEventListener("message", (event) => {
      if (ws !== nextWs) return;
      markHealthy();
      handleWsMessage(event);
    });

    nextWs.addEventListener("close", (event: CloseEvent) => {
      if (ws !== nextWs) return;
      clearConnectTimeout();
      clearStableTimer();
      // A refused session is not a flaky network: the same verdict as an HTTP 401. The explicit
      // server close (1008) is decisive; the "unauthorized" reason is repeatable-by-accident so it
      // takes several in a row, with no healthy connection in between.
      if (isExplicitAuthClose(event)) {
        rlog("warn", "WebSocket closed by the server as a lost session", { code: event.code });
        reportSessionLost(sessionLostReasonFromClose(event.reason));
        return;
      }
      if (isUnauthorizedClose(event)) {
        consecutiveAuthCloses += 1;
        if (consecutiveAuthCloses >= maxConsecutiveAuthCloses) {
          rlog("warn", "WebSocket repeatedly refused as unauthorized; treating the session as lost", {
            closes: consecutiveAuthCloses,
          });
          reportSessionLost("unauthorized");
          return;
        }
      }
      const error = createRemoteIssue({
        kind: "ws-closed",
        rawMessage: event.reason || "",
      });
      scheduleReconnect(error, event.code || 0);
    });

    nextWs.addEventListener("error", () => {
      if (ws !== nextWs) return;
      if (activeWakeProbe) return;
      const error = createRemoteIssue({ kind: "ws-error" });
      emitConnectionState({
        connected: false,
        reconnecting: true,
        message: error.message,
        code: 0,
        attempt: reconnectAttempt + 1,
      });
    });
  }

  connectWebSocket();

  // --------------------------------------------------------------------
  // Host-driven suspend/resume (production hardening §5 "Session" 6).
  //
  // WHY THE HOST AND NOT `visibilitychange`. A WebView inside a backgrounded Android app is not a
  // hidden tab: the app is still running, the page is still live, and Android does not reliably
  // suspend a WebView's JavaScript or its sockets — so a terminal that is streaming output keeps
  // streaming it, over the relay, on the user's mobile data, behind a screen that is off. Only the
  // HOST knows the app went to the background and how long ago, and only the host knows its own grace
  // period, so the host is what decides.
  //
  // WHAT SUSPEND IS AND IS NOT. It closes the socket and stops reconnecting; it does NOT reload,
  // navigate, or clear anything. The page keeps its DOM and its stores, which is what lets a return
  // after a two-minute background be a reconnect rather than a fresh session — and what keeps the
  // half-typed command in the input bar. If the SESSION itself has expired in the meantime, `resume`
  // fails the ordinary way and the host re-bootstraps.
  //
  // The bridge is a small object on `window` because that is the surface a WebView host can call
  // (`runJavaScript`). It exposes exactly two verbs and one read; nothing here can send terminal
  // input, request a credential, or reach anything the page could not already reach.
  const SUSPENDED_MESSAGE = "Paused while the app is in the background.";
  /**
   * Two banners, because there are two readers and only one of them has a host behind them.
   *
   * On a phone the native app is watching (see `reportSessionLost`) and a new session is already on
   * its way, so the only useful thing to say is "wait". In a plain browser tab nothing is coming: the
   * person reading it IS the recovery mechanism, and telling them the app will handle it would be a
   * promise nobody kept.
   */
  const SESSION_LOST_HOSTED_MESSAGE = "Session ended. Reopening from the app…";
  const SESSION_LOST_MESSAGE = "Session ended. Reload this page to start a new one.";
  let suspended = false;
  /**
   * Latched the first time the server answers 401, cleared by a resume.
   *
   * WHAT THIS STOPS. A page whose session cookie is gone keeps polling: `/api/state` on every resume
   * probe, `/api/attention/sync` on every attention change, and a WebSocket that reconnects on a
   * backoff. Every one of those is a 401, and on a phone every one of them also reaches the host as
   * an HTTP error it has to decide about. That storm is what turned one lost cookie into a minute of
   * a dead terminal: the host tore down the very re-bootstrap that was in flight, over and over,
   * because the OLD page was still shouting at it. A session that is gone is gone until something
   * mints a new one, so the correct amount of further traffic is none.
   */
  let sessionLost = false;

  function cancelWakeProbe(): void {
    wakeProbeEpoch += 1;
    activeWakeProbe?.controller?.abort();
    activeWakeProbe = null;
  }

  function isCurrentWakeProbe(epoch: number): boolean {
    return !suspended && activeWakeProbe?.epoch === epoch;
  }

  function isRetryableWakeError(error: unknown): error is RemoteError {
    const issue = error as Partial<RemoteError>;
    if (!issue?.isRemoteTransport) return false;
    if (/origin has been unregistered from argo tunnel/i.test(issue.rawMessage || "")) return false;
    if (issue.kind === "network") return true;
    return Boolean(issue.statusCode && issue.statusCode >= 500 && issue.statusCode < 600 && issue.statusCode !== 530);
  }

  function emitWakeProbeFailure(error: RemoteError): void {
    emitConnectionState({
      connected: false,
      message: error.message,
      hint: error.hint,
      code: error.statusCode,
    });
  }

  function startWakeProbe(socketToCloseOnFailure?: WebSocket): void {
    if (activeWakeProbe || suspended || sessionLost) return;
    const epoch = ++wakeProbeEpoch;
    activeWakeProbe = { epoch, controller: null };
    void (async () => {
      let finalError: RemoteError | null = null;
      for (let attempt = 0; attempt < WAKE_PROBE_ATTEMPTS; attempt += 1) {
        if (!isCurrentWakeProbe(epoch)) return;
        const controller = new AbortController();
        activeWakeProbe.controller = controller;
        const timeout = window.setTimeout(() => controller.abort(), WAKE_PROBE_TIMEOUT_MS);
        try {
          const payload = await fetchJson("/api/state", undefined, {
            signal: controller.signal,
            emitConnectionState: false,
          });
          if (!isCurrentWakeProbe(epoch)) return;
          noteCoreRevision(payload);
          emitConnectionState({ connected: true, message: "" });
          safeDispatch(listeners.stateUpdated, payload as CoreState, "stateUpdated");
          return;
        } catch (error) {
          if (!isCurrentWakeProbe(epoch)) return;
          finalError = (error as Partial<RemoteError>)?.isRemoteTransport
            ? (error as RemoteError)
            : createRemoteIssue({
                kind: controller.signal.aborted ? "network" : "request-failed",
                rawMessage: (error as { message?: string })?.message || "",
                recoverable: controller.signal.aborted,
              });
          if (sessionLost || !isRetryableWakeError(finalError) || attempt === WAKE_PROBE_ATTEMPTS - 1) break;
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, WAKE_PROBE_RETRY_DELAYS_MS[attempt] ?? 0);
          });
        } finally {
          window.clearTimeout(timeout);
          if (activeWakeProbe?.epoch === epoch && activeWakeProbe.controller === controller) {
            activeWakeProbe.controller = null;
          }
        }
      }
      if (!isCurrentWakeProbe(epoch) || !finalError || sessionLost) return;
      emitWakeProbeFailure(finalError);
      if (socketToCloseOnFailure && ws === socketToCloseOnFailure) {
        try {
          socketToCloseOnFailure.close();
        } catch {
          // Already gone.
        }
      }
    })()
      .catch((error) => {
        rlog("warn", "Wake probe failed unexpectedly", { error: (error as Error)?.message || String(error) });
      })
      .finally(() => {
        if (activeWakeProbe?.epoch === epoch) activeWakeProbe = null;
      });
  }

  // PRESENCE. The server's idle deadline moves only for typing, resizing and subscribing, so a phone
  // that is merely WATCHING a terminal looked idle and was logged out after the idle window (2026-10-05).
  // While the page is visible, not suspended and holding an open socket, the host app is in the
  // foreground and a person can see the screen: that is the activity. Sent only inside a native host
  // (a browser tab has no such deadline) and never while suspended, so a backgrounded phone still idles
  // out. The server's absolute deadline is untouched by it.
  const PRESENCE_INTERVAL_MS = 60_000;
  if (mobileHost && typeof window !== "undefined") {
    window.setInterval(() => {
      const current = ws;
      if (suspended || sessionLost || !current || current.readyState !== WebSocket.OPEN) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        current.send(JSON.stringify({ type: "client:presence" }));
      } catch {
        // A socket that cannot send is closing; the reconnect path owns that.
      }
    }, PRESENCE_INTERVAL_MS);
  }

  function suspendTransport(): void {
    if (suspended) return;
    suspended = true;
    cancelWakeProbe();
    if (webSocketConnectTimer) {
      window.clearTimeout(webSocketConnectTimer);
      webSocketConnectTimer = 0;
    }
    consecutiveConnectTimeouts = 0;
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = 0;
    }
    const current = ws;
    ws = null;
    if (current) {
      try {
        // 1000: this is a deliberate, clean close. The server treats it as a viewer going away, which
        // is exactly what it is.
        current.close(1000, "suspended");
      } catch {
        // Already closing.
      }
    }
    emitConnectionState({ connected: false, reconnecting: false, message: SUSPENDED_MESSAGE });
  }

  function resumeTransport(): void {
    if (!suspended) return;
    suspended = false;
    // Forget what was last told to the host. The suspend posted `connected:false`, and a reconnect that
    // lands on the same payload (or a reply that raced the suspend with `connected:true`) would be
    // swallowed by the dedupe, so the host never saw the reconnect it is waiting for and declared the
    // resume stalled (2026-10-05).
    lastPostedConnectionState = "";
    // A resume follows either a background teardown or a fresh bootstrap; both are a new verdict on
    // whether this page has a session, so the latch must not survive one.
    sessionLost = false;
    reconnectAttempt = 0;
    consecutiveAuthCloses = 0;
    consecutiveConnectTimeouts = 0;
    // The fresh socket's URL carries `?rev=` (see `buildWsUrl`), so the server sends ONE catch-up
    // core if state moved while we were away, and the re-sent `terminal:subscribe` produces the
    // desktop's own BOUNDED replay per session — not the whole history. That bound is what keeps a
    // reconnect from undoing the data saving the suspend achieved.
    connectWebSocket();
    // AND ONE BOUNDED PROBE, BECAUSE A SOCKET CANNOT REPORT ITS OWN REFUSAL. A resume happens after an
    // arbitrary time away, so the session it is reattaching to may be gone — the desktop's idle
    // deadline, the relay's viewer TTL, a desktop that restarted. A rejected WebSocket UPGRADE
    // reaches the page as a close event and nothing else: no status, no body, indistinguishable from
    // a flaky network, and therefore answered with a reconnect backoff that retries forever. The
    // host, which is the only party that can mint a new session, is never told, and the user holds a
    // phone that says "reconnecting" until they kill the screen.
    //
    // An HTTP request has a status. This one turns the same dead session into a 401, which
    // `fetchJson` already routes to `reportSessionLost` — so the ambiguous case becomes the handled
    // one. It re-syncs the state it fetches too, the way `probeAfterResume` does for a live socket,
    // which is not a side benefit: a page returning from the background needs it either way.
    //
    // IT CLAIMS THE PROBE WINDOW. A foreground fires `visibilitychange`, `pageshow` and `focus` within
    // milliseconds of the host's `resume()`, and `probeAfterResume` answers those with this same
    // recovery — so without claiming the throttle window here, every resume started the same recovery
    // twice. A healthy wake still makes one request; transient failures get the bounded retries in
    // `startWakeProbe`.
    lastProbeAt = Date.now();
    startWakeProbe();
  }

  /**
   * The session is over: stop talking, and tell the native host so it can mint a new one.
   *
   * The host is told through the `StridetermHost` JavaScript channel the WebView installs. It is
   * absent in a plain browser, which is the whole reason this is a best-effort `postMessage` behind a
   * type check rather than a required dependency: a browser tab has a person in front of it who can
   * re-open the link, and the banner the suspend emits is that person's signal.
   *
   * Suspending rather than merely flagging is the point — see `sessionLost`. It also means the host's
   * next `resume()` is what un-latches this, so a re-bootstrap that lands on the SAME document
   * recovers without a reload.
   */
  function reportSessionLost(reason: SessionLostReason = "unknown"): void {
    if (sessionLost) return;
    sessionLost = true;
    cancelActiveBrowse?.();
    suspendTransport();
    const host = (window as unknown as Record<string, unknown>).StridetermHost as
      { postMessage?: (message: string) => void } | undefined;
    let hosted = false;
    try {
      if (typeof host?.postMessage === "function") {
        // `reason` is an allowlisted token, never the server's own text: the phone must tell an idle
        // expiry (a new ticket fixes it, WebView storage stays) from a revocation (final, wipe) without
        // this page leaking anything else across the channel. An extra field only: older hosts ignore it.
        host.postMessage(JSON.stringify({ type: "session-lost", reason }));
        hosted = true;
      }
    } catch {
      // A host channel that refuses the message changes nothing about the transport, which is already
      // quiet — but it does change the banner: nobody heard, so nobody is reopening anything.
    }
    emitConnectionState({
      connected: false,
      reconnecting: false,
      message: hosted ? SESSION_LOST_HOSTED_MESSAGE : SESSION_LOST_MESSAGE,
    });
  }

  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__stridetermRemote = {
      selectTarget: async (profileId: string, workspaceId: string | null, requestId: number, panelId?: string) => {
        try {
          let payload = await fetchJson("/api/remote-client/profile/activate", { profileId });
          if (workspaceId) payload = await fetchJson("/api/remote-client/workspace/activate", { workspaceId });
          noteCoreRevision(payload);
          if (panelId) {
            if (!workspaceId) throw new Error("A panel selection requires a workspace");
            await new Promise<void>((resolve, reject) => {
              let settled = false;
              const detail: RemotePanelSelectionDetail = {
                profileId,
                workspaceId,
                panelId,
                handled: false,
                resolve: () => finish(resolve),
                reject: (reason) => finish(() => reject(reason)),
              };
              let readyTimeout = 0;
              const onReady = () => requestSelection();
              const finish = (complete: () => void) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(readyTimeout);
                window.removeEventListener(REMOTE_PANEL_SELECTION_READY_EVENT, onReady);
                complete();
              };
              const failIfStillUnhandled = () => {
                if (!detail.handled) finish(() => reject(new Error("Renderer panel selection is not ready")));
              };
              const requestSelection = () => {
                if (settled) return;
                safeDispatch(listeners.stateUpdated, payload as CoreState, "stateUpdated");
                window.dispatchEvent(
                  new CustomEvent<RemotePanelSelectionDetail>(REMOTE_PANEL_SELECTION_EVENT, { detail }),
                );
                if (detail.handled) {
                  window.clearTimeout(readyTimeout);
                  return;
                }
                window.addEventListener(REMOTE_PANEL_SELECTION_READY_EVENT, onReady, { once: true });
              };
              readyTimeout = window.setTimeout(failIfStillUnhandled, REMOTE_PANEL_SELECTION_READY_TIMEOUT_MS);
              requestSelection();
            });
          } else {
            safeDispatch(listeners.stateUpdated, payload as CoreState, "stateUpdated");
          }
          postHost({
            type: "selection-result",
            requestId,
            ok: true,
            ...(panelId ? { profileId, workspaceId, panelId } : {}),
          });
        } catch {
          postHost({ type: "selection-result", requestId, ok: false });
        }
      },
      suspend: suspendTransport,
      resume: resumeTransport,
      /** Whether the transport is currently asleep. Read by the host to decide resume vs. re-bootstrap. */
      isSuspended: () => suspended,
      /**
       * Whether this page has already been told its session is gone.
       *
       * READ IT BEFORE `resume()`, NOT AFTER. Together with `isSuspended()` this is how the host
       * picks between the two ways of waking a backgrounded page: a page that is merely suspended
       * takes a `resume()`, a page whose session is gone needs a fresh ticket and a re-bootstrap,
       * because there is nothing on the server left for a resume to reattach to. `resume()` clears
       * this flag by design (it is a new verdict on a new session), so asking afterwards always
       * answers `false` and would send every lost session down the resume path.
       */
      isSessionLost: () => sessionLost,
    };
    // `onPageFinished` can precede this assignment (notably while the one-time mobile bootstrap
    // reload is still changing documents). Tell the native host when this document's callable
    // bridge actually exists; it scopes the signal to its current navigation before selecting.
    postHost({ type: "bridge-ready" });
  }

  // --------------------------------------------------------------------
  // Resume-from-background handling.
  //
  // Mobile Safari and Chrome aggressively suspend JS in backgrounded tabs.
  // While suspended:
  //  - WebSocket pings/pongs don't process. The server's heartbeat fires
  //    at MAX_MISSED_PONGS and terminates the socket; the close event
  //    queues but the renderer is frozen and can't run scheduleReconnect.
  //  - The kernel may drop the underlying TCP connection silently — when
  //    the tab thaws, ws.readyState is still OPEN but no traffic flows.
  //
  // Without active recovery the UI appears frozen on return: no terminal
  // output arrives, the cached payload is stale, sends queue forever.
  //
  // We listen to both visibilitychange→visible and pageshow (the latter
  // fires after bfcache restore where the page literally was suspended).
  // The probe is: if the socket isn't OPEN, trigger a reconnect; if it
  // is OPEN, do a /api/state round-trip to verify the connection is
  // genuinely alive AND to flush whatever state we missed while away.
  // If the probe fails, close the socket so the existing close→reconnect
  // path kicks in.
  // --------------------------------------------------------------------
  // visibilitychange, pageshow, and focus can all fire within ~50 ms of
  // each other when a backgrounded tab regains focus. Without throttling
  // that's 3 simultaneous /api/state requests on every tab-switch —
  // wasteful on mobile data and creates a small thundering-herd on the
  // notify server. 2 s window dedupes them without delaying a genuine
  // resume probe perceptibly.
  const PROBE_THROTTLE_MS = 2_000;
  let lastProbeAt = 0;
  function probeAfterResume(): void {
    if (typeof document === "undefined") return;
    if (document.visibilityState !== "visible") return;
    // A suspended transport stays suspended until the HOST resumes it. A WebView can become
    // "visible" for reasons that have nothing to do with the app being in the foreground, and a probe
    // that reconnected on one of those would defeat the suspend.
    if (suspended) return;
    const now = Date.now();
    if (now - lastProbeAt < PROBE_THROTTLE_MS) return;
    lastProbeAt = now;
    const current = ws;
    if (!current) {
      // No socket at all — shouldn't happen post-construction, but be safe.
      connectWebSocket();
      return;
    }
    if (current.readyState === WebSocket.CLOSED || current.readyState === WebSocket.CLOSING) {
      // Browser delivered the close event but the reconnect timer may
      // have been suspended along with the renderer. Kick one off if
      // there isn't already a pending reconnect.
      if (!reconnectTimer) {
        const error = createRemoteIssue({ kind: "ws-closed", rawMessage: "Resumed from suspended tab" });
        scheduleReconnect(error);
      }
      return;
    }
    if (current.readyState !== WebSocket.OPEN) {
      // CONNECTING — the existing open/close handlers will resolve it.
      return;
    }
    // Technically OPEN but might be a zombie. Verify via /api/state and
    // re-sync the payload. Close the socket only after bounded recovery fails.
    startWakeProbe(current);
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", probeAfterResume);
  }
  if (typeof window !== "undefined") {
    // pageshow fires on bfcache restore — visibilitychange may NOT fire in
    // that path on some browsers, so we listen to both.
    window.addEventListener("pageshow", probeAfterResume);
    // focus event covers desktop alt-tab back to a stale tab.
    window.addEventListener("focus", probeAfterResume);
  }

  /** Append defined filter values as query params, so a read stays a GET. */
  function withQuery(pathname: string, filters?: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters || {})) {
      if (value === undefined || value === null || value === "") continue;
      params.set(key, String(value));
    }
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  function isRelayBootstrapRedirect(response: Response): boolean {
    if (!response.redirected || !response.url) return false;
    try {
      const target = new URL(response.url, window.location.href);
      return target.origin === window.location.origin && target.pathname === "/__relay/bootstrap";
    } catch {
      return false;
    }
  }

  /**
   * A successful HTTP reply proves the server answered, not that this page is connected: once the
   * transport is suspended there is no socket, and a reply that lands after the suspend made the host
   * believe the page was connected while backgrounded — which then produced false "resume stalled"
   * re-bootstraps on the phone (2026-10-05).
   */
  function emitFetchConnected(): void {
    if (suspended) return;
    emitConnectionState({ connected: true, message: "" });
  }

  async function fetchJson(
    pathname: string,
    payload?: unknown,
    options: { signal?: AbortSignal; emitConnectionState?: boolean } = {},
  ): Promise<unknown> {
    // Without a token we fall through to the cookie-based path: the
    // bootstrap redirect set `strideterm_session=…; HttpOnly` and the
    // browser attaches it to every same-origin fetch. The server's
    // `isAuthorized` accepts either, so dropping the Authorization
    // header is correct here. If both are missing the server will
    // 401 and the existing error path surfaces it.
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    headers["X-Strideterm-Client-Id"] = remoteClientId;
    headers["X-Strideterm-State-Protocol"] = String(STATE_PROTOCOL);
    headers["X-Strideterm-Capabilities"] = STATE_CAPABILITIES.join(",");
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    // GET revalidation: offer the ETag we last saw for this path so the server
    // can answer 304 (see json()/ETag in remote-server.ts). Never for POSTs.
    const isGet = !payload;
    const cachedEntry = isGet ? etagCache.get(pathname) : undefined;
    if (cachedEntry) headers["If-None-Match"] = cachedEntry.etag;

    let response: Response;
    try {
      response = await fetch(pathname, {
        method: payload ? "POST" : "GET",
        headers,
        body: payload ? JSON.stringify(payload) : undefined,
        signal: options.signal,
      });
    } catch (cause) {
      const error = createRemoteIssue({
        kind: "network",
        rawMessage: (cause as { message?: string })?.message || "",
      });
      if (options.emitConnectionState !== false && !options.signal?.aborted) {
        emitConnectionState({ connected: false, message: error.message, hint: error.hint, code: 0 });
      }
      throw error;
    }

    if (options.signal?.aborted) {
      throw createRemoteIssue({ kind: "cancelled", recoverable: false });
    }

    // A relay with an expired viewer cookie historically answered API requests with a redirect to
    // its HTML bootstrap page. Fetch follows that redirect, so the renderer sees 200 rather than
    // the original 302. Treat only the relay's same-origin bootstrap destination as the equivalent
    // of a 401; unrelated redirects and HTML responses remain ordinary malformed API responses.
    if (isRelayBootstrapRedirect(response)) {
      const error = createRemoteIssue({ kind: "http", statusCode: 401 });
      reportSessionLost("unauthorized");
      throw error;
    }

    // 304 Not Modified — the resource is unchanged; reuse the cached body.
    if (response.status === 304 && cachedEntry) {
      if (options.emitConnectionState !== false) emitFetchConnected();
      return cachedEntry.body;
    }

    if (!response.ok) {
      const rawMessage = await response.text();
      if (options.signal?.aborted) {
        throw createRemoteIssue({ kind: "cancelled", recoverable: false });
      }
      const error = createRemoteIssue({
        kind: "http",
        statusCode: response.status,
        rawMessage,
      });
      // 401 is the session ending, not a request failing. Everything else falls through to the
      // ordinary banner-and-throw below.
      if (response.status === 401) {
        reportSessionLost("unauthorized");
        throw error;
      }
      if (options.emitConnectionState !== false) {
        emitConnectionState({
          connected: false,
          message: error.message,
          hint: error.hint,
          code: response.status,
        });
      }
      throw error;
    }

    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      if (options.signal?.aborted) {
        throw createRemoteIssue({ kind: "cancelled", recoverable: false });
      }
      const error = createRemoteIssue({
        kind: "invalid-response",
        rawMessage: "The remote server returned an invalid JSON response.",
      });
      if (options.emitConnectionState !== false) {
        emitConnectionState({ connected: false, message: error.message, hint: error.hint, code: response.status });
      }
      throw error;
    }
    if (options.signal?.aborted) {
      throw createRemoteIssue({ kind: "cancelled", recoverable: false });
    }
    if (options.emitConnectionState !== false) emitFetchConnected();
    // Remember the ETag so the next GET of this path can revalidate. Optional
    // chaining guards environments/mocks whose Response omits `headers`.
    const etag = isGet ? (response.headers?.get?.("ETag") ?? null) : null;
    if (etag) etagCache.set(pathname, { etag, body });
    return body;
  }

  async function browseDirectory(initialPath = ""): Promise<string | null> {
    if (!mobileHost || typeof mobileHost.postMessage !== "function" || !selectedProfileId) return null;
    const requestId =
      typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : `workspace-browse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const profileId = selectedProfileId;
    const workspaceId = selectedWorkspaceId;
    return new Promise<string | null>((resolve) => {
      let settled = false;
      let timeout = 0;
      const cancel = () => finish(null, false);
      const cleanup = () => {
        window.removeEventListener("strideterm:workspace-browse-result", onResult);
        window.removeEventListener("strideterm:workspace-browse-cancel", onCancel);
        window.clearTimeout(timeout);
        if (cancelActiveBrowse === cancel) cancelActiveBrowse = null;
      };
      const finish = (value: string | null, ok: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        postHost({ type: "workspace-browse-ack", requestId, ok });
        resolve(value);
      };
      const onResult = (event: Event) => {
        const detail = (event as CustomEvent<unknown>).detail;
        if (!detail || typeof detail !== "object") return;
        const candidate = detail as Record<string, unknown>;
        if (
          candidate.requestId !== requestId ||
          candidate.profileId !== profileId ||
          (candidate.workspaceId ?? null) !== workspaceId ||
          selectedProfileId !== profileId ||
          selectedWorkspaceId !== workspaceId ||
          typeof candidate.path !== "string" ||
          !candidate.path.trim() ||
          candidate.path.length > 4096 ||
          candidate.path.includes("\0")
        ) {
          return;
        }
        finish(candidate.path, true);
      };
      const onCancel = (event: Event) => {
        const detail = (event as CustomEvent<unknown>).detail;
        if (!detail || typeof detail !== "object" || (detail as Record<string, unknown>).requestId !== requestId)
          return;
        finish(null, false);
      };
      timeout = window.setTimeout(() => finish(null, false), 10 * 60_000);
      cancelActiveBrowse = cancel;
      window.addEventListener("strideterm:workspace-browse-result", onResult);
      window.addEventListener("strideterm:workspace-browse-cancel", onCancel);
      postHost({
        type: "workspace-browse",
        requestId,
        profileId,
        workspaceId,
        initialPath: String(initialPath || ""),
      });
    });
  }

  function send(message: WsMessage): void {
    const current = ws;
    if (current?.readyState === WebSocket.OPEN) {
      current.send(JSON.stringify(message));
      return;
    }
    pendingWsMessages.push(message);
  }

  return {
    isRemote: true,
    /**
     * Manual state refresh. Fetches /api/state from the server and emits
     * the result through the standard stateUpdated listeners, same as a
     * reconnect would. Used by the mobile pull-to-refresh gesture (swipe
     * up at end of terminal) and by any future "refresh" UI affordance.
     *
     * Also kicks the WebSocket if it isn't currently OPEN — a refresh
     * gesture is the strongest user-initiated "something looks wrong"
     * signal we get, so we use it to push reconnect along instead of
     * waiting for the next heartbeat / visibility probe.
     *
     * Failures are swallowed: fetchJson already emitted a connection-
     * issue state, and the close → reconnect path will recover. Nothing
     * more to do at this layer.
     */
    refresh: async (): Promise<void> => {
      // A suspended transport does not reconnect, and a manual refresh is not an exception to that —
      // `scheduleReconnect` and `probeAfterResume` already make the same check before they reach the
      // socket. This is the third door. Pull-to-refresh is precisely the gesture a person makes at a
      // screen that has gone quiet, which after a 401 is every screen, so without this each pull
      // opened a socket the server was always going to reject: exactly the traffic `sessionLost`
      // exists to stop, only hand-cranked.
      if (suspended) return;
      const current = ws;
      if (!current) {
        connectWebSocket();
      } else if (current.readyState !== WebSocket.OPEN && current.readyState !== WebSocket.CONNECTING) {
        // CLOSED/CLOSING: schedule a reconnect if one isn't already queued.
        if (!reconnectTimer) {
          const error = createRemoteIssue({ kind: "ws-closed", rawMessage: "Manual refresh requested" });
          scheduleReconnect(error);
        }
      }
      try {
        const payload = (await fetchJson("/api/state")) as CoreState;
        noteCoreRevision(payload);
        emitConnectionState({ connected: true, message: "" });
        listeners.stateUpdated.forEach((handler) => handler(payload));
      } catch {
        // fetchJson already emitted a connection-issue state; the resume
        // probe / reconnect path will recover. Nothing more to do here.
      }
    },
    openExternal: (url: string) => {
      const nextUrl = String(url || "").trim();
      if (!nextUrl) {
        return Promise.resolve();
      }
      window.open(nextUrl, "_blank", "noopener,noreferrer");
      return Promise.resolve();
    },
    ...(mobileHost && typeof mobileHost.postMessage === "function" ? { browseDirectory } : {}),
    getState: async () => {
      const state = (await fetchJson("/api/state")) as CoreState;
      noteCoreRevision(state);
      return state;
    },
    attachmentList: async (payload) => normalizeAttachmentList(await fetchJson("/api/attachment/list", payload)),
    attachmentDelete: async (payload) => {
      const result = await fetchJson("/api/attachment/delete", payload);
      if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true) {
        throw new Error("Invalid attachment delete response");
      }
      return { ok: true };
    },
    activateProject: (projectId) => fetchJson("/api/project/activate", { projectId }),
    activateSession: (sessionId) => {
      // sessionId format is "workspaceId:panelId" — derive workspaceId from it.
      const workspaceId = String(sessionId || "").split(":")[0];
      return fetchJson("/api/remote-client/session/activate", { workspaceId, sessionId });
    },
    setWorkspaceUIState: (workspaceId, uiState) => fetchJson("/api/workspace/set-ui-state", { workspaceId, uiState }),
    enableWorkspaceGrid: (layout, workspaceIds) => fetchJson("/api/workspace-grid/enable", { layout, workspaceIds }),
    disableWorkspaceGrid: () => fetchJson("/api/workspace-grid/disable", {}),
    setGridLayout: (layout) => fetchJson("/api/workspace-grid/set-layout", { layout }),
    setGridCell: (cellIndex, workspaceId) => fetchJson("/api/workspace-grid/set-cell", { cellIndex, workspaceId }),
    swapGridCells: (a, b) => fetchJson("/api/workspace-grid/swap-cells", { a, b }),
    syncAttentionContext: (payload) => fetchJson("/api/attention/sync", payload),
    clearAllAttention: () => fetchJson("/api/attention/clear-all", {}),
    clearAlertForSession: (sessionId, options) =>
      fetchJson("/api/attention/clear-session", {
        sessionId,
        dismissed: options?.dismissed === true,
      }),
    saveWorkspace: (workspace) => fetchJson("/api/workspace/save", { workspace }),
    saveProject: (project) => fetchJson("/api/project/save", { project }),
    deleteWorkspace: (workspaceId, options) => fetchJson("/api/workspace/delete", { workspaceId, ...options }),
    deleteProject: (projectId) => fetchJson("/api/project/delete", { projectId }),
    reorderWorkspaces: (workspaceIds) => fetchJson("/api/workspace/reorder", { workspaceIds }),
    reorderProjects: (projectIds) => fetchJson("/api/project/reorder", { projectIds }),
    updateSettings: (settings) => fetchJson("/api/settings/update", { settings }),
    configureClaudeHook: () => fetchJson("/api/claude-hook/configure", {}),
    removeClaudeHook: () => fetchJson("/api/claude-hook/remove", {}),
    getClaudeHookStatus: () => fetchJson("/api/claude-hook/status", {}),
    testClaudeHook: () => fetchJson("/api/claude-hook/test", {}),
    configureGeminiHook: () => fetchJson("/api/gemini-hook/configure", {}),
    removeGeminiHook: () => fetchJson("/api/gemini-hook/remove", {}),
    getGeminiHookStatus: () => fetchJson("/api/gemini-hook/status", {}),
    testGeminiHook: () => fetchJson("/api/gemini-hook/test", {}),
    configureCodexHook: () => fetchJson("/api/codex-hook/configure", {}),
    removeCodexHook: () => fetchJson("/api/codex-hook/remove", {}),
    getCodexHookStatus: () => fetchJson("/api/codex-hook/status", {}),
    testCodexHook: () => fetchJson("/api/codex-hook/test", {}),
    configureCopilotHook: () => fetchJson("/api/copilot-hook/configure", {}),
    removeCopilotHook: () => fetchJson("/api/copilot-hook/remove", {}),
    getCopilotHookStatus: () => fetchJson("/api/copilot-hook/status", {}),
    testCopilotHook: () => fetchJson("/api/copilot-hook/test", {}),
    configureOpencodeHook: () => fetchJson("/api/opencode-hook/configure", {}),
    removeOpencodeHook: () => fetchJson("/api/opencode-hook/remove", {}),
    getOpencodeHookStatus: () => fetchJson("/api/opencode-hook/status", {}),
    testOpencodeHook: () => fetchJson("/api/opencode-hook/test", {}),
    checkCommand: (command) => fetchJson("/api/check-command", { command }),
    // Task runner
    recheckClaude: () => fetchJson("/api/task/recheck-claude", {}),
    checkProviders: () => fetchJson("/api/task/check-providers", {}),
    checkIsGitRepo: (cwd) => fetchJson("/api/task/check-git-repo", { cwd }),
    probeDirectory: (cwd) => fetchJson("/api/fs/probe-directory", { cwd }),
    createTaskWorkspace: (payload) => fetchJson("/api/task/create", payload),
    startTask: (payload) => fetchJson("/api/task/start", payload),
    stopTask: (payload) => fetchJson("/api/task/stop", payload),
    pauseTask: (payload) => fetchJson("/api/task/pause", payload),
    resumeTask: (payload) => fetchJson("/api/task/resume", payload),
    resetTask: (payload) => fetchJson("/api/task/reset", payload),
    rejectTaskVerdict: (payload) => fetchJson("/api/task/reject-verdict", payload),
    resendTaskInstruction: (payload) => fetchJson("/api/task/resend-instruction", payload),
    updateTaskDescription: (payload) => fetchJson("/api/task/update-description", payload),
    resolveTaskRecovery: (decisions) =>
      fetchJson("/api/task-recovery/resolve", decisions) as Promise<RecoveryResult<StatePayload>>,
    getTaskStatus: (workspaceId) => fetchJson("/api/task/status", { workspaceId }),
    createCompanionTask: (payload) => fetchJson("/api/task/create-companion", payload),
    answerCompanionTask: (payload) => fetchJson("/api/task/answer-companion", payload),
    getTerminalReplay: (sessionId) =>
      fetchJson("/api/terminal/replay", { sessionId }) as Promise<TerminalReplayPayload>,
    verifyAzureConnection: (connection) => fetchJson("/api/azure/verify-connection", { connection }),
    saveAzureConnection: (connection) => fetchJson("/api/azure/save-connection", { connection }),
    deleteAzureConnection: (connectionId) => fetchJson("/api/azure/delete-connection", { connectionId }),
    refreshAzure: () => fetchJson("/api/azure/refresh", {}),
    queryAzureAuditLog: (filters) => fetchJson("/api/azure/audit-log/query", filters),
    getAzureAuditStats: (filters) => fetchJson("/api/azure/audit-log/stats", filters),
    // Read-only, hence remote-reachable — unlike the setting that produces the
    // entries, which `sanitizeSettingsFromRemote` refuses to let a remote
    // client write. Query filters ride as URL params so this stays a GET.
    queryApprovalAuditLog: (filters) => fetchJson(withQuery("/api/approvals/audit-log", filters)),
    getApprovalAuditStats: (filters) => fetchJson(withQuery("/api/approvals/audit-log/stats", filters)),
    markAzurePullRequestSeen: (prKey) => fetchJson("/api/azure/pull-request/seen", { prKey }),
    openAzurePullRequest: (payload) => fetchJson("/api/azure/pull-request/open", payload),
    commentAzurePullRequest: (payload) => fetchJson("/api/azure/pull-request/comment", payload),
    createReviewBridgeDraftComment: (payload) => fetchJson("/api/review-bridge/draft-comment/create", payload),
    saveReviewBridgeDraft: (payload) => fetchJson("/api/review-bridge/draft/save", payload),
    deleteReviewBridgeDraft: (payload) => fetchJson("/api/review-bridge/draft/delete", payload),
    queueReviewBridgeDraft: (payload) => fetchJson("/api/review-bridge/draft/queue", payload),
    deleteReviewBridgeComment: (payload) => fetchJson("/api/review-bridge/comment/delete", payload),
    replyWithCodeChanges: (payload) => fetchJson("/api/review-bridge/comment/reply-with-changes", payload),
    resetAgentPrompts: () => fetchJson("/api/review-bridge/agent-prompt/reset", {}),
    syncReviewBridgePullRequest: (payload) => fetchJson("/api/review-bridge/pull-request/sync", payload),
    pushAndPublishReview: (payload) => fetchJson("/api/review-bridge/pull-request/push-and-publish", payload),
    updateAzureThreadStatus: (payload) => fetchJson("/api/azure/pull-request/thread-status", payload),
    voteAzurePullRequest: (payload) => fetchJson("/api/azure/pull-request/vote", payload),
    fetchAzureReviewWorkspace: (workspaceId) => fetchJson("/api/azure/workspace/fetch", { workspaceId }),
    rebaseAzureReviewWorkspace: (workspaceId) => fetchJson("/api/azure/workspace/rebase", { workspaceId }),
    pushAzureReviewWorkspace: (workspaceId, options) =>
      fetchJson("/api/azure/workspace/push", { workspaceId, ...options }),
    syncAzureReviewWorkspace: (workspaceId) => fetchJson("/api/azure/workspace/sync", { workspaceId }),
    azureCreatePullRequest: (payload) => fetchJson("/api/azure/create-pull-request", payload),
    azureListRemoteBranches: (payload) => fetchJson("/api/azure/list-remote-branches", payload),
    azureQuickFixListProjects: (payload) => fetchJson("/api/azure/quickfix/list-projects", payload),
    azureQuickFixListRepositories: (payload) => fetchJson("/api/azure/quickfix/list-repositories", payload),
    azureQuickFixListBranches: (payload) => fetchJson("/api/azure/quickfix/list-branches", payload),
    azureQuickFixCreate: (payload) => fetchJson("/api/azure/quickfix/create", payload),
    rerunAzureCheck: (prKey, checkItem) => fetchJson("/api/azure/rerun-check", { prKey, checkItem }),
    listAzurePipelines: (payload) => fetchJson("/api/azure/pipelines/list", payload),
    listAzurePipelineRuns: (payload) => fetchJson("/api/azure/pipelines/runs", payload),
    getAzurePipelineRunSeed: (payload) => fetchJson("/api/azure/pipelines/run-seed", payload),
    getAzurePipelineRunParameters: (payload) => fetchJson("/api/azure/pipelines/run-parameters", payload),
    getAzurePipelineRefs: (payload) => fetchJson("/api/azure/pipelines/refs", payload),
    getAzurePipelineCommits: (payload) => fetchJson("/api/azure/pipelines/commits", payload),
    runAzurePipeline: (payload) => fetchJson("/api/azure/pipelines/run", payload),
    getAzurePipelineRunStatus: (payload) => fetchJson("/api/azure/pipelines/run-status", payload),
    cancelAzureBuild: (payload) => fetchJson("/api/azure/pipelines/cancel", payload),
    getAzureBuildLog: (payload) => fetchJson("/api/azure/pipelines/build-log", payload),
    getAzurePipelineRunDetail: (payload) => fetchJson("/api/azure/pipelines/run-detail", payload),
    verifyGitHubConnection: (connection) => fetchJson("/api/github/verify-connection", { connection }),
    saveGitHubConnection: (connection) => fetchJson("/api/github/save-connection", { connection }),
    deleteGitHubConnection: (connectionId) => fetchJson("/api/github/delete-connection", { connectionId }),
    refreshGitHub: () => fetchJson("/api/github/refresh", {}),
    queryGitHubAuditLog: (filters) => fetchJson("/api/github/audit-log/query", filters),
    getGitHubAuditStats: (filters) => fetchJson("/api/github/audit-log/stats", filters),
    markGitHubPullRequestSeen: (prKey) => fetchJson("/api/github/pull-request/seen", { prKey }),
    openGitHubPullRequest: (payload) => fetchJson("/api/github/pull-request/open", payload),
    commentGitHubPullRequest: (payload) => fetchJson("/api/github/pull-request/comment", payload),
    submitGitHubPullRequestReview: (payload) => fetchJson("/api/github/pull-request/review", payload),
    rerunGitHubCheck: (prKey, checkItem) => fetchJson("/api/github/rerun-check", { prKey, checkItem }),
    fetchGitHubReviewWorkspace: (workspaceId) => fetchJson("/api/github/workspace/fetch", { workspaceId }),
    rebaseGitHubReviewWorkspace: (workspaceId) => fetchJson("/api/github/workspace/rebase", { workspaceId }),
    pushGitHubReviewWorkspace: (workspaceId, options) =>
      fetchJson("/api/github/workspace/push", { workspaceId, ...options }),
    syncGitHubReviewWorkspace: (workspaceId) => fetchJson("/api/github/workspace/sync", { workspaceId }),
    githubListRemoteBranches: (payload) => fetchJson("/api/github/list-remote-branches", payload),
    githubCreatePullRequest: (payload) => fetchJson("/api/github/create-pull-request", payload),
    githubQuickFixListRepos: (payload) => fetchJson("/api/github/quickfix/list-repos", payload),
    githubQuickFixListBranches: (payload) => fetchJson("/api/github/quickfix/list-branches", payload),
    githubQuickFixCreate: (payload) => fetchJson("/api/github/quickfix/create", payload),
    verifyTelegramConnection: (connection) => fetchJson("/api/telegram/verify-connection", { connection }),
    detectTelegramChats: (connection) => fetchJson("/api/telegram/detect-chats", { connection }),
    saveTelegramConnection: (connection) => fetchJson("/api/telegram/save-connection", { connection }),
    deleteTelegramConnection: (connectionId) => fetchJson("/api/telegram/delete-connection", { connectionId }),
    refreshTelegram: () => fetchJson("/api/telegram/refresh", {}),
    regenerateRemoteToken: () => fetchJson("/api/remote/token/regenerate", {}),
    refreshTunnel: () => fetchJson("/api/tunnel/refresh", {}),
    createCloudflareTunnel: () => fetchJson("/api/tunnel/create", {}),
    stopCloudflareTunnel: () => fetchJson("/api/tunnel/stop", {}),
    restartTerminal: (sessionId) => fetchJson("/api/terminal/restart", { sessionId }),
    refreshDocker: () => fetchJson("/api/docker/refresh", {}),
    refreshGit: (projectId) => fetchJson("/api/git/refresh", { projectId }),
    gitFetch: (payload) => fetchJson("/api/git/fetch", payload),
    gitPull: (payload) => fetchJson("/api/git/pull", payload),
    gitPush: (payload) => fetchJson("/api/git/push", payload),
    gitCheckoutBranch: (payload) => fetchJson("/api/git/checkout-branch", payload),
    gitCreateBranch: (payload) => fetchJson("/api/git/create-branch", payload),
    gitMergeIntoCurrent: (payload) => fetchJson("/api/git/merge-into-current", payload),
    gitRebaseOnto: (payload) => fetchJson("/api/git/rebase-onto", payload),
    gitCherryPick: (payload) => fetchJson("/api/git/cherry-pick", payload),
    gitSquashCommits: (payload) => fetchJson("/api/git/squash-commits", payload),
    gitContinueOperation: (payload) => fetchJson("/api/git/continue", payload),
    gitAbortOperation: (payload) => fetchJson("/api/git/abort", payload),
    gitDiffPreview: (payload) => fetchJson("/api/git/diff-preview", payload),
    gitCompareBranch: (payload) => fetchJson("/api/git/compare-branch", payload),
    gitMergeCurrentIntoBase: (payload) => fetchJson("/api/git/merge-into-base", payload),
    gitRemoveWorktree: (payload) => fetchJson("/api/git/remove-worktree", payload),
    gitCommitAll: (payload) => fetchJson("/api/git/commit-all", payload),
    gitStash: (payload) => fetchJson("/api/git/stash", payload),
    gitStashPop: (payload) => fetchJson("/api/git/stash-pop", payload),
    gitListStashes: (payload) => fetchJson("/api/git/stash-list", payload),
    gitStashFiles: (payload) => fetchJson("/api/git/stash-files", payload),
    gitStashFileDiff: (payload) => fetchJson("/api/git/stash-file-diff", payload),
    gitStashApply: (payload) => fetchJson("/api/git/stash-apply", payload),
    gitStashDrop: (payload) => fetchJson("/api/git/stash-drop", payload),
    gitStashBranch: (payload) => fetchJson("/api/git/stash-branch", payload),
    gitStashExport: (payload) => fetchJson("/api/git/stash-export", payload),
    gitStashImport: (payload) => fetchJson("/api/git/stash-import", payload),
    gitCommitDiff: (payload) => fetchJson("/api/git/commit-diff", payload),
    gitCommitInfo: (payload) => fetchJson("/api/git/commit-info", payload),
    gitLogPage: (payload) => fetchJson("/api/git/log-page", payload),
    gitListTags: (payload) => fetchJson("/api/git/list-tags", payload),
    gitCreateTag: (payload) => fetchJson("/api/git/create-tag", payload),
    gitDeleteTag: (payload) => fetchJson("/api/git/delete-tag", payload),
    gitPushTag: (payload) => fetchJson("/api/git/push-tag", payload),
    gitPushAllTags: (payload) => fetchJson("/api/git/push-all-tags", payload),
    gitDeleteRemoteTag: (payload) => fetchJson("/api/git/delete-remote-tag", payload),
    gitForcePushWithLease: (payload) => fetchJson("/api/git/force-push-with-lease", payload),
    gitListBranches: (payload) => fetchJson("/api/git/list-branches", payload),
    gitDeleteBranch: (payload) => fetchJson("/api/git/delete-branch", payload),
    gitDeleteRemoteBranch: (payload) => fetchJson("/api/git/delete-remote-branch", payload),
    gitRenameBranch: (payload) => fetchJson("/api/git/rename-branch", payload),
    gitCheckoutRemoteBranch: (payload) => fetchJson("/api/git/checkout-remote-branch", payload),
    gitLogGraph: (payload) => fetchJson("/api/git/log-graph", payload),
    gitSkipCommit: (payload) => fetchJson("/api/git/skip", payload),
    gitListConflicts: (payload) => fetchJson("/api/git/list-conflicts", payload),
    gitConflictDetail: (payload) => fetchJson("/api/git/conflict-detail", payload),
    gitResolveConflict: (payload) => fetchJson("/api/git/resolve-conflict", payload),
    gitUnresolveConflict: (payload) => fetchJson("/api/git/unresolve-conflict", payload),
    // Forward the whole payload so backendId/contextName/workspaceId reach the
    // server (the desktop preload does the same). The HTTP handler picks the
    // fields it cares about; extras like workspaceId are ignored harmlessly.
    dockerAction: (payload: unknown) => fetchJson("/api/docker/action", payload),
    openDockerSession: (payload) => fetchJson("/api/docker/open-session", payload),
    openLazydockerSession: (payload) => fetchJson("/api/docker/open-lazydocker", payload),
    dockerLogsOpen: (payload) => fetchJson("/api/docker/logs/open", payload),
    dockerLogsUpdate: (payload) => fetchJson("/api/docker/logs/update", payload) as Promise<{ ok: boolean }>,
    dockerLogsClose: (payload) => fetchJson("/api/docker/logs/close", payload),
    // Docker interactive shell. Open/close are infrequent, so plain HTTP POSTs
    // like the log-stream methods above; write/resize are per-keystroke
    // frequent, so — like writeTerminal/resizeTerminal — they go straight over
    // the WS socket instead of an HTTP POST per keystroke.
    dockerShellOpen: (payload) => fetchJson("/api/docker/shell/open", payload),
    dockerShellClose: (payload) => fetchJson("/api/docker/shell/close", payload),
    dockerShellWrite: (payload: { sessionId: string; data: string }) => {
      send({ type: "docker:shell:write", sessionId: payload.sessionId, data: payload.data });
      return Promise.resolve();
    },
    dockerShellResize: (payload: { sessionId: string; cols: number; rows: number }) => {
      send({ type: "docker:shell:resize", sessionId: payload.sessionId, cols: payload.cols, rows: payload.rows });
      return Promise.resolve();
    },
    dockerComposeAction: (payload) => fetchJson("/api/docker/compose-action", payload),
    // `fetchJson` returns `Promise<unknown>`; the StridetermAPI signatures
    // are stricter (Promise<string>, Promise<{...}>). We cast at the boundary
    // — runtime types match because the server returns the same JSON shape
    // that the Electron preload exposes.
    dockerInspect: (payload) => fetchJson("/api/docker/inspect", payload) as Promise<string>,
    dockerTop: (payload) => fetchJson("/api/docker/top", payload) as Promise<string>,
    dockerStats: (payload) =>
      fetchJson("/api/docker/stats", payload) as Promise<{
        cpuPerc: string;
        memUsage: string;
        memPerc: string;
        netIO: string;
        blockIO: string;
        pids: string;
      } | null>,
    dockerImageInspect: (payload) => fetchJson("/api/docker/image/inspect", payload) as Promise<string>,
    dockerVolumeInspect: (payload) => fetchJson("/api/docker/volume/inspect", payload) as Promise<string>,
    dockerNetworkInspect: (payload) => fetchJson("/api/docker/network/inspect", payload) as Promise<string>,
    dockerImageRemove: (payload) => fetchJson("/api/docker/image/remove", payload),
    dockerVolumeRemove: (payload) => fetchJson("/api/docker/volume/remove", payload),
    dockerNetworkRemove: (payload) => fetchJson("/api/docker/network/remove", payload),
    dockerImagePull: (payload) => fetchJson("/api/docker/image/pull", payload),
    dockerImagePrune: (payload) => fetchJson("/api/docker/image/prune", payload),
    dockerVolumePrune: (payload) => fetchJson("/api/docker/volume/prune", payload),
    dockerNetworkPrune: (payload) => fetchJson("/api/docker/network/prune", payload),
    dockerBuilderPrune: (payload) => fetchJson("/api/docker/builder/prune", payload),
    dockerSystemDf: (payload) => fetchJson("/api/docker/system/df", payload) as Promise<string>,
    dockerVolumeList: (payload) => fetchJson("/api/docker/volume/list", payload) as Promise<string>,
    dockerVolumeRead: (payload) => fetchJson("/api/docker/volume/read", payload) as Promise<string>,
    // Log stream subscription — the server pushes "docker:logs:write" and
    // "docker:logs:close" messages over the WS for every connected client.
    onDockerLogsWrite: (handler: (payload: { sessionId: string; data: string }) => void) =>
      listeners.dockerLogsWrite.add(handler),
    onDockerLogsClose: (handler: (payload: { sessionId: string; code: number | null }) => void) =>
      listeners.dockerLogsClose.add(handler),
    onDockerShellData: (handler: (payload: { sessionId: string; data: string }) => void) =>
      listeners.dockerShellData.add(handler),
    onDockerShellClose: (handler: (payload: { sessionId: string; code: number | null }) => void) =>
      listeners.dockerShellClose.add(handler),
    openLazygitSession: (payload) => fetchJson("/api/git/open-lazygit", payload),
    createWorktree: (payload) => fetchJson("/api/git/create-worktree", payload),
    saveProfile: (profile) => fetchJson("/api/profile/save", { profile }),
    deleteProfile: (profileId, options) => fetchJson("/api/profile/delete", { profileId, ...(options || {}) }),
    activateProfile: (profileId) => fetchJson("/api/remote-client/profile/activate", { profileId }),
    activateWorkspace: (workspaceId) => fetchJson("/api/remote-client/workspace/activate", { workspaceId }),
    fileList: (p) => fetchJson("/api/file/list", p),
    fileTree: (p) => fetchJson("/api/file/tree", p),
    filePreview: (p) => fetchJson("/api/file/preview", p),
    fileRead: (p) => fetchJson("/api/file/read", p),
    fileWrite: (p) => fetchJson("/api/file/write", p),
    fileCreateFile: (p) => fetchJson("/api/file/create-file", p),
    fileCreateDir: (p) => fetchJson("/api/file/create-dir", p),
    fileRename: (p) => fetchJson("/api/file/rename", p),
    fileDelete: (p) => fetchJson("/api/file/delete", p),
    fileGitIgnore: (p) => fetchJson("/api/file/git-ignore", p),
    fileMove: (p) => fetchJson("/api/file/move", p),
    fileCopy: (p) => fetchJson("/api/file/copy", p),
    fileOpenInExplorer: (p) => fetchJson("/api/file/open-in-explorer", p),
    fileClipboardCopy: (p) => fetchJson("/api/file/clipboard-copy", p),
    fileOpenInEditor: (p) => fetchJson("/api/file/open-in-editor", p),
    fileInfo: (p) => fetchJson("/api/file/info", p),
    fileGitStatus: (p) => fetchJson("/api/file/git-status", p),
    fileGitRefs: (p) => fetchJson("/api/file/git-refs", p),
    fileGitDiff: (p) => fetchJson("/api/file/git-diff", p),
    fileCommitFiles: (p) => fetchJson("/api/file/commit-files", p),
    fileCommitDiff: (p) => fetchJson("/api/file/commit-diff", p),

    sshCapabilitiesGet: () => fetchJson("/api/ssh/capabilities", {}).then((result) => result as SshRuntimeCapabilities),
    sshHostsList: () => fetchJson("/api/ssh/hosts/list", {}),
    sshHostsCreate: (payload) => fetchJson("/api/ssh/hosts/create", payload),
    sshHostsUpdate: (payload) => fetchJson("/api/ssh/hosts/update", payload),
    sshHostsDelete: (payload) => fetchJson("/api/ssh/hosts/delete", payload),
    sshHostsDuplicate: (payload) => fetchJson("/api/ssh/hosts/duplicate", payload),
    sshHostsTest: (payload) => fetchJson("/api/ssh/hosts/test", payload),
    sshTestStart: async () => {
      throw new Error("SSH connection testing is available in the desktop app.");
    },
    sshTestStop: async () => {
      throw new Error("SSH connection testing is available in the desktop app.");
    },
    sshKeysList: () => fetchJson("/api/ssh/keys/list", {}),
    sshKeysImport: (payload) => fetchJson("/api/ssh/keys/import", payload),
    sshKeysGenerate: (payload) => fetchJson("/api/ssh/keys/generate", payload),
    sshKeysDelete: (payload) => fetchJson("/api/ssh/keys/delete", payload),
    sshKeysRename: (payload) => fetchJson("/api/ssh/keys/rename", payload).then((result) => result as SshKey | null),
    sshKeysTransferStart: (payload) =>
      fetchJson("/api/ssh/keys/transfer/start", payload).then(
        (result) => result as { operationId: string; status: "connecting" },
      ),
    sshKeysTransferStop: (payload) =>
      fetchJson("/api/ssh/keys/transfer/stop", payload).then((result) => result as { ok: boolean }),
    sshCertsList: () => fetchJson("/api/ssh/certs/list", {}),
    sshCertsImport: (payload) => fetchJson("/api/ssh/certs/import", payload),
    sshCertsDelete: (payload) => fetchJson("/api/ssh/certs/delete", payload),
    sshAuthAnswer: (payload) => fetchJson("/api/ssh/auth/answer", payload),
    sshAuthCancel: (payload) => fetchJson("/api/ssh/auth/cancel", payload),
    sshHostKeyAccept: (payload) => fetchJson("/api/ssh/host-key/accept", payload),
    sshHostKeyReject: (payload) => fetchJson("/api/ssh/host-key/reject", payload),
    sshConfigPreview: (payload) => fetchJson("/api/ssh/config/preview", payload),
    sshConfigImport: (payload) => fetchJson("/api/ssh/config/import", payload),
    sshKnownHostsImport: (payload) => fetchJson("/api/ssh/known-hosts/import", payload),

    resizeTerminal: (sessionId: string, size: TerminalSize) =>
      send({ type: "terminal:resize", sessionId, cols: size.cols, rows: size.rows }),
    writeTerminal: (sessionId: string, data: string, originWorkspaceId?: string) =>
      send({ type: "terminal:input", sessionId, data, ...(originWorkspaceId ? { originWorkspaceId } : {}) }),
    takeSessionControl: (sessionId: string) =>
      fetchJson("/api/session/take-control", { sessionId }) as Promise<{ ok: boolean }>,
    onTerminalInputBlocked: (handler: Handler<{ sessionId: string; ownerLabel: string }>) => {
      listeners.terminalInputBlocked.add(handler);
    },
    onStateUpdated: (handler: Handler<CoreState>) => listeners.stateUpdated.add(handler),
    onTerminalData: (handler: Handler<TerminalDataPayload>) => listeners.terminalData.add(handler),
    onTerminalReplay: (handler: Handler<TerminalReplayPayload>) => listeners.terminalReplay.add(handler),
    onTerminalExit: (handler: Handler<TerminalExitPayload>) => listeners.terminalExit.add(handler),
    onTerminalRemoved: (handler: Handler<{ sessionId: string }>) => listeners.terminalRemoved.add(handler),
    onGitPushProgress: (handler: Handler<GitPushProgressPayload>) => listeners.gitPushProgress.add(handler),
    subscribeTerminals: (sessionIds: string[]) => {
      // Idempotence at the source: the caller (attention sync) re-runs on
      // every bell/focus change, so an unchanged set would otherwise be
      // re-sent every few seconds — each triggering the server's full authz
      // pass. Reconnects still re-send via the open handler.
      if (
        hasSubscribedTerminals &&
        sessionIds.length === lastTerminalSubscription.length &&
        sessionIds.every((id, i) => id === lastTerminalSubscription[i])
      ) {
        return;
      }
      lastTerminalSubscription = [...sessionIds];
      hasSubscribedTerminals = true;
      const current = ws;
      if (current?.readyState === WebSocket.OPEN) {
        current.send(JSON.stringify({ type: "terminal:subscribe", sessionIds }));
      }
      // If not open, the connectWebSocket open handler re-sends the remembered
      // set — no need to queue it (and re-queuing would double-send).
    },
    subscribeResources: (resources: string[]) => {
      // Idempotence at the source (panes recompute their interest set on every
      // mount/unmount/grid change): an unchanged set is not re-sent. Reconnects
      // re-send via the open handler.
      if (
        hasDeclaredInterest &&
        resources.length === lastResourceInterest.length &&
        resources.every((id, i) => id === lastResourceInterest[i])
      ) {
        return;
      }
      lastResourceInterest = [...resources];
      hasDeclaredInterest = true;
      const current = ws;
      if (current?.readyState === WebSocket.OPEN) {
        current.send(JSON.stringify({ type: "resource:interest", resources }));
      }
      // If not open, the open handler re-sends the remembered set.
    },
    onResourceInvalidate: (handler: Handler<ResourceInvalidate>) => listeners.resourceInvalidate.add(handler),
    fetchResourceDetail: async (resource: string): Promise<ResourceDetail | null> => {
      const path = detailEndpointFor(resource);
      if (!path) return null;
      return (await fetchJson(path)) as ResourceDetail;
    },
    onConnectionState: (handler: Handler<ConnectionStatePayload>) => listeners.connectionState.add(handler),
    onSshAuthPrompt: (handler: Handler<SshAuthRequest>) => listeners.sshAuthPrompt.add(handler),
    onSshAuthPromptCancel: (handler: Handler<SshAuthPromptCancel>) => listeners.sshAuthPromptCancel.add(handler),
    onSshHostKeyChange: (handler: Handler<Record<string, unknown>>) => listeners.sshHostKeyChange.add(handler),
    onSshState: (handler: Handler<Record<string, unknown>>) => listeners.sshState.add(handler),
    onSshConnectionState: (handler: Handler<SshConnectionState>) => listeners.sshConnectionState.add(handler),
    onSshTestState: (handler: Handler<SshTestStatePayload>) => listeners.sshTestState.add(handler),
    onSshKeyTransferState: (handler: Handler<SshKeyTransferState>) => listeners.sshKeyTransferState.add(handler),
    onNotificationTargetRemoved: (handler: Handler<NotificationTargetRemoved>) => {
      listeners.notificationTargetRemoved.add(handler);
    },
    onApprovalRecorded: (handler: Handler<ApprovalRecorded>) => {
      listeners.approvalRecorded.add(handler);
    },
    getRemoteToken: () => token,
    setRemoteToken: (nextToken: string) => {
      persistToken(nextToken);
      window.location.reload();
    },
  };
}

export function createTransport(): Transport {
  if (window.strideterm) {
    return bindElectronTransport();
  }

  return createRemoteTransport();
}

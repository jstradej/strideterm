/**
 * Typed command authorization + execution for mobile commands (plan §8).
 *
 * Cloud authorization (RTDB Security Rules, App Check, the grants recorded on
 * the device at pairing time) is declared insufficient by the plan — this
 * module re-validates device membership, capability, profile allowlist, and
 * current target state before EVERY command, and calls the exact same
 * runtime business methods Telegram/IPC/remote already use (see
 * runtime-telegram-dispatch.ts for the mirrored pattern) — never a
 * mobile-only shortcut.
 *
 * WHERE AUTHORIZATION COMES FROM (review 2 §P0.3). The required capability, the
 * destructiveness and the maximum TTL of a command are read from
 * COMMAND_POLICY (mobile-command-policy.ts), keyed on `command.type`. They used
 * to come from a `requiredCapability` field the *mobile* wrote onto the command
 * — so the party being authorized chose the label it was authorized against.
 * That field no longer exists on the wire.
 *
 * Command lifecycle: queued -> claimed(lease) -> succeeded | failed |
 * outcome-unknown | expired. "Claimed" here is the local idempotency ledger
 * row (mobile-idempotency-store.ts), not an RTDB transaction — the RTDB
 * claim (exactly one desktop instance executes a given command) is
 * transport.claimCommand()'s job, called by mobile-manager.ts before this
 * dispatcher ever sees the command. mobile-manager.ts also enforces the
 * identity invariants (own pair, own target, inner commandId == outer
 * messageId) before it claims anything at all (review 2 §P0.2).
 *
 * Idempotent vs non-idempotent (plan §8's "outcome-unknown" rule) is the
 * `idempotent` column of the same policy table. A crash between claiming a
 * non-idempotent command and recording its result transitions it to
 * "outcome-unknown" on restart; it is never silently re-executed. The mobile
 * client is expected to refresh state and re-issue as a fresh command if still
 * needed.
 *
 * Known gap (disclosed, not silent): the protocol's task.sendInstruction
 * payload carries a free-text `instruction` field, but the only existing
 * runtime capability in this vein is `resendTaskInstruction(workspaceId,
 * role)`, which re-injects the WORKER's last already-recorded instruction —
 * it does not accept new text. Building a "accept arbitrary new text from
 * mobile and inject it into a running agent conversation" runtime method
 * would be new business logic (out of scope for this pass, which only wires
 * mobile commands to methods that already exist), and raw PTY writes are
 * explicitly forbidden for the mobile channel by the plan. This dispatcher
 * therefore implements task.sendInstruction as "resend the worker's last
 * instruction" and flags the result as degraded (`data.degraded === true`)
 * rather than pretending the mobile-authored text was delivered.
 */
import type { KeyObject } from "node:crypto";
import { canReconnectTunnel } from "../tunnel-manager.js";
import { getLogger } from "../logger.js";
import { findWorkspace } from "../runtime-utils.js";
import { formatWorkspaceDisplayName } from "../../shared/workspace-display.js";
import { createHash } from "node:crypto";
import { buildWorkspaceTree } from "../../shared/workspace-tree.js";
import type { WorkspaceState } from "../../shared/types/state.js";
import { checkCommandPolicy, policyFor } from "./mobile-command-policy.js";
import { deviceAllowsProfile, deviceHasCapability, isDeviceUsable } from "./mobile-device-store.js";
import { REMOTE_WEB_SESSION_CAPABILITY } from "./mobile-web-session-ticket-store.js";
import { RELAY_MOBILE_SESSION_ABSOLUTE_TTL_MS } from "./mobile-relay-protocol.js";
import {
  decodeCanonicalPublicKey,
  deriveRelayE2eKeys,
  publicKeyFromRaw,
  relayE2eInfo,
  relayE2eSalt,
  type RelayE2eDesktopOffer,
  type RelayE2ePhoneAcceptance,
} from "./mobile-crypto.js";
import type { RelayE2eOfferRecord, RelayE2eOfferStore } from "./mobile-relay-e2e-offer-store.js";
import type { RelayE2eSessionStore } from "./mobile-relay-e2e-session-store.js";
import type { MobileAuditLogStore } from "./mobile-audit-log-store.js";
import type { MobileNotificationOriginStore } from "./mobile-notification-origin-store.js";
import type { MobileIdempotencyStore } from "./mobile-idempotency-store.js";
import type { Command, CommandResult, CommandTerminalState, MobileDeviceRecord } from "./mobile-schemas.js";
import type { AppState } from "../../shared/types/state.js";
import type { MobileCommandType } from "../../shared/types/notifications.js";

const log = getLogger("mobile-command-dispatch");

// RTDB limits encrypted command results to 16 KiB of base64 ciphertext. Keep
// each page within that limit after adding the
// 16-byte AES-GCM tag.
const WORKSPACE_CATALOG_MAX_PAGE_ITEMS = 1000;

function workspaceParentIds(workspaces: WorkspaceState[]): Map<string, string | null> {
  const tree = buildWorkspaceTree(workspaces);
  return new Map(workspaces.map((workspace) => [workspace.id, tree.parentOf(workspace.id)]));
}

function workspaceCatalogToken(workspaces: WorkspaceState[], parents: Map<string, string | null>): string {
  const membership = workspaces.map((workspace) => [workspace.id, parents.get(workspace.id) ?? null]);
  return createHash("sha256").update(JSON.stringify(membership)).digest("hex");
}

function latestIso(...values: Array<string | null | undefined>): string | undefined {
  let latest: string | undefined;
  let latestTime = 0;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time) || time <= latestTime) continue;
    latest = value;
    latestTime = time;
  }
  return latest;
}

interface MobileCatalogPullRequest {
  status?: string;
  closedDate?: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  updatedAt?: string;
  state?: string;
}

interface MobileCatalogReviewSummary {
  pullRequest?: MobileCatalogPullRequest;
  checks?: { failedCount?: number; pendingCount?: number; passedCount?: number };
  lastActivityAt?: string | null;
}

interface TaskActionResult {
  ok: boolean;
}

/**
 * Runtime business methods this dispatcher calls — the exact same methods
 * Telegram/IPC/remote-server already call (runtime-task-handlers.ts,
 * runtime.ts's createCloudflareTunnel/getPayload). Typed as a narrow
 * structural interface (not `typeof import("../runtime.js")`) so tests can
 * supply a lightweight fake instead of booting the full runtime.
 */
export interface MobileCommandRuntime {
  pauseTask(workspaceId: string): TaskActionResult;
  resumeTask(workspaceId: string): Promise<TaskActionResult>;
  stopTask(workspaceId: string): TaskActionResult;
  resetTask(workspaceId: string): Promise<TaskActionResult>;
  updateTaskDescription(workspaceId: string, description: string): Promise<TaskActionResult>;
  resendTaskInstruction(workspaceId: string, role: "worker" | "judge"): Promise<TaskActionResult>;
  /**
   * Clears the attention alert on a session — the SAME method the desktop's own
   * "Dismiss"/"Jump" and the remote client call, so a phone acknowledgement lands
   * in one code path with them rather than a second, mobile-only clearing rule.
   */
  clearAlertForSession(sessionId: string, options?: { dismissed?: boolean }): unknown;
  createCloudflareTunnel(): Promise<unknown>;
  getPayload(): {
    git?: {
      workspaces?: Record<
        string,
        {
          available?: boolean;
          branch?: string;
          dirtyCount?: number;
          branchMerged?: boolean;
          lastChangeAt?: string | null;
        }
      >;
    };
    taskRunner?: Record<string, { state?: string; currentRound?: number; maxRounds?: number }>;
    attention?: {
      byWorkspace?: Record<string, { count?: number; latestAt?: string | null }>;
      byProject?: Record<string, { count?: number; latestAt?: string | null }>;
      sessions?: Record<
        string,
        { workspaceId?: string; activity?: string; agentLike?: boolean; hasUserInput?: boolean }
      >;
    };
    azureDevops?: { pullRequests?: Record<string, MobileCatalogReviewSummary> };
    github?: { pullRequests?: Record<string, MobileCatalogReviewSummary> };
    remoteAccess?: {
      enabled?: boolean;
      host?: string;
      tunnel?: { status?: string; publicUrl?: string; mode?: string };
    };
  };
}

/**
 * Narrow structural dependency for issuing single-use WebView session
 * tickets (plan §9.2). The concrete implementation
 * (mobile-web-session-ticket-store.ts) lives in its own module rather than
 * being imported here directly, and definitely not remote-server.ts — see
 * that module's doc comment for why (avoids a
 * dispatch -> remote-server -> runtime -> dispatch import cycle). runtime.ts
 * constructs the one shared store instance and passes it in as this dep.
 */
export interface MobileWebSessionTicketIssuer {
  issueTicket(input: {
    deviceId: string;
    pairId: string;
    profileId: string;
    allowedOrigin: string;
    /** Which of this installation's servers the ticket may be redeemed at. */
    transport: "relay" | "legacy";
    /** Audit correlation only: the last 8 characters of the requesting command's id. */
    commandRef?: string;
  }): { ticketId: string; secret: string; expiresAt: number };
}

/**
 * What this dispatcher needs to know about the managed relay: whether one is running and, if so,
 * which origin it serves.
 *
 * Deliberately read-only and deliberately narrow. The relay is a TRANSPORT the desktop may be
 * offering; a command never starts, stops or reconfigures it, because the only thing that decides
 * whether this desktop has a relay is the user's own setting.
 */
export interface MobileRelayTransportStatus {
  status(): { enabled: boolean; state: string; relayOrigin: string };
}

export interface MobileCommandDispatcherDeps {
  getState: () => AppState;
  runtime: MobileCommandRuntime;
  idempotencyStore: MobileIdempotencyStore;
  auditLogStore: MobileAuditLogStore;
  ticketIssuer: MobileWebSessionTicketIssuer;
  /** Absent when this build has no relay at all, which is the default. */
  relay?: MobileRelayTransportStatus;
  /**
   * The device record as it stands RIGHT NOW, re-read at the moment a ticket is about to be minted.
   *
   * The dispatcher is handed the record its caller authorised the command against, and between those
   * two instants a revoke, a capability change or a profile-allowlist change can land — the ticket
   * itself lives for sixty seconds, so the window is real and it is the plan's §5 "Ticket" 5 TOCTOU.
   * Absent in a test that does not care, in which case the record passed to `dispatch` is used.
   */
  currentDevice?: (deviceId: string) => MobileDeviceRecord | null;
  /**
   * Latches that this device completed a relay session with end-to-end encryption
   * (`MobileDeviceRecord.relayE2eSeenAt`). Called once the session keys have been derived and stored,
   * never for a ticket that carries no `e2e` block. Absent in a test that does not care.
   */
  markRelayE2eSeen?: (deviceId: string) => void | Promise<void>;
  /**
   * Which alert each notification event was raised from, recorded when the event was sent
   * (mobile-notification-origin-store.ts). Lets `notification.acknowledge` clear the alert the
   * phone is acknowledging, given a payload that carries only the event id.
   *
   * Absent in a test that does not exercise acknowledgement, and absent for an event that never
   * raised an alert — in both cases the ack degrades to the local-only acknowledgement the phone
   * has already performed, which is exactly the old behaviour.
   */
  notificationOrigins?: MobileNotificationOriginStore;
  /**
   * This installation's own long-lived pairing X25519 private key (the same one
   * `mobile-manager.ts` uses for the envelope channel). Needed to derive relay end-to-end
   * encryption session keys (plan 2026-09-23, decision 1) — absent in a test/build that does not
   * wire relay end-to-end encryption at all, in which case `remote.endpoint.request` never offers
   * an `e2e` block and `remote.webSession.issue` ignores one if a client sends it anyway.
   */
  ownPrivateKey?: KeyObject;
  /** Ephemeral key-exchange offers minted by `remote.endpoint.request`, redeemed by `remote.webSession.issue`. */
  e2eOfferStore?: RelayE2eOfferStore;
  /** Where the derived session keys land, keyed by the ticket that was issued alongside them. */
  e2eSessionStore?: RelayE2eSessionStore;
  /**
   * Profiles open in a desktop window, the most recently focused window's profile first. Lets the
   * phone's profile picker lead with what the person is working on at the desk. Absent in a test
   * that does not care — the catalog then carries no desktop order.
   */
  desktopProfileFocusOrder?: () => string[];
  now?: () => number;
}

/**
 * Idempotency is one column of COMMAND_POLICY now, not a second list kept beside it.
 *
 * It used to be a `Set` here and prose in the module doc above, which is two places to update and
 * one place to forget. Since the same table already has to be exhaustive over the command union for
 * the capability derivation, folding this in costs nothing and removes a way for the two to
 * disagree.
 */
function isIdempotent(type: MobileCommandType): boolean {
  return policyFor(type).idempotent;
}

/**
 * Commands whose RESULT is a credential: it reaches the phone once, in the answer, and is never
 * written to disk. The idempotency ledger survives a restart and keeps rows for a day, so a
 * `ticketSecret` in it would outlive the 60 s ticket it redeems by 24 h and sit beside the
 * persisted state. For these the ledger keeps the outcome (status and error code) and nothing else;
 * a replay of a completed one answers `failed` / `ticket-expired` — the ticket it once named is
 * spent or expired by then, and the phone's answer to that is to issue a fresh one.
 */
const CREDENTIAL_RESULT_TYPES: ReadonlySet<MobileCommandType> = new Set<MobileCommandType>(["remote.webSession.issue"]);

interface ExecResult {
  status: CommandTerminalState;
  data: Record<string, unknown> | null;
  errorCode: string | null;
}

function succeeded(data: Record<string, unknown> | null = null): ExecResult {
  return { status: "succeeded", data, errorCode: null };
}
function failed(errorCode: string): ExecResult {
  return { status: "failed", data: null, errorCode };
}

/** Never includes remoteAccess.token — the master token must never appear in a mobile-bound payload (plan §5.1/§9.1). */
function sanitizeRemoteStatus(payload: ReturnType<MobileCommandRuntime["getPayload"]>): Record<string, unknown> {
  const remoteAccess = payload?.remoteAccess || {};
  return {
    enabled: !!remoteAccess.enabled,
    host: typeof remoteAccess.host === "string" ? remoteAccess.host : "",
    tunnelStatus: remoteAccess.tunnel?.status || "idle",
    tunnelUrl: remoteAccess.tunnel?.publicUrl || "",
  };
}

/**
 * The one origin a WebView session ticket may currently be issued for: the
 * origin of the live Cloudflare tunnel URL. Returns "" when no tunnel is
 * connected (LAN-only / disconnected) — a webSession ticket is refused in
 * that case rather than scoped to a LAN origin, matching plan §11.7's
 * production-path restriction to an HTTPS tunnel/custom HTTPS endpoint.
 */
/**
 * The relay origin this desktop is currently reachable at, or "" when it is not.
 *
 * "Currently" is doing real work: an enabled flag is not a transport. The origin is only offered
 * once the connector has actually completed its handshake, because a ticket issued for a relay this
 * desktop is not attached to would send the phone to an origin that answers 503.
 */
function currentRelayOrigin(relay: MobileRelayTransportStatus | undefined): string {
  const status = relay?.status();
  if (!status || !status.enabled || status.state !== "ready") return "";
  return status.relayOrigin || "";
}

/**
 * The endpoint answer, in the shape the protocol actually defines.
 *
 * `host` carries a full origin for the managed relay (scheme included, because a local relay is
 * reached over loopback HTTP and a production one over HTTPS) and a bare host for the Cloudflare
 * path, which is what that path has always sent. The schema's own description allows both, and the
 * client resolves either into an origin.
 */
function buildEndpointMetadata(args: {
  transport: "cloudflare" | "managedRelay";
  host: string;
  tunnelKind: string;
  now: number;
  ttlMs: number;
}): Record<string, unknown> {
  return {
    host: args.host,
    tunnelKind: args.tunnelKind,
    transport: args.transport,
    issuedAt: args.now,
    expiresAt: args.now + args.ttlMs,
  };
}

/** How long an endpoint answer describes. Short: it is a snapshot of a transport, not a lease. */
const REMOTE_ENDPOINT_TTL_MS = 300_000;

/**
 * The relay end-to-end encryption offer to fold into a `managedRelay` endpoint answer (plan
 * 2026-09-23, decision 1), or `{}` on a build with no `e2eOfferStore` wired — which is exactly the
 * "no e2e" answer an older desktop would send, so a phone that understands the block falls back to
 * the plaintext relay viewer path and one that does not simply never sees the field.
 *
 * A fresh ephemeral pair is minted on EVERY call (never reused across answers), with the SAME TTL
 * as the answer itself — the offer must not outlive the endpoint metadata that named its `keyId`.
 */
function buildRelayE2eOffer(deps: MobileCommandDispatcherDeps): { e2e?: RelayE2eDesktopOffer } {
  if (!deps.e2eOfferStore) return {};
  const offer = deps.e2eOfferStore.createOffer(REMOTE_ENDPOINT_TTL_MS);
  return { e2e: { v: 1, keyId: offer.keyId, desktopEphemeralPub: offer.desktopEphemeralPub } };
}

/**
 * The host a Cloudflare-transport answer names: the tunnel's public URL host, or nothing.
 *
 * It used to fall back to the configured LAN host (`0.0.0.0` by default). The desktop never issues
 * a WebView ticket for anything but a connected tunnel (`currentAllowedOrigin`), so that answer was
 * useless to the phone every time — including for a hand-set IP — and it read as "your desktop
 * said no". No host now means the command fails with `tunnel-unavailable`.
 */
function cloudflareEndpointHost(payload: ReturnType<MobileCommandRuntime["getPayload"]>): string {
  const publicUrl = payload?.remoteAccess?.tunnel?.publicUrl || "";
  if (!publicUrl) return "";
  try {
    return new URL(publicUrl).host;
  } catch {
    return "";
  }
}

/** Relay switched on but not attached (e.g. its TLS handshake fails behind inspection). */
function relayEnabledButNotReady(relay: MobileRelayTransportStatus | undefined): boolean {
  const status = relay?.status();
  return status?.enabled === true && status.state !== "ready";
}

function currentAllowedOrigin(payload: ReturnType<MobileCommandRuntime["getPayload"]>): string {
  if (payload?.remoteAccess?.tunnel?.status !== "connected") return "";
  const publicUrl = payload?.remoteAccess?.tunnel?.publicUrl || "";
  if (!publicUrl) return "";
  try {
    return new URL(publicUrl).origin;
  } catch {
    return "";
  }
}

export function createMobileCommandDispatcher(deps: MobileCommandDispatcherDeps) {
  const now = deps.now || (() => Date.now());

  function audit(
    device: MobileDeviceRecord | null,
    command: Command,
    status: "success" | "failure",
    detail: string,
  ): void {
    deps.auditLogStore.logEntry({
      deviceId: device?.deviceId || command.targetDeviceId,
      pairId: device?.pairId || "",
      actor: "device",
      action: `command.${command.type}`,
      status,
      detail,
    });
  }

  function buildResult(
    commandId: string,
    status: CommandTerminalState,
    data: Record<string, unknown> | null,
    errorCode: string | null,
  ): CommandResult {
    return { commandId, status, completedAt: now(), data, errorCode };
  }

  /**
   * Resolves the task workspace a task.* command targets, re-validating
   * profile scope and that the workspace's CURRENT task still matches
   * taskId (a stale command referencing a deleted/recreated task must not
   * silently act on whatever task workspace happens to exist now).
   */
  function resolveTaskWorkspace(
    state: AppState,
    profileId: string,
    workspaceId: string,
    taskId: string,
  ): { ok: true; workspace: AppState["workspaces"][number] } | { ok: false; errorCode: string } {
    const workspace = findWorkspace(state, workspaceId);
    if (!workspace) return { ok: false, errorCode: "workspace-not-found" };
    if ((workspace.profileId || "default") !== profileId) return { ok: false, errorCode: "cross-profile-workspace" };
    if (workspace.kind !== "task" || !workspace.task) return { ok: false, errorCode: "not-a-task-workspace" };
    if (workspace.task.taskId !== taskId) return { ok: false, errorCode: "task-id-mismatch" };
    return { ok: true, workspace };
  }

  /**
   * Checks the workspace a remote command named, or that the profile has one at all.
   *
   * `workspaceId` is optional on `remote.endpoint.request` and `remote.webSession.issue` (review 1
   * finding 2): a phone that has just picked this desktop and a profile in its own picker knows no
   * workspace, and while the field was required there was no way for it to ask — which is why the
   * remote screen was reachable only from a notification that happened to name one. Named, it is
   * still held to belonging to `profileId`. Absent, the profile itself must have at least one
   * workspace, because a session opened onto a profile with nothing in it is a blank screen the user
   * cannot act on and the desktop is the side that knows.
   *
   * What this never becomes is a cross-profile hole: with no workspace named there is nothing to
   * cross, and the profile is `command.profileId`, which the caller was already authorised for
   * against the device record's own allowlist.
   */
  function checkRemoteTarget(
    state: AppState,
    profileId: string,
    workspaceId: string | undefined,
  ): { ok: true } | { ok: false; reason: string } {
    const profileOf = (workspace: { profileId?: string }): string => workspace.profileId || "default";
    if (workspaceId === undefined) {
      const any = state.workspaces.some((workspace) => profileOf(workspace) === profileId);
      return any ? { ok: true } : { ok: false, reason: "profile-has-no-workspace" };
    }
    const workspace = findWorkspace(state, workspaceId);
    if (!workspace || profileOf(workspace) !== profileId) {
      return { ok: false, reason: "cross-profile-workspace" };
    }
    return { ok: true };
  }

  async function execute(command: Command, state: AppState, device: MobileDeviceRecord): Promise<ExecResult> {
    switch (command.type) {
      case "notification.acknowledge": {
        // The phone has already marked the event read on its own screen — that half is local and
        // unconditional there. This half is the desktop's: the alert that produced the event stops
        // asking for attention, because the user has now dealt with it from the phone. Without it a
        // reader who acknowledged on the phone still came back to a desktop badge for something
        // already handled.
        //
        // `dismissed: false` is deliberate. An acknowledgement is engagement — the user read the
        // event and said so — not a dismissal, which feeds the adaptive suppression that makes a
        // repeatedly-ignored session go quieter.
        const origin = deps.notificationOrigins?.get(command.payload.eventId) || null;
        if (!origin) {
          // Either an event that never raised an alert (PR review / pipeline forwards), or one older
          // than the store's window. Nothing to clear, and the phone's local half already happened.
          return succeeded({ eventId: command.payload.eventId, cleared: false });
        }
        // Re-checked here rather than trusted from the recording: a workspace can be moved between
        // profiles while the event sits unread on the phone, and an acknowledgement must never clear
        // an alert in a profile this command was not authorised for.
        const workspace = findWorkspace(state, origin.workspaceId);
        const owningProfileId = workspace ? workspace.profileId || "default" : null;
        if (owningProfileId !== null && owningProfileId !== command.profileId) {
          return succeeded({ eventId: command.payload.eventId, cleared: false });
        }
        const sessionId = origin.sessionId || `${origin.workspaceId}:${origin.panelId}`;
        deps.runtime.clearAlertForSession(sessionId, { dismissed: false });
        return succeeded({ eventId: command.payload.eventId, cleared: true });
      }

      case "task.pause": {
        const resolved = resolveTaskWorkspace(
          state,
          command.profileId,
          command.payload.workspaceId,
          command.payload.taskId,
        );
        if (!resolved.ok) return failed(resolved.errorCode);
        const result = deps.runtime.pauseTask(command.payload.workspaceId);
        return result.ok ? succeeded() : failed("task-not-pausable");
      }
      case "task.resume": {
        const resolved = resolveTaskWorkspace(
          state,
          command.profileId,
          command.payload.workspaceId,
          command.payload.taskId,
        );
        if (!resolved.ok) return failed(resolved.errorCode);
        const result = await deps.runtime.resumeTask(command.payload.workspaceId);
        return result.ok ? succeeded() : failed("task-not-resumable");
      }
      case "task.stop": {
        const resolved = resolveTaskWorkspace(
          state,
          command.profileId,
          command.payload.workspaceId,
          command.payload.taskId,
        );
        if (!resolved.ok) return failed(resolved.errorCode);
        const result = deps.runtime.stopTask(command.payload.workspaceId);
        return result.ok ? succeeded() : failed("task-not-stoppable");
      }
      case "task.reset": {
        const resolved = resolveTaskWorkspace(
          state,
          command.profileId,
          command.payload.workspaceId,
          command.payload.taskId,
        );
        if (!resolved.ok) return failed(resolved.errorCode);
        const result = await deps.runtime.resetTask(command.payload.workspaceId);
        return result.ok ? succeeded() : failed("task-not-resettable");
      }
      case "task.updateDescription": {
        const resolved = resolveTaskWorkspace(
          state,
          command.profileId,
          command.payload.workspaceId,
          command.payload.taskId,
        );
        if (!resolved.ok) return failed(resolved.errorCode);
        const result = await deps.runtime.updateTaskDescription(
          command.payload.workspaceId,
          command.payload.description,
        );
        return result.ok ? succeeded() : failed("update-description-failed");
      }
      case "task.sendInstruction": {
        const resolved = resolveTaskWorkspace(
          state,
          command.profileId,
          command.payload.workspaceId,
          command.payload.taskId,
        );
        if (!resolved.ok) return failed(resolved.errorCode);
        // See module doc comment: free-text instruction content is not
        // deliverable in this pass — resend the worker's last instruction
        // and disclose the degradation in the result data.
        const result = await deps.runtime.resendTaskInstruction(command.payload.workspaceId, "worker");
        return result.ok
          ? succeeded({
              degraded: true,
              note: "resent worker's last instruction; free-text content not deliverable in this pass",
            })
          : failed("nothing-to-resend");
      }

      case "profile.catalog.get": {
        // Names are presentation metadata; ids remain the authorization boundary. Derive the list
        // from the authenticated device record rather than a client filter, so this result cannot
        // enumerate profiles the phone was never granted. Workspace counts let the picker explain
        // why an otherwise-authorized empty profile cannot open a useful remote session.
        const allowed = new Set(device.profileAllowlist);
        // Which allowed profiles are open on the desktop, most recently focused window first. The
        // rank is counted among ALLOWED profiles only, so a gap cannot hint at a window of a
        // profile this phone may not see; `desktopActive` marks the profile of the focused window
        // itself, and is simply absent when that window belongs to a profile outside the allowlist.
        const focusOrder = deps.desktopProfileFocusOrder?.() ?? [];
        const openAllowed = focusOrder.filter((profileId) => allowed.has(profileId));
        const profiles = state.profiles
          .filter((profile) => allowed.has(profile.id))
          .map((profile) => {
            const profileWorkspaces = state.workspaces.filter(
              (workspace) => (workspace.profileId || "default") === profile.id,
            );
            const desktopRank = openAllowed.indexOf(profile.id);
            return {
              id: profile.id,
              name: profile.name,
              workspaceCount: profileWorkspaces.length,
              workspaceNames: profileWorkspaces
                .map((workspace) => formatWorkspaceDisplayName(workspace))
                .filter((name): name is string => typeof name === "string" && name.length > 0)
                .slice(0, 5),
              ...(desktopRank >= 0 ? { desktopRank } : {}),
              ...(focusOrder[0] === profile.id ? { desktopActive: true } : {}),
            };
          });
        if (!command.payload.includeWorkspaces) return succeeded({ profiles });

        const profileId = command.profileId;
        if (!allowed.has(profileId)) return failed("profile-not-allowed");
        const profileIndex = state.profiles.findIndex((profile) => profile.id === profileId);
        if (profileIndex < 0) return failed("profile-not-found");
        // AppState.workspaces is the desktop's canonical manually ordered list.
        // Profile.workspaceIds is retained for legacy/grid compatibility and
        // can lag behind manual reorders, so never use it as the catalog order.
        const profileWorkspaces = state.workspaces.filter(
          (workspace) => (workspace.profileId || "default") === profileId,
        );
        const runtimePayload = deps.runtime.getPayload();
        const gitWorkspaces = runtimePayload.git?.workspaces ?? {};
        const taskRunner = runtimePayload.taskRunner ?? {};
        const attention = runtimePayload.attention;
        const attentionSessions = Object.values(attention?.sessions ?? {});
        const azurePullRequests = runtimePayload.azureDevops?.pullRequests ?? {};
        const githubPullRequests = runtimePayload.github?.pullRequests ?? {};
        const agentActivityByWorkspace = new Map<string, { runningCount: number; doneCount: number }>();
        for (const session of attentionSessions) {
          if (
            !session.workspaceId ||
            !session.agentLike ||
            !session.hasUserInput ||
            (session.activity !== "running" && session.activity !== "done")
          ) {
            continue;
          }
          const counts = agentActivityByWorkspace.get(session.workspaceId) ?? { runningCount: 0, doneCount: 0 };
          if (session.activity === "running") counts.runningCount++;
          else counts.doneCount++;
          agentActivityByWorkspace.set(session.workspaceId, counts);
        }
        const parents = workspaceParentIds(profileWorkspaces);
        const catalogToken = workspaceCatalogToken(profileWorkspaces, parents);
        const offset = command.payload.workspaceOffset ?? 0;
        if (
          (offset > 0 && !command.payload.workspaceCatalogToken) ||
          (command.payload.workspaceCatalogToken && command.payload.workspaceCatalogToken !== catalogToken)
        ) {
          return failed("workspace-catalog-changed");
        }
        if (offset > profileWorkspaces.length) return failed("workspace-catalog-changed");

        const resultProfiles: Array<Record<string, unknown>> = profiles.map((profile) => ({ ...profile }));
        const selectedProfile = resultProfiles.find((profile) => profile.id === profileId);
        if (!selectedProfile) return failed("profile-not-allowed");
        const resultData: Record<string, unknown> = {
          profiles: resultProfiles,
          workspaceCatalogVersion: 1,
          workspaceCatalogProfileId: profileId,
          workspaceCatalogToken: catalogToken,
          workspaceNextOffset: undefined,
        };
        const page: Array<Record<string, unknown>> = [];
        // Starting at offset, add only allowlisted metadata. Measure the final
        // CommandResult JSON so encoding, optional fields and wrapper costs all
        // count toward the page budget.
        for (let i = offset; i < profileWorkspaces.length && page.length < WORKSPACE_CATALOG_MAX_PAGE_ITEMS; i++) {
          const workspace = profileWorkspaces[i];
          const workspaceId = workspace.id;
          const task = workspace.task;
          const liveTask = taskRunner[workspaceId];
          const gitSummary = gitWorkspaces[workspaceId];
          const workspaceAttention = attention?.byWorkspace?.[workspaceId] ?? attention?.byProject?.[workspaceId];
          const agentActivity = agentActivityByWorkspace.get(workspaceId);
          const agentRunningCount = agentActivity?.runningCount ?? 0;
          const agentDoneCount = agentActivity?.doneCount ?? 0;
          const agentActivityState = agentRunningCount > 0 ? "running" : agentDoneCount > 0 ? "done" : undefined;
          const review = workspace.review;
          const reviewProvider = review?.provider;
          const reviewCheckoutMode = review?.checkout?.mode;
          const isReviewChild =
            (reviewProvider === "azure-devops" || reviewProvider === "github") &&
            reviewCheckoutMode === "managed-worktree";
          const reviewSummary = review?.prKey
            ? reviewProvider === "github"
              ? githubPullRequests[review.prKey]
              : reviewProvider === "azure-devops"
                ? azurePullRequests[review.prKey]
                : undefined
            : undefined;
          const reviewPr = reviewSummary?.pullRequest;
          let prStatus: string | undefined;
          let prClosedAt: string | undefined;
          if (isReviewChild && review?.prKey) {
            if (reviewProvider === "azure-devops") {
              prStatus =
                reviewPr?.status === "completed" || reviewPr?.status === "abandoned" ? reviewPr.status : "active";
              if (prStatus !== "active" && reviewPr?.closedDate) prClosedAt = reviewPr.closedDate;
            } else if (reviewProvider === "github") {
              if (reviewPr?.mergedAt) {
                prStatus = "completed";
                prClosedAt = reviewPr.mergedAt;
              } else if (reviewPr && reviewPr.state !== "open") {
                prStatus = "abandoned";
                prClosedAt = reviewPr.closedAt || reviewPr.updatedAt;
              } else {
                prStatus = "active";
              }
            }
          } else if (!isReviewChild && gitSummary?.branchMerged) {
            prStatus = "completed";
          }
          const checks = reviewSummary?.checks;
          const checksState = checks?.failedCount
            ? "failed"
            : checks?.pendingCount
              ? "pending"
              : checks?.passedCount
                ? "passed"
                : undefined;
          const prLastActivityAt = reviewSummary?.lastActivityAt || undefined;
          const attentionLatestAt = workspaceAttention?.latestAt || undefined;
          const gitLastChangeAt = gitSummary?.lastChangeAt || undefined;
          const lastActivityAt = latestIso(
            isReviewChild ? prLastActivityAt : undefined,
            attentionLatestAt,
            gitLastChangeAt,
          );
          const item: Record<string, unknown> = {
            id: workspace.id,
            name: formatWorkspaceDisplayName(workspace) || workspace.name,
            kind: workspace.kind || "terminal",
            ...(workspace.icon ? { icon: workspace.icon } : {}),
            ...(workspace.color ? { color: workspace.color } : {}),
            ...(workspace.starred ? { starred: true } : {}),
            ...(parents.get(workspace.id) ? { parentWorkspaceId: parents.get(workspace.id) } : {}),
            tabCount: workspace.panels?.length ?? 0,
            ...(task?.state || liveTask?.state ? { taskState: liveTask?.state || task?.state } : {}),
            ...(workspace.kind === "task"
              ? {
                  taskCurrentRound: liveTask?.currentRound ?? task?.currentRound ?? 0,
                  taskMaxRounds: liveTask?.maxRounds ?? task?.maxRounds ?? 10,
                  ...(task?.createdAt ? { taskCreatedAt: task.createdAt } : {}),
                }
              : {}),
            ...(gitSummary
              ? {
                  ...(typeof gitSummary.available === "boolean" ? { gitAvailable: gitSummary.available } : {}),
                  ...(typeof gitSummary.branchMerged === "boolean" ? { branchMerged: gitSummary.branchMerged } : {}),
                  ...(gitLastChangeAt ? { gitLastChangeAt } : {}),
                }
              : {}),
            ...(reviewProvider ? { reviewProvider } : {}),
            ...(reviewCheckoutMode ? { reviewCheckoutMode } : {}),
            ...(isReviewChild ? { reviewHasPullRequest: Boolean(review?.pullRequest) } : {}),
            ...(prStatus ? { prStatus } : {}),
            ...(prClosedAt ? { prClosedAt } : {}),
            ...(checksState ? { checksState } : {}),
            ...(prLastActivityAt ? { prLastActivityAt } : {}),
            ...(workspaceAttention?.count ? { attentionCount: workspaceAttention.count } : {}),
            ...(attentionLatestAt ? { attentionLatestAt } : {}),
            ...(agentActivityState ? { agentActivityState } : {}),
            ...(agentRunningCount > 0 ? { agentRunningCount } : {}),
            ...(agentDoneCount > 0 ? { agentDoneCount } : {}),
            ...(lastActivityAt ? { lastActivityAt } : {}),
            ...(gitWorkspaces[workspace.id]?.available
              ? {
                  ...(gitWorkspaces[workspace.id].branch ? { branch: gitWorkspaces[workspace.id].branch } : {}),
                  ...(typeof gitWorkspaces[workspace.id].dirtyCount === "number"
                    ? { dirtyCount: gitWorkspaces[workspace.id].dirtyCount }
                    : {}),
                }
              : {}),
            ...(workspace.lastWorkedAt ? { lastWorkedAt: workspace.lastWorkedAt } : {}),
          };
          page.push(item);
          const next = i + 1 < profileWorkspaces.length ? i + 1 : undefined;
          selectedProfile.workspaces = page;
          selectedProfile.workspacesTruncated = next !== undefined;
          resultData.workspaceNextOffset = next;
          const commandResult = {
            commandId: command.commandId,
            status: "succeeded",
            completedAt: now(),
            data: resultData,
            errorCode: null,
          };
          // Keep a 64-byte safety margin for the actual completion timestamp
          // and any wrapper details added to CommandResult in a compatible way.
          const plaintextBytes = Buffer.byteLength(JSON.stringify(commandResult), "utf8") + 64;
          const ciphertextBase64Bytes = Math.ceil((plaintextBytes + 16) / 3) * 4;
          if (ciphertextBase64Bytes > 16_384) {
            page.pop();
            if (page.length === 0) return failed("workspace-metadata-too-large");
            break;
          }
        }
        const nextOffset = offset + page.length;
        selectedProfile.workspaces = page;
        selectedProfile.workspacesTruncated = nextOffset < profileWorkspaces.length;
        resultData.workspaceNextOffset = nextOffset < profileWorkspaces.length ? nextOffset : undefined;
        return succeeded(resultData);
      }

      case "remote.status.get": {
        const workspace = findWorkspace(state, command.payload.workspaceId);
        if (!workspace || (workspace.profileId || "default") !== command.profileId) {
          return failed("cross-profile-workspace");
        }
        return succeeded(sanitizeRemoteStatus(deps.runtime.getPayload()));
      }
      case "remote.endpoint.request": {
        const target = checkRemoteTarget(state, command.profileId, command.payload.workspaceId);
        if (!target.ok) return failed(target.reason);
        // The managed relay is a THIRD transport, not a replacement (relay plan §2.2). When one is
        // running it is what the phone is told about — and it needs no Cloudflare tunnel, so this
        // path deliberately does not open one. Answering with the tunnel instead would be the
        // automatic fallback the plan forbids, in the other direction.
        const relayOrigin = currentRelayOrigin(deps.relay);
        if (relayOrigin) {
          // Status first, metadata second: both carry a `host`, and the one that must survive is
          // the endpoint's — the status field means "the LAN host this desktop is configured for",
          // which is a different question and not the one the phone asked.
          return succeeded({
            ...sanitizeRemoteStatus(deps.runtime.getPayload()),
            ...buildEndpointMetadata({
              transport: "managedRelay",
              host: relayOrigin,
              tunnelKind: "managedRelay",
              now: now(),
              ttlMs: REMOTE_ENDPOINT_TTL_MS,
            }),
            ...buildRelayE2eOffer(deps),
          });
        }
        if (!canReconnectTunnel(state.settings.remoteAccess)) {
          // Fixed codes only, never free text. A relay that is on but not attached is not a refusal
          // by anybody — the desktop simply has no route right now — and the phone says so.
          return failed(relayEnabledButNotReady(deps.relay) ? "relay-unavailable" : "tunnel-not-approved");
        }
        let payload = deps.runtime.getPayload();
        const liveOrigin = currentAllowedOrigin(payload);
        if (liveOrigin) {
          log.info("remote endpoint reused connected tunnel", {
            status: payload.remoteAccess?.tunnel?.status || "unknown",
            mode: payload.remoteAccess?.tunnel?.mode || "unknown",
          });
        } else {
          log.info("remote endpoint requested tunnel reconnect", {
            status: payload.remoteAccess?.tunnel?.status || "unknown",
          });
          try {
            await deps.runtime.createCloudflareTunnel();
          } catch (err) {
            // The error's text (a cloudflared path, a user directory) goes to the log only; the phone
            // gets a fixed code.
            log.warn("remote endpoint tunnel start failed", { err: (err as Error)?.message });
            return failed("tunnel-unavailable");
          }
          payload = deps.runtime.getPayload();
        }
        const endpointHost = currentAllowedOrigin(payload) ? cloudflareEndpointHost(payload) : "";
        if (!endpointHost) return failed("tunnel-unavailable");
        return succeeded({
          ...sanitizeRemoteStatus(payload),
          ...buildEndpointMetadata({
            transport: "cloudflare",
            host: endpointHost,
            tunnelKind: payload?.remoteAccess?.tunnel?.mode || "quick",
            now: now(),
            ttlMs: REMOTE_ENDPOINT_TTL_MS,
          }),
        });
      }
      case "remote.tunnel.reconnect": {
        const workspace = findWorkspace(state, command.payload.workspaceId);
        if (!workspace || (workspace.profileId || "default") !== command.profileId) {
          return failed("cross-profile-workspace");
        }
        // Unchanged, and deliberately relay-unaware: "reconnect the tunnel" means the tunnel.
        if (!canReconnectTunnel(state.settings.remoteAccess)) {
          return failed("tunnel-not-approved");
        }
        await deps.runtime.createCloudflareTunnel();
        return succeeded(sanitizeRemoteStatus(deps.runtime.getPayload()));
      }
      case "remote.webSession.issue": {
        const target = checkRemoteTarget(state, command.profileId, command.payload.workspaceId);
        if (!target.ok) return failed(target.reason);
        // THE AUTHORITATIVE RE-READ, immediately before the mint (production hardening §5 "Ticket" 5).
        // Everything above authorised this command against the record as it was when the envelope was
        // accepted; a ticket is a credential that outlives that instant by a minute, so the record is
        // read again here and the three things that can have changed are checked again: is the device
        // still active, does it still hold `remote.webSession`, and is this profile still on its
        // allowlist. Without it, a revoke landing in that window produced a usable session.
        const fresh = deps.currentDevice?.(device.deviceId) ?? device;
        if (!isDeviceUsable(fresh)) return failed("device-not-active");
        if (!deviceHasCapability(fresh, REMOTE_WEB_SESSION_CAPABILITY)) return failed("capability-missing");
        if (!deviceAllowsProfile(fresh, command.profileId)) return failed("profile-not-allowed");
        const payload = deps.runtime.getPayload();
        // Which transport this ticket is for is decided HERE, from what the desktop is actually
        // running — never from the origin the request asked for. The request's origin is then
        // compared against it, so a phone cannot obtain a relay-origin ticket from a desktop with no
        // relay, nor a tunnel-origin ticket by naming one.
        const relayOrigin = currentRelayOrigin(deps.relay);
        const expectedOrigin = relayOrigin || currentAllowedOrigin(payload);
        if (!relayOrigin) {
          // Same non-negotiable gate as remote.endpoint.request (plan §9.1): a webSession ticket is
          // just another way to reach the remote server over the TUNNEL, so it must not be issuable
          // under any condition a tunnel reconnect itself would not be allowed under. The relay has
          // its own gate — the user's own relay setting — and does not borrow this one.
          if (!canReconnectTunnel(state.settings.remoteAccess)) {
            return failed("tunnel-not-approved");
          }
          if (!expectedOrigin) return failed("tunnel-not-connected");
        }
        if (expectedOrigin !== command.payload.allowedOrigin) return failed("origin-mismatch");

        // Relay end-to-end encryption acceptance (plan 2026-09-23, decision 1). Only meaningful
        // over the relay transport, and only when the phone actually sent one — an `e2e` block on
        // a legacy-transport request is ignored rather than refused (a client that raced the relay
        // going down between its two calls is not an attacker). A relay-transport request that DID
        // send one but names an offer this desktop cannot find — unknown `keyId`, expired, or this
        // desktop has no `e2eOfferStore`/`ownPrivateKey` wired at all — refuses the WHOLE ticket:
        // "Desktop bez shody keyId ticket nevydá" is what keeps the relay from ever being able to
        // force a plaintext downgrade on its own; only a missing offer or acceptance can produce
        // one, never the relay. Checked BEFORE minting a ticket, so a mismatch never even causes
        // one to be created.
        const e2eAcceptance = command.payload.e2e;
        let e2eOffer: RelayE2eOfferRecord | null = null;
        if (relayOrigin && e2eAcceptance) {
          if (!deps.e2eOfferStore || !deps.ownPrivateKey) return failed("relay-e2e-key-mismatch");
          e2eOffer = deps.e2eOfferStore.getOffer(e2eAcceptance.keyId);
          if (!e2eOffer) return failed("relay-e2e-key-mismatch");
        }

        // The other half of that sentence, and the half a CLIENT can still do. The relay cannot force a
        // plaintext session (above, and the Worker has no code path that could), but a modified or
        // unofficial phone app can simply leave the `e2e` block out, and before this check the desktop
        // minted a relay ticket for it without encryption and remembered nothing. Now a relay request
        // with no acceptance is refused when EITHER the desktop's own `relay.requireE2e` setting is on
        // (the default, and what backfills for an install that predates it) OR this device has ever
        // completed an encrypted relay session (`relayE2eSeenAt`) — a phone that has proven it can do
        // end-to-end encryption cannot be downgraded even with the setting off, which exists only so an
        // older phone app that never could keeps working. Legacy (tunnel) transport is untouched: it
        // never had this encryption. Checked BEFORE `issueTicket`, so a refusal mints nothing.
        //
        // Fails CLOSED on a state that carries no setting at all: only an explicit `false` lets an
        // unencrypted relay ticket through.
        if (
          relayOrigin &&
          !e2eAcceptance &&
          (state.settings.integrations?.mobile?.relay?.requireE2e !== false || typeof fresh.relayE2eSeenAt === "number")
        ) {
          return failed("relay-e2e-required");
        }

        // Which server this ticket is for is decided here, from what the desktop is running — the
        // same decision that chose `expectedOrigin` above, recorded so the redeeming server can
        // refuse a ticket that was minted for the other one.
        const transport = relayOrigin ? "relay" : "legacy";
        const ticket = deps.ticketIssuer.issueTicket({
          deviceId: fresh.deviceId,
          pairId: fresh.pairId,
          profileId: command.profileId,
          allowedOrigin: command.payload.allowedOrigin,
          transport,
          commandRef: command.commandId.slice(-8),
        });

        if (e2eOffer && e2eAcceptance && deps.ownPrivateKey) {
          const desktopOffer: RelayE2eDesktopOffer = {
            v: 1,
            keyId: e2eAcceptance.keyId,
            // From the stored offer itself, never trusted from the request: the salt must be built
            // from what THIS desktop actually sent, not from a value a client could substitute.
            desktopEphemeralPub: e2eOffer.desktopEphemeralPub,
          };
          const phoneAcceptance: RelayE2ePhoneAcceptance = {
            v: 1,
            keyId: e2eAcceptance.keyId,
            phoneEphemeralPub: e2eAcceptance.phoneEphemeralPub,
          };
          try {
            const salt = relayE2eSalt(desktopOffer, phoneAcceptance);
            // ticketId folds THIS ticket into the derivation, per plan decision 1 — a session key
            // never outlives the ticket that produced it under a mismatched identity, and no two
            // tickets (even for the same offer, if the phone re-issued) share a derived key.
            const info = relayE2eInfo(fresh.pairId, fresh.deviceId, ticket.ticketId);
            const relayE2eKeys = deriveRelayE2eKeys(
              e2eOffer.ephemeralPrivateKey,
              publicKeyFromRaw(decodeCanonicalPublicKey(phoneAcceptance.phoneEphemeralPub)),
              deps.ownPrivateKey,
              publicKeyFromRaw(decodeCanonicalPublicKey(fresh.publicKey)),
              salt,
              info,
            );
            // Keyed by deviceId, not ticketId: the relay Worker (P2) stamps the viewer-grant-verified
            // device id — never the ticket, which is a desktop-issued credential the relay never
            // sees — onto the e2e.open frame it forwards to the connector, and that is the only
            // correlation the connector will have for a newly opened, otherwise opaque stream. See
            // mobile-relay-e2e-session-store.ts's own doc comment.
            deps.e2eSessionStore?.put(fresh.deviceId, relayE2eKeys, RELAY_MOBILE_SESSION_ABSOLUTE_TTL_MS);
            // Only after the keys exist: the latch says "this device DID an encrypted session", and a
            // derivation that threw above must not set it. A failed write is logged, not fatal — the
            // session is already encrypted, and the next one latches it.
            try {
              await deps.markRelayE2eSeen?.(fresh.deviceId);
            } catch (latchErr) {
              log.warn("relay e2e latch could not be written", { code: (latchErr as Error)?.message });
            }
          } catch (err) {
            // A malformed phoneEphemeralPub (wrong length, not canonical base64) must not silently
            // fall back to handing out an unencrypted ticket — the whole command fails instead, and
            // the ticket that was already minted is simply never returned to the caller and expires
            // unused (60s), same as any other early return after `issueTicket` leaves behind.
            log.warn("relay e2e key derivation failed", { code: (err as Error)?.message });
            return failed("relay-e2e-key-mismatch");
          }
        }

        // Every field of the protocol's RemoteWebSessionTicket, because the phone parses exactly
        // that shape. `ticketSecret` rather than `secret`: the wire name is the protocol's.
        return succeeded({
          ...sanitizeRemoteStatus(payload),
          ticketId: ticket.ticketId,
          ticketSecret: ticket.secret,
          deviceId: fresh.deviceId,
          pairId: fresh.pairId,
          profileId: command.profileId,
          allowedOrigin: command.payload.allowedOrigin,
          transport,
          // One capability, not a copy of the device's grant list. The remote UI is the authority for
          // exactly this grant, and the old field said something ambiguous about the device instead.
          requiredCapability: REMOTE_WEB_SESSION_CAPABILITY,
          issuedAt: now(),
          expiresAt: ticket.expiresAt,
        });
      }

      case "workspace.status.get": {
        const workspace = findWorkspace(state, command.payload.workspaceId);
        if (!workspace) return failed("workspace-not-found");
        if ((workspace.profileId || "default") !== command.profileId) return failed("cross-profile-workspace");
        // `name` is what the phone has no other way to learn. A workspace id is
        // `workspace-<uuid>`, and the mobile app's notification list had nothing else to put in a
        // subtitle — so every row read like a database key. The name never travels with the event
        // (the sealed payload is {kind,title,body,actions,isTest} and adding a field there would
        // break every older client, since that schema is additionalProperties:false), so the phone
        // resolves it by id, here, and caches it.
        //
        // The SAME string the desktop's own UI shows, via the shared formatter rather than
        // `workspace.name` directly: a task workspace is "Fix the parser #3" in one place and would
        // otherwise be "Fix the parser" in the other, and two names for one thing is worse than a
        // technical one.
        return succeeded({
          kind: workspace.kind,
          taskState: workspace.task?.state || null,
          name: formatWorkspaceDisplayName(workspace) || null,
        });
      }
    }
  }

  return {
    async dispatch(command: Command, device: MobileDeviceRecord | null): Promise<CommandResult> {
      if (!device) {
        audit(null, command, "failure", "device-not-found");
        return buildResult(command.commandId, "failed", null, "device-not-found");
      }
      if (device.revoked) {
        audit(device, command, "failure", "device-revoked");
        return buildResult(command.commandId, "failed", null, "device-revoked");
      }
      // Capability, destructiveness and maximum lifetime all come from COMMAND_POLICY, keyed on
      // `command.type` — never from a label the command carried. See mobile-command-policy.ts for
      // the confused-deputy hole that closed (review 2 §P0.3).
      const policy = checkCommandPolicy(command, device.capabilities, now());
      if (!policy.ok) {
        audit(device, command, "failure", policy.reason);
        return policy.reason === "expired"
          ? buildResult(command.commandId, "expired", null, "command-expired")
          : buildResult(command.commandId, "failed", null, policy.reason);
      }
      if (!device.profileAllowlist.includes(command.profileId)) {
        audit(device, command, "failure", "profile-not-allowed");
        return buildResult(command.commandId, "failed", null, "profile-not-allowed");
      }

      const existing = deps.idempotencyStore.getByIdempotencyKey(command.idempotencyKey);
      if (existing && existing.status !== "claimed") {
        // Already completed (or terminally failed/expired) — safe replay: hand
        // back the ORIGINAL recorded result (including its real completedAt),
        // never re-execute.
        if (existing.status === "succeeded" && CREDENTIAL_RESULT_TYPES.has(command.type)) {
          return {
            commandId: command.commandId,
            status: "failed",
            completedAt: existing.completedAt ? Date.parse(existing.completedAt) : now(),
            data: null,
            errorCode: "ticket-expired",
          };
        }
        return {
          commandId: command.commandId,
          status: existing.status as CommandTerminalState,
          completedAt: existing.completedAt ? Date.parse(existing.completedAt) : now(),
          data: existing.resultData,
          errorCode: existing.errorCode,
        };
      }
      if (existing && existing.status === "claimed") {
        // A prior attempt claimed this idempotencyKey but the process never
        // recorded a terminal result (crash between side effect and write).
        if (!isIdempotent(command.type)) {
          audit(device, command, "failure", "outcome-unknown-crash-recovery");
          return buildResult(command.commandId, "outcome-unknown", null, "crash-recovery");
        }
        // Idempotent — safe to fall through and re-run from scratch.
      } else {
        deps.idempotencyStore.recordClaimed(command.commandId, command.idempotencyKey, new Date(now()).toISOString());
      }

      try {
        const result = await execute(command, deps.getState(), device);
        const completedAtMs = now();
        deps.idempotencyStore.recordResult(
          command.commandId,
          result.status,
          CREDENTIAL_RESULT_TYPES.has(command.type) ? null : result.data,
          result.errorCode,
          new Date(completedAtMs).toISOString(),
        );
        audit(
          device,
          command,
          result.status === "succeeded" ? "success" : "failure",
          result.errorCode || result.status,
        );
        return {
          commandId: command.commandId,
          status: result.status,
          completedAt: completedAtMs,
          data: result.data,
          errorCode: result.errorCode,
        };
      } catch (err) {
        const status: CommandTerminalState = isIdempotent(command.type) ? "failed" : "outcome-unknown";
        const errorCode = (err as Error)?.message || "unknown-error";
        const completedAtMs = now();
        deps.idempotencyStore.recordResult(
          command.commandId,
          status,
          null,
          errorCode,
          new Date(completedAtMs).toISOString(),
        );
        audit(device, command, "failure", errorCode);
        return { commandId: command.commandId, status, completedAt: completedAtMs, data: null, errorCode };
      }
    },
  };
}

export type MobileCommandDispatcher = ReturnType<typeof createMobileCommandDispatcher>;

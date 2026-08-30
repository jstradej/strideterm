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
import { canReconnectTunnel } from "../tunnel-manager.js";
import { getLogger } from "../logger.js";
import { findWorkspace } from "../runtime-utils.js";
import { formatWorkspaceDisplayName } from "../../shared/workspace-display.js";
import { checkCommandPolicy, policyFor } from "./mobile-command-policy.js";
import { deviceAllowsProfile, deviceHasCapability, isDeviceUsable } from "./mobile-device-store.js";
import { REMOTE_WEB_SESSION_CAPABILITY } from "./mobile-web-session-ticket-store.js";
import type { MobileAuditLogStore } from "./mobile-audit-log-store.js";
import type { MobileNotificationOriginStore } from "./mobile-notification-origin-store.js";
import type { MobileIdempotencyStore } from "./mobile-idempotency-store.js";
import type { Command, CommandResult, CommandTerminalState, MobileDeviceRecord } from "./mobile-schemas.js";
import type { AppState } from "../../shared/types/state.js";
import type { MobileCommandType } from "../../shared/types/notifications.js";

const log = getLogger("mobile-command-dispatch");

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
   * Which alert each notification event was raised from, recorded when the event was sent
   * (mobile-notification-origin-store.ts). Lets `notification.acknowledge` clear the alert the
   * phone is acknowledging, given a payload that carries only the event id.
   *
   * Absent in a test that does not exercise acknowledgement, and absent for an event that never
   * raised an alert — in both cases the ack degrades to the local-only acknowledgement the phone
   * has already performed, which is exactly the old behaviour.
   */
  notificationOrigins?: MobileNotificationOriginStore;
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
 * The host a Cloudflare-transport answer names.
 *
 * The tunnel's public URL when there is one, and the LAN host otherwise — which is what this
 * command has always effectively reported, now stated as one value instead of left for the client
 * to assemble out of `host` and `tunnelUrl`.
 */
function cloudflareEndpointHost(payload: ReturnType<MobileCommandRuntime["getPayload"]>): string {
  const publicUrl = payload?.remoteAccess?.tunnel?.publicUrl || "";
  if (publicUrl) {
    try {
      return new URL(publicUrl).host;
    } catch {
      // Fall through to the configured host: a malformed tunnel URL is not a reason to answer
      // with one.
    }
  }
  return typeof payload?.remoteAccess?.host === "string" ? payload.remoteAccess.host : "";
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
        return succeeded({
          profiles: state.profiles
            .filter((profile) => allowed.has(profile.id))
            .map((profile) => ({
              id: profile.id,
              name: profile.name,
              workspaceCount: state.workspaces.filter((workspace) => (workspace.profileId || "default") === profile.id)
                .length,
            })),
        });
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
          });
        }
        if (!canReconnectTunnel(state.settings.remoteAccess)) {
          return failed("tunnel-not-approved");
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
          await deps.runtime.createCloudflareTunnel();
          payload = deps.runtime.getPayload();
        }
        return succeeded({
          ...sanitizeRemoteStatus(payload),
          ...buildEndpointMetadata({
            transport: "cloudflare",
            host: cloudflareEndpointHost(payload),
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
        });
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
          result.data,
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

/**
 * Hand-authored mirror of the wire schemas defined in the sibling
 * `strideterm-mobile` monorepo (`protocol/typescript/src/generated/*.ts`,
 * themselves generated from `protocol/schemas/*.schema.json`).
 *
 * Why hand-authored and not imported: this repo's desktop code cannot import
 * `strideterm-mobile`'s source via a relative path across the two checkouts
 * — the plan (§3.2) explicitly forbids that ("Nesmí importovat zdrojáky
 * relativní cestou z vedlejšího checkoutu; build i CI musí být
 * reprodukovatelné samostatně"). Production is meant to consume a versioned,
 * published `@strideterm/mobile-protocol` package build, but no package
 * registry/CI release pipeline for it exists in this sandbox yet. Until that
 * exists, this file is a same-shape hand-authored mirror: every field name
 * and type below was copied field-for-field from the generated protocol
 * package and MUST be kept in lockstep with it by hand. This is a known,
 * deliberate simplification of this pass — not an oversight.
 *
 * `npm run check:mobile-schema-drift` (scripts/check-mobile-schema-drift.mts) is the automated
 * safety net for that lockstep requirement — it structurally compares every schema here against
 * its generated counterpart and fails on drift; run it after editing this file or the sibling repo.
 *
 * Local-only additions (device persistence shape, mobile settings) that have
 * no protocol-package equivalent live at the bottom of this file, clearly
 * separated.
 */
import { z } from "zod";
import type { MobileCommandType } from "../../shared/types/notifications.js";

// ---------------------------------------------------------------------------
// Mirrors of generated/common.ts
// ---------------------------------------------------------------------------

export const PlatformSchema = z.enum(["android", "ios"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const SeveritySchema = z.enum(["high", "normal", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const CommandLifecycleStateSchema = z.enum([
  "queued",
  "claimed",
  "succeeded",
  "failed",
  "outcome-unknown",
  "expired",
]);
export type CommandLifecycleState = z.infer<typeof CommandLifecycleStateSchema>;

export const CommandTerminalStateSchema = z.enum(["succeeded", "failed", "outcome-unknown", "expired"]);
export type CommandTerminalState = z.infer<typeof CommandTerminalStateSchema>;

export const PairingStatusSchema = z.enum(["pending", "claimed", "expired"]);
export type PairingStatus = z.infer<typeof PairingStatusSchema>;

export const EnvelopeMessageTypeSchema = z.enum(["command", "commandResult", "notificationEvent"]);
export type EnvelopeMessageType = z.infer<typeof EnvelopeMessageTypeSchema>;

// ---------------------------------------------------------------------------
// Mirror of generated/crypto-params.ts
// ---------------------------------------------------------------------------

/**
 * HKDF `info` for a pairing session key. ADR 0002 fixed the primitives but not this string, so
 * each side picked its own — the desktop used "strideterm-mobile-protocol/v1" and the app used
 * "strideterm-mobile-envelope-v1". Same primitives, same shared secret, different derived key:
 * nothing either side sealed could ever have been opened by the other. It is now generated from
 * protocol/schemas/crypto-params.json and mirrored here under the drift check.
 */
export const SESSION_KEY_HKDF_INFO = "strideterm-mobile-envelope-v1";

/**
 * The wire version both sides speak. v2 is a break rather than an addition: every ciphertext's AAD
 * commits to the full routing transcript (see mobile-crypto.ts's buildRoutingAad), so a v1 sender
 * and a v2 receiver fail loudly at the AEAD instead of quietly mis-routing.
 */
export const PROTOCOL_VERSION = 2;

/** The key generation currently in use for a freshly paired device. */
export const INITIAL_SESSION_KEY_VERSION = 1;

/**
 * How the two key generations behind a session key are packed into one version (review 3 §P1.6).
 *
 * `sessionKeyVersion = (desktopKeyVersion - 1) * SESSION_KEY_VERSION_STRIDE + mobileKeyVersion`, both
 * generations bounded to [1, MAX_KEY_GENERATION] so the encoding is injective. The desktop does not
 * derive this itself — `claimPairing` does, and the value arrives on the device record — but the numbers
 * are mirrored because `check:mobile-schema-drift` compares every generated constant, and because the
 * version on an envelope is meaningless without knowing what it encodes.
 */
export const SESSION_KEY_VERSION_STRIDE = 1000;
export const MAX_KEY_GENERATION = 999;

/** AEAD nonce length, and the exact length an inbound envelope's nonce must decode to. */
export const AEAD_NONCE_BYTES = 12;

/** A raw X25519 public key is exactly this many bytes, before any base64 encoding. */
export const X25519_PUBLIC_KEY_BYTES = 32;

/** Entropy in a pairing invitation secret. */
export const PAIRING_SECRET_BYTES = 32;

/** Domain separation for the pairing fingerprint and SAS transcripts (review 2 §P0.4). */
export const PAIRING_FINGERPRINT_DOMAIN = "strideterm-mobile/pairing-fingerprint/v2";
export const PAIRING_SAS_DOMAIN = "strideterm-mobile/pairing-sas/v2";
export const PAIRING_SAS_DIGITS = 8;

/** Length of the QR's one-time key-proof challenge, and the exact length it must decode to. */
export const PAIRING_KEY_PROOF_CHALLENGE_BYTES = 32;

/** Domain separation for the three review 3 §P0.1 commitments. */
export const PAIRING_KEY_PROOF_DOMAIN = "strideterm-mobile/pairing-key-proof/v3";
export const PAIRING_GRANT_COMMITMENT_DOMAIN = "strideterm-mobile/pairing-grant-commitment/v3";
export const PAIRING_APPROVAL_DOMAIN = "strideterm-mobile/pairing-approval/v3";

/** Nonce prefix length in a NotificationEvent's packed `nonce || ciphertext+tag` ciphertext. */
export const NOTIFICATION_EVENT_NONCE_BYTES = 12;

/**
 * HKDF salt for a pairing session key: the pairId, UTF-8 encoded. A per-pair salt, so two
 * pairings sharing an endpoint still derive unrelated keys.
 */
export function sessionKeySalt(pairId: string): Uint8Array {
  return new TextEncoder().encode(pairId);
}

/** Display taxonomy for a decrypted notification payload — which notification channel it lands in. */
export const NotificationKindSchema = z.enum(["waiting", "completed", "error", "general"]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const QuotaWindowKindSchema = z.enum([
  "push-day",
  "push-hour",
  "push-minute",
  "command-day",
  "command-minute",
  // The global, per-Firebase-identity admission counters enqueueCommand applies on top of the
  // pair-scoped ones: desktopDeviceId is client-chosen, so pair budgets multiply with the number
  // of pairs one identity creates (review 2 §P0.5/§P0.7).
  "uid-command-day",
  "uid-command-minute",
  // The event equivalents, applied by enqueueEvent on top of the pair-scoped push windows
  // (review 3 §P0.2/§P0.5).
  "uid-push-day",
  "uid-push-minute",
  // The relay-grant issuance budget (production hardening §4.3). The -minute kinds are scoped to one
  // device or one desktop installation; the -hour and -day kinds are scoped to the ENTITLEMENT, which
  // is what a second device cannot shard — their window ids contain no device at all.
  "relay-viewer-grant-minute",
  "relay-viewer-grant-hour",
  "relay-viewer-grant-day",
  "relay-connector-grant-minute",
  "relay-connector-grant-hour",
  "relay-connector-grant-day",
]);
export type QuotaWindowKind = z.infer<typeof QuotaWindowKindSchema>;

/**
 * A grant the desktop attaches to a paired device at invitation time.
 *
 * Deliberately COARSER than the command type. `requiredCapability` used to be a field on the
 * command itself, authored by the mobile and authorized against by the desktop, so a hostile client
 * could label a destructive type with a cheap capability it happened to hold. The receiver derives
 * the requirement from `command.type` through COMMAND_POLICY now (mobile-command-policy.ts), and
 * this enum is the closed set of grants the pairing dialog offers (review 2 §P0.3).
 */
export const CapabilitySchema = z.enum([
  "notifications",
  "status.read",
  "task.control",
  "task.destructive",
  "remote.request",
  "remote.webSession",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

// ---------------------------------------------------------------------------
// Mirror of generated/envelope.ts
// ---------------------------------------------------------------------------

export const EncryptedEnvelopeSchema = z.object({
  protocolVersion: z.number().int().min(1),
  pairId: z.string().min(1),
  senderDeviceId: z.string().min(1),
  /**
   * The ONE installation this envelope is addressed to. Not advisory: mobile-manager.ts refuses any
   * envelope whose targetDeviceId is not this desktop's own id, before it claims, touches last-seen
   * or dispatches anything (review 2 §P0.2).
   */
  targetDeviceId: z.string().min(1),
  messageId: z.string().min(1),
  messageType: EnvelopeMessageTypeSchema,
  nonce: z.string(),
  createdAt: z.number().int().min(0),
  expiresAt: z.number().int().min(0),
  ciphertext: z.string(),
  aad: z.string(),
  sessionKeyVersion: z.number().int().min(1),
});
export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Mirror of generated/device.ts
// ---------------------------------------------------------------------------

/**
 * The pairing state machine (review 3 §P0.1).
 *
 * v2 had no state at all, and every consequence of that was a hole: the desktop adopted whatever
 * unknown device record appeared during an open invitation, an automatic challenge echo set
 * `verifiedAt`, `MobileCommandDispatcher.dispatch` never looked at it, and the SAS screen's only
 * button hid the code. Nothing but `active` authorizes anything now — see mobile-pairing.ts for the
 * transitions and strideterm-mobile/cloud/functions/src/pairing-state.ts for the cloud half.
 *
 * `userApproved` is DESKTOP-LOCAL: the human pressed "Codes match — activate" and the cloud has not
 * confirmed. Persisted so a crash in that window neither activates the device nor loses the ability
 * to reject it.
 */
export const DeviceStateSchema = z.enum(["claimed", "keyProven", "userApproved", "active", "revoked"]);
export type DeviceState = z.infer<typeof DeviceStateSchema>;

export const DeviceSchema = z.object({
  deviceId: z.string().min(1),
  uid: z.string().min(1),
  pairId: z.string().min(1),
  /** The invitation this device claimed. The desktop adopts only a claim naming its own pending one. */
  pairingId: z.string().min(1),
  state: DeviceStateSchema,
  /** Server-written digest of the approved grants; the desktop recomputes it from its own options. */
  grantCommitment: z.string().min(1),
  /** The claim-time key proof the desktop recomputes before it will move the record past `claimed`. */
  keyProof: z.string().min(1),
  keyProvenAt: z.number().int().min(0).nullable(),
  activatedAt: z.number().int().min(0).nullable(),
  platform: PlatformSchema,
  label: z.string().min(1),
  publicKey: z.string(),
  /** Which generation of `publicKey` this record holds; part of the AAD and of the key lookup. */
  sessionKeyVersion: z.number().int().min(1),
  capabilities: z.array(CapabilitySchema),
  profileAllowlist: z.array(z.string().min(1)),
  createdAt: z.number().int().min(0),
  lastSeenAt: z.number().int().min(0),
  revoked: z.boolean(),
  revokedAt: z.number().int().min(0).nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;

// ---------------------------------------------------------------------------
// Mirror of generated/command.ts
// ---------------------------------------------------------------------------

export const NotificationAcknowledgePayloadSchema = z.object({
  eventId: z.string().min(1),
  // The `verificationCode` field that used to be here is gone (review 3 §P0.1). It made a pairing
  // handshake step travel as an ordinary capability-bearing command, so the desktop had to accept
  // commands from devices no human had approved in order to finish pairing at all. The key proof is
  // part of the claim now, and the receiver refuses every command from a non-active device with no
  // exception carved out.
});
export type NotificationAcknowledgePayload = z.infer<typeof NotificationAcknowledgePayloadSchema>;

export const TaskPausePayloadSchema = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
});
export type TaskPausePayload = z.infer<typeof TaskPausePayloadSchema>;

export const TaskResumePayloadSchema = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
});
export type TaskResumePayload = z.infer<typeof TaskResumePayloadSchema>;

export const TaskStopPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  confirmed: z.literal(true),
});
export type TaskStopPayload = z.infer<typeof TaskStopPayloadSchema>;

export const TaskResetPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  confirmed: z.literal(true),
});
export type TaskResetPayload = z.infer<typeof TaskResetPayloadSchema>;

export const TaskUpdateDescriptionPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  description: z.string().min(1),
});
export type TaskUpdateDescriptionPayload = z.infer<typeof TaskUpdateDescriptionPayloadSchema>;

export const TaskSendInstructionPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  instruction: z.string().min(1),
});
export type TaskSendInstructionPayload = z.infer<typeof TaskSendInstructionPayloadSchema>;

export const ProfileCatalogGetPayloadSchema = z.object({});
export type ProfileCatalogGetPayload = z.infer<typeof ProfileCatalogGetPayloadSchema>;

export const RemoteStatusGetPayloadSchema = z.object({
  workspaceId: z.string().min(1),
});
export type RemoteStatusGetPayload = z.infer<typeof RemoteStatusGetPayloadSchema>;

export const RemoteEndpointRequestPayloadSchema = z.object({
  workspaceId: z.string().min(1).optional(),
});
export type RemoteEndpointRequestPayload = z.infer<typeof RemoteEndpointRequestPayloadSchema>;

export const RemoteTunnelReconnectPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  tunnelId: z.string().min(1),
});
export type RemoteTunnelReconnectPayload = z.infer<typeof RemoteTunnelReconnectPayloadSchema>;

export const RemoteWebSessionIssuePayloadSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  allowedOrigin: z.string().min(1),
});
export type RemoteWebSessionIssuePayload = z.infer<typeof RemoteWebSessionIssuePayloadSchema>;

export const WorkspaceStatusGetPayloadSchema = z.object({
  workspaceId: z.string().min(1),
});
export type WorkspaceStatusGetPayload = z.infer<typeof WorkspaceStatusGetPayloadSchema>;

const commandEnvelopeFields = {
  commandId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  createdAt: z.number().int().min(0),
  expiresAt: z.number().int().min(0),
  profileId: z.string().min(1),
  /**
   * The desktop this command is for. Checked against this desktop's own device id — and against the
   * carrying envelope's messageId, for commandId — before the RTDB claim (review 2 §P0.2).
   *
   * There is deliberately no `requiredCapability` here any more: see CapabilitySchema.
   */
  targetDeviceId: z.string().min(1),
  status: CommandLifecycleStateSchema,
};

export const NotificationAcknowledgeCommandSchema = z.object({
  ...commandEnvelopeFields,
  type: z.literal("notification.acknowledge"),
  payload: NotificationAcknowledgePayloadSchema,
});
export type NotificationAcknowledgeCommand = z.infer<typeof NotificationAcknowledgeCommandSchema>;

export const TaskPauseCommandSchema = z.object({
  ...commandEnvelopeFields,
  type: z.literal("task.pause"),
  payload: TaskPausePayloadSchema,
});
export type TaskPauseCommand = z.infer<typeof TaskPauseCommandSchema>;

export const TaskResumeCommandSchema = z.object({
  ...commandEnvelopeFields,
  type: z.literal("task.resume"),
  payload: TaskResumePayloadSchema,
});
export type TaskResumeCommand = z.infer<typeof TaskResumeCommandSchema>;

export const TaskStopCommandSchema = z.object({
  ...commandEnvelopeFields,
  type: z.literal("task.stop"),
  payload: TaskStopPayloadSchema,
});
export type TaskStopCommand = z.infer<typeof TaskStopCommandSchema>;

export const TaskResetCommandSchema = z.object({
  ...commandEnvelopeFields,
  type: z.literal("task.reset"),
  payload: TaskResetPayloadSchema,
});
export type TaskResetCommand = z.infer<typeof TaskResetCommandSchema>;

export const TaskUpdateDescriptionCommandSchema = z.object({
  ...commandEnvelopeFields,
  type: z.literal("task.updateDescription"),
  payload: TaskUpdateDescriptionPayloadSchema,
});
export type TaskUpdateDescriptionCommand = z.infer<typeof TaskUpdateDescriptionCommandSchema>;

export const TaskSendInstructionCommandSchema = z.object({
  ...commandEnvelopeFields,
  type: z.literal("task.sendInstruction"),
  payload: TaskSendInstructionPayloadSchema,
});
export type TaskSendInstructionCommand = z.infer<typeof TaskSendInstructionCommandSchema>;

export const ProfileCatalogGetCommandSchema = z.object({
  ...commandEnvelopeFields,
  type: z.literal("profile.catalog.get"),
  payload: ProfileCatalogGetPayloadSchema,
});
export type ProfileCatalogGetCommand = z.infer<typeof ProfileCatalogGetCommandSchema>;

export const RemoteStatusGetCommandSchema = z.object({
  ...commandEnvelopeFields,
  type: z.literal("remote.status.get"),
  payload: RemoteStatusGetPayloadSchema,
});
export type RemoteStatusGetCommand = z.infer<typeof RemoteStatusGetCommandSchema>;

export const RemoteEndpointRequestCommandSchema = z.object({
  ...commandEnvelopeFields,
  type: z.literal("remote.endpoint.request"),
  payload: RemoteEndpointRequestPayloadSchema,
});
export type RemoteEndpointRequestCommand = z.infer<typeof RemoteEndpointRequestCommandSchema>;

export const RemoteTunnelReconnectCommandSchema = z.object({
  ...commandEnvelopeFields,
  type: z.literal("remote.tunnel.reconnect"),
  payload: RemoteTunnelReconnectPayloadSchema,
});
export type RemoteTunnelReconnectCommand = z.infer<typeof RemoteTunnelReconnectCommandSchema>;

export const RemoteWebSessionIssueCommandSchema = z.object({
  ...commandEnvelopeFields,
  type: z.literal("remote.webSession.issue"),
  payload: RemoteWebSessionIssuePayloadSchema,
});
export type RemoteWebSessionIssueCommand = z.infer<typeof RemoteWebSessionIssueCommandSchema>;

export const WorkspaceStatusGetCommandSchema = z.object({
  ...commandEnvelopeFields,
  type: z.literal("workspace.status.get"),
  payload: WorkspaceStatusGetPayloadSchema,
});
export type WorkspaceStatusGetCommand = z.infer<typeof WorkspaceStatusGetCommandSchema>;

export const CommandSchema = z.discriminatedUnion("type", [
  NotificationAcknowledgeCommandSchema,
  TaskPauseCommandSchema,
  TaskResumeCommandSchema,
  TaskStopCommandSchema,
  TaskResetCommandSchema,
  TaskUpdateDescriptionCommandSchema,
  TaskSendInstructionCommandSchema,
  ProfileCatalogGetCommandSchema,
  RemoteStatusGetCommandSchema,
  RemoteEndpointRequestCommandSchema,
  RemoteTunnelReconnectCommandSchema,
  RemoteWebSessionIssueCommandSchema,
  WorkspaceStatusGetCommandSchema,
]);
export type Command = z.infer<typeof CommandSchema>;

// Sanity net: keeps this hand-authored union in lockstep with the shared
// MobileCommandType literal (electron/shared/types/notifications.ts). If a
// command type is ever added/renamed in one place without the other, this
// line fails to compile.
type _CommandTypeMatchesMobileCommandType = Command["type"] extends MobileCommandType ? true : false;
type _MobileCommandTypeMatchesCommandType = MobileCommandType extends Command["type"] ? true : false;
const _typeCheck: [_CommandTypeMatchesMobileCommandType, _MobileCommandTypeMatchesCommandType] = [true, true];
void _typeCheck;

// ---------------------------------------------------------------------------
// Mirror of generated/command-result.ts
// ---------------------------------------------------------------------------

export const CommandResultSchema = z.object({
  commandId: z.string().min(1),
  status: CommandTerminalStateSchema,
  completedAt: z.number().int().min(0),
  data: z.record(z.string(), z.unknown()).nullable(),
  errorCode: z.string().nullable(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

// ---------------------------------------------------------------------------
// Mirror of generated/notification-event.ts
// ---------------------------------------------------------------------------

export const NotificationEventSchema = z.object({
  protocolVersion: z.number().int().min(1),
  eventId: z.string().min(1),
  pairId: z.string().min(1),
  sourceDeviceId: z.string().min(1),
  /**
   * The ONE mobile installation this event is for. Also the mailbox path segment
   * (v2/pairs/{pairId}/events/{targetDeviceId}/{eventId}), so the rules grant the read to exactly
   * that device's uid and deliverPush sends to exactly that device's token. A pair with two phones
   * gets two separately addressed, separately sealed events (review 2 §P0.1).
   */
  targetDeviceId: z.string().min(1),
  profileId: z.string().min(1),
  workspaceId: z.string().nullable(),
  severity: SeveritySchema,
  dedupeKey: z.string().min(1),
  collapseKey: z.string().nullable(),
  createdAt: z.number().int().min(0),
  expiresAt: z.number().int().min(0),
  sessionKeyVersion: z.number().int().min(1),
  ciphertext: z.string(),
  aad: z.string(),
});
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

// ---------------------------------------------------------------------------
// Mirror of generated/notification-payload.ts
// ---------------------------------------------------------------------------

/**
 * The DECRYPTED plaintext this desktop seals into a NotificationEvent's
 * ciphertext, and the exact shape the mobile app parses back out.
 *
 * Previously each side had invented its own: the desktop sealed
 * `{title, detail, actions}` and the app parsed `{kind, title, body}`, so a
 * successful decrypt was followed by a guaranteed parse failure on every
 * event. It is now a real schema (notification-payload.schema.json) and is
 * covered by `npm run check:mobile-schema-drift` like every other mirror here.
 */
export const NotificationPayloadSchema = z.object({
  kind: NotificationKindSchema,
  title: z.string(),
  body: z.string(),
  actions: z.array(z.string()),
  isTest: z.boolean(),
  // `verificationCode` used to be here — a random value sealed into an event addressed to a
  // freshly-claimed device, echoed back to prove it could decrypt. Gone with the challenge event
  // itself (review 3 §P0.1): delivering a real event to, and accepting a real command from, a device
  // no human had approved is exactly what the pairing state machine now forbids, and the proof moved
  // into the claim (PairingClaimRequest.keyProof) where no channel is needed for it.
});
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

// ---------------------------------------------------------------------------
// Mirror of generated/presence.ts
// ---------------------------------------------------------------------------

export const PresenceSchema = z.object({
  deviceId: z.string().min(1),
  uid: z.string().min(1),
  status: z.enum(["online", "offline"]),
  lastSeenAt: z.number().int().min(0),
});
export type Presence = z.infer<typeof PresenceSchema>;

// ---------------------------------------------------------------------------
// Mirror of generated/quota-window.ts
// ---------------------------------------------------------------------------

export const QuotaWindowSchema = z.object({
  windowId: z.string().min(1),
  windowStart: z.number().int().min(0),
  windowEnd: z.number().int().min(0),
  count: z.number().int().min(0),
  kind: QuotaWindowKindSchema,
  reservedHighPriorityRemaining: z.number().int().min(0).nullable(),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

// ---------------------------------------------------------------------------
// Mirror of generated/pairing.ts
// ---------------------------------------------------------------------------

export const PairingInvitationSchema = z.object({
  pairingId: z.string().min(1),
  secretHash: z.string().min(1),
  desktopUid: z.string().min(1),
  desktopDeviceId: z.string().min(1),
  publicMeta: z.object({
    desktopLabel: z.string().min(1),
    desktopFingerprint: z.string().min(1),
  }),
  /** The grants the human ticked in the desktop's pairing dialog; claimPairing copies THESE. */
  approvedCapabilities: z.array(CapabilitySchema),
  approvedProfileAllowlist: z.array(z.string().min(1)),
  createdAt: z.number().int().min(0),
  expiresAt: z.number().int().min(0),
  status: PairingStatusSchema,
});
export type PairingInvitation = z.infer<typeof PairingInvitationSchema>;

export const PairingClaimRequestSchema = z.object({
  pairingId: z.string().min(1),
  secret: z.string().min(1),
  mobileDeviceId: z.string().min(1),
  mobileUid: z.string().min(1),
  platform: PlatformSchema,
  label: z.string().min(1),
  publicKey: z.string(),
  /**
   * Proof that the claiming device holds the private key for `publicKey` and scanned this desktop's
   * QR: HMAC-SHA-256 over the pairing-proof transcript under the derived session key, with the QR's
   * one-time challenge as a transcript field (review 3 §P0.1). The cloud can neither forge nor check
   * it; this desktop recomputes it before it will move the record past `claimed`.
   */
  keyProof: z.string().min(1),
  /** The wire version the claiming app speaks; a stale APK fails at pairing rather than later. */
  protocolVersion: z.number().int().min(1),
});
export type PairingClaimRequest = z.infer<typeof PairingClaimRequestSchema>;

export const PairingClaimResponseSchema = z.object({
  status: z.enum(["claimed", "expired", "invalid", "already-claimed"]),
  pairId: z.string().min(1).optional(),
  desktopDeviceId: z.string().min(1).optional(),
  desktopLabel: z.string().min(1).optional(),
  desktopPublicKey: z.string().optional(),
  capabilities: z.array(CapabilitySchema).optional(),
  /** Always `claimed` on success: a claim is the START of pairing, not the end (review 3 §P0.1). */
  state: DeviceStateSchema.optional(),
  /**
   * The two key generations this pairing is bound to (review 3 §P1.6).
   *
   * The phone recomputes `sessionKeyVersion` from `desktopKeyVersion` and refuses the claim on a
   * mismatch, which is what turns the version from a number it was handed into one it verified. This
   * desktop never reads the response — it is the mobile side of the callable — but the mirror has to
   * describe the same wire shape or the drift check is not comparing the same contract.
   */
  desktopKeyVersion: z.number().int().min(1).optional(),
  sessionKeyVersion: z.number().int().min(1).optional(),
  claimedAt: z.number().int().min(0).optional(),
});
export type PairingClaimResponse = z.infer<typeof PairingClaimResponseSchema>;

// ---------------------------------------------------------------------------
// Mirror of generated/remote-endpoint.ts
// ---------------------------------------------------------------------------

export const RemoteEndpointMetadataSchema = z.object({
  host: z.string().min(1),
  tunnelKind: z.string().min(1),
  issuedAt: z.number().int().min(0),
  expiresAt: z.number().int().min(0),
  transport: z.enum(["cloudflare", "managedRelay"]),
});
export type RemoteEndpointMetadata = z.infer<typeof RemoteEndpointMetadataSchema>;

// ---------------------------------------------------------------------------
// Mirror of generated/remote-web-session-ticket.ts
// ---------------------------------------------------------------------------

export const RemoteWebSessionTicketSchema = z.object({
  ticketId: z.string().min(1),
  ticketSecret: z.string().min(1),
  deviceId: z.string().min(1),
  pairId: z.string().min(1),
  profileId: z.string().min(1),
  allowedOrigin: z.string().min(1),
  // Which of this installation's servers the ticket may be redeemed at, and the one capability the
  // remote UI is the authority for. Both replaced a copy of the device's whole grant list, which said
  // something ambiguous about the device rather than anything about the session (production hardening
  // §5 "Ticket" 1-2 and 6).
  transport: z.enum(["relay", "legacy"]),
  requiredCapability: z.literal("remote.webSession"),
  issuedAt: z.number().int().min(0),
  expiresAt: z.number().int().min(0),
});
export type RemoteWebSessionTicket = z.infer<typeof RemoteWebSessionTicketSchema>;

// ---------------------------------------------------------------------------
// Mirror of generated/limits.ts — values copied verbatim from
// protocol/schemas/limits.json. Do not hand-tune these; a change on the
// protocol side must be re-copied here by hand until the real package exists.
// ---------------------------------------------------------------------------

export const MAX_PAIRED_MOBILE_DEVICES_PER_DESKTOP = 3 as const;
export const MAX_ACTIVE_PAIRING_INVITATIONS_PER_DESKTOP = 1 as const;
export const MAX_PAIRING_INVITATIONS_PER_DESKTOP_PER_DAY = 20 as const;
export const MAX_PAIRS_PER_UID = 4 as const;
export const MAX_PUSH_EVENTS_PER_PAIR_PER_UTC_DAY = 100 as const;
export const MAX_PUSH_EVENTS_PER_PAIR_PER_HOUR = 30 as const;
export const MAX_PUSH_EVENTS_PER_PAIR_PER_MINUTE = 5 as const;
export const MAX_PUSH_EVENTS_PER_UID_PER_UTC_DAY = 300 as const;
export const MAX_PUSH_EVENTS_PER_UID_PER_MINUTE = 15 as const;
export const MAX_PUSH_DELIVERIES_PER_DEVICE_PER_UTC_DAY = 100 as const;
export const MAX_COMMANDS_PER_PAIR_PER_UTC_DAY = 500 as const;
export const MAX_COMMANDS_PER_PAIR_PER_MINUTE = 30 as const;
export const MAX_COMMANDS_PER_UID_PER_UTC_DAY = 1000 as const;
export const MAX_COMMANDS_PER_UID_PER_MINUTE = 60 as const;
export const MAX_PENDING_COMMANDS_PER_PAIR = 50 as const;
// The relay-grant issuance budget. Mirrored here because the drift check compares the whole set, not
// because the desktop enforces them: the desktop is a CALLER of `issueRelayConnectorGrant`, and
// knowing the ceiling is what lets it back off rather than hammer a door that is refusing it.
export const MAX_RELAY_VIEWER_GRANTS_PER_DEVICE_PER_MINUTE = 6 as const;
export const MAX_RELAY_VIEWER_GRANTS_PER_ENTITLEMENT_PER_HOUR = 60 as const;
export const MAX_RELAY_VIEWER_GRANTS_PER_ENTITLEMENT_PER_UTC_DAY = 300 as const;
export const MAX_RELAY_CONNECTOR_GRANTS_PER_INSTALLATION_PER_MINUTE = 12 as const;
export const MAX_RELAY_CONNECTOR_GRANTS_PER_ENTITLEMENT_PER_HOUR = 240 as const;
export const MAX_RELAY_CONNECTOR_GRANTS_PER_ENTITLEMENT_PER_UTC_DAY = 1200 as const;
export const MAX_ACTIVE_RELAY_SESSIONS_PER_ENTITLEMENT = 8 as const;
export const MAX_EVENT_ENVELOPE_BYTES = 8192 as const;
export const MAX_COMMAND_ENVELOPE_BYTES = 8192 as const;
export const MAX_RESULT_ENVELOPE_BYTES = 16384 as const;
export const RESERVED_HIGH_PRIORITY_DAILY_PUSH_SLOTS = 10 as const;
// The phone's own diagnostics-report door (`submitDiagnosticsReport`). Mirrored because the drift
// check compares the whole limit set; the desktop is not a caller of it.
export const MAX_DIAGNOSTIC_REPORTS_PER_PRINCIPAL_PER_UTC_DAY = 5 as const;
export const MAX_DIAGNOSTIC_REPORT_BYTES = 65536 as const;
export const MAX_DIAGNOSTIC_REPORT_ENTRIES = 400 as const;
export const DIAGNOSTIC_REPORT_RETENTION_MS = 1209600000 as const;
export const MAX_CLIENT_CLOCK_SKEW_MS = 120000 as const;
export const MAX_ID_LENGTH = 128 as const;
export const MAX_LABEL_LENGTH = 64 as const;
export const MAX_CAPABILITIES_PER_DEVICE = 16 as const;
export const MAX_PROFILES_PER_DEVICE = 32 as const;
export const MAX_PUSH_TOKEN_LENGTH = 4096 as const;
export const MAX_COMMAND_TTL_MS = 86400000 as const;
export const MAX_DESTRUCTIVE_COMMAND_TTL_MS = 300000 as const;
export const MAX_EVENT_TTL_MS = 604800000 as const;
export const MAX_ACTIVE_DEVICES_PER_PAIR_UID = 1 as const;
export const PENDING_PAIRING_APPROVAL_TTL_MS = 600000 as const;
export const COMMAND_RESERVATION_TTL_MS = 60000 as const;
export const EVENT_RESERVATION_TTL_MS = 60000 as const;

// ---------------------------------------------------------------------------
// Local-only additions — no protocol-package equivalent. These describe how
// THIS desktop persists/authorizes mobile devices; they never cross the wire
// as-is (a Device, above, is what's exchanged with Firebase).
// ---------------------------------------------------------------------------

/**
 * Desktop-local notification filter preferences for one paired device (plan
 * §10.4 "notification filter preferences"). Kept intentionally small: a
 * minimum priority floor plus an explicit mute list, mirroring the
 * high/normal/low priority bucket already used for push (plan §7).
 */
export const MobileNotificationFilterSchema = z.object({
  minPriority: SeveritySchema.default("low"),
  mutedKinds: z.array(z.string()).default([]),
});
export type MobileNotificationFilter = z.infer<typeof MobileNotificationFilterSchema>;

/**
 * Device metadata as persisted in the main state JSON (plan §10.4): device
 * id/label/platform/timestamps/fingerprint/capability+profile allowlist/
 * revocation status/notification filter prefs, PLUS the non-secret
 * identifiers (`uid`, `pairId`, `publicKey`) this desktop needs to actually
 * address the device over Firebase and complete the E2E handshake — none of
 * these three are secret (uid/pairId are routing identifiers, publicKey is
 * public by definition), so excluding them would make the record
 * non-functional without adding any confidentiality. What is deliberately
 * NEVER stored here: private keys (credential-store instead), and any
 * runtime-only handle (live Firebase connection, pending lease, WebSocket) —
 * those cannot survive a restart and must not be persisted at all.
 */
export const MobileDeviceRecordSchema = z.object({
  deviceId: z.string().min(1),
  uid: z.string().min(1),
  pairId: z.string().min(1),
  platform: PlatformSchema,
  label: z.string().min(1),
  /** Public display fingerprint (plan §5.1) — not the raw public key. */
  fingerprint: z.string().min(1),
  publicKey: z.string(),
  /**
   * Which generation of `publicKey` this record pins. Part of the AAD and of the session-key cache
   * key, so a rotation cannot be applied silently: an envelope sealed under one sessionKeyVersion never
   * opens against another (review 2 §P1 "Key lifecycle a rotace").
   */
  sessionKeyVersion: z.number().int().min(1).default(1),
  capabilities: z.array(CapabilitySchema),
  profileAllowlist: z.array(z.string().min(1)),
  createdAt: z.number().int().min(0),
  lastSeenAt: z.number().int().min(0),
  revoked: z.boolean(),
  revokedAt: z.number().int().min(0).nullable(),
  notificationFilter: MobileNotificationFilterSchema,
  /**
   * The invitation this device claimed, and the server's digest of the grants that invitation
   * approved (review 3 §P0.1).
   *
   * Both are compared, not merely stored. A claim is adopted only when its `pairingId` is the one the
   * open invitation is waiting on, and only when the commitment the server wrote matches the one this
   * desktop recomputes from the options the human actually ticked — so a record created against a
   * different invitation, or one injected straight into the database, cannot inherit whatever grants
   * happen to be on screen.
   *
   * Defaulted so a device record written before review 3 still loads; such a record is also forced to
   * `state: "active"` by the same defaults, which is correct — it was adopted and verified under the
   * previous rules and revoking working pairings on upgrade would be a worse answer than accepting
   * them.
   */
  pairingId: z.string().default(""),
  grantCommitment: z.string().default(""),
  /** The claim-time key proof, as submitted. Kept for the audit trail after verification. */
  keyProof: z.string().default(""),
  state: DeviceStateSchema.default("active"),
  /** When this desktop verified the claim's key proof. Null while it has not. */
  verifiedAt: z.number().int().min(0).nullable(),
  /** When the human pressed "Codes match" AND the cloud confirmed. Null means no human has approved. */
  activatedAt: z.number().int().min(0).nullable().default(null),
});
export type MobileDeviceRecord = z.infer<typeof MobileDeviceRecordSchema>;

/** `state.settings.integrations.mobile` — mirrors the telegram/azure/github integration settings shape. */
export const MobileRelaySettingsSchema = z.object({
  enabled: z.boolean().default(false),
});

export const MobileIntegrationSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  devices: z.array(MobileDeviceRecordSchema).default([]),
  relay: MobileRelaySettingsSchema.default({ enabled: false }),
});
export type MobileIntegrationSettings = z.infer<typeof MobileIntegrationSettingsSchema>;

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
  e2e: z
    .object({
      v: z.literal(1),
      keyId: z.string().min(1),
      phoneEphemeralPub: z.string(),
    })
    .optional(),
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
  // What the phone's Activity list reads at a glance, so a row does not have to hide its answer
  // behind a tap. All optional: an event from an older desktop carries none of them and is still a
  // valid event.
  workspaceName: z.string().optional(),
  taskId: z.string().min(1).optional(),
  panelId: z.string().optional(),
  tab: z.string().optional(),
  activity: z.string().optional(),
  prompt: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().min(0).optional(),
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
// Mirrors of generated/account.ts
//
// The sanitized account/entitlement documents a client is allowed to see. None of it is an
// authorization input — the three entitlement claims on the ID token are — and none of it may
// carry a Paddle identifier, a raw email or the internal account id.
// ---------------------------------------------------------------------------

export const EntitlementSummarySchema = z.object({
  state: z.enum(["unbound", "trial", "active", "past_due", "lapsed", "revoked", "billing_unconfigured"]),
  notAfter: z.number().int().min(0).optional(),
  renewalAt: z.number().int().min(0).optional(),
  cancellationAt: z.number().int().min(0).optional(),
  planLabel: z.string().optional(),
  source: z.enum(["none", "trial", "subscription", "operator", "incident"]),
});
export type EntitlementSummary = z.infer<typeof EntitlementSummarySchema>;

export const BillingOfferSchema = z.object({
  offerId: z.string().min(1),
  planLabel: z.string().min(1),
  formattedPrice: z.string().min(1),
  billingPeriod: z.enum(["monthly", "annual"]),
});
export type BillingOffer = z.infer<typeof BillingOfferSchema>;

export const AccountUsageCounterSchema = z.object({
  used: z.number().int().min(0),
  limit: z.number().int().min(0),
});
export type AccountUsageCounter = z.infer<typeof AccountUsageCounterSchema>;

export const AccountUsageSchema = z.object({
  installations: AccountUsageCounterSchema,
  mobileDevices: AccountUsageCounterSchema,
  activeRelaySessions: AccountUsageCounterSchema,
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

export const AccountPairSummarySchema = z.object({
  pairId: z.string().min(1),
  pairDeviceId: z.string().min(1),
  desktopInstallationId: z.string().min(1),
  desktopLabel: z.string().optional(),
});
export type AccountPairSummary = z.infer<typeof AccountPairSummarySchema>;

export const AccountInstallationSummarySchema = z.object({
  installationId: z.string().min(1),
  label: z.string().optional(),
  keyFingerprintSuffix: z.string().optional(),
  registeredAt: z.number().int().min(0),
  lastSeenAt: z.number().int().min(0).optional(),
  isThisInstallation: z.boolean(),
  state: z.enum(["active", "revoked"]),
});
export type AccountInstallationSummary = z.infer<typeof AccountInstallationSummarySchema>;

export const AccountMobileDeviceSummarySchema = z.object({
  mobileDeviceKeySuffix: z.string(),
  label: z.string().optional(),
  platform: PlatformSchema,
  boundAt: z.number().int().min(0),
  lastSeenAt: z.number().int().min(0).optional(),
  state: z.enum(["active", "revoked"]),
  pairs: z.array(AccountPairSummarySchema),
});
export type AccountMobileDeviceSummary = z.infer<typeof AccountMobileDeviceSummarySchema>;

export const AccountNoticeSummarySchema = z.object({
  noticeId: z.string().min(1),
  kind: z.enum(["trial-ending-3d", "trial-ending-1d", "trial-ended", "cap-reached", "payment-issue", "access-ended"]),
  effectiveAt: z.number().int().min(0),
  createdAt: z.number().int().min(0),
  acknowledgedAt: z.number().int().min(0).optional(),
});
export type AccountNoticeSummary = z.infer<typeof AccountNoticeSummarySchema>;

export const AccountDeletionStatusSchema = z.object({
  phase: z.enum(["requested", "blocked", "billing-settled", "claims-settled", "completed", "needs-operator"]),
  requestedAt: z.number().int().min(0),
  completedAt: z.number().int().min(0).optional(),
});
export type AccountDeletionStatus = z.infer<typeof AccountDeletionStatusSchema>;

export const AccountOverviewSchema = z.object({
  accountDisplay: z.string().optional(),
  supportReference: z.string().min(1),
  entitlement: EntitlementSummarySchema,
  offers: z.array(BillingOfferSchema),
  usage: AccountUsageSchema,
  installations: z.array(AccountInstallationSummarySchema),
  mobileDevices: z.array(AccountMobileDeviceSummarySchema),
  notices: z.array(AccountNoticeSummarySchema),
  billingConfigured: z.boolean(),
  deletion: AccountDeletionStatusSchema.optional(),
  generatedAt: z.number().int().min(0),
});
export type AccountOverview = z.infer<typeof AccountOverviewSchema>;

// The details block of a fair-use cap rejection (`resource-exhausted`), which is NOT a member of
// ControlPlaneErrorDetails: it never travels in a success-shaped response body. `cap` and `limit`
// are both required — a UI has to be able to say "five of five desktops" without hard-coding the
// number, and WHICH cap decides which screen the user is sent to.
export const CapExhaustedErrorDetailsSchema = z.object({
  reason: z.enum(["cap-exceeded"]),
  cap: z.enum(["installations", "mobileDevices", "pairedMobileDevices", "relaySessions"]),
  limit: z.number().int().min(0),
});
export type CapExhaustedErrorDetails = z.infer<typeof CapExhaustedErrorDetailsSchema>;

export const ControlPlaneErrorDetailsSchema = z.object({
  reason: z.enum(["account-mismatch", "already-paired", "billing-unconfigured", "no-subscription"]),
});
export type ControlPlaneErrorDetails = z.infer<typeof ControlPlaneErrorDetailsSchema>;

// ---------------------------------------------------------------------------
// Mirrors of generated/account-requests.ts
//
// Request/response pairs for the account, installation, trial, billing and revoke callables.
// Every one of these is DESKTOP-ONLY at the IPC boundary (see electron/backend/ipc-schemas.ts):
// the remote web renderer does not route them, and the parity test names them.
// ---------------------------------------------------------------------------

export const EnsureAccountRequestSchema = z.object({
  idempotencyKey: z.string().min(1),
});
export type EnsureAccountRequest = z.infer<typeof EnsureAccountRequestSchema>;

export const EnsureAccountResponseSchema = z.object({
  status: z.enum(["created", "existing"]),
  supportReference: z.string().min(1),
  claimsChanged: z.boolean(),
});
export type EnsureAccountResponse = z.infer<typeof EnsureAccountResponseSchema>;

export const InstallationChallengeRequestSchema = z.object({
  installationId: z.string().min(1),
  publicKey: z.string(),
  label: z.string().optional(),
});
export type InstallationChallengeRequest = z.infer<typeof InstallationChallengeRequestSchema>;

export const InstallationChallengeResponseSchema = z.object({
  challengeId: z.string().min(1),
  transcript: z.string().min(1),
  expiresAt: z.number().int().min(0),
});
export type InstallationChallengeResponse = z.infer<typeof InstallationChallengeResponseSchema>;

export const InstallationRegistrationRequestSchema = z.object({
  challengeId: z.string().min(1),
  signature: z.string(),
  idempotencyKey: z.string().min(1),
  label: z.string().optional(),
  mode: z.enum(["register", "recover-uid"]),
  pairHints: z.array(z.string().min(1)).optional(),
});
export type InstallationRegistrationRequest = z.infer<typeof InstallationRegistrationRequestSchema>;

export const InstallationRegistrationResponseSchema = z.object({
  status: z.enum(["registered", "already-registered", "uid-recovered", "refused"]),
  installationId: z.string().min(1).optional(),
  claimsChanged: z.boolean(),
  adoptedPairIds: z.array(z.string().min(1)).optional(),
  refusedPairIds: z.array(z.string().min(1)).optional(),
  errorReason: ControlPlaneErrorDetailsSchema.optional(),
});
export type InstallationRegistrationResponse = z.infer<typeof InstallationRegistrationResponseSchema>;

export const TrialStartRequestSchema = z.object({
  installationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
});
export type TrialStartRequest = z.infer<typeof TrialStartRequestSchema>;

export const TrialStartResponseSchema = z.object({
  status: z.enum(["started", "already-started", "not-eligible"]),
  notAfter: z.number().int().min(0).optional(),
  reason: z
    .enum(["installation-already-trialed", "account-has-billing-history", "account-has-active-entitlement"])
    .optional(),
  claimsChanged: z.boolean(),
});
export type TrialStartResponse = z.infer<typeof TrialStartResponseSchema>;

export const CheckoutRequestSchema = z.object({
  offerId: z.string().min(1),
  installationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

export const CheckoutResponseSchema = z.object({
  status: z.enum(["ready", "checkout-pending", "refused"]),
  checkoutUrl: z.string().optional(),
  intentId: z.string().min(1).optional(),
  errorReason: ControlPlaneErrorDetailsSchema.optional(),
});
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;

export const PortalSessionRequestSchema = z.object({
  installationId: z.string().min(1),
});
export type PortalSessionRequest = z.infer<typeof PortalSessionRequestSchema>;

export const PortalSessionResponseSchema = z.object({
  status: z.enum(["ready", "refused"]),
  portalUrl: z.string().optional(),
  expiresAt: z.number().int().min(0).optional(),
  errorReason: ControlPlaneErrorDetailsSchema.optional(),
});
export type PortalSessionResponse = z.infer<typeof PortalSessionResponseSchema>;

export const AccountRevokeRequestSchema = z.object({
  kind: z.enum(["installation", "mobile-device", "pair", "account-wide"]),
  targetId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
});
export type AccountRevokeRequest = z.infer<typeof AccountRevokeRequestSchema>;

export const AccountRevokeResponseSchema = z.object({
  status: z.enum(["revoked", "already-revoked", "not-found"]),
  revokedPairDeviceIds: z.array(z.string().min(1)),
  relayCommandsQueued: z.number().int().min(0),
});
export type AccountRevokeResponse = z.infer<typeof AccountRevokeResponseSchema>;

export const AccountDeletionRequestSchema = z.object({
  confirmationPhrase: z.string().min(1),
  idempotencyKey: z.string().min(1),
});
export type AccountDeletionRequest = z.infer<typeof AccountDeletionRequestSchema>;

export const AccountDeletionResponseSchema = z.object({
  status: z.enum(["accepted", "already-pending", "refused"]),
  deletionJobId: z.string().min(1).optional(),
  providerCancellationRequired: z.boolean(),
});
export type AccountDeletionResponse = z.infer<typeof AccountDeletionResponseSchema>;

/**
 * `confirmOwnerForInstallation` — the passwordless flow's owner check.
 *
 * The request carries a LOCATOR and nothing else: the server reads the installation out of the
 * caller's own account and never trusts the id to name which account is meant. The response carries
 * no email, no owner uid and no account id, because a confirmation door that answered with an
 * identity would be a way to read one.
 */
export const ConfirmOwnerRequestSchema = z.object({
  installationId: z.string().min(1),
});
export type ConfirmOwnerRequest = z.infer<typeof ConfirmOwnerRequestSchema>;

export const ConfirmOwnerResponseSchema = z.object({
  status: z.enum(["confirmed", "refused"]),
  reason: z.enum(["owner-mismatch", "installation-not-active", "account-unavailable"]).optional(),
});
export type ConfirmOwnerResponse = z.infer<typeof ConfirmOwnerResponseSchema>;

export const AccountNoticeAckRequestSchema = z.object({
  noticeId: z.string().min(1),
});
export type AccountNoticeAckRequest = z.infer<typeof AccountNoticeAckRequestSchema>;

export const AccountNoticeAckResponseSchema = z.object({
  status: z.enum(["acknowledged", "not-found"]),
});
export type AccountNoticeAckResponse = z.infer<typeof AccountNoticeAckResponseSchema>;

// ---------------------------------------------------------------------------
// Mirrors of generated/control-plane-bootstrap.ts
//
// The signed document that tells an already-released build which control plane to talk to.
// The desktop verifies it with the same canonical serialisation and the same trust-key
// allowlist the Flutter app uses; the cross-runtime vectors are what hold the two together.
// ---------------------------------------------------------------------------

export const ControlPlaneBootstrapPayloadSchema = z.object({
  schemaVersion: z.number().int().min(1),
  environment: z.enum(["local", "dev", "qa", "prod"]),
  configEpoch: z.number().int().min(1),
  issuedAt: z.number().int().min(0),
  notBefore: z.number().int().min(0).optional(),
  projectId: z.string().min(1),
  apiKey: z.string().min(1),
  appId: z.string().min(1),
  messagingSenderId: z.string().min(1),
  databaseUrl: z.string().min(1),
  functionsBaseUrl: z.string().min(1),
  relayOrigin: z.string().optional(),
  appCheckAndroidAppId: z.string().optional(),
  appCheckWebAppId: z.string().optional(),
  /**
   * The EXACT hostnames a checkout or portal URL may point at. Lower-cased, no scheme, no port.
   *
   * Schema version 2. Here because this runtime's external opener needs an allowlist and a signed,
   * environment-scoped envelope is the only place it can get one from — it used to hand any `https:`
   * (indeed any `http:`) URL from a callable response straight to `shell.openExternal`. Empty means
   * this build opens NO billing URL, which is the right default for one that has not been told which
   * merchant it uses.
   */
  billingCheckoutHosts: z.array(z.string().min(1)).optional(),
});
export type ControlPlaneBootstrapPayload = z.infer<typeof ControlPlaneBootstrapPayloadSchema>;

export const ControlPlaneBootstrapEnvelopeSchema = z.object({
  v: z.literal(1),
  keyId: z.string().min(1),
  payload: ControlPlaneBootstrapPayloadSchema,
  signature: z.string(),
});
export type ControlPlaneBootstrapEnvelope = z.infer<typeof ControlPlaneBootstrapEnvelopeSchema>;

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
  /**
   * The principal `claimPairing` charges and authorizes against, resolved by the server from the
   * DESKTOP's own token when the human approved the pairing.
   *
   * A phone that has never paired has no entitlement of its own, so charging the caller at claim
   * time meant either refusing every first pairing or opening the door to any anonymous caller. The
   * invitation is the desktop's authorization, made durable — and neither field reaches the QR, so
   * this desktop writes neither and the phone never sees them.
   */
  admissionPrincipalId: z.string().min(1).optional(),
  principalNotAfter: z.number().int().min(0).optional(),
  createdAt: z.number().int().min(0),
  expiresAt: z.number().int().min(0),
  status: PairingStatusSchema,
  /**
   * WHICH claim consumed the invitation, and what that claim produced.
   *
   * Server-written and never in the QR — this desktop reads them and writes neither. Their reason is
   * that a claim whose HTTP response was lost used to meet a permanent `already-claimed` on every
   * retry: a pairing that HAD completed, presented to the phone as one that had not, with no way to
   * tell that apart from somebody else consuming the invitation. `completion`'s ABSENCE on a consumed
   * invitation is the signal that the claim consumed the credential and did not finish.
   */
  claimedBy: z.string().min(1).optional(),
  claimedAt: z.number().int().min(0).optional(),
  completion: z
    .object({
      mobileDeviceId: z.string().min(1),
      claimsChanged: z.boolean(),
      completedAt: z.number().int().min(0),
      /**
       * The COMPLETE success response the first call returned, replayed byte for byte to a retry.
       *
       * A replay used to be rebuilt from the device id and the pair id alone, and the phone refused
       * it: `PairingRepository` requires `desktopDeviceId`, `desktopLabel` and `desktopPublicKey` and
       * compares them against the scanned QR, so a claim whose response was lost ended as an invalid
       * response instead of a finished pairing. A record with no `response` (written by an earlier
       * build) is RESUMED rather than replayed.
       */
      response: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
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
  status: z.enum(["claimed", "expired", "invalid", "already-claimed", "refused"]),
  /**
   * The structured half of a `refused`. Added because the phone was previously left to GUESS which
   * of several very different problems it had hit — a device cap, a pairing cap, or an invitation
   * belonging to somebody else's account — from one undifferentiated failure.
   */
  errorReason: ControlPlaneErrorDetailsSchema.optional(),
  /**
   * True when the claim bound the phone's uid to an account and raised the claim-sync revision, so
   * the phone must force an ID-token refresh BEFORE registering a push token or asking for a relay
   * grant: its current token predates the claim.
   */
  claimsChanged: z.boolean().optional(),
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
  e2e: z
    .object({
      v: z.literal(1),
      keyId: z.string().min(1),
      desktopEphemeralPub: z.string(),
    })
    .optional(),
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
// The diagnostics-report door (`submitDiagnosticsReport`). The desktop IS a caller of it — the
// Account page's opt-in "send diagnostics" — so these are the bounds `account-diagnostics.ts`
// trims to before sending, not merely a mirrored set the drift check compares.
export const MAX_DIAGNOSTIC_REPORTS_PER_PRINCIPAL_PER_UTC_DAY = 100 as const;
export const MAX_DIAGNOSTIC_REPORT_BYTES = 65536 as const;
export const MAX_DIAGNOSTIC_REPORT_ENTRIES = 400 as const;
export const DIAGNOSTIC_REPORT_RETENTION_MS = 1209600000 as const;
export const MAX_DIAGNOSTIC_NOTE_LENGTH = 500 as const;
export const MAX_DIAGNOSTIC_EVENT_LENGTH = 80 as const;
export const MAX_DIAGNOSTIC_STATUS_LENGTH = 120 as const;
export const MAX_DIAGNOSTIC_LEVEL_LENGTH = 8 as const;
export const MAX_DIAGNOSTIC_APP_FIELD_LENGTH = 80 as const;
export const MAX_DIAGNOSTIC_FIELDS_PER_ENTRY = 12 as const;
export const MAX_DIAGNOSTIC_FIELD_KEY_LENGTH = 40 as const;
export const MAX_DIAGNOSTIC_FIELD_VALUE_LENGTH = 200 as const;
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

// The account/billing bounds. The two caps are the ones a user sees on the Account tab as
// `installations / 5` and `mobile devices / 5`; the rest bound server work the desktop never
// performs and are mirrored because the drift check compares the whole limit set.
export const MAX_INSTALLATIONS_PER_ENTITLEMENT = 5 as const;
export const MAX_MOBILE_DEVICES_PER_ENTITLEMENT = 5 as const;
export const MAX_ACCOUNT_BOOTSTRAP_REQUESTS_PER_UID_PER_UTC_DAY = 20 as const;
export const MAX_INSTALLATION_CHALLENGES_PER_ACCOUNT_PER_UTC_DAY = 40 as const;
export const MAX_TRIAL_REQUESTS_PER_ACCOUNT_PER_UTC_DAY = 10 as const;
export const MAX_CHECKOUT_REQUESTS_PER_ACCOUNT_PER_UTC_DAY = 20 as const;
export const MAX_PORTAL_SESSIONS_PER_ACCOUNT_PER_UTC_DAY = 20 as const;
export const MAX_ACCOUNT_OVERVIEW_REQUESTS_PER_UID_PER_MINUTE = 12 as const;
/** A durable per-account ceiling on the owner-confirmation door. */
export const MAX_OWNER_CONFIRMATIONS_PER_ACCOUNT_PER_UTC_DAY = 40 as const;
export const INSTALLATION_CHALLENGE_TTL_MS = 120000 as const;
export const CHECKOUT_INTENT_TTL_MS = 3600000 as const;
export const PROVIDER_MUTATION_AMBIGUOUS_OBSERVATION_MS = 900000 as const;
export const PADDLE_WEBHOOK_FRESHNESS_TOLERANCE_MS = 300000 as const;
export const CLAIM_SYNC_REPAIR_BATCH_SIZE = 25 as const;
export const CLAIM_SYNC_MAX_UIDS_PER_ACCOUNT = 32 as const;
export const RECONCILIATION_BATCH_SIZE = 50 as const;
/** A durable per-uid ceiling on the challenge leg, so an anonymous caller cannot mint server state. */
export const MAX_INSTALLATION_CHALLENGES_PER_UID_PER_UTC_DAY = 20 as const;
/** One PAGE of the incident compensation walk. A cursor is what makes the walk finishable. */
export const INCIDENT_COMPENSATION_ACCOUNTS_PER_RUN = 200 as const;
/** How many adjustments one repair sweep re-asks the merchant about. */
export const ADJUSTMENT_REPAIRS_PER_SWEEP = 25 as const;
/** Bounded provider fallback when a late adjustment's local transaction index has been swept. */
export const ADJUSTMENT_ROUTING_PROVIDER_LOOKUP_MAX = 5 as const;
/** One PAGE of a durable RTDB branch in a backup export. Paged with a keyset cursor, not truncated. */
export const RTDB_EXPORT_PAGE_SIZE = 5000 as const;
export const ACCOUNT_NOTICE_DELIVERY_BATCH_SIZE = 50 as const;
export const RELAY_REVOCATION_DISPATCH_BATCH_SIZE = 25 as const;
export const MAX_ACCOUNT_OVERVIEW_LIST_ENTRIES = 32 as const;
export const MAX_ACCOUNT_NOTICES_IN_OVERVIEW = 10 as const;
export const MAX_PAIR_HINTS_PER_REGISTRATION = 32 as const;
export const ACCOUNT_NOTICE_RETENTION_MS = 3024000000 as const;
export const BILLING_BOOKKEEPING_RETENTION_MS = 3024000000 as const;

// --- control-plane params (protocol/schemas/control-plane-params.json) ------
//
// The names the entitlement boundary is spelled with. They appear in the Cloud Functions, in the
// Firebase Security Rules (which cannot import anything), here, and in the Flutter app — a mismatch
// between any two is an outage with no error message, because every token verifies and every rule
// refuses.
export const ENTITLEMENT_ISSUER_NAME = "strideterm-control-plane" as const;
export const ENTITLEMENT_CLAIM_ID = "entitlementId" as const;
export const ENTITLEMENT_CLAIM_ISSUER = "entitlementIssuer" as const;
export const ENTITLEMENT_CLAIM_NOT_AFTER = "entitlementNotAfter" as const;
export const RECOVERY_ACCOUNT_CLAIM_KEY = "stridetermRecoveryAccountId" as const;

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
  excludedProfileIds: z.array(z.string().min(1)).optional(),
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
  /**
   * THE CLOUD HALF OF A REVOCATION THIS DESKTOP HAS ALREADY APPLIED LOCALLY, still owed.
   *
   * Set the moment `applyLocalRevocation` lands and cleared only when the Cloud Function confirms.
   * Before it existed, `MobileManager.revokeDevice` called the transport once and swallowed the
   * failure into a `log.warn`: a desktop that was offline when the user revoked a phone left the
   * cloud record `active` FOR EVER, so the phone never learned it had been unpaired and went on
   * holding its pair membership, its push token and its mailbox. The two sides then disagreed
   * permanently, with nothing anywhere that would ever reconcile them.
   *
   * It lives on the device record rather than in a branch of its own because the record IS the
   * outbox entry — it is already persisted in the same atomically-written state blob, it already
   * carries the `pairId` and `pairingId` the retry needs, and it goes away exactly when the record
   * does. Optional so a record written before this loads unchanged.
   */
  pendingCloudRevoke: z
    .object({
      /** Which Cloud Function is owed: a revoke of an adopted device, or a rejection of a claim. */
      kind: z.enum(["revoke", "reject"]),
      /** `rejectPairing`'s reason. Absent for `kind: "revoke"`, which takes none. */
      reason: z.string().optional(),
      requestedAt: z.number().int().min(0),
      attempts: z.number().int().min(0).default(0),
      lastAttemptAt: z.number().int().min(0).optional(),
      /** A stable `mobileErrorCode`, never a transport message — this crosses into the renderer. */
      lastErrorCode: z.string().optional(),
    })
    .optional(),
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

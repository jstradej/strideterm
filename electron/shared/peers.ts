import { z } from "zod";
import { SIDEBAR_NOTE_MAX_LENGTH, saveInstallationNoteSchema, undoInstallationNoteSchema } from "./sidebar-notes.js";
import type { WindowSlotBounds } from "./types/state.js";

/**
 * Attaching profiles of another strIDEterm over the local network.
 *
 * "Host" is the installation whose profiles are attached; "device" is the paired desktop that
 * attaches them. Pairing is one-directional and both roles run on every desktop OS.
 */

export const PEER_DEFAULT_PORT = 43124;
export const PEER_PROTOCOL_VERSION = 1;
export const PEER_SAS_DIGITS = 8;
export const PEER_PAIRING_TTL_MS = 10 * 60_000;

export interface PeerHostingSettings {
  enabled: boolean;
  port: number;
}

/** A desktop this installation lets in. Host side. */
export interface PeerDeviceRecord {
  id: string;
  name: string;
  platform: string;
  publicKey: string;
  pairedAt: number;
  lastSeenAt: number;
  lastAddress: string;
}

/** An installation this desktop attaches profiles from. Device side. `id` is the host's instance id. */
export interface PeerHostRecord {
  id: string;
  label: string;
  address: string;
  port: number;
  hostPublicKey: string;
  pairedAt: number;
}

export interface PeerIntegrationSettings {
  /** Random id of this installation, minted on first use. Empty until then. */
  instanceId: string;
  hosting: PeerHostingSettings;
  devices: PeerDeviceRecord[];
  hosts: PeerHostRecord[];
}

export function defaultPeerSettings(): PeerIntegrationSettings {
  return { instanceId: "", hosting: { enabled: false, port: PEER_DEFAULT_PORT }, devices: [], hosts: [] };
}

const peerId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
/** 32 bytes in canonical base64. */
const base64Bytes32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const port = z.int().min(1).max(65535);

export const peerPairBeginSchema = z
  .object({
    protocolVersion: z.literal(PEER_PROTOCOL_VERSION),
    deviceId: peerId,
    name: z.string().trim().min(1).max(64),
    platform: z.string().trim().min(1).max(16),
    appVersion: z.string().trim().min(1).max(32),
    commitment: base64Bytes32,
  })
  .strict();

export const peerPairRevealSchema = z
  .object({ pairingId: peerId, publicKey: base64Bytes32, nonce: base64Bytes32 })
  .strict();

export const peerPairStatusSchema = z.object({ pairingId: peerId }).strict();

export type PeerPairBegin = z.infer<typeof peerPairBeginSchema>;
export type PeerPairReveal = z.infer<typeof peerPairRevealSchema>;

export interface PeerPairBeginResult {
  pairingId: string;
  hostInstanceId: string;
  hostName: string;
  appVersion: string;
  hostPublicKey: string;
  hostNonce: string;
}

export type PeerPairingState = "awaiting-reveal" | "awaiting-approval" | "approved" | "rejected" | "expired";

export interface PeerPairStatusResult {
  state: PeerPairingState;
}

/** What an authenticated device learns about the host before it shows anything. */
export interface PeerHello {
  protocolVersion: number;
  hostInstanceId: string;
  hostName: string;
  appVersion: string;
  profiles: Array<{ id: string; name: string; color: string; workspaceCount: number }>;
}

/** A pairing request waiting for the code to be typed on the host. Never carries the code. */
export interface PeerPendingPairing {
  pairingId: string;
  deviceId: string;
  name: string;
  platform: string;
  appVersion: string;
  address: string;
  createdAt: number;
  sasReady: boolean;
}

export type PeerApproveResult = "approved" | "sas-mismatch" | "not-found";

export interface PeerListenerInfo {
  listening: boolean;
  port: number;
  addresses: string[];
  error: string;
}

/** Everything the host's settings screen shows. Carries no key, nonce or code. */
export interface PeerHostState {
  hosting: PeerHostingSettings;
  instanceId: string;
  hostName: string;
  encryptionAvailable: boolean;
  listener: PeerListenerInfo;
  devices: PeerDeviceRecord[];
  pending: PeerPendingPairing[];
}

export const peerHostingSettingsSchema = z.object({ enabled: z.boolean(), port }).strict();
export const peerApproveSchema = z.object({ pairingId: peerId, code: z.string().max(32) }).strict();
export const peerPairingIdSchema = z.object({ pairingId: peerId }).strict();
export const peerDeviceIdSchema = z.object({ deviceId: peerId }).strict();
export const peerHostIdSchema = z.object({ hostId: peerId }).strict();
export const peerConnectSchema = z
  .object({
    address: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9.:_-]+$/, "Enter a host name or an IP address."),
    port,
  })
  .strict();
export const peerUpdateAddressSchema = peerConnectSchema.extend({ hostId: peerId }).strict();
const peerDisplayName = z.string().trim().min(1, "Enter a name.").max(64, "Use at most 64 characters.");
export const peerRenameHostSchema = z.object({ hostId: peerId, label: peerDisplayName }).strict();
export const peerRenameDeviceSchema = z.object({ deviceId: peerId, name: peerDisplayName }).strict();

export type PeerPairingEndState = "approved" | "rejected" | "expired" | "cancelled" | "failed";

/** The device side's own pairing attempt ended; `hostId` is set when it was approved. */
export interface PeerPairingResult {
  attemptId: string;
  state: PeerPairingEndState;
  hostId?: string;
  error?: string;
}

export interface PeerStartedPairing {
  attemptId: string;
  /** Formatted for display, "1234 5678". */
  code: string;
  hostId: string;
  hostName: string;
  hostAppVersion: string;
}

export type PeerHostLinkState = "unknown" | "online" | "offline" | "not-paired" | "wrong-host" | "version-mismatch";

/** A paired host as the device shows it: the stored record plus what the last check learned. Carries no key. */
export interface PeerAttachedHost extends PeerHostRecord {
  state: PeerHostLinkState;
  hostAppVersion: string;
  localAppVersion: string;
  profiles: PeerHello["profiles"];
  checkedAt: number;
}

/** A window of this desktop that shows a profile of a host. Geometry mirrors `WindowSlot`. */
export interface PeerWindowSlot {
  id: string;
  hostId: string;
  remoteProfileId: string;
  bounds: WindowSlotBounds;
  displayId?: number;
  isMaximized?: boolean;
  lastFocusedAt: number;
}

/**
 * `clientId` names the window to the host; it is derived, never a secret. `terminalFontSize` is this desktop's own
 * `terminalFontSizeLocal`: the host's setting never applies to a window of this machine.
 */
export type WindowBackend =
  | { kind: "local" }
  | {
      kind: "peer";
      hostId: string;
      hostLabel: string;
      remoteProfileId: string;
      clientId: string;
      terminalFontSize: number;
    };

export const PEER_TERMINAL_FONT_SIZE_MIN = 8;
export const PEER_TERMINAL_FONT_SIZE_MAX = 32;

export interface LocalProfileOverview {
  id: string;
  name: string;
  color: string;
  workspaceCount: number;
  openWindows: number;
}

export interface PeerWindowOpenResult {
  windowId: string;
}

export interface PeerWindowActivateResult {
  /** False when the window already belonged to that host: it only switches profile through the remote protocol. */
  reloaded: boolean;
}

export interface PeerWsOpenFailure {
  state: "closed";
  code: number;
  reason: string;
}

export type PeerWsState = { state: "open" } | PeerWsOpenFailure;

const profileIdText = z.string().min(1).max(200);

export const peerPairCancelSchema = z.object({ attemptId: peerId }).strict();
export const peerRefreshSchema = z.object({ hostId: peerId, force: z.boolean().optional() }).strict();
export const peerWindowOpenSchema = z.object({ hostId: peerId, profileId: profileIdText }).strict();
export const peerWindowLocalSchema = z.object({ profileId: profileIdText }).strict();
export const peerWindowAttentionSchema = z.object({ count: z.int().min(0).max(9999) }).strict();
export const peerWindowFontSizeSchema = z
  .object({ size: z.int().min(PEER_TERMINAL_FONT_SIZE_MIN).max(PEER_TERMINAL_FONT_SIZE_MAX) })
  .strict();

export const PEER_HTTP_MAX_PATH_LENGTH = 8 * 1024;
export const PEER_HTTP_MAX_BODY_BYTES = 64 * 1024 * 1024;

export const peerHttpSchema = z
  .object({
    method: z.string().min(1).max(16),
    pathname: z.string().min(1).max(PEER_HTTP_MAX_PATH_LENGTH),
    headers: z.record(z.string().max(256), z.string().max(8192)),
    body: z.string().max(PEER_HTTP_MAX_BODY_BYTES).optional(),
  })
  .strict();

export const peerWsOpenSchema = z.record(z.string().max(128), z.string().max(2048));
export const peerWsSendSchema = z.string().max(PEER_HTTP_MAX_BODY_BYTES);
export const peerWsCloseSchema = z
  .object({ code: z.int().min(1000).max(4999).optional(), reason: z.string().max(123).optional() })
  .strict();

/** Sub-folder names of one folder on the host, for choosing where a workspace lives. Never carries files, sizes or dates. */
export interface PeerDirectoryListing {
  /** The absolute folder listed, in the host's own notation. */
  path: string;
  /** Null at a filesystem root. */
  parent: string | null;
  separator: "/" | "\\";
  /** Sub-folders only, sorted case-insensitively. */
  entries: Array<{ name: string }>;
  /** Starting points: the home folder, and "/" or every existing drive root. */
  roots: string[];
  /** More than `PEER_DIRECTORY_MAX_ENTRIES` sub-folders: the first ones are returned. */
  truncated: boolean;
}

export const PEER_DIRECTORY_MAX_ENTRIES = 2000;

/** An empty path means the host's home folder. */
export const peerDirectoryListSchema = z.object({ path: z.string().max(4096) }).strict();

/**
 * Alerts waiting on a host, counted per profile the way its own desktop counts them, and the change counter of its
 * global note. Numbers only: a note's text never rides in this answer.
 */
export interface PeerAttentionSummary {
  total: number;
  profiles: Array<{ profileId: string; count: number }>;
  globalNoteRevision: number;
}

export const peerAttentionSummarySchema = z.object({
  total: z.int().min(0),
  profiles: z.array(z.object({ profileId: z.string().max(200), count: z.int().min(0) })).max(1000),
  globalNoteRevision: z.int().min(0).default(0),
});

export const PEER_GLOBAL_NOTE_ROUTE = "/api/peer/global-note";
export const PEER_GLOBAL_NOTE_SAVE_ROUTE = "/api/peer/global-note/save";
export const PEER_GLOBAL_NOTE_UNDO_ROUTE = "/api/peer/global-note/undo";

export const peerGlobalNoteSaveSchema = saveInstallationNoteSchema.extend({ hostId: peerId }).strict();
export const peerGlobalNoteUndoSchema = undoInstallationNoteSchema.extend({ hostId: peerId }).strict();

/** What a host answers for its global note; parsed on the device before the renderer sees it. */
export const peerGlobalNoteSchema = z.object({
  note: z.object({
    id: z.string().min(1).max(200),
    text: z.string().max(SIDEBAR_NOTE_MAX_LENGTH),
    revision: z.int().min(0),
    canUndo: z.boolean(),
    updatedAt: z.string().max(64).optional(),
  }),
  installationName: z.string().max(200),
});

export const PEER_ATTACHMENT_LIST_DAYS = 14;
export const PEER_ATTACHMENT_LIST_MAX_ITEMS = 200;

/** One attachment a host holds, with the profile and workspace that own it. Metadata only. */
export interface PeerAttachmentItem {
  profileId: string;
  profileName: string;
  workspaceId: string;
  workspaceName: string;
  transferId: string;
  name: string;
  size: number;
  sha256: string;
  uploadedAt: number;
}

/** Recent attachments across every profile of the host, newest first. `truncated`: more than the cap were recent. */
export interface PeerAttachmentList {
  items: PeerAttachmentItem[];
  truncated: boolean;
}

/** Names a host sends are cut to this; the item schema refuses a longer one. */
export const PEER_ATTACHMENT_NAME_MAX = 200;

export const peerAttachmentItemSchema = z.object({
  profileId: z.string().max(PEER_ATTACHMENT_NAME_MAX),
  profileName: z.string().max(PEER_ATTACHMENT_NAME_MAX),
  workspaceId: z.string().min(1).max(PEER_ATTACHMENT_NAME_MAX),
  workspaceName: z.string().max(PEER_ATTACHMENT_NAME_MAX),
  transferId: z.string().uuid(),
  name: z.string().min(1).max(255),
  size: z.int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  uploadedAt: z.int().min(0),
});

/** The list as an envelope only: each item is validated on its own, so one bad item does not reject the rest. */
export const peerAttachmentListEnvelopeSchema = z.object({
  items: z.array(z.unknown()).max(PEER_ATTACHMENT_LIST_MAX_ITEMS),
  truncated: z.boolean(),
});

const PEER_ATTACHMENT_COPY_MAX_BYTES = 1024 * 1024 * 1024;

export const peerAttachmentCopySchema = z
  .object({
    hostId: peerId,
    source: z
      .object({
        workspaceId: z.string().min(1).max(200),
        transferId: z.string().uuid(),
        name: z.string().min(1).max(255),
        size: z.int().min(1).max(PEER_ATTACHMENT_COPY_MAX_BYTES),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    targetWorkspaceId: z.string().min(1).max(200),
  })
  .strict();
export type PeerAttachmentCopyRequest = z.infer<typeof peerAttachmentCopySchema>;

export const peerAttachmentCopyCancelSchema = z.object({ copyId: z.string().uuid() }).strict();

import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import {
  PEER_GLOBAL_NOTE_ROUTE,
  PEER_GLOBAL_NOTE_SAVE_ROUTE,
  PEER_GLOBAL_NOTE_UNDO_ROUTE,
  PEER_PROTOCOL_VERSION,
  peerAttachmentItemSchema,
  peerAttachmentListEnvelopeSchema,
  peerGlobalNoteSchema,
  type LocalProfileOverview,
  type PeerApproveResult,
  type PeerAttachedHost,
  type PeerAttachmentCopyRequest,
  type PeerAttachmentItem,
  type PeerAttachmentList,
  type PeerAttentionSummary,
  type PeerHello,
  type PeerHostState,
  type PeerHostingSettings,
  type PeerIntegrationSettings,
  type PeerListenerInfo,
  type PeerWindowSlot,
  type WindowBackend,
} from "../shared/peers.js";
import type { InstallationNote, SaveInstallationNote, UndoInstallationNote } from "../shared/sidebar-notes.js";
import type { AppState, WindowSlotBounds } from "../shared/types/state.js";
import { getLogger } from "./logger.js";
import type { AttachmentReadRequest } from "../shared/attachment-upload.js";
import { createPeerAttachmentCopies } from "./peers/peer-attachment-copy.js";
import { createPeerAttachmentsHost } from "./peers/peer-attachments.js";
import { listPeerDirectories } from "./peers/peer-directories.js";
import { createPeerAttentionPoller, type PeerHostAttention } from "./peers/peer-attention-poller.js";
import { summarizeAttentionForProfile } from "./runtime-utils.js";
import { createPeerClient, type PeerClientDeps, type PeerRequest } from "./peers/peer-client.js";
import { createPeerHost, type PeerHostDeps } from "./peers/peer-host.js";

const log = getLogger("peers");

export const PEER_HOSTING_CHANGED_EVENT = "peers:hosting-changed";
export const PEER_HOST_REMOVED_EVENT = "peers:host-removed";

export const PEER_WINDOW_NOT_ATTACHED = "This window is not attached to another desktop.";
const CLIENT_ID_HEADER = "x-strideterm-client-id";
const CASCADE_ORIGIN = 100;
const CASCADE_STEP = 32;

export interface RuntimePeersDeps {
  getState: () => AppState;
  mutate: (reason: string, mutator: (draft: AppState) => void) => Promise<unknown>;
  credentials: PeerHostDeps["credentials"] & PeerClientDeps["credentials"];
  appVersion: string;
  emit: (event: string, payload: unknown) => void;
  /** Workspaces and the attention snapshot, in the shape `summarizeAttentionForProfile` reads. */
  getAttentionPayload?: () => Parameters<typeof summarizeAttentionForProfile>[0];
  /** The state payload changed (an attachment copy advanced or ended). */
  changed?: () => void;
  /** Change counter of this installation's global note, for the attention answer. */
  getInstallationNoteRevision?: () => number;
}

export function peerHostName(): string {
  return os.hostname().trim().slice(0, 64) || "strIDEterm";
}

/** Names a window to the host. Stable, not guessable by chance, and not a secret: the link authenticates, this only separates windows. */
export function peerWindowClientId(instanceId: string, windowId: string): string {
  return "w" + createHash("sha256").update(`${instanceId}\n${windowId}`).digest("hex").slice(0, 40);
}

/** Works on the raw string: parsing the path as a URL would normalise it behind the back of the client's path check. */
function withBoundProfile(pathname: string, profileId: string): string {
  const split = pathname.indexOf("?");
  const path = split < 0 ? pathname : pathname.slice(0, split);
  const query = new URLSearchParams(split < 0 ? "" : pathname.slice(split + 1));
  query.delete("profileId");
  if (profileId) query.set("profileId", profileId);
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** Workspaces per profile, counted the way the host's hello counts them. */
export function countWorkspacesByProfile(state: Pick<AppState, "workspaces">): Map<string, number> {
  const counts = new Map<string, number>();
  for (const workspace of state.workspaces) {
    const id = String(workspace.profileId || "default");
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * The host side of attaching profiles between desktops. Desktop only: the remote server reaches the
 * `peerHost` handed to its peer listener and nothing else here.
 */
export function createRuntimePeers(deps: RuntimePeersDeps) {
  const settings = (): PeerIntegrationSettings => deps.getState().settings.integrations.peers;
  let listener: PeerListenerInfo = { listening: false, port: settings().hosting.port, addresses: [], error: "" };

  const peerHost = createPeerHost({
    getSettings: settings,
    updateSettings: async (reason, update) => {
      await deps.mutate(reason, (draft) => update(draft.settings.integrations.peers));
    },
    credentials: deps.credentials,
    appVersion: deps.appVersion,
    hostName: peerHostName,
    emit: (event, payload) => deps.emit(event, payload),
  });

  const peerClient = createPeerClient({
    getSettings: settings,
    updateSettings: async (reason, update) => {
      await deps.mutate(reason, (draft) => update(draft.settings.integrations.peers));
    },
    credentials: deps.credentials,
    appVersion: deps.appVersion,
    deviceName: peerHostName,
    platform: process.platform,
    emit: (event, payload) => deps.emit(event, payload),
  });

  const attentionPoller = createPeerAttentionPoller({
    listHostIds: () => settings().hosts.map((host) => host.id),
    getHostStatus: (hostId) => peerClient.getHostStatus(hostId),
    request: (hostId, request) => peerClient.request(hostId, request),
    emit: (event, payload) => deps.emit(event, payload),
  });

  const attachmentsHost = createPeerAttachmentsHost({ getState: () => deps.getState() });

  const attachmentCopies = createPeerAttachmentCopies({
    getState: () => deps.getState(),
    hostInfo: (hostId) => {
      const host = settings().hosts.find((entry) => entry.id === hostId);
      return host ? { label: host.label, state: peerClient.getHostStatus(hostId).state } : null;
    },
    requireHostOnline: (hostId) => requireHostOnline(hostId),
    request: (hostId, request) => peerClient.request(hostId, request),
    emit: (channel, payload) => deps.emit(channel, payload),
    changed: () => deps.changed?.(),
  });

  /** Refreshes the host and refuses, with the reason, unless it is reachable, the same version and still pairing this desktop. */
  async function requireHostOnline(hostId: string): Promise<PeerAttachedHost> {
    if (!settings().hosts.some((host) => host.id === hostId)) throw new Error("This desktop is not attached.");
    await peerClient.refreshHost(hostId);
    const host = attached(hostId);
    if (!host) throw new Error("This desktop is not attached.");
    if (host.state === "online") return host;
    if (host.state === "version-mismatch") {
      throw new Error(
        `${host.label} runs strIDEterm ${host.hostAppVersion || "of another version"}, this desktop runs ${host.localAppVersion}. Both must run the same version.`,
      );
    }
    if (host.state === "not-paired") throw new Error(`${host.label} no longer accepts this desktop. Pair it again.`);
    if (host.state === "wrong-host") throw new Error(`The address of ${host.label} now answers as another strIDEterm.`);
    throw new Error(`${host.label} cannot be reached.`);
  }

  /** The host's own sentence travels with its refusal (a 409 says the note changed), never "status 409". */
  async function hostGlobalNoteCall(hostId: string, request: PeerRequest): Promise<InstallationNote> {
    const host = attached(hostId);
    if (!host) throw new Error("This desktop is not attached.");
    if (host.state !== "online") await requireHostOnline(hostId);
    const response = await peerClient.request(hostId, request);
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      body = null;
    }
    if (response.status !== 200) {
      const detail = (body as { error?: unknown } | null)?.error;
      throw new Error(
        typeof detail === "string" && detail
          ? detail
          : `${host.label} could not handle the note request (status ${response.status}).`,
      );
    }
    const parsed = peerGlobalNoteSchema.safeParse(body);
    if (!parsed.success) throw new Error(`${host.label} sent a note this version cannot read.`);
    return parsed.data;
  }

  function localWindowProfile(windowId: string): { profileId: string } {
    const slot = deps.getState().windowSlots.find((entry) => entry.id === windowId);
    if (!slot) throw new Error("This action is only available in a window of this desktop.");
    return { profileId: slot.profileId || "default" };
  }

  const peerWindows = (): PeerWindowSlot[] => deps.getState().peerWindows ?? [];

  function attached(hostId: string): PeerAttachedHost | null {
    const host = settings().hosts.find((entry) => entry.id === hostId);
    if (!host) return null;
    const status = peerClient.getHostStatus(hostId);
    return {
      ...host,
      state: status.state,
      hostAppVersion: status.hostAppVersion,
      localAppVersion: deps.appVersion,
      profiles: status.profiles,
      checkedAt: status.checkedAt,
    };
  }

  function boundWindow(windowId: string): PeerWindowSlot {
    const slot = peerWindows().find((entry) => entry.id === windowId);
    if (!slot) throw new Error(PEER_WINDOW_NOT_ATTACHED);
    return slot;
  }

  function getHostState(): PeerHostState {
    const current = settings();
    return {
      hosting: { ...current.hosting },
      instanceId: current.instanceId,
      hostName: peerHostName(),
      encryptionAvailable: deps.credentials.isEncryptionAvailable(),
      listener: { ...listener, addresses: [...listener.addresses] },
      devices: peerHost.listDevices(),
      pending: peerHost.listPending(),
    };
  }

  return {
    peerHost,
    peerClient,
    getHostState,

    listHosts(): PeerAttachedHost[] {
      return settings()
        .hosts.map((host) => attached(host.id))
        .filter((host): host is PeerAttachedHost => host !== null);
    },

    async refreshHost(hostId: string, options?: { force?: boolean }): Promise<PeerAttachedHost | null> {
      if (!settings().hosts.some((host) => host.id === hostId)) return null;
      await peerClient.refreshHost(hostId, options);
      return attached(hostId);
    },

    startPairing: (target: { address: string; port: number }) => peerClient.startPairing(target),

    cancelPairing: (attemptId: string): void => peerClient.cancelPairing(attemptId),

    /** Normalization drops the host's windows with it; the event tells main which of them to close. */
    async removeHost(hostId: string): Promise<boolean> {
      const windowIds = peerWindows()
        .filter((slot) => slot.hostId === hostId)
        .map((slot) => slot.id);
      const removed = await peerClient.removeHost(hostId);
      if (removed) {
        attentionPoller.forget(hostId);
        deps.emit(PEER_HOST_REMOVED_EVENT, { hostId, windowIds });
      }
      return removed;
    },

    updateHostAddress: (target: { hostId: string; address: string; port: number }): Promise<boolean> =>
      peerClient.updateHostAddress(target.hostId, { address: target.address, port: target.port }),

    renameHost: (input: { hostId: string; label: string }): Promise<boolean> =>
      peerClient.renameHost(input.hostId, input.label),

    getWindowBackend(windowId: string): WindowBackend {
      const slot = peerWindows().find((entry) => entry.id === windowId);
      if (!slot) return { kind: "local" };
      const host = settings().hosts.find((entry) => entry.id === slot.hostId);
      return {
        kind: "peer",
        hostId: slot.hostId,
        hostLabel: host?.label ?? slot.hostId,
        remoteProfileId: slot.remoteProfileId,
        clientId: peerWindowClientId(settings().instanceId, slot.id),
        terminalFontSize: deps.getState().settings.terminalFontSizeLocal,
      };
    },

    requireHostOnline,

    /** Points an existing peer window at another host and profile; id and geometry stay. */
    async retargetPeerWindow(windowId: string, target: { hostId: string; profileId: string }): Promise<PeerWindowSlot> {
      boundWindow(windowId);
      if (!settings().hosts.some((host) => host.id === target.hostId)) throw new Error("This desktop is not attached.");
      await deps.mutate("peers:window-retarget", (draft) => {
        const slot = (draft.peerWindows ?? []).find((entry) => entry.id === windowId);
        if (!slot) return;
        slot.hostId = target.hostId;
        slot.remoteProfileId = target.profileId;
      });
      return boundWindow(windowId);
    },

    async setTerminalFontSize(size: number): Promise<void> {
      await deps.mutate("peers:font-size", (draft) => {
        draft.settings.terminalFontSizeLocal = size;
      });
    },

    isPeerWindow: (windowId: string): boolean => peerWindows().some((entry) => entry.id === windowId),

    getLocalProfilesOverview(): LocalProfileOverview[] {
      const state = deps.getState();
      const counts = countWorkspacesByProfile(state);
      return state.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        color: profile.color,
        workspaceCount: counts.get(profile.id) ?? 0,
        openWindows: state.windowSlots.filter((slot) => slot.profileId === profile.id).length,
      }));
    },

    async createPeerWindowSlot(input: {
      hostId: string;
      profileId: string;
      cloneFromWindowId?: string;
    }): Promise<PeerWindowSlot> {
      await peerClient.ensureInstanceId();
      if (!settings().hosts.some((host) => host.id === input.hostId)) {
        throw new Error("This desktop is not attached.");
      }
      const state = deps.getState();
      const source = input.cloneFromWindowId
        ? peerWindows().find(
            (slot) =>
              slot.id === input.cloneFromWindowId &&
              slot.hostId === input.hostId &&
              slot.remoteProfileId === input.profileId,
          )
        : undefined;
      const cascade = CASCADE_ORIGIN + (state.windowSlots.length + peerWindows().length) * CASCADE_STEP;
      const bounds: WindowSlotBounds = source
        ? { ...source.bounds, x: source.bounds.x + CASCADE_STEP, y: source.bounds.y + CASCADE_STEP }
        : { x: cascade, y: cascade, width: 1280, height: 800 };
      const slot: PeerWindowSlot = {
        id: randomUUID(),
        hostId: input.hostId,
        remoteProfileId: input.profileId,
        bounds,
        lastFocusedAt: Date.now(),
      };
      await deps.mutate("peers:window-created", (draft) => {
        draft.peerWindows = [...(draft.peerWindows ?? []), slot];
      });
      return slot;
    },

    async removePeerWindowSlot(windowId: string): Promise<void> {
      await deps.mutate("peers:window-removed", (draft) => {
        draft.peerWindows = (draft.peerWindows ?? []).filter((slot) => slot.id !== windowId);
      });
    },

    async updatePeerWindowSlotBounds(windowId: string, bounds: WindowSlotBounds, displayId?: number): Promise<void> {
      await deps.mutate("peers:window-bounds", (draft) => {
        const slot = (draft.peerWindows ?? []).find((entry) => entry.id === windowId);
        if (!slot) return;
        slot.bounds = bounds;
        if (displayId !== undefined) slot.displayId = displayId;
      });
    },

    async setPeerWindowProfile(windowId: string, profileId: string): Promise<void> {
      boundWindow(windowId);
      await deps.mutate("peers:window-profile", (draft) => {
        const slot = (draft.peerWindows ?? []).find((entry) => entry.id === windowId);
        if (slot) slot.remoteProfileId = profileId;
      });
    },

    /** The host and client id come from the window's binding; whatever the renderer sent for either is replaced. */
    async peerWindowRequest(windowId: string, request: PeerRequest) {
      const slot = boundWindow(windowId);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (name.toLowerCase() !== CLIENT_ID_HEADER) headers[name] = value;
      }
      headers[CLIENT_ID_HEADER] = peerWindowClientId(settings().instanceId, slot.id);
      return peerClient.request(slot.hostId, {
        ...request,
        pathname: withBoundProfile(request.pathname, slot.remoteProfileId),
        headers,
      });
    },

    peerWindowOpenSocket(windowId: string, query: Record<string, string>) {
      const slot = boundWindow(windowId);
      const forced: Record<string, string> = {};
      for (const [name, value] of Object.entries(query)) {
        const lower = name.toLowerCase();
        if (lower !== "clientid" && lower !== "profileid") forced[name] = value;
      }
      forced.clientId = peerWindowClientId(settings().instanceId, slot.id);
      forced.profileId = slot.remoteProfileId;
      return peerClient.openSocket(slot.hostId, forced);
    },

    dispose(): void {
      attachmentCopies.dispose();
      attentionPoller.stop();
      peerClient.dispose();
    },

    async start(): Promise<void> {
      attentionPoller.start();
      if (!settings().hosting.enabled) return;
      try {
        await peerHost.ensureIdentity();
      } catch (error) {
        log.warn("peer identity is unavailable; the peer listener has no keys", {
          err: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async setHosting(input: PeerHostingSettings): Promise<PeerHostState> {
      const current = settings().hosting;
      if (current.enabled === input.enabled && current.port === input.port) return getHostState();
      if (input.enabled) await peerHost.ensureIdentity();
      await deps.mutate("peers:hosting", (draft) => {
        draft.settings.integrations.peers.hosting = { enabled: input.enabled, port: input.port };
      });
      log.info("peer hosting changed", { enabled: input.enabled, port: input.port });
      deps.emit(PEER_HOSTING_CHANGED_EVENT, { enabled: input.enabled, port: input.port });
      return getHostState();
    },

    approvePairing(input: { pairingId: string; code: string }): Promise<PeerApproveResult> {
      return peerHost.approvePairing(input.pairingId, input.code);
    },

    rejectPairing: (pairingId: string): boolean => peerHost.rejectPairing(pairingId),

    removeDevice: (deviceId: string): Promise<boolean> => peerHost.removeDevice(deviceId),

    renameDevice: (input: { deviceId: string; name: string }): Promise<boolean> =>
      peerHost.renameDevice(input.deviceId, input.name),

    hello(): PeerHello {
      const state = deps.getState();
      const counts = countWorkspacesByProfile(state);
      return {
        protocolVersion: PEER_PROTOCOL_VERSION,
        hostInstanceId: settings().instanceId,
        hostName: peerHostName(),
        appVersion: deps.appVersion,
        profiles: state.profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          color: profile.color,
          workspaceCount: counts.get(profile.id) ?? 0,
        })),
      };
    },

    /** Alert counts per profile of this desktop, for an attached desktop's badge. Counts only. */
    attention(): PeerAttentionSummary {
      const payload = deps.getAttentionPayload?.() ?? {};
      const profiles = deps
        .getState()
        .profiles.map((profile) => ({
          profileId: profile.id,
          count: summarizeAttentionForProfile(payload, profile.id).count,
        }))
        .filter((profile) => profile.count > 0);
      return {
        total: profiles.reduce((sum, profile) => sum + profile.count, 0),
        profiles,
        globalNoteRevision: deps.getInstallationNoteRevision?.() ?? 0,
      };
    },

    listDirectories: (requested: string) => listPeerDirectories(requested),

    /** Host side: recent attachments of every profile, for a paired desktop. */
    listAttachments: (): Promise<PeerAttachmentList> => attachmentsHost.list(),
    readAttachment: (request: AttachmentReadRequest) => attachmentsHost.read(request),

    /** Device side: what a paired host holds. The renderer names the host; the path is fixed here. */
    async listHostAttachments(hostId: string): Promise<PeerAttachmentList> {
      const host = attached(hostId);
      if (!host) throw new Error("This desktop is not attached.");
      if (host.state !== "online") await requireHostOnline(hostId);
      const response = await peerClient.request(hostId, { method: "GET", pathname: "/api/peer/attachments" });
      if (response.status !== 200)
        throw new Error(`${host.label} could not list its attachments (status ${response.status}).`);
      let body: unknown;
      try {
        body = JSON.parse(response.body);
      } catch {
        body = null;
      }
      const envelope = peerAttachmentListEnvelopeSchema.safeParse(body);
      if (!envelope.success) throw new Error(`${host.label} sent a list this version cannot read.`);
      const items: PeerAttachmentItem[] = [];
      for (const raw of envelope.data.items) {
        const item = peerAttachmentItemSchema.safeParse(raw);
        if (item.success) items.push(item.data);
      }
      const dropped = envelope.data.items.length - items.length;
      if (dropped > 0) log.warn("peer attachment list dropped items it cannot read", { hostId, dropped });
      return { items, truncated: envelope.data.truncated };
    },

    /** Device side: a paired host's global note. The renderer names the host; the path is fixed here. */
    getHostGlobalNote: (hostId: string): Promise<InstallationNote> =>
      hostGlobalNoteCall(hostId, { method: "GET", pathname: PEER_GLOBAL_NOTE_ROUTE }),
    saveHostGlobalNote: (hostId: string, input: SaveInstallationNote): Promise<InstallationNote> =>
      hostGlobalNoteCall(hostId, {
        method: "POST",
        pathname: PEER_GLOBAL_NOTE_SAVE_ROUTE,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    undoHostGlobalNote: (hostId: string, input: UndoInstallationNote): Promise<InstallationNote> =>
      hostGlobalNoteCall(hostId, {
        method: "POST",
        pathname: PEER_GLOBAL_NOTE_UNDO_ROUTE,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),

    startAttachmentCopy: async (request: PeerAttachmentCopyRequest, windowId: string) =>
      attachmentCopies.start(request, localWindowProfile(windowId)),

    cancelAttachmentCopy: (copyId: string, windowId: string) =>
      attachmentCopies.cancel(copyId, localWindowProfile(windowId)),

    getAttachmentCopiesPayload: () => attachmentCopies.getPayload(),

    getPeerHostAttention(): PeerHostAttention[] {
      return attentionPoller.getAll();
    },

    setListenerInfo(info: PeerListenerInfo): void {
      const next = { ...info, addresses: [...info.addresses] };
      if (JSON.stringify(next) === JSON.stringify(listener)) return;
      listener = next;
      deps.emit("peers:updated", {});
    },
  };
}

import { hkdfSync, randomUUID } from "node:crypto";
import { openEnvelope, sealEnvelope } from "./mobile-crypto.js";
import type { MobileWorkspaceRow } from "./mobile-workspace-projection.js";
import type { RelayReason } from "./mobile-relay-protocol.js";
import { isRelayId } from "./mobile-relay-protocol.js";
import { getLogger } from "../logger.js";

const log = getLogger("mobile-system-channel");

const MAX_PART_BYTES = 32 * 1024;
const MAX_PHONE_CIPHERTEXT_BYTES = MAX_PART_BYTES + 28;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_PARTS = 256;
const HISTORY_BATCHES = 64;
const HISTORY_BYTES = 8 * 1024 * 1024;
const HISTORY_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_TRACKED_PROFILES = 16;
const RETAIN_MS = 5 * 60_000;
const ACK_TIMEOUT_MS = 30_000;

function safeRef(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export interface SystemChannelDevice {
  deviceId: string;
  pairId: string;
  sessionKey: Buffer;
  capabilities: readonly string[];
  profileAllowlist: string[];
}

/** The catalogue is what `profile.catalog.get` guards with `status.read`; without that grant a device
 * may read no profile here either, so the native channel cannot widen a notifications-only pairing. */
function canReadCatalog(device: SystemChannelDevice): boolean {
  return device.capabilities.includes("status.read");
}

function readableProfiles(device: SystemChannelDevice): Set<string> {
  return canReadCatalog(device) ? new Set(device.profileAllowlist) : new Set();
}

/** HKDF-SHA-256 salt/info that separate the system channel's AEAD key from the pairing session key
 * (ADR 0037). Mirrored by the mobile client and pinned by `test-fixtures/system-channel.json`. */
export const SYSTEM_CHANNEL_KEY_SALT = "strideterm-system-channel";
export const SYSTEM_CHANNEL_KEY_INFO = "aes-256-gcm/v1";

/** The system channel never seals with the session key itself, which also protects RTDB envelopes. */
export function deriveSystemChannelKey(sessionKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      sessionKey,
      Buffer.from(SYSTEM_CHANNEL_KEY_SALT, "utf8"),
      Buffer.from(SYSTEM_CHANNEL_KEY_INFO, "utf8"),
      32,
    ),
  );
}

export interface SystemCatalogSource {
  getRows(profileId: string): MobileWorkspaceRow[] | null;
  subscribe(listener: () => void): () => void;
}

export interface SystemChannelConnection {
  receive(sequence: number, ciphertext: Buffer): void;
  close(reason: RelayReason): void;
}

export interface MobileSystemChannelOptions {
  resolveDevice(deviceId: string): SystemChannelDevice | null;
  source: SystemCatalogSource;
  now?: () => number;
}

interface CatalogBatch {
  v: 1;
  type: "catalog.batch";
  profileId: string;
  epoch: string;
  baseRevision: number;
  revision: number;
  batchId: string;
  part: number;
  parts: number;
  mode: "snapshot" | "delta";
  changes: Array<{ id: string; set: Record<string, unknown>; unset: string[] }>;
  removed: string[];
  order?: string[];
}

interface ProfileHistory {
  epoch: string;
  rows: MobileWorkspaceRow[];
  stateBytes: number;
  revision: number;
  expiresAt: number;
  history: CatalogBatch[][];
  bytes: number;
}

interface ConnectionState {
  id: string;
  deviceId: string;
  pairId: string;
  /** The pairing session key, kept only to notice a re-key or a re-pair; never used to seal. */
  key: Buffer;
  channelKey: Buffer;
  allowlist: Set<string>;
  inSequence: number;
  outSequence: number;
  profileId: string | null;
  waitingForAck: number | null;
  inflightBatch: CatalogBatch[] | null;
  sentParts: number;
  acknowledgedParts: number;
  inflightRows: MobileWorkspaceRow[] | null;
  pendingRows: { rows: MobileWorkspaceRow[]; revision: number } | null;
  ackTimer: ReturnType<typeof setTimeout> | null;
  queue: Array<{ batch: CatalogBatch[]; rows: MobileWorkspaceRow[] | null }>;
  rejectedAck: {
    profileId: string;
    epoch: string;
    revision: number;
    batchId: string;
    parts: number;
    sentParts: number;
    acknowledgedParts: number;
  } | null;
  closed: boolean;
  send: (sequence: number, ciphertext: Buffer) => boolean;
  close: (reason: RelayReason) => void;
}

export function buildSystemChannelAad(input: {
  connectionId: string;
  pairId: string;
  deviceId: string;
  sequence: number;
  direction: "phone-to-desktop" | "desktop-to-phone";
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      channel: "strideterm-system",
      connectionId: input.connectionId,
      pairId: input.pairId,
      deviceId: input.deviceId,
      sequence: input.sequence,
      direction: input.direction,
    }),
    "utf8",
  );
}

export function createMobileSystemChannel(options: MobileSystemChannelOptions) {
  const now = options.now ?? Date.now;
  const profiles = new Map<string, ProfileHistory>();
  const connections = new Map<string, ConnectionState>();
  let unsubscribeSource: (() => void) | null = null;
  let pruneTimer: ReturnType<typeof setTimeout> | null = null;
  const counters = { opened: 0, closed: 0, batches: 0, batchBytes: 0, ackTimeouts: 0, coalesced: 0 };

  function ensureSourceSubscription(): void {
    if (!unsubscribeSource) unsubscribeSource = options.source.subscribe(sourceChanged);
  }

  function stopSourceIfIdle(): void {
    if (![...connections.values()].some((connection) => connection.profileId !== null) && unsubscribeSource) {
      unsubscribeSource();
      unsubscribeSource = null;
    }
  }

  function detachProfile(connection: ConnectionState): void {
    if (connection.profileId) {
      const profile = profiles.get(connection.profileId);
      if (profile) profile.expiresAt = now() + RETAIN_MS;
    }
    connection.profileId = null;
    connection.waitingForAck = null;
    if (connection.ackTimer) clearTimeout(connection.ackTimer);
    connection.ackTimer = null;
    connection.inflightRows = null;
    connection.inflightBatch = null;
    connection.sentParts = 0;
    connection.acknowledgedParts = 0;
    connection.pendingRows = null;
    connection.queue = [];
    stopSourceIfIdle();
    pruneExpired();
  }

  function rejectProfileTopic(
    connection: ConnectionState,
    profileId: string,
    code: "permission-denied" | "too-large",
  ): void {
    const rejected = connection.inflightBatch?.[0];
    if (rejected?.profileId === profileId) {
      connection.rejectedAck = {
        profileId,
        epoch: rejected.epoch,
        revision: rejected.revision,
        batchId: rejected.batchId,
        parts: rejected.parts,
        sentParts: connection.sentParts,
        acknowledgedParts: connection.acknowledgedParts,
      };
    }
    send(connection, { v: 1, type: "catalog.error", profileId, code });
    if (connection.profileId === profileId) detachProfile(connection);
  }

  function denyProfile(connection: ConnectionState, profileId: string): void {
    rejectProfileTopic(connection, profileId, "permission-denied");
  }

  function refuseProfile(profileId: string, removeHistory = false): void {
    if (removeHistory) profiles.delete(profileId);
    for (const connection of connections.values()) {
      if (connection.profileId === profileId) {
        rejectProfileTopic(connection, profileId, "too-large");
      }
    }
  }

  function evictInactiveProfile(): boolean {
    const active = new Set(
      [...connections.values()].flatMap((connection) => (connection.profileId ? [connection.profileId] : [])),
    );
    const oldest = [...profiles.entries()]
      .filter(([profileId]) => !active.has(profileId))
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (!oldest) return false;
    profiles.delete(oldest[0]);
    return true;
  }

  function pruneExpired(): void {
    if (pruneTimer) clearTimeout(pruneTimer);
    pruneTimer = null;
    const time = now();
    for (const [profileId, profile] of profiles) {
      if (
        profile.expiresAt <= time &&
        ![...connections.values()].some((connection) => connection.profileId === profileId)
      ) {
        profiles.delete(profileId);
      }
    }
    if (profiles.size === 0 && unsubscribeSource) {
      unsubscribeSource();
      unsubscribeSource = null;
    }
    const activeProfiles = new Set(
      [...connections.values()].flatMap((connection) => (connection.profileId ? [connection.profileId] : [])),
    );
    const idleProfiles = [...profiles.entries()]
      .filter(([profileId]) => !activeProfiles.has(profileId))
      .map(([, profile]) => profile);
    if (idleProfiles.length > 0) {
      const nextExpiry = Math.min(...idleProfiles.map((profile) => profile.expiresAt));
      pruneTimer = setTimeout(pruneExpired, Math.max(1, nextExpiry - time));
      pruneTimer.unref?.();
    }
  }

  function project(profileId: string): MobileWorkspaceRow[] | null {
    const rows = options.source.getRows(profileId);
    if (!rows) return null;
    return rows.map((row) => structuredClone(row));
  }

  function rowMap(rows: MobileWorkspaceRow[]): Map<string, MobileWorkspaceRow> {
    return new Map(rows.map((row) => [row.id, row]));
  }

  function jsonBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  }

  function retainedBytes(): number {
    return [...profiles.values()].reduce((sum, profile) => sum + profile.bytes + profile.stateBytes, 0);
  }

  function makeRoom(extraBytes: number, protectedProfileId?: string): boolean {
    if (retainedBytes() + extraBytes <= HISTORY_TOTAL_BYTES) return true;
    const connected = (profileId: string) =>
      [...connections.values()].some((connection) => connection.profileId === profileId);
    for (const [profileId, profile] of [...profiles.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)) {
      while (profile.history.length && retainedBytes() + extraBytes > HISTORY_TOTAL_BYTES) {
        const oldBatch = profile.history.shift()!;
        const bytes = oldBatch.reduce((sum, part) => sum + jsonBytes(part), 0);
        profile.bytes -= bytes;
      }
      if (retainedBytes() + extraBytes <= HISTORY_TOTAL_BYTES) return true;
      if (profileId !== protectedProfileId && !connected(profileId)) profiles.delete(profileId);
      if (retainedBytes() + extraBytes <= HISTORY_TOTAL_BYTES) return true;
    }
    return retainedBytes() + extraBytes <= HISTORY_TOTAL_BYTES;
  }

  function splitBatch(input: Omit<CatalogBatch, "part" | "parts">): CatalogBatch[] | null {
    const base: Record<string, unknown> = { ...input };
    delete base.changes;
    delete base.removed;
    delete base.order;
    type Chunk = Pick<CatalogBatch, "changes" | "removed" | "order">;
    const emptyChunk = (): Chunk => ({ changes: [], removed: [], ...(input.order === undefined ? {} : { order: [] }) });
    const chunks: Chunk[] = [];
    let chunk = emptyChunk();
    const fits = (candidate: Chunk) => jsonBytes({ ...base, ...candidate, part: 255, parts: 256 }) <= MAX_PART_BYTES;
    const flush = () => {
      chunks.push(chunk);
      chunk = emptyChunk();
    };
    const append = (kind: "changes" | "removed" | "order", value: unknown): boolean => {
      const candidate: Chunk = {
        ...chunk,
        [kind]: [...(chunk[kind] as unknown[]), value],
      };
      if (fits(candidate)) {
        chunk = candidate;
        return true;
      }
      if (!chunk.changes.length && !chunk.removed.length && !chunk.order?.length) return false;
      flush();
      const first: Chunk = { ...chunk, [kind]: [...(chunk[kind] as unknown[]), value] };
      if (!fits(first)) return false;
      chunk = first;
      return true;
    };
    for (const change of input.changes) if (!append("changes", change)) return null;
    for (const id of input.removed) if (!append("removed", id)) return null;
    for (const id of input.order ?? []) if (!append("order", id)) return null;
    if (chunk.changes.length || chunk.removed.length || chunk.order?.length || chunks.length === 0) chunks.push(chunk);
    if (chunks.length > MAX_BATCH_PARTS) return null;
    const parts = chunks.map(
      (part, index) => ({ ...base, ...part, part: index, parts: chunks.length }) as CatalogBatch,
    );
    if (parts.reduce((sum, part) => sum + jsonBytes(part), 0) > MAX_BATCH_BYTES) return null;
    return parts;
  }

  function makeBatch(
    profileId: string,
    profileEpoch: string,
    before: MobileWorkspaceRow[],
    after: MobileWorkspaceRow[],
    baseRevision: number,
    revision: number,
    snapshot: boolean,
  ): CatalogBatch[] | null {
    const oldRows = rowMap(before);
    const newRows = rowMap(after);
    const changes: Array<{ id: string; set: Record<string, unknown>; unset: string[] }> = [];
    const removed: string[] = [];
    for (const row of after) {
      const old = oldRows.get(row.id);
      const set: Record<string, unknown> = {};
      const unset: string[] = [];
      for (const [key, value] of Object.entries(row)) {
        if (key === "id") continue;
        if (!old || JSON.stringify(old[key]) !== JSON.stringify(value)) set[key] = value;
      }
      if (old)
        for (const key of Object.keys(old)) {
          if (key !== "id" && !(key in row)) unset.push(key);
        }
      if (snapshot || !old || Object.keys(set).length || unset.length) changes.push({ id: row.id, set, unset });
    }
    for (const row of before) if (!newRows.has(row.id)) removed.push(row.id);
    const beforeOrder = before.map((row) => row.id);
    const afterOrder = after.map((row) => row.id);
    const orderChanged = snapshot || JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder);
    return splitBatch({
      v: 1,
      type: "catalog.batch",
      profileId,
      epoch: profileEpoch,
      baseRevision,
      revision,
      batchId: randomUUID(),
      mode: snapshot ? "snapshot" : "delta",
      changes,
      removed,
      ...(orderChanged ? { order: afterOrder } : {}),
    });
  }

  function retain(profileId: string, profile: ProfileHistory, batch: CatalogBatch[]): void {
    const bytes = batch.reduce((sum, part) => sum + jsonBytes(part), 0);
    profile.history.push(batch);
    profile.bytes += bytes;
    profile.revision = batch[0]!.revision;
    while (profile.history.length > HISTORY_BATCHES || profile.bytes > HISTORY_BYTES) {
      const removed = profile.history.shift();
      if (removed) {
        profile.bytes -= removed.reduce((sum, part) => sum + jsonBytes(part), 0);
      }
    }
    profiles.set(profileId, profile);
    while (retainedBytes() > HISTORY_TOTAL_BYTES) {
      const oldest = [...profiles.entries()]
        .filter(([, candidate]) => candidate.history.length > 0)
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (!oldest) break;
      const oldBatch = oldest[1].history.shift();
      if (!oldBatch) break;
      const bytesRemoved = oldBatch.reduce((sum, part) => sum + jsonBytes(part), 0);
      oldest[1].bytes -= bytesRemoved;
    }
  }

  function send(connection: ConnectionState, value: unknown): boolean {
    if (connection.closed) return false;
    const sequence = connection.outSequence++;
    const sealed = sealEnvelope(
      Buffer.from(JSON.stringify(value), "utf8"),
      connection.channelKey,
      buildSystemChannelAad({
        connectionId: connection.id,
        pairId: connection.pairId,
        deviceId: connection.deviceId,
        sequence,
        direction: "desktop-to-phone",
      }),
    );
    const sent = connection.send(sequence, Buffer.concat([sealed.nonce, sealed.ciphertext]));
    if (!sent) connection.close("queue-overflow");
    return sent;
  }

  function startAckDeadline(connection: ConnectionState): void {
    if (connection.ackTimer) clearTimeout(connection.ackTimer);
    connection.ackTimer = setTimeout(() => {
      counters.ackTimeouts++;
      log.warn("system channel ACK deadline expired", {
        connectionRef: safeRef(connection.id),
        profileRef: connection.profileId ? safeRef(connection.profileId) : null,
        revision: connection.waitingForAck,
        acknowledgedParts: connection.acknowledgedParts,
        sentParts: connection.sentParts,
      });
      connection.close("timeout");
    }, ACK_TIMEOUT_MS);
    connection.ackTimer.unref?.();
  }

  function transmitWindow(connection: ConnectionState): void {
    const batch = connection.inflightBatch;
    if (!batch) return;
    const limit = batch.length === 1 ? 1 : Math.min(batch.length, connection.acknowledgedParts + 4);
    while (connection.sentParts < limit) {
      if (!send(connection, batch[connection.sentParts]!)) return;
      connection.sentParts++;
    }
    if (batch.length > 1 && (connection.acknowledgedParts === 0 || connection.acknowledgedParts % 16 === 0)) {
      log.debug("system channel multipart progress", {
        connectionRef: safeRef(connection.id),
        profileRef: safeRef(batch[0]!.profileId),
        revision: batch[0]!.revision,
        acknowledgedParts: connection.acknowledgedParts,
        sentParts: connection.sentParts,
        totalParts: batch.length,
      });
    }
    startAckDeadline(connection);
  }

  function startBatch(connection: ConnectionState, batch: CatalogBatch[], rows: MobileWorkspaceRow[] | null): void {
    connection.waitingForAck = batch[0]!.revision;
    connection.inflightRows = rows;
    connection.inflightBatch = batch;
    connection.sentParts = 0;
    connection.acknowledgedParts = 0;
    const bytes = batch.reduce((sum, part) => sum + jsonBytes(part), 0);
    counters.batches++;
    counters.batchBytes += bytes;
    log.info("system channel catalog batch", {
      connectionRef: safeRef(connection.id),
      profileRef: safeRef(batch[0]!.profileId),
      mode: batch[0]!.mode,
      baseRevision: batch[0]!.baseRevision,
      revision: batch[0]!.revision,
      changes: batch.reduce((sum, part) => sum + part.changes.length, 0),
      removed: batch.reduce((sum, part) => sum + part.removed.length, 0),
      parts: batch.length,
      bytes,
    });
    transmitWindow(connection);
  }

  function sendBatch(connection: ConnectionState, batch: CatalogBatch[], rows?: MobileWorkspaceRow[] | null): void {
    if (connection.waitingForAck !== null || connection.closed) {
      connection.queue.push({ batch, rows: rows ?? null });
      return;
    }
    startBatch(connection, batch, rows ?? null);
  }

  function sendNext(connection: ConnectionState): void {
    if (connection.waitingForAck !== null || connection.queue.length === 0) return;
    const next = connection.queue.shift()!;
    startBatch(connection, next.batch, next.rows);
  }

  function sourceChanged(): void {
    pruneExpired();
    for (const connection of connections.values()) {
      const current = options.resolveDevice(connection.deviceId);
      if (!current || current.pairId !== connection.pairId || !current.sessionKey.equals(connection.key)) {
        connection.close("revoked");
        continue;
      }
      connection.allowlist = readableProfiles(current);
      if (connection.profileId && !connection.allowlist.has(connection.profileId)) {
        log.warn("system channel profile permission revoked", {
          connectionRef: safeRef(connection.id),
          deviceRef: safeRef(connection.deviceId),
          profileRef: safeRef(connection.profileId),
        });
        denyProfile(connection, connection.profileId);
      }
    }
    stopSourceIfIdle();
    pruneExpired();
    for (const [profileId, profile] of profiles) {
      const interested = [...connections.values()].some((connection) => connection.profileId === profileId);
      if (!interested) continue;
      const projected = project(profileId);
      if (!projected) {
        for (const connection of connections.values()) {
          if (connection.profileId === profileId) denyProfile(connection, profileId);
        }
        continue;
      }
      const next = projected;
      const nextStateBytes = jsonBytes(next);
      if (!makeRoom(nextStateBytes - profile.stateBytes, profileId)) {
        log.warn("system channel catalog exceeded retained-memory limit", {
          profileRef: safeRef(profileId),
          rows: next.length,
          bytes: nextStateBytes,
        });
        refuseProfile(profileId, true);
        continue;
      }
      const candidate = makeBatch(
        profileId,
        profile.epoch,
        profile.rows,
        next,
        profile.revision,
        profile.revision + 1,
        false,
      );
      if (!candidate) {
        refuseProfile(profileId, true);
        continue;
      }
      if (
        candidate.length === 1 &&
        candidate[0]!.changes.length === 0 &&
        candidate[0]!.removed.length === 0 &&
        !candidate[0]!.order
      )
        continue;
      profile.rows = next;
      profile.stateBytes = nextStateBytes;
      retain(profileId, profile, candidate);
      for (const connection of connections.values()) {
        if (connection.profileId !== profileId) continue;
        if (connection.waitingForAck !== null) {
          counters.coalesced++;
          log.debug("system channel update coalesced behind ACK", {
            connectionRef: safeRef(connection.id),
            profileRef: safeRef(profileId),
            waitingRevision: connection.waitingForAck,
            latestRevision: profile.revision,
          });
          connection.pendingRows = { rows: next, revision: profile.revision };
          connection.queue = [];
        } else sendBatch(connection, candidate, next);
      }
    }
  }

  function subscribe(
    connection: ConnectionState,
    profileId: string,
    cursorEpoch?: string,
    cursorRevision?: number,
  ): void {
    if (connection.profileId) detachProfile(connection);
    if (!connection.allowlist.has(profileId)) {
      log.warn("system channel subscription rejected by profile allowlist", {
        connectionRef: safeRef(connection.id),
        deviceRef: safeRef(connection.deviceId),
        profileRef: safeRef(profileId),
      });
      denyProfile(connection, profileId);
      return;
    }
    const rows = project(profileId);
    if (!rows) {
      denyProfile(connection, profileId);
      return;
    }
    const rowsBytes = jsonBytes(rows);
    if (!profiles.has(profileId) && profiles.size >= MAX_TRACKED_PROFILES) {
      pruneExpired();
      while (profiles.size >= MAX_TRACKED_PROFILES) {
        if (!evictInactiveProfile()) break;
      }
      if (profiles.size >= MAX_TRACKED_PROFILES) {
        send(connection, { v: 1, type: "catalog.error", profileId, code: "too-large" });
        return;
      }
    }
    const oldProfile = profiles.get(profileId);
    if (!makeRoom(rowsBytes - (oldProfile?.stateBytes ?? 0), profileId)) {
      if (oldProfile) refuseProfile(profileId, true);
      send(connection, { v: 1, type: "catalog.error", profileId, code: "too-large" });
      return;
    }
    ensureSourceSubscription();
    connection.profileId = profileId;
    log.info("system channel subscribed", {
      connectionRef: safeRef(connection.id),
      profileRef: safeRef(profileId),
      cursorEpochMatches: cursorEpoch === profiles.get(profileId)?.epoch,
      cursorRevision: Number.isSafeInteger(cursorRevision) ? cursorRevision : null,
    });
    let profile = profiles.get(profileId);
    if (!profile) {
      profile = {
        epoch: randomUUID(),
        rows,
        stateBytes: rowsBytes,
        revision: 0,
        expiresAt: now() + RETAIN_MS,
        history: [],
        bytes: 0,
      };
      profiles.set(profileId, profile);
    }
    if (profile.revision === 0) {
      const snapshot = makeBatch(profileId, profile.epoch, [], rows, 0, 1, true);
      if (!snapshot) {
        refuseProfile(profileId, true);
        return;
      }
      profile.rows = rows;
      retain(profileId, profile, snapshot);
    } else if (JSON.stringify(profile.rows) !== JSON.stringify(rows)) {
      const delta = makeBatch(
        profileId,
        profile.epoch,
        profile.rows,
        rows,
        profile.revision,
        profile.revision + 1,
        false,
      );
      if (delta && makeRoom(rowsBytes - profile.stateBytes, profileId)) {
        profile.rows = rows;
        profile.stateBytes = rowsBytes;
        retain(profileId, profile, delta);
      } else {
        refuseProfile(profileId, true);
        return;
      }
    }
    profile.expiresAt = now() + RETAIN_MS;
    pruneExpired();
    const cursor = cursorEpoch === profile.epoch && Number.isSafeInteger(cursorRevision) ? cursorRevision! : -1;
    const history = profile.history;
    const canResume =
      cursor === profile.revision ||
      (cursor >= 0 &&
        cursor < profile.revision &&
        history.length > 0 &&
        history[history.length - 1]![0]!.revision === profile.revision &&
        history.find((batch) => batch[0]!.revision > cursor)?.[0]?.baseRevision === cursor);
    if (cursor === profile.revision && cursorEpoch === profile.epoch) {
      log.debug("system channel cursor already current", {
        connectionRef: safeRef(connection.id),
        profileRef: safeRef(profileId),
        revision: profile.revision,
      });
      send(connection, { v: 1, type: "catalog.synced", profileId, epoch: profile.epoch, revision: profile.revision });
    } else if (canResume && cursor < profile.revision) {
      for (const batch of history) if (batch[0]!.revision > cursor) sendBatch(connection, batch);
    } else if (cursor !== profile.revision) {
      const snapshot = makeBatch(profileId, profile.epoch, [], profile.rows, 0, profile.revision, true);
      if (snapshot) sendBatch(connection, snapshot, profile.rows);
    }
  }

  function handleMessage(connection: ConnectionState, plaintext: Buffer): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        connection.close("protocol-error");
        return;
      }
      message = parsed as Record<string, unknown>;
    } catch {
      connection.close("protocol-error");
      return;
    }
    if (!message || message.v !== 1 || typeof message.type !== "string") {
      connection.close("protocol-error");
      return;
    }
    const fresh = options.resolveDevice(connection.deviceId);
    if (!fresh || fresh.pairId !== connection.pairId || !fresh.sessionKey.equals(connection.key)) {
      connection.close("revoked");
      return;
    }
    connection.allowlist = readableProfiles(fresh);
    const hasOnlyKeys = (allowed: readonly string[]) => Object.keys(message).every((key) => allowed.includes(key));
    switch (message.type) {
      case "ping":
        if (!hasOnlyKeys(["v", "type", "id"]) || !isRelayId(message.id)) {
          connection.close("protocol-error");
          return;
        }
        log.debug("system channel liveness ping", { connectionRef: safeRef(connection.id) });
        send(connection, { v: 1, type: "pong", id: message.id });
        return;
      case "subscribe":
        if (
          !hasOnlyKeys(["v", "type", "profileId", "epoch", "revision"]) ||
          typeof message.profileId !== "string" ||
          (message.epoch !== undefined && typeof message.epoch !== "string") ||
          (message.revision !== undefined && !isSafeRevision(message.revision)) ||
          (message.epoch === undefined) !== (message.revision === undefined)
        ) {
          connection.close("protocol-error");
          return;
        }
        connection.waitingForAck = null;
        if (connection.ackTimer) clearTimeout(connection.ackTimer);
        connection.ackTimer = null;
        connection.inflightRows = null;
        connection.inflightBatch = null;
        connection.sentParts = 0;
        connection.acknowledgedParts = 0;
        connection.pendingRows = null;
        connection.queue = [];
        subscribe(
          connection,
          message.profileId,
          message.epoch as string | undefined,
          message.revision as number | undefined,
        );
        return;
      case "unsubscribe":
        if (!hasOnlyKeys(["v", "type", "profileId"]) || typeof message.profileId !== "string") {
          connection.close("protocol-error");
          return;
        }
        // A topic error may detach the subscription before a queued unsubscribe
        // reaches us. Treat that unsubscribe as an idempotent no-op, but keep
        // rejecting attempts to unsubscribe a different active topic.
        if (connection.profileId === null) return;
        if (message.profileId !== connection.profileId) {
          connection.close("protocol-error");
          return;
        }
        detachProfile(connection);
        return;
      case "ack": {
        if (
          !hasOnlyKeys(["v", "type", "profileId", "epoch", "revision"]) ||
          typeof message.profileId !== "string" ||
          typeof message.epoch !== "string" ||
          !isSafeRevision(message.revision)
        ) {
          connection.close("protocol-error");
          return;
        }
        const rejected = connection.rejectedAck;
        const currentAck =
          message.profileId === connection.profileId &&
          message.epoch === profiles.get(connection.profileId!)?.epoch &&
          message.revision === connection.waitingForAck &&
          (connection.inflightBatch?.length === 1 || connection.acknowledgedParts === connection.inflightBatch?.length);
        if (
          !currentAck &&
          rejected &&
          message.profileId === rejected.profileId &&
          message.epoch === rejected.epoch &&
          message.revision === rejected.revision &&
          (rejected.parts === 1 || rejected.acknowledgedParts === rejected.parts)
        )
          return;
        if (!currentAck) {
          connection.close("protocol-error");
          return;
        }
        const acknowledgedRevision = connection.waitingForAck;
        if (
          connection.inflightBatch &&
          connection.inflightBatch.length > 1 &&
          connection.acknowledgedParts !== connection.inflightBatch.length
        ) {
          connection.close("protocol-error");
          return;
        }
        const acknowledgedRows = connection.inflightRows;
        connection.waitingForAck = null;
        if (connection.ackTimer) clearTimeout(connection.ackTimer);
        connection.ackTimer = null;
        connection.inflightRows = null;
        connection.inflightBatch = null;
        connection.sentParts = 0;
        connection.acknowledgedParts = 0;
        if (connection.pendingRows) {
          const pending = connection.pendingRows;
          connection.pendingRows = null;
          const baseRevision = acknowledgedRows ? acknowledgedRevision! : 0;
          const combined = makeBatch(
            connection.profileId!,
            profiles.get(connection.profileId!)!.epoch,
            acknowledgedRows ?? [],
            pending.rows,
            baseRevision,
            pending.revision,
            acknowledgedRows === null,
          );
          if (!combined) {
            refuseProfile(connection.profileId!, true);
            return;
          }
          startBatch(connection, combined, pending.rows);
        } else sendNext(connection);
        return;
      }
      case "ack.part": {
        if (
          !hasOnlyKeys(["v", "type", "profileId", "epoch", "revision", "batchId", "part"]) ||
          typeof message.profileId !== "string" ||
          typeof message.epoch !== "string" ||
          !isSafeRevision(message.revision) ||
          typeof message.batchId !== "string" ||
          !Number.isSafeInteger(message.part) ||
          (message.part as number) < 0
        ) {
          connection.close("protocol-error");
          return;
        }
        const rejected = connection.rejectedAck;
        const currentAck =
          message.profileId === connection.profileId &&
          message.epoch === profiles.get(connection.profileId!)?.epoch &&
          message.revision === connection.waitingForAck &&
          message.batchId === connection.inflightBatch?.[0]?.batchId &&
          message.part === connection.acknowledgedParts &&
          (message.part as number) < connection.sentParts;
        if (
          !currentAck &&
          rejected &&
          message.profileId === rejected.profileId &&
          message.epoch === rejected.epoch &&
          message.revision === rejected.revision &&
          message.batchId === rejected.batchId &&
          message.part === rejected.acknowledgedParts &&
          (message.part as number) < rejected.sentParts
        ) {
          rejected.acknowledgedParts++;
          return;
        }
        if (!currentAck) {
          connection.close("protocol-error");
          return;
        }
        if (
          !connection.inflightBatch ||
          connection.inflightBatch.length <= 1 ||
          connection.inflightBatch[0]!.batchId !== message.batchId ||
          message.part !== connection.acknowledgedParts ||
          message.part >= connection.sentParts
        ) {
          connection.close("protocol-error");
          return;
        }
        connection.acknowledgedParts++;
        transmitWindow(connection);
        return;
      }
      default:
        return;
    }
  }

  function open(input: {
    connectionId: string;
    deviceId: string;
    send: (sequence: number, ciphertext: Buffer) => boolean;
    close: (reason: RelayReason) => void;
  }): SystemChannelConnection | null {
    pruneExpired();
    const device = options.resolveDevice(input.deviceId);
    if (!device || !canReadCatalog(device)) return null;
    const connection: ConnectionState = {
      id: input.connectionId,
      deviceId: device.deviceId,
      pairId: device.pairId,
      key: Buffer.from(device.sessionKey),
      channelKey: deriveSystemChannelKey(device.sessionKey),
      allowlist: readableProfiles(device),
      inSequence: 0,
      outSequence: 0,
      profileId: null,
      waitingForAck: null,
      inflightBatch: null,
      sentParts: 0,
      acknowledgedParts: 0,
      inflightRows: null,
      pendingRows: null,
      ackTimer: null,
      queue: [],
      rejectedAck: null,
      closed: false,
      send: input.send,
      close: (reason: RelayReason) => {
        if (connection.closed) return;
        connection.closed = true;
        const profileRef = connection.profileId ? safeRef(connection.profileId) : null;
        if (connection.profileId) {
          const profile = profiles.get(connection.profileId);
          if (profile) profile.expiresAt = now() + RETAIN_MS;
        }
        if (connection.ackTimer) clearTimeout(connection.ackTimer);
        connection.ackTimer = null;
        connection.key.fill(0);
        connection.channelKey.fill(0);
        connection.profileId = null;
        connection.queue = [];
        connection.pendingRows = null;
        connection.inflightRows = null;
        connection.inflightBatch = null;
        connections.delete(connection.id);
        stopSourceIfIdle();
        counters.closed++;
        log.info("system channel closed", {
          connectionRef: safeRef(connection.id),
          deviceRef: safeRef(connection.deviceId),
          profileRef,
          reason,
        });
        input.close(reason);
        pruneExpired();
      },
    };
    connections.set(connection.id, connection);
    counters.opened++;
    log.info("system channel opened", {
      connectionRef: safeRef(connection.id),
      deviceRef: safeRef(connection.deviceId),
    });
    return {
      receive(sequence, ciphertext) {
        if (connection.closed) return;
        const current = options.resolveDevice(connection.deviceId);
        if (!current || current.pairId !== connection.pairId || !current.sessionKey.equals(connection.key)) {
          connection.close("revoked");
          return;
        }
        connection.allowlist = readableProfiles(current);
        if (sequence !== connection.inSequence++) {
          connection.close("protocol-error");
          return;
        }
        if (ciphertext.length < 28 || ciphertext.length > MAX_PHONE_CIPHERTEXT_BYTES) {
          connection.close(ciphertext.length < 28 ? "protocol-error" : "too-large");
          return;
        }
        try {
          const plaintext = openEnvelope(
            ciphertext.subarray(12),
            ciphertext.subarray(0, 12),
            connection.channelKey,
            buildSystemChannelAad({
              connectionId: connection.id,
              pairId: connection.pairId,
              deviceId: connection.deviceId,
              sequence,
              direction: "phone-to-desktop",
            }),
          );
          handleMessage(connection, plaintext);
        } catch {
          connection.close("protocol-error");
        }
      },
      close(reason) {
        connection.close(reason);
      },
    };
  }

  function revokeDevice(deviceId: string): void {
    for (const connection of connections.values()) if (connection.deviceId === deviceId) connection.close("revoked");
  }

  return {
    open,
    revokeDevice,
    stop() {
      for (const connection of connections.values()) connection.close("shutting-down");
      unsubscribeSource?.();
      unsubscribeSource = null;
      if (pruneTimer) clearTimeout(pruneTimer);
      pruneTimer = null;
      profiles.clear();
    },
    stats: () => ({ ...counters, connections: connections.size, profiles: profiles.size }),
  };
}

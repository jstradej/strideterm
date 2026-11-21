import { peerAttentionSummarySchema, type PeerAttentionSummary, type PeerHostLinkState } from "../../shared/peers.js";
import { PEER_HOST_NOTE_CHANGED_CHANNEL, type PeerHostNoteChanged } from "../../shared/peer-host-note-events.js";
import { getLogger } from "../logger.js";
import { PeerClientError, type PeerRequest, type PeerResponse } from "./peer-client.js";

const log = getLogger("peers");

export const PEER_ATTENTION_EVENT = "peers:attention";
export const PEER_ATTENTION_ROUTE = "/api/peer/attention";
export const PEER_ATTENTION_INTERVAL_MS = 30_000;
export const PEER_ATTENTION_BACKOFF_MS = 2 * 60_000;
const FIRST_POLL_DELAY_MS = 3_000;
const TICK_MS = 5_000;
/** Version and identity problems end polling until a refresh says otherwise; the request itself would only be refused. */
const SKIPPED_STATES: ReadonlySet<PeerHostLinkState> = new Set(["not-paired", "wrong-host", "version-mismatch"]);

export interface PeerHostAttention extends Omit<PeerAttentionSummary, "globalNoteRevision"> {
  hostId: string;
  checkedAt: number;
}

export interface PeerAttentionEvent {
  hostId: string;
  total: number;
  /** Null for the first answer of a host: there is nothing to compare it with, so it is no "rise". */
  previousTotal: number | null;
  profiles: PeerAttentionSummary["profiles"];
}

export interface PeerAttentionPollerDeps {
  listHostIds(): string[];
  getHostStatus(hostId: string): { state: PeerHostLinkState; checkedAt: number };
  request(hostId: string, request: PeerRequest): Promise<PeerResponse>;
  emit(event: string, payload: PeerAttentionEvent | PeerHostNoteChanged): void;
  now?(): number;
  intervalMs?: number;
  backoffMs?: number;
  firstPollDelayMs?: number;
  tickMs?: number;
}

interface HostEntry {
  dueAt: number;
  inFlight: boolean;
  data: PeerHostAttention | null;
  /** The host cannot be asked: `data` then holds a zero placeholder so the badge does not keep the last number. */
  unknown: boolean;
  failing: boolean;
  /** The host's last known global note counter; kept across an outage so a change made meanwhile still counts. */
  noteRevision: number | null;
  /** `checkedAt` of the status at the time the host refused this desktop; polling resumes when a refresh moves it. */
  refusedAt: number | null;
  loggedKind: string;
}

/**
 * Asks every attached host, now and then, how many alerts wait there, so the badge and the OS notification of this
 * desktop do not depend on a window of that host being open. Background work: a failure is never shown, and the link
 * itself already logs why it failed.
 */
export function createPeerAttentionPoller(deps: PeerAttentionPollerDeps) {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? PEER_ATTENTION_INTERVAL_MS;
  const backoffMs = deps.backoffMs ?? PEER_ATTENTION_BACKOFF_MS;
  const firstPollDelayMs = deps.firstPollDelayMs ?? FIRST_POLL_DELAY_MS;
  const tickMs = deps.tickMs ?? TICK_MS;
  const entries = new Map<string, HostEntry>();
  let timer: NodeJS.Timeout | null = null;

  function entryFor(hostId: string): HostEntry {
    let entry = entries.get(hostId);
    if (!entry) {
      entry = {
        dueAt: now() + firstPollDelayMs,
        inFlight: false,
        data: null,
        unknown: false,
        failing: false,
        noteRevision: null,
        refusedAt: null,
        loggedKind: "",
      };
      entries.set(hostId, entry);
    }
    return entry;
  }

  function logOnce(hostId: string, entry: HostEntry, kind: string): void {
    if (entry.loggedKind === kind) return;
    entry.loggedKind = kind;
    log.warn("peer attention poll failed", { hostId, kind });
  }

  /** A fall to nothing: it never raises a notification, and the next answer counts as a first one. */
  function markUnknown(hostId: string, entry: HostEntry): void {
    if (!entry.data || entry.unknown) return;
    const previousTotal = entry.data.total;
    entry.data = { hostId, total: 0, profiles: [], checkedAt: now() };
    entry.unknown = true;
    if (previousTotal !== 0) deps.emit(PEER_ATTENTION_EVENT, { hostId, total: 0, previousTotal, profiles: [] });
  }

  function forget(hostId: string): void {
    const entry = entries.get(hostId);
    if (!entry) return;
    entries.delete(hostId);
    if (entry.data && !entry.unknown && entry.data.total !== 0) {
      deps.emit(PEER_ATTENTION_EVENT, { hostId, total: 0, previousTotal: entry.data.total, profiles: [] });
    }
  }

  function parse(response: PeerResponse): PeerAttentionSummary | string {
    if (response.status !== 200) return `status-${response.status}`;
    try {
      const parsed = peerAttentionSummarySchema.safeParse(JSON.parse(response.body));
      return parsed.success ? parsed.data : "unreadable";
    } catch {
      return "unreadable";
    }
  }

  async function poll(hostId: string, entry: HostEntry): Promise<void> {
    entry.inFlight = true;
    try {
      let outcome: PeerAttentionSummary | string;
      try {
        outcome = parse(await deps.request(hostId, { method: "GET", pathname: PEER_ATTENTION_ROUTE }));
      } catch (error) {
        const code = error instanceof PeerClientError ? error.code : "other";
        if (code === "not-paired") entry.refusedAt = deps.getHostStatus(hostId).checkedAt;
        if (!(error instanceof PeerClientError)) logOnce(hostId, entry, "request-failed");
        entry.failing = true;
        entry.dueAt = now() + backoffMs;
        markUnknown(hostId, entry);
        return;
      }
      if (typeof outcome === "string") {
        logOnce(hostId, entry, outcome);
        entry.failing = true;
        entry.dueAt = now() + backoffMs;
        markUnknown(hostId, entry);
        return;
      }
      entry.failing = false;
      entry.loggedKind = "";
      entry.dueAt = now() + intervalMs;
      const wasUnknown = entry.unknown;
      const previousTotal = wasUnknown ? null : (entry.data?.total ?? null);
      entry.unknown = false;
      entry.data = { hostId, total: outcome.total, profiles: outcome.profiles, checkedAt: now() };
      const previousNoteRevision = entry.noteRevision;
      entry.noteRevision = outcome.globalNoteRevision;
      if (previousNoteRevision !== null && previousNoteRevision !== outcome.globalNoteRevision) {
        deps.emit(PEER_HOST_NOTE_CHANGED_CHANNEL, { hostId, revision: outcome.globalNoteRevision });
      }
      if (wasUnknown || previousTotal !== outcome.total) {
        deps.emit(PEER_ATTENTION_EVENT, { hostId, total: outcome.total, previousTotal, profiles: outcome.profiles });
      }
    } finally {
      entry.inFlight = false;
    }
  }

  function tick(): void {
    const hostIds = new Set(deps.listHostIds());
    for (const known of [...entries.keys()]) {
      if (!hostIds.has(known)) forget(known);
    }
    const current = now();
    for (const hostId of hostIds) {
      const entry = entryFor(hostId);
      if (entry.inFlight || current < entry.dueAt) continue;
      const status = deps.getHostStatus(hostId);
      if (SKIPPED_STATES.has(status.state)) {
        markUnknown(hostId, entry);
        entry.dueAt = current + intervalMs;
        continue;
      }
      if (entry.refusedAt !== null) {
        if (status.checkedAt === entry.refusedAt) {
          entry.dueAt = current + intervalMs;
          continue;
        }
        entry.refusedAt = null;
      }
      void poll(hostId, entry).catch((error: unknown) => {
        log.error("peer attention poll crashed", {
          hostId,
          err: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Drops a removed host at once, so its alerts leave the badge without waiting for the next pass. */
    forget,
    /** Last answer of every host that is still attached. */
    getAll(): PeerHostAttention[] {
      const hostIds = new Set(deps.listHostIds());
      return [...entries.values()].flatMap((entry) =>
        entry.data && hostIds.has(entry.data.hostId) ? [entry.data] : [],
      );
    },
    /** Test hook: run one scheduling pass now. */
    tick,
  };
}

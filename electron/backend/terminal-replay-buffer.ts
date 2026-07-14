/**
 * Bounded per-session terminal replay store.
 *
 * Replaces the single concatenated-string buffer with a chunk ring that keeps
 * a monotonically increasing sequence number per session. The sequence lets a
 * remote client order a replay snapshot against the live frames that follow it
 * (see .Private/plan-terminal-stream-backpressure-v2.md): the client ignores
 * any live frame whose `seq <= throughSeq` as a defensive duplicate guard, and
 * a gap can never appear because the subscribe handshake snapshots the buffer
 * and starts live delivery in one synchronous step (no `await` between them).
 *
 * Eviction drops whole chunks from the head and never splits a chunk (plan v2:
 * "never split a chunk at a character offset"). A single chunk that alone
 * exceeds the whole budget is evicted entirely — leaving the store empty rather
 * than truncated — so the store is strictly bounded by `maxBytes` at all times
 * and a replay never begins partway through an ANSI escape sequence.
 */

export interface TerminalReplaySnapshot {
  /** Concatenated stored output, oldest chunk first. */
  data: string;
  /** Sequence of the newest chunk (0 when nothing has been recorded yet). */
  throughSeq: number;
}

interface ReplayChunk {
  seq: number;
  data: string;
  bytes: number;
}

interface SessionReplay {
  chunks: ReplayChunk[];
  /** Index of the oldest live chunk in `chunks`; entries before it are evicted
   *  but not yet spliced out (see the compaction note in `append`). */
  head: number;
  bytes: number;
  /** Last assigned sequence number. */
  seq: number;
}

export class TerminalReplayStore {
  private readonly sessions = new Map<string, SessionReplay>();
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(0, maxBytes || 0);
  }

  /**
   * Record a chunk and return the sequence number assigned to it. The sequence
   * is assigned even when storage is disabled (`maxBytes === 0`) or the chunk
   * is evicted immediately, so live-frame ordering stays well-defined
   * regardless of the byte budget.
   */
  append(sessionId: string, data: string): number {
    if (!sessionId) return 0;
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = { chunks: [], head: 0, bytes: 0, seq: 0 };
      this.sessions.set(sessionId, entry);
    }
    const seq = ++entry.seq;
    if (!this.maxBytes || !data) return seq;
    const bytes = Buffer.byteLength(data, "utf8");
    entry.chunks.push({ seq, data, bytes });
    entry.bytes += bytes;
    // Evict whole chunks from the head until within budget. Eviction advances a
    // head index instead of Array.shift() so a noisy session pinned at the byte
    // cap stays O(1) amortized per append rather than O(n) re-indexing the whole
    // array on every small chunk. Chunks are never split: a lone chunk that
    // alone exceeds the budget is evicted entirely (leaving the store empty)
    // rather than truncated, so a replay never begins partway through an ANSI
    // escape sequence. The seq counter still advances.
    while (entry.head < entry.chunks.length && entry.bytes > this.maxBytes) {
      entry.bytes -= entry.chunks[entry.head].bytes;
      entry.head++;
    }
    // Compact once the evicted prefix dominates the array so the backing store
    // can't grow without bound on a long-lived session (amortized O(1): the
    // slice runs at most once per ~live-chunk-count appends).
    if (entry.head > 0 && entry.head * 2 >= entry.chunks.length) {
      entry.chunks = entry.chunks.slice(entry.head);
      entry.head = 0;
    }
    return seq;
  }

  /** Point-in-time snapshot: all stored output plus the newest sequence. */
  snapshot(sessionId: string): TerminalReplaySnapshot {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { data: "", throughSeq: 0 };
    let data = "";
    const live = entry.head > 0 ? entry.chunks.slice(entry.head) : entry.chunks;
    for (const chunk of live) data += chunk.data;
    return { data, throughSeq: entry.seq };
  }

  /**
   * Clear stored output but KEEP the sequence counter. Used on an intentional
   * restart: the next process generation continues the counter, so a client
   * still holding an old `throughSeq` cannot mistake fresh output for a
   * duplicate.
   */
  clear(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.chunks = [];
      entry.head = 0;
      entry.bytes = 0;
    }
  }

  /** Drop everything including the counter. Used on session/panel destroy. */
  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Drop every session belonging to a workspace (workspace/profile delete). */
  deleteWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}:`;
    for (const sessionId of this.sessions.keys()) {
      if (sessionId.startsWith(prefix)) this.sessions.delete(sessionId);
    }
  }
}

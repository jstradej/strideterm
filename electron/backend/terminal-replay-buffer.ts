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

type ParserState = "ground" | "escape" | "csi" | "osc" | "string";
type MouseTrackingMode = "none" | "x10" | "vt200" | "drag" | "any";
type MouseEncoding = "default" | "sgr" | "sgr-pixels";

interface TerminalModeState {
  applicationCursorKeys: boolean;
  applicationKeypad: boolean;
  alternateBuffer: boolean;
  mouseTracking: MouseTrackingMode;
  mouseEncoding: MouseEncoding;
  sendFocus: boolean;
  bracketedPaste: boolean;
  synchronizedOutput: boolean;
}

interface ReplayBoundaryState {
  parser: ParserState;
  csi: string;
  csiOverflow: boolean;
  escape: string;
  escapeOverflow: boolean;
  modes: TerminalModeState;
}

interface SessionReplay {
  chunks: ReplayChunk[];
  /** Index of the oldest live chunk in `chunks`; entries before it are evicted
   *  but not yet spliced out (see the compaction note in `append`). */
  head: number;
  bytes: number;
  /** Last assigned sequence number. */
  seq: number;
  /** Parser and terminal modes immediately before the oldest retained chunk. */
  boundary: ReplayBoundaryState;
}

const MAX_CSI_LENGTH = 128;

function defaultModeState(): TerminalModeState {
  return {
    applicationCursorKeys: false,
    applicationKeypad: false,
    alternateBuffer: false,
    mouseTracking: "none",
    mouseEncoding: "default",
    sendFocus: false,
    bracketedPaste: false,
    synchronizedOutput: false,
  };
}

function defaultBoundaryState(): ReplayBoundaryState {
  return {
    parser: "ground",
    csi: "",
    csiOverflow: false,
    escape: "",
    escapeOverflow: false,
    modes: defaultModeState(),
  };
}

function resetModesAfterSoftReset(modes: TerminalModeState): void {
  modes.applicationCursorKeys = false;
  modes.applicationKeypad = false;
  modes.sendFocus = false;
  modes.bracketedPaste = false;
  modes.synchronizedOutput = false;
}

function resetModesAfterRis(state: ReplayBoundaryState): void {
  state.modes = defaultModeState();
}

function applyPrivateModes(state: ReplayBoundaryState, params: string, enabled: boolean): void {
  for (const token of params.split(";")) {
    if (!/^\d+$/.test(token)) continue;
    const mode = Number(token);
    switch (mode) {
      case 1:
        state.modes.applicationCursorKeys = enabled;
        break;
      case 9:
        state.modes.mouseTracking = enabled ? "x10" : "none";
        break;
      case 47:
      case 1047:
      case 1049:
        state.modes.alternateBuffer = enabled;
        break;
      case 66:
        state.modes.applicationKeypad = enabled;
        break;
      case 1000:
        state.modes.mouseTracking = enabled ? "vt200" : "none";
        break;
      case 1002:
        state.modes.mouseTracking = enabled ? "drag" : "none";
        break;
      case 1003:
        state.modes.mouseTracking = enabled ? "any" : "none";
        break;
      case 1004:
        state.modes.sendFocus = enabled;
        break;
      case 1006:
        state.modes.mouseEncoding = enabled ? "sgr" : "default";
        break;
      case 1016:
        state.modes.mouseEncoding = enabled ? "sgr-pixels" : "default";
        break;
      case 2004:
        state.modes.bracketedPaste = enabled;
        break;
      case 2026:
        state.modes.synchronizedOutput = enabled;
        break;
    }
  }
}

function applyCsi(state: ReplayBoundaryState, sequence: string): void {
  const final = sequence.at(-1) || "";
  const body = sequence.slice(0, -1);
  if (body === "!" && final === "p") {
    resetModesAfterSoftReset(state.modes);
    return;
  }
  if (
    [...body].some((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code <= 0x2f;
    })
  )
    return;
  if (body.startsWith("?") && (final === "h" || final === "l")) {
    applyPrivateModes(state, body.slice(1), final === "h");
  }
}

function feedControlState(state: ReplayBoundaryState, data: string): void {
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    const ch = data[i];

    // xterm's parser applies these transitions from every parser state.
    if (code === 0x18 || code === 0x1a) {
      state.parser = "ground";
      state.csi = "";
      state.csiOverflow = false;
      state.escape = "";
      state.escapeOverflow = false;
      continue;
    }
    if (code === 0x1b) {
      state.parser = "escape";
      state.csi = "";
      state.csiOverflow = false;
      state.escape = "\u001b";
      state.escapeOverflow = false;
      continue;
    }
    if (code >= 0x80 && code <= 0x9f) {
      state.csi = "";
      state.csiOverflow = false;
      state.escape = "";
      state.escapeOverflow = false;
      if (code === 0x9b) state.parser = "csi";
      else if (code === 0x9d) state.parser = "osc";
      else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) state.parser = "string";
      else state.parser = "ground";
      continue;
    }

    if (state.parser === "ground") {
      continue;
    }

    if (state.parser === "escape") {
      if (code < 0x20 || code === 0x7f) {
        continue;
      } else if (!state.escapeOverflow && state.escape === "\u001b" && ch === "[") {
        state.parser = "csi";
        state.csi = "";
        state.csiOverflow = false;
        state.escape = "";
      } else if (!state.escapeOverflow && state.escape === "\u001b" && ch === "]") {
        state.parser = "osc";
        state.escape = "";
      } else if (
        !state.escapeOverflow &&
        state.escape === "\u001b" &&
        (ch === "P" || ch === "X" || ch === "^" || ch === "_")
      ) {
        state.parser = "string";
        state.escape = "";
      } else if (code >= 0x20 && code <= 0x2f) {
        if (!state.escapeOverflow) {
          if (state.escape.length < MAX_CSI_LENGTH) state.escape += ch;
          else {
            state.escape = "";
            state.escapeOverflow = true;
          }
        }
      } else if (code >= 0x30 && code <= 0x7e) {
        if (!state.escapeOverflow) {
          const sequence = state.escape + ch;
          if (sequence === "\u001bc") resetModesAfterRis(state);
          else if (sequence === "\u001b=") state.modes.applicationKeypad = true;
          else if (sequence === "\u001b>") state.modes.applicationKeypad = false;
        }
        state.parser = "ground";
        state.escape = "";
        state.escapeOverflow = false;
      } else {
        state.parser = "ground";
        state.escape = "";
        state.escapeOverflow = false;
      }
      continue;
    }

    if (state.parser === "csi") {
      if (code >= 0x40 && code <= 0x7e) {
        if (!state.csiOverflow) applyCsi(state, state.csi + ch);
        state.parser = "ground";
        state.csi = "";
        state.csiOverflow = false;
      } else if (code >= 0x20 && code <= 0x3f) {
        if (!state.csiOverflow) {
          if (state.csi.length < MAX_CSI_LENGTH) state.csi += ch;
          else {
            state.csi = "";
            state.csiOverflow = true;
          }
        }
      } else if (code < 0x20) {
        continue;
      } else if (code === 0x7f) {
        continue;
      } else {
        state.parser = "ground";
        state.csi = "";
        state.csiOverflow = false;
      }
      continue;
    }

    if (state.parser === "osc" || state.parser === "string") {
      if (state.parser === "osc" && code === 0x07) {
        state.parser = "ground";
      }
      continue;
    }
  }
}

function modePreamble(modes: TerminalModeState): string {
  let data = "";
  if (modes.alternateBuffer) data += "\u001b[?1049h";
  if (modes.applicationCursorKeys) data += "\u001b[?1h";
  if (modes.applicationKeypad) data += "\u001b=";
  if (modes.mouseTracking !== "none") {
    const parameter = { x10: 9, vt200: 1000, drag: 1002, any: 1003 }[modes.mouseTracking];
    data += `\u001b[?${parameter}h`;
  }
  if (modes.mouseEncoding === "sgr") data += "\u001b[?1006h";
  else if (modes.mouseEncoding === "sgr-pixels") data += "\u001b[?1016h";
  if (modes.sendFocus) data += "\u001b[?1004h";
  if (modes.bracketedPaste) data += "\u001b[?2004h";
  if (modes.synchronizedOutput) data += "\u001b[?2026h";
  return data;
}

function parserContinuation(state: ReplayBoundaryState): string {
  switch (state.parser) {
    case "ground":
      return "";
    case "escape":
      return state.escapeOverflow ? "\u001b!" : state.escape;
    case "csi":
      // An intermediate space makes an overflowed sequence unrecognized while
      // keeping xterm in CSI state until the original suffix reaches its final.
      return state.csiOverflow ? "\u001b[ " : `\u001b[${state.csi}`;
    case "osc":
      // Use an unknown OSC number so the evicted payload cannot be replayed as
      // a title, clipboard, or other recognized OSC command.
      return "\u001b]999999;";
    case "string":
      // APC is inert in xterm and provides the same ST-terminated parser state
      // for an evicted DCS/APC/PM/SOS payload without replaying that payload.
      return "\u001b_";
  }
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
      entry = { chunks: [], head: 0, bytes: 0, seq: 0, boundary: defaultBoundaryState() };
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
    while (
      entry.head < entry.chunks.length &&
      entry.bytes + Buffer.byteLength(modePreamble(entry.boundary.modes) + parserContinuation(entry.boundary), "utf8") >
        this.maxBytes
    ) {
      const evicted = entry.chunks[entry.head];
      feedControlState(entry.boundary, evicted.data);
      entry.bytes -= evicted.bytes;
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
    const prefix = modePreamble(entry.boundary.modes) + parserContinuation(entry.boundary);
    if (Buffer.byteLength(prefix, "utf8") + entry.bytes > this.maxBytes) data = "";
    else data = prefix + data;
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
      entry.boundary = defaultBoundaryState();
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

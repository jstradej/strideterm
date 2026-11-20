import xterm from "@xterm/headless";
import { getLogger } from "./logger.js";

const log = getLogger("review-trust");

/**
 * An interactive review starts its agent in a fresh checkout the agent has never trusted, so the agent first asks
 * whether to trust the folder. That question sits in the terminal, where nobody started from a notification or a
 * phone is looking. This watches the review's terminal for it, lists it in the payload, and answers it ONLY when the
 * user presses the notification's button — re-reading the screen first, never from a stale observation.
 *
 * Only dialogs whose text was verified against the real CLI are recognised. Claude Code 2.1.x:
 *   Quick safety check: Is this a project you created or one you trust? …
 *   > No, exit
 *     Yes, I trust this folder
 * The default is "No, exit": a bare Enter exits the agent and the review prompt with it.
 */

export type TrustChoice = "yes" | "no" | null;

export interface TrustDialogMatch {
  /** The option the dialog's cursor is on now. */
  selected: TrustChoice;
}

const CLAUDE_QUESTION = /Is this a project you created or one you trust\?/u;
const CLAUDE_YES = "Yes, I trust this folder";
const CLAUDE_NO = "No, exit";
const CURSOR_MARKS = [">", "❯", "›"];

/** The option text of a line the dialog's cursor is on (`> 2. Yes, …`), else null. */
function selectedOption(line: string): string | null {
  const trimmed = line.trim();
  const mark = CURSOR_MARKS.find((candidate) => trimmed.startsWith(candidate));
  if (!mark) return null;
  return trimmed
    .slice(mark.length)
    .trim()
    .replace(/^\d+\.\s/u, "")
    .trim();
}

export function matchTrustDialog(provider: string, screen: string): TrustDialogMatch | null {
  if (provider !== "claude") return null;
  // A narrow terminal (a phone's pane) wraps the question across rows.
  const flowing = screen.replace(/\s+/gu, " ");
  if (!CLAUDE_QUESTION.test(flowing) || !flowing.includes(CLAUDE_YES)) return null;
  let selected: TrustChoice = null;
  for (const line of screen.split("\n")) {
    const option = selectedOption(line);
    if (option === CLAUDE_YES) selected = "yes";
    else if (option === CLAUDE_NO) selected = "no";
  }
  return { selected };
}

/** The rows on screen now (not the scrollback), rebuilt from the terminal's output. */
export async function renderTerminalViewport(data: string, cols: number, rows: number): Promise<string> {
  if (!data) return "";
  const terminal = new xterm.Terminal({
    cols: Math.max(2, Math.min(1000, Math.trunc(cols || 120))),
    rows: Math.max(2, Math.min(300, Math.trunc(rows || 34))),
    scrollback: 0,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => terminal.write(data, resolve));
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let index = buffer.baseY; index < buffer.baseY + terminal.rows; index++) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  } finally {
    terminal.dispose();
  }
}

export interface ReviewTrustWaiting {
  sessionId: string;
  workspaceId: string;
  profileId: string;
  provider: string;
  prKey: string;
  since: string;
}

export interface ReviewTrustWatcherDeps {
  /** The session's output so far and its size, or null once the session is gone. */
  snapshot(sessionId: string): { data: string; cols: number; rows: number } | null;
  write(sessionId: string, data: string): void;
  /** The waiting list changed: rebroadcast the payload. */
  changed(): void;
  render?: (data: string, cols: number, rows: number) => Promise<string>;
}

interface Watched extends Omit<ReviewTrustWaiting, "since"> {
  since: string | null;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  busy: boolean;
  misses: number;
}

/**
 * The agent's own UI after the trust step (Claude's banner): the folder was trusted already, nothing will ask.
 * Without it, a dialog is still awaited for APPEAR_WINDOW_MS — a sandboxed or first start can take a while.
 */
const AGENT_STARTED = /Claude Code v\d/u;
const APPEAR_WINDOW_MS = 5 * 60_000;
/** A waiting question is dropped only after this many reads in a row miss it (a redraw or resize can miss once). */
const MISSES_TO_FORGET = 3;
const POLL_MS = 1_000;
const WAITING_POLL_MS = 3_000;
const MAX_WATCH_MS = 6 * 60 * 60_000;
const SELECT_SETTLE_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ReviewTrustWatcher {
  readonly #deps: ReviewTrustWatcherDeps;
  readonly #render: (data: string, cols: number, rows: number) => Promise<string>;
  readonly #watched = new Map<string, Watched>();

  constructor(deps: ReviewTrustWatcherDeps) {
    this.#deps = deps;
    this.#render = deps.render ?? renderTerminalViewport;
  }

  watch(entry: Omit<ReviewTrustWaiting, "since">): void {
    if (!matchTrustDialogSupported(entry.provider)) return;
    this.forget(entry.sessionId);
    const watched: Watched = { ...entry, since: null, startedAt: Date.now(), timer: null, busy: false, misses: 0 };
    this.#watched.set(entry.sessionId, watched);
    this.#schedule(watched, POLL_MS);
  }

  forget(sessionId: string): void {
    const watched = this.#watched.get(sessionId);
    if (!watched) return;
    if (watched.timer) clearTimeout(watched.timer);
    this.#watched.delete(sessionId);
    if (watched.since) this.#deps.changed();
  }

  waiting(): ReviewTrustWaiting[] {
    return [...this.#watched.values()]
      .filter((item): item is Watched & { since: string } => item.since !== null)
      .map(({ sessionId, workspaceId, profileId, provider, prKey, since }) => ({
        sessionId,
        workspaceId,
        profileId,
        provider,
        prKey,
        since,
      }));
  }

  /** The waiting entry of a session, for the caller's scope check before `confirm`. */
  get(sessionId: string): ReviewTrustWaiting | null {
    return this.waiting().find((item) => item.sessionId === sessionId) ?? null;
  }

  /**
   * The user's own answer, given from the notification: select "Yes" and press Enter, each step only after the
   * screen proves the dialog is still there and the cursor is where it has to be.
   */
  async confirm(sessionId: string): Promise<void> {
    const watched = this.#watched.get(sessionId);
    if (!watched?.since) throw new Error("This review is no longer waiting for folder trust.");
    if (watched.busy) throw new Error("The folder is already being trusted.");
    watched.busy = true;
    try {
      let match = await this.#read(watched);
      // Not forgotten here: one read can catch a redraw; the poll drops the entry once it is really gone.
      if (!match) throw new Error("The agent is not showing the folder question now. Open its terminal to check.");
      if (match.selected === "no") {
        this.#deps.write(sessionId, "\x1b[B");
        await sleep(SELECT_SETTLE_MS);
        match = await this.#read(watched);
      }
      if (match?.selected !== "yes") {
        throw new Error("Could not select “Yes, I trust this folder”. Answer the question in the agent's terminal.");
      }
      this.#deps.write(sessionId, "\r");
      log.info("review folder trusted from the notification", {
        sessionId,
        workspaceId: watched.workspaceId,
        provider: watched.provider,
      });
      this.forget(sessionId);
    } finally {
      watched.busy = false;
    }
  }

  dispose(): void {
    for (const watched of this.#watched.values()) if (watched.timer) clearTimeout(watched.timer);
    this.#watched.clear();
  }

  async #read(watched: Watched): Promise<TrustDialogMatch | null> {
    return (await this.#look(watched))?.match ?? null;
  }

  async #look(watched: Watched): Promise<{ screen: string; match: TrustDialogMatch | null } | null> {
    const snapshot = this.#deps.snapshot(watched.sessionId);
    if (!snapshot) return null;
    const screen = await this.#render(snapshot.data, snapshot.cols, snapshot.rows);
    return { screen, match: matchTrustDialog(watched.provider, screen) };
  }

  #schedule(watched: Watched, delay: number): void {
    watched.timer = setTimeout(() => {
      watched.timer = null;
      void this.#poll(watched);
    }, delay);
  }

  async #poll(watched: Watched): Promise<void> {
    if (this.#watched.get(watched.sessionId) !== watched) return;
    if (watched.busy) {
      this.#schedule(watched, POLL_MS);
      return;
    }
    let look: { screen: string; match: TrustDialogMatch | null } | null = null;
    const gone = !this.#deps.snapshot(watched.sessionId);
    let failed = false;
    try {
      look = gone ? null : await this.#look(watched);
    } catch (error) {
      failed = true;
      log.warn("review trust check failed", { sessionId: watched.sessionId, error: (error as Error).message });
    }
    if (this.#watched.get(watched.sessionId) !== watched) return;
    const age = Date.now() - watched.startedAt;
    if (gone || age >= MAX_WATCH_MS) {
      this.forget(watched.sessionId);
      return;
    }
    if (look?.match) {
      watched.misses = 0;
      if (!watched.since) {
        watched.since = new Date().toISOString();
        log.info("review waits for folder trust", { sessionId: watched.sessionId, workspaceId: watched.workspaceId });
        this.#deps.changed();
      }
      this.#schedule(watched, WAITING_POLL_MS);
      return;
    }
    if (watched.since) {
      // Answered in the terminal — unless this read just caught a redraw or a resize.
      watched.misses += 1;
      if (watched.misses >= MISSES_TO_FORGET) this.forget(watched.sessionId);
      else this.#schedule(watched, POLL_MS);
      return;
    }
    // Never asked: the folder was trusted already once the agent's own UI is up.
    if ((!failed && look && AGENT_STARTED.test(look.screen)) || age >= APPEAR_WINDOW_MS) {
      this.forget(watched.sessionId);
      return;
    }
    this.#schedule(watched, POLL_MS);
  }
}

function matchTrustDialogSupported(provider: string): boolean {
  return provider === "claude";
}

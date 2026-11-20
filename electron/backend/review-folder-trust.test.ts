import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { matchTrustDialog, renderTerminalViewport, ReviewTrustWatcher } from "./review-folder-trust.js";

// Captured from Claude Code 2.1.329 started in a never-trusted folder (the path is generalised).
const CLAUDE_TRUST_SCREEN = [
  "────────────────────────────────────────────────────────────────────────",
  " Accessing workspace:",
  "",
  " C:\\reviews\\pr-42-review-0f3c",
  "",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  "",
  " Claude Code'll be able to read, edit, and execute files here.",
  "",
  " Security guide",
  "",
  " > No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
].join("\n");
const CLAUDE_TRUST_YES_SELECTED = CLAUDE_TRUST_SCREEN.replace(" > No, exit", "   No, exit").replace(
  "   Yes, I trust this folder",
  " > Yes, I trust this folder",
);
const CLAUDE_PROMPT_SCREEN = " ▐▛███▜▌   Claude Code v2.1.329\n> Review pull request 42\n● Reading the diff…";

describe("matchTrustDialog", () => {
  test("recognises Claude's trust question and which option the cursor is on", () => {
    expect(matchTrustDialog("claude", CLAUDE_TRUST_SCREEN)).toEqual({ selected: "no" });
    expect(matchTrustDialog("claude", CLAUDE_TRUST_YES_SELECTED)).toEqual({ selected: "yes" });
  });

  test("recognises the question wrapped across rows of a narrow terminal", () => {
    const narrow = CLAUDE_TRUST_SCREEN.replace(
      " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
      " Quick safety check: Is this a project you\n created or one you trust? (Like your own",
    );
    expect(matchTrustDialog("claude", narrow)).toEqual({ selected: "no" });
  });

  test("does not see a dialog in a working session, nor for an agent whose dialog was never verified", () => {
    expect(matchTrustDialog("claude", CLAUDE_PROMPT_SCREEN)).toBeNull();
    expect(matchTrustDialog("claude", "Yes, I trust this folder")).toBeNull();
    expect(matchTrustDialog("codex", CLAUDE_TRUST_SCREEN)).toBeNull();
  });
});

describe("renderTerminalViewport", () => {
  test("returns the rows on screen, not the scrollback", async () => {
    const data = `${Array.from({ length: 30 }, (_, index) => `old ${index}`).join("\r\n")}\r\n\x1b[2J\x1b[H\x1b[1m > Yes\x1b[0m`;
    const screen = await renderTerminalViewport(data, 40, 10);
    expect(screen.split("\n")).toHaveLength(10);
    expect(screen).toContain(" > Yes");
    expect(screen).not.toContain("old 0");
  });
});

describe("ReviewTrustWatcher", () => {
  let screen: string;
  let alive: boolean;
  let writes: string[];
  let changed: number;
  let watcher: ReviewTrustWatcher;
  const entry = { sessionId: "ws-1:panel-1", workspaceId: "ws-1", profileId: "p1", provider: "claude", prKey: "42" };

  beforeEach(() => {
    vi.useFakeTimers();
    screen = "";
    alive = true;
    writes = [];
    changed = 0;
    watcher = new ReviewTrustWatcher({
      snapshot: () => (alive ? { data: "x", cols: 120, rows: 40 } : null),
      write: (_sessionId, data) => {
        writes.push(data);
        // The CLI moves its cursor on Down.
        if (data === "\x1b[B" && screen === CLAUDE_TRUST_SCREEN) screen = CLAUDE_TRUST_YES_SELECTED;
      },
      changed: () => {
        changed += 1;
      },
      render: async () => screen,
    });
  });
  afterEach(() => {
    watcher.dispose();
    vi.useRealTimers();
  });

  test("lists a review whose agent asks to trust its folder, and drops it once answered in the terminal", async () => {
    screen = CLAUDE_TRUST_SCREEN;
    watcher.watch(entry);
    expect(watcher.waiting()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watcher.waiting()).toEqual([{ ...entry, since: expect.any(String) }]);
    expect(changed).toBe(1);

    screen = CLAUDE_PROMPT_SCREEN;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(watcher.waiting()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(watcher.waiting()).toEqual([]);
    expect(changed).toBe(2);
    expect(writes).toEqual([]);
  });

  test("keeps a waiting question through one read that misses it (a redraw or a resize)", async () => {
    screen = CLAUDE_TRUST_SCREEN;
    watcher.watch(entry);
    await vi.advanceTimersByTimeAsync(1_000);
    screen = "";
    await vi.advanceTimersByTimeAsync(3_000);
    screen = CLAUDE_TRUST_SCREEN;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watcher.waiting()).toHaveLength(1);
    expect(changed).toBe(1);
  });

  test("selects Yes, proves it on screen and only then presses Enter", async () => {
    screen = CLAUDE_TRUST_SCREEN;
    watcher.watch(entry);
    await vi.advanceTimersByTimeAsync(1_000);
    const confirmed = watcher.confirm(entry.sessionId);
    await vi.advanceTimersByTimeAsync(500);
    await confirmed;
    expect(writes).toEqual(["\x1b[B", "\r"]);
    expect(watcher.waiting()).toEqual([]);
  });

  test("never presses Enter when the cursor cannot be proved to be on Yes", async () => {
    const stuck = CLAUDE_TRUST_SCREEN.replace("Security guide", "Security guide ");
    screen = stuck;
    watcher.watch(entry);
    await vi.advanceTimersByTimeAsync(1_000);
    const confirmed = watcher.confirm(entry.sessionId).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(500);
    expect(((await confirmed) as Error).message).toMatch(/Could not select/u);
    expect(writes).toEqual(["\x1b[B"]);
  });

  test("does not move a cursor it cannot see: Down only from a recognised No", async () => {
    screen = CLAUDE_TRUST_SCREEN.replace(" > No, exit", "   No, exit");
    watcher.watch(entry);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(watcher.confirm(entry.sessionId)).rejects.toThrow(/Could not select/u);
    expect(writes).toEqual([]);
  });

  test("refuses when the question is gone or was never asked", async () => {
    await expect(watcher.confirm(entry.sessionId)).rejects.toThrow(/no longer waiting/u);
    screen = CLAUDE_TRUST_SCREEN;
    watcher.watch(entry);
    await vi.advanceTimersByTimeAsync(1_000);
    screen = CLAUDE_PROMPT_SCREEN;
    await expect(watcher.confirm(entry.sessionId)).rejects.toThrow(/not showing the folder question/u);
    expect(writes).toEqual([]);
  });

  test("waits out a slow start, and stops once the agent's own UI shows the folder was trusted already", async () => {
    screen = "";
    watcher.watch(entry);
    await vi.advanceTimersByTimeAsync(90_000);
    screen = CLAUDE_TRUST_SCREEN;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watcher.waiting()).toHaveLength(1);
    watcher.forget(entry.sessionId);

    screen = CLAUDE_PROMPT_SCREEN;
    watcher.watch(entry);
    await vi.advanceTimersByTimeAsync(1_000);
    screen = CLAUDE_TRUST_SCREEN;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watcher.waiting()).toEqual([]);
  });

  test("stops watching a review whose agent exited", async () => {
    screen = CLAUDE_TRUST_SCREEN;

    watcher.watch(entry);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watcher.waiting()).toHaveLength(1);
    alive = false;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(watcher.waiting()).toEqual([]);
  });

  test("ignores an agent whose trust dialog is not known", async () => {
    screen = CLAUDE_TRUST_SCREEN;
    watcher.watch({ ...entry, provider: "codex" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watcher.waiting()).toEqual([]);
  });
});

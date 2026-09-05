/**
 * A `question` — an agent blocked on a permission dialog or an elicitation —
 * is the STRONGEST input-blocking state there is. Every summary and tooltip
 * used to test `kind === "waiting"` inline, so a question fell through to the
 * "finished task" branch and the user was told "1 finished terminal task"
 * about a terminal that was waiting on them.
 */
import { describe, expect, test } from "vitest";
import { attentionTitle, tabAttentionTitle } from "./helpers.js";
import { summarizeAttention } from "./selectors.js";

describe("attentionTitle", () => {
  test("a latest question reads as needing input, not as a finished task", () => {
    expect(attentionTitle({ count: 1, alerts: [{ kind: "question", title: "claude" }] })).toBe(
      "1 terminal needs input. Latest: claude",
    );
  });

  test("waiting keeps its wording", () => {
    // The plural quirk ("2 terminal need input") is pre-existing wording, kept
    // verbatim so this test pins the kind branch rather than a copy edit.
    expect(attentionTitle({ count: 2, alerts: [{ kind: "waiting", title: "claude" }] })).toBe(
      "2 terminal need input. Latest: claude",
    );
  });

  test("a completed alert still reports a finished task", () => {
    expect(attentionTitle({ count: 1, alerts: [{ kind: "completed", title: "build", exitCode: 0 }] })).toBe(
      "1 finished terminal task. Latest: build (exit 0)",
    );
  });
});

describe("tabAttentionTitle", () => {
  test("a question says what it is — a question, not generic attention", () => {
    expect(tabAttentionTitle({ kind: "question", title: "claude" })).toBe("claude is asking a question.");
  });

  test("waiting keeps its wording", () => {
    expect(tabAttentionTitle({ kind: "waiting", title: "claude" })).toBe("claude is waiting for input.");
  });

  test("anything else falls back to generic attention", () => {
    expect(tabAttentionTitle({ kind: "completed", title: "build", exitCode: 1 })).toBe(
      "build needs attention (exit 1).",
    );
  });
});

describe("summarizeAttention", () => {
  test("a question counts toward waitingCount, which drives the high-attention badge", () => {
    const payload = {
      appState: { workspaces: [{ id: "ws-a", profileId: "default" }] },
      attention: {
        byWorkspace: {
          "ws-a": {
            alerts: [
              { kind: "question", at: "2026-09-03T10:00:00.000Z" },
              { kind: "completed", at: "2026-09-03T09:00:00.000Z" },
            ],
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(summarizeAttention(payload)).toEqual({ count: 2, waitingCount: 1 });
  });
});

import { describe, expect, test } from "vitest";
import {
  MAX_REVIEW_ACTIVITY,
  appendReviewActivity,
  buildConnectionErrorEvent,
  buildReviewActivityEvent,
  diffSignatureKeys,
  filterNewComments,
  parseAzureVoteSignature,
  parseGitHubReviewSignature,
  shouldSeedConnection,
  truncateBody,
} from "./review-activity.js";

describe("review-activity helpers", () => {
  test("truncateBody collapses whitespace and trims to the requested length", () => {
    expect(truncateBody("  hello   world  ")).toBe("hello world");
    expect(truncateBody("abcdef", 4)).toBe("abc…");
    expect(truncateBody("")).toBe("");
  });

  test("appendReviewActivity prepends and caps at MAX_REVIEW_ACTIVITY", () => {
    const prev = Array.from({ length: MAX_REVIEW_ACTIVITY }, (_, i) => ({ id: `old-${i}` }));
    const next = appendReviewActivity(prev, [{ id: "new-1" }, { id: "new-2" }]);
    expect(next).toHaveLength(MAX_REVIEW_ACTIVITY);
    expect(next[0].id).toBe("new-1");
    expect(next[1].id).toBe("new-2");
    expect(next.at(-1).id).not.toBe(prev.at(-1).id);
  });

  test("appendReviewActivity returns previous list when no new events", () => {
    const prev = [{ id: "a" }];
    expect(appendReviewActivity(prev, [])).toBe(prev);
    expect(appendReviewActivity(undefined, undefined)).toEqual([]);
  });

  test("parseAzureVoteSignature restores Map<id, 'vote:declined'>", () => {
    const sig = "r1:10:0|r2:-10:1";
    const map = parseAzureVoteSignature(sig);
    expect(map.get("r1")).toBe("10:0");
    expect(map.get("r2")).toBe("-10:1");
    expect(parseAzureVoteSignature("").size).toBe(0);
  });

  test("parseGitHubReviewSignature restores Map<login, 'state:requested'>", () => {
    const sig = "alice:approved:0|bob:pending:1";
    const map = parseGitHubReviewSignature(sig);
    expect(map.get("alice")).toBe("approved:0");
    expect(map.get("bob")).toBe("pending:1");
  });

  test("diffSignatureKeys returns changed keys and excludes selfKey", () => {
    const prev = new Map([
      ["me", "pending:1"],
      ["bob", "pending:1"],
      ["carol", "approved:0"],
    ]);
    const curr = new Map([
      ["me", "approved:0"], // self changed — should be excluded
      ["bob", "approved:0"], // changed
      ["carol", "approved:0"], // unchanged
      ["dan", "pending:1"], // added
    ]);
    const diff = diffSignatureKeys(prev, curr, "me");
    expect(diff.sort()).toEqual(["bob", "dan"]);
  });

  test("diffSignatureKeys notices removed reviewers", () => {
    const prev = new Map([["gone", "approved:0"]]);
    const curr = new Map();
    expect(diffSignatureKeys(prev, curr, "")).toEqual(["gone"]);
  });

  test("shouldSeedConnection is true until the Set records the connection", () => {
    const set = new Set();
    expect(shouldSeedConnection(set, "conn-1")).toBe(true);
    set.add("conn-1");
    expect(shouldSeedConnection(set, "conn-1")).toBe(false);
    expect(shouldSeedConnection(set, "conn-2")).toBe(true);
  });

  test("filterNewComments keeps only non-self comments strictly newer than the cutoff", () => {
    const comments = [
      { author: { login: "alice" }, at: "2026-03-17T09:00:00.000Z", body: "old" },
      { author: { login: "me" }, at: "2026-03-17T10:00:00.000Z", body: "self" },
      { author: { login: "bob" }, at: "2026-03-17T10:05:00.000Z", body: "reply" },
    ];
    const result = filterNewComments({
      comments,
      sinceIsoString: "2026-03-17T09:30:00.000Z",
      isSelf: (a) => a?.login === "me",
      getTimestamp: (c) => c.at,
      getAuthor: (c) => c.author,
    });
    expect(result.map((c) => c.body)).toEqual(["reply"]);
  });

  describe("buildConnectionErrorEvent", () => {
    const connection = { id: "conn-1", label: "Acme" };
    const at = "2026-03-17T10:00:00.000Z";

    test("emits when status transitions into error", () => {
      const event = buildConnectionErrorEvent({
        provider: "azure-devops",
        connection,
        prevState: { status: "ok", lastError: "" },
        currentStatus: "error",
        currentError: "401 Unauthorized",
        at,
      });
      expect(event).toMatchObject({
        kind: "connection-error",
        provider: "azure-devops",
        connectionId: "conn-1",
        prKey: "connection:conn-1",
        title: "Acme: connection error",
      });
      expect(event.body).toContain("401");
    });

    test("emits on first sync (idle → error)", () => {
      const event = buildConnectionErrorEvent({
        provider: "github",
        connection,
        prevState: {},
        currentStatus: "error",
        currentError: "Network down",
        at,
      });
      expect(event).toBeTruthy();
    });

    test("stays silent when the same error persists across polls", () => {
      const event = buildConnectionErrorEvent({
        provider: "azure-devops",
        connection,
        prevState: { status: "error", lastError: "401 Unauthorized" },
        currentStatus: "error",
        currentError: "401 Unauthorized",
        at,
      });
      expect(event).toBeNull();
    });

    test("emits again when the error message changes", () => {
      const event = buildConnectionErrorEvent({
        provider: "azure-devops",
        connection,
        prevState: { status: "error", lastError: "401 Unauthorized" },
        currentStatus: "error",
        currentError: "PAT expired",
        at,
      });
      expect(event).toBeTruthy();
      expect(event.body).toContain("PAT expired");
    });

    test("stays silent when status is ok", () => {
      const event = buildConnectionErrorEvent({
        provider: "github",
        connection,
        prevState: { status: "error", lastError: "previous" },
        currentStatus: "ok",
        currentError: "",
        at,
      });
      expect(event).toBeNull();
    });
  });

  test("buildReviewActivityEvent produces a stable id built from prKey/kind/at", () => {
    const summary = {
      prKey: "conn:repo:42",
      connectionId: "conn",
      repository: { name: "thing", fullName: "org/thing" },
      pullRequest: { id: 42, number: 42, title: "Do it", webUrl: "https://x/42" },
      role: "reviewer",
      reviewWorkspaceId: "ws-1",
    };
    const event = buildReviewActivityEvent({
      provider: "github",
      summary,
      kind: "pr-new-comment",
      at: "2026-03-17T10:00:00.000Z",
      title: "t",
      body: "b",
    });
    expect(event.id).toBe("conn:repo:42:pr-new-comment:2026-03-17T10:00:00.000Z");
    expect(event.provider).toBe("github");
    expect(event.repositoryName).toBe("org/thing");
    expect(event.pullRequestNumber).toBe(42);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { JiraRequestError } from "./jira-request-error.js";
import {
  classifyJiraWriteFailure,
  JiraWriteSafety,
  jiraWriteFailureSafeCode,
  type JiraWriteIdentity,
} from "./jira-write-safety.js";
import { JiraWriteJournal, type JiraWriteJournalState } from "./jira-write-journal.js";
import { JIRA_WRITE_SAFE_CODE_PATTERN } from "../../shared/jira-error-codes.js";

const logCalls = vi.hoisted(() => [] as Array<{ level: string; message: string; meta?: Record<string, unknown> }>);
vi.mock("../logger.js", () => {
  const record = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    logCalls.push({ level, message, meta });
  };
  return {
    getLogger: () => ({
      error: record("error"),
      warn: record("warn"),
      info: record("info"),
      debug: record("debug"),
      trace: record("trace"),
    }),
    redactSecrets: (value: string) => value,
  };
});

const issue = { connectionId: "c1", issueId: "100", issueKey: "APP-1" };
const mine: JiraWriteIdentity = { kind: "cloud", accountId: "acct-1" };

function setup() {
  const store = {
    value: undefined as JiraWriteJournalState | undefined,
    async load() {
      return this.value && structuredClone(this.value);
    },
    async save(value: JiraWriteJournalState) {
      this.value = structuredClone(value);
    },
  };
  const journal = new JiraWriteJournal({ store });
  const hooks = {
    listTransitions: vi.fn(async () => []),
    transition: vi.fn(async () => ({})),
    addComment: vi.fn(async () => ({})),
    addRemoteLink: vi.fn(async () => ({})),
    addWorklog: vi.fn(async () => ({})),
    getMyself: vi.fn(async () => mine),
    canWorklog: vi.fn(async () => true),
    journal,
    getAuditContext: vi.fn(async () => ({ profileId: "p1", requester: "Alice", apiActor: "alice", actor: mine })),
    freshIssueState: vi.fn(async () => ({ status: "To Do", updated: "2026-10-23T10:00:00Z" })),
    reconcile: vi.fn(async () => "applied" as const),
  };
  const safety = new JiraWriteSafety(hooks);
  const comment = async () => {
    const confirmation = await safety.previewComment(issue, "My private comment text", "post this update", "personal");
    return safety.executeComment(issue, "My private comment text", confirmation);
  };
  const entries = () => store.value!.entries;
  return { hooks, comment, entries };
}

beforeEach(() => {
  logCalls.length = 0;
});

const statusFailure = (
  code: ConstructorParameters<typeof JiraRequestError>[0],
  status: number,
  retryAfterMs?: number,
) => new JiraRequestError(code, `Jira request failed (${status}).`, retryAfterMs, status);

describe("a failed write is classified by what happened, not by its message", () => {
  it.each([
    [401, "auth-expired", /sign-in has expired/i],
    [403, "permission-denied", /not allowed to make that change/i],
    [404, "not-found", /could not find/i],
  ] as const)("%i is rejected: not applied, never blocks the retry, and says why", async (status, code, message) => {
    const { hooks, comment, entries } = setup();
    hooks.addComment.mockRejectedValueOnce(statusFailure(code, status));
    const failure = await comment().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code,
      status: "failed",
      statusCode: status,
      journalId: entries()[0].id,
      message: expect.stringMatching(message),
    });
    expect(entries()[0]).toMatchObject({
      state: "reconciled",
      reconciliation: "not-applied",
      safeCode: `${code}:${status}`,
    });
    await expect(comment()).resolves.toMatchObject({ status: "succeeded" });
    expect(hooks.addComment).toHaveBeenCalledTimes(2);
  });

  it("429 is rate-limited with its wait, and Jira did not apply the write", async () => {
    const { hooks, comment, entries } = setup();
    hooks.addComment.mockRejectedValueOnce(statusFailure("rate-limited", 429, 7_000));
    await expect(comment()).rejects.toMatchObject({
      code: "rate-limited",
      status: "failed",
      retryAfterMs: 7_000,
      message: expect.stringContaining("retry in about 7 s"),
    });
    expect(entries()[0]).toMatchObject({
      state: "reconciled",
      reconciliation: "not-applied",
      safeCode: "rate-limited:429",
    });
  });

  it("400, 409 and 422 stay jira-write-rejected and carry Jira's explanation", async () => {
    for (const status of [400, 409, 422]) {
      const { hooks, comment, entries } = setup();
      hooks.addComment.mockRejectedValueOnce(
        new JiraRequestError("unknown", `Jira request failed (${status}): bad`, undefined, status, {
          detail: "Field 'x' is required",
        }),
      );
      await expect(comment()).rejects.toMatchObject({
        code: "jira-write-rejected",
        status: "failed",
        message: expect.stringContaining(`(${status}). Field 'x' is required`),
      });
      expect(entries()[0]).toMatchObject({
        state: "reconciled",
        reconciliation: "not-applied",
        safeCode: `unknown:${status}`,
      });
    }
  });

  it("a failure before anything was sent is 'not sent': failed, never unknown, and a retry is allowed", async () => {
    const { hooks, comment, entries } = setup();
    hooks.addComment.mockRejectedValueOnce(
      new JiraRequestError(
        "credential-missing",
        "Jira PAT is missing. Reconnect this Jira connection.",
        undefined,
        undefined,
        {
          notSent: true,
        },
      ),
    );
    await expect(comment()).rejects.toMatchObject({
      code: "credential-missing",
      status: "failed",
      message: expect.stringContaining("Nothing was sent to Jira"),
    });
    expect(entries()[0]).toMatchObject({ state: "failed", safeCode: "not-sent:credential-missing" });
    await expect(comment()).resolves.toMatchObject({ status: "succeeded" });
  });

  it("a status on a not-sent failure (a sign-in service answering 401) is still 'not sent'", () => {
    expect(
      classifyJiraWriteFailure(new JiraRequestError("auth-expired", "expired", undefined, 401, { notSent: true })),
    ).toMatchObject({ kind: "not-sent", code: "auth-expired", statusCode: 401 });
  });

  it("a network failure after the request was sent stays unknown and blocks an identical retry", async () => {
    const { hooks, comment, entries } = setup();
    hooks.addComment.mockRejectedValueOnce(
      new JiraRequestError("network", "Jira write request failed or exceeded its time limit."),
    );
    await expect(comment()).rejects.toMatchObject({
      code: "jira-write-unknown",
      status: "unknown",
      message: expect.stringContaining("may have accepted"),
    });
    expect(entries()[0]).toMatchObject({ state: "unknown", safeCode: "network" });
    await expect(comment()).rejects.toThrow(/already recorded or unresolved/);
    expect(hooks.addComment).toHaveBeenCalledTimes(1);
  });

  it("a 500 or an unrecognised error is unknown too, and the old exact-string match no longer decides anything", async () => {
    const { hooks, comment, entries } = setup();
    hooks.addComment.mockRejectedValueOnce(new Error("Jira request failed (400)."));
    await expect(comment()).rejects.toMatchObject({ code: "jira-write-unknown", status: "unknown" });
    expect(entries()[0]).toMatchObject({ state: "unknown", safeCode: "provider-error" });
    expect(classifyJiraWriteFailure(statusFailure("network", 503))).toMatchObject({ kind: "unknown", statusCode: 503 });
  });

  it("every safeCode it writes fits the journal's pattern", () => {
    for (const failure of [
      classifyJiraWriteFailure(statusFailure("permission-denied", 403)),
      classifyJiraWriteFailure(new JiraRequestError("host-unreachable", "x", undefined, undefined, { notSent: true })),
      classifyJiraWriteFailure(new Error("x")),
    ])
      expect(jiraWriteFailureSafeCode(failure)).toMatch(JIRA_WRITE_SAFE_CODE_PATTERN);
  });
});

describe("what the log learns about a write", () => {
  it("one info line on success and one warn line on failure, never the content", async () => {
    const { comment, entries } = setup();
    await comment();
    const success = logCalls.find((call) => call.message === "jira write succeeded");
    expect(success).toMatchObject({
      level: "info",
      meta: { op: "comment", connectionId: "c1", issueKey: "APP-1", journalId: entries()[0].id },
    });

    expect(JSON.stringify(logCalls)).not.toContain("My private comment text");
  });

  it("a rejected write logs outcome, code, status and the cause code", async () => {
    const { hooks, comment, entries } = setup();
    hooks.addComment.mockRejectedValueOnce(
      new JiraRequestError("permission-denied", "denied", undefined, 403, {
        cause: Object.assign(new Error("secret detail"), { code: "EPROTO" }),
      }),
    );
    await comment().catch(() => undefined);
    const failure = logCalls.find((call) => call.message === "jira write did not complete");
    expect(failure).toMatchObject({
      level: "warn",
      meta: {
        op: "comment",
        connectionId: "c1",
        issueKey: "APP-1",
        journalId: entries()[0].id,
        outcome: "rejected",
        code: "permission-denied",
        statusCode: 403,
        cause: "EPROTO",
      },
    });
    const text = JSON.stringify(logCalls);
    expect(text).not.toContain("My private comment text");
    expect(text).not.toContain("secret detail");
  });

  it("warns, and still reports the failure, when the journal cannot record the outcome", async () => {
    const { hooks, comment } = setup();
    hooks.journal.markFailed = vi.fn().mockRejectedValue(new Error("disk"));
    hooks.addComment.mockRejectedValueOnce(
      new JiraRequestError("credential-missing", "missing", undefined, undefined, { notSent: true }),
    );
    await expect(comment()).rejects.toMatchObject({ code: "credential-missing", status: "failed" });
    expect(logCalls.some((call) => call.message.includes("outcome could not be recorded"))).toBe(true);
  });

  it("warns when an ambiguous write could not even be marked unknown", async () => {
    const { hooks, comment } = setup();
    hooks.journal.markUnknown = vi.fn().mockRejectedValue(new Error("disk"));
    hooks.addComment.mockRejectedValueOnce(new JiraRequestError("network", "timeout"));
    await expect(comment()).rejects.toMatchObject({ code: "jira-write-unknown" });
    expect(
      logCalls.some((call) => call.level === "warn" && call.message.includes("outcome could not be recorded")),
    ).toBe(true);
  });
});

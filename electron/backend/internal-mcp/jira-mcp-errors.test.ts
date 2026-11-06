import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInternalMcpBroker, type JiraInternalMcpApi } from "./internal-mcp-broker.js";
import { createInternalMcpStdioHandlers } from "./internal-mcp-stdio.js";
import { jiraMcpCallSucceeded, jiraUnavailableError } from "./jira-mcp-errors.js";
import { InternalMcpError } from "./errors.js";
import { JiraRequestError } from "../jira/jira-request-error.js";
import { createJiraInternalMcpApi, type JiraMcpReader } from "./jira-mcp-api.js";
import type { TaskService } from "./task-service.js";

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

beforeEach(() => {
  logCalls.length = 0;
});

describe("what an agent learns about a failed Jira call", () => {
  it.each([
    ["auth-expired", /sign in to it again/i, undefined],
    ["rate-limited", /rate limiting/i, 5_000],
    ["permission-denied", /denied/i, undefined],
    ["host-unreachable", /could not be reached/i, undefined],
  ] as const)("%s reaches the agent as a safe code, not as a generic failure", (code, message, retryAfterMs) => {
    const error = jiraUnavailableError(
      new JiraRequestError(code, "Jira said https://jira.example.com/?jql=secret", retryAfterMs, 401),
      { operation: "jira_get_issue", connectionId: "conn-1" },
    );
    expect(error).toBeInstanceOf(InternalMcpError);
    expect(error).toMatchObject({ code: "jira_unavailable", jiraCode: code, retryAfterMs });
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain("jql=secret");
  });

  it("anything else stays the generic message with no code", () => {
    const error = jiraUnavailableError(new Error("socket hang up https://x/?token=abc"), { operation: "jira_search" });
    expect(error).toMatchObject({ code: "jira_unavailable" });
    expect(error.jiraCode).toBeUndefined();
    expect(error.message).toBe("The Jira request failed. No Jira credentials or provider details were returned.");
  });

  it("is logged as a transition per connection and operation: one warn for a repeated failure, one line on recovery", () => {
    const call = { operation: "jira_get_issue", connectionId: "conn-mcp" };
    for (let i = 0; i < 4; i += 1) jiraUnavailableError(new JiraRequestError("network", "x"), call);
    jiraUnavailableError(new JiraRequestError("network", "x"), { operation: "jira_search", connectionId: "conn-mcp" });
    const warns = logCalls.filter((entry) => entry.level === "warn" && String(entry.meta?.scope).startsWith("mcp:"));
    expect(warns.map((entry) => entry.meta)).toMatchObject([
      { connectionId: "conn-mcp", scope: "mcp:jira_get_issue", code: "network" },
      { connectionId: "conn-mcp", scope: "mcp:jira_search", code: "network" },
    ]);
    jiraMcpCallSucceeded(call);
    jiraMcpCallSucceeded(call);
    const recovered = logCalls.filter((entry) => entry.message === "jira background work recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0].meta).toMatchObject({ connectionId: "conn-mcp", scope: "mcp:jira_get_issue" });
  });
});

describe("through the real API, broker and stdio bridge", () => {
  const brokers: Array<ReturnType<typeof createInternalMcpBroker>> = [];
  afterEach(async () => {
    await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  });

  it("an expired sign-in and a rate limit carry their code and wait all the way to the tool result", async () => {
    let failure: JiraRequestError = new JiraRequestError("auth-expired", "expired", undefined, 401);
    const manager = {
      issue: vi.fn(async () => {
        throw failure;
      }),
    } as unknown as JiraMcpReader;
    const jira = createJiraInternalMcpApi({
      manager,
      listConnections: () => [],
      resolveConnection: async () => ({ id: "jira-1", profileId: "p", enabled: true }) as never,
      authorizeConnection: async () => true,
      authorizeIssue: async () => true,
      managedDataRoot: async () => "/tmp",
      saveCommentDraft: async () => ({ draftId: "d", createdAt: "now" }),
    }) as JiraInternalMcpApi;
    const broker = createInternalMcpBroker({
      service: {} as unknown as Pick<TaskService, never> as TaskService,
      jira,
      isGrantLive: () => true,
    });
    brokers.push(broker);
    await broker.start();
    const grant = broker.mintGrant({
      profileId: "p",
      workspaceId: "w",
      sessionId: "s",
      panelId: "panel",
      command: "claude",
      tasksEnabled: false,
      jiraEnabled: true,
    });
    const { send } = createInternalMcpStdioHandlers({
      config: { url: grant.url, capability: grant.capability, tasksEnabled: false, jiraEnabled: true },
    });
    const request = { operation: "jira_get_issue", input: { connectionId: "jira-1", issueId: "OPS-1" } } as const;
    const expired = await send(request);
    expect(expired.isError).toBe(true);
    expect(JSON.parse((expired.content[0] as { text: string }).text)).toEqual({
      error: {
        code: "jira_unavailable",
        message: expect.stringMatching(/sign in to it again/i),
        jiraCode: "auth-expired",
      },
    });
    failure = new JiraRequestError("rate-limited", "limited", 7_000, 429);
    const limited = JSON.parse(((await send(request)).content[0] as { text: string }).text);
    expect(limited.error).toMatchObject({ code: "jira_unavailable", jiraCode: "rate-limited", retryAfterMs: 7_000 });
  });
});

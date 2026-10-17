import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildReviewGitPolicy } from "../shared/review-git-policy.js";
import { createReviewGitBroker } from "./review-git/broker.js";
import {
  createReviewGitClient,
  describeOperation,
  readReviewGitStdioConfig,
  registerReviewGitTools,
} from "./review-git-mcp.js";

const CAPABILITY = "A".repeat(43);
const URL_OK = "http://127.0.0.1:43111/review-git";

describe("readReviewGitStdioConfig", () => {
  const env = (url: string, capability = CAPABILITY) => ({
    STRIDETERM_REVIEW_GIT_URL: url,
    STRIDETERM_REVIEW_GIT_CAPABILITY: capability,
  });

  test("accepts exactly the loopback broker endpoint with a well-formed capability", () => {
    expect(readReviewGitStdioConfig(env(URL_OK))).toEqual({ url: URL_OK, capability: CAPABILITY });
  });

  test.each([
    ["no variables", {}],
    ["an https endpoint", env("https://127.0.0.1:1/review-git")],
    ["a non-loopback host", env("http://192.168.1.5:43111/review-git")],
    ["another path", env("http://127.0.0.1:43111/ssh-mcp")],
    ["embedded credentials", env("http://user:pw@127.0.0.1:43111/review-git")],
    ["a query string", env("http://127.0.0.1:43111/review-git?x=1")],
    ["port zero", env("http://127.0.0.1:0/review-git")],
    ["a short capability", env(URL_OK, "short")],
    ["an unsafe capability", env(URL_OK, "A".repeat(42) + "!")],
  ])("refuses %s", (_label, input) => {
    expect(readReviewGitStdioConfig(input as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("review Git client", () => {
  const config = { url: URL_OK, capability: CAPABILITY };
  const ok = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });

  test("mints one idempotency key before the first attempt and reuses it when the acknowledgement is lost", async () => {
    const keys: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      keys.push(JSON.parse(String(init?.body)).idempotencyKey);
      if (keys.length < 3) throw new TypeError("fetch failed");
      return ok({ operationId: "op-1", status: "running" });
    });
    const client = createReviewGitClient({ config, fetchImpl: fetchImpl as never, retryDelayMs: 1 });

    const result = await client.start({ kind: "push" });

    expect(result).toMatchObject({ operationId: "op-1" });
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
  });

  test("each separate call gets its own key", async () => {
    const keys: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      keys.push(JSON.parse(String(init?.body)).idempotencyKey);
      return ok({ operationId: "op", status: "running" });
    });
    const client = createReviewGitClient({ config, fetchImpl: fetchImpl as never });
    await client.start({ kind: "push" });
    await client.start({ kind: "push" });
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("an answer from the broker is final: HTTP errors are never retried", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "Cross-profile refused" } }), { status: 422 }),
    );
    const client = createReviewGitClient({ config, fetchImpl: fetchImpl as never, retryDelayMs: 1 });
    await expect(client.start({ kind: "push" })).rejects.toThrow("Cross-profile refused");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("gives up after three transport failures instead of looping", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createReviewGitClient({ config, fetchImpl: fetchImpl as never, retryDelayMs: 1 });
    await expect(client.start({ kind: "push" })).rejects.toThrow("fetch failed");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("a call without a grant says so instead of reaching for anything else", async () => {
    const client = createReviewGitClient({ config: null });
    await expect(client.read({ operation: "status" })).rejects.toThrow("no runtime grant");
    expect(client.available).toBe(false);
  });

  test("sends only the capability as credentials", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => ok({}));
    const client = createReviewGitClient({ config, fetchImpl: fetchImpl as never });
    await client.read({ operation: "identity" });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${CAPABILITY}` });
  });
});

describe("what the agent is told", () => {
  const lookup = (result: unknown, kind = "push") => ({
    operationId: "op-1",
    status: "succeeded" as const,
    operation: { kind, startedAt: "t", finishedAt: "t", result },
  });
  const textOf = (result: ReturnType<typeof describeOperation>) =>
    (result.content[0] as { type: "text"; text: string }).text;

  test("a proposal is not an action: it says nothing was done, asks for the user, and names the next call", () => {
    const text = textOf(
      describeOperation(
        "git_operation_status",
        lookup(
          {
            status: "confirm-required",
            proposal: {
              proposalId: "prop-123",
              kind: "force-push",
              title: "Force push over changes on the server?",
              message: "server has 2 commits",
              facts: {},
              affectedCommits: [{ sha: "a".repeat(40), subject: "mine" }],
              affectedTotal: 1,
              incomingCommits: [{ sha: "b".repeat(40), subject: "theirs" }],
              incomingTotal: 1,
            },
          },
          "force-push",
        ),
      ),
    );
    expect(text).toContain("USER CONSENT REQUIRED. Nothing was done yet.");
    expect(text).toContain("AskUserQuestion");
    expect(text).toContain("wait for their actual answer");
    // Asked through the status tool, but the continuation is the tool that STARTED it.
    expect(text).toContain('call review_git_force_push again with proposalId="prop-123"');
    expect(text).toContain("aaaaaaaa mine");
    expect(text).toContain("bbbbbbbb theirs");
  });

  test("a stale proposal says the repository changed", () => {
    const text = textOf(
      describeOperation(
        "review_git_push",
        lookup({
          status: "confirm-required",
          stale: true,
          proposal: {
            proposalId: "p2",
            kind: "push",
            title: "t",
            message: "m",
            facts: {},
            affectedCommits: [],
            affectedTotal: 0,
            incomingCommits: [],
            incomingTotal: 0,
          },
        }),
      ),
    );
    expect(text).toContain("THE REPOSITORY CHANGED");
  });

  test("a block is a reason, not a consent question", () => {
    const text = textOf(
      describeOperation(
        "review_git_push",
        lookup({ status: "blocked", code: "dirty-tree", message: "2 modified", guidance: "Commit first." }),
      ),
    );
    expect(text).toContain("BLOCKED (dirty-tree): 2 modified");
    expect(text).toContain("Commit first.");
    expect(text).toContain("not a consent question");
  });

  test("a still-running operation says it keeps running and must not be started again", () => {
    const text = textOf(describeOperation("review_git_push", { operationId: "op-1", status: "running" }));
    expect(text).toContain("still running");
    expect(text).toContain("Do not start it again");
  });

  test("a failed operation says the repository may be partly changed and forbids an automatic retry", () => {
    const text = textOf(
      describeOperation("review_git_push", {
        operationId: "op-1",
        status: "failed",
        operation: { kind: "push", startedAt: "t", finishedAt: "t", error: "lease rejected" },
      }),
    );
    expect(text).toContain("FAILED: lease rejected");
    expect(text).toContain("Do not retry automatically");
  });

  test("an expired result is reported as expired, not guessed", () => {
    const text = textOf(
      describeOperation("git_operation_status", {
        operationId: "op-1",
        status: "unavailable",
        reason: "expired",
        message: "This operation finished more than 24 hours ago and its result is no longer kept.",
      }),
    );
    expect(text).toContain("no longer kept");
  });

  test("push and publish are reported separately with the warning never to repeat either", () => {
    const text = textOf(
      describeOperation(
        "review_git_push",
        lookup({
          kind: "push-and-publish",
          push: { status: "pushed", message: "Pushed abc to feature." },
          publish: { attempted: true, published: ["c1"], failed: [{ commentKey: "c2", error: "403" }] },
        }),
      ),
    );
    expect(text).toContain("Push: pushed");
    expect(text).toContain("1 comment(s) posted, 1 failed");
    expect(text).toContain("never repeat a push that succeeded");
  });

  test("the policy tells every agent to ask and wait; Claude is told to use AskUserQuestion", () => {
    const generic = buildReviewGitPolicy({ askTool: null });
    expect(generic).toContain("ask the user in the conversation, then STOP and wait for their actual reply");
    expect(generic).toContain("NOT the user's consent");
    expect(generic).toContain("Do not run git commands that change the repository in a shell");
    for (const operation of ["rebase", "stage", "commit", "push", "force push", "continue / skip / abort"]) {
      expect(generic).toContain(operation);
    }
    const claude = buildReviewGitPolicy({ askTool: "AskUserQuestion" });
    expect(claude).toContain("call AskUserQuestion with those facts and WAIT for the user's actual answer");
    expect(claude).toContain("PermissionRequest hooks and auto-approval are NOT the user's consent");
  });
});

describe("the MCP tools, end to end through the broker", () => {
  interface Started {
    input: Record<string, unknown>;
    caller: Record<string, unknown>;
  }
  let broker: ReturnType<typeof createReviewGitBroker>;
  let client: Client;
  let started: Started[];
  let scripted: Record<string, unknown>;
  let reads: string[];

  beforeEach(async () => {
    started = [];
    reads = [];
    scripted = {};
    const service = {
      operations: {} as never,
      start: vi.fn((input: Record<string, unknown>, caller: Record<string, unknown>) => {
        started.push({ input, caller });
        return { started: true as const, operationId: `op-${started.length}` };
      }),
      lookup: (operationId: string) => {
        const index = Number(operationId.replace("op-", "")) - 1;
        const kind = String(started[index]?.input.kind);
        return {
          status: "succeeded" as const,
          operation: {
            kind,
            startedAt: "t",
            finishedAt: "t",
            result: scripted[kind] ?? { status: "pushed", message: "ok" },
          },
        };
      },
      read: vi.fn(async (input: { operation: string }) => {
        reads.push(input.operation);
        return { read: input.operation };
      }),
    };
    broker = createReviewGitBroker({ service: service as never, isGrantLive: () => true });
    const { url } = await broker.start();
    const { capability } = broker.mintGrant({
      sessionId: "ws:p",
      profileId: "default",
      workspaceId: "ws-1",
      panelId: "p",
      prKey: "k",
      identityKey: "i",
      agent: "claude",
      command: "claude",
    });
    const server = new McpServer({ name: "test", version: "1" });
    registerReviewGitTools(server, createReviewGitClient({ config: { url, capability } }));
    client = new Client({ name: "agent", version: "1" });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  });

  afterEach(async () => {
    await client.close();
    await broker.close();
  });

  const textOf = (result: unknown) =>
    ((result as { content: Array<{ text: string }> }).content[0] || { text: "" }).text;

  test("registers the read tools, every mutation, the audit log and the status tool — and no shell or arbitrary Git tool", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "get_git_audit_log",
        "git_operation_status",
        "review_git_abort",
        "review_git_checks",
        "review_git_commit",
        "review_git_conflicts",
        "review_git_continue",
        "review_git_diff",
        "review_git_fetch",
        "review_git_force_push",
        "review_git_history",
        "review_git_identity",
        "review_git_push",
        "review_git_rebase",
        "review_git_refresh",
        "review_git_refs",
        "review_git_skip",
        "review_git_stage",
        "review_git_status",
        "review_git_unstage",
      ].sort(),
    );
    expect(names.some((name) => /shell|exec|run_git|stash|merge|revert|reset|publish/u.test(name))).toBe(false);
  });

  test("every consent-required tool says so in its description; fetch and the read tools do not take a proposal", async () => {
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [
      "review_git_rebase",
      "review_git_stage",
      "review_git_unstage",
      "review_git_commit",
      "review_git_continue",
      "review_git_skip",
      "review_git_abort",
      "review_git_push",
      "review_git_force_push",
      "review_git_refresh",
    ]) {
      const tool = byName.get(name)!;
      expect(tool.description).toContain("Needs the user's consent");
      expect(Object.keys(tool.inputSchema.properties || {})).toEqual(expect.arrayContaining(["proposalId", "consent"]));
    }
    expect(Object.keys(byName.get("review_git_fetch")!.inputSchema.properties || {})).toEqual([]);
    expect(Object.keys(byName.get("review_git_status")!.inputSchema.properties || {})).toEqual([]);
  });

  test("a first call without proposalId returns a proposal and tells the agent to ask", async () => {
    scripted.commit = {
      status: "confirm-required",
      proposal: {
        proposalId: "prop-1",
        kind: "commit",
        title: "Commit the staged changes?",
        message: "Commit 1 staged path.",
        facts: {},
        affectedCommits: [],
        affectedTotal: 0,
        incomingCommits: [],
        incomingTotal: 0,
      },
    };
    const result = await client.callTool({ name: "review_git_commit", arguments: { message: "fix it" } });
    expect(textOf(result)).toContain("USER CONSENT REQUIRED");
    expect(textOf(result)).toContain('proposalId="prop-1"');
    expect(started[0].input).toMatchObject({ kind: "commit", message: "fix it" });
    expect(started[0].input.confirmation).toBeUndefined();
  });

  test("the continuation carries the proposal id and the user's reported answer as audit context", async () => {
    await client.callTool({
      name: "review_git_commit",
      arguments: { message: "fix it", proposalId: "prop-1", consent: "Yes, commit it." },
    });
    expect(started[0].input).toMatchObject({
      kind: "commit",
      message: "fix it",
      confirmation: { proposalId: "prop-1" },
    });
    expect(started[0].caller).toMatchObject({
      profileId: "default",
      requester: { source: "mcp", agent: "claude", consent: "Yes, commit it." },
    });
  });

  test("every start carries an idempotency key, and a fetch needs no consent", async () => {
    await client.callTool({ name: "review_git_fetch", arguments: {} });
    expect(String(started[0].input.idempotencyKey)).toHaveLength(36);
    expect(started[0].input.kind).toBe("fetch");
  });

  test("reads go through the broker and never start an operation", async () => {
    await client.callTool({ name: "review_git_status", arguments: {} });
    await client.callTool({ name: "review_git_diff", arguments: { scope: "staged" } });
    expect(reads).toEqual(["status", "diff"]);
    expect(started).toEqual([]);
  });

  test("an operation's outcome is reported by the status tool under the tool that started it", async () => {
    scripted.rebase = {
      status: "confirm-required",
      proposal: {
        proposalId: "prop-9",
        kind: "rebase",
        title: "t",
        message: "m",
        facts: {},
        affectedCommits: [],
        affectedTotal: 0,
        incomingCommits: [],
        incomingTotal: 0,
      },
    };
    await client.callTool({ name: "review_git_rebase", arguments: {} });
    const status = await client.callTool({ name: "git_operation_status", arguments: { operationId: "op-1" } });
    expect(textOf(status)).toContain('call review_git_rebase again with proposalId="prop-9"');
  });

  test("a capability the runtime no longer honours turns into an error the agent can read", async () => {
    await broker.close();
    const result = await client.callTool({ name: "review_git_status", arguments: {} }).catch((error: Error) => error);
    expect(String((result as Error).message ?? textOf(result))).toBeTruthy();
  });
});

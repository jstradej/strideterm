import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { REVIEW_GIT_CAPABILITY_ENV, REVIEW_GIT_URL_ENV } from "../shared/review-git-env.js";
import { createReviewGitBroker } from "./review-git/broker.js";

const stdioEntry = fileURLToPath(new URL("./review-bridge-mcp-stdio.ts", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startAgentSide(options: { withGrant: boolean }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-review-git-mcp-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const read = vi.fn(async (input: { operation: string }) => ({ read: input.operation }));
  const start = vi.fn((_input: unknown, _caller: unknown) => ({ started: true as const, operationId: "op-1" }));
  const service = {
    operations: {} as never,
    read,
    start,
    lookup: () => ({
      status: "succeeded" as const,
      operation: {
        kind: "commit",
        startedAt: "t",
        finishedAt: "t",
        result: {
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
        },
      },
    }),
  };
  const broker = createReviewGitBroker({ service: service as never, isGrantLive: () => true });
  const { url } = await broker.start();
  cleanups.push(() => broker.close());
  const env: Record<string, string> = {};
  if (options.withGrant) {
    const grant = broker.mintGrant({
      sessionId: "ws-1:panel-1",
      profileId: "default",
      workspaceId: "ws-1",
      panelId: "panel-1",
      prKey: "conn:repo:7",
      identityKey: "identity",
      agent: "claude",
      command: "claude",
    });
    env[REVIEW_GIT_URL_ENV] = grant.url;
    env[REVIEW_GIT_CAPABILITY_ENV] = grant.capability;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    // The same entry and flags the agent launchers hand to every supported agent, on every platform.
    args: [
      "--import",
      "tsx",
      stdioEntry,
      "--review-bridge-mcp",
      "--review-root",
      root,
      "--review-workspace-id",
      "ws-1",
    ],
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return { client, read, start, url };
}

const textOf = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0] || { text: "" }).text;

describe("the real review bridge MCP server process", () => {
  test("serves the draft tools AND the Git tools from one server, with the consent policy as its instructions", async () => {
    const { client } = await startAgentSide({ withGrant: true });
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        // Existing review tools are preserved.
        "list_review_comments",
        "get_review_comment",
        "create_review_comment",
        "save_review_draft",
        "queue_review_draft",
        "reply_with_code_changes",
        // Git, context and status tools live in the same server.
        "review_git_identity",
        "review_git_status",
        "review_git_refs",
        "review_git_push",
        "review_git_force_push",
        "get_git_audit_log",
        "git_operation_status",
      ]),
    );
    const instructions = client.getInstructions() || "";
    expect(instructions).toContain("ask the user in the conversation, then STOP and wait for their actual reply");
    expect(instructions).toContain("Do not run git commands that change the repository in a shell");
  }, 60_000);

  test("a Git tool reaches the runtime through the per-tab capability in its environment", async () => {
    const { client, read, start } = await startAgentSide({ withGrant: true });

    const status = await client.callTool({ name: "review_git_status", arguments: {} });
    expect(JSON.parse(textOf(status))).toEqual({ read: "status" });
    expect(read).toHaveBeenCalledTimes(1);

    const commit = await client.callTool({ name: "review_git_commit", arguments: { message: "fix" } });
    expect(textOf(commit)).toContain("USER CONSENT REQUIRED");
    expect(textOf(commit)).toContain('proposalId="prop-1"');
    expect(start).toHaveBeenCalledTimes(1);
  }, 60_000);

  test("without a grant the Git tools say so and never touch anything else", async () => {
    const { client, read } = await startAgentSide({ withGrant: false });
    const result = await client.callTool({ name: "review_git_status", arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("no runtime grant");
    expect(read).not.toHaveBeenCalled();
  }, 60_000);
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vitest";
import { execFileText } from "./process-utils.js";
import { createReviewBridgeStore } from "./review-bridge-store.js";

async function removeFixture(root: string): Promise<void> {
  const target = path.resolve(root);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith("strideterm-review-stdio-")
  ) {
    throw new Error("Refusing to remove an unexpected fixture directory.");
  }
  await fs.rm(target, { recursive: true, force: true });
}

test("production draft-only MCP over stdio adds unqueued findings and preserves existing drafts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-review-stdio-"));
  const checkout = path.join(root, "checkout");
  const bridgeRoot = path.join(root, "bridge");
  const prKey = "github:acme/web:42";
  const client = new Client({ name: "review-integration", version: "1" });
  const store = await createReviewBridgeStore(bridgeRoot);
  const git = (args: string[]) => execFileText("git", args, { cwd: checkout, timeout: 15_000 });
  try {
    await fs.mkdir(checkout);
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Review Test"]);
    await git(["config", "user.email", "review@example.invalid"]);
    await fs.writeFile(path.join(checkout, "app.txt"), "before\n");
    await git(["add", "."]);
    await git(["commit", "-m", "base"]);
    const baseCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await fs.writeFile(path.join(checkout, "app.txt"), "after\n");
    await git(["commit", "-am", "change"]);
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await store.syncPullRequest({
      provider: "github",
      prKey,
      connectionId: "github",
      repository: { name: "web" },
      pullRequest: { id: 42, title: "Example", status: "open" },
    });
    await store.createDraftComment({ prKey, body: "My existing draft", filePath: "app.txt", lineNumber: 1 });
    const original = store.getPullRequestContext(prKey)!.drafts[0];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("./review-bridge-mcp-stdio.ts", import.meta.url)),
        "--review-bridge-mcp",
        "--review-root",
        bridgeRoot,
        "--review-pr-key",
        prKey,
        "--review-draft-only",
        "--review-checkout",
        checkout,
        "--review-head",
        head,
        "--review-base",
        baseCommit,
      ],
      stderr: "pipe",
    });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "create_review_comment",
      "get_review_changes",
      "get_review_comment",
      "list_review_comments",
    ]);
    const changes = await client.callTool({ name: "get_review_changes", arguments: { filePath: "app.txt" } });
    expect(JSON.stringify(changes)).toContain("+after");
    const finding = await client.callTool({
      name: "create_review_comment",
      arguments: { body: "Concrete defect", filePath: "app.txt", lineNumber: 1, priority: "high" },
    });
    expect(finding.isError).not.toBe(true);
    const forbidden = await client.callTool({ name: "delete_review_comment", arguments: { index: 1 } });
    expect(forbidden.isError).toBe(true);
    const context = store.getPullRequestContext(prKey)!;
    expect(context.drafts.find((draft) => draft.draftId === original.draftId)).toEqual(original);
    expect(context.drafts.find((draft) => draft.body === "Concrete defect")?.status).toBe("draft");
    expect(context.drafts.every((draft) => draft.status === "draft")).toBe(true);
    expect((await git(["status", "--porcelain"])).stdout).toBe("");
  } finally {
    await client.close();
    await store.close();
    await removeFixture(root);
  }
});

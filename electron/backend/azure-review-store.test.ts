import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createAzureReviewStore } from "./azure-review-store.js";

const tempPaths = [];

async function createTempPath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-azure-review-"));
  tempPaths.push(directory);
  return path.join(directory, "azure-review.json");
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((targetPath) => fs.rm(targetPath, { recursive: true, force: true })));
});

describe("azure review store", () => {
  test("persists tracked pull request metadata", async () => {
    const filePath = await createTempPath();
    const store = await createAzureReviewStore(filePath);

    await store.upsertTrackedPullRequest("conn:repo:123", {
      lastSeenActivityAt: "2026-03-17T10:00:00.000Z",
      reviewWorkspaceId: "workspace-123",
    });

    const reloaded = await createAzureReviewStore(filePath);
    expect(reloaded.getTrackedPullRequest("conn:repo:123")).toMatchObject({
      lastSeenActivityAt: "2026-03-17T10:00:00.000Z",
      reviewWorkspaceId: "workspace-123",
    });
  });

  test("stores connection sync state", async () => {
    const store = await createAzureReviewStore(await createTempPath());

    await store.upsertConnectionState("ado-main", {
      status: "error",
      lastError: "Token expired",
    });

    expect(store.getState().connections["ado-main"]).toMatchObject({
      status: "error",
      lastError: "Token expired",
    });
  });
});

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}));

// Lets individual tests force fs.readFile to reject with a specific error
// (ENOENT / EPERM / EBUSY) without touching any other fs/promises call —
// everything else (writeFile, mkdir, rm, rename) still hits the real
// filesystem via `actual`.
const readFileOverride = vi.hoisted(() => ({
  current: null as ((...args: unknown[]) => Promise<unknown>) | null,
}));

// Same escape hatch for fs.rename, so a test can force the corrupt-file
// quarantine to fail without disturbing any other filesystem call.
const renameOverride = vi.hoisted(() => ({
  current: null as ((...args: unknown[]) => Promise<unknown>) | null,
}));

vi.mock("./logger.js", () => ({
  getLogger: () => mockLogger,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (...args: unknown[]) => {
    if (readFileOverride.current) {
      return readFileOverride.current(...args);
    }
    return (actual.readFile as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
  }) as unknown as typeof actual.readFile;
  const rename = (async (...args: unknown[]) => {
    if (renameOverride.current) {
      return renameOverride.current(...args);
    }
    return (actual.rename as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
  }) as unknown as typeof actual.rename;
  const mocked = { ...actual, readFile, rename };
  return { ...mocked, default: mocked };
});

import { createAzureReviewStore } from "./azure-review-store.js";

const tempPaths: string[] = [];

async function createTempPath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-azure-review-"));
  tempPaths.push(directory);
  return path.join(directory, "azure-review.json");
}

afterEach(async () => {
  readFileOverride.current = null;
  renameOverride.current = null;
  mockLogger.error.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.info.mockClear();
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

  test("falls back to defaults and persists a fresh file when the read fails with ENOENT", async () => {
    const filePath = await createTempPath();
    // File exists on disk, but the read itself reports ENOENT (e.g. a race
    // between existsSync and readFile). This must legitimately fall back to
    // defaults and be allowed to persist them.
    await fs.writeFile(filePath, JSON.stringify({ version: 1, trackedPullRequests: {}, connections: {} }));
    readFileOverride.current = async () => {
      throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    };

    const store = await createAzureReviewStore(filePath);

    expect(store.getState()).toEqual({ version: 1, trackedPullRequests: {}, connections: {} });

    readFileOverride.current = null;
    const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(persisted).toEqual({ version: 1, trackedPullRequests: {}, connections: {} });
  });

  test("rethrows and leaves the file untouched when the read fails with a non-ENOENT error", async () => {
    const filePath = await createTempPath();
    const originalContent = JSON.stringify({
      version: 1,
      trackedPullRequests: {
        "conn:repo:1": { key: "conn:repo:1", lastSeenActivityAt: "2026-01-01T00:00:00.000Z" },
      },
      connections: {},
    });
    await fs.writeFile(filePath, originalContent);

    readFileOverride.current = async () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    };

    await expect(createAzureReviewStore(filePath)).rejects.toMatchObject({ code: "EPERM" });
    expect(mockLogger.error).toHaveBeenCalled();

    readFileOverride.current = null;
    const untouched = readFileSync(filePath, "utf8");
    expect(untouched).toBe(originalContent);
  });

  test("rethrows and leaves the file untouched when the read fails with EBUSY", async () => {
    const filePath = await createTempPath();
    const originalContent = JSON.stringify({ version: 1, trackedPullRequests: {}, connections: {} });
    await fs.writeFile(filePath, originalContent);

    readFileOverride.current = async () => {
      throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    };

    await expect(createAzureReviewStore(filePath)).rejects.toMatchObject({ code: "EBUSY" });
    expect(mockLogger.error).toHaveBeenCalled();

    readFileOverride.current = null;
    const untouched = readFileSync(filePath, "utf8");
    expect(untouched).toBe(originalContent);
  });

  test("quarantines a corrupt file and persists fresh defaults when JSON.parse fails", async () => {
    const filePath = await createTempPath();
    const corruptContent = "{ not valid json";
    await fs.writeFile(filePath, corruptContent);

    const store = await createAzureReviewStore(filePath);

    expect(store.getState()).toEqual({ version: 1, trackedPullRequests: {}, connections: {} });
    expect(mockLogger.error).toHaveBeenCalled();

    const directory = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const corruptEntry = readdirSync(directory).find((name) => name.startsWith(`${baseName}.corrupt-`));
    expect(corruptEntry).toBeTruthy();

    const preserved = readFileSync(path.join(directory, corruptEntry as string), "utf8");
    expect(preserved).toBe(corruptContent);

    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    expect(persisted).toEqual({ version: 1, trackedPullRequests: {}, connections: {} });
  });

  test("rethrows and leaves the corrupt file untouched when quarantine (rename) fails", async () => {
    const filePath = await createTempPath();
    const corruptContent = "{ not valid json";
    await fs.writeFile(filePath, corruptContent);

    // JSON.parse fails, so the store tries to quarantine the corrupt file — but
    // the rename itself fails (e.g. EPERM). It must rethrow instead of falling
    // back to defaults; otherwise the immediate persist() would overwrite the
    // (still recoverable) corrupt original with empty state.
    renameOverride.current = async () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    };

    await expect(createAzureReviewStore(filePath)).rejects.toMatchObject({ code: "EPERM" });
    expect(mockLogger.error).toHaveBeenCalled();

    renameOverride.current = null;
    const untouched = readFileSync(filePath, "utf8");
    expect(untouched).toBe(corruptContent);
  });
});

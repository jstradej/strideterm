import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeRecoverySnapshot, readRecoverySnapshot, deleteRecoverySnapshot } from "./task-recovery-snapshot.js";
import type { TaskRecoverySnapshot } from "./types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "snapshot-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeSnapshot(overrides: Partial<TaskRecoverySnapshot> = {}): TaskRecoverySnapshot {
  return {
    taskId: "task-abc",
    workspaceId: "ws-123",
    workspaceName: "My Task",
    profileId: "default",
    currentRound: 2,
    maxRounds: 5,
    lastSavedAt: Date.now(),
    phase: "worker",
    worker: { providerId: "claude", model: "sonnet" },
    judge: { providerId: "claude", model: "opus" },
    artifacts: {
      cwd: "/tmp/myproject",
      taskDir: "/tmp/myproject/.strideterm/tasks/task-abc",
      handoffPath: "/tmp/myproject/.strideterm/tasks/task-abc/HANDOFF.md",
      verdictPath: "/tmp/myproject/.strideterm/tasks/task-abc/verdict.json",
      promptPath: "/tmp/myproject/.strideterm/tasks/task-abc/PROMPT.md",
      workLockPath: "/tmp/myproject/.strideterm/tasks/task-abc/WORK_LOCK",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// writeRecoverySnapshot
// ---------------------------------------------------------------------------
describe("writeRecoverySnapshot", () => {
  test("writes recovery.json to snapshotDir", async () => {
    const snapshot = makeSnapshot();
    await writeRecoverySnapshot(tmpDir, snapshot);
    const filePath = path.join(tmpDir, "recovery.json");
    expect(existsSync(filePath)).toBe(true);
    const content = JSON.parse(await readFile(filePath, "utf8")) as TaskRecoverySnapshot;
    expect(content.taskId).toBe("task-abc");
    expect(content.phase).toBe("worker");
    expect(content.currentRound).toBe(2);
  });

  test("creates directory if it does not exist", async () => {
    const nested = path.join(tmpDir, "tasks", "task-abc");
    const snapshot = makeSnapshot({ taskId: "task-abc" });
    await writeRecoverySnapshot(nested, snapshot);
    expect(existsSync(path.join(nested, "recovery.json"))).toBe(true);
  });

  test("atomic write — no .tmp leftover after success", async () => {
    await writeRecoverySnapshot(tmpDir, makeSnapshot());
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(tmpDir);
    expect(files.filter((f) => f.includes(".tmp-"))).toHaveLength(0);
    expect(files).toContain("recovery.json");
  });

  test("overwrites an existing snapshot", async () => {
    await writeRecoverySnapshot(tmpDir, makeSnapshot({ phase: "worker" }));
    await writeRecoverySnapshot(tmpDir, makeSnapshot({ phase: "judge" }));
    const result = await readRecoverySnapshot(tmpDir);
    expect(result?.phase).toBe("judge");
  });

  test("does not throw when write fails (non-fatal)", async () => {
    // Pass a path where we'd have to write into a file (impossible as dir)
    const filePath = path.join(tmpDir, "recovery.json");
    // Pre-create a directory at the file path to cause an error
    const { mkdir } = await import("node:fs/promises");
    await mkdir(filePath, { recursive: true });
    // Should not throw
    await expect(writeRecoverySnapshot(tmpDir, makeSnapshot())).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readRecoverySnapshot
// ---------------------------------------------------------------------------
describe("readRecoverySnapshot", () => {
  test("returns the snapshot when valid", async () => {
    const snapshot = makeSnapshot({ phase: "judge", currentRound: 3 });
    await writeRecoverySnapshot(tmpDir, snapshot);
    const result = await readRecoverySnapshot(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe("judge");
    expect(result!.currentRound).toBe(3);
    expect(result!.taskId).toBe("task-abc");
  });

  test("returns null when file does not exist", async () => {
    const result = await readRecoverySnapshot(path.join(tmpDir, "nonexistent"));
    expect(result).toBeNull();
  });

  test("returns null for invalid JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(tmpDir, "recovery.json"), "not{json", "utf8");
    const result = await readRecoverySnapshot(tmpDir);
    expect(result).toBeNull();
  });

  test("returns null for JSON missing required fields", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(tmpDir, "recovery.json"), JSON.stringify({ taskId: "x" }), "utf8");
    const result = await readRecoverySnapshot(tmpDir);
    expect(result).toBeNull();
  });

  test("preserves all snapshot fields on round-trip", async () => {
    const snapshot = makeSnapshot();
    await writeRecoverySnapshot(tmpDir, snapshot);
    const result = await readRecoverySnapshot(tmpDir);
    expect(result).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// deleteRecoverySnapshot
// ---------------------------------------------------------------------------
describe("deleteRecoverySnapshot", () => {
  test("removes an existing recovery.json", async () => {
    await writeRecoverySnapshot(tmpDir, makeSnapshot());
    expect(existsSync(path.join(tmpDir, "recovery.json"))).toBe(true);
    await deleteRecoverySnapshot(tmpDir);
    expect(existsSync(path.join(tmpDir, "recovery.json"))).toBe(false);
  });

  test("does not throw when file does not exist", async () => {
    await expect(deleteRecoverySnapshot(path.join(tmpDir, "absent"))).resolves.toBeUndefined();
  });
});

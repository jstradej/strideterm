import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { inspectCandidates } from "./task-recovery-handler.js";
import { writeRecoverySnapshot, readRecoverySnapshot } from "./task-recovery-snapshot.js";
import type { TaskRecoverySnapshot } from "./types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "handler-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function makeTaskDir(taskId: string, opts: { handoff?: string; verdict?: string } = {}) {
  const dir = path.join(tmpDir, "tasks", taskId, ".strideterm", "tasks", taskId);
  await mkdir(dir, { recursive: true });
  if (opts.handoff !== undefined) await writeFile(path.join(dir, "HANDOFF.md"), opts.handoff, "utf8");
  if (opts.verdict !== undefined) await writeFile(path.join(dir, "verdict.json"), opts.verdict, "utf8");
  return dir;
}

function snapshotRoot(): string {
  return path.join(tmpDir, "tasks");
}

function makeSnapshot(
  taskId: string,
  taskDir: string,
  overrides: Partial<TaskRecoverySnapshot> = {},
): TaskRecoverySnapshot {
  return {
    taskId,
    workspaceId: `ws-${taskId}`,
    workspaceName: `Task ${taskId}`,
    profileId: "default",
    currentRound: 1,
    maxRounds: 3,
    lastSavedAt: Date.now(),
    phase: "worker",
    worker: { providerId: "claude", model: "sonnet" },
    judge: { providerId: "claude", model: "opus" },
    artifacts: {
      cwd: path.join(tmpDir, "project"),
      taskDir,
      handoffPath: path.join(taskDir, "HANDOFF.md"),
      verdictPath: path.join(taskDir, "verdict.json"),
      workLockPath: path.join(taskDir, "WORK_LOCK"),
    },
    ...overrides,
  };
}

function makeAppState(workspaces: Array<{ id: string; kind: string; taskId: string; state: string; round?: number }>) {
  return {
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: `Workspace ${w.id}`,
      kind: w.kind,
      profileId: "default",
      task: {
        taskId: w.taskId,
        state: w.state,
        currentRound: w.round ?? 1,
        maxRounds: 3,
      },
    })),
  };
}

describe("inspectCandidates", () => {
  test("returns a candidate for a running task with a snapshot and no verdict", async () => {
    const taskId = "task-running";
    const artifactDir = await makeTaskDir(taskId);
    const snapshot = makeSnapshot(taskId, artifactDir);
    const snapshotDir = path.join(snapshotRoot(), taskId);
    await writeRecoverySnapshot(snapshotDir, snapshot);

    const appState = makeAppState([{ id: `ws-${taskId}`, kind: "task", taskId, state: "running" }]);
    const candidates = await inspectCandidates(snapshotRoot(), appState);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].taskId).toBe(taskId);
    expect(candidates[0].fsState).toBe("neither");
  });

  test("returns fsState=handoff-exists when HANDOFF.md has content", async () => {
    const taskId = "task-handoff";
    const artifactDir = await makeTaskDir(taskId, { handoff: "# Handoff\n\nSome content." });
    const snapshot = makeSnapshot(taskId, artifactDir);
    const snapshotDir = path.join(snapshotRoot(), taskId);
    await writeRecoverySnapshot(snapshotDir, snapshot);

    const appState = makeAppState([{ id: `ws-${taskId}`, kind: "task", taskId, state: "running" }]);
    const candidates = await inspectCandidates(snapshotRoot(), appState);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].fsState).toBe("handoff-exists");
  });

  test("drops snapshot and excludes task when verdict.json already on disk", async () => {
    const taskId = "task-verdict";
    const artifactDir = await makeTaskDir(taskId, {
      verdict: JSON.stringify({ score: 8, pass: true }),
    });
    const snapshot = makeSnapshot(taskId, artifactDir);
    const snapshotDir = path.join(snapshotRoot(), taskId);
    await writeRecoverySnapshot(snapshotDir, snapshot);

    const appState = makeAppState([{ id: `ws-${taskId}`, kind: "task", taskId, state: "running" }]);
    const candidates = await inspectCandidates(snapshotRoot(), appState);

    expect(candidates).toHaveLength(0);
    // Snapshot deleted as part of inspection
    expect(await readRecoverySnapshot(snapshotDir)).toBeNull();
  });

  test("excludes non-task workspaces", async () => {
    const appState = makeAppState([{ id: "ws-shell", kind: "shell", taskId: "t1", state: "running" }]);
    const candidates = await inspectCandidates(snapshotRoot(), appState);
    expect(candidates).toHaveLength(0);
  });

  test("excludes tasks in non-recoverable states", async () => {
    const taskId = "task-idle";
    const artifactDir = await makeTaskDir(taskId);
    const snapshot = makeSnapshot(taskId, artifactDir);
    const snapshotDir = path.join(snapshotRoot(), taskId);
    await writeRecoverySnapshot(snapshotDir, snapshot);

    const appState = makeAppState([{ id: `ws-${taskId}`, kind: "task", taskId, state: "idle" }]);
    const candidates = await inspectCandidates(snapshotRoot(), appState);
    expect(candidates).toHaveLength(0);
  });

  test("excludes tasks with no snapshot on disk", async () => {
    const taskId = "task-no-snapshot";
    const appState = makeAppState([{ id: `ws-${taskId}`, kind: "task", taskId, state: "running" }]);
    const candidates = await inspectCandidates(snapshotRoot(), appState);
    expect(candidates).toHaveLength(0);
  });

  test("auto-skips and deletes snapshots older than 24 h", async () => {
    const taskId = "task-old";
    const artifactDir = await makeTaskDir(taskId);
    const OLD = Date.now() - 25 * 60 * 60 * 1000;
    const snapshot = makeSnapshot(taskId, artifactDir, { lastSavedAt: OLD });
    const snapshotDir = path.join(snapshotRoot(), taskId);
    await writeRecoverySnapshot(snapshotDir, snapshot);

    const appState = makeAppState([{ id: `ws-${taskId}`, kind: "task", taskId, state: "running" }]);
    const candidates = await inspectCandidates(snapshotRoot(), appState);

    expect(candidates).toHaveLength(0);
    expect(await readRecoverySnapshot(snapshotDir)).toBeNull();
  });

  test("handles evaluating and judge-evaluating states as recoverable", async () => {
    for (const state of ["evaluating", "judge-evaluating"]) {
      const taskId = `task-${state}`;
      const artifactDir = await makeTaskDir(taskId);
      const snapshot = makeSnapshot(taskId, artifactDir);
      const snapshotDir = path.join(snapshotRoot(), taskId);
      await writeRecoverySnapshot(snapshotDir, snapshot);

      const appState = makeAppState([{ id: `ws-${taskId}`, kind: "task", taskId, state }]);
      const candidates = await inspectCandidates(snapshotRoot(), appState);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].taskId).toBe(taskId);
    }
  });

  test("returns multiple candidates for multiple matching tasks", async () => {
    const tasks = ["task-a", "task-b", "task-c"];
    for (const taskId of tasks) {
      const artifactDir = await makeTaskDir(taskId);
      const snapshot = makeSnapshot(taskId, artifactDir);
      const snapshotDir = path.join(snapshotRoot(), taskId);
      await writeRecoverySnapshot(snapshotDir, snapshot);
    }
    const appState = makeAppState(
      tasks.map((taskId) => ({ id: `ws-${taskId}`, kind: "task", taskId, state: "running" })),
    );
    const candidates = await inspectCandidates(snapshotRoot(), appState);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.taskId).sort()).toEqual(tasks.sort());
  });
});

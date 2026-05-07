import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { taskHasWorkerFile, updateTaskDescriptionFile, writeTaskFiles } from "./agent-task-files.js";
import { taskDir, TASK_FILE, WORKER_FILE, extractTaskDescription } from "./agent-task-utils.js";
import type { TaskState } from "../shared/types/task.js";

function fakeLogger() {
  const calls: Array<{ level: string; msg: string; meta?: unknown }> = [];
  const make =
    (level: string) =>
    (msg: string, meta?: unknown): void => {
      calls.push({ level, msg, meta });
    };
  return {
    calls,
    log: {
      trace: make("trace"),
      debug: make("debug"),
      info: make("info"),
      warn: make("warn"),
      error: make("error"),
      child: () => ({}) as unknown,
    } as unknown as Parameters<typeof updateTaskDescriptionFile>[3],
  };
}

const FIXTURE_TASK_MD = `# Task

> Created: 2026-04-27 12:00:00 | Project: /tmp/whatever

This is the original description.
It can span multiple lines.

## Verification before completion

> Auto-detected commands.

- [ ] Run \`npm test\`

## Rules

- Commit your work
`;

describe("updateTaskDescriptionFile", () => {
  let cwd: string;
  const taskId = "task-abc";

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "task-files-test-"));
    const dir = taskDir(cwd, taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, TASK_FILE), FIXTURE_TASK_MD, "utf8");
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test("replaces description while preserving header, Verification, and Rules sections", async () => {
    const { log } = fakeLogger();
    await updateTaskDescriptionFile(cwd, taskId, "New brief — much shorter.", log);

    const updated = await readFile(path.join(taskDir(cwd, taskId), TASK_FILE), "utf8");
    expect(updated).toContain("# Task");
    expect(updated).toContain("> Created: 2026-04-27 12:00:00");
    expect(updated).toContain("New brief — much shorter.");
    expect(updated).not.toContain("This is the original description.");
    expect(updated).toContain("## Verification before completion");
    expect(updated).toContain("- [ ] Run `npm test`");
    expect(updated).toContain("## Rules");
    expect(updated).toContain("- Commit your work");
  });

  test("round-trips through extractTaskDescription", async () => {
    const { log } = fakeLogger();
    const newDesc = "Investigate why the auth flow drops the refresh token.\n\nSee /tmp/repro.";
    await updateTaskDescriptionFile(cwd, taskId, newDesc, log);

    const updated = await readFile(path.join(taskDir(cwd, taskId), TASK_FILE), "utf8");
    expect(extractTaskDescription(updated)).toBe(newDesc);
  });

  test("empty description is replaced with placeholder block", async () => {
    const { log } = fakeLogger();
    await updateTaskDescriptionFile(cwd, taskId, "   ", log);

    const updated = await readFile(path.join(taskDir(cwd, taskId), TASK_FILE), "utf8");
    expect(updated).toContain("> No task description provided.");
    // Placeholder must be treated as "no description" by the extractor so
    // startTask doesn't mistake the placeholder for a real assignment.
    expect(extractTaskDescription(updated)).toBe("");
  });

  test("propagates ENOENT when TASK.md is missing", async () => {
    const { log } = fakeLogger();
    const missingTaskId = "does-not-exist";
    await expect(updateTaskDescriptionFile(cwd, missingTaskId, "x", log)).rejects.toThrow();
  });
});

describe("writeTaskFiles — split format (TASK.md + WORKER.md)", () => {
  let cwd: string;

  function makeTask(overrides: Partial<TaskState> = {}): TaskState {
    return {
      taskId: "task-split-001",
      description: "Refactor auth flow.",
      parentWorkspaceId: "ws-1",
      worktreeBase: "",
      worktreeBranch: "",
      workerPanelId: "panel-w",
      judgePanelId: "panel-j",
      maxRounds: 10,
      showerInterval: 5,
      state: "idle",
      currentRound: 0,
      rounds: [],
      lastShowerRound: 0,
      lastJudgeInstructions: "",
      workerProviderConfig: null,
      judgeProviderConfig: null,
      promptSent: false,
      pausedFromState: "",
      showerResumePrompt: "",
      startedAt: null,
      totalPausedMs: 0,
      pausedAt: null,
      finishedAt: null,
      rateLimitedUntil: null,
      ...overrides,
    } as TaskState;
  }

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "task-split-test-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test("TASK.md contains only the brief; WORKER.md holds Verification + Rules", async () => {
    const { log } = fakeLogger();
    const task = makeTask({ description: "Build the user login form." });
    await writeTaskFiles(cwd, task, log);

    const taskPath = path.join(taskDir(cwd, task.taskId), TASK_FILE);
    const workerPath = path.join(taskDir(cwd, task.taskId), WORKER_FILE);
    const taskMd = await readFile(taskPath, "utf8");
    const workerMd = await readFile(workerPath, "utf8");

    expect(taskMd).toContain("# Task");
    expect(taskMd).toContain("Build the user login form.");
    // Operational sections moved to WORKER.md
    expect(taskMd).not.toContain("## Verification before completion");
    expect(taskMd).not.toContain("## Rules");
    // Regression guard: npm-style command examples must never appear in
    // TASK.md. They used to live in the legacy fallback verification block
    // which is now gone from TASK.md entirely.
    expect(taskMd).not.toMatch(/npm test|npm run lint|npm run typecheck/);

    expect(workerMd).toContain("# Worker");
    expect(workerMd).toContain("## Verification before completion");
    expect(workerMd).toContain("## Rules");
    expect(workerMd).toContain("Commit your work");
  });

  test("TASK.md with empty description still gets only header + placeholder (no Verification)", async () => {
    // Mirrors the most common new-task case: user clicks Create without typing
    // a description. Old code would still drop "## Verification before
    // completion" with hardcoded npm examples into TASK.md; the split must
    // keep that out so the user-facing file stays focused on the brief.
    const { log } = fakeLogger();
    const task = makeTask({ description: "" });
    await writeTaskFiles(cwd, task, log);

    const taskMd = await readFile(path.join(taskDir(cwd, task.taskId), TASK_FILE), "utf8");
    expect(taskMd).toContain("# Task");
    expect(taskMd).toContain("> No task description provided");
    expect(taskMd).not.toContain("## Verification");
    expect(taskMd).not.toContain("## Rules");
    expect(taskMd).not.toMatch(/npm test|npm run lint|npm run typecheck/);
  });

  test("when verify commands are auto-detected, they land in WORKER.md (not TASK.md)", async () => {
    // Drop a package.json with detectable scripts so the auto-detector picks
    // them up. The detector is shared with production — if anything ever
    // routes its output back into TASK.md, this test catches it.
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit" } }),
      "utf8",
    );

    const { log } = fakeLogger();
    const task = makeTask({ description: "Anything." });
    await writeTaskFiles(cwd, task, log);

    const taskMd = await readFile(path.join(taskDir(cwd, task.taskId), TASK_FILE), "utf8");
    const workerMd = await readFile(path.join(taskDir(cwd, task.taskId), WORKER_FILE), "utf8");

    expect(taskMd).not.toContain("npm test");
    expect(taskMd).not.toContain("npm run lint");
    expect(workerMd).toContain("npm test");
    expect(workerMd).toContain("npm run lint");
  });

  test("taskHasWorkerFile returns true after split, false when WORKER.md is missing", async () => {
    const { log } = fakeLogger();
    const task = makeTask();
    await writeTaskFiles(cwd, task, log);
    expect(await taskHasWorkerFile(cwd, task.taskId)).toBe(true);

    await rm(path.join(taskDir(cwd, task.taskId), WORKER_FILE));
    expect(await taskHasWorkerFile(cwd, task.taskId)).toBe(false);
  });

  test("legacy single-file TASK.md (no WORKER.md) round-trips through extractTaskDescription", async () => {
    // Simulate a task created before the split: TASK.md still has rules
    // embedded; no WORKER.md exists. The parser must still pick the brief
    // out cleanly and updateTaskDescriptionFile must still preserve the
    // trailing system sections.
    const dir = taskDir(cwd, "legacy-001");
    await mkdir(dir, { recursive: true });
    const legacyTaskMd = `# Task

> Created: 2026-04-01 09:00:00 | Project: /tmp

Original brief lives here.

## Verification before completion

- [ ] Run tests

## Rules

- Commit your work
`;
    await writeFile(path.join(dir, TASK_FILE), legacyTaskMd, "utf8");

    expect(await taskHasWorkerFile(cwd, "legacy-001")).toBe(false);
    expect(extractTaskDescription(legacyTaskMd)).toBe("Original brief lives here.");

    const { log } = fakeLogger();
    await updateTaskDescriptionFile(cwd, "legacy-001", "Updated brief.", log);
    const updated = await readFile(path.join(dir, TASK_FILE), "utf8");
    expect(updated).toContain("Updated brief.");
    expect(updated).toContain("## Verification before completion");
    expect(updated).toContain("## Rules");
    expect(updated).toContain("- [ ] Run tests");
  });
});

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { updateTaskDescriptionFile } from "./agent-task-files.js";
import { taskDir, TASK_FILE, extractTaskDescription } from "./agent-task-utils.js";

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

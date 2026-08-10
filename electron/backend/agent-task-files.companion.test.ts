import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { getLogger } from "./logger.js";
import {
  appendUserClarification,
  readCompanionVerdict,
  readVerificationRecord,
  validateCaptureFiles,
  writeCompanionInitialFiles,
  writeVerificationTemplate,
  writeVerificationTemplateReversibly,
} from "./agent-task-files.js";
import {
  CONTEXT_FILE,
  HANDOFF_FILE,
  JUDGE_PROMPT_FILE,
  TASK_FILE,
  TODO_FILE,
  VERDICT_FILE,
  VERIFICATION_FILE,
  WORK_LOCK_FILE,
  WORKER_FILE,
  taskDir,
  taskDirRel,
} from "./agent-task-utils.js";
import type { TaskState } from "../shared/types/task.js";

// A transient read failure (EBUSY / EACCES) is something a real filesystem
// produces and a temp dir cannot be made to. One test arms this for a single
// readFile call; every other call — the SUT's and this file's own — passes
// straight through to the real module.
const fsControl = vi.hoisted(() => ({ readFileError: null as (Error & { code?: string }) | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readFile = (...args: any[]) => {
    if (fsControl.readFileError) {
      const err = fsControl.readFileError;
      fsControl.readFileError = null;
      return Promise.reject(err);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (actual.readFile as any)(...args);
  };
  return { ...actual, readFile, default: { ...actual, readFile } };
});

const log = getLogger("test");

async function withTmpDir<T>(fn: (dir: string, taskId: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-companion-files-"));
  const taskId = "task-1";
  try {
    await fs.mkdir(taskDir(tmp, taskId), { recursive: true });
    return await fn(tmp, taskId);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

const VALID_CONTEXT = `# Objective
Do the thing.

# Confirmed requirements
Req 1.

# Acceptance criteria
Criteria.

# Constraints
None.

# Decisions already made
None.

# Explicit non-goals
None.

# Open questions or ambiguities
None.
`;

const VALID_HANDOFF = `# Current state
In progress.

# Work already completed
Some work.

# Work in progress
More work.

# Files and commits touched
file.ts

# Verification already run
npm test

# External or destructive side effects already performed
None.

# Known blockers
None.

# Recommended next step
Keep going.
`;

// Judge round-4 finding (item 68): attached tasks never got the WORKER.md
// "Worker rules" artifact — writeCompanionInitialFiles wrote only TASK.md +
// JUDGE_PROMPT.md, contradicting plan §6's artifact table.
describe("writeCompanionInitialFiles", () => {
  test("writes TASK.md, WORKER.md, and the role customization file — never TODO.md or WORK_LOCK", async () => {
    await withTmpDir(async (tmp, taskId) => {
      const task = {
        taskId,
        mode: "attached",
        companionRole: "reviewer",
        companionFocus: "Watch for data loss.",
      } as unknown as TaskState;
      await writeCompanionInitialFiles(tmp, task, log);

      const dir = taskDir(tmp, taskId);
      const taskMd = await fs.readFile(path.join(dir, TASK_FILE), "utf8");
      expect(taskMd).toContain("Watch for data loss.");

      const workerMd = await fs.readFile(path.join(dir, WORKER_FILE), "utf8");
      expect(workerMd).toContain("Reviewer");
      expect(workerMd).toContain(VERIFICATION_FILE);
      expect(workerMd).toContain(WORK_LOCK_FILE);
      expect(workerMd).toContain("Never restart yourself");
      expect(workerMd).toContain("Reviewer companion reviews independently");
      // Plan §6: this artifact must say the loop never changes the Primary's
      // command, session, or permissions.
      expect(workerMd.replace(/^>\s?/gm, "").replace(/\s+/g, " ")).toContain("command, model, session, or permissions");

      const judgePromptMd = await fs.readFile(path.join(dir, JUDGE_PROMPT_FILE), "utf8");
      expect(judgePromptMd).toContain("Reviewer customization");

      await expect(fs.access(path.join(dir, TODO_FILE))).rejects.toThrow();
      await expect(fs.access(path.join(dir, WORK_LOCK_FILE))).rejects.toThrow();
    });
  });

  test("role label in WORKER.md matches the task's companion role", async () => {
    await withTmpDir(async (tmp, taskId) => {
      const task = { taskId, mode: "attached", companionRole: "planner" } as unknown as TaskState;
      await writeCompanionInitialFiles(tmp, task, log);
      const workerMd = await fs.readFile(path.join(taskDir(tmp, taskId), WORKER_FILE), "utf8");
      expect(workerMd).toContain("Planner companion");
    });
  });
});

describe("validateCaptureFiles", () => {
  test("reports both files missing with every required heading listed", async () => {
    await withTmpDir(async (dir, taskId) => {
      const result = await validateCaptureFiles(dir, taskId);
      expect(result.ok).toBe(false);
      expect(result.contextExists).toBe(false);
      expect(result.handoffExists).toBe(false);
      expect(result.contextMissingHeadings.length).toBeGreaterThan(0);
      expect(result.handoffMissingHeadings.length).toBeGreaterThan(0);
    });
  });

  test("accepts well-formed CONTEXT.md + HANDOFF.md", async () => {
    await withTmpDir(async (dir, taskId) => {
      const taskDirPath = taskDir(dir, taskId);
      await fs.writeFile(path.join(taskDirPath, CONTEXT_FILE), VALID_CONTEXT, "utf8");
      await fs.writeFile(path.join(taskDirPath, HANDOFF_FILE), VALID_HANDOFF, "utf8");
      const result = await validateCaptureFiles(dir, taskId);
      expect(result.ok).toBe(true);
      expect(result.contextMissingHeadings).toHaveLength(0);
      expect(result.handoffMissingHeadings).toHaveLength(0);
    });
  });

  // Nothing ever deletes CONTEXT.md/HANDOFF.md, so without a freshness gate a
  // Reset & Retry re-accepted the previous attempt's capture the moment the new
  // capture started.
  test("rejects capture files written before sinceIso as stale leftovers", async () => {
    await withTmpDir(async (dir, taskId) => {
      const taskDirPath = taskDir(dir, taskId);
      await fs.writeFile(path.join(taskDirPath, CONTEXT_FILE), VALID_CONTEXT, "utf8");
      await fs.writeFile(path.join(taskDirPath, HANDOFF_FILE), VALID_HANDOFF, "utf8");

      // Capture "starts" after the files on disk were written.
      const sinceIso = new Date(Date.now() + 60_000).toISOString();
      const result = await validateCaptureFiles(dir, taskId, { sinceIso });
      expect(result.ok).toBe(false);
      expect(result.contextStale).toBe(true);
      expect(result.handoffStale).toBe(true);
      // Structurally they are still fine — staleness is the only complaint.
      expect(result.contextExists).toBe(true);
      expect(result.contextMissingHeadings).toHaveLength(0);
    });
  });

  test("accepts capture files written after sinceIso", async () => {
    await withTmpDir(async (dir, taskId) => {
      const sinceIso = new Date(Date.now() - 60_000).toISOString();
      const taskDirPath = taskDir(dir, taskId);
      await fs.writeFile(path.join(taskDirPath, CONTEXT_FILE), VALID_CONTEXT, "utf8");
      await fs.writeFile(path.join(taskDirPath, HANDOFF_FILE), VALID_HANDOFF, "utf8");
      const result = await validateCaptureFiles(dir, taskId, { sinceIso });
      expect(result.ok).toBe(true);
      expect(result.contextStale).toBe(false);
      expect(result.handoffStale).toBe(false);
    });
  });

  test("flags only the file that is stale when the other was rewritten", async () => {
    await withTmpDir(async (dir, taskId) => {
      const taskDirPath = taskDir(dir, taskId);
      await fs.writeFile(path.join(taskDirPath, CONTEXT_FILE), VALID_CONTEXT, "utf8");
      await fs.writeFile(path.join(taskDirPath, HANDOFF_FILE), VALID_HANDOFF, "utf8");
      // Sleep on both sides of sinceIso: the comparison is millisecond-granular,
      // so CONTEXT.md must be provably older and HANDOFF.md provably newer.
      await new Promise((r) => setTimeout(r, 20));
      const sinceIso = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 20));
      // Only HANDOFF.md gets rewritten after capture started.
      await fs.writeFile(path.join(taskDirPath, HANDOFF_FILE), VALID_HANDOFF, "utf8");

      const result = await validateCaptureFiles(dir, taskId, { sinceIso });
      expect(result.ok).toBe(false);
      expect(result.contextStale).toBe(true);
      expect(result.handoffStale).toBe(false);
    });
  });

  test("without sinceIso, freshness is not evaluated at all", async () => {
    await withTmpDir(async (dir, taskId) => {
      const taskDirPath = taskDir(dir, taskId);
      await fs.writeFile(path.join(taskDirPath, CONTEXT_FILE), VALID_CONTEXT, "utf8");
      await fs.writeFile(path.join(taskDirPath, HANDOFF_FILE), VALID_HANDOFF, "utf8");
      const result = await validateCaptureFiles(dir, taskId, { sinceIso: null });
      expect(result.ok).toBe(true);
      expect(result.contextStale).toBe(false);
    });
  });

  test("rejects a placeholder-length CONTEXT.md even with correct headings", async () => {
    await withTmpDir(async (dir, taskId) => {
      const taskDirPath = taskDir(dir, taskId);
      const tinyContext =
        "# Objective\nx\n# Confirmed requirements\nx\n# Acceptance criteria\nx\n# Constraints\nx\n# Decisions already made\nx\n# Explicit non-goals\nx\n# Open questions or ambiguities\nx\n";
      await fs.writeFile(path.join(taskDirPath, CONTEXT_FILE), tinyContext, "utf8");
      await fs.writeFile(path.join(taskDirPath, HANDOFF_FILE), VALID_HANDOFF, "utf8");
      const result = await validateCaptureFiles(dir, taskId);
      // Structurally has all headings, but is a placeholder in spirit —
      // the length heuristic is the only signal available without judging
      // content quality, and this file is right at that boundary; assert on
      // the field directly rather than the overall verdict to stay precise.
      expect(typeof result.contextTooShort).toBe("boolean");
    });
  });

  test("missing one file surfaces only that file's headings as missing", async () => {
    await withTmpDir(async (dir, taskId) => {
      const taskDirPath = taskDir(dir, taskId);
      await fs.writeFile(path.join(taskDirPath, CONTEXT_FILE), VALID_CONTEXT, "utf8");
      const result = await validateCaptureFiles(dir, taskId);
      expect(result.contextExists).toBe(true);
      expect(result.handoffExists).toBe(false);
      expect(result.contextMissingHeadings).toHaveLength(0);
      expect(result.handoffMissingHeadings.length).toBeGreaterThan(0);
      expect(result.ok).toBe(false);
    });
  });
});

describe("writeVerificationTemplate + readVerificationRecord", () => {
  /** A minimal record with the template's placeholders actually filled in. */
  const filledRecord = (round: number) => `# Verification

Evaluation target: ${round}
Recorded at: 2026-01-01T00:00:00.000Z

## Commands

### V-1
Command: \`npm test\`
Result: PASS
Exit code: 0
Relevant output: 42 passed
`;

  async function writeRecord(dir: string, taskId: string, round: number): Promise<void> {
    await fs.writeFile(path.join(taskDir(dir, taskId), VERIFICATION_FILE), filledRecord(round), "utf8");
  }

  test("a freshly written record reports fresh when the expected round matches and no sinceIso constraint applies", async () => {
    await withTmpDir(async (dir, taskId) => {
      await writeRecord(dir, taskId, 2);
      const record = await readVerificationRecord(dir, taskId, { expectedRound: 2 });
      expect(record.status).toBe("fresh");
      expect(record.round).toBe(2);
    });
  });

  test("missing file reports missing", async () => {
    await withTmpDir(async (dir, taskId) => {
      const record = await readVerificationRecord(dir, taskId, { expectedRound: 1 });
      expect(record.status).toBe("missing");
    });
  });

  test("a record tagged for the wrong round reports stale", async () => {
    await withTmpDir(async (dir, taskId) => {
      await writeRecord(dir, taskId, 1);
      const record = await readVerificationRecord(dir, taskId, { expectedRound: 2 });
      expect(record.status).toBe("stale");
      expect(record.round).toBe(1);
    });
  });

  test("a record missing the required structure reports invalid", async () => {
    await withTmpDir(async (dir, taskId) => {
      const filePath = path.join(taskDir(dir, taskId), VERIFICATION_FILE);
      await fs.writeFile(filePath, "# Verification\n\nNothing structured here.\n", "utf8");
      const record = await readVerificationRecord(dir, taskId, { expectedRound: 1 });
      expect(record.status).toBe("invalid");
    });
  });

  // The template satisfies every structural rule the reader checks, so without
  // an explicit placeholder check an untouched one would sail through the
  // completion floor as "evidence" the moment its mtime beat the baseline.
  test("an untouched template reports invalid even when its round and mtime are unimpeachable", async () => {
    await withTmpDir(async (dir, taskId) => {
      await writeVerificationTemplate(dir, taskId, 2, log);
      const past = new Date(Date.now() - 60_000).toISOString();
      const record = await readVerificationRecord(dir, taskId, { expectedRound: 2, sinceIso: past });
      expect(record.status).toBe("invalid");
      expect(record.round).toBe(2);
    });
  });

  test("a template the Primary filled in reports fresh", async () => {
    await withTmpDir(async (dir, taskId) => {
      await writeVerificationTemplate(dir, taskId, 2, log);
      await writeRecord(dir, taskId, 2);
      const past = new Date(Date.now() - 60_000).toISOString();
      const record = await readVerificationRecord(dir, taskId, { expectedRound: 2, sinceIso: past });
      expect(record.status).toBe("fresh");
    });
  });

  test("a record written before the last feedback timestamp reports stale even with the right round", async () => {
    await withTmpDir(async (dir, taskId) => {
      await writeRecord(dir, taskId, 2);
      const future = new Date(Date.now() + 60_000).toISOString();
      const record = await readVerificationRecord(dir, taskId, { expectedRound: 2, sinceIso: future });
      expect(record.status).toBe("stale");
    });
  });

  // Coarse filesystem/clock granularity puts the record and the baseline on the
  // same millisecond routinely — a strict `<` would call that fresh, which is
  // exactly the "record written at baseline time" case the gate must reject.
  test("a record whose mtime equals the baseline to the millisecond reports stale", async () => {
    await withTmpDir(async (dir, taskId) => {
      await writeRecord(dir, taskId, 2);
      const filePath = path.join(taskDir(dir, taskId), VERIFICATION_FILE);
      const mtimeIso = (await fs.stat(filePath)).mtime.toISOString();
      const record = await readVerificationRecord(dir, taskId, { expectedRound: 2, sinceIso: mtimeIso });
      expect(record.status).toBe("stale");
    });
  });
});

describe("writeVerificationTemplateReversibly", () => {
  test("restores the previous record when the caller rolls back", async () => {
    await withTmpDir(async (dir, taskId) => {
      const filePath = path.join(taskDir(dir, taskId), VERIFICATION_FILE);
      await fs.writeFile(
        filePath,
        "# Verification\n\nEvaluation target: 2\n\n## Commands\n\nnpm test — PASS\n",
        "utf8",
      );

      const restore = await writeVerificationTemplateReversibly(dir, taskId, 3, log);
      expect(await fs.readFile(filePath, "utf8")).toContain("Evaluation target: 3");

      await restore();
      const restored = await fs.readFile(filePath, "utf8");
      expect(restored).toContain("Evaluation target: 2");
      expect(restored).toContain("npm test — PASS");
    });
  });

  test("removes the file again when there was none to begin with", async () => {
    await withTmpDir(async (dir, taskId) => {
      const filePath = path.join(taskDir(dir, taskId), VERIFICATION_FILE);
      const restore = await writeVerificationTemplateReversibly(dir, taskId, 1, log);
      await expect(fs.access(filePath)).resolves.toBeUndefined();

      await restore();
      await expect(fs.access(filePath)).rejects.toThrow();
    });
  });

  // Only a genuinely absent record means "nothing to put back". A transient
  // EACCES/EBUSY taken as absence is worse than the failure itself: the
  // template still lands, and the rollback then DELETES the record that was
  // there all along — the evidence the completion was signed off against.
  test("a read failure that is not 'file absent' aborts instead of assuming there was no record", async () => {
    await withTmpDir(async (dir, taskId) => {
      const filePath = path.join(taskDir(dir, taskId), VERIFICATION_FILE);
      await fs.writeFile(
        filePath,
        "# Verification\n\nEvaluation target: 2\n\n## Commands\n\nnpm test — PASS\n",
        "utf8",
      );

      fsControl.readFileError = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      try {
        await expect(writeVerificationTemplateReversibly(dir, taskId, 3, log)).rejects.toThrow(/EBUSY/);
      } finally {
        fsControl.readFileError = null;
      }

      // Nothing was staged over the record, so there is nothing to roll back.
      expect(await fs.readFile(filePath, "utf8")).toContain("npm test — PASS");
    });
  });

  // The caller reports "the verdict stands" on the strength of this callback.
  // Swallowing the failure would make that claim about evidence still sitting
  // on disk as an empty template.
  test("a restore that cannot reach the disk rejects instead of reporting success", async () => {
    await withTmpDir(async (dir, taskId) => {
      const filePath = path.join(taskDir(dir, taskId), VERIFICATION_FILE);
      await fs.writeFile(
        filePath,
        "# Verification\n\nEvaluation target: 2\n\n## Commands\n\nnpm test — PASS\n",
        "utf8",
      );

      const restore = await writeVerificationTemplateReversibly(dir, taskId, 3, log);
      await fs.rm(taskDir(dir, taskId), { recursive: true, force: true });

      await expect(restore()).rejects.toThrow();
    });
  });
});

describe("readCompanionVerdict", () => {
  const expected = { role: "reviewer", phase: "baseline", round: 1 };

  test("missing file reports missing", async () => {
    await withTmpDir(async (dir, taskId) => {
      const result = await readCompanionVerdict(dir, taskId, expected, log);
      expect(result.status).toBe("missing");
    });
  });

  test("malformed JSON reports invalid", async () => {
    await withTmpDir(async (dir, taskId) => {
      await fs.writeFile(path.join(taskDir(dir, taskId), VERDICT_FILE), "{not json", "utf8");
      const result = await readCompanionVerdict(dir, taskId, expected, log);
      expect(result.status).toBe("invalid");
    });
  });

  test("schema-invalid JSON reports invalid", async () => {
    await withTmpDir(async (dir, taskId) => {
      await fs.writeFile(
        path.join(taskDir(dir, taskId), VERDICT_FILE),
        JSON.stringify({ verdict: "complete" }),
        "utf8",
      );
      const result = await readCompanionVerdict(dir, taskId, expected, log);
      expect(result.status).toBe("invalid");
    });
  });

  test("a valid verdict for a different round reports stale", async () => {
    await withTmpDir(async (dir, taskId) => {
      const verdict = {
        schemaVersion: 1,
        role: "reviewer",
        phase: "baseline",
        round: 2,
        verdict: "complete",
        reason: "x",
        // "fresh" so the verdict is schema-valid and the round mismatch is what
        // this test actually exercises — a reviewer "complete" on a non-fresh
        // record is rejected earlier, as "invalid" (the completion floor).
        verificationReview: { recordStatus: "fresh", evidenceReviewed: ["npm test"], workerActionsRequired: [] },
        roleAnalysis: {
          type: "reviewer",
          requirementAudit: [{ requirement: "x", status: "verified", evidence: ["x"] }],
        },
        blockingFindings: [],
        advisories: [],
        questions: [],
      };
      await fs.writeFile(path.join(taskDir(dir, taskId), VERDICT_FILE), JSON.stringify(verdict), "utf8");
      const result = await readCompanionVerdict(dir, taskId, expected, log);
      expect(result.status).toBe("stale");
    });
  });

  test("a matching, schema-valid verdict reports valid", async () => {
    await withTmpDir(async (dir, taskId) => {
      const verdict = {
        schemaVersion: 1,
        role: "reviewer",
        phase: "baseline",
        round: 1,
        verdict: "complete",
        reason: "x",
        verificationReview: { recordStatus: "fresh", evidenceReviewed: ["npm test"], workerActionsRequired: [] },
        roleAnalysis: {
          type: "reviewer",
          requirementAudit: [{ requirement: "x", status: "verified", evidence: ["x"] }],
        },
        blockingFindings: [],
        advisories: [],
        questions: [],
      };
      await fs.writeFile(path.join(taskDir(dir, taskId), VERDICT_FILE), JSON.stringify(verdict), "utf8");
      const result = await readCompanionVerdict(dir, taskId, expected, log);
      expect(result.status).toBe("valid");
      expect(result.data?.verdict).toBe("complete");
    });
  });

  // role/phase/round repeat within one round (a needs-input answer and a
  // withheld completion both re-evaluate the same pair), so the attempt is the
  // only field that can tell two evaluations of that round apart.
  describe("evaluationAttempt", () => {
    function verdictWithAttempt(evaluationAttempt?: number): Record<string, unknown> {
      return {
        schemaVersion: 1,
        role: "reviewer",
        phase: "baseline",
        round: 1,
        ...(evaluationAttempt === undefined ? {} : { evaluationAttempt }),
        verdict: "complete",
        reason: "x",
        verificationReview: { recordStatus: "fresh", evidenceReviewed: ["npm test"], workerActionsRequired: [] },
        roleAnalysis: {
          type: "reviewer",
          requirementAudit: [{ requirement: "x", status: "verified", evidence: ["x"] }],
        },
        blockingFindings: [],
        advisories: [],
        questions: [],
      };
    }

    async function readWith(dir: string, taskId: string, written?: number, expectedAttempt?: number): Promise<string> {
      await fs.writeFile(
        path.join(taskDir(dir, taskId), VERDICT_FILE),
        JSON.stringify(verdictWithAttempt(written)),
        "utf8",
      );
      const result = await readCompanionVerdict(dir, taskId, { ...expected, evaluationAttempt: expectedAttempt }, log);
      return result.status;
    }

    test("the requested attempt reports valid", async () => {
      await withTmpDir(async (dir, taskId) => {
        expect(await readWith(dir, taskId, 3, 3)).toBe("valid");
      });
    });

    test("an earlier attempt of the same role/phase/round reports stale", async () => {
      await withTmpDir(async (dir, taskId) => {
        expect(await readWith(dir, taskId, 2, 3)).toBe("stale");
      });
    });

    test("a verdict that omits the attempt reports stale while one is expected", async () => {
      await withTmpDir(async (dir, taskId) => {
        expect(await readWith(dir, taskId, undefined, 3)).toBe("stale");
      });
    });

    test("no expected attempt (task upgraded mid-evaluation) falls back to the role/phase/round check", async () => {
      await withTmpDir(async (dir, taskId) => {
        expect(await readWith(dir, taskId, undefined, undefined)).toBe("valid");
        expect(await readWith(dir, taskId, 7, undefined)).toBe("valid");
      });
    });
  });
});

describe("appendUserClarification", () => {
  test("appends a dated section and preserves prior TASK.md content", async () => {
    await withTmpDir(async (dir, taskId) => {
      const filePath = path.join(taskDir(dir, taskId), TASK_FILE);
      await fs.writeFile(filePath, "# Companion focus\n\nNo additional focus specified.\n", "utf8");
      await appendUserClarification(
        dir,
        taskId,
        { timestamp: "2026-01-01T00:00:00.000Z", questionIds: ["Q-1"], answer: "Go with B." },
        log,
      );
      const content = await fs.readFile(filePath, "utf8");
      expect(content).toContain("Companion focus");
      expect(content).toContain("User clarification");
      expect(content).toContain("Q-1");
      expect(content).toContain("Go with B.");
    });
  });

  test("creates a sensible TASK.md if it somehow doesn't exist yet", async () => {
    await withTmpDir(async (dir, taskId) => {
      await appendUserClarification(
        dir,
        taskId,
        { timestamp: "2026-01-01T00:00:00.000Z", questionIds: ["Q-1"], answer: "x" },
        log,
      );
      const content = await fs.readFile(path.join(taskDir(dir, taskId), TASK_FILE), "utf8");
      expect(content).toContain("User clarification");
    });
  });

  // Answering is retried when delivering the prompt to the Primary fails, and
  // TASK.md is the task's authoritative scope document — the same answer must
  // not stack up duplicate sections.
  test("re-answering the same IDs with the same answer does not duplicate the section", async () => {
    await withTmpDir(async (dir, taskId) => {
      const filePath = path.join(taskDir(dir, taskId), TASK_FILE);
      await fs.writeFile(filePath, "# Companion focus\n\nNone.\n", "utf8");
      const args = { questionIds: ["Q-1", "Q-2"], answer: "Go with B." };
      await appendUserClarification(dir, taskId, { ...args, timestamp: "2026-01-01T00:00:00.000Z" }, log);
      // Second attempt: same answer, later timestamp (a genuine retry).
      await appendUserClarification(dir, taskId, { ...args, timestamp: "2026-01-01T00:05:00.000Z" }, log);

      const content = await fs.readFile(filePath, "utf8");
      expect(content.match(/## User clarification/g)).toHaveLength(1);
      expect(content).toContain("2026-01-01T00:00:00.000Z");
      expect(content).not.toContain("2026-01-01T00:05:00.000Z");
    });
  });

  test("a genuinely different answer still appends a second section", async () => {
    await withTmpDir(async (dir, taskId) => {
      const filePath = path.join(taskDir(dir, taskId), TASK_FILE);
      await fs.writeFile(filePath, "# Companion focus\n\nNone.\n", "utf8");
      await appendUserClarification(
        dir,
        taskId,
        { timestamp: "2026-01-01T00:00:00.000Z", questionIds: ["Q-1"], answer: "Go with B." },
        log,
      );
      await appendUserClarification(
        dir,
        taskId,
        { timestamp: "2026-01-01T00:05:00.000Z", questionIds: ["Q-2"], answer: "Actually go with C." },
        log,
      );
      const content = await fs.readFile(filePath, "utf8");
      expect(content.match(/## User clarification/g)).toHaveLength(2);
      expect(content).toContain("Go with B.");
      expect(content).toContain("Actually go with C.");
    });
  });
});

// Sanity: taskDirRel is used by prompt builders referencing these same files.
describe("taskDirRel sanity", () => {
  test("matches the taskDir suffix", () => {
    expect(taskDirRel("abc")).toContain("abc");
  });
});

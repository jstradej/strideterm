import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import {
  excludePipelineRunDir,
  pipelineFixBranchName,
  writePipelineRunFiles,
  type PipelineRunFacts,
  type PipelineRunRecord,
} from "./pipeline-agent-files.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pipeline-agent-files-"));
  dirs.push(dir);
  return dir;
}

function record(partial: Partial<PipelineRunRecord> & { id: string }): PipelineRunRecord {
  return {
    parentId: "",
    name: partial.id,
    type: "Task",
    result: "succeeded",
    order: 1,
    logId: null,
    errors: [],
    ...partial,
  };
}

function facts(records: PipelineRunRecord[]): PipelineRunFacts {
  return {
    pipelineName: "orders-release",
    projectName: "ABC",
    buildId: 9,
    buildNumber: "20261103.1",
    result: "failed",
    sourceBranch: "refs/heads/develop",
    sourceVersion: "090d0b8d",
    webUrl: "",
    requestedFor: "",
    records,
  };
}

describe("pipeline run files", () => {
  test("a run over the size budget still hands over the failing step's log, and says what it left out", async () => {
    const root = await tempDir();
    const records = [
      record({ id: "setup", name: "Setup", order: 1, logId: 1 }),
      record({
        id: "scan",
        name: "Scan image",
        order: 2,
        logId: 2,
        result: "failed",
        errors: ["jf docker scan failed"],
      }),
    ];
    const fetched: number[] = [];
    await writePipelineRunFiles({
      root,
      facts: facts(records),
      checkoutNote: "no checkout",
      maxTotalBytes: 8,
      fetchLog: async (logId) => {
        fetched.push(logId);
        return "x".repeat(8);
      },
    });
    expect(fetched).toEqual([2]);
    const runDir = path.join(root, ".strideterm", "pipeline-run", "9");
    expect(await readdir(path.join(runDir, "logs"))).toEqual(["002-Scan-image.log"]);
    const brief = await readFile(path.join(runDir, "BRIEF.md"), "utf8");
    expect(brief).toContain("Setup (succeeded) — not downloaded: the run's logs are over the size budget");
    expect(brief).toContain("1. jf docker scan failed");
  });

  test("a long log keeps its end, and a log that cannot be fetched is named in the brief", async () => {
    const root = await tempDir();
    const records = [
      record({ id: "build", name: "Build", order: 1, logId: 1, result: "failed" }),
      record({ id: "gone", name: "Publish", order: 2, logId: 2 }),
    ];
    await writePipelineRunFiles({
      root,
      facts: facts(records),
      checkoutNote: "no checkout",
      maxLogBytes: 30,
      fetchLog: async (logId) => {
        if (logId === 2) throw new Error("404 Not Found");
        return `${"noise line\n".repeat(20)}Error: the actual cause\n`;
      },
    });
    const runDir = path.join(root, ".strideterm", "pipeline-run", "9");
    const log = await readFile(path.join(runDir, "logs", "001-Build.log"), "utf8");
    expect(log.endsWith("Error: the actual cause\n")).toBe(true);
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(30);
    const brief = await readFile(path.join(runDir, "BRIEF.md"), "utf8");
    expect(brief).toContain("Build (failed) — logs/001-Build.log — only the end of the log is kept");
    expect(brief).toContain("Publish (succeeded) — could not be downloaded: 404 Not Found");
  });

  test("an error raised on a job points at the job's log", async () => {
    const root = await tempDir();
    const records = [
      record({ id: "job", name: "Publish", type: "Job", order: 1, logId: 1, result: "failed" }),
      record({ id: "check", parentId: "job", name: "Checkpoint", type: "Checkpoint", errors: ["Agent lost"] }),
    ];
    await writePipelineRunFiles({ root, facts: facts(records), checkoutNote: "x", fetchLog: async () => "log" });
    const brief = await readFile(path.join(root, ".strideterm", "pipeline-run", "9", "BRIEF.md"), "utf8");
    expect(brief).toContain("1. Agent lost\n   - Where: Publish\n   - Log: logs/001-Publish.log");
  });
});

describe("pipeline fix branch", () => {
  test("is a valid branch name built from the pipeline and the run, numbered on a retry", () => {
    expect(pipelineFixBranchName("orders-release", "20261103.1")).toBe("pipeline-fix/orders-release-20261103.1");
    expect(pipelineFixBranchName("Návrh / deploy (prod)", "1..2", 2)).toBe("pipeline-fix/Navrh-deploy-prod-1.2-2");
  });
});

describe("excluding the run files from git", () => {
  test("adds the rule once to the checkout's info/exclude", async () => {
    const root = await tempDir();
    const runGit = async () => ".git/info/exclude\n";
    await excludePipelineRunDir(root, runGit);
    await excludePipelineRunDir(root, runGit);
    expect(await readFile(path.join(root, ".git", "info", "exclude"), "utf8")).toBe("/.strideterm/pipeline-run/\n");
  });
});

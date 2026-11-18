import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAutomationResult } from "./automation-result.js";

describe("automation result reading", () => {
  it("bounds reads and refuses a result symlink outside the workspace", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "automation-result-"));
    try {
      const cwd = path.join(base, "workspace");
      const dir = path.join(cwd, ".strideterm", "automations", "auto", "runs", "run");
      await mkdir(dir, { recursive: true });
      const result = path.join(dir, "RESULT.md");
      expect(await readAutomationResult(cwd, "auto", "run", 4)).toBeUndefined();
      await writeFile(result, "abcdefgh");
      expect(await readAutomationResult(cwd, "auto", "run", 4)).toBe("abcd");
      await rm(result);
      const external = path.join(base, "secret");
      await writeFile(external, "secret");
      await symlink(external, result);
      await expect(readAutomationResult(cwd, "auto", "run", 100)).rejects.toThrow("outside the workspace");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform === "win32")("requires a regular result file", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "automation-result-type-"));
    try {
      await mkdir(path.join(cwd, ".strideterm", "automations", "auto", "runs", "run", "RESULT.md"), {
        recursive: true,
      });
      await expect(readAutomationResult(cwd, "auto", "run", 4)).rejects.toThrow("must be a regular file");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

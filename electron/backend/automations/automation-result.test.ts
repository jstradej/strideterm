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
});

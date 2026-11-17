import { mkdtemp, mkdir, readFile, rm, symlink, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareAutomationRunDirectory } from "./automation-run-files.js";

it("ignores run artifacts before creating them and preserves existing ignore entries", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "automation-ignore-"));
  try {
    await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n");
    await prepareAutomationRunDirectory(cwd, "auto", "first");
    await prepareAutomationRunDirectory(cwd, "auto", "second");
    expect(await readFile(path.join(cwd, ".gitignore"), "utf8")).toBe("node_modules/\n.strideterm/\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("refuses a workspace metadata link outside the workspace before creating run files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automation-files-"));
  try {
    const cwd = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await mkdir(cwd);
    await mkdir(outside);
    try {
      await symlink(outside, path.join(cwd, ".strideterm"), "dir");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(prepareAutomationRunDirectory(cwd, "auto", "run")).rejects.toThrow("outside the workspace");
    await expect(stat(path.join(outside, "automations"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

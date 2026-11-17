import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { ensureGitIgnore } from "../agent-task-files.js";
import { getLogger } from "../logger.js";

/** Create only within the real workspace root, checking every existing path component. */
export async function prepareAutomationRunDirectory(cwd: string, workspaceId: string, runId: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/u.test(workspaceId) || !/^[A-Za-z0-9_-]+$/u.test(runId))
    throw new Error("Invalid automation run identity");
  const root = await realpath(cwd);
  await ensureGitIgnore(root, getLogger("automations"));
  let current = root;
  for (const segment of [".strideterm", "automations", workspaceId, "runs", runId]) {
    const next = path.join(current, segment);
    await mkdir(next).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    current = await realpath(next);
    const relative = path.relative(root, current);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Automation run directory is outside the workspace");
  }
  return current;
}

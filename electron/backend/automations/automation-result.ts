import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

/** Read at most `maxBytes` of a result whose resolved path stays in the workspace. */
export async function readAutomationResult(
  cwd: string,
  workspaceId: string,
  runId: string,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    const root = await realpath(cwd);
    const filePath = await realpath(
      path.join(cwd, ".strideterm", "automations", workspaceId, "runs", runId, "RESULT.md"),
    );
    const relative = path.relative(root, filePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Automation result is outside the workspace");
    const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
    const file = await open(filePath, flags);
    try {
      if (!(await file.stat()).isFile()) throw new Error("Automation result must be a regular file");
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

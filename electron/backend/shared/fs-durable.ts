/// <reference types="node" />
import path from "node:path";
import fs from "node:fs/promises";
import { getLogger } from "../logger.js";

const log = getLogger("fs-durable");

const RENAME_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write a file through an explicit handle and fsync before closing, so the
 * bytes survive a crash/power loss right after the write (fsync errors are
 * swallowed — durability is best-effort, the write itself is not).
 *
 * mode 0o600: callers persist secrets (the state file's remote-access
 * token, credentials.json). The default umask 022 would leave a fresh file
 * world-readable on shared Linux/macOS hosts. Windows ignores mode.
 */
export async function writeFileDurable(filePath: string, data: string): Promise<void> {
  const handle = await fs.open(filePath, "w", 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync().catch(() => {});
  } finally {
    await handle.close();
  }
}

/**
 * fsync the directory containing filePath so a just-renamed entry survives
 * a crash. No-op on Windows, where directory handles cannot be fsynced.
 */
export async function syncDirectory(filePath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(path.dirname(filePath), "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => {});
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Rename with retries for transient Windows sharing violations: renaming
 * over a file another process has open (AV scan, search indexer, a reader
 * mid-readFile) fails with EPERM/EBUSY/EACCES. Those locks clear within
 * milliseconds — retry briefly before giving up. Non-transient errors
 * (ENOENT, EXDEV, …) are rethrown immediately.
 */
export async function renameWithRetries(fromPath: string, toPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RENAME_RETRIES; attempt++) {
    try {
      await fs.rename(fromPath, toPath);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      if (attempt < RENAME_RETRIES) {
        log.warn("atomic rename blocked, retrying", { attempt, code });
        await sleep(100 * attempt);
      }
    }
  }
  throw lastError;
}

/// <reference types="node" />
/**
 * Reads, writes, and deletes the per-task recovery snapshot
 * (~/.strideterm/tasks/{taskId}/recovery.json).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getLogger } from "../logger.js";
import type { TaskRecoverySnapshot } from "./types.js";

const log = getLogger("recovery:snapshot");

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, filePath);
}

export async function writeRecoverySnapshot(snapshotDir: string, snapshot: TaskRecoverySnapshot): Promise<void> {
  const filePath = path.join(snapshotDir, "recovery.json");
  try {
    await atomicWrite(filePath, JSON.stringify(snapshot, null, 2));
    log.debug("recovery snapshot written", {
      taskId: snapshot.taskId,
      phase: snapshot.phase,
      round: snapshot.currentRound,
    });
  } catch (err) {
    log.warn("failed to write recovery snapshot (non-fatal)", {
      taskId: snapshot.taskId,
      err: (err as Error).message,
    });
  }
}

export async function readRecoverySnapshot(snapshotDir: string): Promise<TaskRecoverySnapshot | null> {
  const filePath = path.join(snapshotDir, "recovery.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as TaskRecoverySnapshot;
    if (!parsed.taskId || !parsed.workspaceId || !parsed.phase) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function deleteRecoverySnapshot(snapshotDir: string): Promise<void> {
  const filePath = path.join(snapshotDir, "recovery.json");
  try {
    await fs.rm(filePath, { force: true });
    log.debug("recovery snapshot deleted", { snapshotDir });
  } catch (err) {
    log.warn("failed to delete recovery snapshot (non-fatal)", { err: (err as Error).message });
  }
}

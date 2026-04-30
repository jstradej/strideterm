/// <reference types="node" />
/**
 * Task recovery handler — pure inspection layer.
 *
 * inspectCandidates() reads state.json + recovery.json for each task workspace,
 * applies the no-false-positive filter, and returns candidates for the UI dialog.
 *
 * The actual resume action (set state, spawn PTY, inject prompt) lives in
 * runtime.ts:resolveTaskRecovery — it needs the full runtime (sessions, store,
 * task runner) which we don't want to thread through here.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getLogger } from "../logger.js";
import { readRecoverySnapshot, deleteRecoverySnapshot } from "./task-recovery-snapshot.js";
import type { RecoveryCandidate, TaskRecoverySnapshot, FsState } from "./types.js";

const log = getLogger("recovery:handler");

const AUTO_SKIP_OLDER_THAN_MS = 24 * 60 * 60 * 1000; // 24 h

interface WorkspaceTask {
  taskId?: string;
  state?: string;
  currentRound?: number;
  maxRounds?: number;
}

interface WorkspaceRef {
  id: string;
  name?: string;
  kind?: string;
  task?: WorkspaceTask | null;
  profileId?: string;
}

interface AppStateRef {
  workspaces?: WorkspaceRef[];
}

async function deriveFsState(artifacts: TaskRecoverySnapshot["artifacts"]): Promise<FsState> {
  try {
    const raw = await fs.readFile(artifacts.verdictPath, "utf8");
    JSON.parse(raw);
    return "verdict-exists";
  } catch {
    /* no verdict */
  }

  try {
    const stat = await fs.stat(artifacts.handoffPath);
    if (stat.size > 0) return "handoff-exists";
  } catch {
    /* no handoff */
  }

  return "neither";
}

function recoverySnapshotDir(snapshotRoot: string, taskId: string): string {
  return path.join(snapshotRoot, taskId);
}

/**
 * Returns recovery candidates for tasks that were running when the app crashed.
 *
 * No-false-positive invariants — a candidate is only emitted when:
 *   1. runtime.lock detected a crash (caller's responsibility)
 *   2. recovery.json exists for the taskId
 *   3. task.state in state.json is "running" / "evaluating" / "judge-evaluating"
 *   4. recovery.json parses without error
 *   5. recovery.json is younger than AUTO_SKIP_OLDER_THAN_MS (24 h)
 *   6. verdict.json is NOT on disk (those tasks are already complete — snapshot
 *      is silently deleted, no dialog entry)
 */
export async function inspectCandidates(snapshotRoot: string, appState: AppStateRef): Promise<RecoveryCandidate[]> {
  const RECOVERABLE = new Set(["running", "evaluating", "judge-evaluating"]);
  const candidates: RecoveryCandidate[] = [];

  for (const ws of appState.workspaces ?? []) {
    if (ws.kind !== "task" || !ws.task?.taskId) continue;
    const taskId = ws.task.taskId;
    if (!RECOVERABLE.has(ws.task.state ?? "")) continue;

    const snapshotDir = recoverySnapshotDir(snapshotRoot, taskId);
    const snapshot = await readRecoverySnapshot(snapshotDir);
    if (!snapshot) continue;

    if (Date.now() - snapshot.lastSavedAt > AUTO_SKIP_OLDER_THAN_MS) {
      log.info("recovery snapshot too old — auto-skipping", { taskId, lastSavedAt: snapshot.lastSavedAt });
      await deleteRecoverySnapshot(snapshotDir);
      continue;
    }

    const fsState = await deriveFsState(snapshot.artifacts);

    if (fsState === "verdict-exists") {
      log.info("verdict on disk after crash — round already complete, dropping snapshot", { taskId });
      await deleteRecoverySnapshot(snapshotDir);
      continue;
    }

    candidates.push({
      taskId: snapshot.taskId,
      workspaceId: snapshot.workspaceId,
      workspaceName: snapshot.workspaceName,
      profileId: snapshot.profileId,
      currentRound: snapshot.currentRound,
      maxRounds: snapshot.maxRounds,
      phase: snapshot.phase,
      lastSavedAt: snapshot.lastSavedAt,
      worker: snapshot.worker,
      judge: snapshot.judge,
      artifacts: snapshot.artifacts,
      fsState,
    });
  }

  return candidates;
}

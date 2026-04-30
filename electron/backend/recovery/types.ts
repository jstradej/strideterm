/**
 * Shared types for the task-agent session-recovery subsystem.
 */

export type { RecoveryCandidate, RecoveryFsState } from "../../shared/types/state.js";
import type { RecoveryFsState } from "../../shared/types/state.js";

export interface TaskRecoverySnapshot {
  taskId: string;
  workspaceId: string;
  workspaceName: string;
  profileId: string;
  currentRound: number;
  maxRounds: number;
  lastSavedAt: number;
  /** Which role was active when the snapshot was written. */
  phase: "worker" | "judge";
  worker: { providerId: string; model?: string };
  judge: { providerId: string; model?: string };
  artifacts: {
    cwd: string;
    taskDir: string;
    handoffPath: string;
    verdictPath: string;
    workLockPath: string;
  };
}

export interface RuntimeLock {
  pid: number;
  /** Epoch ms of the process start time (for PID-reuse detection). */
  startedAt: number;
  execPath: string;
}

export type RecoveryDecision = "continue" | "fresh" | "skip";

/** @deprecated Use RecoveryFsState from shared/types/state.ts */
export type FsState = RecoveryFsState;

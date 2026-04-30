/**
 * Shared types for the task-agent session-recovery subsystem.
 */

export type { RecoveryCandidate } from "../../shared/types/state.js";

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
    /** Path to round-N-prompt.md written before agent spawn. Used for Copilot programmatic resume. */
    promptPath: string;
    workLockPath: string;
  };
}

export type RecoveryDecision = "continue" | "fresh" | "skip";

export interface ProviderConfig {
  providerId: string;
  model: string;
}

export interface TaskVerdict {
  round: number;
  verdict: "pass" | "fail" | "stop";
  reason: string;
  timestamp: string;
}

export interface TaskRound {
  round: number;
  startedAt: string | null;
  finishedAt: string | null;
  verdict: TaskVerdict | null;
}

export type TaskExecutionState =
  | "idle"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "stopped"
  | "evaluating"
  | "showering"
  // Additional states used by AgentTaskRunner
  | "judge-evaluating"
  | "refreshing"
  | "completed"
  | string; // extensible

export interface TaskState {
  taskId: string;
  description: string;
  parentWorkspaceId: string;
  worktreeBase: string;
  worktreeBranch: string;
  workerPanelId: string;
  judgePanelId: string;
  maxRounds: number;
  showerInterval: number;
  state: TaskExecutionState;
  currentRound: number;
  rounds: TaskRound[];
  lastShowerRound: number;
  lastJudgeInstructions: string;
  workerProviderConfig: ProviderConfig | null;
  judgeProviderConfig: ProviderConfig | null;
  promptSent: boolean;
  pausedFromState: string;
  showerResumePrompt: string;
  startedAt: string | null;
  totalPausedMs: number;
  pausedAt: string | null;
  finishedAt: string | null;
  // ISO timestamp at which a worker rate-limit (Claude Code "You've hit your
  // limit · resets HH:MM") expires. While set in the future, onAgentIdle for
  // the worker is suppressed so the runner doesn't try to evaluate or re-prompt
  // a paused worker. The runner schedules a resume nudge for this time + grace.
  rateLimitedUntil: string | null;
  // Set on first prompt-build after probing disk: true when WORKER.md exists
  // (new split format), false for legacy tasks with rules embedded in TASK.md.
  // Persists for the task's lifetime so prompt builders can branch without
  // re-probing each round.
  useWorkerFile?: boolean;
  // Set to true by resetTask. The next startTask sends `/clear` to the
  // Worker and Judge sessions before injecting prompts so neither agent
  // carries conversational context from the previous run (which would
  // shadow an updated brief or make the worker think work is already done).
  // Cleared after the clears fire so Resume / mid-task starts don't wipe
  // running context.
  needsContextClear?: boolean;
}

export interface TaskWorkspace {
  id: string;
  name: string;
  cwd: string;
  task: TaskState;
}

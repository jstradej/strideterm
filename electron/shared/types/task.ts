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
}

export interface TaskWorkspace {
  id: string;
  name: string;
  cwd: string;
  task: TaskState;
}

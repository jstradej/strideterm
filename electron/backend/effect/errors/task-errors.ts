import { Data } from "effect";

export class TaskWorkerError extends Data.TaggedError("TaskWorkerError")<{
  readonly workspaceId: string;
  readonly cause: unknown;
}> {}

export class TaskJudgeError extends Data.TaggedError("TaskJudgeError")<{
  readonly workspaceId: string;
  readonly cause: unknown;
}> {}

export class TaskTimeoutError extends Data.TaggedError("TaskTimeoutError")<{
  readonly workspaceId: string;
  readonly timeoutMs: number;
}> {}

export class TaskCancelledError extends Data.TaggedError("TaskCancelledError")<{
  readonly workspaceId: string;
}> {}

export class TaskFileError extends Data.TaggedError("TaskFileError")<{
  readonly workspaceId: string;
  readonly path: string;
  readonly cause: unknown;
}> {}

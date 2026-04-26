import { Data } from "effect";

export class TaskFileError extends Data.TaggedError("TaskFileError")<{
  readonly workspaceId: string;
  readonly path: string;
  readonly cause: unknown;
}> {}

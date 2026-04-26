import { Data } from "effect";

export class GitAuthError extends Data.TaggedError("GitAuthError")<{
  readonly cwd: string;
  readonly remote: string;
  readonly cause: unknown;
}> {}

export class GitConflictError extends Data.TaggedError("GitConflictError")<{
  readonly cwd: string;
  readonly files: ReadonlyArray<string>;
}> {}

export class GitNotARepoError extends Data.TaggedError("GitNotARepoError")<{
  readonly cwd: string;
}> {}

export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  readonly cwd: string;
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly stderr: string;
  readonly exitCode: number;
}> {}

export class GitWorktreeError extends Data.TaggedError("GitWorktreeError")<{
  readonly cwd: string;
  readonly cause: unknown;
}> {}

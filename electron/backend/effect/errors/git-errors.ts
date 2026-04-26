import { Data } from "effect";

export class GitAuthError extends Data.TaggedError("GitAuthError")<{
  readonly cwd: string;
  readonly remote: string;
  readonly cause: unknown;
}> {}

export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  readonly cwd: string;
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly stderr: string;
  readonly exitCode: number;
}> {}

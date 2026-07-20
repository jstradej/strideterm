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
  // stdout is carried alongside stderr because git forwards a failing hook's
  // (e.g. pre-push `npm run check`) output across BOTH streams — tsc/eslint/
  // vitest write most diagnostics to stdout. Dropping it lost the actual reason
  // a push failed, leaving only a bare "hook exited with code 1".
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}> {}

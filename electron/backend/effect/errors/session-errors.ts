import { Data } from "effect";

export class PtySpawnError extends Data.TaggedError("PtySpawnError")<{
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly cause: unknown;
}> {}

export class SshAuthError extends Data.TaggedError("SshAuthError")<{
  readonly sessionId: string;
  readonly host: string;
  readonly cause: unknown;
}> {}

export class SshHostKeyError extends Data.TaggedError("SshHostKeyError")<{
  readonly sessionId: string;
  readonly host: string;
  readonly fingerprint: string;
}> {}

export class SshConnectionError extends Data.TaggedError("SshConnectionError")<{
  readonly sessionId: string;
  readonly host: string;
  readonly cause: unknown;
}> {}

export class SessionNotFoundError extends Data.TaggedError("SessionNotFoundError")<{
  readonly sessionId: string;
}> {}

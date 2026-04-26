import { Data } from "effect";

export class PtySpawnError extends Data.TaggedError("PtySpawnError")<{
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly cause: unknown;
}> {}

import { Data } from "effect";

export class DockerCmdError extends Data.TaggedError("DockerCmdError")<{
  readonly containerId: string;
  readonly cmd: string;
  readonly stderr: string;
  readonly exitCode: number;
}> {}

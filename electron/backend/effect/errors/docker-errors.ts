import { Data } from "effect";

export class DockerNotFoundError extends Data.TaggedError("DockerNotFoundError")<{
  readonly containerId: string;
}> {}

export class ContainerNotRunningError extends Data.TaggedError("ContainerNotRunningError")<{
  readonly containerId: string;
  readonly status: string;
}> {}

export class DockerCmdError extends Data.TaggedError("DockerCmdError")<{
  readonly containerId: string;
  readonly cmd: string;
  readonly stderr: string;
  readonly exitCode: number;
}> {}

export class DockerStreamError extends Data.TaggedError("DockerStreamError")<{
  readonly containerId: string;
  readonly cause: unknown;
}> {}

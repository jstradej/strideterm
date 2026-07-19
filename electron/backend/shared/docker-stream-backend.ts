import type { DockerBackendId } from "../../shared/types/state.js";

/**
 * Connection details for a single docker CLI backend (host docker, or docker
 * running inside WSL) needed to spawn `docker` for a log tail or an
 * interactive shell exec. Shared between docker-log-streamer.ts and
 * docker-shell-streamer.ts — the two streamers differ in what they do with
 * the stream (read-only log tail vs. bidirectional pty), not in how they
 * identify/spawn the backend.
 */
export interface DockerStreamBackend {
  id: DockerBackendId;
  type: "host" | "wsl";
  file: string;
  argsPrefix: string[];
}

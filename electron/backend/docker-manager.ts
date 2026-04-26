import { EventEmitter } from "node:events";
import { Effect } from "effect";
import { execFileText, parseJsonLines, quotePosixArg } from "./process-utils.js";
import { getLogger } from "./logger.js";
import { runEffect } from "./effect/runtime.js";
import { DockerCmdError } from "./effect/errors/docker-errors.js";
import type { DockerState, DockerContainer } from "../shared/types/state.js";

const log = getLogger("docker");

interface DockerBackend {
  type: "host" | "wsl";
  file: string;
  argsPrefix: string[];
}

interface LaunchArgs {
  file: string;
  args: string[];
}

function createUnavailableState(message = "Docker is unavailable."): DockerState {
  return {
    available: false,
    backend: null,
    contexts: [],
    containers: [],
    lazydocker: {
      available: false,
      backend: null,
      error: "",
    },
    error: message,
    lastUpdatedAt: null,
  };
}

export class DockerManager extends EventEmitter {
  private snapshot: DockerState;
  private backend: DockerBackend | null;
  private lazydockerBackend: DockerBackend | null;

  constructor() {
    super();
    this.snapshot = createUnavailableState();
    this.backend = null;
    this.lazydockerBackend = null;
  }

  getSnapshot(): DockerState {
    return this.snapshot;
  }

  async detectBackend(): Promise<DockerBackend | null> {
    if (this.backend) {
      return this.backend;
    }

    try {
      await execFileText("docker", ["version", "--format", "{{json .}}"]);
      this.backend = { type: "host", file: "docker", argsPrefix: [] };
      return this.backend;
    } catch {
      // Continue to WSL fallback.
    }

    try {
      await execFileText("wsl.exe", ["-e", "sh", "-lc", "docker version --format '{{json .}}'"]);
      this.backend = { type: "wsl", file: "wsl.exe", argsPrefix: ["-e", "sh", "-lc"] };
      return this.backend;
    } catch {
      this.backend = null;
      return null;
    }
  }

  async runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const backend = await this.detectBackend();
    if (!backend) {
      throw new Error("Docker CLI was not found on Windows PATH or inside WSL.");
    }

    if (backend.type === "host") {
      return execFileText(backend.file, args);
    }

    const command = ["docker", ...args.map((value) => quotePosixArg(value))].join(" ");
    return execFileText(backend.file, [...backend.argsPrefix, command]);
  }

  async detectLazydocker(): Promise<DockerBackend | null> {
    if (this.lazydockerBackend) {
      return this.lazydockerBackend;
    }

    const backend = await this.detectBackend();
    if (!backend) {
      this.lazydockerBackend = null;
      return null;
    }

    try {
      if (backend.type === "host") {
        await execFileText("lazydocker", ["--version"]);
        this.lazydockerBackend = { type: "host", file: "lazydocker", argsPrefix: [] };
        return this.lazydockerBackend;
      }

      await execFileText("wsl.exe", [
        "-e",
        "sh",
        "-lc",
        "command -v lazydocker >/dev/null 2>&1 && lazydocker --version",
      ]);
      this.lazydockerBackend = { type: "wsl", file: "wsl.exe", argsPrefix: ["-e", "sh", "-lc"] };
      return this.lazydockerBackend;
    } catch {
      this.lazydockerBackend = null;
      return null;
    }
  }

  createLaunchArgs(args: string[]): LaunchArgs | null {
    if (!this.backend) {
      return null;
    }

    if (this.backend.type === "host") {
      return {
        file: this.backend.file,
        args,
      };
    }

    const command = ["docker", ...args.map((value) => quotePosixArg(value))].join(" ");
    return {
      file: this.backend.file,
      args: [...this.backend.argsPrefix, command],
    };
  }

  createLazydockerLaunch(): LaunchArgs | null {
    if (!this.lazydockerBackend) {
      return null;
    }

    if (this.lazydockerBackend.type === "host") {
      return {
        file: this.lazydockerBackend.file,
        args: [],
      };
    }

    return {
      file: this.lazydockerBackend.file,
      args: [...this.lazydockerBackend.argsPrefix, "lazydocker"],
    };
  }

  // Effect-based parallel query for contexts + containers.  Used by refresh().
  #fetchDockerData = Effect.fn("DockerManager.fetchDockerData")(function* (
    this: DockerManager,
  ): Effect.fn.Return<[{ stdout: string; stderr: string }, { stdout: string; stderr: string }], DockerCmdError> {
    const [contextsResult, containersResult] = yield* Effect.all(
      [
        Effect.tryPromise({
          try: () => this.runDocker(["context", "ls", "--format", "{{json .}}"]),
          catch: (e) =>
            new DockerCmdError({
              containerId: "",
              cmd: "docker context ls",
              stderr: String((e as { stderr?: string }).stderr ?? e),
              exitCode: 1,
            }),
        }),
        Effect.tryPromise({
          try: () => this.runDocker(["ps", "-a", "--no-trunc", "--format", "{{json .}}"]),
          catch: (e) =>
            new DockerCmdError({
              containerId: "",
              cmd: "docker ps",
              stderr: String((e as { stderr?: string }).stderr ?? e),
              exitCode: 1,
            }),
        }),
      ],
      { concurrency: "unbounded" },
    );
    return [contextsResult, containersResult];
  });

  async refresh(): Promise<DockerState> {
    try {
      await this.detectBackend();
      await this.detectLazydocker();
      // Use Effect.all for concurrent Docker queries (Effect-based internal impl).
      const [contextsResult, containersResult] = await runEffect(this.#fetchDockerData());

      this.snapshot = {
        available: true,
        backend: this.backend?.type || null,
        contexts: parseJsonLines(contextsResult.stdout),
        containers: parseJsonLines(containersResult.stdout) as DockerContainer[],
        lazydocker: {
          available: Boolean(this.lazydockerBackend),
          backend: this.lazydockerBackend?.type || null,
          error: this.lazydockerBackend ? "" : "Lazydocker executable was not found in the active Docker environment.",
        },
        error: "",
        lastUpdatedAt: new Date().toISOString(),
      };
    } catch (error) {
      const err = error as { stderr?: string; error?: Error };
      log.debug("docker refresh failed", { err: err.stderr || err.error?.message || "Docker refresh failed." });
      this.snapshot = {
        ...createUnavailableState(err.stderr || err.error?.message || "Docker refresh failed."),
        backend: this.backend?.type || null,
        lazydocker: {
          available: Boolean(this.lazydockerBackend),
          backend: this.lazydockerBackend?.type || null,
          error: this.lazydockerBackend ? "" : "Lazydocker executable was not found in the active Docker environment.",
        },
      };
    }

    this.emit("updated", this.snapshot);
    return this.snapshot;
  }

  async performAction(action: string, containerId: string): Promise<DockerState> {
    const command = (
      {
        start: ["start", containerId],
        stop: ["stop", containerId],
        restart: ["restart", containerId],
        remove: ["rm", "-f", containerId],
      } as Record<string, string[]>
    )[action];

    if (!command) {
      throw new Error(`Unsupported Docker action: ${action}`);
    }

    await this.runDocker(command);
    return this.refresh();
  }

  findContainer(containerId: string): DockerContainer | null {
    return this.snapshot.containers.find((container) => container.ID === containerId) || null;
  }

  createShellLaunch(containerId: string): LaunchArgs | null {
    const shellCommand = "command -v bash >/dev/null 2>&1 && exec bash || exec sh";
    return this.createLaunchArgs(["exec", "-it", containerId, "sh", "-lc", shellCommand]);
  }

  createLogsLaunch(containerId: string): LaunchArgs | null {
    return this.createLaunchArgs(["logs", "-f", containerId]);
  }
}

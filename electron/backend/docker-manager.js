import { EventEmitter } from "node:events";
import { execFileText, parseJsonLines, quotePosixArg } from "./process-utils.js";

function createUnavailableState(message = "Docker is unavailable.") {
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
  constructor() {
    super();
    this.snapshot = createUnavailableState();
    this.backend = null;
    this.lazydockerBackend = null;
  }

  getSnapshot() {
    return this.snapshot;
  }

  async detectBackend() {
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

  async runDocker(args) {
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

  async detectLazydocker() {
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

      await execFileText("wsl.exe", ["-e", "sh", "-lc", "command -v lazydocker >/dev/null 2>&1 && lazydocker --version"]);
      this.lazydockerBackend = { type: "wsl", file: "wsl.exe", argsPrefix: ["-e", "sh", "-lc"] };
      return this.lazydockerBackend;
    } catch {
      this.lazydockerBackend = null;
      return null;
    }
  }

  createLaunchArgs(args) {
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

  createLazydockerLaunch() {
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

  async refresh() {
    try {
      await this.detectBackend();
      await this.detectLazydocker();
      const [contextsResult, containersResult] = await Promise.all([
        this.runDocker(["context", "ls", "--format", "{{json .}}"]),
        this.runDocker(["ps", "-a", "--no-trunc", "--format", "{{json .}}"]),
      ]);

      this.snapshot = {
        available: true,
        backend: this.backend?.type || null,
        contexts: parseJsonLines(contextsResult.stdout),
        containers: parseJsonLines(containersResult.stdout),
        lazydocker: {
          available: Boolean(this.lazydockerBackend),
          backend: this.lazydockerBackend?.type || null,
          error: this.lazydockerBackend ? "" : "Lazydocker executable was not found in the active Docker environment.",
        },
        error: "",
        lastUpdatedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.snapshot = {
        ...createUnavailableState(error.stderr || error.error?.message || "Docker refresh failed."),
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

  async performAction(action, containerId) {
    const command = {
      start: ["start", containerId],
      stop: ["stop", containerId],
      restart: ["restart", containerId],
      remove: ["rm", "-f", containerId],
    }[action];

    if (!command) {
      throw new Error(`Unsupported Docker action: ${action}`);
    }

    await this.runDocker(command);
    return this.refresh();
  }

  findContainer(containerId) {
    return this.snapshot.containers.find((container) => container.ID === containerId) || null;
  }

  createShellLaunch(containerId) {
    const shellCommand = "command -v bash >/dev/null 2>&1 && exec bash || exec sh";
    return this.createLaunchArgs(["exec", "-it", containerId, "sh", "-lc", shellCommand]);
  }

  createLogsLaunch(containerId) {
    return this.createLaunchArgs(["logs", "-f", containerId]);
  }
}

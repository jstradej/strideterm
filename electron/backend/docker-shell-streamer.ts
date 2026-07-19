/// <reference types="node" />
import { EventEmitter } from "node:events";
import pty from "node-pty";
import type { IPty } from "node-pty";
import { quotePosixArg } from "./process-utils.js";
import { getLogger } from "./logger.js";
import type { DockerStreamBackend } from "./shared/docker-stream-backend.js";
import { SessionMap } from "./shared/session-map.js";

const log = getLogger("docker-shell-streamer");

/**
 * Bidirectional `docker exec -it <id> sh` session piped through node-pty so
 * that the docker CLI sees a real TTY (otherwise `-it` errors out). Mirrors
 * the read-only `DockerLogSession` but with input forwarding + resize.
 */
export class DockerShellSession extends EventEmitter {
  private ptyProc: IPty | null = null;
  readonly sessionId: string;

  constructor(
    sessionId: string,
    private readonly backend: DockerStreamBackend,
    private readonly contextName: string,
    private readonly containerId: string,
    private readonly cols: number = 80,
    private readonly rows: number = 24,
  ) {
    super();
    this.sessionId = sessionId;
  }

  start(): void {
    // Probe for bash inside the container, fall back to sh. We do this in one
    // shell invocation so the user never sees a "bash: not found" flash.
    const shellInit = "command -v bash >/dev/null 2>&1 && exec bash || exec sh";
    const dockerArgs = ["--context", this.contextName, "exec", "-it", this.containerId, "sh", "-lc", shellInit];

    let file: string;
    let args: string[];
    if (this.backend.type === "host") {
      file = this.backend.file;
      args = dockerArgs;
    } else {
      // WSL: wrap the docker invocation in `sh -lc 'docker --context ...'`
      // so quoting survives the wsl.exe boundary. quotePosixArg handles the
      // shell-injection-safe quoting.
      file = this.backend.file;
      const cmd = ["docker", ...dockerArgs.map(quotePosixArg)].join(" ");
      args = [...this.backend.argsPrefix, cmd];
    }

    try {
      this.ptyProc = pty.spawn(file, args, {
        name: "xterm-256color",
        cols: this.cols,
        rows: this.rows,
        cwd: process.env.HOME || process.env.USERPROFILE || process.cwd(),
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      log.warn("docker shell session spawn failed", {
        sessionId: this.sessionId,
        err: (err as Error)?.message,
      });
      this.emit("close", 1);
      return;
    }

    this.ptyProc.onData((data: string) => {
      this.emit("data", data);
    });
    this.ptyProc.onExit(({ exitCode }) => {
      this.ptyProc = null;
      this.emit("close", exitCode ?? 0);
      log.debug("docker shell session exited", { sessionId: this.sessionId, exitCode });
    });

    log.debug("docker shell session started", { sessionId: this.sessionId, containerId: this.containerId });
  }

  write(data: string): void {
    if (!this.ptyProc) return;
    this.ptyProc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.ptyProc) return;
    if (cols < 1 || rows < 1) return;
    try {
      this.ptyProc.resize(cols, rows);
    } catch (err) {
      // ptyProc might have died between the resize call and write — log at
      // debug so we can correlate "phantom" resize errors with exit events.
      log.debug("docker shell resize after exit", { sessionId: this.sessionId, err: (err as Error)?.message });
    }
  }

  stop(): void {
    if (!this.ptyProc) return;
    try {
      this.ptyProc.kill();
    } catch (err) {
      log.debug("docker shell kill (already dead)", { sessionId: this.sessionId, err: (err as Error)?.message });
    }
    this.ptyProc = null;
  }
}

export class DockerShellManager {
  private sessions = new SessionMap<DockerShellSession>();

  openSession(
    sessionId: string,
    backend: DockerStreamBackend,
    contextName: string,
    containerId: string,
    cols: number,
    rows: number,
    onData: (sessionId: string, data: string) => void,
    onClose: (sessionId: string, code: number | null) => void,
  ): void {
    this.closeSession(sessionId);

    const session = new DockerShellSession(sessionId, backend, contextName, containerId, cols, rows);
    session.on("data", (data: string) => onData(sessionId, data));
    session.on("close", (code: number | null) => {
      this.sessions.delete(sessionId);
      onClose(sessionId, code);
    });

    this.sessions.set(sessionId, session);
    session.start();
  }

  writeSession(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.write(data);
  }

  resizeSession(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.resize(cols, rows);
  }

  closeSession(sessionId: string): void {
    this.sessions.remove(sessionId);
  }

  closeAll(): void {
    this.sessions.stopAll();
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  hasAnySessions(): boolean {
    return this.sessions.hasAny();
  }
}

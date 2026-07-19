/// <reference types="node" />
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { quotePosixArg } from "./process-utils.js";
import { getLogger } from "./logger.js";
import type { DockerBackendId } from "../shared/types/state.js";

const log = getLogger("docker-log-streamer");

interface LogBackend {
  id: DockerBackendId;
  type: "host" | "wsl";
  file: string;
  argsPrefix: string[];
}

export interface LogStreamOptions {
  /** Inject docker's RFC3339 timestamp prefix (`docker logs --timestamps`). */
  timestamps?: boolean;
  /**
   * Lines of scrollback to replay before tailing live. `"all"` maps to
   * `--tail all`; numeric values pass through as-is. Default 1000.
   */
  tail?: number | "all";
}

/**
 * Single `docker logs -f` subscription. The session can be restarted in place
 * (via `restart`) with different options — useful for toggling timestamps or
 * changing the tail buffer without making the renderer juggle session IDs.
 */
export class DockerLogSession extends EventEmitter {
  private child: ChildProcess | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private options: Required<LogStreamOptions>;
  private restartScheduled = false;
  readonly sessionId: string;

  constructor(
    sessionId: string,
    private readonly backend: LogBackend,
    private readonly contextName: string,
    private readonly containerId: string,
    options: LogStreamOptions = {},
  ) {
    super();
    this.sessionId = sessionId;
    this.options = {
      timestamps: !!options.timestamps,
      tail: options.tail ?? 1000,
    };
  }

  getOptions(): Required<LogStreamOptions> {
    return { ...this.options };
  }

  /**
   * Spawn the underlying `docker logs -f` process. If a previous child is
   * still alive (e.g. mid-restart), the old child is killed first so we
   * never end up duplicating the stream.
   */
  start(): void {
    if (this.child) {
      // Defensive: kill the old child before respawning. The new spawn happens
      // after the kill emits "close", so we don't leak fd's or double-stream.
      this.clearKillTimer();
      try {
        this.child.kill("SIGTERM");
      } catch (err) {
        log.debug("docker log session kill before restart", {
          sessionId: this.sessionId,
          err: (err as Error)?.message,
        });
      }
      this.child = null;
    }

    const tailArg = String(this.options.tail);
    const dockerArgs = [
      "--context",
      this.contextName,
      "logs",
      "-f",
      "--tail",
      tailArg,
      ...(this.options.timestamps ? ["--timestamps"] : []),
      this.containerId,
    ];

    try {
      if (this.backend.type === "host") {
        this.child = spawn(this.backend.file, dockerArgs, { windowsHide: true });
      } else {
        const command = ["docker", ...dockerArgs.map(quotePosixArg)].join(" ");
        this.child = spawn(this.backend.file, [...this.backend.argsPrefix, command], {
          windowsHide: true,
        });
      }
    } catch (err) {
      // spawn() itself can synchronously throw on ENOENT-ish failures.
      log.warn("docker log session spawn threw", {
        sessionId: this.sessionId,
        err: (err as Error)?.message,
      });
      this.emit("error", err as Error);
      this.emit("close", 1);
      return;
    }

    this.child.stdout?.on("data", (b: Buffer) => this.emit("data", b));
    this.child.stderr?.on("data", (b: Buffer) => this.emit("data", b));
    this.child.on("close", (code) => {
      this.clearKillTimer();
      this.child = null;
      this.emit("close", code);
      // Restart can be scheduled while the previous child was still alive;
      // honor it now that we know the old one is fully gone.
      if (this.restartScheduled) {
        this.restartScheduled = false;
        this.start();
      } else {
        log.debug("docker log session closed", { sessionId: this.sessionId, code });
      }
    });
    this.child.on("error", (err) => {
      log.warn("docker log session runtime error", {
        sessionId: this.sessionId,
        err: err.message,
      });
      this.emit("error", err);
      // node will emit "close" after "error", so we leave the close handler
      // to do the lifecycle bookkeeping.
    });

    log.debug("docker log session started", {
      sessionId: this.sessionId,
      containerId: this.containerId,
      tail: this.options.tail,
      timestamps: this.options.timestamps,
    });
  }

  /**
   * Update streaming options and respawn. Buffered output downstream of this
   * (e.g. xterm scrollback in the renderer) is the caller's responsibility —
   * we just give it a fresh stream.
   */
  restart(options: LogStreamOptions): void {
    this.options = {
      timestamps: options.timestamps ?? this.options.timestamps,
      tail: options.tail ?? this.options.tail,
    };
    if (this.child) {
      this.restartScheduled = true;
      this.stop();
    } else {
      this.start();
    }
  }

  stop(): void {
    if (!this.child) return;
    try {
      this.child.kill("SIGTERM");
    } catch (err) {
      log.debug("docker log session kill threw", {
        sessionId: this.sessionId,
        err: (err as Error)?.message,
      });
    }
    // WSL: docker logs -f may not die on SIGTERM; follow up with SIGINT after 500 ms.
    if (this.backend.type === "wsl") {
      this.killTimer = setTimeout(() => {
        try {
          this.child?.kill("SIGINT");
        } catch {
          // already gone — no-op
        }
      }, 500);
    }
  }

  private clearKillTimer(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }
}

export class DockerLogManager {
  private sessions = new Map<string, DockerLogSession>();

  openSession(
    sessionId: string,
    backend: LogBackend,
    contextName: string,
    containerId: string,
    onData: (sessionId: string, data: Buffer) => void,
    onClose: (sessionId: string, code: number | null) => void,
    options: LogStreamOptions = {},
  ): void {
    this.closeSession(sessionId);

    const session = new DockerLogSession(sessionId, backend, contextName, containerId, options);
    session.on("data", (data: Buffer) => onData(sessionId, data));
    session.on("close", (code: number | null) => {
      // The session may still be in our map if the close was triggered by a
      // pending restart; the session itself will respawn. Only drop from the
      // map when the session has truly given up (child === null AND no
      // restartScheduled). We can't see those fields from out here, so we
      // simply leave the lifecycle to closeSession() / shutdown. If the
      // backend log session restart fires, the renderer will see two close
      // events — which is fine; it'll just re-show "reattaching…".
      onClose(sessionId, code);
    });
    session.on("error", (err: Error) => {
      log.warn("docker log session error surfaced", { sessionId, err: err.message });
    });

    this.sessions.set(sessionId, session);
    session.start();
  }

  /** Update the stream options of an existing session (or no-op if missing). */
  updateSession(sessionId: string, options: LogStreamOptions): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.restart(options);
    return true;
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.stop();
    this.sessions.delete(sessionId);
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.stop();
    }
    this.sessions.clear();
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  hasAnySessions(): boolean {
    return this.sessions.size > 0;
  }
}

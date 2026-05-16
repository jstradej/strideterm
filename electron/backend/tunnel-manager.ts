/// <reference types="node" />
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { execFileText } from "./process-utils.js";
import { getLogger } from "./logger.js";
import { APP_CONFIG } from "../../config/app-config.js";

const log = getLogger("tunnel");

const QUICK_TUNNEL_URL = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;

// Shown to the user (and embedded into error messages) whenever cloudflared
// is missing or fails to start. Kept here so the UI hint and the snapshot
// error stay in sync.
export const CLOUDFLARED_DOWNLOAD_URL = "https://developers.cloudflare.com/tunnel/downloads/";

// Cap on how much cloudflared output we keep buffered for the post-mortem
// error message. The full stream still goes to the log via log.debug; this
// is purely the tail we surface back to the UI.
const OUTPUT_BUFFER_MAX_BYTES = 8 * 1024;
const ERROR_TAIL_LINES = 6;

interface TunnelSnapshot {
  available: boolean;
  status: string;
  mode: string;
  publicUrl: string;
  localUrl: string;
  error: string;
  startedAt: string | null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createSnapshot(overrides: Partial<TunnelSnapshot> = {}): TunnelSnapshot {
  return {
    available: false,
    status: "idle",
    mode: APP_CONFIG.tunnel.mode,
    publicUrl: "",
    localUrl: "",
    error: "",
    startedAt: null,
    ...overrides,
  };
}

function resolveCloudflaredBinary(preferredBinary = ""): string {
  // Defense-in-depth on top of the multi-transport filter
  // (REMOTE_BLOCKED_REMOTE_ACCESS_FIELDS in remote-server.ts) that already
  // prevents a leaked-token attacker from setting this path. If that filter
  // ever regresses and we get a bogus path here, the existsSync gate makes us
  // fall through to the candidate search instead of trusting it — so spawn
  // never runs an attacker-pointed-at-but-missing binary, and refreshAvailability
  // surfaces a clean "not found on PATH" error to the user.
  if (preferredBinary) {
    if (existsSync(preferredBinary)) {
      log.debug("resolved cloudflared via user preference", { binary: preferredBinary });
      return preferredBinary;
    }
    log.warn("configured cloudflared binary does not exist on disk; falling back to PATH lookup", {
      binary: preferredBinary,
    });
  }

  const candidates = APP_CONFIG.tunnel.binaries;
  const resolved =
    candidates.find((candidate) => candidate === "cloudflared" || existsSync(candidate)) || "cloudflared";
  log.debug("resolved cloudflared via candidate list", { binary: resolved, candidates });
  return resolved;
}

function appendToBuffer(buffer: string, chunk: string): string {
  const combined = buffer + chunk;
  if (combined.length <= OUTPUT_BUFFER_MAX_BYTES) {
    return combined;
  }
  return combined.slice(combined.length - OUTPUT_BUFFER_MAX_BYTES);
}

function tailLines(buffer: string, count = ERROR_TAIL_LINES): string {
  const lines = buffer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-count).join(" | ");
}

function buildDownloadHint(preferredBinary: string): string {
  return preferredBinary
    ? `Configured cloudflared binary could not be started (path: ${preferredBinary}). Verify the path or download a fresh build from ${CLOUDFLARED_DOWNLOAD_URL}`
    : `cloudflared was not found on PATH. Install it from ${CLOUDFLARED_DOWNLOAD_URL} or set its full path in Settings → Cloudflared binary.`;
}

export function extractQuickTunnelUrl(rawText: unknown): string {
  const match = String(rawText || "").match(QUICK_TUNNEL_URL);
  return match?.[1] || "";
}

export class CloudflareTunnelManager extends EventEmitter {
  private snapshot: TunnelSnapshot;
  private processHandle: ChildProcess | null;
  private stopRequested: boolean;
  private binaryPreference: string;
  private binary: string;

  constructor({ binaryPath = "" }: { binaryPath?: string } = {}) {
    super();
    this.snapshot = createSnapshot();
    this.processHandle = null;
    this.stopRequested = false;
    this.binaryPreference = String(binaryPath || "").trim();
    this.binary = resolveCloudflaredBinary(this.binaryPreference);
  }

  getSnapshot(): TunnelSnapshot {
    return clone(this.snapshot);
  }

  setBinaryPreference(binaryPath = ""): void {
    const next = String(binaryPath || "").trim();
    if (next === this.binaryPreference) {
      return;
    }
    log.info("cloudflared binary preference changed", {
      from: this.binaryPreference || "(none)",
      to: next || "(none)",
    });
    this.binaryPreference = next;
    this.binary = resolveCloudflaredBinary(this.binaryPreference);
  }

  async refreshAvailability(): Promise<TunnelSnapshot> {
    this.binary = resolveCloudflaredBinary(this.binaryPreference);
    log.debug("refreshing cloudflared availability", {
      binary: this.binary,
      preference: this.binaryPreference || "(none)",
    });
    try {
      const { stdout, stderr } = await execFileText(this.binary, ["--version"]);
      const version = (stdout || stderr || "").split(/\r?\n/)[0]?.trim() || "(unknown)";
      log.info("cloudflared available", { binary: this.binary, version });
      this.snapshot = {
        ...this.snapshot,
        available: true,
        error: this.snapshot.status === "idle" ? "" : this.snapshot.error,
      };
    } catch (rawError: unknown) {
      // execFileText rejects with { error, stdout, stderr }. Surface every
      // useful field — the colleague's "chyba 1" was cloudflared exiting
      // with code 1 and the actual reason sitting in stderr, never logged.
      const errObj = rawError as { error?: Error & { code?: string | number }; stdout?: string; stderr?: string };
      log.warn("cloudflared --version failed", {
        binary: this.binary,
        preference: this.binaryPreference || "(none)",
        errCode: errObj?.error?.code,
        errMessage: errObj?.error?.message,
        stdout: (errObj?.stdout || "").trim(),
        stderr: (errObj?.stderr || "").trim(),
      });
      this.snapshot = createSnapshot({
        ...this.snapshot,
        available: false,
        status: this.processHandle ? this.snapshot.status : "idle",
        error: buildDownloadHint(this.binaryPreference),
      });
    }

    this.emit("updated", this.getSnapshot());
    return this.getSnapshot();
  }

  async startQuickTunnel(localUrl: string): Promise<TunnelSnapshot> {
    log.info("startQuickTunnel requested", { localUrl, binary: this.binary });
    await this.refreshAvailability();
    if (!this.snapshot.available) {
      log.error("cannot start quick tunnel — cloudflared unavailable", {
        binary: this.binary,
        preference: this.binaryPreference || "(none)",
        snapshotError: this.snapshot.error,
      });
      throw new Error(
        this.snapshot.error || `cloudflared is unavailable. Download it from ${CLOUDFLARED_DOWNLOAD_URL}`,
      );
    }

    await this.stop({ preserveAvailability: true, quiet: true });

    const args = ["tunnel", "--url", localUrl, "--no-autoupdate"];
    log.info("spawning cloudflared", { binary: this.binary, args, localUrl });

    this.stopRequested = false;
    this.processHandle = spawn(this.binary, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = this.processHandle.pid;
    log.debug("cloudflared spawned", { pid });

    this.snapshot = createSnapshot({
      ...this.snapshot,
      available: true,
      status: "connecting",
      localUrl,
      publicUrl: "",
      error: "",
      startedAt: new Date().toISOString(),
    });
    this.emit("updated", this.getSnapshot());

    return new Promise((resolve, reject) => {
      let settled = false;
      // Rolling buffer of everything cloudflared has emitted so far. Used
      // for the post-mortem in error paths (timeout, unexpected exit) —
      // every line is also forwarded to the application log in real time.
      let outputBuffer = "";

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        const tail = tailLines(outputBuffer);
        log.error("cloudflared did not report a public URL before timeout", {
          pid,
          timeoutMs: APP_CONFIG.tunnel.connectTimeoutMs,
          outputTail: tail || "(no output captured)",
        });
        this.stop({ preserveAvailability: true, quiet: true }).catch(() => {});
        const baseMessage = `Quick tunnel did not report a public URL within ${APP_CONFIG.tunnel.connectTimeoutMs}ms.`;
        reject(new Error(tail ? `${baseMessage} Last cloudflared output: ${tail}` : baseMessage));
      }, APP_CONFIG.tunnel.connectTimeoutMs);

      const logStreamChunk = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
        const text = chunk.toString();
        outputBuffer = appendToBuffer(outputBuffer, text);
        // cloudflared emits one log record per line; split so each line
        // lands as its own entry rather than a multi-line blob.
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) {
            log.debug(`cloudflared ${stream}`, { pid, line: trimmed });
          }
        }
      };

      const handleOutput = (stream: "stdout" | "stderr") => (chunk: Buffer | string) => {
        logStreamChunk(stream, chunk);
        const url = extractQuickTunnelUrl(chunk.toString());
        if (!url || settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        log.info("cloudflared quick tunnel connected", { pid, publicUrl: url, localUrl });
        this.snapshot = createSnapshot({
          ...this.snapshot,
          available: true,
          status: "connected",
          publicUrl: url,
          localUrl,
          error: "",
        });
        this.emit("updated", this.getSnapshot());
        resolve(this.getSnapshot());
      };

      const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
        this.processHandle = null;
        clearTimeout(timeout);
        const wasRequested = this.stopRequested;
        this.stopRequested = false;

        if (wasRequested) {
          log.info("cloudflared stopped on request", { pid, code, signal });
          this.snapshot = createSnapshot({
            available: this.snapshot.available,
            error: "",
          });
          this.emit("updated", this.getSnapshot());
          if (!settled) {
            settled = true;
            resolve(this.getSnapshot());
          }
          return;
        }

        const tail = tailLines(outputBuffer);
        log.error("cloudflared exited unexpectedly", {
          pid,
          code,
          signal,
          outputTail: tail || "(no output captured)",
        });

        const baseMessage =
          code !== null
            ? `cloudflared exited with code ${code}.`
            : signal
              ? `cloudflared was terminated by signal ${signal}.`
              : "cloudflared exited unexpectedly.";
        const message = tail ? `${baseMessage} Last output: ${tail}` : baseMessage;
        this.snapshot = createSnapshot({
          available: this.snapshot.available,
          error: message,
        });
        this.emit("updated", this.getSnapshot());
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      };

      this.processHandle!.stdout?.on("data", handleOutput("stdout"));
      this.processHandle!.stderr?.on("data", handleOutput("stderr"));
      this.processHandle!.once("exit", handleExit);
      this.processHandle!.once("error", (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.processHandle = null;
        log.error("failed to launch cloudflared", {
          binary: this.binary,
          preference: this.binaryPreference || "(none)",
          errMessage: error.message,
          errCode: (error as NodeJS.ErrnoException).code,
        });
        const message =
          error.message ||
          `Failed to launch cloudflared. Verify the binary or download a fresh build from ${CLOUDFLARED_DOWNLOAD_URL}`;
        this.snapshot = createSnapshot({
          available: this.snapshot.available,
          error: message,
        });
        this.emit("updated", this.getSnapshot());
        reject(new Error(message));
      });
    });
  }

  // Surface a pre-flight failure from outside the manager (e.g. origin
  // probe rejected before we even spawned cloudflared). Resets status to
  // idle so the UI doesn't linger on "connecting…" and writes `error`
  // so the inline error banner can render it.
  applyExternalError(message: string): void {
    this.snapshot = {
      ...this.snapshot,
      status: "idle",
      error: message || "",
    };
    this.emit("updated", this.getSnapshot());
  }

  // Reflect "attempting to connect" in the snapshot before cloudflared
  // is spawned — used while probing the local origin so the chip flips
  // to "connecting" immediately instead of after the 4s preflight wait.
  applyExternalConnecting(): void {
    this.snapshot = {
      ...this.snapshot,
      status: "connecting",
      error: "",
    };
    this.emit("updated", this.getSnapshot());
  }

  async stop({
    preserveAvailability = false,
    quiet = false,
  }: { preserveAvailability?: boolean; quiet?: boolean } = {}): Promise<TunnelSnapshot> {
    if (!this.processHandle) {
      this.snapshot = createSnapshot({
        available: preserveAvailability ? this.snapshot.available : false,
        error: preserveAvailability ? "" : this.snapshot.error,
      });
      if (!quiet) {
        this.emit("updated", this.getSnapshot());
      }
      return this.getSnapshot();
    }

    const processHandle = this.processHandle;
    log.info("stopping cloudflared", { pid: processHandle.pid, preserveAvailability, quiet });
    this.stopRequested = true;
    processHandle.kill();
    await once(processHandle, "exit").catch(() => {});
    this.processHandle = null;
    this.snapshot = createSnapshot({
      available: preserveAvailability ? this.snapshot.available : false,
      error: "",
    });
    if (!quiet) {
      this.emit("updated", this.getSnapshot());
    }
    return this.getSnapshot();
  }
}

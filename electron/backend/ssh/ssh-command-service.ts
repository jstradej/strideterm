import { randomUUID } from "node:crypto";
import type { Client, ClientChannel } from "ssh2";
import { SshManager } from "./ssh-manager.js";

const OPERATION_PREFIX = "ssh-mcp:";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_COMMAND_LENGTH = 8_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_GLOBAL_OPERATIONS = 8;

type HostRecord = NonNullable<ReturnType<SshManager["getHost"]>>;
type LaunchMode = "ssh2" | "system-ssh" | "wsl";

export interface SshMcpHostSummary {
  id: string;
  name: string;
  host: string;
  username: string;
  port: number;
  methods: string[];
}

export interface SshMcpCommandResult {
  hostId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
}

export class SshMcpError extends Error {
  code: "setup_required" | "unsupported_host" | "busy" | "cancelled" | "timeout" | "invalid_request";

  constructor(code: SshMcpError["code"], message: string) {
    super(message);
    this.name = "SshMcpError";
    this.code = code;
  }
}

export interface SshCommandServiceOptions {
  sshManager: SshManager;
  getEffectiveLaunchMode: (_host: HostRecord) => LaunchMode;
}

interface ActiveOperation {
  rejectSetup: (_error: SshMcpError) => void;
  abort: () => void;
}

function safeHostSummary(host: HostRecord): SshMcpHostSummary {
  return {
    id: host.id,
    name: host.name || host.host,
    host: host.host,
    username: host.username || "",
    port: host.port || 22,
    methods: Array.isArray(host.auth?.methods) ? [...host.auth.methods] : [],
  };
}

function collectText(
  chunks: Buffer[],
  value: Buffer | string,
  currentBytes: number,
): { bytes: number; truncated: boolean } {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const available = Math.max(0, MAX_OUTPUT_BYTES - currentBytes);
  const kept = chunk.subarray(0, available);
  if (kept.length) chunks.push(kept);
  return { bytes: currentBytes + kept.length, truncated: kept.length < chunk.length };
}

export function createSshCommandService({ sshManager, getEffectiveLaunchMode }: SshCommandServiceOptions) {
  const active = new Map<string, ActiveOperation>();

  const failForPrompt = (sessionId: unknown, kind: "auth" | "host-key") => {
    if (typeof sessionId !== "string" || !sessionId.startsWith(OPERATION_PREFIX)) return;
    const operation = active.get(sessionId);
    if (!operation) return;
    const detail =
      kind === "host-key"
        ? "Host key must be verified in SSH Settings before using agent SSH tools."
        : "Saved SSH credentials need attention. Complete the connection test in SSH Settings before using agent SSH tools.";
    operation.rejectSetup(new SshMcpError("setup_required", detail));
    operation.abort();
    void sshManager.stop(sessionId);
  };

  const onAuthPrompt = (event: { sessionId?: unknown }) => failForPrompt(event?.sessionId, "auth");
  const onHostKeyChange = (event: { sessionId?: unknown }) => failForPrompt(event?.sessionId, "host-key");
  sshManager.on("ssh:auth-prompt", onAuthPrompt);
  sshManager.on("ssh:host-key-change", onHostKeyChange);

  function getEligibleHost(hostId: string): HostRecord {
    const host = sshManager.getHost(hostId);
    if (!host)
      throw new SshMcpError(
        "unsupported_host",
        "Saved SSH host was not found. Refresh the SSH host list and try again.",
      );
    if (getEffectiveLaunchMode(host) !== "ssh2") {
      throw new SshMcpError(
        "unsupported_host",
        "This host uses System SSH or WSL. Agent SSH tools currently support Built-in SSH hosts only.",
      );
    }
    return host;
  }

  function listHosts(): SshMcpHostSummary[] {
    return sshManager
      .listHosts()
      .filter((host) => getEffectiveLaunchMode(host) === "ssh2")
      .map(safeHostSummary);
  }

  async function runCommand({
    hostId,
    command,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  }: {
    hostId: string;
    command: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<SshMcpCommandResult> {
    if (!hostId.trim() || !command.trim() || command.length > MAX_COMMAND_LENGTH) {
      throw new SshMcpError(
        "invalid_request",
        `Host ID and command are required; command limit is ${MAX_COMMAND_LENGTH} characters.`,
      );
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new SshMcpError("invalid_request", `Timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds.`);
    }
    if (active.size >= MAX_GLOBAL_OPERATIONS)
      throw new SshMcpError("busy", "Too many SSH commands are running. Try again shortly.");
    if (signal?.aborted) throw new SshMcpError("cancelled", "SSH command was cancelled.");

    getEligibleHost(hostId);
    const sessionId = `${OPERATION_PREFIX}${randomUUID()}`;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    const channelRef: { current: ClientChannel | null } = { current: null };
    let timedOut = false;
    let setupError: SshMcpError | null = null;
    let rejectSetup!: (_error: SshMcpError) => void;
    const setupFailure = new Promise<never>((_, reject) => (rejectSetup = reject));

    const abort = () => {
      channelRef.current?.close();
      void sshManager.stop(sessionId).catch(() => {});
    };
    const operation: ActiveOperation = {
      rejectSetup: (error) => {
        setupError = error;
        rejectSetup(error);
      },
      abort,
    };
    active.set(sessionId, operation);

    const cancel = () => {
      abort();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const timeoutHandle: ReturnType<typeof setTimeout> = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeoutMs);
    timeoutHandle.unref?.();

    try {
      const connect = sshManager.createSession({
        sessionId,
        hostId,
        cols: 80,
        rows: 24,
        authOnly: true,
        skipLastConnectedAt: false,
        authenticatedActionTimeoutMs: timeoutMs,
        onAuthenticated: async (client: Client) => {
          if (signal?.aborted) throw new SshMcpError("cancelled", "SSH command was cancelled.");
          if (timedOut) throw new SshMcpError("timeout", "SSH command timed out.");
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error) => {
              if (settled) return;
              settled = true;
              signal?.removeEventListener("abort", onAbort);
              if (error) reject(error);
              else resolve();
            };
            const onAbort = () => {
              channelRef.current?.close();
              finish(
                timedOut
                  ? new SshMcpError("timeout", "SSH command timed out.")
                  : new SshMcpError("cancelled", "SSH command was cancelled."),
              );
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            try {
              client.exec(command, { pty: false }, (error, stream) => {
                if (error) return finish(error);
                channelRef.current = stream;
                if (signal?.aborted || timedOut) {
                  stream.close();
                  return finish(
                    timedOut
                      ? new SshMcpError("timeout", "SSH command timed out.")
                      : new SshMcpError("cancelled", "SSH command was cancelled."),
                  );
                }
                stream.on("data", (data: Buffer | string) => {
                  const result = collectText(stdout, data, stdoutBytes);
                  stdoutBytes = result.bytes;
                  truncated ||= result.truncated;
                });
                stream.stderr.on("data", (data: Buffer | string) => {
                  const result = collectText(stderr, data, stderrBytes);
                  stderrBytes = result.bytes;
                  truncated ||= result.truncated;
                });
                stream.on("exit", (code: number | null, sig: string | null) => {
                  exitCode = typeof code === "number" ? code : null;
                  exitSignal = sig || null;
                });
                stream.on("error", (streamError: Error) => finish(streamError));
                stream.on("close", (code: number | null, sig: string | null) => {
                  if (exitCode === null && typeof code === "number") exitCode = code;
                  if (!exitSignal && sig) exitSignal = sig;
                  finish();
                });
              });
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
            }
          });
        },
      });

      await Promise.race([connect, setupFailure]);
      if (signal?.aborted) throw new SshMcpError("cancelled", "SSH command was cancelled.");
      if (timedOut) {
        return {
          hostId,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: null,
          signal: null,
          timedOut: true,
          truncated,
        };
      }
      if (setupError) throw setupError;
      return {
        hostId,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal: exitSignal,
        timedOut,
        truncated,
      };
    } catch (error) {
      if (setupError) throw setupError;
      if (timedOut) {
        return {
          hostId,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: null,
          signal: null,
          timedOut: true,
          truncated,
        };
      }
      if (signal?.aborted) throw new SshMcpError("cancelled", "SSH command was cancelled.");
      if (error instanceof SshMcpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/host key|fingerprint|verify|verification/i.test(message)) {
        throw new SshMcpError(
          "setup_required",
          "Host key must be verified in SSH Settings before using agent SSH tools.",
        );
      }
      if (/auth|password|passphrase|keyboard-interactive|authentication/i.test(message)) {
        throw new SshMcpError(
          "setup_required",
          "Saved SSH credentials need attention. Complete the connection test in SSH Settings before using agent SSH tools.",
        );
      }
      throw new SshMcpError(
        "setup_required",
        `SSH connection failed. Check the saved host and run its connection test in SSH Settings. (${message})`,
      );
    } finally {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", cancel);
      active.delete(sessionId);
      channelRef.current?.close();
      await sshManager.stop(sessionId).catch(() => {});
    }
  }

  return {
    listHosts,
    runCommand,
    close() {
      sshManager.off("ssh:auth-prompt", onAuthPrompt);
      sshManager.off("ssh:host-key-change", onHostKeyChange);
      for (const [sessionId, operation] of active) {
        operation.rejectSetup(new SshMcpError("cancelled", "SSH command service is shutting down."));
        operation.abort();
        void sshManager.stop(sessionId);
      }
    },
  };
}

export { DEFAULT_TIMEOUT_MS as SSH_MCP_DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS as SSH_MCP_MAX_TIMEOUT_MS };

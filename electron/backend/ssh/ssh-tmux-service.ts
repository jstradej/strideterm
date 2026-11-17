import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { Client } from "ssh2";
import { z } from "zod";
import {
  buildSshTmuxPreviewCommand,
  normalizeSshTmuxName,
  SSH_TMUX_NO_MATCH_EXIT,
  SSH_TMUX_OUTPUT_MARKER,
  type SshTmuxFailure,
  type SshTmuxListInput,
  type SshTmuxListResult,
  type SshTmuxPreviewResult,
  type SshTmuxSession,
} from "../../shared/ssh-tmux.js";
import type { SshManager } from "./ssh-manager.js";

const SESSION_PREFIX = "ssh-tmux:";
const LIST_PREFIX = "strideterm-tmux\t";
export const SSH_TMUX_LIST_COMMAND = `printf '%s' '${SSH_TMUX_OUTPUT_MARKER}'; LC_ALL=C tmux -u list-sessions -F '${LIST_PREFIX}#{session_windows}\t#{session_attached}\t#{session_activity}\t#{session_name}'`;
const OPERATION_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_OPERATIONS = 6;
const MAX_WINDOW_OPERATIONS = 2;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

const hostIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim().length > 0);
const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_-]+$/i);
const listSchema = z.strictObject({ hostId: hostIdSchema, requestId: requestIdSchema.optional() });
const previewSchema = listSchema.extend({ name: z.string().refine((name) => normalizeSshTmuxName(name) !== null) });
const cancelSchema = z.strictObject({ requestId: requestIdSchema });

type Host = NonNullable<ReturnType<SshManager["getHost"]>>;
type ExternalMode = "system-ssh" | "wsl";
type Probe = {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanupFn: () => Promise<void>;
};

type Owner = { windowId: string; profileId: string };
type Operation = Owner & { requestId?: string; cancel: () => boolean };

class TmuxProbeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function failure(error: string, message: string): SshTmuxFailure {
  return { ok: false, error, message };
}

const cancelled = () => new TmuxProbeError("cancelled", "The tmux request was cancelled.");
const timedOut = () =>
  new TmuxProbeError("timeout", "The tmux request timed out. Check the SSH connection and try again.");

export function isSshTmuxSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && sessionId.startsWith(SESSION_PREFIX);
}

function parseInteger(source: string | undefined): number | null {
  if (!source || !/^\d+$/.test(source)) return null;
  const value = Number(source);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseSshTmuxSessions(output: string): SshTmuxSession[] {
  const sessions = new Map<string, SshTmuxSession>();
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith(LIST_PREFIX)) continue;
    const [windowsText, attachedText, activityText, rawName, ...extraFields] = line
      .slice(LIST_PREFIX.length)
      .split("\t");
    const name = normalizeSshTmuxName(rawName);
    const windows = parseInteger(windowsText);
    const attached = parseInteger(attachedText);
    if (name === null || windows === null || attached === null || extraFields.length) continue;
    const seconds = parseInteger(activityText);
    const milliseconds = seconds === null ? null : seconds * 1000;
    sessions.set(name, {
      name,
      windows,
      attached: attached > 0,
      lastActivityAt: Number.isSafeInteger(milliseconds) ? milliseconds : null,
    });
  }
  return [...sessions.values()];
}

function boundedOutput(limit: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    append(data: Buffer | string) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const kept = chunk.subarray(0, limit - bytes);
      if (kept.length) chunks.push(kept);
      bytes += kept.length;
      truncated ||= kept.length < chunk.length;
    },
    read() {
      return { text: Buffer.concat(chunks, bytes).toString("utf8"), truncated };
    },
  };
}

function commandOutput() {
  const stdout = boundedOutput(MAX_STDOUT_BYTES);
  const stderr = boundedOutput(MAX_STDERR_BYTES);
  return {
    stdout: stdout.append,
    stderr: stderr.append,
    result(exitCode: number | null) {
      const output = stdout.read();
      return { exitCode, output: output.text, truncated: output.truncated, stderr: stderr.read().text };
    },
  };
}

type CommandResult = ReturnType<ReturnType<typeof commandOutput>["result"]>;

function execBuiltin(client: Client, command: string, signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const output = commandOutput();
    let exitCode: number | null = null;
    let closeChannel: (() => void) | undefined;
    const abort = () => {
      closeChannel?.();
      reject(signal.reason);
    };
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(output.result(exitCode));
    };
    signal.addEventListener("abort", abort, { once: true });
    client.exec(command, { pty: false }, (error, stream) => {
      if (error) return finish(error);
      closeChannel = () => stream.close();
      if (signal.aborted) {
        stream.close();
        return;
      }
      stream.on("data", output.stdout);
      stream.stderr.on("data", output.stderr);
      stream.on("error", finish);
      stream.stderr.on("error", finish);
      stream.on("exit", (code: unknown) => {
        if (typeof code === "number") exitCode = code;
      });
      stream.on("close", (code: unknown) => {
        if (typeof code === "number") exitCode ??= code;
        finish();
      });
    });
  });
}

function execExternal(probe: Probe, signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const output = commandOutput();
    const detached = process.platform !== "win32";
    const child = spawn(probe.file, probe.args, {
      env: probe.env,
      signal,
      killSignal: "SIGKILL",
      detached,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // With no controlling terminal, proxy hops cannot prompt. Stop their process group on cancellation.
    const stopProxies = () => {
      if (!detached || child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The SSH process group already exited.
      }
    };
    signal.addEventListener("abort", stopProxies, { once: true });
    child.stdout.on("data", output.stdout);
    child.stderr.on("data", output.stderr);
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", stopProxies);
      resolve(output.result(code));
    });
  });
}

function connectionFailure(message: string): SshTmuxFailure {
  if (/timed out|timeout/i.test(message)) {
    const error = timedOut();
    return failure(error.code, error.message);
  }
  if (/host key|fingerprint|verification/i.test(message)) {
    return failure("host-key", "SSH host verification failed. Verify the saved host in SSH Settings and try again.");
  }
  if (/cancelled|canceled/i.test(message)) return failure("cancelled", "The SSH authentication prompt was cancelled.");
  if (/permission denied|authenticat|password|passphrase/i.test(message)) {
    return failure(
      "authentication",
      "SSH authentication failed. Check the saved host and credentials in SSH Settings.",
    );
  }
  if (/WSL distribution/i.test(message)) {
    return failure("ssh-unavailable", "The configured WSL distribution is unavailable. Check the SSH host settings.");
  }
  return failure("connection", "Could not connect over SSH. Test the saved host in SSH Settings and try again.");
}

function noServer(result: CommandResult): boolean {
  return (
    result.exitCode === 1 &&
    /(?:^|\n)(?:no server running on |no sessions\s*(?:$|\n)|error connecting to [^\n]+ \((?:No such file or directory|Connection refused)\))/iu.test(
      result.stderr,
    )
  );
}

function commandFailure(result: CommandResult): SshTmuxFailure {
  if (result.exitCode === 127) {
    return failure("tmux-missing", "tmux was not found on the SSH host. Install it or check the remote PATH.");
  }
  if (
    result.exitCode === SSH_TMUX_NO_MATCH_EXIT ||
    noServer(result) ||
    /can't find (?:session|pane)/iu.test(result.stderr)
  ) {
    return failure(
      "session-missing",
      "The tmux session is no longer available. Refresh the session list and try again.",
    );
  }
  if (result.exitCode === 255) return connectionFailure(result.stderr);
  return failure("tmux-command", "The SSH host could not complete the tmux command.");
}

function plainText(output: string): string {
  return stripVTControlCharacters(output).replace(/\p{Cc}/gu, (character) =>
    character === "\n" || character === "\t" ? character : "",
  );
}

function readOutput(output: string): string {
  const marker = output.indexOf(SSH_TMUX_OUTPUT_MARKER);
  if (marker === -1) throw new TmuxProbeError("tmux-command", "The SSH host did not return the expected tmux output.");
  return output.slice(marker + SSH_TMUX_OUTPUT_MARKER.length);
}

export function createSshTmuxService({
  sshManager,
  getEffectiveLaunchMode,
  prepareExternalProbe,
  timeoutMs = OPERATION_TIMEOUT_MS,
}: {
  sshManager: Pick<SshManager, "getHost" | "createSession" | "stop">;
  getEffectiveLaunchMode: (host: Host) => "ssh2" | ExternalMode;
  prepareExternalProbe: (host: Host, command: string, mode: ExternalMode) => Promise<Probe>;
  timeoutMs?: number;
}) {
  const active = new Map<string, Operation>();
  let closed = false;

  function findRequest(requestId: string, owner: Owner): Operation | undefined {
    for (const operation of active.values()) {
      if (
        operation.requestId === requestId &&
        operation.windowId === owner.windowId &&
        operation.profileId === owner.profileId
      ) {
        return operation;
      }
    }
  }

  async function run({ hostId, requestId }: SshTmuxListInput, command: string, owner: Owner): Promise<CommandResult> {
    if (closed) throw cancelled();
    if (!owner.windowId || !owner.profileId)
      throw new TmuxProbeError("desktop-only", "Open the saved SSH host in a desktop window.");
    if (requestId && findRequest(requestId, owner))
      throw new TmuxProbeError("busy", "This tmux request is already running.");
    if (
      active.size >= MAX_OPERATIONS ||
      [...active.values()].filter((entry) => entry.windowId === owner.windowId).length >= MAX_WINDOW_OPERATIONS
    ) {
      throw new TmuxProbeError("busy", "Too many tmux requests are running. Try again shortly.");
    }
    const savedHost = sshManager.getHost(hostId);
    if (!savedHost) throw new TmuxProbeError("host-missing", "The saved SSH host no longer exists.");
    const mode = getEffectiveLaunchMode(savedHost);
    const sessionId = `${SESSION_PREFIX}${randomUUID()}`;
    const controller = new AbortController();
    const { signal } = controller;
    active.set(sessionId, {
      ...owner,
      requestId,
      cancel: () => {
        if (signal.aborted) return false;
        controller.abort(cancelled());
        return true;
      },
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const timer = setTimeout(() => controller.abort(timedOut()), timeoutMs);
    timer.unref?.();

    async function runBuiltin() {
      let result: CommandResult | undefined;
      await sshManager.createSession({
        sessionId,
        hostId,
        cols: 80,
        rows: 24,
        authOnly: true,
        skipLastConnectedAt: true,
        authenticatedActionTimeoutMs: COMMAND_TIMEOUT_MS,
        onAuthenticated: async (client) => {
          result = await execBuiltin(client, command, signal);
        },
      });
      if (!result) throw new Error("SSH closed before the tmux command completed.");
      return result;
    }

    async function runExternal(host: Host, externalMode: ExternalMode) {
      const probe = await prepareExternalProbe(host, command, externalMode);
      try {
        return await execExternal(probe, signal);
      } finally {
        await probe.cleanupFn();
      }
    }

    try {
      return await Promise.race([mode === "ssh2" ? runBuiltin() : runExternal(savedHost, mode), aborted]);
    } finally {
      clearTimeout(timer);
      if (mode === "ssh2") await sshManager.stop(sessionId).catch(() => {});
      active.delete(sessionId);
    }
  }

  function runFailure(error: unknown): SshTmuxFailure {
    if (error instanceof TmuxProbeError) return failure(error.code, error.message);
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return failure("ssh-unavailable", "The configured SSH executable was not found. Check the SSH host settings.");
    }
    return connectionFailure(error instanceof Error ? error.message : "");
  }

  return {
    ownerOf(sessionId: unknown): string | undefined {
      return isSshTmuxSessionId(sessionId) ? active.get(sessionId)?.windowId : undefined;
    },
    async list(payload: unknown, owner: Owner): Promise<SshTmuxListResult> {
      const parsed = listSchema.safeParse(payload);
      if (!parsed.success) return failure("invalid-request", "Choose a saved SSH host.");
      try {
        const result = await run(parsed.data, SSH_TMUX_LIST_COMMAND, owner);
        if (noServer(result)) return { ok: true, sessions: [] };
        if (result.exitCode !== 0) return commandFailure(result);
        if (result.truncated)
          return failure("output-limit", "The SSH host returned too much output to list tmux sessions.");
        return { ok: true, sessions: parseSshTmuxSessions(readOutput(result.output)) };
      } catch (error) {
        return runFailure(error);
      }
    },
    async preview(payload: unknown, owner: Owner): Promise<SshTmuxPreviewResult> {
      const parsed = previewSchema.safeParse(payload);
      if (!parsed.success) return failure("invalid-request", "Choose a valid tmux session on a saved SSH host.");
      try {
        const result = await run(parsed.data, buildSshTmuxPreviewCommand(parsed.data.name), owner);
        if (result.exitCode !== 0) return commandFailure(result);
        return { ok: true, output: plainText(readOutput(result.output)) };
      } catch (error) {
        return runFailure(error);
      }
    },
    cancel(payload: unknown, owner: Owner): boolean {
      const parsed = cancelSchema.safeParse(payload);
      return parsed.success && (findRequest(parsed.data.requestId, owner)?.cancel() ?? false);
    },
    closeWindow(windowId: string) {
      for (const operation of active.values()) if (operation.windowId === windowId) operation.cancel();
    },
    closeStaleWindows(getProfileId: (windowId: string) => string | null) {
      for (const operation of active.values()) {
        if (getProfileId(operation.windowId) !== operation.profileId) operation.cancel();
      }
    },
    close() {
      closed = true;
      for (const operation of active.values()) operation.cancel();
    },
  };
}

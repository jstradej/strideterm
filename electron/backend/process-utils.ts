import { execFile, spawn, type ExecFileOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { getLogger } from "./logger.js";
import { errorMessage } from "../shared/error-message.js";

const log = getLogger("process-utils");

export class ProcessCommandError extends Error {
  readonly _tag = "ProcessCommandError";

  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode: number | null,
    readonly code: string | number | null,
    cause: unknown,
  ) {
    super(errorMessage({ stderr, stdout, message }), { cause });
    this.name = "ProcessCommandError";
  }
}

function processCode(error: unknown): string | number | null {
  if (error === null || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "number" || typeof error.code === "string" ? error.code : null;
}

function processExitCode(error: unknown): number | null {
  const code = processCode(error);
  return typeof code === "number" ? code : null;
}

export function quotePosixArg(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function execFileText(
  file: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        const stdoutText = stdout?.toString?.() || "";
        const stderrText = stderr?.toString?.() || "";
        reject(
          new ProcessCommandError(
            error.message,
            stdoutText,
            stderrText,
            processExitCode(error),
            processCode(error),
            error,
          ),
        );
        return;
      }

      resolve({
        stdout: stdout?.toString?.() || "",
        stderr: stderr?.toString?.() || "",
      });
    });
  });
}

/**
 * Like {@link execFileText}, but streams output as it arrives via `onData`
 * instead of only resolving with the full buffers at the end. Used for
 * long-running commands (e.g. `git push`, which can block for a minute-plus on
 * a pre-push hook) so the UI can show live progress.
 *
 * Nonzero exits and spawn failures reject with `ProcessCommandError`, retaining
 * the cause and output buffers. Retained buffers are capped at `maxBuffer` per
 * stream (front is trimmed, keeping the tail where a hook's error summary
 * lives); `onData` still fires for every chunk regardless of the cap.
 */
export function spawnTextStreaming(
  file: string,
  args: string[],
  options: ExecFileOptions & { onData?: (chunk: string) => void } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { onData, maxBuffer = 10 * 1024 * 1024, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, ...spawnOptions });
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";

    const capFront = (buf: string): string => (buf.length > maxBuffer ? buf.slice(buf.length - maxBuffer) : buf);

    child.stdout?.on("data", (buf: Buffer) => {
      const text = outDecoder.write(buf);
      if (!text) return;
      stdout = capFront(stdout + text);
      onData?.(text);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      const text = errDecoder.write(buf);
      if (!text) return;
      stderr = capFront(stderr + text);
      onData?.(text);
    });

    child.on("error", (error) => {
      reject(new ProcessCommandError(error.message, stdout, stderr, processExitCode(error), processCode(error), error));
    });
    child.on("close", (code) => {
      stdout = capFront(stdout + outDecoder.end());
      stderr = capFront(stderr + errDecoder.end());
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`Command failed: ${file} ${args.join(" ")} (exit code ${code ?? "unknown"})`);
      reject(new ProcessCommandError(error.message, stdout, stderr, code, code, error));
    });
  });
}

export function parseJsonLines(rawText: string): unknown[] {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed: unknown[] = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) {
    log.debug(`parseJsonLines: skipped ${skipped} non-JSON line(s)`, { skipped, total: lines.length });
  }
  return parsed;
}

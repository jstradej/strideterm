import { execFile, spawn, type ExecFileOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { getLogger } from "./logger.js";

const log = getLogger("process-utils");

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
        reject({
          error,
          stdout: stdout?.toString?.() || "",
          stderr: stderr?.toString?.() || "",
        });
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
 * Resolve/reject shapes mirror execFileText so callers can treat both the same:
 * on non-zero exit (or spawn error) it rejects with `{ error, stdout, stderr,
 * exitCode }`. Retained buffers are capped at `maxBuffer` per stream (front is
 * trimmed, keeping the tail where a hook's error summary lives); `onData` still
 * fires for every chunk regardless of the cap.
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
      reject({ error, stdout, stderr });
    });
    child.on("close", (code) => {
      stdout = capFront(stdout + outDecoder.end());
      stderr = capFront(stderr + errDecoder.end());
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error: NodeJS.ErrnoException = new Error(`Command failed: ${file} ${args.join(" ")}`);
      error.code = String(code ?? "");
      reject({ error, stdout, stderr, exitCode: code ?? 1 });
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

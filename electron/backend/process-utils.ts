import { execFile, type ExecFileOptions } from "node:child_process";
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

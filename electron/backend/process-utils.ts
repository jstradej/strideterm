import { execFile, type ExecFileOptions } from "node:child_process";

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
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

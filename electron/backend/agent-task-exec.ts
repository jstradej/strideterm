import { exec } from "node:child_process";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function execCommand(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  const childPromise = new Promise<ExecResult>((resolve) => {
    const child = exec(command, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
  });

  const hardTimeout = new Promise<ExecResult>((resolve) => {
    setTimeout(() => {
      resolve({ exitCode: 1, stdout: "", stderr: `Command timed out after ${timeoutMs}ms` });
    }, timeoutMs + 5000);
  });

  return Promise.race([childPromise, hardTimeout]);
}

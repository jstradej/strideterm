import { exec } from "node:child_process";

export function execCommand(command, cwd, timeoutMs) {
  const childPromise = new Promise((resolve) => {
    const child = exec(command, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
  });

  const hardTimeout = new Promise((resolve) => {
    setTimeout(() => {
      resolve({ exitCode: 1, stdout: "", stderr: `Command timed out after ${timeoutMs}ms` });
    }, timeoutMs + 5000);
  });

  return Promise.race([childPromise, hardTimeout]);
}

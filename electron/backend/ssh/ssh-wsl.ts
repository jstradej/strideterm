/// <reference types="node" />
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WslDistros {
  installed: boolean;
  distros: string[];
  default?: string;
  error?: string;
}

export async function detectWslDistros(): Promise<WslDistros | null> {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync("wsl.exe", ["-l", "-q"], {
      env: { ...process.env, WSL_UTF8: "1" },
      timeout: 5000,
      windowsHide: true,
    });
    const distros = stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\0/g, ""))
      .filter(Boolean);
    if (!distros.length) return { installed: false, distros: [] };

    let defaultDistro = distros[0]!;
    try {
      const { stdout: defaultOut } = await execFileAsync("wsl.exe", ["-l", "-v"], {
        env: { ...process.env, WSL_UTF8: "1" },
        timeout: 5000,
        windowsHide: true,
      });
      const defaultMatch = defaultOut.match(/^\*\s+(\S+)/m);
      if (defaultMatch) defaultDistro = defaultMatch[1]!.replace(/\0/g, "");
    } catch {
      // best-effort
    }

    return {
      installed: true,
      distros,
      default: defaultDistro,
    };
  } catch (err) {
    return { installed: false, distros: [], error: (err as Error).message };
  }
}

/**
 * The distributions that are running right now, or null when WSL cannot say.
 *
 * `wsl -l --running -q` prints bare names, so this reads the same in every Windows display language
 * (the STATE column of `wsl -l -v` is localized). The capability probe asks only running
 * distributions whether they have ssh: `wsl -d <distro> -- …` BOOTS a stopped one, which takes
 * seconds and is a side effect nobody asked for by opening a dialog.
 */
export async function listRunningWslDistros(): Promise<string[] | null> {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync("wsl.exe", ["-l", "--running", "-q"], {
      env: { ...process.env, WSL_UTF8: "1" },
      timeout: 5000,
      windowsHide: true,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\0/g, ""))
      .filter(Boolean);
  } catch {
    // Older WSL builds exit non-zero when nothing runs; either way nothing is known to be running.
    return null;
  }
}

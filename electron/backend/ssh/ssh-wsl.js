import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function detectWslDistros() {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync("wsl.exe", ["-l", "-q"], {
      env: { ...process.env, WSL_UTF8: "1" },
      timeout: 5000,
    });
    const distros = stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\0/g, ""))
      .filter(Boolean);
    if (!distros.length) return { installed: false, distros: [] };

    let defaultDistro = distros[0];
    try {
      const { stdout: defaultOut } = await execFileAsync("wsl.exe", ["-l", "-v"], {
        env: { ...process.env, WSL_UTF8: "1" },
        timeout: 5000,
      });
      const defaultMatch = defaultOut.match(/^\*\s+(\S+)/m);
      if (defaultMatch) defaultDistro = defaultMatch[1].replace(/\0/g, "");
    } catch {}

    return {
      installed: true,
      distros,
      default: defaultDistro,
    };
  } catch (err) {
    return { installed: false, distros: [], error: err.message };
  }
}

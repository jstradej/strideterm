/// <reference types="node" />
import { spawn } from "node:child_process";
import { getLogger } from "./logger.js";

const log = getLogger("fix-path");

/**
 * Inherit PATH from the user's login shell.
 *
 * On macOS, GUI apps launched from Finder/Dock get a degraded PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) that's missing user-installed binaries —
 * brew, mise, nvm, pnpm, custom installs in `~/.local/bin`, etc. The user's
 * actual PATH lives in their shell rc files (`.zshrc`, `.bash_profile`) and
 * is only set when a login shell starts. The same problem affects Linux apps
 * launched from the desktop environment when the rc files set PATH.
 *
 * We spawn `$SHELL -ilc 'echo $PATH'` once at startup and merge the result
 * into `process.env.PATH` so child processes — Claude Code / Codex / Gemini /
 * Copilot / OpenCode detection, Docker, lazydocker, git, btm — see the same
 * PATH as the user's terminal. Without this every "is X installed" probe
 * returns false even when the binary is present in the user's shell.
 *
 * No-op on Windows (env vars there come from the system + user registry, not
 * from a shell rc). Skippable via `STRIDETERM_NO_FIX_PATH=1` for tests.
 */
export async function inheritShellPath(): Promise<void> {
  if (process.platform === "win32") return;
  if (process.env.STRIDETERM_NO_FIX_PATH === "1") return;

  const shell = process.env.SHELL || "/bin/bash";
  try {
    const out = await runLoginShell(shell);
    if (!out) return;
    const fromShell = out.split(":").filter(Boolean);
    const existing = (process.env.PATH || "").split(":").filter(Boolean);
    // Shell PATH wins (user customized it); keep anything Electron added at the end.
    const merged = Array.from(new Set([...fromShell, ...existing])).join(":");
    log.info("inherited PATH from login shell", {
      shell,
      shellEntries: fromShell.length,
      previousEntries: existing.length,
    });
    process.env.PATH = merged;
  } catch (err) {
    log.warn("failed to inherit PATH from login shell — child processes may not find user-installed binaries", {
      shell,
      err: (err as Error).message,
    });
  }
}

function runLoginShell(shell: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // -i (interactive) + -l (login) makes the shell source the same files
    // that load when the user opens Terminal. ELECTRON_RUN_AS_NODE is
    // cleared so the child invokes the actual shell, not the Node binary
    // that Electron embeds.

    const proc = spawn(shell, ["-ilc", "echo $PATH"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`shell exited with code ${code}`));
    });
    // Hard timeout — a misconfigured login shell can hang forever (waiting
    // for prompts, network, etc.). If it can't tell us PATH in 3s, give up.
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("shell timed out"));
    }, 3000);
    proc.on("close", () => clearTimeout(timer));
  });
}

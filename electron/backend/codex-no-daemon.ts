import { getLogger } from "./logger.js";
import { execFileText } from "./process-utils.js";

const log = getLogger("codex-no-daemon");

// Codex >= 0.157 attaches a plain `codex` TUI to a shared daemon that runs hooks and MCP servers with the
// environment of whichever terminal started it, so per-PTY env (session id/token, notify URL) never reaches them.
export const CODEX_NO_DAEMON_MIN_VERSION = "0.157.0";
export const CODEX_NO_DAEMON_FLAG = "--no-daemon";

// Interactive entry points. Every other subcommand is non-interactive and rejects the flag or has no use for it.
const INTERACTIVE_SUBCOMMANDS = new Set(["resume", "fork"]);
const KNOWN_SUBCOMMANDS = new Set([
  "agents",
  "exec",
  "e",
  "review",
  "login",
  "logout",
  "mcp",
  "plugin",
  "app-server",
  "remote-control",
  "app",
  "completion",
  "update",
  "doctor",
  "sandbox",
  "debug",
  "apply",
  "a",
  "resume",
  "queue",
  "archive",
  "delete",
  "migrate-rollouts",
  "migrate-nfs-db",
  "unarchive",
  "fork",
  "cloud",
  "exec-server",
  "features",
  "help",
]);

function parseVersion(version: string): number[] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Whether an interactive Codex launch should get `--no-daemon`. An unknown version counts as modern: a too-old
 * Codex then fails visibly once and the probe result fixes the next launch.
 */
export function shouldAddCodexNoDaemon(args: string[], version: string | null): boolean {
  if (args.some((arg) => arg === CODEX_NO_DAEMON_FLAG || arg === "--remote" || arg.startsWith("--remote="))) {
    return false;
  }
  const first = String(args[0] || "").toLowerCase();
  if (KNOWN_SUBCOMMANDS.has(first) && !INTERACTIVE_SUBCOMMANDS.has(first)) return false;
  const parsed = version ? parseVersion(version) : null;
  if (parsed && compareVersions(parsed, parseVersion(CODEX_NO_DAEMON_MIN_VERSION)!) < 0) return false;
  return true;
}

/**
 * Inserts ` --no-daemon` into the raw command right after the executable token, leaving every other byte as typed
 * (the text goes to cmd / PowerShell / bash, so it must not be re-quoted). Token boundaries follow
 * `tokenizeCommand` in `shared/agent-ssh.ts`.
 */
export function insertCodexNoDaemon(command: string): string {
  let index = 0;
  while (index < command.length && /\s/u.test(command[index])) index += 1;
  let quote = "";
  for (; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"' && ["\\", '"', "'"].includes(command[index + 1] || "")) index += 1;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (/\s/u.test(char)) break;
  }
  return `${command.slice(0, index)} ${CODEX_NO_DAEMON_FLAG}${command.slice(index)}`;
}

export type CodexVersionExec = (
  file: string,
  args: string[],
  options: { timeout: number; shell?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export interface CodexVersionProbe {
  /** Cached version, or null while unknown. The first call for an executable starts one `--version` run. */
  get(executable: string): string | null;
}

export function createCodexVersionProbe({
  exec = execFileText,
  platform = process.platform,
  timeoutMs = 5000,
}: { exec?: CodexVersionExec; platform?: string; timeoutMs?: number } = {}): CodexVersionProbe {
  const cache = new Map<string, string | null>();
  return {
    get(executable) {
      if (cache.has(executable)) return cache.get(executable) ?? null;
      cache.set(executable, null);
      // On Windows `codex` is a .cmd shim, which only a shell can start. The shell gets one command string:
      // args next to `shell: true` are a Node deprecation (DEP0190).
      const win = platform === "win32";
      const file = win && /\s/u.test(executable) ? `"${executable}"` : executable;
      Promise.resolve()
        .then(() =>
          win
            ? exec(`${file} --version`, [], { timeout: timeoutMs, shell: true })
            : exec(file, ["--version"], { timeout: timeoutMs }),
        )
        .then(({ stdout, stderr }) => {
          const match = /\d+\.\d+\.\d+/u.exec(`${stdout}\n${stderr}`);
          if (match) cache.set(executable, match[0]);
          else log.warn("could not read the Codex version", { executable });
        })
        .catch((err: unknown) => {
          log.warn("codex --version failed", { executable, err: (err as Error)?.message || String(err) });
        });
      return null;
    },
  };
}

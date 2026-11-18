/// <reference types="node" />
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
 * We spawn `$SHELL -ilc …` at startup and merge the result into
 * `process.env.PATH` so the processes strIDEterm itself starts — agent CLI
 * detection, git, Docker, lazydocker, btm, task check commands — see the same
 * PATH as the user's terminal. (Agent and custom-launch TABS do not depend on
 * it on POSIX: the session manager starts them through the login shell, which
 * reads PATH itself — `viaLoginShell` in session-manager.ts.)
 *
 * One slow shell start (machine just woke, Spotlight indexing, a network
 * mount in an rc file) must not leave the whole run with the degraded PATH.
 * So:
 *  - the shell is asked more than once, with growing timeouts;
 *  - the last PATH a shell DID report is cached in the data dir and applied
 *    when the shell is slow, while the shell keeps running in the background
 *    and replaces it when it answers;
 *  - the PATH is read between markers, so text an rc file prints to stdout
 *    cannot become a PATH entry, and only absolute entries are kept (a
 *    relative entry such as `.` would resolve binaries from whatever
 *    directory a tab starts in — a repository could shadow `git`).
 *
 * No-op on Windows (env vars there come from the system + user registry, not
 * from a shell rc). Skippable via `STRIDETERM_NO_FIX_PATH=1` for tests.
 */

/** Attempt 1 at startup, attempt 2 only when 1 failed. Worst case without a cache: 20 s. */
export const SHELL_PATH_ATTEMPT_TIMEOUTS_MS = [5_000, 15_000] as const;
/** With a cached PATH, startup waits this long for the shell before going on with the cache. */
export const SHELL_PATH_CACHE_GRACE_MS = 1_500;

const START_MARKER = "__STRIDETERM_PATH_START__";
const END_MARKER = "__STRIDETERM_PATH_END__";
// Fixed command, nothing interpolated into it. printf, not echo: zsh's echo
// interprets backslashes.
const PRINT_PATH_COMMAND = `printf '%s%s%s' '${START_MARKER}' "$PATH" '${END_MARKER}'`;

const MAX_ENTRIES = 512;
const MAX_ENTRY_LENGTH = 4096;

export interface InheritShellPathOptions {
  /** File holding the last PATH a login shell reported (`<dataDir>/shell-path.json`). */
  cacheFile?: string;
  /** Per-attempt timeouts; the default is `SHELL_PATH_ATTEMPT_TIMEOUTS_MS`. */
  attemptTimeoutsMs?: readonly number[];
  /** How long startup waits for the shell when a cache exists; the default is `SHELL_PATH_CACHE_GRACE_MS`. */
  cacheGraceMs?: number;
}

function isEnabled(): boolean {
  return process.platform !== "win32" && process.env.STRIDETERM_NO_FIX_PATH !== "1";
}

/** `$SHELL`, else the account's login shell from the user database, else bash. */
export function resolveLoginShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  try {
    const fromUserDb = os.userInfo().shell;
    if (fromUserDb && path.isAbsolute(fromUserDb)) return fromUserDb;
  } catch {
    // userInfo throws when the uid has no passwd entry; bash is the fallback.
  }
  return "/bin/bash";
}

/**
 * Resolves once PATH is usable for the first spawns:
 *  - the shell answered (the usual case, tens of milliseconds); or
 *  - a cache exists and the shell did not answer within the grace period:
 *    the cached PATH is applied and the SAME shell keeps running to its own
 *    timeout in the background (a slow shell is not killed and restarted), a
 *    second attempt follows if it fails; or
 *  - there is no cache: every attempt is awaited, at most 20 s in total.
 */
export async function inheritShellPath(options: InheritShellPathOptions = {}): Promise<void> {
  if (!isEnabled()) return;

  const shell = resolveLoginShell();
  const timeouts = options.attemptTimeoutsMs?.length ? options.attemptTimeoutsMs : SHELL_PATH_ATTEMPT_TIMEOUTS_MS;
  const basePath = process.env.PATH || "";
  const attempt = (index: number) =>
    runAttempt({ shell, basePath, cacheFile: options.cacheFile }, index + 1, timeouts.length, timeouts[index]);
  const remaining = async (): Promise<boolean> => {
    for (let i = 1; i < timeouts.length; i++) {
      if (await attempt(i)) return true;
    }
    return false;
  };

  const first = attempt(0);
  const cached = options.cacheFile ? readCache(options.cacheFile) : null;

  if (!cached) {
    if ((await first) || (await remaining())) return;
    log.warn("failed to inherit PATH from login shell — child processes may not find user-installed binaries", {
      shell,
    });
    return;
  }

  const grace = options.cacheGraceMs ?? SHELL_PATH_CACHE_GRACE_MS;
  let graceTimer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    first,
    new Promise<"grace">((resolve) => {
      graceTimer = setTimeout(() => resolve("grace"), grace);
    }),
  ]);
  clearTimeout(graceTimer);
  if (outcome === true) return;

  applyPath(cached, basePath, "cache", { shell });
  void (async () => {
    if ((await first) || (await remaining())) return;
    log.warn("login shell never reported PATH — staying on the cached PATH", { shell });
  })();
}

async function runAttempt(
  { shell, basePath, cacheFile }: { shell: string; basePath: string; cacheFile?: string },
  attempt: number,
  of: number,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const entries = await readLoginShellPath(shell, timeoutMs);
    applyPath(entries, basePath, "login shell", { shell, attempt });
    if (cacheFile) writeCache(cacheFile, entries);
    return true;
  } catch (err) {
    log.warn("login shell did not report PATH", { shell, attempt, of, timeoutMs, err: (err as Error).message });
    return false;
  }
}

function applyPath(entries: string[], basePath: string, source: string, meta: Record<string, unknown>): void {
  const existing = basePath.split(":").filter(Boolean);
  // Shell PATH wins (user customized it); keep anything Electron added at the end.
  const merged = Array.from(new Set([...entries, ...existing])).join(":");
  log.info(`inherited PATH from ${source}`, {
    ...meta,
    shellEntries: entries.length,
    previousEntries: existing.length,
  });
  process.env.PATH = merged;
}

/** Keeps absolute, printable entries only; returns `[]` when nothing usable is left. */
export function sanitizePathEntries(raw: string): string[] {
  const out: string[] = [];
  for (const entry of raw.split(":")) {
    if (!entry || entry.length > MAX_ENTRY_LENGTH) continue;
    if (!path.isAbsolute(entry)) continue;
    if (/[\u0000-\u001f\u007f]/.test(entry)) continue;
    if (!out.includes(entry)) out.push(entry);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/** Extracts the PATH printed between the markers; anything an rc file printed around it is ignored. */
export function extractMarkedPath(stdout: string): string | null {
  const start = stdout.lastIndexOf(START_MARKER);
  if (start < 0) return null;
  const from = start + START_MARKER.length;
  const end = stdout.indexOf(END_MARKER, from);
  if (end < 0) return null;
  return stdout.slice(from, end);
}

function readLoginShellPath(shell: string, timeoutMs: number): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    // -i (interactive) + -l (login) makes the shell source the same files
    // that load when the user opens Terminal. ELECTRON_RUN_AS_NODE is
    // cleared so the child invokes the actual shell, not the Node binary
    // that Electron embeds. `detached` puts it in its own process group so a
    // timeout also kills whatever an rc file started.
    const proc = spawn(shell, ["-ilc", PRINT_PATH_COMMAND], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });

    let settled = false;
    let stdout = "";
    const finish = (err: Error | null, value?: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value ?? []);
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      // A PATH is small; a runaway rc file must not grow this without bound.
      if (stdout.length < 1_000_000) stdout += chunk.toString();
    });
    proc.on("error", (err: Error) => finish(err));
    proc.on("close", (code: number | null) => {
      if (code !== 0) return finish(new Error(`shell exited with code ${code}`));
      const marked = extractMarkedPath(stdout);
      if (marked === null) return finish(new Error("shell output carried no PATH marker"));
      const entries = sanitizePathEntries(marked);
      if (entries.length === 0) return finish(new Error("shell reported an empty PATH"));
      finish(null, entries);
    });

    const timer = setTimeout(() => {
      finish(new Error(`shell timed out after ${timeoutMs} ms`));
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }, timeoutMs);
  });
}

function readCache(file: string): string[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { path?: unknown };
    if (typeof parsed?.path !== "string") return null;
    const entries = sanitizePathEntries(parsed.path);
    return entries.length ? entries : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("shell PATH cache unreadable — ignoring it", { err: (err as Error).message });
    }
    return null;
  }
}

function writeCache(file: string, entries: string[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ path: entries.join(":"), savedAt: new Date().toISOString() }), {
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } catch (err) {
    log.warn("could not save shell PATH cache", { err: (err as Error).message });
  }
}

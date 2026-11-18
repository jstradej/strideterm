import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoist mock so the import below picks it up. We replace `child_process.spawn`
// with a fake that drives stdout + close events on demand, letting tests
// exercise inheritShellPath() without spawning a real shell. Each spawn takes
// the next behaviour from the queue (the last one repeats).
type SpawnBehavior = { stdout?: string; exitCode?: number; emitError?: Error; hang?: boolean };
const spawnCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; detached?: boolean }> = [];
let behaviors: SpawnBehavior[] = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string, args: string[], options: { env: NodeJS.ProcessEnv; detached?: boolean }) => {
    spawnCalls.push({ command, args, env: options.env, detached: options.detached });
    const behavior = behaviors.length > 1 ? behaviors.shift()! : (behaviors[0] ?? {});
    const closeListeners: Array<(code: number) => void> = [];
    const errorListeners: Array<(err: Error) => void> = [];
    const stdoutListeners: Array<(chunk: Buffer) => void> = [];
    const proc = {
      stdout: {
        on(event: string, handler: (chunk: Buffer) => void) {
          if (event === "data") stdoutListeners.push(handler);
        },
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        if (event === "close") closeListeners.push(handler as (code: number) => void);
        else if (event === "error") errorListeners.push(handler as (err: Error) => void);
      },
      kill() {
        // simulate timeout-induced kill
        for (const listener of closeListeners) listener(137);
      },
    };
    if (behavior.hang) return proc;
    queueMicrotask(() => {
      if (behavior.emitError) {
        for (const listener of errorListeners) listener(behavior.emitError);
        return;
      }
      if (behavior.stdout) {
        for (const handler of stdoutListeners) handler(Buffer.from(behavior.stdout));
      }
      for (const listener of closeListeners) listener(behavior.exitCode ?? 0);
    });
    return proc;
  }),
}));

vi.mock("./logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { extractMarkedPath, inheritShellPath, sanitizePathEntries } from "./fix-path.js";

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_SHELL = process.env.SHELL;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function marked(p: string, before = "", after = ""): string {
  return `${before}__STRIDETERM_PATH_START__${p}__STRIDETERM_PATH_END__${after}`;
}

let tmpDir: string;

beforeEach(() => {
  spawnCalls.length = 0;
  behaviors = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-path-"));
});

afterEach(() => {
  vi.useRealTimers();
  setPlatform(ORIGINAL_PLATFORM);
  process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_SHELL === undefined) delete process.env.SHELL;
  else process.env.SHELL = ORIGINAL_SHELL;
  delete process.env.STRIDETERM_NO_FIX_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("inheritShellPath", () => {
  test("is a no-op on Windows (PATH is system-managed there)", async () => {
    setPlatform("win32");
    process.env.PATH = "C:\\Windows\\system32";
    await inheritShellPath();
    expect(spawnCalls).toHaveLength(0);
    expect(process.env.PATH).toBe("C:\\Windows\\system32");
  });

  test("is a no-op when STRIDETERM_NO_FIX_PATH=1 (test escape hatch)", async () => {
    setPlatform("darwin");
    process.env.STRIDETERM_NO_FIX_PATH = "1";
    process.env.PATH = "/usr/bin:/bin";
    await inheritShellPath();
    expect(spawnCalls).toHaveLength(0);
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  test("merges shell PATH ahead of existing PATH on macOS", async () => {
    setPlatform("darwin");
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    behaviors = [{ stdout: marked("/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin:/bin") }];

    await inheritShellPath();

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("/bin/zsh");
    expect(spawnCalls[0].args[0]).toBe("-ilc");
    expect(spawnCalls[0].detached).toBe(true);
    // Shell-derived entries should come first; previously-existing ones append; no duplicates.
    expect(process.env.PATH).toBe("/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  test("ignores whatever an rc file prints around the marked PATH", async () => {
    setPlatform("darwin");
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin";
    behaviors = [{ stdout: marked("/opt/homebrew/bin", "Welcome!\n/evil/bin:", "\nbye /x") }];

    await inheritShellPath();

    expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  test("falls back to the account's login shell when SHELL is unset", async () => {
    setPlatform("darwin");
    delete process.env.SHELL;
    process.env.PATH = "/usr/bin";
    behaviors = [{ stdout: marked("/extra:/usr/bin") }];

    await inheritShellPath();

    expect(spawnCalls[0].command).toBe(os.userInfo().shell || "/bin/bash");
    expect(process.env.PATH).toBe("/extra:/usr/bin");
  });

  test("clears ELECTRON_RUN_AS_NODE in the child env so the shell binary runs, not Node", async () => {
    setPlatform("darwin");
    process.env.SHELL = "/bin/zsh";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    behaviors = [{ stdout: marked("/usr/bin") }];

    await inheritShellPath();

    expect(spawnCalls[0].env.ELECTRON_RUN_AS_NODE).toBe("");
    delete process.env.ELECTRON_RUN_AS_NODE;
  });

  test("retries after a timeout instead of giving up on the first slow shell", async () => {
    setPlatform("darwin");
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin";
    behaviors = [{ hang: true }, { stdout: marked("/opt/homebrew/bin") }];

    await inheritShellPath({ attemptTimeoutsMs: [10, 1000] });

    expect(spawnCalls).toHaveLength(2);
    expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  test("caches a reported PATH and applies it when the shell later fails, retrying in the background", async () => {
    setPlatform("darwin");
    process.env.SHELL = "/bin/zsh";
    const cacheFile = path.join(tmpDir, "shell-path.json");

    process.env.PATH = "/usr/bin";
    behaviors = [{ stdout: marked("/opt/homebrew/bin:/Users/u/.local/bin") }];
    await inheritShellPath({ cacheFile, attemptTimeoutsMs: [1000] });
    // The real OS, not the mocked one: Windows has no POSIX file modes.
    if (ORIGINAL_PLATFORM !== "win32") expect(fs.statSync(cacheFile).mode & 0o777).toBe(0o600);

    // Next run: first attempt fails, the cache is applied at once, a later attempt replaces it.
    spawnCalls.length = 0;
    process.env.PATH = "/usr/bin";
    behaviors = [{ exitCode: 1 }, { stdout: marked("/fresh/bin") }];
    await inheritShellPath({ cacheFile, attemptTimeoutsMs: [1000, 1000] });
    expect(process.env.PATH).toBe("/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin");

    await vi.waitFor(() => expect(process.env.PATH).toBe("/fresh/bin:/usr/bin"));
    expect(spawnCalls).toHaveLength(2);
  });

  test("with a cache, a slow shell does not hold up startup and still replaces the cache when it answers", async () => {
    setPlatform("darwin");
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin";
    const cacheFile = path.join(tmpDir, "shell-path.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ path: "/cached/bin" }));
    behaviors = [{ hang: true }];

    const started = Date.now();
    await inheritShellPath({ cacheFile, attemptTimeoutsMs: [60_000], cacheGraceMs: 20 });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(process.env.PATH).toBe("/cached/bin:/usr/bin");
    // The slow shell was not killed and restarted: one spawn only.
    expect(spawnCalls).toHaveLength(1);
  });

  test("ignores a cache entry that is not absolute", async () => {
    setPlatform("darwin");
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin";
    const cacheFile = path.join(tmpDir, "shell-path.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ path: ".:bin:/ok/bin" }));
    behaviors = [{ exitCode: 1 }];

    await inheritShellPath({ cacheFile, attemptTimeoutsMs: [1000] });

    expect(process.env.PATH).toBe("/ok/bin:/usr/bin");
  });

  test("leaves PATH untouched when every attempt fails and there is no cache", async () => {
    setPlatform("darwin");
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin";
    behaviors = [{ exitCode: 1 }];

    await inheritShellPath({ cacheFile: path.join(tmpDir, "missing.json"), attemptTimeoutsMs: [1000, 1000] });

    expect(spawnCalls).toHaveLength(2);
    expect(process.env.PATH).toBe("/usr/bin");
  });

  test("leaves PATH untouched when the spawn errors out", async () => {
    setPlatform("darwin");
    process.env.SHELL = "/missing/shell";
    process.env.PATH = "/usr/bin";
    behaviors = [{ emitError: new Error("ENOENT") }];

    await inheritShellPath({ attemptTimeoutsMs: [1000] });

    expect(process.env.PATH).toBe("/usr/bin");
  });
});

describe("PATH parsing", () => {
  test("extractMarkedPath needs both markers", () => {
    expect(extractMarkedPath(marked("/a:/b", "noise"))).toBe("/a:/b");
    expect(extractMarkedPath("/a:/b")).toBeNull();
    expect(extractMarkedPath("__STRIDETERM_PATH_START__/a")).toBeNull();
  });

  test("sanitizePathEntries keeps absolute, printable, unique entries", () => {
    expect(sanitizePathEntries(".::bin:/a:/a:/b\n/c:/d")).toEqual(["/a", "/d"]);
  });
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoist mock so the import below picks it up. We replace `child_process.spawn`
// with a fake that drives stdout + close events on demand, letting tests
// exercise inheritShellPath() without spawning a real shell.
const spawnCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
let nextSpawnBehavior: { stdout?: string; exitCode?: number; emitError?: Error; hang?: boolean } = {};

vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    spawnCalls.push({ command, args, env: options.env });
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
    if (nextSpawnBehavior.hang) return proc;
    queueMicrotask(() => {
      if (nextSpawnBehavior.emitError) {
        for (const listener of errorListeners) listener(nextSpawnBehavior.emitError);
        return;
      }
      if (nextSpawnBehavior.stdout) {
        for (const handler of stdoutListeners) {
          handler(Buffer.from(nextSpawnBehavior.stdout));
        }
      }
      for (const listener of closeListeners) listener(nextSpawnBehavior.exitCode ?? 0);
    });
    return proc;
  }),
}));

vi.mock("./logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { inheritShellPath } from "./fix-path.js";

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_SHELL = process.env.SHELL;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  spawnCalls.length = 0;
  nextSpawnBehavior = {};
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_SHELL === undefined) delete process.env.SHELL;
  else process.env.SHELL = ORIGINAL_SHELL;
  delete process.env.STRIDETERM_NO_FIX_PATH;
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
    nextSpawnBehavior = {
      stdout: "/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin:/bin\n",
      exitCode: 0,
    };

    await inheritShellPath();

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("/bin/zsh");
    expect(spawnCalls[0].args).toEqual(["-ilc", "echo $PATH"]);
    // Shell-derived entries should come first; previously-existing ones append; no duplicates.
    expect(process.env.PATH).toBe("/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  test("falls back to /bin/bash when SHELL is unset", async () => {
    setPlatform("darwin");
    delete process.env.SHELL;
    process.env.PATH = "/usr/bin";
    nextSpawnBehavior = { stdout: "/extra:/usr/bin\n", exitCode: 0 };

    await inheritShellPath();

    expect(spawnCalls[0].command).toBe("/bin/bash");
    expect(process.env.PATH).toBe("/extra:/usr/bin");
  });

  test("clears ELECTRON_RUN_AS_NODE in the child env so the shell binary runs, not Node", async () => {
    setPlatform("darwin");
    process.env.SHELL = "/bin/zsh";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    nextSpawnBehavior = { stdout: "/usr/bin\n", exitCode: 0 };

    await inheritShellPath();

    expect(spawnCalls[0].env.ELECTRON_RUN_AS_NODE).toBe("");
    delete process.env.ELECTRON_RUN_AS_NODE;
  });

  test("leaves PATH untouched when the shell exits non-zero", async () => {
    setPlatform("darwin");
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin";
    nextSpawnBehavior = { stdout: "", exitCode: 1 };

    await inheritShellPath();

    expect(process.env.PATH).toBe("/usr/bin");
  });

  test("leaves PATH untouched when the spawn errors out", async () => {
    setPlatform("darwin");
    process.env.SHELL = "/missing/shell";
    process.env.PATH = "/usr/bin";
    nextSpawnBehavior = { emitError: new Error("ENOENT") };

    await inheritShellPath();

    expect(process.env.PATH).toBe("/usr/bin");
  });
});

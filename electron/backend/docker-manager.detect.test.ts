import { beforeEach, describe, expect, test, vi } from "vitest";

// Lives in its own file because it mocks process-utils at module level —
// docker-manager.test.ts drives the real module through a subclass and would
// break under the same mock.
const { execFileText, ProcessCommandError } = vi.hoisted(() => {
  class MockProcessCommandError extends Error {
    readonly _tag = "ProcessCommandError";
    constructor(
      message: string,
      readonly stdout: string,
      readonly stderr: string,
      readonly exitCode: number | null,
      readonly code: string | number | null,
      cause: unknown,
    ) {
      super(message, { cause });
    }
  }
  return { execFileText: vi.fn(), ProcessCommandError: MockProcessCommandError };
});
vi.mock("./process-utils.js", () => ({
  execFileText: (...args: unknown[]) => execFileText(...args),
  ProcessCommandError,
  parseJsonLines: () => [],
  quotePosixArg: (v: unknown) => `'${String(v)}'`,
}));

const { DockerManager } = await import("./docker-manager.js");

/** Shape execFileText rejects with when the CLI cannot be spawned. */
function enoent() {
  const cause = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
  return Promise.reject(new ProcessCommandError(cause.message, "", "", null, "ENOENT", cause));
}

/** CLI exists, but the daemon is down — a non-zero exit, NOT a spawn failure. */
function daemonDown() {
  const cause = Object.assign(new Error("exit 1"), { code: 1 });
  return Promise.reject(new ProcessCommandError("exit 1", "", "Cannot connect to the Docker daemon", 1, 1, cause));
}

function callsFor(file: string) {
  return execFileText.mock.calls.filter((c) => c[0] === file).length;
}

describe("detectAllBackends — missing-CLI memo", () => {
  beforeEach(() => {
    execFileText.mockReset();
  });

  test("a CLI that answers ENOENT is not spawned again on the next detection", async () => {
    execFileText.mockImplementation(() => enoent());
    const docker = new DockerManager();

    await docker.detectAllBackends();
    const afterFirst = callsFor("docker");
    expect(afterFirst).toBe(1);

    await docker.detectAllBackends();

    expect(callsFor("docker")).toBe(afterFirst);
  });

  test("a non-zero exit keeps the CLI probed — the daemon can come back on its own", async () => {
    execFileText.mockImplementation(() => daemonDown());
    const docker = new DockerManager();

    await docker.detectAllBackends();
    await docker.detectAllBackends();

    expect(callsFor("docker")).toBe(2);
  });

  test("invalidateBackendDetectionCache() forgets the memo so Refresh re-probes", async () => {
    execFileText.mockImplementation(() => enoent());
    const docker = new DockerManager();

    await docker.detectAllBackends();
    docker.invalidateBackendDetectionCache();
    await docker.detectAllBackends();

    expect(callsFor("docker")).toBe(2);
  });

  test("the memo does not hide a CLI that starts working after an explicit refresh", async () => {
    // Pinned to darwin so `docker` is the only probe and the assertions below
    // describe it alone.
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      execFileText.mockImplementation(() => enoent());
      const docker = new DockerManager();

      expect(await docker.detectAllBackends()).toEqual([]);

      execFileText.mockImplementation(() => Promise.resolve({ stdout: "{}", stderr: "" }));
      docker.invalidateBackendDetectionCache();

      expect(await docker.detectAllBackends()).toEqual([expect.objectContaining({ id: "host" })]);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  test("wsl.exe is probed only on Windows", async () => {
    execFileText.mockImplementation(() => Promise.resolve({ stdout: "{}", stderr: "" }));
    const original = process.platform;

    try {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      await new DockerManager().detectAllBackends();
      expect(callsFor("wsl.exe")).toBe(0);

      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      await new DockerManager().detectAllBackends();
      expect(callsFor("wsl.exe")).toBe(1);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const handles: FakePtyHandle[] = [];
const spawnCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];

class FakePtyHandle {
  exitHandlers: Array<(info: { exitCode: number }) => void> = [];
  writes: string[] = [];
  onData(): void {}
  onExit(handler: (info: { exitCode: number }) => void): void {
    this.exitHandlers.push(handler);
  }
  resize(): void {}
  write(data: string): void {
    this.writes.push(data);
  }
  kill(exitCode = 0): void {
    queueMicrotask(() => this.exitHandlers.forEach((handler) => handler({ exitCode })));
  }
}

vi.mock("node-pty", () => ({
  default: {
    spawn: vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
      const handle = new FakePtyHandle();
      handles.push(handle);
      spawnCalls.push({ file, args, options });
      return handle;
    }),
  },
}));

import { SessionManager, type SessionSandboxHooks } from "./session-manager.js";

function state() {
  return {
    activeWorkspaceId: "w",
    workspaces: [
      {
        id: "w",
        cwd: process.cwd(),
        activePanelId: "agent",
        sandboxEnabled: true,
        panels: [{ id: "agent", title: "Agent", command: "claude", startup: "default" }],
      },
    ],
  };
}

function hooks(overrides: Partial<SessionSandboxHooks> = {}): SessionSandboxHooks & {
  prepare: ReturnType<typeof vi.fn>;
  wrap: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    prepare: vi.fn(async () => true),
    wrap: vi.fn(({ env }: { env: Record<string, string> }) => ({
      file: "/usr/bin/node",
      args: ["/launcher.mjs", "/launch.json"],
      env: { ...env, FROM_WRAP: "1" },
      cwd: "/sandbox/cwd",
    })),
    release: vi.fn(),
    ...overrides,
  } as never;
}

function deferredPreparation() {
  let resolve!: (isolated: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SessionManager sandbox hooks", () => {
  let testDataDir: string;

  beforeEach(() => {
    handles.length = 0;
    spawnCalls.length = 0;
    testDataDir = mkdtempSync(path.join(tmpdir(), "session-sandbox-"));
    vi.stubEnv("STRIDETERM_DATA_DIR", testDataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(testDataDir, { recursive: true, force: true });
  });

  test("spawns the sandbox's launcher in place of the shell and gives it the wrapped environment", async () => {
    const sandbox = hooks();
    const manager = new SessionManager({ sandbox });
    const session = await manager.ensureSession(state() as never, "w:agent");
    expect(session?.status).toBe("running");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({ file: "/usr/bin/node", args: ["/launcher.mjs", "/launch.json"] });
    expect(spawnCalls[0].options.cwd).toBe("/sandbox/cwd");
    expect((spawnCalls[0].options.env as Record<string, string>).FROM_WRAP).toBe("1");
    const context = sandbox.wrap.mock.calls[0][0];
    expect(context.sessionId).toBe("w:agent");
    expect(context.launcher.file).not.toBe("/usr/bin/node");
  });

  test("never types the shell-integration source line into a sandboxed shell: its script is not readable there", async () => {
    const manager = new SessionManager({ sandbox: hooks() });
    await manager.ensureSession(state() as never, "w:agent");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(handles[0].writes.filter((line) => /source|^\. /u.test(line))).toEqual([]);
  });

  test("keeps the host's PowerShell integration script out of the isolated launch command", async () => {
    const sandbox = hooks();
    const launcher = { file: "pwsh", args: ["-NoLogo"] };
    const manager = new SessionManager({ sandbox, getSessionLaunch: () => launcher });

    await manager.ensureSession(state() as never, "w:agent");

    expect(sandbox.wrap.mock.calls[0]?.[0].launcher).toEqual(launcher);
  });

  test("fails closed and visibly when the sandbox cannot start: nothing is spawned", async () => {
    const sandbox = hooks({ prepare: vi.fn(async () => Promise.reject(new Error("bubblewrap is missing"))) });
    const manager = new SessionManager({ sandbox });
    const output: string[] = [];
    manager.on("terminal:data", (event: { data: string }) => output.push(event.data));
    const session = await manager.ensureSession(state() as never, "w:agent");
    expect(session).toBeNull();
    expect(spawnCalls).toHaveLength(0);
    expect(output.join("")).toContain("Isolated tab not started: bubblewrap is missing");
    expect(manager.failedSpawns.has("w:agent")).toBe(true);
  });

  test("fails closed when wrapping fails, and releases what prepare set up", async () => {
    const sandbox = hooks({
      wrap: vi.fn(() => {
        throw new Error("the workspace folder does not exist");
      }),
    });
    const manager = new SessionManager({ sandbox });
    const session = await manager.ensureSession(state() as never, "w:agent");
    expect(session).toBeNull();
    expect(spawnCalls).toHaveLength(0);
    expect(sandbox.release).toHaveBeenCalledWith("w:agent");
  });

  test("an isolated launch leaves a missing folder for the sandbox to resolve", async () => {
    const sandbox = hooks();
    const missing = path.join(tmpdir(), randomUUID());
    const manager = new SessionManager({ sandbox, getSessionLaunch: () => ({ cwd: missing }) });
    const withoutWorkspaceRoot = state();
    withoutWorkspaceRoot.workspaces[0].cwd = "";

    await manager.ensureSession(withoutWorkspaceRoot as never, "w:agent");

    expect(sandbox.wrap.mock.calls[0]?.[0].cwd).toBe(missing);
  });

  test("releases preparation when building the agent launch fails", async () => {
    const sandbox = hooks();
    const manager = new SessionManager({
      sandbox,
      getSessionLaunch() {
        throw new Error("could not build the agent launch");
      },
    });

    await expect(manager.ensureSession(state() as never, "w:agent")).rejects.toThrow(
      "could not build the agent launch",
    );
    expect(spawnCalls).toHaveLength(0);
    expect(sandbox.release).toHaveBeenCalledExactlyOnceWith("w:agent");
  });

  test("releases the sandbox when the process exits", async () => {
    const sandbox = hooks();
    const manager = new SessionManager({ sandbox });
    await manager.ensureSession(state() as never, "w:agent");
    handles[0].kill(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sandbox.release).toHaveBeenCalledWith("w:agent");
  });

  test("releases a stopped session even if its exit arrives after a replacement starts", async () => {
    const prepare = vi.fn<SessionSandboxHooks["prepare"]>().mockResolvedValueOnce(true).mockResolvedValue(false);
    const sandbox = hooks({ prepare });
    const manager = new SessionManager({ sandbox });
    await manager.ensureSession(state() as never, "w:agent");
    const original = handles[0];
    vi.spyOn(original, "kill").mockImplementationOnce(() => {});

    manager.removeSession("w:agent");
    expect(sandbox.release).toHaveBeenCalledExactlyOnceWith("w:agent");
    await manager.ensureSession(state() as never, "w:agent");

    original.kill();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(sandbox.release).toHaveBeenCalledTimes(1);
    expect(manager.getIsolationMap()).toEqual({ "w:agent": false });
  });

  test("leaves a tab the sandbox does not claim exactly as it was", async () => {
    const sandbox = hooks({ prepare: vi.fn(async () => false) });
    const manager = new SessionManager({ sandbox });
    await manager.ensureSession(state() as never, "w:agent");
    expect(sandbox.wrap).not.toHaveBeenCalled();
    expect(spawnCalls[0].file).not.toBe("/usr/bin/node");
  });

  test("reports what was launched: a tab started before isolation was turned on stays outside it", async () => {
    const claims = { value: false };
    const sandbox = hooks({ prepare: vi.fn(async () => claims.value) });
    const manager = new SessionManager({ sandbox });
    await manager.ensureSession(state() as never, "w:agent");
    expect(manager.getIsolationMap()).toEqual({ "w:agent": false });

    // Turning isolation on does not reach into the running process: it is returned as it is, unwrapped.
    claims.value = true;
    const again = await manager.ensureSession(state() as never, "w:agent");
    expect(again?.status).toBe("running");
    expect(spawnCalls).toHaveLength(1);
    expect(sandbox.wrap).not.toHaveBeenCalled();
    expect(manager.getIsolationMap()).toEqual({ "w:agent": false });

    // After a restart the new process is the isolated one.
    handles[0].kill(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await manager.ensureSession(state() as never, "w:agent");
    expect(manager.getIsolationMap()).toEqual({ "w:agent": true });
  });

  test.each([true, false])("shares concurrent starts when sandbox eligibility is %s", async (isolated) => {
    const sandbox = hooks({ prepare: vi.fn(async () => isolated) });
    const manager = new SessionManager({ sandbox });
    const [first, second] = await Promise.all([
      manager.ensureSession(state() as never, "w:agent"),
      manager.ensureSession(state() as never, "w:agent"),
    ]);
    expect(first?.status).toBe("running");
    expect(first).toBe(second);
    expect(sandbox.prepare).toHaveBeenCalledTimes(1);
    expect(spawnCalls).toHaveLength(1);
  });

  test("deleting a workspace during sandbox preparation cancels the launch", async () => {
    const preparation = deferredPreparation();
    const sandbox = hooks({ prepare: vi.fn(() => preparation.promise) });
    const manager = new SessionManager({ sandbox });
    const start = manager.ensureSession(state() as never, "w:agent");

    await manager.removeWorkspaceSessions("w");
    preparation.resolve(true);

    await expect(start).resolves.toBeNull();
    expect(spawnCalls).toHaveLength(0);
    expect(sandbox.wrap).not.toHaveBeenCalled();
    expect(sandbox.release).toHaveBeenCalledExactlyOnceWith("w:agent");
  });

  test("a restart waits for canceled sandbox preparation before launching a fresh session", async () => {
    const preparation = deferredPreparation();
    const prepare = vi
      .fn<SessionSandboxHooks["prepare"]>()
      .mockReturnValueOnce(preparation.promise)
      .mockResolvedValue(true);
    const sandbox = hooks({ prepare });
    const manager = new SessionManager({ sandbox });
    const start = manager.ensureSession(state() as never, "w:agent");
    const restart = manager.restartSession(() => state() as never, "w:agent");

    preparation.resolve(true);

    await expect(start).resolves.toBeNull();
    await expect(restart).resolves.toMatchObject({ status: "running", sandboxed: true });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(spawnCalls).toHaveLength(1);
    expect(sandbox.release).toHaveBeenCalledExactlyOnceWith("w:agent");
  });

  test.each(["panel removal", "shutdown"])("%s cancels a restart waiting for the old process", async (action) => {
    const sandbox = hooks();
    const manager = new SessionManager({ sandbox });
    await manager.ensureSession(state() as never, "w:agent");
    const original = handles[0];
    const kill = vi.spyOn(original, "kill").mockImplementation(() => {});

    const restart = manager.restartSession(() => state() as never, "w:agent");
    await vi.waitFor(() => expect(kill).toHaveBeenCalled());
    if (action === "panel removal") {
      manager.syncWithState({ ...state(), workspaces: [] } as never);
    } else {
      manager.stopAll();
    }
    kill.mockRestore();
    original.kill();

    await expect(restart).resolves.toBeNull();
    expect(manager.hasSession("w:agent")).toBe(false);
    expect(spawnCalls).toHaveLength(1);
  });

  test("a restart honors isolation enabled while the old process is exiting", async () => {
    const sandbox = hooks({ prepare: async ({ workspace }) => workspace.sandboxEnabled === true });
    const manager = new SessionManager({ sandbox });
    let live = state();
    live.workspaces[0].sandboxEnabled = false;
    await manager.ensureSession(live as never, "w:agent");
    const original = handles[0];
    const kill = vi.spyOn(original, "kill").mockImplementationOnce(() => {});

    const restart = manager.restartSession(() => live as never, "w:agent");
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1));
    live = state();
    original.kill();

    await expect(restart).resolves.toMatchObject({ status: "running", sandboxed: true });
    expect(sandbox.wrap).toHaveBeenCalledTimes(1);
  });
});

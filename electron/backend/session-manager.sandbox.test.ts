import { beforeEach, describe, expect, test, vi } from "vitest";

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

describe("SessionManager sandbox hooks", () => {
  beforeEach(() => {
    handles.length = 0;
    spawnCalls.length = 0;
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

  test("releases the sandbox when the process exits", async () => {
    const sandbox = hooks();
    const manager = new SessionManager({ sandbox });
    await manager.ensureSession(state() as never, "w:agent");
    handles[0].kill(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sandbox.release).toHaveBeenCalledWith("w:agent");
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

  test("a second start that raced the first returns the running session instead of spawning again", async () => {
    const manager = new SessionManager({ sandbox: hooks() });
    const [first, second] = await Promise.all([
      manager.ensureSession(state() as never, "w:agent"),
      manager.ensureSession(state() as never, "w:agent"),
    ]);
    expect(first).toBe(second);
    expect(spawnCalls).toHaveLength(1);
  });
});

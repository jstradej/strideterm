import { beforeEach, describe, expect, test, vi } from "vitest";

const handles: FakePtyHandle[] = [];
const spawnCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
let spawnError: Error | null = null;

class FakePtyHandle {
  dataHandlers: Array<(data: string) => void> = [];
  exitHandlers: Array<(info: { exitCode: number }) => void> = [];

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (info: { exitCode: number }) => void): void {
    this.exitHandlers.push(handler);
  }

  resize(): void {}

  write(): void {}

  kill(exitCode = 0): void {
    queueMicrotask(() => {
      this.exitHandlers.forEach((handler) => handler({ exitCode }));
    });
  }
}

vi.mock("node-pty", () => ({
  default: {
    spawn: vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
      if (spawnError) {
        throw spawnError;
      }
      const handle = new FakePtyHandle();
      handles.push(handle);
      spawnCalls.push({ file, args, options });
      return handle;
    }),
  },
}));

import { SessionManager, shellIntegrationEnv } from "./session-manager.js";

function createState() {
  return {
    activeWorkspaceId: "workspace-a",
    workspaces: [
      {
        id: "workspace-a",
        cwd: "/home/user/workspace",
        activePanelId: "shell",
        panels: [
          {
            id: "shell",
            title: "Shell",
            command: "",
            startup: "default",
          },
        ],
      },
    ],
  };
}

describe("SessionManager", () => {
  beforeEach(() => {
    handles.length = 0;
    spawnCalls.length = 0;
    spawnError = null;
  });

  test("hard restart spawns a fresh session and marks old exit as intentional", async () => {
    const manager = new SessionManager();
    const exits: unknown[] = [];
    manager.on("terminal:exit", (payload) => exits.push(payload));

    manager.ensureSession(createState() as Parameters<typeof manager.ensureSession>[0], "workspace-a:shell");
    const restarted = await manager.restartSession(
      createState() as Parameters<typeof manager.ensureSession>[0],
      "workspace-a:shell",
    );

    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      sessionId: "workspace-a:shell",
      intentional: true,
    });
    expect(handles).toHaveLength(2);
    expect(restarted?.status).toBe("running");
    expect(manager.sessions.get("workspace-a:shell")?.status).toBe("running");
  });

  test("marks unexpected exits as non-intentional", () => {
    const manager = new SessionManager();
    const exits: unknown[] = [];
    manager.on("terminal:exit", (payload) => exits.push(payload));

    manager.ensureSession(createState() as Parameters<typeof manager.ensureSession>[0], "workspace-a:shell");
    handles[0].kill(7);
    return new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => {
      expect(exits).toHaveLength(1);
      expect(exits[0]).toMatchObject({
        sessionId: "workspace-a:shell",
        exitCode: 7,
        intentional: false,
      });
    });
  });

  test("merges session-specific environment variables into the shell", () => {
    const manager = new SessionManager({
      getSessionEnv: ({ workspace, panel, sessionId }) => ({
        STRIDETERM_REVIEW_PR_KEY: `${workspace.id}:${panel.id}:${sessionId}`,
        STRIDETERM_REVIEW_BRIEF_MD: "/tmp/review/agent-brief.md",
      }),
    });

    manager.ensureSession(createState() as Parameters<typeof manager.ensureSession>[0], "workspace-a:shell");

    expect(spawnCalls).toHaveLength(1);
    expect((spawnCalls[0].options.env as Record<string, string>).STRIDETERM_REVIEW_PR_KEY).toBe(
      "workspace-a:shell:workspace-a:shell",
    );
    expect((spawnCalls[0].options.env as Record<string, string>).STRIDETERM_REVIEW_BRIEF_MD).toBe(
      "/tmp/review/agent-brief.md",
    );
  });

  test("uses session launch overrides for review-aware agent sessions", () => {
    const manager = new SessionManager({
      getSessionLaunch: () => ({
        file: "claude",
        args: ["--mcp-config", '{"mcpServers":{}}'],
        cwd: "/tmp/review-worktree",
        env: {
          STRIDETERM_REVIEW_MCP: "1",
        },
        skipCommandInjection: true,
      }),
    });

    manager.ensureSession(createState() as Parameters<typeof manager.ensureSession>[0], "workspace-a:shell");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].file).toBe("claude");
    expect(spawnCalls[0].args).toEqual(["--mcp-config", '{"mcpServers":{}}']);
    expect(spawnCalls[0].options.cwd).toBe("/tmp/review-worktree");
    expect((spawnCalls[0].options.env as Record<string, string>).STRIDETERM_REVIEW_MCP).toBe("1");
  });

  test("ignores resize errors after a pty has already exited", () => {
    const manager = new SessionManager();

    manager.ensureSession(createState() as Parameters<typeof manager.ensureSession>[0], "workspace-a:shell");
    handles[0].resize = vi.fn(() => {
      throw new Error("Cannot resize a pty that has already exited");
    });

    expect(() => manager.resizeSession("workspace-a:shell", 120, 40)).not.toThrow();
  });

  test("injects shell integration env vars when enabled", () => {
    const manager = new SessionManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = createState();
    state.settings = { notifications: { shellIntegration: true } };
    // Use an explicit launch config with a recognized shell
    state.workspaces[0].panels[0].launch = { file: "pwsh.exe", args: ["-NoLogo"] };

    manager.ensureSession(state, "workspace-a:shell");

    const env = spawnCalls[0].options.env as Record<string, string>;
    expect(env.STRIDETERM_SHELL_INTEGRATION).toBe("1");
    expect(env.STRIDETERM_SHELL_INTEGRATION_SCRIPT).toMatch(/pwsh\.ps1$/);
  });

  test("skips shell integration env when disabled in settings", () => {
    const manager = new SessionManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = createState();
    state.settings = { notifications: { shellIntegration: false } };
    state.workspaces[0].panels[0].launch = { file: "pwsh.exe", args: ["-NoLogo"] };

    manager.ensureSession(state, "workspace-a:shell");

    const env = spawnCalls[0].options.env as Record<string, string>;
    expect(env.STRIDETERM_SHELL_INTEGRATION).toBeUndefined();
  });

  test("returns null and emits terminal data when pty spawn fails", async () => {
    const manager = new SessionManager();
    const terminalData: unknown[] = [];
    spawnError = new Error("bad cwd");
    manager.on("terminal:data", (payload) => terminalData.push(payload));

    const result = await manager.ensureSession(
      createState() as Parameters<typeof manager.ensureSession>[0],
      "workspace-a:shell",
    );

    expect(result).toBeNull();
    expect(manager.sessions.has("workspace-a:shell")).toBe(false);
    expect(terminalData).toHaveLength(1);
    expect(terminalData[0]).toMatchObject({
      sessionId: "workspace-a:shell",
      data: expect.stringContaining("bad cwd"),
    });
  });

  test("coalesces concurrent ssh session starts for the same session id", async () => {
    let resolveStart: (() => void) | null = null;
    const sshManager = {
      getHost: vi.fn(() => ({
        id: "host-a",
        host: "example.test",
        advanced: { launchVia: "ssh2" },
      })),
      createSession: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveStart = resolve;
          }),
      ),
    };
    const manager = new SessionManager({ sshManager: sshManager as never });
    const state = createState();
    state.workspaces[0].activePanelId = "ssh";
    state.workspaces[0].panels[0] = {
      id: "ssh",
      title: "SSH",
      command: "ssh",
      startup: "default",
      launch: { kind: "ssh", sshHostId: "host-a" },
    };

    const first = manager.ensureSession(state as Parameters<typeof manager.ensureSession>[0], "workspace-a:ssh");
    const second = manager.ensureSession(state as Parameters<typeof manager.ensureSession>[0], "workspace-a:ssh");
    await Promise.resolve();

    expect(sshManager.createSession).toHaveBeenCalledTimes(1);
    expect(resolveStart).toBeTypeOf("function");
    resolveStart?.();
    const [firstSession, secondSession] = await Promise.all([first, second]);

    expect(firstSession).toBe(secondSession);
    expect(manager.sessions.get("workspace-a:ssh")).toBe(firstSession);
  });
});

describe("shellIntegrationEnv", () => {
  test("returns PROMPT_COMMAND for bash", () => {
    const env = shellIntegrationEnv("/bin/bash", true);
    expect(env.STRIDETERM_SHELL_INTEGRATION).toBe("1");
    expect(env.BASH_ENV).toMatch(/bash\.sh$/);
    expect(env.PROMPT_COMMAND).toMatch(/source/);
  });

  test("returns integration script path for zsh", () => {
    const env = shellIntegrationEnv("/usr/bin/zsh", true);
    expect(env.STRIDETERM_SHELL_INTEGRATION).toBe("1");
    expect(env.STRIDETERM_SHELL_INTEGRATION_SCRIPT).toMatch(/zsh\.sh$/);
  });

  test("returns integration script path for pwsh", () => {
    const env = shellIntegrationEnv("pwsh.exe", true);
    expect(env.STRIDETERM_SHELL_INTEGRATION).toBe("1");
    expect(env.STRIDETERM_SHELL_INTEGRATION_SCRIPT).toMatch(/pwsh\.ps1$/);
  });

  test("returns empty object when disabled", () => {
    const env = shellIntegrationEnv("/bin/bash", false);
    expect(env).toEqual({});
  });

  test("returns empty object for unrecognized shells", () => {
    const env = shellIntegrationEnv("/usr/bin/fish", true);
    expect(env).toEqual({});
  });
});

import { beforeEach, describe, expect, test, vi } from "vitest";

const handles = [];
const spawnCalls = [];

class FakePtyHandle {
  constructor() {
    this.dataHandlers = [];
    this.exitHandlers = [];
  }

  onData(handler) {
    this.dataHandlers.push(handler);
  }

  onExit(handler) {
    this.exitHandlers.push(handler);
  }

  resize() {}

  write() {}

  kill(exitCode = 0) {
    queueMicrotask(() => {
      this.exitHandlers.forEach((handler) => handler({ exitCode }));
    });
  }
}

vi.mock("node-pty", () => ({
  default: {
    spawn: vi.fn((file, args, options) => {
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
  });

  test("hard restart spawns a fresh session and marks old exit as intentional", async () => {
    const manager = new SessionManager();
    const exits = [];
    manager.on("terminal:exit", (payload) => exits.push(payload));

    manager.ensureSession(createState(), "workspace-a:shell");
    const restarted = await manager.restartSession(createState(), "workspace-a:shell");

    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      sessionId: "workspace-a:shell",
      intentional: true,
    });
    expect(handles).toHaveLength(2);
    expect(restarted.status).toBe("running");
    expect(manager.sessions.get("workspace-a:shell")?.status).toBe("running");
  });

  test("marks unexpected exits as non-intentional", () => {
    const manager = new SessionManager();
    const exits = [];
    manager.on("terminal:exit", (payload) => exits.push(payload));

    manager.ensureSession(createState(), "workspace-a:shell");
    handles[0].kill(7);
    return new Promise((resolve) => queueMicrotask(resolve)).then(() => {
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

    manager.ensureSession(createState(), "workspace-a:shell");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].options.env.STRIDETERM_REVIEW_PR_KEY).toBe("workspace-a:shell:workspace-a:shell");
    expect(spawnCalls[0].options.env.STRIDETERM_REVIEW_BRIEF_MD).toBe("/tmp/review/agent-brief.md");
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

    manager.ensureSession(createState(), "workspace-a:shell");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].file).toBe("claude");
    expect(spawnCalls[0].args).toEqual(["--mcp-config", '{"mcpServers":{}}']);
    expect(spawnCalls[0].options.cwd).toBe("/tmp/review-worktree");
    expect(spawnCalls[0].options.env.STRIDETERM_REVIEW_MCP).toBe("1");
  });

  test("ignores resize errors after a pty has already exited", () => {
    const manager = new SessionManager();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    manager.ensureSession(createState(), "workspace-a:shell");
    handles[0].resize = vi.fn(() => {
      throw new Error("Cannot resize a pty that has already exited");
    });

    expect(() => manager.resizeSession("workspace-a:shell", 120, 40)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Ignoring resize failure"));

    warnSpy.mockRestore();
  });

  test("injects shell integration env vars when enabled", () => {
    const manager = new SessionManager();
    const state = createState();
    state.settings = { notifications: { shellIntegration: true } };
    // Use an explicit launch config with a recognized shell
    state.workspaces[0].panels[0].launch = { file: "pwsh.exe", args: ["-NoLogo"] };

    manager.ensureSession(state, "workspace-a:shell");

    const env = spawnCalls[0].options.env;
    expect(env.STRIDETERM_SHELL_INTEGRATION).toBe("1");
    expect(env.STRIDETERM_SHELL_INTEGRATION_SCRIPT).toMatch(/pwsh\.ps1$/);
  });

  test("skips shell integration env when disabled in settings", () => {
    const manager = new SessionManager();
    const state = createState();
    state.settings = { notifications: { shellIntegration: false } };
    state.workspaces[0].panels[0].launch = { file: "pwsh.exe", args: ["-NoLogo"] };

    manager.ensureSession(state, "workspace-a:shell");

    const env = spawnCalls[0].options.env;
    expect(env.STRIDETERM_SHELL_INTEGRATION).toBeUndefined();
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

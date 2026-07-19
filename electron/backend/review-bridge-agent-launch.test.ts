import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildReviewAgentLaunch as _buildReviewAgentLaunch,
  detectReviewAgentPanel,
} from "./review-bridge-agent-launch.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildReviewAgentLaunch = _buildReviewAgentLaunch as (...args: any[]) => any;

function createContext() {
  return {
    prKey: "ado-main:repo-1:123",
    rootPath: "C:/Users/strad/.strideterm/review-bridge",
    repository: {
      id: "repo-1",
      name: "mhub",
    },
    pullRequest: {
      id: 123,
      title: "Review bridge",
      sourceRefName: "refs/heads/feature/review-bridge",
      targetRefName: "refs/heads/main",
    },
  };
}

function createWorkspace() {
  return {
    id: "workspace-review",
    cwd: "C:/reviews/pr-123",
    review: {
      provider: "azure-devops",
      prKey: "ado-main:repo-1:123",
    },
  };
}

describe("review bridge agent launch", () => {
  test("detects built-in review agent panels", () => {
    expect(detectReviewAgentPanel({ command: "claude" })).toBe("claude");
    expect(detectReviewAgentPanel({ command: "codex" })).toBe("codex");
    expect(detectReviewAgentPanel({ command: "copilot" })).toBe("copilot");
    expect(detectReviewAgentPanel({ command: '"C:/Tools/Claude/claude.exe" --model haiku' })).toBe("claude");
    expect(detectReviewAgentPanel({ command: '"C:/Tools/copilot.cmd" --allow-all-tools' })).toBe("copilot");
    expect(detectReviewAgentPanel({ command: "npm test" })).toBeNull();
  });

  test("detects copilot from panel title when command doesn't match", () => {
    // Panel with no command but a descriptive title (e.g. user-customized terminal tab)
    expect(detectReviewAgentPanel({ title: "GitHub Copilot" })).toBe("copilot");
    expect(detectReviewAgentPanel({ title: "github copilot session" })).toBe("copilot");
    // Generic "copilot" in title also matches — users shortening the label
    expect(detectReviewAgentPanel({ title: "Copilot" })).toBe("copilot");
  });

  test("builds a claude launch with embedded review MCP config", () => {
    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel: { id: "claude", title: "Claude Code", command: "claude --model haiku --verbose" },
      context: createContext(),
      processInfo: {
        execPath: "C:/Program Files/strIDEterm/strIDEterm.exe",
        argv: ["C:/Program Files/strIDEterm/strIDEterm.exe"],
        defaultApp: false,
        platform: "linux",
      },
    });

    expect(launch).toMatchObject({
      file: "claude",
      skipCommandInjection: true,
    });
    expect(launch.args).toContain("--mcp-config");
    expect(launch.args).toContain("--strict-mcp-config");
    expect(launch.args).toContain("--append-system-prompt");
    expect(launch.args).toContain("--add-dir");
    expect(launch.args).toContain("C:/reviews/pr-123");
    expect(launch.args.slice(0, 2)).toEqual(["--model", "haiku"]);
    expect(launch.args).toContain("--verbose");

    const configArg = launch.args[launch.args.indexOf("--mcp-config") + 1];
    const parsed = JSON.parse(configArg);
    expect(parsed.mcpServers.review.command).toBe("C:/Program Files/strIDEterm/strIDEterm.exe");
    expect(parsed.mcpServers.review.args).toEqual([
      "--review-bridge-mcp",
      "--review-root",
      "C:/Users/strad/.strideterm/review-bridge",
      "--review-pr-key",
      "ado-main:repo-1:123",
    ]);
    expect(parsed.mcpServers.review.env).toBeUndefined();
  });

  test("builds a codex launch with inline session-local MCP config", () => {
    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel: { id: "codex", title: "Codex", command: 'codex -s danger-full-access -c model_reasoning_effort="high"' },
      context: createContext(),
      processInfo: {
        execPath: "C:/Program Files/strIDEterm/strIDEterm.exe",
        argv: ["C:/Program Files/strIDEterm/strIDEterm.exe"],
        defaultApp: false,
        platform: "linux",
      },
    });

    expect(launch).toMatchObject({
      file: "codex",
      skipCommandInjection: true,
    });
    expect(launch.args.slice(0, 4)).toEqual(["-s", "danger-full-access", "-c", "model_reasoning_effort=high"]);
    expect(launch.args).toContain("--add-dir");
    expect(launch.args).toContain("C:/reviews/pr-123");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on untyped launch args array
    const configValues = (launch.args as any[])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test assertion on untyped launch args
      .map((value: any, index: any) => (launch.args[index - 1] === "-c" ? value : null))
      .filter(Boolean);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const commandConfig = configValues.find((value: any) => value.startsWith("mcp_servers.review.command="));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const argsConfig = configValues.find((value: any) => value.startsWith("mcp_servers.review.args="));
    expect(commandConfig).toBe('mcp_servers.review.command="C:/Program Files/strIDEterm/strIDEterm.exe"');
    expect(argsConfig).toContain("mcp_servers.review.args=");
    expect(argsConfig).toContain("--review-bridge-mcp");
    expect(launch.args.at(-1)).toContain("list_review_comments");
  });

  test("defaults review codex sessions to workspace-write when no sandbox is specified", () => {
    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel: { id: "codex", title: "Codex", command: "codex" },
      context: createContext(),
      processInfo: {
        execPath: "C:/Program Files/strIDEterm/strIDEterm.exe",
        argv: ["C:/Program Files/strIDEterm/strIDEterm.exe"],
        defaultApp: false,
        platform: "linux",
      },
    });

    expect(launch.file).toBe("codex");
    expect(launch.args.slice(0, 2)).toEqual(["-s", "workspace-write"]);
    expect(launch.args).toContain("--add-dir");
  });

  test("uses an explicit app target when launched from Electron default-app mode", () => {
    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel: { id: "claude", title: "Claude Code", command: "claude" },
      context: createContext(),
      processInfo: {
        execPath: "/opt/homebrew/bin/electron",
        argv: ["/opt/homebrew/bin/electron", "."],
        defaultApp: true,
        platform: "darwin",
      },
    });

    const configArg = launch.args[launch.args.indexOf("--mcp-config") + 1];
    const parsed = JSON.parse(configArg);
    expect(path.isAbsolute(parsed.mcpServers.review.args[0])).toBe(true);
    expect(parsed.mcpServers.review.args.slice(1)).toEqual([
      "--review-bridge-mcp",
      "--review-root",
      "C:/Users/strad/.strideterm/review-bridge",
      "--review-pr-key",
      "ado-main:repo-1:123",
    ]);
  });

  test("uses shell command injection on Windows for claude wrappers", () => {
    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel: { id: "claude", title: "Claude Code", command: "claude" },
      context: createContext(),
      processInfo: {
        execPath: "C:/Program Files/strIDEterm/strIDEterm.exe",
        argv: ["C:/Program Files/strIDEterm/strIDEterm.exe"],
        defaultApp: false,
        platform: "win32",
        commandLookup: {
          claude: "C:/Users/test/.local/bin/claude.exe",
        },
      },
    });

    expect(launch.file).toBe("C:/Users/test/.local/bin/claude.exe");
    expect(launch.args).toContain("--mcp-config");
    expect(launch.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
    });
    const configArg = launch.args[launch.args.indexOf("--mcp-config") + 1];
    const parsed = JSON.parse(configArg);
    expect(parsed.mcpServers.review.args[0].replaceAll("\\", "/")).toContain(
      "/electron/backend/review-bridge-mcp-stdio.js",
    );
    expect(parsed.mcpServers.review.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(launch.args.join(" ")).toContain("--review-bridge-mcp");
  });

  test("builds a copilot launch with --additional-mcp-config and --allow-all-tools", () => {
    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel: { id: "copilot", title: "GitHub Copilot", command: "copilot --model claude-sonnet-4.6" },
      context: createContext(),
      processInfo: {
        execPath: "C:/Program Files/strIDEterm/strIDEterm.exe",
        argv: ["C:/Program Files/strIDEterm/strIDEterm.exe"],
        defaultApp: false,
        platform: "linux",
      },
    });

    expect(launch).toMatchObject({
      file: "copilot",
      skipCommandInjection: true,
    });
    // Copilot's permission bypass flag must be present even when the panel
    // command omits it — review MCP requires tool access.
    expect(launch.args).toContain("--allow-all-tools");
    // Panel args are inherited (everything after "copilot")
    expect(launch.args).toContain("--model");
    expect(launch.args).toContain("claude-sonnet-4.6");
    expect(launch.args).toContain("--additional-mcp-config");
    expect(launch.args).toContain("--add-dir");
    expect(launch.args).toContain("C:/reviews/pr-123");
    expect(launch.args).toContain("-i");

    // MCP config is inline JSON (same pattern as Claude's --mcp-config)
    const configArg = launch.args[launch.args.indexOf("--additional-mcp-config") + 1];
    const parsed = JSON.parse(configArg);
    expect(parsed.mcpServers.review.command).toBe("C:/Program Files/strIDEterm/strIDEterm.exe");
    expect(parsed.mcpServers.review.args).toContain("--review-bridge-mcp");
    expect(parsed.mcpServers.review.args).toContain("--review-pr-key");
    expect(parsed.mcpServers.review.args).toContain("ado-main:repo-1:123");
  });

  test("does not duplicate --allow-all-tools when panel command already includes it", () => {
    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel: { id: "copilot", title: "GitHub Copilot", command: "copilot --allow-all-tools --model gpt-5.4" },
      context: createContext(),
      processInfo: {
        execPath: "C:/Program Files/strIDEterm/strIDEterm.exe",
        argv: ["C:/Program Files/strIDEterm/strIDEterm.exe"],
        defaultApp: false,
        platform: "linux",
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allowCount = (launch.args as any[]).filter((arg: any) => arg === "--allow-all-tools").length;
    expect(allowCount).toBe(1);
  });

  test("resolves copilot binary path on Windows via commandLookup", () => {
    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel: { id: "copilot", title: "GitHub Copilot", command: "copilot" },
      context: createContext(),
      processInfo: {
        execPath: "C:/Program Files/strIDEterm/strIDEterm.exe",
        argv: ["C:/Program Files/strIDEterm/strIDEterm.exe"],
        defaultApp: false,
        platform: "win32",
        commandLookup: {
          copilot: "C:/Users/test/AppData/Roaming/npm/copilot.cmd",
        },
      },
    });

    expect(launch.file).toBe("C:/Users/test/AppData/Roaming/npm/copilot.cmd");
    expect(launch.args).toContain("--allow-all-tools");
    expect(launch.args).toContain("--additional-mcp-config");
  });

  test("builds an opencode launch with inline OPENCODE_CONFIG_CONTENT mcp wiring", () => {
    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel: { id: "opencode", title: "OpenCode", command: "opencode --model anthropic/claude-sonnet-4-6" },
      context: createContext(),
      processInfo: {
        execPath: "C:/Program Files/strIDEterm/strIDEterm.exe",
        argv: ["C:/Program Files/strIDEterm/strIDEterm.exe"],
        defaultApp: false,
        platform: "linux",
      },
    });

    expect(launch).toMatchObject({
      file: "opencode",
      skipCommandInjection: true,
    });
    // Permission bypass must be present even when the panel command omits it —
    // review MCP requires tool access without interactive approval prompts.
    expect(launch.args).toContain("--yolo");
    // Panel args are inherited (everything after "opencode")
    expect(launch.args).toContain("--model");
    expect(launch.args).toContain("anthropic/claude-sonnet-4-6");
    expect(launch.args).toContain("--prompt");

    expect(launch.env).toBeDefined();
    const configContent = launch.env.OPENCODE_CONFIG_CONTENT;
    expect(configContent).toBeTruthy();
    const parsed = JSON.parse(configContent);
    expect(parsed.mcp.review.type).toBe("local");
    expect(parsed.mcp.review.enabled).toBe(true);
    expect(parsed.mcp.review.command[0]).toBe("C:/Program Files/strIDEterm/strIDEterm.exe");
    expect(parsed.mcp.review.command).toContain("--review-bridge-mcp");
    expect(parsed.mcp.review.command).toContain("--review-pr-key");
    expect(parsed.mcp.review.command).toContain("ado-main:repo-1:123");
  });

  test("does not duplicate --yolo when panel command already includes it", () => {
    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel: { id: "opencode", title: "OpenCode", command: "opencode --yolo --model default" },
      context: createContext(),
      processInfo: {
        execPath: "C:/Program Files/strIDEterm/strIDEterm.exe",
        argv: ["C:/Program Files/strIDEterm/strIDEterm.exe"],
        defaultApp: false,
        platform: "linux",
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const yoloCount = (launch.args as any[]).filter((arg: any) => arg === "--yolo").length;
    expect(yoloCount).toBe(1);
  });

  test("resolves opencode binary path on Windows via commandLookup", () => {
    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel: { id: "opencode", title: "OpenCode", command: "opencode" },
      context: createContext(),
      processInfo: {
        execPath: "C:/Program Files/strIDEterm/strIDEterm.exe",
        argv: ["C:/Program Files/strIDEterm/strIDEterm.exe"],
        defaultApp: false,
        platform: "win32",
        commandLookup: {
          opencode: "C:/Users/test/AppData/Roaming/npm/opencode.cmd",
        },
      },
    });

    expect(launch.file).toBe("C:/Users/test/AppData/Roaming/npm/opencode.cmd");
    expect(launch.args).toContain("--yolo");
    expect(launch.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
    });
    const parsed = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
    expect(parsed.mcp.review.environment).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(parsed.mcp.review.command.join(" ")).toContain("--review-bridge-mcp");
  });

  test("falls back to bare opencode command on Windows when not resolvable via PATH", () => {
    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel: { id: "opencode", title: "OpenCode", command: "opencode" },
      context: createContext(),
      processInfo: {
        execPath: "C:/Program Files/strIDEterm/strIDEterm.exe",
        argv: ["C:/Program Files/strIDEterm/strIDEterm.exe"],
        defaultApp: false,
        platform: "win32",
        pathEnv: "",
      },
    });

    expect(launch.file).toBe("opencode");
    expect(launch.env.OPENCODE_CONFIG_CONTENT).toBeTruthy();
  });

  test("dispatches a detected opencode panel to buildOpencodeLaunch instead of falling through", () => {
    const panel = { title: "OpenCode session" }; // no command/id — detected via title only
    expect(detectReviewAgentPanel(panel)).toBe("opencode");

    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel,
      context: createContext(),
      processInfo: {
        execPath: "C:/Program Files/strIDEterm/strIDEterm.exe",
        argv: ["C:/Program Files/strIDEterm/strIDEterm.exe"],
        defaultApp: false,
        platform: "linux",
      },
    });

    expect(launch).not.toBeNull();
    expect(launch.file).toBe("opencode");
    expect(launch.env.OPENCODE_CONFIG_CONTENT).toBeTruthy();
    const parsed = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
    expect(parsed.mcp.review.command).toContain("--review-bridge-mcp");
  });

  test("uses node plus codex js entrypoint on Windows", () => {
    const launch = buildReviewAgentLaunch({
      workspace: createWorkspace(),
      panel: { id: "codex", title: "Codex", command: "codex -s danger-full-access" },
      context: createContext(),
      processInfo: {
        execPath: "C:/Program Files/strIDEterm/strIDEterm.exe",
        argv: ["C:/Program Files/strIDEterm/strIDEterm.exe"],
        defaultApp: false,
        platform: "win32",
        commandLookup: {
          node: "C:/Program Files/nodejs/node.exe",
          codex: "C:/Users/test/AppData/Roaming/npm/codex.cmd",
        },
      },
    });

    expect(launch.file).toBe("C:/Program Files/nodejs/node.exe");
    expect(launch.args[0].replaceAll("\\", "/")).toBe(
      "C:/Users/test/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js",
    );
    expect(launch.args).toContain("-s");
    expect(launch.args).toContain("danger-full-access");
    expect(launch.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(launch.args.join(" ")).toContain("mcp_servers.review.command=");
    expect(launch.args.join(" ")).toContain("--review-bridge-mcp");
  });
});

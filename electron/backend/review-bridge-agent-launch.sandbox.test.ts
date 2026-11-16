import { describe, expect, test } from "vitest";
import {
  buildAgentMcpLaunch,
  buildAgentSshMcpServerSpec,
  buildInternalMcpServerSpec,
  buildReviewAgentLaunch,
  type SandboxMcpTarget,
} from "./review-bridge-agent-launch.js";

const PROXY = ["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];

function sandbox(overrides: Partial<SandboxMcpTarget> = {}): SandboxMcpTarget {
  return {
    nodePath: "/usr/bin/node",
    forwardEnv: PROXY,
    mapPath: (hostPath) => `/mapped${hostPath.replaceAll("\\", "/").replace(/^[A-Za-z]:/u, "")}`,
    ...overrides,
  };
}

const processInfo = (target?: SandboxMcpTarget) => ({
  execPath: "C:\\Program Files\\strIDEterm\\strIDEterm.exe",
  isElectron: true,
  platform: "win32",
  ...(target ? { sandbox: target } : {}),
});

describe("MCP bridge specs inside the sandbox", () => {
  test("an ordinary tab keeps the Electron executable running as node", () => {
    const spec = buildInternalMcpServerSpec(processInfo());
    expect(spec.command).toBe(processInfo().execPath);
    expect(spec.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(spec.forwardEnv).toBeUndefined();
  });

  test("a sandboxed tab runs the bridge with plain node on the mapped entry and inherits the proxy by name", () => {
    for (const spec of [
      buildInternalMcpServerSpec(processInfo(sandbox())),
      buildAgentSshMcpServerSpec(processInfo(sandbox())),
    ]) {
      expect(spec.command).toBe("/usr/bin/node");
      expect(spec.args[0]).toMatch(/^\/mapped\/.*\.js$/u);
      expect(spec.args[1]).toMatch(/^--(internal|ssh)-mcp$/u);
      expect(spec.env).toBeUndefined();
      expect(spec.forwardEnv).toEqual(PROXY);
    }
  });

  test("on a native host the bridge stays the app's own executable: only the folders it reads and the proxy names are added", () => {
    const granted: string[] = [];
    const native = sandbox({
      nodePath: null,
      mapPath: (hostPath) => {
        granted.push(hostPath);
        return hostPath;
      },
    });
    const spec = buildInternalMcpServerSpec({
      ...processInfo(native),
      platform: "linux",
      execPath: "/opt/app/strideterm",
    });
    expect(spec.command).toBe("/opt/app/strideterm");
    expect(spec.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(spec.forwardEnv).toEqual(PROXY);
    expect(granted).toEqual([expect.stringMatching(/internal-mcp-stdio-entry.js$/u), "/opt/app"]);
  });

  test("refuses a bridge the sandbox host cannot read instead of starting it unisolated", () => {
    expect(() => buildInternalMcpServerSpec(processInfo(sandbox({ mapPath: () => null })))).toThrow(
      /cannot run inside the sandbox/,
    );
  });
});

describe("the proxy reaches the MCP servers of every agent without being written into a command line", () => {
  const internalMcpEnv = { STRIDETERM_INTERNAL_MCP_URL: "http://gateway.strideterm.internal/broker/CAP/internal-mcp" };
  const launchFor = (command: string, geminiSettingsPath?: string) => {
    const info = processInfo(sandbox());
    const launch = buildAgentMcpLaunch({
      workspace: { cwd: "/work/app" },
      panel: { id: "p", command },
      processInfo: { ...info, platform: "linux", commandLookup: {} },
      internalMcp: buildInternalMcpServerSpec(info),
      internalMcpEnv,
      geminiSettingsPath,
    });
    expect(launch).not.toBeNull();
    return launch!;
  };

  test("Codex forwards them by name in env_vars", () => {
    const args = launchFor("codex").args.join("\n");
    expect(args).toMatch(/mcp_servers\.[^.]+\.env_vars=\[[^\]]*"HTTP_PROXY"/u);
    expect(args).toContain('"STRIDETERM_INTERNAL_MCP_URL"');
    expect(args).not.toMatch(/srt\.|:[0-9a-f]{32}@/u);
  });

  test("Copilot names them as placeholders of the tab's environment", () => {
    const args = launchFor("copilot").args;
    const config = JSON.parse(args[args.indexOf("--additional-mcp-config") + 1]);
    const server = Object.values(config.mcpServers)[0] as { env: Record<string, string> };
    expect(server.env.HTTP_PROXY).toBe("${HTTP_PROXY}");
    expect(server.env.NO_PROXY).toBe("${NO_PROXY}");
  });

  test("OpenCode names them as {env:} references, never with a value", () => {
    const config = JSON.parse(launchFor("opencode").env!.OPENCODE_CONFIG_CONTENT);
    const server = Object.values(config.mcp)[0] as { environment: Record<string, string>; command: string[] };
    expect(server.environment.HTTP_PROXY).toBe("{env:HTTP_PROXY}");
    expect(server.command[0]).toBe("/usr/bin/node");
  });

  test("Gemini gets a settings file that names them, and every grant variable, as placeholders", () => {
    const launch = launchFor("gemini --model gemini-2.5-pro", "/data/gemini-mcp/s.json");
    expect(launch.env).toEqual({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/data/gemini-mcp/s.json" });
    expect(launch.args).toEqual(["--model", "gemini-2.5-pro"]);
    expect(launch.files).toHaveLength(1);
    expect(launch.files![0].path).toBe("/data/gemini-mcp/s.json");
    const settings = JSON.parse(launch.files![0].content);
    const server = Object.values(settings.mcpServers)[0] as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(server.command).toBe("/usr/bin/node");
    expect(server.env.HTTP_PROXY).toBe("${HTTP_PROXY}");
    expect(server.env.NO_PROXY).toBe("${NO_PROXY}");
    expect(server.env.STRIDETERM_INTERNAL_MCP_URL).toBe("${STRIDETERM_INTERNAL_MCP_URL}");
    expect(server.env.STRIDETERM_INTERNAL_MCP_CAPABILITY).toBe("${STRIDETERM_INTERNAL_MCP_CAPABILITY}");
    expect(launch.files![0].content).not.toContain("gateway.strideterm.internal");
  });

  test("a Gemini launch without a settings path is refused instead of starting without its tools", () => {
    expect(() => launchFor("gemini")).toThrow(/settings file path/u);
  });

  test("Claude inherits the tab's environment and gets the node command in its inline config", () => {
    const args = launchFor("claude").args;
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    const server = Object.values(config.mcpServers)[0] as { command: string; env?: unknown };
    expect(server.command).toBe("/usr/bin/node");
    expect(server.env).toBeUndefined();
  });
});

describe("a Windows tab isolated in WSL runs the distro's own agent CLI", () => {
  const windowsShims = {
    node: "C:/Program Files/nodejs/node.exe",
    codex: "C:/Users/test/AppData/Roaming/npm/codex.cmd",
    claude: "C:/Users/test/.local/bin/claude.exe",
  };

  test.each(["codex --yolo", "claude --dangerously-skip-permissions"])(
    "%s is launched by its bare name, not through a Windows shim",
    (command) => {
      const info = processInfo(sandbox());
      const launch = buildAgentMcpLaunch({
        workspace: { cwd: "C:\\work\\app" },
        panel: { id: "p", command },
        processInfo: { ...info, commandLookup: windowsShims, pathExists: () => true },
        internalMcp: buildInternalMcpServerSpec(info),
      });
      expect(launch!.file).toBe(command.split(" ")[0]);
      expect(launch!.args.join(" ")).not.toMatch(/codex\.js|AppData/u);
    },
  );

  test("an explicit path to the codex.cmd shim is not unwrapped into node and a Windows script", () => {
    const info = processInfo(sandbox());
    const launch = buildAgentMcpLaunch({
      workspace: { cwd: "C:\\work\\app" },
      panel: { id: "p", command: "C:/Users/test/AppData/Roaming/npm/codex.cmd" },
      processInfo: { ...info, commandLookup: windowsShims, pathExists: () => true },
      internalMcp: buildInternalMcpServerSpec(info),
    });
    expect(launch!.file).not.toMatch(/node\.exe$/u);
    expect(launch!.args.join(" ")).not.toContain("codex.js");
  });

  test("an ordinary Windows tab keeps node plus codex.js", () => {
    const launch = buildAgentMcpLaunch({
      workspace: { cwd: "C:\\work\\app" },
      panel: { id: "p", command: "codex" },
      processInfo: { ...processInfo(), commandLookup: windowsShims, pathExists: () => true },
      internalMcp: buildInternalMcpServerSpec(processInfo()),
    });
    expect(launch!.file).toBe("C:/Program Files/nodejs/node.exe");
    expect(launch!.args[0].replaceAll("\\", "/")).toContain("@openai/codex/bin/codex.js");
  });
});

describe("the review bridge in the sandbox", () => {
  test("uses node with the mapped entry and maps the Windows paths it is told to read", () => {
    const launch = buildReviewAgentLaunch({
      workspace: { cwd: "C:\\work\\app" },
      panel: { id: "p", command: "codex" },
      context: { rootPath: "C:\\store\\review", prKey: "pr-1", workspaceId: "w" },
      processInfo: { ...processInfo(sandbox()), platform: "linux", commandLookup: {} },
    });
    const args = launch!.args.join("\n");
    expect(args).toContain('mcp_servers.review.command="/usr/bin/node"');
    expect(args).toContain("/mapped/store/review");
    expect(args).toContain('"HTTP_PROXY"');
  });

  test("Gemini gets the review server and the proxy by name in its settings file", () => {
    const launch = buildReviewAgentLaunch({
      workspace: { cwd: "/work/app" },
      panel: { id: "p", command: "gemini" },
      context: { rootPath: "/store/review", prKey: "pr-1", workspaceId: "w" },
      reviewGitEnv: { STRIDETERM_REVIEW_GIT_URL: "http://x", STRIDETERM_REVIEW_GIT_CAPABILITY: "secret-value" },
      processInfo: { ...processInfo(sandbox()), platform: "linux", commandLookup: {} },
      geminiSettingsPath: "/data/gemini-mcp/r.json",
    });
    expect(launch).not.toBeNull();
    expect(launch!.env).toEqual({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/data/gemini-mcp/r.json" });
    const settings = JSON.parse(launch!.files![0].content);
    expect(settings.mcpServers.review.args).toContain("--review-bridge-mcp");
    expect(settings.mcpServers.review.env.HTTP_PROXY).toBe("${HTTP_PROXY}");
    expect(settings.mcpServers.review.env.STRIDETERM_REVIEW_GIT_CAPABILITY).toBe("${STRIDETERM_REVIEW_GIT_CAPABILITY}");
    expect(launch!.files![0].content).not.toContain("secret-value");
  });

  test("the automatic one-shot review does not run on Gemini", () => {
    expect(
      buildReviewAgentLaunch({
        workspace: { cwd: "/w" },
        panel: { id: "p", command: "gemini" },
        context: { rootPath: "/r", prKey: "pr-1", workspaceId: "w" },
        processInfo: { platform: "linux", execPath: "/x" },
        geminiSettingsPath: "/data/g.json",
        initialPrompt: "review",
        draftOnlyReview: true,
      }),
    ).toBeNull();
  });
});

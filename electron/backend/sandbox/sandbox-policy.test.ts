import { describe, expect, it } from "vitest";
import { SANDBOX_GATEWAY_HOST } from "../../shared/sandbox.js";
import { getAgentSandboxProfile, mirrorExclusions, mirroredAgentFolders } from "./agent-profile.js";
import { SANDBOX_LAUNCHER_SOURCE } from "./launcher-script.js";
import { sanitizeSandboxEnv } from "./sandbox-env.js";
import { buildSandboxPolicy, type SandboxPolicyInput } from "./sandbox-policy.js";
import { TOOLCHAIN_PROFILES } from "./toolchain-profile.js";

const node = TOOLCHAIN_PROFILES.find((profile) => profile.id === "node")!;
const maven = TOOLCHAIN_PROFILES.find((profile) => profile.id === "maven")!;

function input(overrides: Partial<SandboxPolicyInput> = {}): SandboxPolicyInput {
  return {
    os: "linux",
    home: "/home/dev",
    roots: ["/work/app"],
    gitDirs: [],
    readPaths: [],
    readWritePaths: [],
    agent: getAgentSandboxProfile("opencode"),
    toolchains: [node],
    cacheRoot: "/var/tmp/cache",
    workspaceDomains: [],
    toolConfigDir: "/tmp/strideterm-sandbox-s1",
    ...overrides,
  };
}

describe("buildSandboxPolicy", () => {
  it("denies the home directory and other credential places, then re-allows by name", () => {
    const { runtime } = buildSandboxPolicy(input());
    expect(runtime.filesystem.denyRead).toEqual(
      expect.arrayContaining(["/home/dev", "/home", "/root", "/mnt", "/var/run/docker.sock", "/run/docker.sock"]),
    );
    expect(runtime.filesystem.allowRead).toEqual(
      expect.arrayContaining([
        "/work/app",
        "/home/dev/.local/state/opencode",
        "/home/dev/.nvm",
        "/var/tmp/cache",
        "/tmp/strideterm-sandbox-s1",
      ]),
    );
    expect(runtime.filesystem.allowRead).not.toContain("/home/dev");
    // OpenCode's config folder holds opencode.json: it is mirrored by the launcher, not granted whole.
    expect(runtime.filesystem.allowRead).not.toContain("/home/dev/.config/opencode");
  });

  it("grants no folder that holds a credential-bearing config file, for any of the five agents", () => {
    for (const id of ["claude", "codex", "copilot", "opencode", "gemini"]) {
      const agent = getAgentSandboxProfile(id)!;
      const folders = mirroredAgentFolders(agent).map((relative) => `/home/dev/${relative}`);
      expect(folders.length, id).toBeGreaterThan(0);
      const { runtime, optional } = buildSandboxPolicy(input({ agent }));
      const everything = [
        ...runtime.filesystem.allowRead,
        ...runtime.filesystem.allowWrite,
        ...optional.allowRead,
        ...optional.allowWrite,
      ];
      for (const folder of folders) {
        expect(everything, `${id} ${folder}`).not.toContain(folder);
        expect(
          everything.some((item) => folder.startsWith(`${item}/`)),
          `${id} parent of ${folder}`,
        ).toBe(false);
      }
      for (const file of agent.configFiles ?? []) {
        expect(
          everything.some((item) => item.endsWith(file.path)),
          `${id} ${file.path}`,
        ).toBe(false);
      }
    }
  });

  it("leaves out the MCP sign-in stores that sit beside the model sign-in", () => {
    expect(mirrorExclusions(getAgentSandboxProfile("gemini"), ".gemini")).toEqual(
      expect.arrayContaining(["settings.json", ".env", "mcp-oauth-tokens.json"]),
    );
    expect(mirroredAgentFolders(getAgentSandboxProfile("opencode"))).toEqual(
      expect.arrayContaining([".config/opencode", ".local/share/opencode"]),
    );
    expect(mirrorExclusions(getAgentSandboxProfile("opencode"), ".local/share/opencode")).toEqual(["mcp-auth.json"]);
    expect(mirrorExclusions(getAgentSandboxProfile("codex"), ".codex")).toEqual(
      expect.arrayContaining(["config.toml", "hooks.json"]),
    );
    expect(mirrorExclusions(getAgentSandboxProfile("copilot"), ".copilot")).toEqual(
      expect.arrayContaining(["config.json", "mcp-config.json"]),
    );
  });

  it("does not grant a Windows sign-in folder whole either when it holds a config file", () => {
    const { runtime } = buildSandboxPolicy(
      input({
        agent: getAgentSandboxProfile("codex"),
        loginLinks: [{ link: "/home/dev/.codex", target: "/mnt/c/Users/me/.codex" }],
      }),
    );
    expect([...runtime.filesystem.allowRead, ...runtime.filesystem.allowWrite]).not.toContain("/mnt/c/Users/me/.codex");
  });

  it("never hands the host's Docker socket or its folder to the sandbox", () => {
    const { runtime } = buildSandboxPolicy(input());
    const everything = [...runtime.filesystem.allowRead, ...runtime.filesystem.allowWrite];
    expect(everything.some((item) => item.includes("docker"))).toBe(false);
  });

  it("allows writing to the workspace, /tmp, the agent's data folders and the toolchain cache only", () => {
    const { runtime } = buildSandboxPolicy(input());
    expect(runtime.filesystem.allowWrite).toEqual(
      expect.arrayContaining(["/work/app", "/tmp", "/home/dev/.local/state/opencode", "/var/tmp/cache/node"]),
    );
    expect(runtime.filesystem.allowWrite).not.toContain("/home/dev");
    expect(runtime.filesystem.allowWrite).not.toContain("/home/dev/.nvm");
  });

  it("keeps project files the host runs later read-only, and git hooks and config of external git dirs too", () => {
    const { optional } = buildSandboxPolicy(input({ gitDirs: ["/repo/.git/worktrees/x", "/repo/.git"] }));
    expect(optional.denyWrite).toEqual(
      expect.arrayContaining([
        "/work/app/.claude",
        "/work/app/.mcp.json",
        "/work/app/.vscode",
        "/work/app/.idea",
        "/work/app/.git/hooks",
        "/work/app/.git/config",
        "/repo/.git/hooks",
        "/repo/.git/config",
        "/repo/.git/worktrees/x/hooks",
      ]),
    );
  });

  it("lets git write to a linked worktree's git directories", () => {
    const { runtime } = buildSandboxPolicy(input({ gitDirs: ["/repo/.git/worktrees/x", "/repo/.git"] }));
    expect(runtime.filesystem.allowWrite).toEqual(expect.arrayContaining(["/repo/.git/worktrees/x", "/repo/.git"]));
  });

  it("allows only the agent's domains, the toolchains' public registries and the workspace's own list", () => {
    const { runtime } = buildSandboxPolicy(
      input({ toolchains: [node, maven], workspaceDomains: ["extra.example.com", "bad host"] }),
    );
    expect(runtime.network.allowedDomains).toEqual(
      expect.arrayContaining([
        "opencode.ai",
        "*.opencode.ai",
        "models.dev",
        "registry.npmjs.org",
        "repo.maven.apache.org",
        "extra.example.com",
      ]),
    );
    expect(runtime.network.allowedDomains).not.toContain("bad host");
    expect(runtime.network.allowedDomains).not.toContain(SANDBOX_GATEWAY_HOST);
  });

  it("routes the gateway host to the host's gateway socket only when there is one", () => {
    const withGateway = buildSandboxPolicy(input({ gatewaySocket: "/tmp/gw.sock" }));
    expect(withGateway.runtime.network.allowedDomains).toContain(SANDBOX_GATEWAY_HOST);
    expect(withGateway.runtime.network.mitmProxy).toEqual({
      socketPath: "/tmp/gw.sock",
      domains: [SANDBOX_GATEWAY_HOST],
    });
  });

  it("lets an interactive agent use pseudo-terminals on macOS only", () => {
    expect(buildSandboxPolicy(input({ os: "darwin", home: "/Users/dev" })).runtime.allowPty).toBe(true);
    expect(buildSandboxPolicy(input()).runtime).not.toHaveProperty("allowPty");
  });

  it("opens the macOS trust service only for an agent that verifies TLS through it, and only on macOS", () => {
    const codex = getAgentSandboxProfile("codex");
    const darwin = { os: "darwin" as const, home: "/Users/dev" };
    expect(buildSandboxPolicy(input({ ...darwin, agent: codex })).runtime.enableWeakerNetworkIsolation).toBe(true);
    expect(buildSandboxPolicy(input({ agent: codex })).runtime).not.toHaveProperty("enableWeakerNetworkIsolation");
    for (const id of ["claude", "copilot", "opencode", "gemini"]) {
      expect(buildSandboxPolicy(input({ ...darwin, agent: getAgentSandboxProfile(id) })).runtime).not.toHaveProperty(
        "enableWeakerNetworkIsolation",
      );
    }
  });

  it("uses the macOS places on macOS", () => {
    const { runtime } = buildSandboxPolicy(input({ os: "darwin", home: "/Users/dev" }));
    expect(runtime.filesystem.denyRead).toEqual(expect.arrayContaining(["/Users/dev", "/Users", "/Volumes"]));
    expect(runtime.filesystem.denyRead).not.toContain("/mnt");
  });

  it("creates the cache and the agent's data folders before the sandbox starts, but not a sign-in file", () => {
    const { ensureDirs } = buildSandboxPolicy(input({ agent: getAgentSandboxProfile("claude") }));
    expect(ensureDirs).toEqual(expect.arrayContaining(["/var/tmp/cache", "/var/tmp/cache/node", "/home/dev/.claude"]));
    expect(ensureDirs).not.toContain("/home/dev/.claude.json");
  });
});

describe("sanitizeSandboxEnv", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    TERM: "xterm-256color",
    GITHUB_TOKEN: "ghp_secret",
    AWS_SECRET_ACCESS_KEY: "aws",
    NPM_TOKEN: "npm",
    ANTHROPIC_API_KEY: "sk-ant",
    OPENAI_API_KEY: "sk-openai",
    STRIDETERM_SESSION_TOKEN: "own",
    STRIDETERM_INTERNAL_MCP_CAPABILITY: "cap",
    npm_config_cache: "/host/cache",
    UNRELATED: "x",
  };

  it("keeps only the allowed names and the agent's own sign-in", () => {
    const env = sanitizeSandboxEnv({
      env: host,
      platform: "linux",
      agent: getAgentSandboxProfile("claude"),
      toolchains: [node],
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      TERM: "xterm-256color",
      ANTHROPIC_API_KEY: "sk-ant",
    });
    expect(env.STRIDETERM_SESSION_TOKEN).toBe("own");
    expect(env.STRIDETERM_INTERNAL_MCP_CAPABILITY).toBe("cap");
    for (const leaked of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "NPM_TOKEN", "OPENAI_API_KEY", "UNRELATED"]) {
      expect(env, leaked).not.toHaveProperty(leaked);
    }
  });

  it("keeps Copilot's dedicated model authentication variable only", () => {
    const env = sanitizeSandboxEnv({
      env: { COPILOT_GITHUB_TOKEN: "copilot", GH_TOKEN: "gh", GITHUB_TOKEN: "github", OTHER_TOKEN: "other" },
      platform: "linux",
      agent: getAgentSandboxProfile("copilot"),
      toolchains: [],
    });
    expect(env).toEqual({ COPILOT_GITHUB_TOKEN: "copilot" });
  });

  it("drops a STRIDETERM_ variable that is not one of the session's own names", () => {
    const env = sanitizeSandboxEnv({
      env: {
        STRIDETERM_SPIKE_ACCESS_TOKEN: "x",
        STRIDETERM_HOST_TOKEN: "x",
        STRIDETERM_DATA_DIR: "/d",
        STRIDETERM_SESSION_ID: "s",
        STRIDETERM_SESSION_TOKEN: "t",
        STRIDETERM_NOTIFY_URL: "u",
        STRIDETERM_REVIEW_GIT_CAPABILITY: "c",
        STRIDETERM_SSH_MCP_CAPABILITY: "c",
      },
      platform: "linux",
      agent: null,
      toolchains: [],
    });
    expect(Object.keys(env).sort()).toEqual([
      "STRIDETERM_NOTIFY_URL",
      "STRIDETERM_REVIEW_GIT_CAPABILITY",
      "STRIDETERM_SESSION_ID",
      "STRIDETERM_SESSION_TOKEN",
      "STRIDETERM_SSH_MCP_CAPABILITY",
    ]);
  });

  it("does not forward Unix path variables from a Windows host into WSL", () => {
    const env = sanitizeSandboxEnv({
      env: { Path: "C:\\Windows", HOME: "C:\\Users\\dev", TERM: "xterm", STRIDETERM_SESSION_ID: "s" },
      platform: "win32",
      agent: null,
      toolchains: [],
    });
    expect(env).toEqual({ TERM: "xterm", STRIDETERM_SESSION_ID: "s" });
  });

  it("strips other tools' credentials out of an inherited OPENCODE_CONFIG_CONTENT but keeps what the runtime issues", () => {
    const inherited = JSON.stringify({
      provider: { x: { options: { apiKey: "INERT_PROVIDER_KEY" } } },
      mcp: {
        hostGit: {
          type: "local",
          command: ["never-run", "INERT_HOST_ARG_SECRET"],
          environment: { GITHUB_TOKEN: "INERT_HOST_MCP_SECRET", STRIDETERM_HOST_TOKEN: "INERT_HOST_MCP_SECRET" },
        },
        remote: {
          type: "remote",
          url: "https://x.example",
          headers: { Authorization: "Bearer INERT_HOST_MCP_SECRET" },
        },
        review: {
          type: "local",
          command: ["node", "bridge.mjs"],
          environment: {
            STRIDETERM_REVIEW_GIT_CAPABILITY: "cap",
            HTTP_PROXY: "{env:HTTP_PROXY}",
            LEAK: "INERT_HOST_MCP_SECRET",
          },
          enabled: true,
        },
      },
      permission: { bash: "ask" },
    });
    const env = sanitizeSandboxEnv({
      env: { OPENCODE_CONFIG_CONTENT: inherited },
      platform: "linux",
      agent: getAgentSandboxProfile("opencode"),
      toolchains: [],
    });
    const text = env.OPENCODE_CONFIG_CONTENT;
    expect(text).not.toContain("INERT_HOST_MCP_SECRET");
    expect(text).not.toContain("INERT_PROVIDER_KEY");
    const parsed = JSON.parse(text);
    expect(parsed.permission).toEqual({ bash: "ask" });
    expect(Object.keys(parsed.mcp)).toEqual(["hostGit", "review"]);
    expect(parsed.mcp.review.environment).toEqual({
      STRIDETERM_REVIEW_GIT_CAPABILITY: "cap",
      HTTP_PROXY: "{env:HTTP_PROXY}",
    });
    const hostCopy = sanitizeSandboxEnv({
      env: { OPENCODE_CONFIG_CONTENT: inherited },
      hostEnv: { OPENCODE_CONFIG_CONTENT: inherited },
      platform: "linux",
      agent: getAgentSandboxProfile("opencode"),
      toolchains: [],
    });
    expect(hostCopy).toEqual({});
    expect(
      sanitizeSandboxEnv({
        env: { OPENCODE_CONFIG_CONTENT: "{not json" },
        platform: "linux",
        agent: null,
        toolchains: [],
      }),
    ).toEqual({});
  });

  it("gives an agent without a login variable none, even for a well-known token name", () => {
    const env = sanitizeSandboxEnv({
      env: { OPENAI_API_KEY: "k" },
      platform: "linux",
      agent: getAgentSandboxProfile("claude"),
      toolchains: [],
    });
    expect(env).toEqual({});
  });
});

describe("Claude's .claude.json", () => {
  it("is not in any grant: the agent's state file is the sandbox's own copy", () => {
    const profile = getAgentSandboxProfile("claude")!;
    expect(profile.stateFiles).toEqual([".claude.json"]);
    expect([...profile.readHome, ...profile.writeHome].some((item) => item.endsWith(".claude.json"))).toBe(false);
    const policy = buildSandboxPolicy(input({ agent: profile }));
    const lists = [
      policy.runtime.filesystem.allowRead,
      policy.runtime.filesystem.allowWrite,
      policy.optional.allowRead,
      policy.optional.allowWrite,
    ];
    for (const list of lists) expect(list.some((item) => item.endsWith(".claude.json"))).toBe(false);
  });
});

describe("native shared agent configuration", () => {
  it("keeps the agent's settings, hooks and MCP config read-only in its own folder, not only on Windows", () => {
    const { optional } = buildSandboxPolicy(input({ agent: getAgentSandboxProfile("codex") }));
    expect(optional.denyWrite).toEqual(
      expect.arrayContaining([
        "/home/dev/.codex/config.toml",
        "/home/dev/.codex/hooks",
        "/home/dev/.codex/settings.json",
      ]),
    );
    const claude = buildSandboxPolicy(input({ agent: getAgentSandboxProfile("claude") }));
    expect(claude.optional.denyWrite).toEqual(
      expect.arrayContaining([
        "/home/dev/.claude/settings.json",
        "/home/dev/.claude/hooks",
        "/home/dev/.config/claude/config.json",
      ]),
    );
    const opencode = buildSandboxPolicy(input({ agent: getAgentSandboxProfile("opencode") }));
    expect(opencode.optional.denyWrite).toContain("/home/dev/.config/opencode/opencode.json");
  });

  it("protects what the host auto-loads from an agent folder, whether or not it exists yet", () => {
    const opencode = buildSandboxPolicy(input({ agent: getAgentSandboxProfile("opencode") }));
    expect(opencode.optional.denyWrite).toEqual(
      expect.arrayContaining(["/home/dev/.config/opencode/plugins", "/home/dev/.config/opencode/plugin"]),
    );
    const gemini = buildSandboxPolicy(input({ agent: getAgentSandboxProfile("gemini") }));
    expect(gemini.optional.denyWrite).toEqual(
      expect.arrayContaining(["/home/dev/.gemini/settings.json", "/home/dev/.gemini/extensions"]),
    );
  });

  it("keeps a protected path whose parent exists, so the agent cannot be the one to create it", () => {
    expect(SANDBOX_LAUNCHER_SOURCE).toContain("exists(path.dirname(item))");
    expect(SANDBOX_LAUNCHER_SOURCE).not.toContain("(optional.denyWrite || []).filter(exists)");
  });

  it("protects a Windows login target the same way", () => {
    const { optional } = buildSandboxPolicy(
      input({
        agent: getAgentSandboxProfile("codex"),
        loginLinks: [{ link: "/home/dev/.codex", target: "/mnt/c/Users/me/.codex" }],
      }),
    );
    expect(optional.denyWrite).toContain("/mnt/c/Users/me/.codex/config.toml");
  });
});

describe("workspace homes", () => {
  it("grants a per-workspace folder read-write and creates it, outside the shared cache", () => {
    const gradle = TOOLCHAIN_PROFILES.find((profile) => profile.id === "gradle")!;
    const policy = buildSandboxPolicy(
      input({
        toolchains: [gradle],
        workspaceHomes: ["/var/tmp/homes/w1/gradle"],
        ensureDirs: ["/var/tmp/cache/gradle/modules-2"],
      }),
    );
    expect(policy.runtime.filesystem.allowWrite).toContain("/var/tmp/homes/w1/gradle");
    expect(policy.runtime.filesystem.allowRead).toContain("/var/tmp/homes/w1/gradle");
    expect(policy.ensureDirs).toEqual(
      expect.arrayContaining(["/var/tmp/homes/w1/gradle", "/var/tmp/cache/gradle/modules-2"]),
    );
    const home = "/var/tmp/homes/w1/gradle";
    for (const granted of policy.runtime.filesystem.allowWrite) {
      if (granted !== home) expect(home.startsWith(`${granted}/`)).toBe(false);
    }
  });
});

import { parseAgentCommand } from "../../shared/agent-ssh.js";

/**
 * What one agent CLI needs inside the sandbox: the destinations it talks to, where its binary,
 * data and sign-in live (relative to the home directory), and the few environment variables that
 * carry its own sign-in to its model. Everything else about the home directory stays unreadable.
 */
export interface AgentSandboxProfile {
  id: string;
  /** Destinations the agent needs: its model, sign-in and update endpoints. */
  domains: string[];
  /** Home-relative paths the agent may read (binary, configuration, sign-in). */
  readHome: string[];
  /** Home-relative paths the agent may write (sessions, caches, sign-in refresh). */
  writeHome: string[];
  /**
   * Home-relative folders the agent's own installer puts its executable in and adds to PATH only in an interactive
   * shell's rc file (`~/.opencode/bin` from `.bashrc`). Readable, searched by the probe, and on PATH inside the sandbox.
   */
  binHome?: string[];
  /**
   * Home-relative FILES that hold the agent's state and also configuration the host CLI obeys (Claude's
   * `.claude.json` carries MCP server definitions). They are never shared: the sandbox gets its own copy,
   * seeded from the host's file, so what the agent writes there cannot reach the host's configuration.
   */
  stateFiles?: string[];
  /**
   * Home-relative configuration files that can carry credentials of tools other than the model (MCP servers' env and
   * headers, hooks, helper commands). Their folder is NOT granted whole: the sandbox gets a mirror of the folder
   * without them and a sanitized copy of each, regenerated from the host's file on every launch.
   */
  configFiles?: AgentConfigFile[];
  /**
   * Environment variable names kept from the host. This is the single exception to "no token in
   * the sandbox": the agent's own sign-in to its model.
   */
  loginEnv: string[];
  /**
   * macOS only: the agent verifies TLS through the system trust service (`com.apple.trustd.agent`), which Seatbelt
   * blocks by default. Codex does; without it every HTTPS request fails ("workspace routing discovery failed").
   * Opens the trust service as a channel out, so it is granted per agent, never to all of them.
   */
  needsSystemTrust?: boolean;
}

export interface AgentConfigFile {
  path: string;
  /**
   * `omit`: not copied at all (an MCP sign-in store that holds no model login). `claude-credentials`: a store that mixes
   * the model login with MCP sign-ins — only the model login is copied, and a renewed one is carried back at the end.
   */
  format: "json" | "toml" | "env" | "claude-credentials" | "copilot-config" | "omit";
}

const AGENT_PROFILES: Record<string, AgentSandboxProfile> = {
  claude: {
    id: "claude",
    domains: ["api.anthropic.com", "*.anthropic.com", "claude.ai", "*.claude.ai", "claude.com", "*.claude.com"],
    readHome: [".claude", ".local/share/claude", ".config/claude"],
    writeHome: [".claude", ".cache/claude", ".config/claude"],
    stateFiles: [".claude.json"],
    configFiles: [
      { path: ".claude/settings.json", format: "json" },
      { path: ".claude/settings.local.json", format: "json" },
      { path: ".claude/.credentials.json", format: "claude-credentials" },
    ],
    loginEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  },
  codex: {
    id: "codex",
    domains: ["api.openai.com", "auth.openai.com", "chatgpt.com", "*.chatgpt.com"],
    readHome: [".codex"],
    writeHome: [".codex"],
    configFiles: [
      { path: ".codex/config.toml", format: "toml" },
      { path: ".codex/hooks.json", format: "json" },
    ],
    loginEnv: ["OPENAI_API_KEY"],
    needsSystemTrust: true,
  },
  copilot: {
    id: "copilot",
    domains: [
      "api.githubcopilot.com",
      "*.githubcopilot.com",
      "github.com",
      "api.github.com",
      "copilot-proxy.githubusercontent.com",
    ],
    readHome: [".copilot", ".config/github-copilot"],
    writeHome: [".copilot", ".config/github-copilot", ".cache/copilot"],
    configFiles: [
      { path: ".copilot/mcp-config.json", format: "json" },
      { path: ".copilot/config.json", format: "copilot-config" },
    ],
    loginEnv: ["COPILOT_GITHUB_TOKEN"],
  },
  opencode: {
    id: "opencode",
    domains: ["opencode.ai", "*.opencode.ai", "models.dev"],
    readHome: [
      ".opencode/bin",
      ".config/opencode",
      ".local/share/opencode",
      ".cache/opencode",
      ".local/state/opencode",
    ],
    writeHome: [".config/opencode", ".local/share/opencode", ".cache/opencode", ".local/state/opencode"],
    binHome: [".opencode/bin"],
    configFiles: [
      { path: ".config/opencode/opencode.json", format: "json" },
      { path: ".config/opencode/opencode.jsonc", format: "json" },
      { path: ".local/share/opencode/mcp-auth.json", format: "omit" },
    ],
    loginEnv: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  },
  gemini: {
    id: "gemini",
    domains: [
      "generativelanguage.googleapis.com",
      "cloudcode-pa.googleapis.com",
      "oauth2.googleapis.com",
      "accounts.google.com",
    ],
    readHome: [".gemini"],
    writeHome: [".gemini"],
    configFiles: [
      { path: ".gemini/settings.json", format: "json" },
      { path: ".gemini/.env", format: "env" },
      { path: ".gemini/mcp-oauth-tokens.json", format: "omit" },
    ],
    loginEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
};

export function getAgentSandboxProfile(providerId: string): AgentSandboxProfile | null {
  return AGENT_PROFILES[providerId] ?? null;
}

/** Home-relative folders an agent's installer may have put it in outside a non-interactive shell's PATH. */
export function agentBinHome(providerId: string): string[] {
  return AGENT_PROFILES[providerId]?.binHome ?? [];
}

/** Every provider with a profile, in the catalog's vocabulary. */
export function listAgentSandboxProfiles(): AgentSandboxProfile[] {
  return Object.values(AGENT_PROFILES);
}

const folderOf = (file: AgentConfigFile) => file.path.split("/").slice(0, -1).join("/");

/** Home-relative folders of the agent that hold a credential-bearing config file: mirrored, never granted whole. */
export function mirroredAgentFolders(agent: AgentSandboxProfile | null): string[] {
  return [...new Set((agent?.configFiles ?? []).map(folderOf))];
}

/** File names, per mirrored folder, that the mirror leaves out (the sandbox gets a sanitized copy instead). */
export function mirrorExclusions(agent: AgentSandboxProfile | null, folder: string): string[] {
  return (agent?.configFiles ?? [])
    .filter((file) => folderOf(file) === folder)
    .map((file) => file.path.split("/").at(-1) as string);
}

export { detectSandboxAgent } from "../../shared/sandbox-eligibility.js";

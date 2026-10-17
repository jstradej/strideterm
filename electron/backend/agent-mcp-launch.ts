/**
 * How an MCP server is handed to an agent CLI at launch, shared by the review bridge and the
 * per-session grants (Built-in SSH, internal task MCP): Claude `--mcp-config`, Codex
 * `-c mcp_servers.*` (with `env_vars` naming — never carrying — the grant variables) and
 * Copilot `--additional-mcp-config`. Existing servers and the user's own config are kept.
 */

export interface AgentMcpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** A server to install for one launch, plus the names of the per-session grant variables it reads. */
export interface AgentMcpInstall {
  name: string;
  spec: AgentMcpServerSpec;
  grantEnvVars: string[];
}

export function installEnvVars(install: AgentMcpInstall): string[] {
  return [...new Set([...Object.keys(install.spec.env || {}), ...install.grantEnvVars])];
}

export function installsEnv(installs: AgentMcpInstall[]): Record<string, string> {
  return Object.assign({}, ...installs.map((install) => install.spec.env || {}));
}

export function claudeMcpServerEntries(installs: AgentMcpInstall[]): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const { name, spec } of installs) {
    entries[name] = { command: spec.command, args: spec.args, ...(spec.env ? { env: spec.env } : {}) };
  }
  return entries;
}

export function appendClaudeMcpServers(args: string[], additions: Record<string, unknown>): void {
  const merged: Record<string, unknown> = {};
  const existingServers: Record<string, unknown> = {};
  const configFiles: string[] = [];
  const retained: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const inline = arg.startsWith("--mcp-config=") ? arg.slice("--mcp-config=".length) : null;
    if (arg === "--mcp-config" || inline !== null) {
      const values: string[] = [];
      if (inline !== null) values.push(inline);
      else {
        while (index + 1 < args.length && !args[index + 1].startsWith("-")) values.push(args[++index]);
      }
      if (values.length === 0) throw new Error("Claude --mcp-config is missing its config value.");
      for (const value of values) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          configFiles.push(value);
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          configFiles.push(value);
          continue;
        }
        const config = parsed as Record<string, unknown>;
        Object.assign(merged, config);
        const servers = config.mcpServers;
        if (servers !== undefined) {
          if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
            throw new Error("Agent MCP tools require Claude mcpServers to be a JSON object.");
          }
          Object.assign(existingServers, servers);
        }
      }
      continue;
    }
    retained.push(arg);
  }
  merged.mcpServers = { ...existingServers, ...additions };
  retained.push("--mcp-config", ...configFiles, JSON.stringify(merged));
  args.splice(0, args.length, ...retained);
}

export function pushCodexMcpInstalls(args: string[], installs: AgentMcpInstall[]): void {
  for (const install of installs) {
    args.push(
      "-c",
      `mcp_servers.${install.name}.command=${JSON.stringify(install.spec.command)}`,
      "-c",
      `mcp_servers.${install.name}.args=${JSON.stringify(install.spec.args)}`,
      "-c",
      `mcp_servers.${install.name}.env_vars=${JSON.stringify(installEnvVars(install))}`,
    );
  }
}

export function copilotMcpConfigArgs(servers: Record<string, unknown>): string[] {
  return ["--additional-mcp-config", JSON.stringify({ mcpServers: servers })];
}

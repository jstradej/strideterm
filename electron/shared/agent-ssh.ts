export type AgentSshMcpProvider = "claude" | "codex";
export const SSH_MCP_URL_ENV = "STRIDETERM_SSH_MCP_URL";
export const SSH_MCP_CAPABILITY_ENV = "STRIDETERM_SSH_MCP_CAPABILITY";

export interface ParsedAgentCommand {
  provider: AgentSshMcpProvider;
  executable: string;
  args: string[];
}

export interface AgentSshMcpEligibility {
  supported: boolean;
  provider: AgentSshMcpProvider | null;
  reason: string | null;
}

const UNSUPPORTED_REASON = "SSH tools are available only when this tab directly launches Claude Code or Codex.";

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let tokenStarted = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = "";
        continue;
      }
      if (
        char === "\\" &&
        quote === '"' &&
        index + 1 < command.length &&
        ["\\", '"', "'"].includes(command[index + 1])
      ) {
        current += command[++index];
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (tokenStarted) tokens.push(current);
      current = "";
      tokenStarted = false;
      continue;
    }
    if (char === "\\" && index + 1 < command.length && ["\\", '"', "'"].includes(command[index + 1])) {
      current += command[++index];
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (quote) return [];
  if (tokenStarted) tokens.push(current);
  return tokens;
}

function commandProvider(executable: string): AgentSshMcpProvider | null {
  const basename = executable.split(/[\\/]/u).pop()?.toLowerCase() || "";
  const withoutExtension = basename.replace(/\.(?:exe|cmd|bat|com)$/u, "");
  return withoutExtension === "claude" || withoutExtension === "codex" ? withoutExtension : null;
}

function containsShellOperator(command: string): boolean {
  let quote = "";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (quote === '"' && (char === "`" || (char === "$" && /[A-Za-z_{(]/u.test(command[index + 1] || "")))) {
        return true;
      }
      if (char === "%" && /[A-Za-z_]/u.test(command[index + 1] || "") && command.indexOf("%", index + 1) > index + 1)
        return true;
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"') index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if ([";", "|", "&", ">", "<", "`"].includes(char)) {
      return true;
    }
    if (char === "$" && /[A-Za-z_{(]/u.test(command[index + 1] || "")) return true;
    if (char === "%" && /[A-Za-z_]/u.test(command[index + 1] || "") && command.indexOf("%", index + 1) > index + 1)
      return true;
  }
  return false;
}

export function parseAgentCommand(command: unknown): ParsedAgentCommand | null {
  const text = String(command || "").trim();
  if (!text || /[\0\r\n]/u.test(text) || containsShellOperator(text)) return null;
  const tokens = tokenizeCommand(text);
  if (!tokens.length) return null;
  const provider = commandProvider(tokens[0]);
  if (!provider) return null;
  const firstArg = (tokens[1] || "").toLowerCase();
  if (
    (provider === "claude" && ["auth", "mcp", "plugin", "plugins", "install", "update", "doctor"].includes(firstArg)) ||
    (provider === "codex" && ["mcp", "login", "logout", "completion", "debug"].includes(firstArg))
  ) {
    return null;
  }
  return { provider, executable: tokens[0], args: tokens.slice(1) };
}

export function getAgentSshMcpEligibility(command: unknown): AgentSshMcpEligibility {
  const parsed = parseAgentCommand(command);
  return parsed
    ? { supported: true, provider: parsed.provider, reason: null }
    : { supported: false, provider: null, reason: UNSUPPORTED_REASON };
}

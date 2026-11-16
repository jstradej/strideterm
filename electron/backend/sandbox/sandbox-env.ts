import type { AgentSandboxProfile } from "./agent-profile.js";
import type { ToolchainProfile } from "./toolchain-profile.js";

/**
 * The environment a sandboxed process gets. Invariant: no token from the host reaches the sandbox; the
 * single exception is the agent's own sign-in to its model (`AgentSandboxProfile.loginEnv`).
 *
 * It is an allowlist, not a scrub: a name the list does not know is dropped, so a token variable the
 * list has never heard of cannot leak. Names that look like secrets are dropped even when allowed by
 * prefix, except the session's own named `STRIDETERM_*` grants, which are the sandbox's capabilities.
 */

const COMMON = new Set([
  "TERM",
  "COLORTERM",
  "FORCE_COLOR",
  "TERM_PROGRAM",
  "COLORFGBG",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
]);

/** OpenCode's inline config: the one variable whose VALUE, not its name, can carry other tools' credentials. */
const OPENCODE_INLINE_CONFIG = "OPENCODE_CONFIG_CONTENT";

/** Unix names that make the shell and tools behave; on Windows the distro's login shell provides them. */
const UNIX_ONLY = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL"]);

/**
 * The `STRIDETERM_*` names a launch really sets: the session's identity and the capabilities of its own brokers, and the
 * review checkout's paths. Any other name (a token the host process was started with) is not a capability of this session.
 */
const STRIDETERM_SESSION_NAMES = new Set([
  "STRIDETERM_SESSION_ID",
  "STRIDETERM_SESSION_TOKEN",
  "STRIDETERM_NOTIFY_URL",
  "STRIDETERM_INTERNAL_MCP_URL",
  "STRIDETERM_INTERNAL_MCP_CAPABILITY",
  "STRIDETERM_INTERNAL_MCP_TASKS_ENABLED",
  "STRIDETERM_INTERNAL_MCP_JIRA_ENABLED",
  "STRIDETERM_REVIEW_GIT_URL",
  "STRIDETERM_REVIEW_GIT_CAPABILITY",
  "STRIDETERM_SSH_MCP_URL",
  "STRIDETERM_SSH_MCP_CAPABILITY",
  "STRIDETERM_REVIEW_PROVIDER",
  "STRIDETERM_REVIEW_PR_KEY",
  "STRIDETERM_REVIEW_ROOT",
  "STRIDETERM_REVIEW_DB",
  "STRIDETERM_REVIEW_STORE_DIR",
  "STRIDETERM_REVIEW_EXPORT_DIR",
  "STRIDETERM_REVIEW_BRIEF_MD",
  "STRIDETERM_REVIEW_BRIEF_JSON",
  "STRIDETERM_REVIEW_CLI",
  "STRIDETERM_REVIEW_WORKSPACE_ID",
]);

const SECRET_LIKE = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY|COOKIE)/iu;

export interface SandboxEnvInput {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  agent: AgentSandboxProfile | null;
  toolchains: ToolchainProfile[];
  /** The host process's own environment: an inline OpenCode config identical to it was inherited, not issued by the runtime. */
  hostEnv?: Record<string, string | undefined>;
}

export function sanitizeSandboxEnv({
  env,
  platform,
  agent,
  toolchains,
  hostEnv,
}: SandboxEnvInput): Record<string, string> {
  const login = new Set(agent?.loginEnv ?? []);
  const toolchainNames = new Set(toolchains.flatMap((profile) => Object.keys(profile.env)));
  const out: Record<string, string> = {};
  const nameAllowed = (name: string, withCommon: boolean): boolean => {
    const upper = platform === "win32" ? name.toUpperCase() : name;
    const stridetermOwn = STRIDETERM_SESSION_NAMES.has(upper);
    const allowed =
      stridetermOwn ||
      (withCommon && COMMON.has(upper)) ||
      (withCommon && platform !== "win32" && UNIX_ONLY.has(upper)) ||
      login.has(upper) ||
      toolchainNames.has(upper) ||
      (withCommon && platform !== "win32" && /^LC_[A-Z_]+$/u.test(upper));
    if (!allowed) return false;
    return !(SECRET_LIKE.test(upper) && !stridetermOwn && !login.has(upper));
  };
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const upper = platform === "win32" ? name.toUpperCase() : name;
    if (upper === OPENCODE_INLINE_CONFIG) {
      // Its command argv is trusted only when the runtime issued it; a copy of the host's own value is dropped whole.
      if (hostEnv && Object.entries(hostEnv).some(([key, host]) => key.toUpperCase() === upper && host === value))
        continue;
      const inline = sanitizeOpencodeInlineConfig(value, (key) => nameAllowed(key, false));
      if (inline) out[name] = inline;
      continue;
    }
    if (nameAllowed(name, true)) out[name] = value;
  }
  return out;
}

/**
 * OpenCode reads MCP servers (with their `environment` and `headers`) from this variable. A value inherited from the host
 * carries whatever the host's tools authenticate with, so only the shape the runtime itself issues survives: `mcp` servers
 * with their command and the session's own named variables, and `permission`. Unparseable content is dropped whole.
 */
function sanitizeOpencodeInlineConfig(value: string, keepName: (name: string) => boolean): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (source.permission !== undefined) out.permission = source.permission;
  if (source.mcp && typeof source.mcp === "object" && !Array.isArray(source.mcp)) {
    const servers: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(source.mcp as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const server = raw as Record<string, unknown>;
      if (server.type !== "local" || !Array.isArray(server.command)) continue;
      const environment: Record<string, unknown> = {};
      const own = server.environment;
      if (own && typeof own === "object" && !Array.isArray(own)) {
        for (const [key, inner] of Object.entries(own as Record<string, unknown>)) {
          // A `{env:NAME}` placeholder is a forwarding by name, never a value.
          if (typeof inner === "string" && (keepName(key) || inner === `{env:${key}}`)) environment[key] = inner;
        }
      }
      servers[name] = {
        type: "local",
        command: server.command,
        environment,
        ...(typeof server.enabled === "boolean" ? { enabled: server.enabled } : {}),
      };
    }
    out.mcp = servers;
  }
  return JSON.stringify(out);
}

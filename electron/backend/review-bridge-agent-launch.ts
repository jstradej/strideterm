/// <reference types="node" />
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_REVIEW_AGENTS = new Set(["claude", "codex", "copilot", "opencode"]);
const DEFAULT_APP_ENTRY = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const REVIEW_BRIDGE_STDIO_ENTRY = fileURLToPath(new URL("./review-bridge-mcp-stdio.js", import.meta.url));

interface ReviewPanel {
  id?: string;
  title?: string;
  command?: string;
}

interface ReviewRepository {
  id?: string;
  name?: string;
}

interface ReviewPullRequest {
  id?: number;
  title?: string;
  sourceRefName?: string;
  targetRefName?: string;
}

interface ReviewContext {
  rootPath?: string;
  prKey?: string;
  workspaceId?: string;
  reviewWorkspaceId?: string;
  repository?: ReviewRepository;
  pullRequest?: ReviewPullRequest;
}

interface ProcessInfo {
  execPath?: string;
  argv?: string[];
  defaultApp?: boolean;
  platform?: string;
  pathEnv?: string;
  commandLookup?: Record<string, string>;
  pathExists?: (p: string) => boolean;
}

interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface AgentLaunch {
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  skipCommandInjection: boolean;
}

interface BuildLaunchInput {
  workspace?: { cwd?: string };
  panel?: ReviewPanel;
  context?: ReviewContext;
  processInfo?: ProcessInfo;
}

function normalizeText(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function firstCommandToken(command: unknown): string {
  const normalized = normalizeText(command);
  if (!normalized) {
    return "";
  }
  return normalized.split(/\s+/u)[0] || "";
}

function tokenizeCommand(command: unknown): string[] {
  const input = String(command || "").trim();
  if (!input) {
    return [];
  }

  const tokens: string[] = [];
  let current = "";
  let quote = "";

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        quote = "";
        continue;
      }

      if (char === "\\" && quote === '"' && index + 1 < input.length && ["\\", '"', "'"].includes(input[index + 1])) {
        index += 1;
        current += input[index];
        continue;
      }

      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (char === "\\" && index + 1 < input.length && ["\\", '"', "'"].includes(input[index + 1])) {
      index += 1;
      current += input[index];
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function commandBasename(command: unknown): string {
  const token = firstCommandToken(command);
  if (!token) {
    return "";
  }
  return normalizeText(path.parse(token).name || token);
}

function inheritedPanelArgs(panel: ReviewPanel = {}): string[] {
  const tokens = tokenizeCommand(panel.command);
  return tokens.length > 1 ? tokens.slice(1) : [];
}

function hasCodexSandboxOverride(args: string[] = []): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || "").trim();
    if (!value) {
      continue;
    }
    if (value === "-s" || value === "--sandbox") {
      return true;
    }
    if (value.startsWith("--sandbox=")) {
      return true;
    }
  }
  return false;
}

function pushWorkspaceScope(args: string[], workspaceCwd: unknown): void {
  const cwd = String(workspaceCwd || "").trim();
  if (!cwd) {
    return;
  }
  args.push("--add-dir", cwd);
}

// Review context is only ever handed to an agent as *passive* context, never as
// a turn the agent is expected to act on. Claude takes it via
// --append-system-prompt, which does not start a run. Codex ([PROMPT]
// positional), Copilot (-i) and OpenCode (--prompt) have no equivalent: their
// only prompt inputs submit immediately, so opening one of those tabs in a
// review workspace would kick off an unrequested review run. Those three get
// the MCP wiring and nothing else — the user drives the first turn.
function buildReviewPrompt(context: ReviewContext | undefined): string {
  const repository = String(context?.repository?.name || context?.repository?.id || "the repository").trim();
  const pullRequestId = Number.isInteger(context?.pullRequest?.id) ? `PR #${context!.pullRequest!.id}` : null;
  const title = String(context?.pullRequest?.title || "").trim();

  if (!pullRequestId) {
    return [
      "You are working inside a strIDEterm review workspace.",
      "Review MCP tools are available but will activate once a pull request is created.",
      "For now, focus on implementing and committing your changes.",
    ].join(" ");
  }

  const label = title ? `${pullRequestId} (${title})` : pullRequestId;
  return [
    `You are working inside a strIDEterm review workspace for ${label} in ${repository}.`,
    "Use the embedded review MCP tools first.",
    "Start with list_review_comments.",
    "Use get_review_comment for details, save_review_draft for replies, create_review_comment for new findings, and queue_review_draft only when a draft is ready.",
    "Do not publish to Azure DevOps directly.",
  ].join(" ");
}

function windowsPathList(pathValue: unknown): string[] {
  return String(pathValue || "")
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function resolveWindowsCommandPath(
  commandName: string,
  processInfo: ProcessInfo = {},
  preferredExtensions: string[] = [],
): string {
  const overrides = processInfo.commandLookup || {};
  const explicit = String(overrides[commandName] || "").trim();
  if (explicit) {
    return explicit;
  }

  const executableExtensions = preferredExtensions.length
    ? preferredExtensions
    : [".exe", ".cmd", ".bat", ".com", ".ps1"];
  const pathEntries = windowsPathList(processInfo.pathEnv || process.env.PATH || "");
  const baseName = String(commandName || "").trim();
  if (!baseName) {
    return "";
  }

  for (const entry of pathEntries) {
    for (const extension of executableExtensions) {
      const candidate = path.join(entry, baseName.endsWith(extension) ? baseName : `${baseName}${extension}`);
      try {
        if (typeof processInfo.pathExists === "function") {
          if (processInfo.pathExists(candidate)) {
            return candidate;
          }
          continue;
        }
        if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {}
    }
  }

  return "";
}

interface FinishLaunchInput {
  platform?: string;
  commandName: string;
  preferredExtensions?: string[];
  args: string[];
  workspace?: { cwd?: string };
  processInfo?: ProcessInfo;
  // env to attach when running on win32 (both the resolved-binary and the
  // bare-command-fallback returns always carry it, matching the pre-refactor
  // per-provider tails).
  win32Env?: Record<string, string>;
  // env to attach on non-win32 platforms. Omitted entirely (no `env` key)
  // unless a provider explicitly needs one there (only OpenCode does, since
  // it ships its MCP config via env on every platform, not just win32).
  nonWin32Env?: Record<string, string>;
  // Overrides the default single-binary `resolveWindowsCommandPath` lookup
  // for providers whose win32 resolution needs more than one binary (Codex
  // resolves both `node` and `codex` and rewrites `args` around them).
  resolveWin32?: () => { file: string; args: string[] } | null;
}

// Shared win32 binary-resolution-with-fallback tail used by every
// buildXxxLaunch function: try to resolve a real path for the provider's
// command on Windows, fall back to invoking the bare command name if that
// fails (relying on shell/PATH resolution), and leave non-Windows platforms
// untouched.
function finishLaunch({
  platform,
  commandName,
  preferredExtensions,
  args,
  workspace,
  processInfo,
  win32Env,
  nonWin32Env,
  resolveWin32,
}: FinishLaunchInput): AgentLaunch {
  const cwd = workspace?.cwd || "";

  if (platform === "win32") {
    const resolved = resolveWin32
      ? resolveWin32()
      : (() => {
          const resolvedPath = resolveWindowsCommandPath(commandName, processInfo, preferredExtensions);
          return resolvedPath ? { file: resolvedPath, args } : null;
        })();

    if (resolved) {
      return {
        file: resolved.file,
        args: resolved.args,
        cwd,
        env: win32Env || {},
        skipCommandInjection: true,
      };
    }

    return {
      file: commandName,
      args,
      cwd,
      env: win32Env || {},
      skipCommandInjection: true,
    };
  }

  return {
    file: commandName,
    args,
    cwd,
    ...(nonWin32Env !== undefined ? { env: nonWin32Env } : {}),
    skipCommandInjection: true,
  };
}

function resolveDefaultAppEntry(processInfo: ProcessInfo = {}): string {
  const argv = Array.isArray(processInfo.argv) ? processInfo.argv : [];
  const explicitTarget = argv.slice(1).find((value) => {
    const text = String(value || "").trim();
    return text && !text.startsWith("-");
  });
  if (!explicitTarget) {
    return DEFAULT_APP_ENTRY;
  }
  if (path.isAbsolute(explicitTarget)) {
    return explicitTarget;
  }
  return path.resolve(DEFAULT_APP_ENTRY, explicitTarget);
}

function buildMcpServerSpec({
  context,
  processInfo,
}: {
  context?: ReviewContext;
  processInfo?: ProcessInfo;
}): McpServerSpec {
  const command = String(processInfo?.execPath || process.execPath || "").trim();
  if (!command) {
    throw new Error("Review bridge MCP launch is missing an executable path.");
  }

  const args = ["--review-bridge-mcp", "--review-root", String(context?.rootPath || "")];
  const workspaceId = context?.reviewWorkspaceId || context?.workspaceId || "";
  if (workspaceId) {
    args.push("--review-workspace-id", String(workspaceId));
  }
  if (context?.prKey) {
    args.push("--review-pr-key", String(context.prKey));
  }

  const platform = processInfo?.platform || process.platform;
  if (platform === "win32") {
    return {
      command,
      args: [REVIEW_BRIDGE_STDIO_ENTRY, ...args],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
      },
    };
  }

  if (processInfo?.defaultApp) {
    return {
      command,
      args: [resolveDefaultAppEntry(processInfo), ...args],
    };
  }

  return { command, args };
}

function buildClaudeLaunch({ workspace, panel, context, processInfo }: BuildLaunchInput): AgentLaunch {
  const mcp = buildMcpServerSpec({ context, processInfo });
  const platform = processInfo?.platform || process.platform;
  const args = [...inheritedPanelArgs(panel)];
  pushWorkspaceScope(args, workspace?.cwd);
  args.push(
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        review: {
          command: mcp.command,
          args: mcp.args,
          env: mcp.env,
        },
      },
    }),
    "--strict-mcp-config",
    "--append-system-prompt",
    buildReviewPrompt(context),
  );

  return finishLaunch({
    platform,
    commandName: "claude",
    preferredExtensions: [".exe", ".cmd", ".bat"],
    args,
    workspace,
    processInfo,
    win32Env: mcp.env,
  });
}

function buildCodexLaunch({ workspace, panel, context, processInfo }: BuildLaunchInput): AgentLaunch {
  const mcp = buildMcpServerSpec({ context, processInfo });
  const platform = processInfo?.platform || process.platform;
  const args = [...inheritedPanelArgs(panel)];
  if (!hasCodexSandboxOverride(args)) {
    args.unshift("workspace-write");
    args.unshift("-s");
  }
  pushWorkspaceScope(args, workspace?.cwd);
  args.push(
    "-c",
    `mcp_servers.review.command=${JSON.stringify(mcp.command)}`,
    "-c",
    `mcp_servers.review.args=${JSON.stringify(mcp.args)}`,
  );

  return finishLaunch({
    platform,
    commandName: "codex",
    args,
    workspace,
    processInfo,
    win32Env: mcp.env,
    // Codex needs both `node` and its own shim resolved on Windows: the
    // launch invokes node directly against the resolved codex.js entrypoint
    // rather than the shim itself, so this can't use the generic single-path
    // resolution the other providers share.
    resolveWin32: () => {
      const nodePath = resolveWindowsCommandPath("node", processInfo, [".exe", ".cmd", ".bat"]);
      const codexShim = resolveWindowsCommandPath("codex", processInfo, [".cmd", ".bat", ".ps1", ".exe"]);
      if (!nodePath || !codexShim) {
        return null;
      }
      return {
        file: nodePath,
        args: [path.join(path.dirname(codexShim), "node_modules", "@openai", "codex", "bin", "codex.js"), ...args],
      };
    },
  });
}

function buildCopilotLaunch({ workspace, panel, context, processInfo }: BuildLaunchInput): AgentLaunch {
  const mcp = buildMcpServerSpec({ context, processInfo });
  const platform = processInfo?.platform || process.platform;
  const args = [...inheritedPanelArgs(panel)];
  if (!args.includes("--allow-all-tools") && !args.includes("--yolo") && !args.includes("--allow-all")) {
    args.unshift("--allow-all-tools");
  }
  // Copilot exposes per-session MCP servers via --additional-mcp-config. The
  // argument accepts inline JSON (matches Claude's --mcp-config shape).
  args.push(
    "--additional-mcp-config",
    JSON.stringify({
      mcpServers: {
        review: {
          command: mcp.command,
          args: mcp.args,
          env: mcp.env,
        },
      },
    }),
    "--add-dir",
    String(workspace?.cwd || ""),
  );

  return finishLaunch({
    platform,
    commandName: "copilot",
    preferredExtensions: [".cmd", ".bat", ".exe", ".ps1"],
    args,
    workspace,
    processInfo,
    win32Env: mcp.env,
  });
}

function buildOpencodeLaunch({ workspace, panel, context, processInfo }: BuildLaunchInput): AgentLaunch {
  const mcp = buildMcpServerSpec({ context, processInfo });
  const platform = processInfo?.platform || process.platform;
  const args = [...inheritedPanelArgs(panel)];
  // --yolo is a real flag but `hidden: true`, so it does NOT show up in
  // `opencode --help` — don't "fix" it away after reading that output. OpenCode
  // resolves auto-approval as `auto || yolo || dangerously-skip-permissions`,
  // so this is exactly the documented --auto. Verified on opencode 1.18.14:
  // its yargs parser is strict (an unknown flag exits 1 with the help screen),
  // and --yolo starts the TUI normally.
  if (!args.includes("--yolo")) {
    args.unshift("--yolo");
  }

  // Unlike Claude/Codex/Copilot, OpenCode's CLI has no flag for inline
  // per-session MCP config. Its config loader does support OPENCODE_CONFIG_CONTENT
  // — an env var carrying an opencode.json fragment that's merged on top of the
  // project config (see https://opencode.ai/docs/mcp-servers/ for the "mcp" shape,
  // which uses a combined command+args array and "environment" instead of "env").
  const configContent = JSON.stringify({
    mcp: {
      review: {
        type: "local",
        command: [mcp.command, ...mcp.args],
        environment: mcp.env,
        enabled: true,
      },
    },
  });
  const env = { ...(mcp.env || {}), OPENCODE_CONFIG_CONTENT: configContent };

  return finishLaunch({
    platform,
    commandName: "opencode",
    preferredExtensions: [".cmd", ".bat", ".exe", ".ps1"],
    args,
    workspace,
    processInfo,
    win32Env: env,
    // Unlike Claude/Codex/Copilot, OpenCode needs its env on every platform
    // (its MCP config is delivered via OPENCODE_CONFIG_CONTENT, not a CLI
    // flag), so it's the only provider passing a non-win32 env too.
    nonWin32Env: env,
  });
}

export function detectReviewAgentPanel(panel: ReviewPanel = {}): string | null {
  const commandToken = firstCommandToken(panel.command);
  if (SUPPORTED_REVIEW_AGENTS.has(commandToken)) {
    return commandToken;
  }

  const basename = commandBasename(panel.command);
  if (SUPPORTED_REVIEW_AGENTS.has(basename)) {
    return basename;
  }

  const panelId = normalizeText(panel.id);
  if (SUPPORTED_REVIEW_AGENTS.has(panelId)) {
    return panelId;
  }

  const title = normalizeText(panel.title);
  if (title.includes("github copilot") || title.includes("copilot")) {
    return "copilot";
  }
  if (title.includes("claude")) {
    return "claude";
  }
  if (title.includes("codex")) {
    return "codex";
  }
  if (title.includes("opencode")) {
    return "opencode";
  }

  return null;
}

export { buildMcpServerSpec };

export function buildReviewAgentLaunch({
  workspace,
  panel,
  context,
  processInfo,
}: BuildLaunchInput): AgentLaunch | null {
  if (!context?.rootPath) {
    return null;
  }

  const agent = detectReviewAgentPanel(panel);
  if (agent === "claude") {
    return buildClaudeLaunch({ workspace, panel, context, processInfo });
  }
  if (agent === "codex") {
    return buildCodexLaunch({ workspace, panel, context, processInfo });
  }
  if (agent === "copilot") {
    return buildCopilotLaunch({ workspace, panel, context, processInfo });
  }
  if (agent === "opencode") {
    return buildOpencodeLaunch({ workspace, panel, context, processInfo });
  }
  return null;
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_REVIEW_AGENTS = new Set(["claude", "codex"]);
const DEFAULT_APP_ENTRY = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const REVIEW_BRIDGE_STDIO_ENTRY = fileURLToPath(new URL("./review-bridge-mcp-stdio.js", import.meta.url));

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function firstCommandToken(command) {
  const normalized = normalizeText(command);
  if (!normalized) {
    return "";
  }
  return normalized.split(/\s+/u)[0] || "";
}

function tokenizeCommand(command) {
  const input = String(command || "").trim();
  if (!input) {
    return [];
  }

  const tokens = [];
  let current = "";
  let quote = "";

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        quote = "";
        continue;
      }

      if (
        char === "\\"
        && quote === "\""
        && index + 1 < input.length
        && ["\\", "\"", "'"].includes(input[index + 1])
      ) {
        index += 1;
        current += input[index];
        continue;
      }

      current += char;
      continue;
    }

    if (char === "\"" || char === "'") {
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

    if (
      char === "\\"
      && index + 1 < input.length
      && ["\\", "\"", "'"].includes(input[index + 1])
    ) {
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

function commandBasename(command) {
  const token = firstCommandToken(command);
  if (!token) {
    return "";
  }
  return normalizeText(path.parse(token).name || token);
}

function inheritedPanelArgs(panel = {}) {
  const tokens = tokenizeCommand(panel.command);
  return tokens.length > 1 ? tokens.slice(1) : [];
}

function hasCodexSandboxOverride(args = []) {
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

function pushWorkspaceScope(args, workspaceCwd) {
  const cwd = String(workspaceCwd || "").trim();
  if (!cwd) {
    return;
  }
  args.push("--add-dir", cwd);
}

function buildReviewPrompt(context) {
  const repository = String(context?.repository?.name || context?.repository?.id || "the repository").trim();
  const pullRequestId = Number.isInteger(context?.pullRequest?.id) ? `PR #${context.pullRequest.id}` : "this PR";
  const title = String(context?.pullRequest?.title || "").trim();
  const label = title ? `${pullRequestId} (${title})` : pullRequestId;

  return [
    `You are working inside a strIDEterm review workspace for ${label} in ${repository}.`,
    "Use the embedded review MCP tools first.",
    "Start with list_review_comments.",
    "Use get_review_comment for details, save_review_draft for replies, create_local_comment for local follow-ups, and queue_review_draft only when a draft is ready.",
    "Do not publish to Azure DevOps directly.",
  ].join(" ");
}

function windowsPathList(pathValue) {
  return String(pathValue || "")
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function resolveWindowsCommandPath(commandName, processInfo = {}, preferredExtensions = []) {
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

function resolveDefaultAppEntry(processInfo = {}) {
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

function buildMcpServerSpec({ context, processInfo }) {
  const command = String(processInfo?.execPath || process.execPath || "").trim();
  if (!command) {
    throw new Error("Review bridge MCP launch is missing an executable path.");
  }

  const args = [
    "--review-bridge-mcp",
    "--review-root",
    String(context?.rootPath || ""),
    "--review-pr-key",
    String(context?.prKey || ""),
  ];

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

function buildClaudeLaunch({ workspace, panel, context, processInfo }) {
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

  if (platform === "win32") {
    const claudePath = resolveWindowsCommandPath("claude", processInfo, [".exe", ".cmd", ".bat"]);
    if (claudePath) {
      return {
        file: claudePath,
        args,
        cwd: workspace?.cwd || "",
        env: mcp.env || {},
        skipCommandInjection: true,
      };
    }

    return {
      file: "claude",
      args,
      cwd: workspace?.cwd || "",
      env: mcp.env || {},
      skipCommandInjection: true,
    };
  }

  return {
    file: "claude",
    args,
    cwd: workspace?.cwd || "",
    skipCommandInjection: true,
  };
}

function buildCodexLaunch({ workspace, panel, context, processInfo }) {
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
    buildReviewPrompt(context),
  );

  if (platform === "win32") {
    const nodePath = resolveWindowsCommandPath("node", processInfo, [".exe", ".cmd", ".bat"]);
    const codexShim = resolveWindowsCommandPath("codex", processInfo, [".cmd", ".bat", ".ps1", ".exe"]);
    if (nodePath && codexShim) {
      return {
        file: nodePath,
        args: [
          path.join(path.dirname(codexShim), "node_modules", "@openai", "codex", "bin", "codex.js"),
          ...args,
        ],
        cwd: workspace?.cwd || "",
        env: mcp.env || {},
        skipCommandInjection: true,
      };
    }

    return {
      file: "codex",
      args,
      cwd: workspace?.cwd || "",
      env: mcp.env || {},
      skipCommandInjection: true,
    };
  }

  return {
    file: "codex",
    args,
    cwd: workspace?.cwd || "",
    skipCommandInjection: true,
  };
}

export function detectReviewAgentPanel(panel = {}) {
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
  if (title.includes("claude")) {
    return "claude";
  }
  if (title.includes("codex")) {
    return "codex";
  }

  return null;
}

export { buildMcpServerSpec };

export function buildReviewAgentLaunch({ workspace, panel, context, processInfo }) {
  if (!workspace?.review?.prKey || !context?.prKey || !context?.rootPath) {
    return null;
  }

  const agent = detectReviewAgentPanel(panel);
  if (agent === "claude") {
    return buildClaudeLaunch({ workspace, panel, context, processInfo });
  }
  if (agent === "codex") {
    return buildCodexLaunch({ workspace, panel, context, processInfo });
  }
  return null;
}

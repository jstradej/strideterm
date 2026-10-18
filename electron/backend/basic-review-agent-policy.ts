export type BasicReviewProvider = "claude" | "codex" | "copilot" | "opencode";

export interface BasicReviewAgentPolicy {
  args: string[];
  env: Record<string, string>;
  opencodePermission?: Record<string, unknown>;
}

const reviewTools = [
  "list_review_comments",
  "get_review_comment",
  "get_review_changes",
  "create_review_comment",
] as const;

function retainModelAndEffort(args: string[]): string[] {
  const retained: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model" || arg === "-m" || arg === "--effort" || arg === "--reasoning-effort") {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) retained.push(arg, value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--model=") || arg.startsWith("--effort=") || arg.startsWith("--reasoning-effort=")) {
      retained.push(arg);
    }
  }
  return retained;
}

function claudePolicy(args: string[]): BasicReviewAgentPolicy {
  return {
    args: [
      ...retainModelAndEffort(args),
      "--tools",
      "Read,Glob,Grep",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      ...reviewTools.map((tool) => `mcp__review__${tool}`),
    ],
    env: {},
  };
}

function codexPolicy(args: string[]): BasicReviewAgentPolicy {
  return { args: [...retainModelAndEffort(args), "--sandbox", "read-only"], env: {} };
}

function copilotPolicy(args: string[]): BasicReviewAgentPolicy {
  const available = ["read", "view", "grep", "glob", ...reviewTools.map((tool) => `review-${tool}`)];
  return {
    args: [
      ...retainModelAndEffort(args),
      "--available-tools",
      ...available,
      "--allow-tool",
      "read",
      ...reviewTools.map((tool) => `review(${tool})`),
    ],
    // Copilot documents COPILOT_ALLOW_ALL=true as an environment equivalent of --allow-all-tools.
    env: { COPILOT_ALLOW_ALL: "false" },
  };
}

function opencodePolicy(args: string[]): BasicReviewAgentPolicy {
  const permission: Record<string, unknown> = {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    edit: "deny",
    bash: "deny",
  };
  for (const tool of reviewTools) permission[`review_${tool}`] = "allow";
  return { args: retainModelAndEffort(args), env: {}, opencodePermission: permission };
}

/**
 * Produces the provider controls for the one-shot draft-only PR action. Deliberately
 * keeps only model/effort preferences from the user's template; ordinary tab launch
 * arguments are handled by the existing launch path and are not modified here.
 */
export function buildBasicReviewAgentPolicy(
  provider: BasicReviewProvider,
  inheritedArgs: string[] = [],
): BasicReviewAgentPolicy {
  switch (provider) {
    case "claude":
      return claudePolicy(inheritedArgs);
    case "codex":
      return codexPolicy(inheritedArgs);
    case "copilot":
      return copilotPolicy(inheritedArgs);
    case "opencode":
      return opencodePolicy(inheritedArgs);
  }
}

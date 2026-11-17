import { parseAgentCommand } from "../../shared/agent-ssh.js";
import type { AutomationActor } from "../automations/automation-definitions.js";
import type { InternalMcpGrantContext } from "./internal-mcp-broker.js";

/** Derive privilege from the authenticated terminal command, never the tool input. */
export function automationActorForGrant(grant: InternalMcpGrantContext): AutomationActor {
  const parsed = parseAgentCommand(grant.command);
  const flag =
    parsed &&
    {
      claude: "--dangerously-skip-permissions",
      codex: "--dangerously-bypass-approvals-and-sandbox",
      copilot: "--allow-all-tools",
      opencode: "--yolo",
      gemini: "--yolo",
    }[parsed.provider];
  // Only commands built by our provider registry have a known argument grammar.
  // Unknown switches cannot confer privilege: they might consume the next token.
  const valueOptions = new Set(["--model", "-m", "--effort", "--reasoning-effort", "-c", "-s"]);
  let maySkip = false;
  if (parsed && flag) {
    for (let i = 0; i < parsed.args.length; i++) {
      const arg = parsed.args[i]!;
      if (arg === flag) {
        maySkip = true;
        continue;
      }
      if (valueOptions.has(arg)) {
        i++;
        continue;
      }
      maySkip = false;
      break;
    }
  }
  return { kind: "agent", sessionId: grant.sessionId, canSkipPermissions: maySkip };
}

import type { SandboxDeniedRequest } from "../../electron/shared/sandbox.js";
import { formatWorkspaceDisplayName } from "../../electron/shared/workspace-display.js";
import type { WorkspaceState } from "../../electron/shared/types/state.js";

const SECOND_LEVEL_LABELS = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne"]);
const LEADING_EMOJI = /^[\p{Extended_Pictographic}️‍\s]+/u;

/** The destination as the allowlist spells it: the port only when it is not the scheme's default. */
export function sandboxDestination(request: Pick<SandboxDeniedRequest, "host" | "port">): string {
  return request.port && request.port !== 443 && request.port !== 80 ? `${request.host}:${request.port}` : request.host;
}

/**
 * The part of a host a person recognises the service by. Display emphasis only, never a decision: it has no
 * public-suffix list, so an unusual suffix falls back to the last two labels.
 */
export function splitRegistrableDomain(host: string): { prefix: string; domain: string } {
  const labels = host.split(".");
  if (labels.length <= 2 || /^[0-9.]+$/u.test(host) || host.includes(":")) return { prefix: "", domain: host };
  const last = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  const keep = last.length === 2 && SECOND_LEVEL_LABELS.has(second) ? 3 : 2;
  const cut = labels.length - keep;
  return { prefix: `${labels.slice(0, cut).join(".")}.`, domain: labels.slice(cut).join(".") };
}

export function stripLeadingEmoji(title: string): string {
  return title.replace(LEADING_EMOJI, "").trim();
}

/** "Claude Code · demo", else the workspace name, else "An isolated tab". */
export function describeRequestSource(
  sessionId: string,
  workspaceId: string,
  workspaces: ReadonlyArray<WorkspaceState> | undefined,
): { label: string; workspaceName: string } {
  const workspace = workspaces?.find((item) => item.id === workspaceId);
  const workspaceName = formatWorkspaceDisplayName(workspace);
  const panelId = sessionId.startsWith(`${workspaceId}:`) ? sessionId.slice(workspaceId.length + 1) : "";
  const panel = panelId ? workspace?.panels?.find((item) => item.id === panelId) : undefined;
  const tab = stripLeadingEmoji(panel?.title || "");
  if (tab && workspaceName) return { label: `${tab} · ${workspaceName}`, workspaceName };
  return { label: tab || workspaceName || "An isolated tab", workspaceName };
}

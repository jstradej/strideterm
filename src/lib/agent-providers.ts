// Task-agent CLI provider catalog + command-line builder. Shared by
// WorkspaceDialog (backward-compat defaulting for older workspace drafts)
// and AgentProviderConfig (the worker/judge picker UI) so the two don't carry
// separate copies of the provider list (code review 2026-07 §3.5).
//
// Note: electron/backend and src/stores/app-dialog-actions.ts each keep their
// own equivalent command-string builder aligned with their own runtime needs
// (see buildProviderCommandString in app-dialog-actions.ts) — that's a
// pre-existing, intentionally separate copy and out of scope here.

import { PROVIDER_CHOICES, effortArgs } from "../../electron/shared/agent-provider-catalog.js";
import type { ProviderChoice, ProviderModelChoice } from "../../electron/shared/agent-provider-catalog.js";

export interface ProviderConfig {
  providerId: string;
  model: string;
  effort?: string;
  skipPermissions?: boolean;
}

export { PROVIDER_CHOICES };
export type { ProviderChoice, ProviderModelChoice };

export function buildProviderCommand({ providerId, model, effort, skipPermissions }: ProviderConfig): string {
  if (providerId === "claude") {
    const parts = ["claude"];
    if (skipPermissions) parts.push("--dangerously-skip-permissions");
    if (model) parts.push("--model", model);
    parts.push(...effortArgs(providerId, effort));
    return parts.join(" ");
  }
  if (providerId === "codex") {
    const parts = ["codex"];
    if (skipPermissions) parts.push("--dangerously-bypass-approvals-and-sandbox", "-s", "danger-full-access");
    if (model) parts.push("--model", model);
    parts.push(...effortArgs(providerId, effort));
    return parts.join(" ");
  }
  if (providerId === "gemini") {
    const parts = ["gemini"];
    if (skipPermissions) parts.push("--yolo");
    if (model) parts.push("-m", model);
    return parts.join(" ");
  }
  if (providerId === "copilot") {
    const parts = ["copilot"];
    if (skipPermissions) parts.push("--allow-all-tools");
    if (model) parts.push("--model", model);
    parts.push(...effortArgs(providerId, effort));
    return parts.join(" ");
  }
  if (providerId === "opencode") {
    const parts = ["opencode"];
    if (skipPermissions) parts.push("--yolo");
    if (model && model !== "default") parts.push("--model", model);
    return parts.join(" ");
  }
  return "";
}

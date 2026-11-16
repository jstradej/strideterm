// Dependency-free pieces of the agent sandbox shared by the runtime and the renderer.

/** The `@anthropic-ai/sandbox-runtime` release strIDEterm was built and checked against. */
export const SANDBOX_SRT_VERSION = "0.0.83";

/** Hostname the sandbox uses for the strIDEterm gateway; the sandbox proxy routes it to the host. */
export const SANDBOX_GATEWAY_HOST = "gateway.strideterm.internal";

export type SandboxPrerequisiteId = "wsl" | "node" | "srt" | "bubblewrap" | "socat" | "ripgrep" | "seatbelt";

export interface SandboxPrerequisite {
  id: SandboxPrerequisiteId;
  label: string;
  ok: boolean;
  /** strIDEterm can install it after the user confirms. */
  installable: boolean;
  detail?: string;
}

/** Agent CLIs strIDEterm can run in isolation; the probe looks for each of them where the sandbox runs. */
export const SANDBOX_AGENT_IDS = ["claude", "codex", "copilot", "opencode", "gemini"] as const;

export interface SandboxAgentStatus {
  id: string;
  /** The CLI is installed where the sandbox runs (on Windows: inside WSL, not just on Windows). */
  ok: boolean;
  /** Windows: only the Windows install was found (a shim under /mnt), which the sandbox cannot run. */
  windowsOnly?: boolean;
  detail?: string;
}

export interface SandboxStatus {
  platform: "linux" | "darwin" | "win32";
  /** Every prerequisite is present, so a sandboxed tab can start. */
  ready: boolean;
  prerequisites: SandboxPrerequisite[];
  /** Plain statements the UI shows next to the switch (what is and is not protected, platform limits). */
  notes: string[];
  /** Whether MCP tools, hooks and registries can reach the host gateway from the sandbox. */
  gateway: "available" | "unavailable";
  gatewayDetail?: string;
  /** Agent CLIs found where the sandbox runs. Informational: they never affect `ready`. Empty when the host is not reachable. */
  agents: SandboxAgentStatus[];
  /** Windows: the distro's home folder as Windows reaches it (`\\wsl.localhost\<distro>\home\<user>`). */
  wslHome?: string;
}

export interface SandboxDeniedRequest {
  id: string;
  workspaceId: string;
  sessionId: string;
  host: string;
  port: number | null;
  /** Epoch milliseconds of the first request. */
  at: number;
  /** pending: the sandbox is still waiting for an answer. */
  state: "pending" | "allowed" | "denied" | "expired";
}

export const SANDBOX_MAX_WORKSPACE_DOMAINS = 100;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+(?::[0-9]{1,5})?$`);

/**
 * One allowed destination as `host`, `*.host` or either with `:port`. A bare `*`, a single label
 * and IP literals are refused: the allowlist names services, never "everything" or a machine.
 */
export function normalizeSandboxDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 253 || !DOMAIN_RE.test(value)) return null;
  const hostPart = value.replace(/:[0-9]+$/u, "");
  if (/^[0-9.]+$/u.test(hostPart)) return null;
  if (hostPart.startsWith("*.") && hostPart.slice(2).split(".").length < 2) return null;
  const port = /:([0-9]+)$/u.exec(value)?.[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  return value;
}

export function normalizeSandboxDomains(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const domain = normalizeSandboxDomain(item);
    if (domain && !out.includes(domain)) out.push(domain);
    if (out.length >= SANDBOX_MAX_WORKSPACE_DOMAINS) break;
  }
  return out;
}

/** Text the UI uses everywhere a tab or workspace is described as isolated. It never says "safe". */
export const SANDBOX_LABEL = "isolated";

export const SANDBOX_NOT_PROTECTED = [
  "The workspace contents: the agent can read and change them and sends them to its model.",
  "The agent's own sign-in to its model: it is shared with the host and the agent can read it.",
  "Traffic to the model: it is an allowed channel out.",
  "The system kernel: this is process isolation, not a virtual machine.",
] as const;

export interface SandboxInstallResult {
  status: SandboxStatus;
  /** What strIDEterm ran and what it printed, for the user to read. */
  log: string[];
  /** Commands the user must run by hand when a step needed a password or failed. */
  manual: string[];
  failed: boolean;
}

export interface SandboxDecisionPayload {
  requestId: string;
  allow: boolean;
  /** With `allow`: keep the destination on the workspace's allowlist. */
  remember?: boolean;
}

export interface SandboxDecisionResult {
  ok: boolean;
  /** The allowlist entry that was added, or empty. */
  remembered: string;
}

import { createHash } from "node:crypto";
import type { UsageWindow } from "../../shared/agent-usage.js";
import type { UsageAccountReading } from "../../shared/agent-usage.js";
import { runJsonlCli } from "./cli-probe.js";
import { UsageUnavailable } from "./unavailable.js";

const CLI_TIMEOUT_MS = 12_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const rateLimitedUntil = new Map<string, number>();

type LimitWindow = { utilization?: unknown; used_percentage?: unknown; resets_at?: unknown } | null;
type UsageReply = {
  rate_limits_available?: unknown;
  rate_limits?: {
    five_hour?: LimitWindow;
    seven_day?: LimitWindow;
    seven_day_oauth_apps?: LimitWindow;
    seven_day_opus?: LimitWindow;
    seven_day_sonnet?: LimitWindow;
    model_scoped?: Array<{ display_name?: unknown; utilization?: unknown; resets_at?: unknown }>;
  } | null;
};

type ClaudeAccount = { label: string; key: string };
const MAX_SCOPED_WINDOWS = 27;

function safeLabel(value: unknown, fallback: string): string {
  const normalized =
    typeof value === "string"
      ? value
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  return normalized.slice(0, 96) || fallback;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function resetTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric)
    ? numeric > 10_000_000_000
      ? numeric
      : numeric * 1000
    : Date.parse(String(value));
  return Number.isFinite(new Date(parsed).getTime()) ? parsed : undefined;
}

function mapWindow(
  label: string,
  raw: LimitWindow | undefined,
  durationMinutes: number,
  scope?: string,
): UsageWindow | undefined {
  if (!raw) return undefined;
  const percent = typeof raw.utilization === "number" ? raw.utilization : raw.used_percentage;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
  const resetsAt = resetTimestamp(raw.resets_at);
  return {
    label,
    usedPercent: percent,
    durationMinutes,
    ...(scope === undefined ? {} : { scope }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function unpackResponse(
  message: unknown,
): { requestId: string; subtype: string; payload?: Record<string, unknown>; error?: string } | undefined {
  const outer = asObject(message);
  if (outer?.type !== "control_response") return undefined;
  const response = asObject(outer.response);
  if (!response || typeof response.request_id !== "string" || typeof response.subtype !== "string") return undefined;
  return {
    requestId: response.request_id,
    subtype: response.subtype,
    payload: asObject(response.response),
    error: typeof response.error === "string" ? response.error : undefined,
  };
}

function identityFromInitialize(value: unknown): ClaudeAccount | undefined {
  const account = asObject(asObject(value)?.account);
  const email = typeof account?.email === "string" ? account.email.trim() : "";
  if (!email) return undefined;
  const organization = typeof account?.organization === "string" ? account.organization.trim() : "";
  const apiProvider = typeof account?.apiProvider === "string" ? account.apiProvider.trim() : "";
  // Keep the stable account key opaque. Email remains only as the UI label.
  const key = createHash("sha256").update(`${email.toLowerCase()}\0${organization}\0${apiProvider}`).digest("hex");
  return { label: safeLabel(email, "Claude account"), key };
}

function classifyCliError(error: unknown, cooldownKey: string): UsageUnavailable {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/not found|could not start|not installed/.test(message)) {
    return new UsageUnavailable("Claude Code CLI is not available");
  }
  if (/timed out|timeout/.test(message)) {
    return new UsageUnavailable("Claude Code usage request timed out");
  }
  if (/unsupported|unknown.*(subtype|request)|get_usage/i.test(message)) {
    return new UsageUnavailable("Claude Code CLI does not support usage reporting; update Claude Code");
  }
  if (/429|rate.?limit|too many requests/i.test(message)) {
    rateLimitedUntil.set(cooldownKey, Date.now() + RATE_LIMIT_COOLDOWN_MS);
    return new UsageUnavailable("Claude usage service rate limited the request");
  }
  if (/auth|login|token|credential|401|403/i.test(message)) {
    return new UsageUnavailable("Claude Code login is unavailable or expired; sign in with Claude Code again");
  }
  return new UsageUnavailable("Claude Code usage could not be read");
}

/** Reads the signed-in account and subscription quota in one Claude CLI process, without submitting a prompt. */
export async function readClaudeAccountUsage(env?: NodeJS.ProcessEnv): Promise<UsageAccountReading> {
  let usageReply: UsageReply;
  let account: ClaudeAccount | undefined;
  const selectedEnv = env ?? process.env;
  let cooldownKey = `claude-profile-${createHash("sha256")
    .update(selectedEnv.CLAUDE_CONFIG_DIR || selectedEnv.HOME || selectedEnv.USERPROFILE || "default")
    .digest("hex")}`;
  try {
    usageReply = await runJsonlCli<UsageReply>(
      "claude",
      [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--safe-mode",
      ],
      {
        type: "control_request",
        request_id: "strideterm-usage-initialize",
        request: { subtype: "initialize", hooks: {}, sdkMcpServers: [] },
      },
      (message, send) => {
        const response = unpackResponse(message);
        if (!response) {
          const item = asObject(message);
          if (item?.type === "result" && item.is_error === true) {
            throw new UsageUnavailable("Claude Code could not return plan usage.");
          }
          return undefined;
        }
        if (response.subtype === "error") {
          throw classifyCliError(new Error(response.error || "Claude CLI control request failed"), cooldownKey);
        }
        if (response.subtype !== "success") return undefined;
        if (response.requestId === "strideterm-usage-initialize") {
          account = identityFromInitialize(response.payload);
          if (account) cooldownKey = account.key;
          if ((rateLimitedUntil.get(cooldownKey) ?? 0) > Date.now()) {
            throw new UsageUnavailable("Claude usage check is cooling down after a rate limit");
          }
          send({
            type: "control_request",
            request_id: "strideterm-usage-read",
            request: { subtype: "get_usage", skip_behaviors: true },
          });
          return undefined;
        }
        if (response.requestId === "strideterm-usage-read" && response.payload) {
          return response.payload as UsageReply;
        }
        return undefined;
      },
      { timeoutMs: CLI_TIMEOUT_MS, ...(env === undefined ? {} : { env }) },
    );
  } catch (error) {
    if (error instanceof UsageUnavailable) throw error;
    throw classifyCliError(error, cooldownKey);
  }

  if (!usageReply || usageReply.rate_limits_available !== true || !usageReply.rate_limits) {
    throw new UsageUnavailable("Claude plan usage is unavailable for this login");
  }
  const limits = usageReply.rate_limits;
  const windows = [
    mapWindow("5-hour", limits.five_hour, 300),
    mapWindow("7-day", limits.seven_day, 10080),
    mapWindow("7-day OAuth apps", limits.seven_day_oauth_apps, 10080, "OAuth apps"),
    mapWindow("7-day Opus", limits.seven_day_opus, 10080, "Opus"),
    mapWindow("7-day Sonnet", limits.seven_day_sonnet, 10080, "Sonnet"),
  ];
  for (const scoped of (Array.isArray(limits.model_scoped) ? limits.model_scoped : []).slice(0, MAX_SCOPED_WINDOWS)) {
    const scope = (typeof scoped.display_name === "string" && scoped.display_name.trim()) || "Model";
    const safeScope = safeLabel(scope, "Model");
    windows.push(
      mapWindow(
        `${safeScope} weekly`,
        { utilization: scoped.utilization, resets_at: scoped.resets_at },
        10080,
        safeScope,
      ),
    );
  }
  const result = windows.filter((window): window is UsageWindow => window !== undefined);
  if (result.length === 0) throw new UsageUnavailable("Claude plan usage data is unavailable");
  return account ? { account, windows: result } : { windows: result };
}

/** Compatibility wrapper for callers that only need quota windows. */
export async function readClaudeUsage(): Promise<UsageWindow[]> {
  return (await readClaudeAccountUsage()).windows;
}

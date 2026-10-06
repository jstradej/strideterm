import { sanitizeTerminalText } from "./terminal-text.js";

export const NOTIFICATION_BODY_MAX_BYTES = 1500;
export const NOTIFICATION_EXCERPT_MAX_BYTES = 1100;

export function truncateUtf8Head(value: string, maxBytes: number): string {
  if (maxBytes < 3) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const char of value) {
    if (Buffer.byteLength(result + char, "utf8") > maxBytes - 3) break;
    result += char;
  }
  return `${result.trimEnd()}…`;
}

export function truncateUtf8End(value: string, maxBytes: number): string {
  if (maxBytes < 3) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const char of [...value].reverse()) {
    if (Buffer.byteLength(char + result, "utf8") > maxBytes - 3) break;
    result = char + result;
  }
  return `…${result.trimStart()}`;
}

export function recentTerminalExcerpt(raw: string, maxLines = 8): string {
  const lines = sanitizeTerminalText(raw).split("\n").slice(-maxLines);
  return truncateUtf8End(lines.join("\n"), NOTIFICATION_EXCERPT_MAX_BYTES);
}

export function notificationSummary(kind: string, detail: string, exitCode?: number): string {
  const key = String(detail || "")
    .trim()
    .toLowerCase();
  if (key === "hook:subagentstop") return "Subagent finished";
  if (key === "hook:stop") return "Agent finished";
  if (key === "hook:notification:permission_prompt" || key === "permission_prompt") return "Permission needed";
  if (detail && !/^[a-z]+[:._-][a-z0-9:._-]+$/i.test(key)) return detail;
  if (kind === "error") return exitCode && exitCode !== 0 ? `Command failed (exit ${exitCode})` : "Command failed";
  if (kind === "completed")
    return exitCode && exitCode !== 0 ? `Command failed (exit ${exitCode})` : "Command finished";
  if (kind === "question") return "Agent needs an answer";
  if (kind === "waiting") return "Waiting for input";
  return "Activity updated";
}

export function buildNotificationBody(input: {
  kind: string;
  detail?: string;
  message?: string;
  exitCode?: number;
  recentOutput?: string;
}): string {
  const message = truncateUtf8Head(sanitizeTerminalText(input.message), 500);
  const lead = truncateUtf8Head(
    message || notificationSummary(input.kind, String(input.detail || ""), input.exitCode),
    500,
  );
  const output = String(input.recentOutput || "").trim();
  if (!output || output === lead) return truncateUtf8Head(lead, NOTIFICATION_BODY_MAX_BYTES);
  const label = "Recent terminal output:\n";
  const separator = "\n\n";
  const remaining = NOTIFICATION_BODY_MAX_BYTES - Buffer.byteLength(lead + separator + label, "utf8");
  if (remaining <= 3) return truncateUtf8Head(lead, NOTIFICATION_BODY_MAX_BYTES);
  return `${lead}${separator}${label}${truncateUtf8End(output, remaining)}`;
}

export const MOBILE_PROMPT_MAX_CHARS = 300;

function singleLine(value: string | undefined): string {
  return sanitizeTerminalText(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Headline for a notification on the phone: "<workspace> · <tab>", degrading to whichever half is
 * known, then to the profile label. What happened is the body's job, never the title's.
 */
export function mobileNotificationTitle(input: {
  workspaceName?: string;
  tab?: string;
  profileLabel?: string;
}): string {
  const workspace = singleLine(input.workspaceName);
  const tab = singleLine(input.tab);
  if (workspace && tab && workspace !== tab) return `${workspace} · ${tab}`;
  return workspace || tab || singleLine(input.profileLabel);
}

/**
 * The text a phone shows for one alert: a short lead sentence plus, for events where the agent is
 * blocked on the user, the question itself. Unlike `buildNotificationBody` (the Telegram-era
 * "lead + recent terminal output" dump) it never ships terminal output as the body: the excerpt is
 * reduced to its last few lines and sent as `prompt`, and only for `waiting`/`question`.
 */
export function buildMobileNotificationContent(input: {
  kind: string;
  detail?: string;
  message?: string;
  exitCode?: number;
  recentOutput?: string;
}): { lead: string; prompt?: string } {
  const message = truncateUtf8Head(sanitizeTerminalText(input.message), 500);
  const lead = truncateUtf8Head(
    message || notificationSummary(input.kind, String(input.detail || ""), input.exitCode),
    500,
  );
  if (input.kind !== "waiting" && input.kind !== "question") return { lead };

  let prompt = message.trim();
  if (!prompt) {
    const lines = sanitizeTerminalText(String(input.recentOutput || ""))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    prompt = lines.slice(-3).join("\n");
  }
  if (!prompt) return { lead };
  if (prompt.length > MOBILE_PROMPT_MAX_CHARS) prompt = `…${prompt.slice(-(MOBILE_PROMPT_MAX_CHARS - 1)).trimStart()}`;
  return { lead, prompt };
}

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

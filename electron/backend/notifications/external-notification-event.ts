/**
 * Pure builder for ExternalNotificationEvent (plan §10.1).
 *
 * Every call site that currently forwards an alert to Telegram (the
 * raiseAlert() wrapper, PR review activity forwarding, pipeline check
 * forwarding — all in runtime.ts) builds exactly ONE ExternalNotificationEvent
 * from the same local data it already uses for the Telegram payload, via this
 * single function. That is what keeps Telegram and Mobile from growing
 * parallel, time-diverging classification logic: there is one mapping table,
 * used everywhere, not one per adapter.
 *
 * Pure function — no side effects, safe to unit test without a runtime.
 */
import type {
  ExternalNotificationEvent,
  ExternalNotificationPriority,
  MobileCommandType,
} from "../../shared/types/notifications.js";
import { truncateUtf8Head } from "./notification-context.js";
import { sanitizeTerminalText } from "./terminal-text.js";

export interface BuildExternalNotificationEventInput {
  eventId: string;
  profileId: string;
  workspaceId: string;
  sessionId?: string | null;
  panelId?: string | null;
  kind: string;
  /** Same urgency signal already computed for the Telegram payload — reused, not reclassified. */
  urgency?: "normal" | "urgent";
  title: string;
  detail?: string;
  workspaceName?: string;
  taskId?: string;
  tab?: string;
  activity?: string;
  prompt?: string;
  exitCode?: number | null;
  durationMs?: number;
  createdAt?: number;
}

function displayText(value: string | undefined, maxLength: number): string | undefined {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  let result = "";
  for (const char of text) {
    if (result.length + char.length > maxLength) break;
    result += char;
  }
  return result || undefined;
}

/**
 * Priority mapping (plan §7): urgency "urgent" always wins (permission
 * prompts, failed pipeline checks, ...). Otherwise "waiting" is high because
 * an agent is blocked on the user; "info"/"subagent_done" are low (routine
 * progress pings); everything else (completed/review/pipeline-succeeded/
 * unknown kinds) is normal.
 */
function resolvePriority(kind: string, urgency: "normal" | "urgent"): ExternalNotificationPriority {
  if (urgency === "urgent") return "high";
  if (kind === "waiting" || kind === "error") return "high";
  if (kind === "info" || kind === "subagent_done") return "low";
  return "normal";
}

/**
 * Which mobile command types a client may offer as a quick action for this
 * event kind. Only "waiting" exposes reply-style actions (the agent is
 * blocked on the user right now); every other kind only offers acknowledge —
 * task lifecycle changes (resume/stop/reset/updateDescription) are left to
 * the mobile task detail screen, not a notification quick action, per the
 * plan's example in §10.1 ("a waiting event exposes task.sendInstruction /
 * task.pause etc.").
 */
function resolveActions(kind: string): MobileCommandType[] {
  if (kind === "waiting") {
    return ["task.sendInstruction", "task.pause", "notification.acknowledge"];
  }
  return ["notification.acknowledge"];
}

export function buildExternalNotificationEvent(input: BuildExternalNotificationEventInput): ExternalNotificationEvent {
  const kind = input.kind || "info";
  const urgency = input.urgency === "urgent" ? "urgent" : "normal";
  const priority = resolvePriority(kind, urgency);
  const workspaceId = input.workspaceId || "";
  const sessionId = input.sessionId || null;
  const panelId = input.panelId || null;
  const activity = displayText(sanitizeTerminalText(input.activity || ""), 200);
  const dedupeKey = `${workspaceId}:${sessionId || panelId || ""}:${kind}`;

  return {
    eventId: input.eventId,
    profileId: input.profileId || "default",
    workspaceId,
    sessionId,
    panelId,
    kind,
    priority,
    title: truncateUtf8Head(displayText(input.title, 500) || "", 500),
    detail: truncateUtf8Head(input.detail || "", 1500),
    ...(displayText(input.workspaceName, 120) ? { workspaceName: displayText(input.workspaceName, 120) } : {}),
    ...(input.taskId && input.taskId.length <= 200 ? { taskId: input.taskId } : {}),
    ...(displayText(input.tab, 120) ? { tab: displayText(input.tab, 120) } : {}),
    ...(activity ? { activity } : {}),
    ...(input.prompt ? { prompt: truncateUtf8Head(input.prompt, 500) } : {}),
    ...(Number.isInteger(input.exitCode) ? { exitCode: input.exitCode! } : {}),
    ...(Number.isInteger(input.durationMs) && input.durationMs! >= 0 ? { durationMs: input.durationMs! } : {}),
    dedupeKey,
    // Only low-priority events collapse — waiting/error/normal events must
    // never silently disappear behind a later one (plan §7/§11.5).
    collapseKey: priority === "low" ? dedupeKey : null,
    createdAt: typeof input.createdAt === "number" ? input.createdAt : Date.now(),
    actions: resolveActions(kind),
  };
}

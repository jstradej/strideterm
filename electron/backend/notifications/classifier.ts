/**
 * Pure classifier for Claude Code hook events.
 *
 * Decides whether a hook event should be shown to the user (userFacing)
 * and at what urgency. System-only events are consumed internally (state
 * updates, task runner handoff, metrics) and never raise alerts.
 *
 * See the plan in .private/plan-notifications-reliability.md § 3.2.c for the
 * full classification table.
 *
 * Pure function — no side effects, safe to import anywhere and to unit-test.
 */

export interface Classification {
  userFacing: boolean;
  tier?: 1 | 2 | 3;
  urgency?: "normal" | "urgent";
  kind?: "waiting" | "completed" | "info" | "subagent_done";
  detail?: string;
}

const SYSTEM_ONLY: Classification = Object.freeze({ userFacing: false });

export interface ClassifyOptions {
  /**
   * Raise a user-facing alert for SubagentStop (kind "subagent_done"). Off by
   * default — sub-agents finishing mid-turn read as false "done" signals;
   * most users only act on the end-of-turn Stop. Mirrors
   * settings.notifications.subagentCompletion.
   */
  subagentCompletion?: boolean;
}

/**
 * @param hook     — hook name (Notification, Stop, SubagentStop, UserPromptSubmit, ...)
 * @param subtype  — for Notification: idle_prompt / permission_prompt / etc.
 * @param options  — user settings that influence classification.
 */
export function classifyHookEvent(hook: unknown, subtype?: unknown, options?: ClassifyOptions): Classification {
  const hookName = String(hook || "").trim();
  const sub = String(subtype || "").trim();

  if (hookName === "Notification") {
    switch (sub) {
      case "permission_prompt":
        return {
          userFacing: true,
          tier: 1,
          urgency: "urgent",
          kind: "waiting",
          detail: "hook:Notification:permission_prompt",
        };
      case "idle_prompt":
        return {
          userFacing: true,
          tier: 1,
          urgency: "normal",
          kind: "waiting",
          detail: "hook:Notification:idle_prompt",
        };
      case "elicitation_dialog":
        return {
          userFacing: true,
          tier: 1,
          urgency: "normal",
          kind: "waiting",
          detail: "hook:Notification:elicitation_dialog",
        };
      case "auth_success":
        // Informational only — log is enough, no user alert.
        return SYSTEM_ONLY;
      case "":
        // Legacy callers that only pass the hook name. Treat as idle_prompt —
        // the most common case when hook name arrives without a subtype.
        return {
          userFacing: true,
          tier: 1,
          urgency: "normal",
          kind: "waiting",
          detail: "hook:Notification",
        };
      default:
        // Unknown subtype — do NOT alert. Prevents noise from new Claude Code
        // notification types we don't yet understand. Dispatcher still logs it.
        return SYSTEM_ONLY;
    }
  }

  if (hookName === "Stop") {
    // Conditional: user-facing only for non-task sessions. The dispatcher
    // still gives task runner first dibs; task workspaces will typically
    // consume Stop via onHookEvent and this user-facing branch won't fire.
    return {
      userFacing: true,
      tier: 1,
      urgency: "normal",
      kind: "completed",
      detail: "hook:Stop",
    };
  }

  if (hookName === "SubagentStop") {
    // Sub-agent finished within a turn (e.g. a Task tool completed). Task
    // runner gets first dibs via onSubagentStop — when it consumes the hook
    // for a task workspace, this branch never fires. User-facing only when
    // the user opted in (settings.notifications.subagentCompletion, default
    // off): one ping per finished sub-agent is noise for most users, who
    // only act on the turn-end Stop. Distinct kind so Telegram forwardKinds
    // can filter subagent pings independently of Stop notifications.
    if (!options?.subagentCompletion) return SYSTEM_ONLY;
    return {
      userFacing: true,
      tier: 1,
      urgency: "normal",
      kind: "subagent_done",
      detail: "hook:SubagentStop",
    };
  }

  if (hookName === "UserPromptSubmit") {
    // Side-effect hook: dispatcher applies signal updates (reset busy,
    // update lastPromptAt). Never alerts the user.
    return SYSTEM_ONLY;
  }

  if (hookName === "PreToolUse" || hookName === "PostToolUse" || hookName === "PreCompact") {
    // Not configured in claude-hook-config.js by default (volume).
    // If they arrive (third-party config), keep them system-only.
    return SYSTEM_ONLY;
  }

  // Unknown hook name — never alert. Dispatcher will log at trace.
  return SYSTEM_ONLY;
}

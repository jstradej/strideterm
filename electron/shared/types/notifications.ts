export interface NotificationPayload {
  title: string;
  body: string;
  sessionId?: string;
  workspaceId?: string;
  silent?: boolean;
}

export interface Toast {
  id: string;
  type: "info" | "success" | "warning" | "error";
  message: string;
  duration?: number;
  createdAt: string;
}

export interface Alert {
  id: string;
  sessionId: string;
  workspaceId: string;
  kind: "prompt" | "agent-idle" | "agent-done" | "task-done";
  message: string;
  createdAt: string;
}

/**
 * The 13 mobile command types from strideterm-mobile/protocol (plan §8).
 * Defined here (not in electron/backend/mobile/) so shared, non-mobile code
 * (this file's ExternalNotificationEvent) can reference "which mobile action
 * applies" without a shared -> backend dependency. electron/backend/mobile/
 * mobile-schemas.ts imports this same union for its Command Zod schemas
 * instead of re-declaring the literals, so there is exactly one list.
 */
export type MobileCommandType =
  | "notification.acknowledge"
  | "task.pause"
  | "task.resume"
  | "task.stop"
  | "task.reset"
  | "task.updateDescription"
  | "task.sendInstruction"
  | "profile.catalog.get"
  | "remote.status.get"
  | "remote.endpoint.request"
  | "remote.tunnel.reconnect"
  | "remote.webSession.issue"
  | "workspace.status.get";

/** Priority bucket for mobile push delivery — see plan §7. */
export type ExternalNotificationPriority = "high" | "normal" | "low";

/**
 * Transport-neutral notification event (plan §10.1). Created once by the
 * runtime for every alert/PR/pipeline notification that already goes to
 * Telegram, and consumed by adapters (Telegram's own forwardAlert() keeps
 * running unchanged side-by-side; MobileManager is the second adapter).
 * This type intentionally carries only stable IDs, context, and routing
 * metadata — never the rich Telegram-specific formatting/threading state,
 * which stays inside telegram-manager.ts.
 */
export interface ExternalNotificationEvent {
  /** Unique per construction (not per dedupeKey) — e.g. randomUUID(). */
  eventId: string;
  profileId: string;
  workspaceId: string;
  sessionId: string | null;
  panelId: string | null;
  /** Alert/notification kind as classified elsewhere (e.g. "waiting", "completed", "info", "review", "pipeline"). */
  kind: string;
  priority: ExternalNotificationPriority;
  title: string;
  detail: string;
  /** Stable key for collapsing duplicate OS/mobile notifications of the same alert. */
  dedupeKey: string;
  /** Set only for low-priority/repeatable kinds — see buildExternalNotificationEvent(). */
  collapseKey: string | null;
  /** Epoch ms. */
  createdAt: number;
  /** Which of the 12 mobile command types a client may offer as a quick action for this event. */
  actions: MobileCommandType[];
}

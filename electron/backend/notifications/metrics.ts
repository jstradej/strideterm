/**
 * Lightweight in-memory metrics for the notification pipeline.
 * Plan § 3.5.
 *
 * Counters survive the lifetime of the runtime process. Exposed via
 * runtime.getNotificationMetrics() for the About dialog / diagnostics.
 */

interface Counters {
  alertsTotal: number;
  alertsByTier: Record<number, number>;
  alertsByKind: Record<string, number>;
  alertsByUrgency: Record<string, number>;
  alertsByCommandClass: Record<string, number>;
  hooksReceived: number;
  hooksByName: Record<string, number>;
  dismissedWithoutInteraction: number;
}

const counters: Counters = {
  alertsTotal: 0,
  alertsByTier: { 1: 0, 2: 0, 3: 0 },
  alertsByKind: { waiting: 0, completed: 0, info: 0 },
  alertsByUrgency: { normal: 0, urgent: 0 },
  alertsByCommandClass: {}, // commandClass → count
  hooksReceived: 0,
  hooksByName: {}, // hook name → count
  dismissedWithoutInteraction: 0,
};

const startedAt = Date.now();

interface RecordAlertOptions {
  tier?: number;
  kind?: string;
  urgency?: string;
  commandClass?: string;
}

export function recordAlert({ tier = 1, kind = "waiting", urgency = "normal", commandClass = "" }: RecordAlertOptions = {}): void {
  counters.alertsTotal += 1;
  counters.alertsByTier[tier] = (counters.alertsByTier[tier] || 0) + 1;
  counters.alertsByKind[kind] = (counters.alertsByKind[kind] || 0) + 1;
  counters.alertsByUrgency[urgency] = (counters.alertsByUrgency[urgency] || 0) + 1;
  if (commandClass) {
    counters.alertsByCommandClass[commandClass] = (counters.alertsByCommandClass[commandClass] || 0) + 1;
  }
}

export function recordHook(hookName: string): void {
  counters.hooksReceived += 1;
  if (hookName) {
    counters.hooksByName[hookName] = (counters.hooksByName[hookName] || 0) + 1;
  }
}

export function recordDismissedWithoutInteraction(): void {
  counters.dismissedWithoutInteraction += 1;
}

export interface NotificationMetrics extends Counters {
  uptimeMs: number;
}

export function getMetrics(): NotificationMetrics {
  return {
    uptimeMs: Date.now() - startedAt,
    ...counters,
    // defensive copies so callers can't mutate internal state
    alertsByTier: { ...counters.alertsByTier },
    alertsByKind: { ...counters.alertsByKind },
    alertsByUrgency: { ...counters.alertsByUrgency },
    alertsByCommandClass: { ...counters.alertsByCommandClass },
    hooksByName: { ...counters.hooksByName },
  };
}

export function _resetForTests(): void {
  counters.alertsTotal = 0;
  counters.alertsByTier = { 1: 0, 2: 0, 3: 0 };
  counters.alertsByKind = { waiting: 0, completed: 0, info: 0 };
  counters.alertsByUrgency = { normal: 0, urgent: 0 };
  counters.alertsByCommandClass = {};
  counters.hooksReceived = 0;
  counters.hooksByName = {};
  counters.dismissedWithoutInteraction = 0;
}

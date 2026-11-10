// Nothing in Jira polls on a fast timer; a user action is what asks for fresh data. This tells the
// runtime someone is using Jira so it checks the profile's alert queries now. The runtime skips a
// query that polled within the last two minutes; this throttle keeps the request itself rare.
const NUDGE_THROTTLE_MS = 2 * 60_000;
let lastNudgeAt = Number.NEGATIVE_INFINITY;

export function nudgeJiraPolling(api: { nudgeJiraPolling?: () => Promise<unknown> } | null | undefined): void {
  const now = Date.now();
  if (!api?.nudgeJiraPolling || now - lastNudgeAt < NUDGE_THROTTLE_MS) return;
  lastNudgeAt = now;
  // Background work: a failing IPC handler is already logged by the runtime, there is no action to report.
  void api.nudgeJiraPolling().catch(() => undefined);
}

export function resetJiraNudgeThrottleForTests(): void {
  lastNudgeAt = Number.NEGATIVE_INFINITY;
}

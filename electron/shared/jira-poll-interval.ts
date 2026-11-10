// Background checks of saved queries are the only timer that reaches Jira, so they are kept rare;
// a user action (opening the inbox, focusing the Jira search) checks sooner. See `nudgeJiraPolling`.
export const JIRA_POLL_MIN_SECONDS = 15 * 60;
export const JIRA_POLL_MAX_SECONDS = 60 * 60;
export const JIRA_POLL_DEFAULT_SECONDS = JIRA_POLL_MIN_SECONDS;

export function clampJiraPollSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return JIRA_POLL_DEFAULT_SECONDS;
  return Math.max(JIRA_POLL_MIN_SECONDS, Math.min(JIRA_POLL_MAX_SECONDS, Math.trunc(seconds)));
}

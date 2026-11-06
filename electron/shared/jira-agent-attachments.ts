export const JIRA_AGENT_ATTACHMENT_MAX_FILES_LIMIT = 500;
export const JIRA_AGENT_ATTACHMENT_MAX_MEGABYTES_LIMIT = 500;

export interface JiraAgentAttachmentLimits {
  maxFiles: number;
  maxMegabytes: number;
}

export const DEFAULT_JIRA_AGENT_ATTACHMENT_LIMITS: JiraAgentAttachmentLimits = { maxFiles: 50, maxMegabytes: 50 };

function bounded(value: unknown, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(1, Math.trunc(value))) : fallback;
}

/** Fills the default only for a missing or non-numeric value; a valid user value is kept (clamped to the bounds). */
export function normalizeJiraAgentAttachmentLimits(raw: unknown): JiraAgentAttachmentLimits {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    maxFiles: bounded(
      value.maxFiles,
      JIRA_AGENT_ATTACHMENT_MAX_FILES_LIMIT,
      DEFAULT_JIRA_AGENT_ATTACHMENT_LIMITS.maxFiles,
    ),
    maxMegabytes: bounded(
      value.maxMegabytes,
      JIRA_AGENT_ATTACHMENT_MAX_MEGABYTES_LIMIT,
      DEFAULT_JIRA_AGENT_ATTACHMENT_LIMITS.maxMegabytes,
    ),
  };
}

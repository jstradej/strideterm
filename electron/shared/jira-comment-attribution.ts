export const JIRA_COMMENT_ATTRIBUTION_MAX_TEXT = 500;
const PLACEHOLDER_VALUE_MAX = 200;

export interface JiraCommentAttribution {
  enabled: boolean;
  text: string;
  position: "before" | "after";
}

export const DEFAULT_JIRA_COMMENT_ATTRIBUTION: JiraCommentAttribution = {
  enabled: true,
  text: "On behalf of {user}",
  position: "before",
};

function stripControl(text: string, keepNewline: boolean): string {
  return keepNewline
    ? text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    : text.replace(/[\u0000-\u001f\u007f]/g, " ");
}

export function cleanJiraAttributionText(value: string): string {
  return stripControl(value, true).trim().slice(0, JIRA_COMMENT_ATTRIBUTION_MAX_TEXT).trim();
}

/** Fills the default only for a missing or malformed value; a valid user value is kept as it is. */
export function normalizeJiraCommentAttribution(raw: unknown): JiraCommentAttribution {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  if (
    !value ||
    typeof value.enabled !== "boolean" ||
    typeof value.text !== "string" ||
    (value.position !== "before" && value.position !== "after")
  )
    return { ...DEFAULT_JIRA_COMMENT_ATTRIBUTION };
  return { enabled: value.enabled, text: cleanJiraAttributionText(value.text), position: value.position };
}

export interface JiraAttributionNames {
  /** The user's own Jira display name on this connection, when known. */
  user?: string;
  /** The strIDEterm profile name, used when no own identity is known. */
  profile?: string;
  /** The technical account's display name. */
  account?: string;
}

function cleanValue(value: string | undefined): string {
  return stripControl(value ?? "", false)
    .trim()
    .slice(0, PLACEHOLDER_VALUE_MAX);
}

/** Returns the final attribution line(s), or "" when nothing should be added. */
export function renderJiraCommentAttribution(
  setting: JiraCommentAttribution | undefined,
  names: JiraAttributionNames,
): string {
  if (!setting?.enabled) return "";
  const template = cleanJiraAttributionText(setting.text);
  if (!template) return "";
  const user = cleanValue(names.user) || cleanValue(names.profile);
  const account = cleanValue(names.account);
  return template.replace(/\{(user|account)\}/g, (_match, key: string) => (key === "user" ? user : account)).trim();
}

export function applyJiraCommentAttribution(
  body: string,
  setting: JiraCommentAttribution | undefined,
  names: JiraAttributionNames,
): string {
  const line = renderJiraCommentAttribution(setting, names);
  if (!line) return body;
  return setting?.position === "after" ? `${body}\n\n${line}` : `${line}\n\n${body}`;
}

/**
 * Client-side mirror of `jiraConnectionMetadataSchema` (electron/backend/ipc-schemas.ts), so a bad value is reported
 * next to its field instead of as an IPC validation error. `jira-metadata-validation.test.ts` pins both to each other.
 */
const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,19}$/;

export type JiraMetadataDraftInput = {
  label: string;
  accountPurpose: "personal" | "technical";
  issueKeyPrefixesText: string;
  defaultJql: string;
  projectKeysText: string;
  pollSeconds: number | string;
};

export type JiraMetadataField = "label" | "issueKeyPrefixes" | "defaultJql" | "projectKeys" | "pollSeconds";

export type JiraMetadataValue = {
  label: string;
  accountPurpose: "personal" | "technical";
  issueKeyPrefixes: string[];
  defaultJql: string;
  projectKeys: string[];
  pollSeconds: number;
};

export function splitJiraKeys(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\s]+/)
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

export function validateJiraMetadataDraft(
  draft: JiraMetadataDraftInput,
): { ok: true; value: JiraMetadataValue } | { ok: false; errors: Partial<Record<JiraMetadataField, string>> } {
  const errors: Partial<Record<JiraMetadataField, string>> = {};
  const label = draft.label.trim();
  if (!label) errors.label = "Enter a connection name.";
  else if (label.length > 80) errors.label = "Keep the connection name under 80 characters.";
  const issueKeyPrefixes = splitJiraKeys(draft.issueKeyPrefixesText);
  const badPrefix = issueKeyPrefixes.find((key) => !JIRA_KEY_PATTERN.test(key));
  if (badPrefix)
    errors.issueKeyPrefixes = `“${badPrefix}” is not a Jira project key. Use letters, digits or _, starting with a letter (up to 20 characters).`;
  else if (issueKeyPrefixes.length > 50) errors.issueKeyPrefixes = "Use at most 50 prefixes.";
  const projectKeys = splitJiraKeys(draft.projectKeysText);
  const badProject = projectKeys.find((key) => !JIRA_KEY_PATTERN.test(key));
  if (badProject)
    errors.projectKeys = `“${badProject}” is not a Jira project key. Use letters, digits or _, starting with a letter (up to 20 characters).`;
  else if (projectKeys.length > 100) errors.projectKeys = "Use at most 100 project keys.";
  const defaultJql = draft.defaultJql.trim();
  if (defaultJql.length > 2000) errors.defaultJql = "Keep the default JQL under 2000 characters.";
  const pollSeconds = typeof draft.pollSeconds === "number" ? draft.pollSeconds : Number(draft.pollSeconds);
  if (draft.pollSeconds === "" || !Number.isInteger(pollSeconds) || pollSeconds < 60 || pollSeconds > 3600)
    errors.pollSeconds = "Enter a whole number of seconds between 60 and 3600.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: { label, accountPurpose: draft.accountPurpose, issueKeyPrefixes, defaultJql, projectKeys, pollSeconds },
  };
}

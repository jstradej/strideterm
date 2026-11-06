import { createHash } from "node:crypto";
import type { JiraIssueRef, JiraIssueSnapshot } from "../../shared/types/task.js";

/**
 * A stable identity for an issue within a Jira connection. Issue keys are
 * deliberately excluded because Jira keys can change when issues move.
 */
export function jiraIssueIdentity(ref: Pick<JiraIssueRef, "connectionId" | "issueId">): string {
  return JSON.stringify([ref.connectionId, ref.issueId]);
}

/** Keep multiple Jira issues attached to a workspace/task without duplicates. */
export function associateJiraIssues<T extends JiraIssueRef>(
  current: readonly T[] | undefined,
  additions: readonly T[],
): T[] {
  const result = [...(current ?? [])];
  const identities = new Set(result.map(jiraIssueIdentity));
  for (const issue of additions) {
    const identity = jiraIssueIdentity(issue);
    if (identities.has(identity)) {
      // Preserve stable identity but refresh the display key when Jira moved it.
      const existing = result.findIndex((item) => jiraIssueIdentity(item) === identity);
      if (existing >= 0) result[existing] = issue;
      continue;
    }
    identities.add(identity);
    result.push(issue);
  }
  return result;
}

/** Fields whose values are captured and checked when acting on a Jira snapshot. */
export const JIRA_SNAPSHOT_FIELDS = ["summary", "status", "issueType", "projectKey", "updated", "assignee"] as const;

export type JiraSnapshotField = (typeof JIRA_SNAPSHOT_FIELDS)[number];
export type JiraSnapshotValues = Pick<JiraIssue, JiraSnapshotField>;
// Structural contract keeps this helper independent of JiraManager/runtime.
export interface JiraIssue {
  ref: JiraIssueRef;
  summary: string;
  status: string;
  issueType: string;
  projectKey: string;
  updated: string;
  assignee?: string;
}

function selectedValues(issue: JiraIssue): JiraSnapshotValues {
  return {
    summary: issue.summary,
    status: issue.status,
    issueType: issue.issueType,
    projectKey: issue.projectKey,
    updated: issue.updated,
    assignee: issue.assignee,
  };
}

function hashValues(values: JiraSnapshotValues): string {
  const canonical = JIRA_SNAPSHOT_FIELDS.map((field) => [field, values[field] ?? null]);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function createJiraIssueSnapshot(issue: JiraIssue): JiraIssueSnapshot {
  const fields = selectedValues(issue);
  return { ref: { ...issue.ref }, fields, hash: hashValues(fields) };
}

export type JiraSnapshotDrift = { drifted: false; fields: [] } | { drifted: true; fields: JiraSnapshotField[] };

/** Compare only the explicitly selected snapshot fields; report which drifted. */
export function verifyJiraIssueSnapshot(snapshot: JiraIssueSnapshot, current: JiraIssue): JiraSnapshotDrift {
  if (jiraIssueIdentity(snapshot.ref) !== jiraIssueIdentity(current.ref)) {
    return { drifted: true, fields: [...JIRA_SNAPSHOT_FIELDS] };
  }
  const values = selectedValues(current);
  const fields = JIRA_SNAPSHOT_FIELDS.filter((field) => (snapshot.fields[field] ?? null) !== (values[field] ?? null));
  // Hash is also checked to detect malformed/tampered snapshots, while the
  // field comparison above supplies an actionable explanation for ordinary drift.
  if (fields.length === 0 && snapshot.hash !== hashValues(snapshot.fields)) {
    return { drifted: true, fields: [...JIRA_SNAPSHOT_FIELDS] };
  }
  return fields.length ? { drifted: true, fields: [...fields] } : { drifted: false, fields: [] };
}

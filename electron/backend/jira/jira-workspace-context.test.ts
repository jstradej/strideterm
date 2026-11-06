import { describe, expect, test } from "vitest";
import {
  associateJiraIssues,
  createJiraIssueSnapshot,
  jiraIssueIdentity,
  verifyJiraIssueSnapshot,
  type JiraIssue,
} from "./jira-workspace-context.js";

const issue = (patch: Partial<JiraIssue> = {}): JiraIssue => ({
  ref: { provider: "jira", connectionId: "conn-a", issueId: "100", issueKey: "APP-1" },
  summary: "Fix login",
  status: "Open",
  issueType: "Bug",
  projectKey: "APP",
  updated: "2026-01-01T00:00:00Z",
  ...patch,
});

describe("Jira workspace context helpers", () => {
  test("uses connection plus immutable issue id for identity", () => {
    expect(jiraIssueIdentity(issue().ref)).toBe(
      jiraIssueIdentity(issue({ ref: { ...issue().ref, issueKey: "APP-2" } }).ref),
    );
    expect(jiraIssueIdentity(issue({ ref: { ...issue().ref, connectionId: "conn-b" } }).ref)).not.toBe(
      jiraIssueIdentity(issue().ref),
    );
  });

  test("associates several refs and updates key for existing identity", () => {
    const first = issue();
    const moved = issue({ ref: { ...first.ref, issueKey: "APP-9" } });
    const other = issue({ ref: { ...first.ref, issueId: "200", issueKey: "APP-2" } });
    expect(associateJiraIssues([first.ref], [moved.ref, other.ref])).toEqual([moved.ref, other.ref]);
  });

  test("snapshot detects selected-field drift and ignores presentation key changes", () => {
    const snapshot = createJiraIssueSnapshot(issue());
    expect(verifyJiraIssueSnapshot(snapshot, issue({ ref: { ...issue().ref, issueKey: "APP-8" } }))).toEqual({
      drifted: false,
      fields: [],
    });
    expect(verifyJiraIssueSnapshot(snapshot, issue({ status: "In Progress" }))).toEqual({
      drifted: true,
      fields: ["status"],
    });
  });
});

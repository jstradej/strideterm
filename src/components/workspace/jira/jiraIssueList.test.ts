import { describe, expect, it } from "vitest";
import { filterJiraIssues, jiraIssueStatusGroup, sortJiraIssues, withJqlOrderBy } from "./jiraIssueList";

const issue = (key: string, fields: Record<string, string> = {}) => ({ ref: { issueKey: key }, ...fields });

describe("Jira issue list", () => {
  it("replaces or appends the ORDER BY clause", () => {
    expect(withJqlOrderBy("project = ABC ORDER BY updated DESC", "priority")).toBe(
      "project = ABC ORDER BY priority DESC, updated DESC",
    );
    expect(withJqlOrderBy("assignee = currentUser()", "created")).toBe(
      "assignee = currentUser() ORDER BY created DESC",
    );
    expect(withJqlOrderBy("", "key")).toBe("ORDER BY key DESC");
    expect(withJqlOrderBy('text ~ "sort order by date"', "updated")).toBe(
      'text ~ "sort order by date" ORDER BY updated DESC',
    );
  });

  it("sorts by priority rank, then by the most recent update", () => {
    const sorted = sortJiraIssues(
      [
        issue("ABC-1", { priority: "C", updated: "2026-10-20T00:00:00Z" }),
        issue("ABC-2", { priority: "A", updated: "2026-10-01T00:00:00Z" }),
        issue("ABC-3", { priority: "B", updated: "2026-10-02T00:00:00Z" }),
        issue("ABC-4", { priority: "A", updated: "2026-10-03T00:00:00Z" }),
      ],
      "priority",
    );
    expect(sorted.map((item) => item.ref.issueKey)).toEqual(["ABC-4", "ABC-2", "ABC-3", "ABC-1"]);
  });

  it("sorts keys numerically and puts unassigned issues last", () => {
    expect(
      sortJiraIssues([issue("ABC-9"), issue("ABC-100"), issue("ABC-20")], "key").map((i) => i.ref.issueKey),
    ).toEqual(["ABC-100", "ABC-20", "ABC-9"]);
    expect(
      sortJiraIssues(
        [issue("ABC-1"), issue("ABC-2", { assignee: "Roe, Richard" }), issue("ABC-3", { assignee: "Doe, Jane" })],
        "assignee",
      ).map((i) => i.ref.issueKey),
    ).toEqual(["ABC-3", "ABC-2", "ABC-1"]);
  });

  it("filters by status group and text", () => {
    const issues = [
      issue("ABC-1", { status: "To Do", summary: "Brand detection" }),
      issue("ABC-2", { status: "Code Review", summary: "Watchdog email", assignee: "Duda, Tomas" }),
      issue("ABC-3", { status: "Closed", summary: "Release" }),
    ];
    expect(issues.map(jiraIssueStatusGroup)).toEqual(["todo", "active", "done"]);
    expect(filterJiraIssues(issues, "", "active").map((i) => i.ref.issueKey)).toEqual(["ABC-2"]);
    expect(filterJiraIssues(issues, "duda", "all").map((i) => i.ref.issueKey)).toEqual(["ABC-2"]);
    expect(filterJiraIssues(issues, "abc-3", "all").map((i) => i.ref.issueKey)).toEqual(["ABC-3"]);
    expect(filterJiraIssues(issues, "brand", "done")).toEqual([]);
  });
});

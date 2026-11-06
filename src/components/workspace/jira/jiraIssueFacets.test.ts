import { describe, expect, it } from "vitest";
import { applyJiraFacets, emptyJiraFacets, hasJiraFacets, jiraFacetOptions } from "./jiraIssueFacets";

const issues = [
  { status: "To Do", issueType: "Bug", priority: "High", assignee: "Alice" },
  { status: "In Progress", issueType: "Bug", priority: "Low", assignee: "Bob" },
  { status: "In Progress", issueType: "Task", priority: "High", assignee: "Alice" },
  { status: "Done", issueType: "Task", priority: "", assignee: "" },
];

describe("Jira result facets", () => {
  it("counts the loaded issues per value, most common first", () => {
    const none = emptyJiraFacets();
    expect(jiraFacetOptions(issues, none, "status")).toEqual([
      { value: "In Progress", count: 2 },
      { value: "Done", count: 1 },
      { value: "To Do", count: 1 },
    ]);
    expect(jiraFacetOptions(issues, none, "priority")).toEqual([
      { value: "High", count: 2 },
      { value: "Low", count: 1 },
    ]);
    expect(jiraFacetOptions(issues, none, "assignee")).toEqual([
      { value: "Alice", count: 2 },
      { value: "Bob", count: 1 },
      { value: "", count: 1 },
    ]);
  });

  it("filters by every selected facet and keeps the other values of the same facet pickable", () => {
    const selection = { ...emptyJiraFacets(), type: "Bug", status: "In Progress" };
    expect(hasJiraFacets(selection)).toBe(true);
    expect(applyJiraFacets(issues, selection)).toEqual([issues[1]]);
    expect(jiraFacetOptions(issues, selection, "status")).toEqual([
      { value: "In Progress", count: 1 },
      { value: "To Do", count: 1 },
    ]);
  });

  it("selects unassigned issues with the empty value and returns everything when nothing is selected", () => {
    expect(applyJiraFacets(issues, { ...emptyJiraFacets(), assignee: "" })).toEqual([issues[3]]);
    expect(applyJiraFacets(issues, emptyJiraFacets())).toEqual(issues);
  });

  it("keeps a selected value visible even when no loaded issue has it any more", () => {
    expect(jiraFacetOptions(issues, { ...emptyJiraFacets(), priority: "Blocker" }, "priority")[0]).toEqual({
      value: "Blocker",
      count: 0,
    });
  });
});
